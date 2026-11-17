from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_
from uuid import UUID
from datetime import datetime, timezone
from typing import List, Optional, Dict, Tuple
import uuid
import random
import time

from app.core.database import get_db
from app.models.employee import Employee
from app.models.leave import LeaveRequest, LeaveLedger
from app.models.enums import LeaveType, LeaveStatus, ApprovalStatus, UserRole, ExecutiveTier, LedgerTransactionType
from app.schemas.leave import LeaveRequestCreate, ExecutiveLeaveReview, LeaveRequestOut
from app.api.deps import get_current_user, get_optional_current_user, require_executive

router = APIRouter()

# In-memory leaves cache with 15-second TTL
_LEAVES_CACHE: Dict[str, Tuple[float, List[LeaveRequestOut]]] = {}

def invalidate_leaves_cache():
    _LEAVES_CACHE.clear()

@router.get("/", response_model=List[LeaveRequestOut])
async def list_leaves(
    employee_id: Optional[UUID] = None,
    status: Optional[LeaveStatus] = None,
    limit: int = 500,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
    target_emp_id = employee_id if employee_id else (current_user.id if (current_user and current_user.role == UserRole.EMPLOYEE) else None)
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
    result = await db.execute(stmt)
    rows = result.all()

    out_leaves: List[LeaveRequestOut] = []
    for leave, code, name, dept in rows:
        leave_dict = LeaveRequestOut.model_validate(leave)
        leave_dict.employee_code = code
        leave_dict.employee_name = name
        leave_dict.department = dept
        out_leaves.append(leave_dict)

    _LEAVES_CACHE[cache_key] = (now_ts + 60.0, out_leaves)
    return out_leaves

@router.post("/", response_model=LeaveRequestOut)
async def submit_leave(
    payload: LeaveRequestCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    if payload.end_date < payload.start_date:
        raise HTTPException(status_code=400, detail="End date cannot be earlier than start date")

    req_type = LeaveType.WFH if payload.type in [LeaveType.WFH, LeaveType.WORK_FROM_HOME] else payload.type
    num_days = (payload.end_date - payload.start_date).days + 1

    # Balance validation for paid categories
    if req_type == LeaveType.EARN_LEAVE:
        avail = float(current_user.earn_leave_balance or 0.0)
        if avail < num_days:
            raise HTTPException(status_code=400, detail=f"Insufficient Earn Leave balance: Requested {num_days} day(s), available: {avail}")
    elif req_type == LeaveType.SICK_LEAVE:
        avail = float(current_user.sick_leave_balance or 0.0)
        if avail < num_days:
            raise HTTPException(status_code=400, detail=f"Insufficient Sick Leave balance: Requested {num_days} day(s), available: {avail}")
    elif req_type == LeaveType.CASUAL_LEAVE:
        avail = float(current_user.casual_leave_balance or 0.0)
        if avail < num_days:
            raise HTTPException(status_code=400, detail=f"Insufficient Casual Leave balance: Requested {num_days} day(s), available: {avail}")

    # Check for existing duplicate or overlapping pending/approved leave requests
    overlap_res = await db.execute(
        select(LeaveRequest).where(
            and_(
                LeaveRequest.employee_id == current_user.id,
                LeaveRequest.status.in_([LeaveStatus.PENDING, LeaveStatus.APPROVED]),
                LeaveRequest.start_date <= payload.end_date,
                LeaveRequest.end_date >= payload.start_date
            )
        )
    )
    existing_overlap = overlap_res.first()
    if existing_overlap:
        raise HTTPException(
            status_code=400,
            detail=f"An active or pending {existing_overlap[0].type.value} request already exists for dates overlapping with {payload.start_date} to {payload.end_date}."
        )

    # Generate sequential/unique request code
    code = f"LV-{payload.start_date.year}-{uuid.uuid4().hex[:6].upper()}"

    leave = LeaveRequest(
        id=uuid.uuid4(),
        request_code=code,
        employee_id=current_user.id,
        type=req_type,
        start_date=payload.start_date,
        end_date=payload.end_date,
        reason=payload.reason,
        status=LeaveStatus.PENDING,
        ceo_status=ApprovalStatus.PENDING,
        cto_status=ApprovalStatus.WAITING_CEO,
        deduction_applied=False
    )
    db.add(leave)
    await db.commit()
    await db.refresh(leave)
    invalidate_leaves_cache()
    emp_applicant = await db.execute(select(Employee).where(Employee.id == leave.employee_id))
    applicant = emp_applicant.scalar_one_or_none()
    out = LeaveRequestOut.model_validate(leave)
    if applicant:
        out.employee_code = applicant.employee_code
        out.employee_name = applicant.full_name
        out.department = applicant.department
    return out

@router.patch("/{leave_id}/review", response_model=LeaveRequestOut)
async def review_leave(
    leave_id: str,
    payload: ExecutiveLeaveReview,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_executive())
):
    now = datetime.now(timezone.utc)
    clean_id = leave_id.strip()
    try:
        val_uuid = uuid.UUID(clean_id)
        stmt = select(LeaveRequest).where(or_(LeaveRequest.id == val_uuid, LeaveRequest.request_code == clean_id))
    except ValueError:
        stmt = select(LeaveRequest).where(LeaveRequest.request_code == clean_id)
    res = await db.execute(stmt)
    leave = res.scalar_one_or_none()
    if not leave:
        raise HTTPException(status_code=404, detail="Leave request not found")

    is_super_admin = (current_user.role == UserRole.SUPER_ADMIN)
    is_ceo = (current_user.executive_tier == ExecutiveTier.CEO)
    is_cto = (current_user.executive_tier == ExecutiveTier.CTO)

    if is_cto:
        if leave.ceo_status != ApprovalStatus.APPROVED:
            raise HTTPException(status_code=400, detail="CTO cannot review leave before CEO has approved it")
        leave.cto_status = payload.action
        leave.cto_reviewed_by = current_user.id
        leave.cto_reviewed_at = now
        leave.cto_notes = payload.notes
    elif is_ceo:
        leave.ceo_status = payload.action
        leave.ceo_reviewed_by = current_user.id
        leave.ceo_reviewed_at = now
        leave.ceo_notes = payload.notes
        if payload.action == ApprovalStatus.APPROVED:
            # Unblock CTO stage
            if leave.cto_status == ApprovalStatus.WAITING_CEO:
                leave.cto_status = ApprovalStatus.PENDING
    elif is_super_admin:
        # Super Admin has overarching executive override
        leave.ceo_status = payload.action
        leave.cto_status = payload.action
        leave.ceo_reviewed_by = current_user.id
        leave.cto_reviewed_by = current_user.id
        leave.ceo_reviewed_at = now
        leave.cto_reviewed_at = now
        leave.ceo_notes = payload.notes
        leave.cto_notes = payload.notes
        leave.cto_reviewed_at = now
        leave.cto_notes = payload.notes

    # Evaluate Overall Status
    if payload.action == ApprovalStatus.REJECTED:
        leave.status = LeaveStatus.REJECTED
        leave.rejection_reason = payload.notes or "Rejected by executive review"
    elif (leave.ceo_status == ApprovalStatus.APPROVED and 
          (leave.cto_status == ApprovalStatus.APPROVED or leave.cto_status == ApprovalStatus.NA or is_ceo)):
        # When both approve or CEO grants approval
        leave.status = LeaveStatus.APPROVED

        # Apply ledger deduction if not already applied
        if not leave.deduction_applied:
            num_days = (leave.end_date - leave.start_date).days + 1
            # Fetch target employee
            emp_res = await db.execute(select(Employee).where(Employee.id == leave.employee_id))
            emp = emp_res.scalar_one_or_none()
            if emp:
                new_bal = 0.0
                if leave.type.value == "EARN_LEAVE":
                    emp.earn_leave_balance = max(0.0, float(emp.earn_leave_balance or 0.0) - num_days)
                    new_bal = float(emp.earn_leave_balance)
                elif leave.type.value == "SICK_LEAVE":
                    emp.sick_leave_balance = max(0.0, float(emp.sick_leave_balance or 0.0) - num_days)
                    new_bal = float(emp.sick_leave_balance)
                elif leave.type.value == "CASUAL_LEAVE":
                    emp.casual_leave_balance = max(0.0, float(emp.casual_leave_balance or 0.0) - num_days)
                    new_bal = float(emp.casual_leave_balance)

                # Append to LeaveLedger
                ledger_entry = LeaveLedger(
                    id=uuid.uuid4(),
                    employee_id=emp.id,
                    category=leave.type,
                    transaction_type=LedgerTransactionType.APPROVED_DEBIT,
                    amount=num_days,
                    balance_after=new_bal,
                    reference_id=leave.request_code,
                    notes=f"Approved leave deduction for {leave.request_code}"
                )
                db.add(ledger_entry)
            leave.deduction_applied = True

    await db.commit()
    await db.refresh(leave)
    invalidate_leaves_cache()
    emp_applicant = await db.execute(select(Employee).where(Employee.id == leave.employee_id))
    applicant = emp_applicant.scalar_one_or_none()
    out = LeaveRequestOut.model_validate(leave)
    if applicant:
        out.employee_code = applicant.employee_code
        out.employee_name = applicant.full_name
        out.department = applicant.department
    return out
