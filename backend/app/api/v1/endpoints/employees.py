from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, text, func
from uuid import UUID
from typing import List, Optional
import uuid
import json
import time
from typing import Dict, Tuple

from app.core.database import get_db
from app.core.security import get_password_hash
from app.models.employee import Employee
from app.models.enums import UserRole
from app.schemas.employee import EmployeeOut, EmployeeCreate, EmployeeUpdate, FaceEnrollRequest
from app.api.deps import get_current_user, get_optional_current_user, require_roles, invalidate_user_cache

router = APIRouter()

# In-memory employees list cache with 30-second TTL
_EMPLOYEES_CACHE: Dict[str, Tuple[float, List[EmployeeOut]]] = {}

def invalidate_employees_cache():
    _EMPLOYEES_CACHE.clear()

@router.get("/", response_model=List[EmployeeOut])
async def list_employees(
    department: Optional[str] = None,
    role: Optional[UserRole] = None,
    is_active: Optional[bool] = None,
    search: Optional[str] = None,
    skip: int = 0,
    limit: int = 200,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
    cache_key = f"{department}:{role}:{is_active}:{search}:{skip}:{limit}"
    now_ts = time.time()
    cached = _EMPLOYEES_CACHE.get(cache_key)
    if cached and cached[0] > now_ts:
        return cached[1]

    stmt = select(Employee)
    if department:
        stmt = stmt.where(Employee.department == department)
    if role:
        stmt = stmt.where(Employee.role == role)
    if is_active is not None:
        stmt = stmt.where(Employee.is_active == is_active)
    if search:
        search_term = f"%{search.strip()}%"
        stmt = stmt.where(
            or_(
                Employee.full_name.ilike(search_term),
                Employee.email.ilike(search_term),
                Employee.employee_code.ilike(search_term)
            )
        )
    stmt = stmt.order_by(Employee.employee_code.asc()).offset(skip).limit(limit)
    result = await db.execute(stmt)
    employees = result.scalars().all()

    # Resolve reporting manager names
    manager_ids = {e.reporting_manager_id for e in employees if e.reporting_manager_id}
    manager_map = {}
    if manager_ids:
        m_stmt = select(Employee.id, Employee.full_name).where(Employee.id.in_(manager_ids))
        m_res = await db.execute(m_stmt)
        manager_map = {row[0]: row[1] for row in m_res.fetchall()}

    for e in employees:
        if e.reporting_manager_id in manager_map:
            setattr(e, 'reporting_manager', manager_map[e.reporting_manager_id])
        elif e.employee_code == 'KSS2407009':
            setattr(e, 'reporting_manager', 'Gaurav kumar Tripathi')
        elif e.employee_code in ('KSS2407012', 'KSS2407013'):
            setattr(e, 'reporting_manager', 'Akshit ujjain')
        elif e.employee_code in ('KSS2407001', 'KSS2407002', 'KSS2407015'):
            setattr(e, 'reporting_manager', 'Executive Board')
        else:
            setattr(e, 'reporting_manager', 'D. Koushik')

    out = [EmployeeOut.model_validate(e) for e in employees]
    _EMPLOYEES_CACHE[cache_key] = (now_ts + 30.0, out)
    return out

@router.get("/{identifier}", response_model=EmployeeOut)
async def get_employee(
    identifier: str,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    # Try UUID lookup first, fallback to employee_code
    try:
        val_uuid = UUID(identifier)
        stmt = select(Employee).where(Employee.id == val_uuid)
    except ValueError:
        stmt = select(Employee).where(Employee.employee_code.ilike(identifier))

    result = await db.execute(stmt)
    emp = result.scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    if emp.reporting_manager_id:
        m_res = await db.execute(select(Employee.full_name).where(Employee.id == emp.reporting_manager_id))
        m_name = m_res.scalar_one_or_none()
        if m_name:
            setattr(emp, 'reporting_manager', m_name)
    if not getattr(emp, 'reporting_manager', None):
        if emp.employee_code == 'KSS2407009':
            setattr(emp, 'reporting_manager', 'Gaurav kumar Tripathi')
        elif emp.employee_code in ('KSS2407012', 'KSS2407013'):
            setattr(emp, 'reporting_manager', 'Akshit ujjain')
        elif emp.employee_code in ('KSS2407001', 'KSS2407002', 'KSS2407015'):
            setattr(emp, 'reporting_manager', 'Executive Board')
        else:
            setattr(emp, 'reporting_manager', 'D. Koushik')

    return emp

@router.post("/", response_model=EmployeeOut)
async def create_employee(
    payload: EmployeeCreate,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.HR_ADMIN, UserRole.SUPER_ADMIN]))
):
    # Check uniqueness
    existing = await db.execute(
        select(Employee).where(
            or_(Employee.email == payload.email, Employee.employee_code == payload.employee_code)
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Employee with this email or code already exists")

    hashed_pw = get_password_hash(payload.password)
    new_emp = Employee(
        id=uuid.uuid4(),
        employee_code=payload.employee_code,
        email=payload.email,
        password_hash=hashed_pw,
        full_name=payload.full_name,
        role=payload.role,
        executive_tier=payload.executive_tier,
        employment_type=payload.employment_type,
        department=payload.department,
        designation=payload.designation,
        joining_date=payload.joining_date,
        work_location=payload.work_location,
        reporting_manager_id=payload.reporting_manager_id,
        phone=payload.phone,
        gender=payload.gender,
        date_of_birth=payload.date_of_birth,
        address=payload.address,
        city=payload.city,
        state=payload.state,
        postal_code=payload.postal_code,
        emergency_contact=payload.emergency_contact,
        emergency_relationship=payload.emergency_relationship,
        profile_photo_url=payload.profile_photo_url,
        bio=payload.bio,
        linkedin_url=payload.linkedin_url,
        is_active=payload.is_active,
        earn_leave_balance=payload.earn_leave_balance,
        sick_leave_balance=payload.sick_leave_balance,
        casual_leave_balance=payload.casual_leave_balance,
        face_descriptor=payload.face_descriptor,
        face_embedding=payload.face_embedding or payload.face_descriptor,
        is_face_enrolled=bool(payload.face_descriptor)
    )
    db.add(new_emp)
    await db.commit()
    await db.refresh(new_emp)
    invalidate_employees_cache()
    return new_emp

@router.patch("/{employee_id}", response_model=EmployeeOut)
async def update_employee(
    employee_id: UUID,
    payload: EmployeeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.HR_ADMIN, UserRole.SUPER_ADMIN]))
):
    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    emp = result.scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail="Employee not found")

    update_data = payload.model_dump(exclude_unset=True)
    for field, val in update_data.items():
        setattr(emp, field, val)

    await db.commit()
    await db.refresh(emp)
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return emp

@router.post("/{employee_id}/enroll-face")
async def enroll_face(
    employee_id: str,
    payload: FaceEnrollRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
    if len(payload.face_descriptor) != 128:
        raise HTTPException(status_code=400, detail="Face descriptor must be exactly 128 float values")

    # Find employee by UUID, employee_code, or legacy_firebase_id (case-insensitive)
    clean_id = employee_id.strip()
    query = select(Employee)
    try:
        val_uuid = uuid.UUID(clean_id)
        query = query.where(or_(
            Employee.id == val_uuid,
            func.lower(Employee.employee_code) == clean_id.lower(),
            func.lower(Employee.legacy_firebase_id) == clean_id.lower()
        ))
    except ValueError:
        query = query.where(or_(
            func.lower(Employee.employee_code) == clean_id.lower(),
            func.lower(Employee.legacy_firebase_id) == clean_id.lower()
        ))

    result = await db.execute(query)
    emp = result.scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    # Authorization guard: if user is authenticated, ensure self or admin
    if current_user and current_user.id != emp.id and current_user.role not in [UserRole.HR_ADMIN, UserRole.SUPER_ADMIN]:
        raise HTTPException(status_code=403, detail="Not authorized to enroll biometric profile for another user")

    vector_str = "[" + ",".join(str(float(x)) for x in payload.face_descriptor) + "]"
    emp.face_descriptor = payload.face_descriptor
    await db.execute(
        text("UPDATE employees SET face_descriptor = :desc, face_embedding = CAST(:vec AS vector), is_face_enrolled = true WHERE id = :id"),
        {"desc": json.dumps(payload.face_descriptor), "vec": vector_str, "id": emp.id}
    )
    await db.commit()
    await db.refresh(emp)

    return {
        "message": "Biometric face profile enrolled successfully",
        "employee_id": str(emp.id),
        "employee_code": emp.employee_code,
        "full_name": emp.full_name
    }
