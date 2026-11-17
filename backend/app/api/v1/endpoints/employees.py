from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_, text, func
from uuid import UUID
from typing import List, Optional
import os
import base64
import uuid
import json
import math
import time
from typing import Dict, Tuple

from app.core.database import get_db
from app.core.security import get_password_hash
from app.core.cloudinary_service import (
    upload_employee_photo as cloudinary_upload_employee_photo,
    delete_cloudinary_image,
    cleanup_old_employee_photo
)
from app.models.employee import Employee
from app.models.enums import UserRole
from app.schemas.employee import EmployeeOut, EmployeeCreate, EmployeeUpdate, FaceEnrollRequest, PhotoUploadRequest
from app.api.deps import get_current_user, get_optional_current_user, require_roles, invalidate_user_cache

router = APIRouter()

def normalize_vector(vec: List[float]) -> List[float]:
    """Strict L2 unit normalization for illumination-invariant vector comparisons"""
    norm = math.sqrt(sum(float(x) ** 2 for x in vec))
    if norm > 0:
        return [float(x) / norm for x in vec]
    return [float(x) for x in vec]

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
    _EMPLOYEES_CACHE[cache_key] = (now_ts + 120.0, out)
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

    # Upload photo to Cloudinary if provided as base64 data URI
    photo_url = payload.profile_photo_url
    if photo_url and (photo_url.startswith("data:image/") or ";base64," in photo_url):
        upload_res = cloudinary_upload_employee_photo(photo_url, payload.employee_code)
        photo_url = upload_res.get("secure_url")

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
        profile_photo_url=photo_url,
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
    employee_id: str,
    payload: EmployeeUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
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

    is_self = current_user and current_user.id == emp.id
    is_admin_or_pm = current_user and current_user.role in [UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER]

    update_data = payload.model_dump(exclude_unset=True)

    # If the user is updating their own profile and is not an Admin/PM, protect administrative settings
    if is_self and not is_admin_or_pm:
        restricted_fields = {
            "role", "executive_tier", "earn_leave_balance", "sick_leave_balance",
            "casual_leave_balance", "is_active", "department", "designation",
            "joining_date", "work_location", "reporting_manager_id"
        }
        for field in restricted_fields:
            update_data.pop(field, None)
    elif current_user and not is_self and not is_admin_or_pm:
        raise HTTPException(status_code=403, detail="Not authorized to edit other employee profiles")

    # Cloudinary sync: if profile_photo_url is updated, upload to Cloudinary and delete the old asset
    if "profile_photo_url" in update_data:
        val = update_data["profile_photo_url"]
        old_photo = emp.profile_photo_url
        if val and (val.startswith("data:image/") or ";base64," in val):
            upload_res = cloudinary_upload_employee_photo(val, emp.employee_code)
            new_url = upload_res.get("secure_url")
            if old_photo and old_photo != new_url:
                cleanup_old_employee_photo(old_photo)
            update_data["profile_photo_url"] = new_url
        elif val and val != old_photo:
            if old_photo:
                cleanup_old_employee_photo(old_photo)

    for field, val in update_data.items():
        setattr(emp, field, val)

    await db.commit()
    await db.refresh(emp)
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return emp

@router.post("/{employee_id}/photo", response_model=EmployeeOut)
async def upload_employee_photo(
    employee_id: str,
    payload: PhotoUploadRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
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

    is_self = current_user and current_user.id == emp.id
    is_admin = current_user and current_user.role in [UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER]
    if current_user and not is_self and not is_admin:
        raise HTTPException(status_code=403, detail="Not authorized to update photo for another employee")

    photo_data = payload.photo_data.strip()
    old_photo_url = emp.profile_photo_url

    # Upload to Cloudinary with smart face-centered cropping
    upload_res = cloudinary_upload_employee_photo(photo_data, emp.employee_code)
    new_photo_url = upload_res.get("secure_url")

    # If the employee had a previous photo and it is different, delete the old asset from Cloudinary/disk
    if old_photo_url and old_photo_url != new_photo_url:
        cleanup_old_employee_photo(old_photo_url)

    emp.profile_photo_url = new_photo_url

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
    current_user: Employee = Depends(get_current_user)
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

    # Authorization guard: Only the employee themselves or HR / Super Admin can enroll biometrics
    if current_user.id != emp.id and current_user.role not in [UserRole.HR_ADMIN, UserRole.SUPER_ADMIN]:
        raise HTTPException(status_code=403, detail="Not authorized to enroll biometric profile for another user")

    norm_desc = normalize_vector(payload.face_descriptor)
    vector_str = "[" + ",".join(str(float(x)) for x in norm_desc) + "]"

    # Anti-Impersonation Check: Ensure this face is NOT already registered to another employee
    # Uses Euclidean distance (<->) with strict 0.48 threshold
    dup_query = text("""
        SELECT id, employee_code, full_name, (face_embedding <-> CAST(:vec AS vector)) as dist
        FROM employees
        WHERE is_face_enrolled = true 
          AND face_embedding IS NOT NULL 
          AND id != :id
        ORDER BY dist ASC
        LIMIT 1
    """)
    dup_res = await db.execute(dup_query, {"vec": vector_str, "id": emp.id})
    closest_match = dup_res.first()
    if closest_match and closest_match.dist is not None and float(closest_match.dist) <= 0.48:
        raise HTTPException(
            status_code=409,
            detail=f"Security Violation: This face is already enrolled under {closest_match.full_name} ({closest_match.employee_code}). One individual cannot register under multiple employee accounts."
        )

    emp.face_descriptor = norm_desc
    await db.execute(
        text("UPDATE employees SET face_descriptor = :desc, face_embedding = CAST(:vec AS vector), is_face_enrolled = true WHERE id = :id"),
        {"desc": json.dumps(norm_desc), "vec": vector_str, "id": emp.id}
    )
    await db.commit()
    await db.refresh(emp)
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)

    return {
        "message": "Biometric face profile enrolled successfully",
        "employee_id": str(emp.id),
        "employee_code": emp.employee_code,
        "full_name": emp.full_name,
        "is_face_enrolled": True
    }

@router.post("/reset-all-faces")
async def reset_all_faces(
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER]))
):
    await db.execute(text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false"))
    await db.commit()
    invalidate_employees_cache()
    invalidate_user_cache()
    return {"message": "All face biometric registrations have been reset successfully"}

@router.post("/{employee_id}/reset-face")
async def reset_employee_face(
    employee_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
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
    emp = (await db.execute(query)).scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    if current_user.id != emp.id and current_user.role not in [UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER]:
        raise HTTPException(status_code=403, detail="Not authorized to reset biometric profile for another user")
    
    await db.execute(
        text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false WHERE id = :id"),
        {"id": emp.id}
    )
    await db.commit()
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return {
        "message": f"Face biometric reset successfully for {emp.full_name}",
        "employee_code": emp.employee_code
    }

@router.delete("/{employee_id}")
async def delete_employee(
    employee_id: str,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
    if not current_user or current_user.role not in [UserRole.HR_ADMIN, UserRole.SUPER_ADMIN]:
        raise HTTPException(status_code=403, detail="Admin authorization required to delete employees")

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

    emp = (await db.execute(query)).scalar_one_or_none()
    if not emp:
        raise HTTPException(status_code=404, detail=f"Employee '{employee_id}' not found")

    # Clean up Cloudinary asset or local storage
    if emp.profile_photo_url:
        cleanup_old_employee_photo(emp.profile_photo_url)

    await db.delete(emp)
    await db.commit()
    invalidate_employees_cache()
    invalidate_user_cache(emp.id)
    return {"message": f"Employee {emp.employee_code} and associated photo deleted successfully"}
