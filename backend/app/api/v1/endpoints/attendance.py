from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, and_, or_, text, func
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import selectinload
from uuid import UUID
from datetime import date, datetime, timedelta, timezone, time as dt_time
from typing import List, Optional
import uuid
import math
import time
from typing import Dict, Tuple

from app.core.database import get_db
from app.core.config import settings
from app.models.employee import Employee
from app.models.attendance import AttendanceRecord, AttendanceBreak
from app.models.leave import LeaveRequest
from app.models.settings import CompanySettings
from app.models.enums import AttendanceStatus, AttendanceMethod, BreakType, UserRole, LeaveType, LeaveStatus, ExecutiveTier
from app.schemas.attendance import (
    CheckInRequest, CheckOutRequest, AttendanceRecordOut,
    BreakActionRequest, AttendanceBreakOut,
    BiometricMatchRequest, BiometricMatchResponse,
    AttendanceCorrectionRequest
)
from app.api.deps import get_current_user, get_optional_current_user

router = APIRouter()

# Records cache (per query, per process). Mutations clear it.
_RECORDS_CACHE: Dict[str, Tuple[float, List[AttendanceRecordOut]]] = {}
_RECORDS_CACHE_TTL = 30.0
_RECORDS_CACHE_MAX_KEYS = 128

FACE_MATCH_THRESHOLD = 0.55           # Biometric verification threshold (Euclidean L2 <= 0.55, cosine sim >= 0.849)
FACE_MAX_ACCEPTABLE_THRESHOLD = 0.58  # Maximum allowable threshold requested by clients
CHECKIN_OPEN_LOCAL = dt_time(10, 0)   # 10:00 AM check-in opening time
LATE_CUTOFF_LOCAL = dt_time(10, 15)   # 10:00 shift start + 15 min grace, in COMPANY time (marked Late after 10:15 AM)
GEOFENCE_TOLERANCE_FACTOR = 1.5       # GPS jitter allowance (radius * 1.5 + 50m)
GEOFENCE_TOLERANCE_EXTRA_M = 50.0
PRIVILEGED_ADMINS = (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN)
GEOFENCE_EXEMPT_ROLES = (UserRole.HR_ADMIN, UserRole.SUPER_ADMIN, UserRole.PROJECT_MANAGER)


def normalize_vector(vec: List[float]) -> List[float]:
    """Strict L2 unit normalization for illumination-invariant vector comparisons"""
    norm = math.sqrt(sum(float(x) ** 2 for x in vec))
    if norm > 0:
        return [float(x) / norm for x in vec]
    return [float(x) for x in vec]


def validate_descriptor(vec: Optional[List[float]]) -> List[float]:
    if not isinstance(vec, list) or len(vec) != 128:
        raise HTTPException(status_code=400, detail="Face descriptor must have exactly 128 dimensions")
    try:
        floats = [float(x) for x in vec]
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="Face descriptor must contain only numbers")
    if any(not math.isfinite(x) for x in floats) or math.sqrt(sum(x * x for x in floats)) < 1e-6:
        raise HTTPException(status_code=400, detail="Face descriptor contains invalid values")
    return floats


def invalidate_records_cache() -> None:
    _RECORDS_CACHE.clear()


def calculate_distance_meters(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    R = 6371000  # Earth radius in meters
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    delta_phi = math.radians(lat2 - lat1)
    delta_lambda = math.radians(lon2 - lon1)
    a = math.sin(delta_phi / 2.0) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(delta_lambda / 2.0) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return R * c


def _company_tz(tz_name: Optional[str] = None):
    """Company timezone (falls back to fixed IST if tzdata is unavailable)."""
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(tz_name or settings.COMPANY_TIMEZONE)
    except Exception:
        return timezone(timedelta(hours=5, minutes=30))


def company_now(tz_name: Optional[str] = None) -> datetime:
    return datetime.now(timezone.utc).astimezone(_company_tz(tz_name))


_COMPANY_SETTINGS_CACHE: Optional[Tuple[float, CompanySettings]] = None


def invalidate_company_settings_cache() -> None:
    global _COMPANY_SETTINGS_CACHE
    _COMPANY_SETTINGS_CACHE = None


async def _load_company_settings(db: AsyncSession) -> Optional[CompanySettings]:
    global _COMPANY_SETTINGS_CACHE
    now = time.time()
    if _COMPANY_SETTINGS_CACHE and _COMPANY_SETTINGS_CACHE[0] > now:
        return _COMPANY_SETTINGS_CACHE[1]
    res = (await db.execute(select(CompanySettings).limit(1))).scalar_one_or_none()
    if res:
        _COMPANY_SETTINGS_CACHE = (now + 60.0, res)
    return res


def _is_inside_geofence(lat: Optional[float], lon: Optional[float], cfg: Optional[CompanySettings]) -> Tuple[bool, Optional[float], float]:
    """(inside, distance_m, allowed_m). DB settings take precedence over env defaults."""
    g_lat = cfg.geofence_lat if cfg and cfg.geofence_lat is not None else settings.GEOFENCE_LAT
    g_lon = cfg.geofence_lon if cfg and cfg.geofence_lon is not None else settings.GEOFENCE_LON
    radius = cfg.geofence_radius_meters if cfg and cfg.geofence_radius_meters else settings.GEOFENCE_RADIUS_METERS
    allowed = radius * GEOFENCE_TOLERANCE_FACTOR + GEOFENCE_TOLERANCE_EXTRA_M
    if lat is None or lon is None or not (-90 <= lat <= 90) or not (-180 <= lon <= 180):
        return False, None, allowed
    dist = calculate_distance_meters(lat, lon, g_lat, g_lon)
    return dist <= radius, dist, allowed


async def _has_approved_wfh(db: AsyncSession, emp: Employee, day: date, cfg: Optional[CompanySettings]) -> bool:
    """WFH is only valid with an APPROVED WFH request covering `day`, or if the employee's role
    is in the company's allowed_wfh_roles. The client-supplied `is_wfh` flag is never trusted alone."""
    allowed_roles = (cfg.allowed_wfh_roles if cfg and cfg.allowed_wfh_roles else []) or []
    if isinstance(allowed_roles, list) and emp.role.value in [str(r) for r in allowed_roles]:
        return True
    res = await db.execute(
        select(LeaveRequest.id).where(
            LeaveRequest.employee_id == emp.id,
            LeaveRequest.type == LeaveType.WFH,  # DB leave_type_enum has no WORK_FROM_HOME label; submit_leave normalises to WFH
            LeaveRequest.status == LeaveStatus.APPROVED,
            LeaveRequest.start_date <= day,
            LeaveRequest.end_date >= day,
        ).limit(1)
    )
    return res.first() is not None


@router.post("/verify-face", response_model=BiometricMatchResponse)
async def verify_biometric_face(
    payload: BiometricMatchRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Optional[Employee] = Depends(get_optional_current_user),
):
    """1:1 face verification (pgvector L2). Supports both authenticated session tokens and 
    diagnostic face verification via employee_code / employee_id."""
    norm_vec = normalize_vector(validate_descriptor(payload.face_descriptor))
    vector_str = "[" + ",".join(str(float(x)) for x in norm_vec) + "]"
    # Clients may only be STRICTER than the server limit; a looser/NaN/negative value is clamped.
    try:
        req_thr = float(payload.threshold)
    except (TypeError, ValueError):
        req_thr = FACE_MATCH_THRESHOLD
    effective_threshold = req_thr if (math.isfinite(req_thr) and 0 < req_thr <= FACE_MAX_ACCEPTABLE_THRESHOLD) else FACE_MATCH_THRESHOLD

    is_admin = bool(current_user and current_user.role in PRIVILEGED_ADMINS)
    wants_other = bool(payload.employee_id or payload.employee_code)

    if wants_other or not is_admin:
        emp_uuid = None
        emp_code = ""
        if wants_other:
            if payload.employee_id:
                try:
                    emp_uuid = uuid.UUID(str(payload.employee_id))
                except Exception:
                    pass
            emp_code = str(payload.employee_code or payload.employee_id or "")
        elif current_user:
            emp_uuid = current_user.id  # non-admin without a target => verify self
        else:
            return {"matched": False, "message": "Employee identifier required for face verification"}

        clean_code = emp_code.replace("emp-", "").replace("EMP-", "").strip()

        lookup_res = await db.execute(text("""
            SELECT id, employee_code, full_name, (face_embedding IS NOT NULL) as has_embedding
            FROM employees
            WHERE is_active = true AND (
                id = :emp_uuid 
                OR LOWER(employee_code) = LOWER(:emp_code) 
                OR LOWER(employee_code) = LOWER(:clean_code)
                OR LOWER(legacy_firebase_id) = LOWER(:emp_code)
                OR LOWER(legacy_firebase_id) = LOWER(:clean_code)
            )
            LIMIT 1;
        """), {"emp_uuid": emp_uuid, "emp_code": emp_code, "clean_code": clean_code})
        target_emp = lookup_res.fetchone()

        if not target_emp:
            return {"matched": False, "message": "Employee not found in active directory"}

        emp_id, target_code, full_name, has_embedding = target_emp[0], target_emp[1], target_emp[2], bool(target_emp[3])

        if current_user and emp_id != current_user.id and not is_admin:
            raise HTTPException(status_code=403, detail="You can only verify your own face")

        if not has_embedding:
            return {
                "matched": False, "employee_id": emp_id, "employee_code": target_code, "full_name": full_name,
                "distance": 1.0, "confidence": 0.0,
                "message": "No biometric face template registered for this employee. Please register your face first."
            }

        dist_val = (await db.execute(text("""
            SELECT (face_embedding <-> CAST(:vec AS vector)) AS distance FROM employees WHERE id = :emp_id LIMIT 1;
        """), {"vec": vector_str, "emp_id": emp_id})).scalar()
        dist = float(dist_val) if dist_val is not None else 1.0
        matched = dist <= effective_threshold
        # Exact cosine similarity on unit vectors: 1.0 - (dist^2) / 2.0
        cos_sim = 1.0 - (dist * dist) / 2.0
        confidence = max(0.0, min(1.0, cos_sim)) if matched else max(0.0, round(1.0 - min(dist, 1.0), 4))

        if not matched:
            other = (await db.execute(text("""
                SELECT (face_embedding <-> CAST(:vec AS vector)) AS distance
                FROM employees
                WHERE is_active = true AND face_embedding IS NOT NULL AND id != :emp_id
                ORDER BY face_embedding <-> CAST(:vec AS vector) LIMIT 1;
            """), {"vec": vector_str, "emp_id": emp_id})).fetchone()
            if other and float(other[0]) <= effective_threshold:
                # Never disclose WHOSE face it was.
                return {
                    "matched": False, "impersonation_detected": True,
                    "employee_id": emp_id, "employee_code": target_code, "full_name": full_name,
                    "distance": round(dist, 4), "confidence": 0.0,
                    "message": "SECURITY REJECTION: Biometric identity mismatch. The scanned face belongs to a different employee. Cross-employee check-in is forbidden."
                }

        return {
            "matched": matched, "employee_id": emp_id, "employee_code": target_code, "full_name": full_name,
            "distance": round(dist, 4), "confidence": round(confidence, 4),
            "message": "Biometric match verified" if matched else f"Biometric mismatch (L2 distance: {round(dist, 3)} > {effective_threshold}). Face does not match registered profile."
        }

    # Kiosk mode (HR/Super Admin only): 1:N nearest-neighbour search
    match = (await db.execute(text("""
        SELECT id, employee_code, full_name, (face_embedding <-> CAST(:vec AS vector)) AS distance
        FROM employees WHERE is_active = true AND face_embedding IS NOT NULL
        ORDER BY face_embedding <-> CAST(:vec AS vector) LIMIT 1;
    """), {"vec": vector_str})).fetchone()
    if not match:
        return {"matched": False, "message": "No registered face profiles found in vector database"}

    emp_id, emp_code, full_name, dist = match[0], match[1], match[2], float(match[3])
    matched = dist <= effective_threshold
    cos_sim = 1.0 - (dist * dist) / 2.0
    confidence = max(0.0, min(1.0, cos_sim)) if matched else max(0.0, round(1.0 - min(dist, 1.0), 4))
    if not matched:  # don't reveal the nearest non-matching employee
        return {"matched": False, "distance": round(dist, 4), "confidence": confidence,
                "message": "No matching face found within biometric threshold"}
    return {
        "matched": True, "employee_id": emp_id, "employee_code": emp_code, "full_name": full_name,
        "distance": round(dist, 4), "confidence": round(confidence, 4), "message": "Biometric match verified"
    }


@router.post("/check-in", response_model=AttendanceRecordOut)
async def check_in(
    payload: CheckInRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    cfg = await _load_company_settings(db)
    tz_name = (cfg.timezone if cfg and cfg.timezone else None)
    local_now = company_now(tz_name)
    today = local_now.date()
    now = datetime.now(timezone.utc)

    # Target employee with strict authorization enforcement
    target_emp = current_user
    if payload.employee_code:
        code_clean = payload.employee_code.strip().lower()
        curr_codes = {
            current_user.employee_code.strip().lower() if current_user.employee_code else "",
            str(current_user.id).lower(),
            current_user.legacy_firebase_id.strip().lower() if current_user.legacy_firebase_id else ""
        }
        if code_clean not in curr_codes:
            if current_user.role not in PRIVILEGED_ADMINS:
                raise HTTPException(
                    status_code=403,
                    detail="Security Violation: Regular employees cannot check in on behalf of another employee."
                )
            res = await db.execute(select(Employee).where(
                or_(
                    func.lower(Employee.employee_code) == code_clean,
                    func.lower(Employee.legacy_firebase_id) == code_clean
                )
            ))
            target = res.scalar_one_or_none()
            if not target:
                raise HTTPException(status_code=404, detail=f"Employee with code '{payload.employee_code}' not found")
            if not target.is_active:
                raise HTTPException(status_code=400, detail="Cannot check in an inactive employee")
            target_emp = target
    is_proxy = target_emp.id != current_user.id

    res = await db.execute(
        select(AttendanceRecord).where(
            and_(AttendanceRecord.employee_id == target_emp.id, AttendanceRecord.date == today)
        )
    )
    existing = res.scalar_one_or_none()
    if existing and existing.check_in_at:
        raise HTTPException(status_code=400, detail="Employee has already checked in today")

    # Check-in time window: only permitted after 10:00 AM
    if local_now.time() < CHECKIN_OPEN_LOCAL:
        raise HTTPException(
            status_code=400,
            detail="Check-in is only permitted after 10:00 AM. Please wait until 10:00 AM to check in."
        )

    # WFH must be backed by an approved request (or an allowed role): the client flag alone is not trusted.
    is_wfh = False
    if payload.is_wfh:
        if not await _has_approved_wfh(db, target_emp, today, cfg):
            raise HTTPException(status_code=403, detail="Work-from-home check-in requires an approved WFH request for today")
        is_wfh = True

    # Geofence (company settings first, env as fallback). Enforced for on-site, non-WFH check-ins.
    inside, dist_m, allowed_m = _is_inside_geofence(payload.latitude, payload.longitude, cfg)
    enforce = settings.SERVER_GEOFENCE_ENFORCEMENT and (cfg.geofence_enforced if cfg is not None and cfg.geofence_enforced is not None else True)
    if enforce and not is_wfh and target_emp.role not in GEOFENCE_EXEMPT_ROLES:
        if dist_m is None:
            raise HTTPException(status_code=400, detail="Location is required to check in at the office")
        if dist_m > allowed_m:
            raise HTTPException(status_code=403, detail=f"You are {int(dist_m)}m from the office. Check-in is only allowed on-site within permitted location radius (or with an approved WFH).")
    location_ok = inside

    # Status: On-time up to 10:15 AM; anyone after 10:15 AM is automatically marked Late.
    status = AttendanceStatus.PRESENT
    if is_wfh:
        status = AttendanceStatus.WORK_FROM_HOME
    elif local_now.time() > LATE_CUTOFF_LOCAL:
        status = AttendanceStatus.LATE

    # Location-based check-in method (face biometric check-in removed for all employees)
    method = AttendanceMethod.GEO_ATTENDANCE if location_ok else AttendanceMethod.PORTAL_1CLICK

    if existing:
        existing.status = status
        existing.check_in_at = now
        existing.check_in_lat = payload.latitude
        existing.check_in_lon = payload.longitude
        existing.location_verified = location_ok
        existing.is_wfh = is_wfh
        existing.attendance_method = method
        record = existing
    else:
        record = AttendanceRecord(
            id=uuid.uuid4(), employee_id=target_emp.id, date=today, status=status, check_in_at=now,
            working_minutes=0, is_wfh=is_wfh, location_verified=location_ok,
            check_in_lat=payload.latitude, check_in_lon=payload.longitude, attendance_method=method
        )
        db.add(record)

    try:
        await db.commit()
    except IntegrityError:  # concurrent double check-in hit uq_attendance_emp_date
        await db.rollback()
        raise HTTPException(status_code=400, detail="Employee has already checked in today")
    await db.refresh(record)
    invalidate_records_cache()
    return record


async def _today_record(db: AsyncSession, emp: Employee) -> Optional[AttendanceRecord]:
    cfg = await _load_company_settings(db)
    today = company_now(cfg.timezone if cfg and cfg.timezone else None).date()
    res = await db.execute(select(AttendanceRecord).where(
        and_(AttendanceRecord.employee_id == emp.id, AttendanceRecord.date == today)))
    return res.scalar_one_or_none()


@router.post("/check-out", response_model=AttendanceRecordOut)
async def check_out(
    payload: CheckOutRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    target_emp = current_user
    if payload.employee_code and current_user.role in [UserRole.SUPER_ADMIN, UserRole.HR_ADMIN, UserRole.PROJECT_MANAGER]:
        stmt = select(Employee).where(func.lower(Employee.employee_code) == payload.employee_code.strip().lower())
        found = (await db.execute(stmt)).scalar_one_or_none()
        if found:
            target_emp = found

    now = payload.check_out_at or datetime.now(timezone.utc)
    record = await _today_record(db, target_emp)
    if not record or not record.check_in_at:
        if payload.notes and "Auto-checked out" in payload.notes and record:
            return record
        # Graceful auto-heal: If shift was started via Firebase or Neon record is missing,
        # provision today's record and complete checkout seamlessly instead of hard blocking.
        if not record:
            cfg = await _load_company_settings(db)
            today = company_now(cfg.timezone if cfg and cfg.timezone else None).date()
            record = AttendanceRecord(
                id=uuid.uuid4(),
                employee_id=target_emp.id,
                date=today,
                check_in_at=now,
                check_out_at=now,
                working_minutes=0,
                status=AttendanceStatus.PRESENT,
                location_verified=True,
                attendance_method=AttendanceMethod.PORTAL_1CLICK
            )
            db.add(record)
            await db.commit()
            await db.refresh(record)
            invalidate_records_cache()
            return record
        elif not record.check_in_at:
            record.check_in_at = now

    if record.check_out_at:
        # Idempotent: a retry/double-tap must not overwrite the real checkout time or inflate hours.
        return record

    record.check_out_at = now
    breaks = (await db.execute(select(AttendanceBreak).where(AttendanceBreak.attendance_id == record.id))).scalars().all()
    for b in breaks:  # auto-close any open break
        if b.end_time is None:
            b.end_time = now
            b.duration_minutes = max(1, int((now - b.start_time).total_seconds() / 60.0))
            db.add(b)

    total_break_mins = sum(b.duration_minutes or 0 for b in breaks)
    total_shift_mins = max(0, int((now - record.check_in_at).total_seconds() / 60.0))
    record.working_minutes = max(0, total_shift_mins - total_break_mins)
    if payload.notes:
        record.notes = payload.notes[:1000]

    await db.commit()
    await db.refresh(record)
    invalidate_records_cache()
    return record


@router.post("/breaks/start", response_model=AttendanceBreakOut)
async def start_break(
    payload: BreakActionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    now = datetime.now(timezone.utc)
    att = await _today_record(db, current_user)
    if not att or not att.check_in_at or att.check_out_at:
        if att and att.check_out_at:
            raise HTTPException(status_code=400, detail="Cannot take a break after checking out")
        # Auto-provision/heal today attendance record if shift was started via Firebase
        if not att:
            cfg = await _load_company_settings(db)
            today = company_now(cfg.timezone if cfg and cfg.timezone else None).date()
            att = AttendanceRecord(
                id=uuid.uuid4(),
                employee_id=current_user.id,
                date=today,
                check_in_at=now,
                status=AttendanceStatus.PRESENT,
                location_verified=True,
                attendance_method=AttendanceMethod.PORTAL_1CLICK
            )
            db.add(att)
            await db.commit()
            await db.refresh(att)
        elif not att.check_in_at:
            att.check_in_at = now
            await db.commit()
            await db.refresh(att)

    active_rows = (await db.execute(select(AttendanceBreak).where(
        and_(AttendanceBreak.attendance_id == att.id, AttendanceBreak.end_time.is_(None))))).scalars().all()
    if active_rows:
        active_b = active_rows[0]
        if active_b.type == payload.break_type:
            return active_b
        # Auto-close prior open break so the employee isn't blocked by an orphaned break
        for b in active_rows:
            b.end_time = now
            b.duration_minutes = max(1, int((now - b.start_time).total_seconds() / 60.0))

    new_break = AttendanceBreak(id=uuid.uuid4(), attendance_id=att.id, type=payload.break_type, start_time=now, duration_minutes=0)
    db.add(new_break)
    await db.commit()
    await db.refresh(new_break)
    invalidate_records_cache()
    return new_break


@router.post("/breaks/end", response_model=AttendanceBreakOut)
async def end_break(
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    now = datetime.now(timezone.utc)
    att = await _today_record(db, current_user)
    if not att:
        raise HTTPException(status_code=400, detail="No attendance record for today")

    open_breaks = (await db.execute(select(AttendanceBreak).where(
        and_(AttendanceBreak.attendance_id == att.id, AttendanceBreak.end_time.is_(None))
    ).order_by(AttendanceBreak.start_time.asc()))).scalars().all()
    if not open_breaks:
        last_break = (await db.execute(select(AttendanceBreak).where(AttendanceBreak.attendance_id == att.id)
                                       .order_by(AttendanceBreak.start_time.desc()))).scalars().first()
        if last_break:
            return last_break  # idempotent retry
        raise HTTPException(status_code=400, detail="No active break to end")

    for b in open_breaks:  # tolerate (and heal) rows where >1 break was left open
        b.end_time = now
        b.duration_minutes = max(1, int((now - b.start_time).total_seconds() / 60.0))
    await db.commit()
    await db.refresh(open_breaks[0])
    invalidate_records_cache()
    return open_breaks[0]


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
    limit: int = Query(500, ge=1, le=5000),
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    # Privileged roles (SUPER_ADMIN, HR_ADMIN, PROJECT_MANAGER) can view all or filter by employee_id.
    # Regular employees and Tech Leads are scoped strictly to their own records.
    PRIVILEGED_ROLES = (UserRole.SUPER_ADMIN, UserRole.HR_ADMIN, UserRole.PROJECT_MANAGER)
    is_privileged = bool(current_user and current_user.role in PRIVILEGED_ROLES)
    target_emp_id = employee_id if is_privileged else current_user.id
    cache_key = f"{target_emp_id}:{start_date}:{end_date}:{limit}"
    now_ts = time.time()
    cached = _RECORDS_CACHE.get(cache_key)
    if cached and cached[0] > now_ts:
        return cached[1]

    stmt = (
        select(AttendanceRecord, Employee.employee_code, Employee.full_name, Employee.department)
        .join(Employee, AttendanceRecord.employee_id == Employee.id, isouter=True)
        .options(selectinload(AttendanceRecord.breaks))
    )
    if target_emp_id:
        stmt = stmt.where(AttendanceRecord.employee_id == target_emp_id)
    if start_date:
        stmt = stmt.where(AttendanceRecord.date >= start_date)
    if end_date:
        stmt = stmt.where(AttendanceRecord.date <= end_date)
    stmt = stmt.order_by(AttendanceRecord.date.desc()).limit(limit)
    rows = (await db.execute(stmt)).all()

    out_records: List[AttendanceRecordOut] = []
    for att, code, name, dept in rows:
        rec = AttendanceRecordOut.model_validate(att)
        rec.employee_code = code
        rec.employee_name = name
        rec.department = dept
        out_records.append(rec)

    if len(_RECORDS_CACHE) >= _RECORDS_CACHE_MAX_KEYS:
        _RECORDS_CACHE.clear()
    _RECORDS_CACHE[cache_key] = (now_ts + _RECORDS_CACHE_TTL, out_records)
    return out_records


def map_attendance_status(val: Optional[str]) -> Optional[AttendanceStatus]:
    if not val:
        return None
    cleaned = val.strip().upper().replace(" ", "_").replace("-", "_")
    mapping = {
        "PRESENT": AttendanceStatus.PRESENT,
        "LATE": AttendanceStatus.LATE,
        "WORK_FROM_HOME": AttendanceStatus.WORK_FROM_HOME,
        "WFH": AttendanceStatus.WORK_FROM_HOME,
        "HALF_DAY": AttendanceStatus.HALF_DAY,
        "ON_LEAVE": AttendanceStatus.ON_LEAVE,
        "LEAVE": AttendanceStatus.ON_LEAVE,
        "ABSENT": AttendanceStatus.ABSENT,
        "HOLIDAY": AttendanceStatus.HOLIDAY,
    }
    return mapping.get(cleaned, AttendanceStatus.PRESENT)


async def _apply_attendance_correction(
    payload: AttendanceCorrectionRequest,
    record_id: Optional[UUID],
    db: AsyncSession,
    current_user: Employee
):
    is_authorized = (
        current_user.role in (UserRole.SUPER_ADMIN, UserRole.HR_ADMIN, UserRole.PROJECT_MANAGER, UserRole.TECH_LEAD)
        or (current_user.employee_code and current_user.employee_code.upper() in ("KSS2407013", "KSS2407003", "KSS2407012"))
        or (current_user.email and current_user.email.lower() in ("sb.akash@kalpanaaa.in", "founder@kalpanaaasoftwaresolutions.in", "d.koushik@kalpanaaasoftwaresolutions.in", "satya.ranjan.dash@kalpanaaa.in"))
    )
    if not is_authorized:
        raise HTTPException(
            status_code=403,
            detail="Access Denied: Only Project Managers, Tech Leads, HR Admins, and Super Admins can override attendance."
        )

    target_record_id = record_id or payload.record_id

    # 1. Resolve target employee
    target_emp: Optional[Employee] = None
    if payload.employee_id:
        target_emp = (await db.execute(select(Employee).where(Employee.id == payload.employee_id))).scalar_one_or_none()
    if not target_emp and payload.employee_code:
        code_clean = payload.employee_code.strip().lower()
        target_emp = (await db.execute(select(Employee).where(
            or_(
                func.lower(Employee.employee_code) == code_clean,
                func.lower(Employee.legacy_firebase_id) == code_clean
            )
        ))).scalar_one_or_none()

    # 2. Locate existing record
    rec: Optional[AttendanceRecord] = None
    if target_record_id:
        rec = (await db.execute(
            select(AttendanceRecord).where(AttendanceRecord.id == target_record_id).options(selectinload(AttendanceRecord.breaks))
        )).scalar_one_or_none()

    target_date = payload.date or (payload.check_in_at.date() if payload.check_in_at else None)
    if not rec and target_emp and target_date:
        rec = (await db.execute(
            select(AttendanceRecord).where(
                and_(AttendanceRecord.employee_id == target_emp.id, AttendanceRecord.date == target_date)
            ).options(selectinload(AttendanceRecord.breaks))
        )).scalar_one_or_none()

    # 3. If record doesn't exist yet, create it
    if not rec:
        if not target_emp:
            raise HTTPException(status_code=404, detail="Attendance record or target employee could not be resolved.")
        if not target_date:
            target_date = date.today()
        rec = AttendanceRecord(
            id=uuid.uuid4(),
            employee_id=target_emp.id,
            date=target_date,
            status=AttendanceStatus.PRESENT,
            attendance_method=AttendanceMethod.HR_CORRECTION,
            location_verified=True,
            is_wfh=False
        )
        db.add(rec)
    elif not target_emp:
        target_emp = (await db.execute(select(Employee).where(Employee.id == rec.employee_id))).scalar_one_or_none()

    # 4. Apply updates
    if payload.check_in_at is not None:
        rec.check_in_at = payload.check_in_at
    if payload.clear_check_out:
        rec.check_out_at = None
        rec.working_minutes = 0
        if not payload.status:
            rec.status = AttendanceStatus.PRESENT
    elif payload.check_out_at is not None:
        rec.check_out_at = payload.check_out_at
    if payload.status:
        st = map_attendance_status(payload.status)
        if st:
            rec.status = st
            if st == AttendanceStatus.WORK_FROM_HOME:
                rec.is_wfh = True
    if payload.clear_check_out:
        rec.working_minutes = 0
    elif payload.working_minutes is not None:
        rec.working_minutes = payload.working_minutes
    elif rec.check_in_at and rec.check_out_at:
        gross_secs = (rec.check_out_at - rec.check_in_at).total_seconds()
        rec.working_minutes = max(0, int(gross_secs / 60))
    if payload.notes:
        rec.notes = payload.notes if not rec.notes else f"{rec.notes} | {payload.notes}"

    rec.corrected_by_id = current_user.id
    rec.updated_at = datetime.now(timezone.utc)

    invalidate_records_cache()
    await db.commit()
    await db.refresh(rec)

    out = AttendanceRecordOut.model_validate(rec)
    if target_emp:
        out.employee_code = target_emp.employee_code
        out.employee_name = target_emp.full_name
        out.department = target_emp.department
    return out


@router.post("/correction", response_model=AttendanceRecordOut)
async def correct_attendance_post(
    payload: AttendanceCorrectionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    return await _apply_attendance_correction(payload, None, db, current_user)


@router.patch("/records/{record_id}", response_model=AttendanceRecordOut)
async def correct_attendance_patch(
    record_id: UUID,
    payload: AttendanceCorrectionRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    return await _apply_attendance_correction(payload, record_id, db, current_user)


@router.post("/records/{record_id}/undo-checkout", response_model=AttendanceRecordOut)
async def undo_checkout_post(
    record_id: UUID,
    payload: Optional[AttendanceCorrectionRequest] = None,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    req_payload = payload or AttendanceCorrectionRequest()
    req_payload.clear_check_out = True
    return await _apply_attendance_correction(req_payload, record_id, db, current_user)


@router.delete("/records/{record_id}")
async def delete_attendance_record(
    record_id: UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    rec = (await db.execute(
        select(AttendanceRecord).where(AttendanceRecord.id == record_id).options(selectinload(AttendanceRecord.breaks))
    )).scalar_one_or_none()
    if not rec:
        return {"success": True, "message": "Attendance record not found or already deleted."}

    await db.delete(rec)
    await db.commit()
    invalidate_records_cache()
    return {"success": True, "message": f"Attendance record {record_id} successfully deleted."}


@router.delete("/record")
async def delete_attendance_record_by_date(
    record_id: Optional[str] = None,
    employee_id: Optional[str] = None,
    employee_code: Optional[str] = None,
    date_str: Optional[str] = Query(None, alias="date"),
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    rec = None
    # 1. Try by record_id UUID
    if record_id:
        try:
            rid = uuid.UUID(record_id)
            rec = (await db.execute(
                select(AttendanceRecord).where(AttendanceRecord.id == rid).options(selectinload(AttendanceRecord.breaks))
            )).scalar_one_or_none()
        except ValueError:
            pass

    # 2. If not found by UUID, find by employee + date
    if not rec and date_str:
        try:
            target_date = datetime.strptime(date_str, "%Y-%m-%d").date()
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid date format. Expected YYYY-MM-DD.")

        target_emp = None
        if employee_code:
            code_val = employee_code.strip().lower()
            target_emp = (await db.execute(
                select(Employee).where(
                    or_(
                        func.lower(Employee.employee_code) == code_val,
                        func.lower(Employee.legacy_firebase_id) == code_val
                    )
                )
            )).scalar_one_or_none()
        if not target_emp and employee_id:
            try:
                emp_uuid = uuid.UUID(employee_id)
                target_emp = (await db.execute(select(Employee).where(Employee.id == emp_uuid))).scalar_one_or_none()
            except ValueError:
                code_val = employee_id.strip().lower()
                target_emp = (await db.execute(
                    select(Employee).where(
                        or_(
                            func.lower(Employee.employee_code) == code_val,
                            func.lower(Employee.legacy_firebase_id) == code_val
                        )
                    )
                )).scalar_one_or_none()

        if target_emp:
            rec = (await db.execute(
                select(AttendanceRecord).where(
                    and_(AttendanceRecord.employee_id == target_emp.id, AttendanceRecord.date == target_date)
                ).options(selectinload(AttendanceRecord.breaks))
            )).scalar_one_or_none()

    if not rec:
        return {"success": True, "message": "Attendance record not found or already deleted."}

    await db.delete(rec)
    await db.commit()
    invalidate_records_cache()
    return {"success": True, "message": "Attendance record successfully deleted."}
