import time
from collections import defaultdict, deque
from typing import Deque, Dict

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import BaseModel
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.audit_util import add_audit
from app.api.deps import get_current_user
from app.core.database import get_db
from app.core.security import (
    burn_password_hash_time,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_password_hash,
    is_hashed,
    validate_new_password,
    verify_legacy_plaintext,
    verify_password,
)
from app.models.employee import Employee
from app.schemas.auth import LoginRequest, PasswordChangeRequest, Token
from app.schemas.employee import EmployeeOut

router = APIRouter()

# --- Brute-force throttle (per process; put a shared store such as Redis in front for multi-worker deploys) ---
MAX_FAILED_ATTEMPTS = 8
LOCKOUT_WINDOW_SECONDS = 15 * 60
_failed_attempts: Dict[str, Deque[float]] = defaultdict(deque)


def _throttle_keys(identifier: str, request: Request) -> list[str]:
    ip = request.client.host if request.client else "unknown"
    return [f"id:{identifier.lower()}", f"ip:{ip}"]


def _prune(q: Deque[float], now: float) -> None:
    while q and now - q[0] > LOCKOUT_WINDOW_SECONDS:
        q.popleft()


def _is_locked(keys: list[str]) -> bool:
    now = time.time()
    for k in keys:
        q = _failed_attempts[k]
        _prune(q, now)
        # IP bucket is more generous (shared office NAT); identifier bucket is strict.
        limit = MAX_FAILED_ATTEMPTS * (4 if k.startswith("ip:") else 1)
        if len(q) >= limit:
            return True
    return False


def _record_failure(keys: list[str]) -> None:
    now = time.time()
    for k in keys:
        _failed_attempts[k].append(now)


def _clear_failures(keys: list[str]) -> None:
    for k in keys:
        if k.startswith("id:"):
            _failed_attempts.pop(k, None)


def _invalid() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid email or password",
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post("/login", response_model=Token)
async def login(credentials: LoginRequest, request: Request, db: AsyncSession = Depends(get_db)):
    identifier = (credentials.email or "").strip()
    if not identifier or not credentials.password or len(identifier) > 254 or len(credentials.password) > 1024:
        raise _invalid()

    keys = _throttle_keys(identifier, request)
    if _is_locked(keys):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many failed login attempts. Please try again in a few minutes.",
            headers={"Retry-After": str(LOCKOUT_WINDOW_SECONDS)},
        )

    # Exact, case-insensitive match (NOT ilike: '%' / '_' in user input acted as wildcards).
    ident_l = identifier.lower()
    stmt = (
        select(Employee)
        .where(or_(func.lower(Employee.email) == ident_l, func.lower(Employee.employee_code) == ident_l))
        .limit(2)
    )
    rows = (await db.execute(stmt)).scalars().all()
    # Ambiguous (e.g. one person's email equals another's code) => treat as invalid rather than guess.
    employee = rows[0] if len(rows) == 1 else None

    if employee is None:
        burn_password_hash_time(credentials.password)
        _record_failure(keys)
        raise _invalid()

    stored = employee.password_hash
    is_valid = False
    needs_upgrade = False
    if is_hashed(stored):
        is_valid = verify_password(credentials.password, stored)
    else:
        # Legacy rows migrated with a plaintext password: constant-time compare, then upgrade.
        is_valid = verify_legacy_plaintext(credentials.password, stored)
        needs_upgrade = is_valid
        if not stored:
            burn_password_hash_time(credentials.password)

    if not is_valid:
        _record_failure(keys)
        raise _invalid()

    if not employee.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive account")

    if needs_upgrade:
        employee.password_hash = get_password_hash(credentials.password)
        await db.commit()

    _clear_failures(keys)

    return {
        "access_token": create_access_token(subject=str(employee.id)),
        "refresh_token": create_refresh_token(subject=str(employee.id)),
        "token_type": "bearer",
        "employee_id": employee.id,
        "employee_code": employee.employee_code,
        "email": employee.email,
        "full_name": employee.full_name,
        "role": employee.role,
        "executive_tier": employee.executive_tier,
    }


class RefreshRequest(BaseModel):
    refresh_token: str


@router.post("/refresh")
async def refresh_access_token(payload: RefreshRequest, db: AsyncSession = Depends(get_db)):
    """Exchange a valid refresh token for a new access token."""
    bad = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid refresh token")
    try:
        claims = decode_token(payload.refresh_token)
    except Exception:
        raise bad
    if claims.get("type") != "refresh" or not claims.get("sub"):
        raise bad
    try:
        from uuid import UUID
        emp_id = UUID(claims["sub"])
    except Exception:
        raise bad
    emp = (await db.execute(select(Employee).where(Employee.id == emp_id))).scalar_one_or_none()
    if emp is None or not emp.is_active:
        raise bad
    return {"access_token": create_access_token(subject=str(emp.id)), "token_type": "bearer"}


@router.get("/me", response_model=EmployeeOut)
async def get_current_profile(current_user: Employee = Depends(get_current_user)):
    return current_user


@router.post("/change-password")
async def change_password(
    payload: PasswordChangeRequest,
    request: Request,
    current_user: Employee = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # `current_user` was loaded by get_current_user in THIS request's session (no detached cache),
    # so the mutation below is actually persisted by db.commit().
    stored = current_user.password_hash
    ok = verify_password(payload.old_password, stored) if is_hashed(stored) else verify_legacy_plaintext(payload.old_password, stored)
    if not ok:
        raise HTTPException(status_code=400, detail="Incorrect current password")

    err = validate_new_password(payload.new_password)
    if err:
        raise HTTPException(status_code=422, detail=err)
    if payload.new_password == payload.old_password:
        raise HTTPException(status_code=422, detail="New password must be different from the current password")

    current_user.password_hash = get_password_hash(payload.new_password)
    add_audit(db, current_user.id, "SECURITY_PASSWORD_CHANGED", target=current_user.employee_code,
              entity_type="employee", entity_id=str(current_user.id), request=request)
    await db.commit()
    return {"message": "Password updated successfully"}
