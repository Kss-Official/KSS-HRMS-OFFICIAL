from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, and_, or_, func, case
from uuid import UUID
from datetime import datetime, timezone
from typing import List, Optional, Dict, Tuple
import uuid
import time

from app.core.database import get_db
from app.models.employee import Employee
from app.models.leave import LeaveRequest, LeaveLedger
from app.models.enums import LeaveType, LeaveStatus, ApprovalStatus, UserRole, ExecutiveTier, LedgerTransactionType
from app.schemas.leave import LeaveRequestCreate, ExecutiveLeaveReview, LeaveRequestOut
from app.api.deps import get_current_user, require_executive
from app.api.audit_util import add_audit
from app.api.v1.endpoints.attendance import company_now

router = APIRouter()

_LEAVES_CACHE: Dict[str, Tuple[float, List[LeaveRequestOut]]] = {}
_LEAVES_CACHE_TTL = 30.0
_LEAVES_CACHE_MAX_KEYS = 128

PAID_TYPES = (LeaveType.EARN_LEAVE, LeaveType.SICK_LEAVE, LeaveType.CASUAL_LEAVE)
BALANCE_ATTR = {
    LeaveType.EARN_LEAVE: "earn_leave_balance",
    LeaveType.SICK_LEAVE: "sick_leave_balance",
    LeaveType.CASUAL_LEAVE: "casual_leave_balance",
}
MAX_LEAVE_DAYS = 366
MAX_REASON_LEN = 2000


def invalidate_leaves_cache():
    _LEAVES_CACHE.clear()


async def _to_out(db: AsyncSession, leave: LeaveRequest) -> LeaveRequestOut:
    applicant = (await db.execute(select(Employee).where(Employee.id == leave.employee_id))).scalar_one_or_none()
    out = LeaveRequestOut.model_validate(leave)
    if applicant:
        out.employee_code = applicant.employee_code
        out.employee_name = applicant.full_name
        out.department = applicant.department
    return out


from urllib.parse import unquote

async def _find_leave(db: AsyncSession, leave_id: str, current_user_id: Optional[UUID] = None, lock: bool = False) -> Optional[LeaveRequest]:
    """Exact and canonical lookup by UUID, request_code (case-insensitive), or composite `LR_<code>_<YYYY-MM-DD>...` form.
    Prioritizes active/pending/approved requests when multiple historical records exist for the same employee/date."""
    raw_clean = leave_id.strip()
    clean = unquote(raw_clean).strip()

    # 1. Exact match on request_code or UUID
    conds = [
        func.lower(LeaveRequest.request_code) == clean.lower(),
        func.lower(LeaveRequest.request_code) == raw_clean.lower()
    ]
    try:
        conds.append(LeaveRequest.id == uuid.UUID(clean))
    except ValueError:
        pass
    try:
        conds.append(LeaveRequest.id == uuid.UUID(raw_clean))
    except ValueError:
        pass

    stmt = select(LeaveRequest).where(or_(*conds)).order_by(
        case((LeaveRequest.status.in_([LeaveStatus.PENDING, LeaveStatus.APPROVED]), 0), else_=1),
        LeaveRequest.created_at.desc()
    ).limit(1)
    if lock:
        stmt = stmt.with_for_update()
    row = (await db.execute(stmt)).scalars().first()
    if row:
        return row

    # 2. Composite LR_ format: LR_<employee_code>_<YYYY-MM-DD>...
    if clean.startswith("LR_") or raw_clean.startswith("LR_"):
        target_str = clean if clean.startswith("LR_") else raw_clean
        parts = target_str.split("_")
        if len(parts) >= 3:
            try:
                date_part = datetime.strptime(parts[2], "%Y-%m-%d").date()
            except ValueError:
                date_part = None

            if date_part:
                raw_code = parts[1].strip()
                clean_code = raw_code.lower().replace("emp-", "").strip()

                eid_stmt = select(Employee.id).where(or_(
                    func.lower(Employee.employee_code) == raw_code.lower(),
                    func.lower(Employee.employee_code) == clean_code,
                    func.lower(Employee.legacy_firebase_id) == raw_code.lower(),
                    func.lower(Employee.legacy_firebase_id) == clean_code
                )).limit(1)
                found_eid = (await db.execute(eid_stmt)).scalar_one_or_none()

                target_emp_id = found_eid or current_user_id
                if target_emp_id:
                    stmt = select(LeaveRequest).where(
                        and_(LeaveRequest.employee_id == target_emp_id, LeaveRequest.start_date == date_part)
                    ).order_by(
                        case((LeaveRequest.status.in_([LeaveStatus.PENDING, LeaveStatus.APPROVED]), 0), else_=1),
                        LeaveRequest.created_at.desc()
                    ).limit(1)
                    if lock:
                        stmt = stmt.with_for_update()
                    found = (await db.execute(stmt)).scalars().first()
                    if found:
                        return found

    # 3. Fallback for authenticated current user: if user owns an active request matching start_date in string
    if current_user_id:
        import re
        date_match = re.search(r'\d{4}-\d{2}-\d{2}', clean)
        if date_match:
            try:
                d_val = datetime.strptime(date_match.group(0), "%Y-%m-%d").date()
                stmt = select(LeaveRequest).where(
                    and_(LeaveRequest.employee_id == current_user_id, LeaveRequest.start_date == d_val)
                ).order_by(
                    case((LeaveRequest.status.in_([LeaveStatus.PENDING, LeaveStatus.APPROVED]), 0), else_=1),
                    LeaveRequest.created_at.desc()
                ).limit(1)
                if lock:
                    stmt = stmt.with_for_update()
                found = (await db.execute(stmt)).scalars().first()
                if found:
                    return found
            except Exception:
                pass

    return None


async def _lock_employee(db: AsyncSession, emp_id: UUID) -> Optional[Employee]:
    return (await db.execute(select(Employee).where(Employee.id == emp_id).with_for_update())).scalar_one_or_none()


@router.get("/", response_model=List[LeaveRequestOut])
async def list_leaves(
    employee_id: Optional[UUID] = None,
    status: Optional[LeaveStatus] = None,
    limit: int = Query(500, ge=1, le=2000),
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    # Privileged roles (SUPER_ADMIN, HR_ADMIN, PROJECT_MANAGER) can view all or filter by employee_id.
    # Regular employees and Tech Leads are scoped strictly to their own requests.
    PRIVILEGED_ROLES = (UserRole.SUPER_ADMIN, UserRole.HR_ADMIN, UserRole.PROJECT_MANAGER)
    is_privileged = bool(current_user and current_user.role in PRIVILEGED_ROLES)
    target_emp_id = employee_id if is_privileged else current_user.id
    cache_key = f"{target_emp_id}:{status}:{limit}"
    now_ts = time.time()
    cached = _LEAVES_CACHE.get(cache_key)
    if cached and cached[0] > now_ts:
        return cached[1]

    stmt = (
        select(LeaveRequest, Employee.employee_code, Employee.full_name, Employee.department)
        .join(Employee, LeaveRequest.employee_id == Employee.id, isouter=True)
    )
    if target_emp_id:
        stmt = stmt.where(LeaveRequest.employee_id == target_emp_id)
    if status:
        stmt = stmt.where(LeaveRequest.status == status)
    stmt = stmt.order_by(LeaveRequest.created_at.desc()).limit(limit)
    rows = (await db.execute(stmt)).all()

    out_leaves: List[LeaveRequestOut] = []
    for leave, code, name, dept in rows:
        o = LeaveRequestOut.model_validate(leave)
        o.employee_code, o.employee_name, o.department = code, name, dept
        out_leaves.append(o)

    if len(_LEAVES_CACHE) >= _LEAVES_CACHE_MAX_KEYS:
        _LEAVES_CACHE.clear()
    _LEAVES_CACHE[cache_key] = (now_ts + _LEAVES_CACHE_TTL, out_leaves)
    return out_leaves


@router.post("/", response_model=LeaveRequestOut)
async def submit_leave(
    payload: LeaveRequestCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    # 1) Idempotent replay FIRST (a retry must return the original, scoped to the caller only).
    code_in = payload.request_code.strip() if payload.request_code else None
    if code_in:
        existing = (await db.execute(select(LeaveRequest).where(LeaveRequest.request_code == code_in))).scalar_one_or_none()
        if existing:
            if existing.employee_id != current_user.id:
                raise HTTPException(status_code=409, detail="Request code already in use")
            return await _to_out(db, existing)

    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="End date cannot be earlier than start date")
    reason = (payload.reason or "").strip()
    if not reason:
        raise HTTPException(status_code=422, detail="A reason is required")
    if len(reason) > MAX_REASON_LEN:
        raise HTTPException(status_code=422, detail="Reason is too long")

    req_type = LeaveType.WFH if payload.type in [LeaveType.WFH, LeaveType.WORK_FROM_HOME] else payload.type
    num_days = (payload.end_date - payload.start_date).days + 1
    if num_days > MAX_LEAVE_DAYS:
        raise HTTPException(status_code=400, detail=f"A single request cannot exceed {MAX_LEAVE_DAYS} days")

    # Serialize this employee's submissions so concurrent requests can't both pass the checks below.
    emp = await _lock_employee(db, current_user.id)

    overlap = (await db.execute(
        select(LeaveRequest).where(and_(
            LeaveRequest.employee_id == current_user.id,
            LeaveRequest.status.in_([LeaveStatus.PENDING, LeaveStatus.APPROVED]),
            LeaveRequest.start_date <= payload.end_date,
            LeaveRequest.end_date >= payload.start_date,
        )).limit(1)
    )).scalars().first()
    if overlap:
        raise HTTPException(status_code=400, detail=f"An active or pending {overlap.type.value} request already exists for dates overlapping with {payload.start_date} to {payload.end_date}.")

    # Balance check counts days already promised by other PENDING requests of the same type.
    if req_type in PAID_TYPES:
        avail = float(getattr(emp, BALANCE_ATTR[req_type]) or 0.0)
        pending_rows = (await db.execute(select(LeaveRequest.start_date, LeaveRequest.end_date).where(and_(
            LeaveRequest.employee_id == current_user.id, LeaveRequest.type == req_type,
            LeaveRequest.status == LeaveStatus.PENDING)))).all()
        pending_days = sum((e - s).days + 1 for s, e in pending_rows)
        if avail - pending_days < num_days:
            raise HTTPException(status_code=400, detail=f"Insufficient {req_type.value.replace('_', ' ').title()} balance: requested {num_days} day(s), available: {max(avail - pending_days, 0)}")

    leave = LeaveRequest(
        id=uuid.uuid4(),
        request_code=code_in or f"LV-{payload.start_date.year}-{uuid.uuid4().hex[:6].upper()}",
        employee_id=current_user.id, type=req_type, start_date=payload.start_date, end_date=payload.end_date,
        reason=reason, status=LeaveStatus.PENDING, ceo_status=ApprovalStatus.PENDING,
        cto_status=ApprovalStatus.WAITING_CEO, deduction_applied=False,
    )
    db.add(leave)
    add_audit(db, current_user.id, "LEAVE_SUBMITTED", target=leave.request_code,
              details=f"{req_type.value} {payload.start_date}..{payload.end_date}", entity_type="leave",
              entity_id=str(leave.id), request=request)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=409, detail="Request code already in use")
    await db.refresh(leave)
    invalidate_leaves_cache()
    return await _to_out(db, leave)


@router.patch("/{leave_id}/review", response_model=LeaveRequestOut)
async def review_leave(
    leave_id: str,
    payload: ExecutiveLeaveReview,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_executive()),
):
    if payload.action not in (ApprovalStatus.APPROVED, ApprovalStatus.REJECTED, ApprovalStatus.WAITING_CEO):
        raise HTTPException(status_code=422, detail="Action must be APPROVED, REJECTED, or WAITING_CEO")

    now = datetime.now(timezone.utc)
    leave = await _find_leave(db, leave_id, current_user_id=None, lock=True)
    if not leave:
        raise HTTPException(status_code=404, detail="Leave request not found")

    if leave.status == LeaveStatus.CANCELLED:
        raise HTTPException(status_code=409, detail="This request was cancelled by the employee and cannot be reviewed")

    if leave.status == LeaveStatus.APPROVED and payload.action == ApprovalStatus.APPROVED:
        # Idempotent re-approval
        return await _to_out(db, leave)

    is_ceo = current_user.executive_tier == ExecutiveTier.CEO
    is_cto = current_user.executive_tier == ExecutiveTier.CTO
    is_super_override = current_user.role == UserRole.SUPER_ADMIN and not (is_ceo or is_cto)

    # Self-review guard: nobody approves/rejects their own request (DECISION: tier-less Super Admin may review executives').
    if leave.employee_id == current_user.id:
        raise HTTPException(status_code=403, detail="You cannot review your own leave request")

    if is_cto:
        is_bypass = bool(payload.notes and ("bypass" in payload.notes.lower() or "direct" in payload.notes.lower()))
        if payload.action == ApprovalStatus.APPROVED:
            if leave.ceo_status != ApprovalStatus.APPROVED:
                if not is_bypass:
                    raise HTTPException(status_code=400, detail="CTO cannot review leave before CEO has approved it")
                # CTO double-slide / direct approval bypassing CEO
                leave.ceo_status = ApprovalStatus.APPROVED
                leave.ceo_reviewed_by = current_user.id
                leave.ceo_reviewed_at = now
                leave.ceo_notes = "Bypassed via CTO direct sanction"
            leave.cto_status = ApprovalStatus.APPROVED
            leave.cto_reviewed_by, leave.cto_reviewed_at, leave.cto_notes = current_user.id, now, payload.notes
        elif payload.action == ApprovalStatus.WAITING_CEO:
            # 1st slide: CTO marks as CEO Approval Needed
            leave.cto_status = ApprovalStatus.WAITING_CEO
            leave.cto_reviewed_by, leave.cto_reviewed_at, leave.cto_notes = current_user.id, now, payload.notes or "CEO Approval Needed"
        elif payload.action == ApprovalStatus.REJECTED:
            leave.cto_status = ApprovalStatus.REJECTED
            leave.cto_reviewed_by, leave.cto_reviewed_at, leave.cto_notes = current_user.id, now, payload.notes
    elif is_ceo:
        leave.ceo_status = payload.action
        leave.ceo_reviewed_by, leave.ceo_reviewed_at, leave.ceo_notes = current_user.id, now, payload.notes
        if payload.action == ApprovalStatus.APPROVED:
            if leave.cto_status in (ApprovalStatus.WAITING_CEO, ApprovalStatus.PENDING):
                # If CTO already marked "CEO Approval Needed", CEO's approval completes the sanction
                if leave.cto_notes and "CEO Approval Needed" in leave.cto_notes:
                    leave.cto_status = ApprovalStatus.APPROVED
                    leave.cto_reviewed_at = now
                else:
                    leave.cto_status = ApprovalStatus.PENDING
    elif is_super_override:
        leave.ceo_status = leave.cto_status = payload.action
        leave.ceo_reviewed_by = leave.cto_reviewed_by = current_user.id
        leave.ceo_reviewed_at = leave.cto_reviewed_at = now
        leave.ceo_notes = leave.cto_notes = payload.notes

    if payload.action == ApprovalStatus.REJECTED:
        leave.status = LeaveStatus.REJECTED
        leave.rejection_reason = payload.notes or "Rejected by executive review"
    elif leave.ceo_status == ApprovalStatus.APPROVED and leave.cto_status in (ApprovalStatus.APPROVED, ApprovalStatus.NA):
        # Final approval: debit the balance atomically (employee row locked) - never below zero.
        if leave.type in PAID_TYPES and not leave.deduction_applied:
            num_days = (leave.end_date - leave.start_date).days + 1
            emp = await _lock_employee(db, leave.employee_id)
            attr = BALANCE_ATTR[leave.type]
            current_bal = float(getattr(emp, attr) or 0.0) if emp else 0.0
            if emp is None or current_bal < num_days:
                await db.rollback()
                raise HTTPException(status_code=400, detail=f"Cannot approve: employee has only {current_bal} day(s) of {leave.type.value.replace('_', ' ').title()} left but {num_days} requested. Adjust the balance or reject the request.")
            new_bal = current_bal - num_days
            setattr(emp, attr, new_bal)
            db.add(LeaveLedger(
                id=uuid.uuid4(), employee_id=emp.id, category=leave.type,
                transaction_type=LedgerTransactionType.APPROVED_DEBIT, amount=num_days, balance_after=new_bal,
                reference_id=leave.request_code, notes=f"Approved leave deduction for {leave.request_code}"))
            leave.deduction_applied = True
        leave.status = LeaveStatus.APPROVED
        leave.rejection_reason = None

    add_audit(db, current_user.id, f"LEAVE_{payload.action.value}", target=leave.request_code,
              details=(payload.notes or "")[:500], entity_type="leave", entity_id=str(leave.id), request=request)
    await db.commit()
    await db.refresh(leave)
    invalidate_leaves_cache()
    return await _to_out(db, leave)


@router.patch("/{leave_id}/cancel", response_model=LeaveRequestOut)
@router.delete("/{leave_id}", response_model=LeaveRequestOut)
async def cancel_leave(
    leave_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    leave = await _find_leave(db, leave_id, current_user_id=current_user.id, lock=True)
    if not leave:
        raise HTTPException(status_code=404, detail="Leave request not found")

    is_owner = current_user.id == leave.employee_id
    is_admin = (current_user.role in [UserRole.SUPER_ADMIN, UserRole.HR_ADMIN] or
                current_user.executive_tier in [ExecutiveTier.CEO, ExecutiveTier.CTO])
    if not is_owner and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to cancel this leave request")

    if leave.status == LeaveStatus.CANCELLED:
        return await _to_out(db, leave)  # idempotent
    if leave.status == LeaveStatus.REJECTED:
        raise HTTPException(status_code=409, detail="A rejected request cannot be cancelled")

    today = company_now().date()
    if leave.status == LeaveStatus.APPROVED and leave.end_date < today and not is_admin:
        raise HTTPException(status_code=409, detail="Leave that has already been taken cannot be cancelled. Please contact HR.")

    if leave.status == LeaveStatus.APPROVED and leave.deduction_applied:
        num_days = (leave.end_date - leave.start_date).days + 1
        emp = await _lock_employee(db, leave.employee_id)
        if emp and leave.type in PAID_TYPES:
            attr = BALANCE_ATTR[leave.type]
            new_bal = float(getattr(emp, attr) or 0.0) + num_days
            setattr(emp, attr, new_bal)
            db.add(LeaveLedger(
                id=uuid.uuid4(), employee_id=emp.id, category=leave.type,
                transaction_type=LedgerTransactionType.REVERSAL_CREDIT, amount=num_days, balance_after=new_bal,
                reference_id=leave.request_code, notes=f"Reversal credit for cancelled leave {leave.request_code}"))
        leave.deduction_applied = False

    leave.status = LeaveStatus.CANCELLED
    add_audit(db, current_user.id, "LEAVE_CANCELLED", target=leave.request_code, entity_type="leave",
              entity_id=str(leave.id), request=request)
    await db.commit()
    await db.refresh(leave)
    invalidate_leaves_cache()
    return await _to_out(db, leave)
