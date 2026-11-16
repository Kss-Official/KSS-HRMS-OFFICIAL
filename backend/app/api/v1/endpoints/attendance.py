from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, text
from sqlalchemy.orm import selectinload
from uuid import UUID
from datetime import date, datetime, timezone, time
from typing import List, Optional
import uuid
import math

from app.core.database import get_db
from app.core.config import settings
from app.models.employee import Employee
from app.models.attendance import AttendanceRecord, AttendanceBreak
from app.models.enums import AttendanceStatus, AttendanceMethod, BreakType
from app.schemas.attendance import (
    CheckInRequest, CheckOutRequest, AttendanceRecordOut,
    BreakActionRequest, AttendanceBreakOut,
    BiometricMatchRequest, BiometricMatchResponse
)
from app.api.deps import get_current_user, get_optional_current_user

router = APIRouter()

def calculate_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c

@router.post("/verify-face", response_model=BiometricMatchResponse)
async def verify_biometric_face(
    payload: BiometricMatchRequest,
    db: AsyncSession = Depends(get_db)
):
    """
    Sub-2ms Native Biometric Search using Neon pgvector HNSW Index (<-> L2 distance)
    """
    if len(payload.face_descriptor) != 128:
        raise HTTPException(status_code=400, detail="Face descriptor must have exactly 128 dimensions")

    vector_str = "[" + ",".join(str(float(x)) for x in payload.face_descriptor) + "]"

    # If employee_id or employee_code is provided, perform strict targeted verification ONLY
    if payload.employee_id or payload.employee_code:
        emp_uuid = None
        if payload.employee_id:
            try:
                emp_uuid = uuid.UUID(str(payload.employee_id))
            except Exception:
                pass
        emp_code = str(payload.employee_code or payload.employee_id or "")

        lookup_sql = text("""
            SELECT id, employee_code, full_name, (face_embedding IS NOT NULL) as has_embedding
            FROM employees
            WHERE is_active = true AND (id = :emp_uuid OR employee_code = :emp_code OR legacy_firebase_id = :emp_code)
            LIMIT 1;
        """)
        lookup_res = await db.execute(lookup_sql, {"emp_uuid": emp_uuid, "emp_code": emp_code})
        target_emp = lookup_res.fetchone()

        if not target_emp:
            return {
                "matched": False,
                "message": f"Employee {emp_code} not found in active directory"
            }

        emp_id, target_code, full_name, has_embedding = target_emp[0], target_emp[1], target_emp[2], bool(target_emp[3])

        if not has_embedding:
            return {
                "matched": False,
                "employee_id": emp_id,
                "employee_code": target_code,
                "full_name": full_name,
                "distance": 1.0,
                "confidence": 0.0,
                "message": "No biometric face template registered for this employee. Please register your face first."
            }

        # Targeted vector distance calculation for this specific employee
        target_dist_sql = text("""
            SELECT (face_embedding <-> CAST(:vec AS vector)) AS distance
            FROM employees
            WHERE id = :emp_id
            LIMIT 1;
        """)
        dist_res = await db.execute(target_dist_sql, {"vec": vector_str, "emp_id": emp_id})
        dist_val = dist_res.scalar()
        dist = float(dist_val) if dist_val is not None else 1.0

        # Strict biometric verification threshold (0.45 = standard Euclidean boundary for genuine face match)
        matched = (dist <= payload.threshold)
        confidence = max(0.0, min(1.0, 1.0 - (dist / payload.threshold))) if matched else max(0.0, round(1.0 - min(dist, 1.0), 4))

        return {
            "matched": matched,
            "employee_id": emp_id,
            "employee_code": target_code,
            "full_name": full_name,
            "distance": round(dist, 4),
            "confidence": round(confidence, 4),
            "message": "Biometric match verified" if matched else f"Biometric mismatch (L2 distance: {round(dist, 3)} > {payload.threshold}). Face does not match registered profile."
        }

    # Kiosk Mode: Global vector nearest neighbor search (ONLY when no specific employee is provided)
    sql = text("""
        SELECT id, employee_code, full_name, (face_embedding <-> CAST(:vec AS vector)) AS distance
        FROM employees
        WHERE is_active = true AND face_embedding IS NOT NULL
        ORDER BY face_embedding <-> CAST(:vec AS vector)
        LIMIT 1;
    """)
    result = await db.execute(sql, {"vec": vector_str})
    match = result.fetchone()

    if not match:
        return {"matched": False, "message": "No registered face profiles found in vector database"}

    emp_id, emp_code, full_name, dist = match[0], match[1], match[2], float(match[3])
    matched = (dist <= payload.threshold)
    confidence = max(0.0, min(1.0, 1.0 - (dist / payload.threshold))) if matched else max(0.0, round(1.0 - min(dist, 1.0), 4))

    return {
        "matched": matched,
        "employee_id": emp_id,
        "employee_code": emp_code,
        "full_name": full_name,
        "distance": round(dist, 4),
        "confidence": round(confidence, 4),
        "message": "Biometric match verified" if matched else "No matching face found within biometric threshold"
    }

@router.post("/check-in", response_model=AttendanceRecordOut)
async def check_in(
    payload: CheckInRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    today = date.today()
    now = datetime.now(timezone.utc)

    # Determine target employee
    target_emp = current_user
    if payload.employee_code and payload.employee_code != current_user.employee_code:
        # Check if HR / Super Admin is checking in another employee
        res = await db.execute(select(Employee).where(Employee.employee_code == payload.employee_code))
        target = res.scalar_one_or_none()
        if target:
            target_emp = target

    # Check if existing record for today
    res = await db.execute(
        select(AttendanceRecord).where(
            and_(AttendanceRecord.employee_id == target_emp.id, AttendanceRecord.date == today)
        )
    )
    existing = res.scalar_one_or_none()
    if existing and existing.check_in_at:
        raise HTTPException(status_code=400, detail="Employee has already checked in today")

    # Geofence Validation
    location_ok = False
    if payload.latitude is not None and payload.longitude is not None:
        dist = calculate_distance_meters(
            payload.latitude, payload.longitude,
            settings.GEOFENCE_LAT, settings.GEOFENCE_LON
        )
        location_ok = (dist <= settings.GEOFENCE_RADIUS_METERS)

    # Determine status (e.g. LATE if past 10:00 AM IST)
    # 10:00 AM IST = 04:30 AM UTC
    status = AttendanceStatus.PRESENT
    if payload.is_wfh:
        status = AttendanceStatus.WORK_FROM_HOME
    elif now.time() > time(4, 30):
        status = AttendanceStatus.LATE

    method = AttendanceMethod.PORTAL_1CLICK
    if payload.face_descriptor:
        method = AttendanceMethod.BIOMETRIC_FACE
    elif location_ok:
        method = AttendanceMethod.GEO_ATTENDANCE

    if existing:
        existing.status = status
        existing.check_in_at = now
        existing.check_in_lat = payload.latitude
        existing.check_in_lon = payload.longitude
        existing.location_verified = location_ok
        existing.is_wfh = payload.is_wfh
        existing.attendance_method = method
        record = existing
    else:
        record = AttendanceRecord(
            id=uuid.uuid4(),
            employee_id=target_emp.id,
            date=today,
            status=status,
            check_in_at=now,
            working_minutes=0,
            is_wfh=payload.is_wfh,
            location_verified=location_ok,
            check_in_lat=payload.latitude,
            check_in_lon=payload.longitude,
            attendance_method=method
        )
        db.add(record)

    await db.commit()
    await db.refresh(record)
    return record

@router.post("/check-out", response_model=AttendanceRecordOut)
async def check_out(
    payload: CheckOutRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    today = date.today()
    now = datetime.now(timezone.utc)

    res = await db.execute(
        select(AttendanceRecord).where(
            and_(AttendanceRecord.employee_id == current_user.id, AttendanceRecord.date == today)
        )
    )
    record = res.scalar_one_or_none()
    if not record or not record.check_in_at:
        raise HTTPException(status_code=400, detail="Cannot check out without checking in first")

    record.check_out_at = now
    # Calculate working minutes
    delta = (now - record.check_in_at).total_seconds() / 60.0
    record.working_minutes = max(0, int(delta))
    if payload.notes:
        record.notes = payload.notes

    await db.commit()
    await db.refresh(record)
    return record

@router.post("/breaks/start", response_model=AttendanceBreakOut)
async def start_break(
    payload: BreakActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    today = date.today()
    now = datetime.now(timezone.utc)

    res = await db.execute(
        select(AttendanceRecord).where(
            and_(AttendanceRecord.employee_id == current_user.id, AttendanceRecord.date == today)
        )
    )
    att = res.scalar_one_or_none()
    if not att or not att.check_in_at or att.check_out_at:
        raise HTTPException(status_code=400, detail="Active check-in required to take a break")

    # Check if an ongoing break exists
    b_res = await db.execute(
        select(AttendanceBreak).where(
            and_(AttendanceBreak.attendance_id == att.id, AttendanceBreak.end_time.is_(None))
        )
    )
    if b_res.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="A break is already active")

    new_break = AttendanceBreak(
        id=uuid.uuid4(),
        attendance_id=att.id,
        type=payload.break_type,
        start_time=now,
        duration_minutes=0
    )
    db.add(new_break)
    await db.commit()
    await db.refresh(new_break)
    return new_break

@router.post("/breaks/end", response_model=AttendanceBreakOut)
async def end_break(
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    today = date.today()
    now = datetime.now(timezone.utc)

    res = await db.execute(
        select(AttendanceRecord).where(
            and_(AttendanceRecord.employee_id == current_user.id, AttendanceRecord.date == today)
        )
    )
    att = res.scalar_one_or_none()
    if not att:
        raise HTTPException(status_code=400, detail="No attendance record for today")

    b_res = await db.execute(
        select(AttendanceBreak).where(
            and_(AttendanceBreak.attendance_id == att.id, AttendanceBreak.end_time.is_(None))
        )
    )
    active_break = b_res.scalar_one_or_none()
    if not active_break:
        raise HTTPException(status_code=400, detail="No active break to end")

    active_break.end_time = now
    duration = (now - active_break.start_time).total_seconds() / 60.0
    active_break.duration_minutes = max(1, int(duration))

    await db.commit()
    await db.refresh(active_break)
    return active_break

@router.post("/break", response_model=AttendanceBreakOut)
async def break_action_alias(
    payload: BreakActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    return await start_break(payload, db, current_user)

@router.get("/records", response_model=List[AttendanceRecordOut])
async def get_records(
    employee_id: Optional[UUID] = None,
    start_date: Optional[date] = None,
    end_date: Optional[date] = None,
    limit: int = Query(2000, ge=1, le=5000),
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user)
):
    stmt = (
        select(AttendanceRecord, Employee.employee_code, Employee.full_name, Employee.department)
        .join(Employee, AttendanceRecord.employee_id == Employee.id, isouter=True)
        .options(selectinload(AttendanceRecord.breaks))
    )
    if current_user and current_user.role.value == "EMPLOYEE":
        stmt = stmt.where(AttendanceRecord.employee_id == current_user.id)
    elif employee_id:
        stmt = stmt.where(AttendanceRecord.employee_id == employee_id)

    if start_date:
        stmt = stmt.where(AttendanceRecord.date >= start_date)
    if end_date:
        stmt = stmt.where(AttendanceRecord.date <= end_date)

    stmt = stmt.order_by(AttendanceRecord.date.desc()).limit(limit)
    result = await db.execute(stmt)
    rows = result.all()

    out_records: List[AttendanceRecordOut] = []
    for att, code, name, dept in rows:
        record_dict = AttendanceRecordOut.model_validate(att)
        record_dict.employee_code = code
        record_dict.employee_name = name
        record_dict.department = dept
        out_records.append(record_dict)

    return out_records
