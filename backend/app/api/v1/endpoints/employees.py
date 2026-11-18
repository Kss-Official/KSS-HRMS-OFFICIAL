from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.exc import IntegrityError
from sqlalchemy import select, or_, text, func
from uuid import UUID
from typing import List, Optional, Dict, Tuple
import json
import math
import time
import uuid

from app.core.database import get_db
from app.core.security import get_password_hash, validate_new_password
from app.core.cloudinary_service import (
    upload_employee_photo as cloudinary_upload_employee_photo,
    cleanup_old_employee_photo,
)
from app.models.employee import Employee
from app.models.enums import UserRole, ExecutiveTier
from app.schemas.employee import EmployeeOut, EmployeeCreate, EmployeeUpdate, FaceEnrollRequest, PhotoUploadRequest
from app.api.deps import get_current_user, require_roles, invalidate_user_cache
from app.api.audit_util import add_audit

router = APIRouter()

MAX_PHOTO_B64_CHARS = 8 * 1024 * 1024  # ~6 MB of image data
FACE_MATCH_THRESHOLD = 0.38

# Roles that may see every field of every employee.
PRIVILEGED_VIEW_ROLES = {UserRole.SUPER_ADMIN, UserRole.HR_ADMIN, UserRole.PROJECT_MANAGER, UserRole.TECH_LEAD}
# Fields a regular EMPLOYEE must not see about OTHER people (they still see their own).
PEER_REDACTED_FIELDS = {
    "address": None, "city": None, "state": None, "postal_code": None,
    "emergency_contact": None, "emergency_relationship": None,
    "earn_leave_balance": 0.0, "sick_leave_balance": 0.0, "casual_leave_balance": 0.0,
}


def normalize_vector(vec: List[float]) -> List[float]:
    """Strict L2 unit normalization for illumination-invariant vector comparisons"""
    norm = math.sqrt(sum(float(x) ** 2 for x in vec))
    if norm > 0:
        return [float(x) / norm for x in vec]
    return [float(x) for x in vec]


def validate_descriptor(vec: Optional[List[float]]) -> List[float]:
    """128 finite, non-degenerate floats. Rejects NaN/inf/all-zero templates."""
    if not isinstance(vec, list) or len(vec) != 128:
        raise HTTPException(status_code=400, detail="Face descriptor must be exactly 128 float values")
    try:
        floats = [float(x) for x in vec]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Face descriptor must contain only numbers")
    if any(not math.isfinite(x) for x in floats):
        raise HTTPException(status_code=400, detail="Face descriptor contains invalid values")
    if math.sqrt(sum(x * x for x in floats)) < 1e-6:
        raise HTTPException(status_code=400, detail="Face descriptor is empty")
    return floats


def validate_photo_url(url: Optional[str]) -> None:
    if not url:
        return
    if url.startswith("data:image/") or ";base64," in url:
        if len(url) > MAX_PHOTO_B64_CHARS:
            raise HTTPException(status_code=413, detail="Photo is too large")
        return
    if not (url.startswith("https://") or url.startswith("http://") or url.startswith("/uploads/") or url.startswith("/avatars/")):
        raise HTTPException(status_code=422, detail="Invalid profile photo URL")


# Employee list cache (unredacted DTOs, per query). Bounded; redaction happens per request.
_EMPLOYEES_CACHE: Dict[str, Tuple[float, List[EmployeeOut]]] = {}
_EMPLOYEES_CACHE_TTL = 60.0
_EMPLOYEES_CACHE_MAX_KEYS = 64


def invalidate_employees_cache():
    _EMPLOYEES_CACHE.clear()


def _fallback_manager(emp: Employee) -> str:
    # TODO(data): replace by populating reporting_manager_id for these employees.
    if emp.employee_code == 'KSS2407009':
        return 'Gaurav kumar Tripathi'
    if emp.employee_code in ('KSS2407012', 'KSS2407013'):
        return 'Akshit ujjain'
    if emp.employee_code in ('KSS2407001', 'KSS2407002', 'KSS2407015'):
        return 'Executive Board'
    return 'D. Koushik'


def view_for(out: EmployeeOut, viewer: Employee) -> EmployeeOut:
    """Returns a copy of `out` appropriate for `viewer`.
    - face_descriptor (biometric template) only ever goes to its owner.
    - plain EMPLOYEEs don't see peers' address/emergency contact/leave balances."""
    is_self = out.id == viewer.id
    update: dict = {}
    if not is_self:
        update["face_descriptor"] = None
        if viewer.role not in PRIVILEGED_VIEW_ROLES:
            update.update(PEER_REDACTED_FIELDS)
    return out.model_copy(update=update) if update else out


async def _find_employee(db: AsyncSession, identifier: str) -> Optional[Employee]:
    """Lookup by UUID, employee_code, or legacy firebase id (exact, case-insensitive)."""
    clean = identifier.strip()
    conds = [func.lower(Employee.employee_code) == clean.lower(),
             func.lower(Employee.legacy_firebase_id) == clean.lower()]
    try:
        conds.append(Employee.id == uuid.UUID(clean))
    except ValueError:
        pass
    rows = (await db.execute(select(Employee).where(or_(*conds)).limit(2))).scalars().all()
    return rows[0] if len(rows) == 1 else None  # ambiguous => treat as not found


def _escape_like(s: str) -> str:
    return s.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("/", response_model=List[EmployeeOut])
async def list_employees(
    department: Optional[str] = Query(None, max_length=100),
    role: Optional[UserRole] = None,
    is_active: Optional[bool] = None,
    search: Optional[str] = Query(None, max_length=100),
    skip: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    cache_key = f"{department}:{role}:{is_active}:{search}:{skip}:{limit}"
    now_ts = time.time()
    cached = _EMPLOYEES_CACHE.get(cache_key)
    if cached and cached[0] > now_ts:
        return [view_for(o, current_user) for o in cached[1]]

    stmt = select(Employee)
    if department:
        stmt = stmt.where(Employee.department == department)
    if role:
        stmt = stmt.where(Employee.role == role)
    if is_active is not None:
        stmt = stmt.where(Employee.is_active == is_active)
    if search and search.strip():
        term = f"%{_escape_like(search.strip())}%"
        stmt = stmt.where(or_(
            Employee.full_name.ilike(term, escape="\\"),
            Employee.email.ilike(term, escape="\\"),
            Employee.employee_code.ilike(term, escape="\\"),
        ))
    stmt = stmt.order_by(Employee.employee_code.asc()).offset(skip).limit(limit)
    employees = (await db.execute(stmt)).scalars().all()

    manager_ids = {e.reporting_manager_id for e in employees if e.reporting_manager_id}
    manager_map = {}
    if manager_ids:
        m_res = await db.execute(select(Employee.id, Employee.full_name).where(Employee.id.in_(manager_ids)))
        manager_map = {row[0]: row[1] for row in m_res.fetchall()}

    for e in employees:
        setattr(e, 'reporting_manager', manager_map.get(e.reporting_manager_id) or _fallback_manager(e))

    out = [EmployeeOut.model_validate(e) for e in employees]
    if len(_EMPLOYEES_CACHE) >= _EMPLOYEES_CACHE_MAX_KEYS:
        _EMPLOYEES_CACHE.clear()
    _EMPLOYEES_CACHE[cache_key] = (now_ts + _EMPLOYEES_CACHE_TTL, out)
    return [view_for(o, current_user) for o in out]


@router.get("/{identifier}", response_model=EmployeeOut)
async def get_employee(
    identifier: str,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    emp = await _find_employee(db, identifier)
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    m_name = None
    if emp.reporting_manager_id:
        m_name = (await db.execute(select(Employee.full_name).where(Employee.id == emp.reporting_manager_id))).scalar_one_or_none()
    setattr(emp, 'reporting_manager', m_name or _fallback_manager(emp))
    return view_for(EmployeeOut.model_validate(emp), current_user)


def _assert_can_grant(current_user: Employee, role: Optional[UserRole], tier: Optional[ExecutiveTier]) -> None:
    """Only a SUPER_ADMIN may mint SUPER_ADMIN accounts or executive (CEO/CTO) tiers."""
    if current_user.role == UserRole.SUPER_ADMIN:
        return
    if role == UserRole.SUPER_ADMIN or (tier is not None and tier != ExecutiveTier.NONE):
        raise HTTPException(status_code=403, detail="Only a Super Admin can assign Super Admin or executive roles")


@router.post("/", response_model=EmployeeOut)
async def create_employee(
    payload: EmployeeCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.HR_ADMIN, UserRole.SUPER_ADMIN])),
):
    _assert_can_grant(current_user, payload.role, payload.executive_tier)

    email = payload.email.strip()
    code = payload.employee_code.strip()
    if not email or not code or "@" not in email:
        raise HTTPException(status_code=422, detail="A valid email and employee code are required")
    err = validate_new_password(payload.password)
    if err:
        raise HTTPException(status_code=422, detail=err)
    validate_photo_url(payload.profile_photo_url)

    dup = await db.execute(
        select(Employee.id).where(or_(func.lower(Employee.email) == email.lower(),
                                      func.lower(Employee.employee_code) == code.lower())).limit(1)
    )
    if dup.first():
        raise HTTPException(status_code=400, detail="Employee with this email or code already exists")

    face_desc = None
    face_emb = None
    if payload.face_descriptor:
        face_desc = normalize_vector(validate_descriptor(payload.face_descriptor))
        face_emb = face_desc  # a client-supplied separate embedding is never trusted

    photo_url = payload.profile_photo_url
    if photo_url and (photo_url.startswith("data:image/") or ";base64," in photo_url or (photo_url.startswith("http") and "res.cloudinary.com" not in photo_url)):
        photo_url = cloudinary_upload_employee_photo(photo_url, code).get("secure_url")

    new_emp = Employee(
        id=uuid.uuid4(), employee_code=code, email=email,
        password_hash=get_password_hash(payload.password),
        full_name=payload.full_name.strip(), role=payload.role, executive_tier=payload.executive_tier,
        employment_type=payload.employment_type, department=payload.department, designation=payload.designation,
        joining_date=payload.joining_date, work_location=payload.work_location,
        reporting_manager_id=payload.reporting_manager_id, phone=payload.phone, gender=payload.gender,
        date_of_birth=payload.date_of_birth, address=payload.address, city=payload.city, state=payload.state,
        postal_code=payload.postal_code, emergency_contact=payload.emergency_contact,
        emergency_relationship=payload.emergency_relationship, profile_photo_url=photo_url, bio=payload.bio,
        linkedin_url=payload.linkedin_url, is_active=payload.is_active,
        earn_leave_balance=max(payload.earn_leave_balance, 0), sick_leave_balance=max(payload.sick_leave_balance, 0),
        casual_leave_balance=max(payload.casual_leave_balance, 0),
        face_descriptor=face_desc, face_embedding=face_emb, is_face_enrolled=bool(face_desc),
    )
    db.add(new_emp)
    add_audit(db, current_user.id, "EMPLOYEE_CREATED", target=code,
              details=f"role={payload.role.value} tier={payload.executive_tier.value}",
              entity_type="employee", entity_id=str(new_emp.id), request=request)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        raise HTTPException(status_code=400, detail="Employee with this email or code already exists")
    await db.refresh(new_emp)
    invalidate_employees_cache()
    return view_for(EmployeeOut.model_validate(new_emp), current_user)


SELF_RESTRICTED_FIELDS = {
    "role", "executive_tier", "earn_leave_balance", "sick_leave_balance", "casual_leave_balance",
    "is_active", "department", "designation", "employment_type", "work_location", "reporting_manager_id",
}
PM_FORBIDDEN_FIELDS = {"role", "executive_tier", "is_active"}


@router.patch("/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: str,
    payload: EmployeeUpdate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    emp = await _find_employee(db, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    is_self = current_user.id == emp.id
    is_hr_or_super = current_user.role in (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN)
    is_pm = current_user.role == UserRole.PROJECT_MANAGER
    update_data = payload.model_dump(exclude_unset=True)

    if is_hr_or_super:
        pass
    elif is_pm:
        for f in PM_FORBIDDEN_FIELDS:
            update_data.pop(f, None)
    elif is_self:
        for f in SELF_RESTRICTED_FIELDS:
            update_data.pop(f, None)
    else:
        raise HTTPException(status_code=403, detail="Not authorized to edit other employee profiles")

    # Privilege-escalation / hierarchy guards
    if "role" in update_data or "executive_tier" in update_data:
        _assert_can_grant(current_user, update_data.get("role"), update_data.get("executive_tier"))
    if current_user.role == UserRole.HR_ADMIN and not is_self and (emp.role == UserRole.SUPER_ADMIN or emp.executive_tier != ExecutiveTier.NONE):
        # HR may edit contact details of executives but not their access level / status
        for f in ("role", "executive_tier", "is_active"):
            if f in update_data:
                raise HTTPException(status_code=403, detail="Only a Super Admin can change an executive's access")
    if is_self and update_data.get("is_active") is False:
        raise HTTPException(status_code=400, detail="You cannot deactivate your own account")
    for bal in ("earn_leave_balance", "sick_leave_balance", "casual_leave_balance"):
        if bal in update_data and (update_data[bal] is None or update_data[bal] < 0):
            raise HTTPException(status_code=422, detail="Leave balances cannot be negative")
    for nn in ("full_name", "department", "designation", "role", "executive_tier", "employment_type", "is_active"):
        if nn in update_data and update_data[nn] is None:
            update_data.pop(nn)  # non-nullable columns: ignore explicit nulls

    if "profile_photo_url" in update_data:
        val = update_data["profile_photo_url"]
        validate_photo_url(val)
        old_photo = emp.profile_photo_url
        if val and (val.startswith("data:image/") or ";base64," in val or (val.startswith("http") and "res.cloudinary.com" not in val)):
            new_url = cloudinary_upload_employee_photo(val, emp.employee_code).get("secure_url")
            update_data["profile_photo_url"] = new_url
            val = new_url
        if val != old_photo and old_photo:
            cleanup_old_employee_photo(old_photo)

    sensitive = {k for k in update_data if k in ("role", "executive_tier", "is_active", "earn_leave_balance",
                                                  "sick_leave_balance", "casual_leave_balance")}
    for field, val in update_data.items():
        setattr(emp, field, val)
    if sensitive:
        add_audit(db, current_user.id, "EMPLOYEE_UPDATED", target=emp.employee_code,
                  details="changed: " + ", ".join(sorted(sensitive)), entity_type="employee",
                  entity_id=str(emp.id), request=request)

    await db.commit()
    await db.refresh(emp)
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return view_for(EmployeeOut.model_validate(emp), current_user)


@router.post("/{employee_id}/photo", response_model=EmployeeOut)
async def upload_employee_photo(
    employee_id: str,
    payload: PhotoUploadRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    emp = await _find_employee(db, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    is_self = current_user.id == emp.id
    if not is_self and current_user.role not in (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER):
        raise HTTPException(status_code=403, detail="Not authorized to update photo for another employee")

    photo_data = payload.photo_data.strip()
    if not photo_data:
        raise HTTPException(status_code=422, detail="Photo data is required")
    if len(photo_data) > MAX_PHOTO_B64_CHARS:
        raise HTTPException(status_code=413, detail="Photo is too large")

    old_photo_url = emp.profile_photo_url
    new_photo_url = cloudinary_upload_employee_photo(photo_data, emp.employee_code).get("secure_url")
    if old_photo_url and old_photo_url != new_photo_url:
        cleanup_old_employee_photo(old_photo_url)
    emp.profile_photo_url = new_photo_url

    await db.commit()
    await db.refresh(emp)
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return view_for(EmployeeOut.model_validate(emp), current_user)


@router.post("/{employee_id}/enroll-face")
async def enroll_face(
    employee_id: str,
    payload: FaceEnrollRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    desc = validate_descriptor(payload.face_descriptor)

    emp = await _find_employee(db, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")
    if current_user.id != emp.id and current_user.role not in (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN):
        raise HTTPException(status_code=403, detail="Not authorized to enroll biometric profile for another user")

    norm_desc = normalize_vector(desc)
    vector_str = "[" + ",".join(str(float(x)) for x in norm_desc) + "]"

    dup_res = await db.execute(text("""
        SELECT id, employee_code, full_name, (face_embedding <-> CAST(:vec AS vector)) as dist
        FROM employees
        WHERE is_face_enrolled = true AND face_embedding IS NOT NULL AND id != :id
        ORDER BY dist ASC LIMIT 1
    """), {"vec": vector_str, "id": emp.id})
    closest = dup_res.first()
    if closest and closest.dist is not None and float(closest.dist) <= FACE_MATCH_THRESHOLD:
        # Don't disclose who the other person is to a non-admin caller.
        who = f"{closest.full_name} ({closest.employee_code})" if current_user.role in (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN) else "another employee"
        raise HTTPException(status_code=409, detail=f"Security Violation: This face is already enrolled under {who}. One individual cannot register under multiple employee accounts.")

    await db.execute(
        text("UPDATE employees SET face_descriptor = CAST(:desc AS jsonb), face_embedding = CAST(:vec AS vector), is_face_enrolled = true WHERE id = :id"),
        {"desc": json.dumps(norm_desc), "vec": vector_str, "id": emp.id},
    )
    add_audit(db, current_user.id, "FACE_ENROLLED", target=emp.employee_code,
              entity_type="employee", entity_id=str(emp.id), request=request)
    await db.commit()
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return {
        "message": "Biometric face profile enrolled successfully",
        "employee_id": str(emp.id), "employee_code": emp.employee_code,
        "full_name": emp.full_name, "is_face_enrolled": True,
    }


@router.post("/reset-all-faces")
async def reset_all_faces(
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.SUPER_ADMIN, UserRole.HR_ADMIN])),
):
    await db.execute(text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false"))
    add_audit(db, current_user.id, "FACE_RESET_ALL", target="ALL_EMPLOYEES", request=request)
    await db.commit()
    invalidate_employees_cache()
    invalidate_user_cache()
    return {"message": "All face biometric registrations have been reset successfully"}


@router.post("/{employee_id}/reset-face")
async def reset_employee_face(
    employee_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user),
):
    emp = await _find_employee(db, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")
    if current_user.id != emp.id and current_user.role not in (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER):
        raise HTTPException(status_code=403, detail="Not authorized to reset biometric profile for another user")

    await db.execute(
        text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false WHERE id = :id"),
        {"id": emp.id},
    )
    add_audit(db, current_user.id, "FACE_RESET", target=emp.employee_code,
              entity_type="employee", entity_id=str(emp.id), request=request)
    await db.commit()
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return {"message": f"Face biometric reset successfully for {emp.full_name}", "employee_code": emp.employee_code}


@router.delete("/{employee_id}")
async def delete_employee(
    employee_id: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.HR_ADMIN, UserRole.SUPER_ADMIN])),
):
    emp = await _find_employee(db, employee_id)
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")
    if emp.id == current_user.id:
        raise HTTPException(status_code=400, detail="You cannot delete your own account")
    if current_user.role == UserRole.HR_ADMIN and (emp.role == UserRole.SUPER_ADMIN or emp.executive_tier != ExecutiveTier.NONE):
        raise HTTPException(status_code=403, detail="Only a Super Admin can remove an executive account")
    if emp.role == UserRole.SUPER_ADMIN and emp.is_active:
        remaining = (await db.execute(
            select(func.count()).select_from(Employee).where(
                Employee.role == UserRole.SUPER_ADMIN, Employee.is_active == True, Employee.id != emp.id)  # noqa: E712
        )).scalar_one()
        if remaining < 1:
            raise HTTPException(status_code=400, detail="Cannot remove the last active Super Admin")

    code, emp_id, photo = emp.employee_code, emp.id, emp.profile_photo_url
    try:
        add_audit(db, current_user.id, "EMPLOYEE_DELETED", target=code, entity_type="employee", entity_id=str(emp_id), request=request)
        await db.delete(emp)
        await db.commit()
        outcome = "deleted"
    except IntegrityError:
        # Employee has attendance / leave / payroll history: keep the records, revoke access.
        await db.rollback()
        emp = await _find_employee(db, str(emp_id))
        emp.is_active = False
        add_audit(db, current_user.id, "EMPLOYEE_DEACTIVATED", target=code,
                  details="has history; deactivated instead of deleted", entity_type="employee",
                  entity_id=str(emp_id), request=request)
        await db.commit()
        outcome = "deactivated"
        photo = None  # keep photo for retained history

    if photo:
        cleanup_old_employee_photo(photo)  # only after the DB delete succeeded
    invalidate_employees_cache()
    invalidate_user_cache(emp_id)
    if outcome == "deleted":
        return {"message": f"Employee {code} and associated photo deleted successfully", "outcome": outcome}
    return {"message": f"Employee {code} has attendance/leave history, so the account was deactivated instead of deleted", "outcome": outcome}
