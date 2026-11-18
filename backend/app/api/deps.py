from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from uuid import UUID
from typing import List, Optional

from app.core.database import get_db
from app.core.security import decode_token
from app.models.employee import Employee
from app.models.enums import UserRole, ExecutiveTier

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")
optional_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)


def invalidate_user_cache(employee_id: Optional[UUID] = None) -> None:
    """Kept for backwards compatibility with callers.

    The previous implementation cached *detached* ORM objects for 60s. That caused
    (a) mutations such as change-password to be applied to an object that no longer
    belonged to the request's session and silently never persisted, and (b) stale
    role / is_active data (a deactivated or demoted user kept access for up to 60s).
    The user row is now loaded in the request's own session every time, so there is
    nothing to invalidate.
    """
    return None


def _employee_id_from_access_token(token: str) -> UUID:
    """Decode a JWT and return the employee id. Raises ValueError if the token is not a
    valid *access* token (refresh tokens must never authenticate API calls)."""
    payload = decode_token(token)
    if payload.get("type") != "access":
        raise ValueError("not an access token")
    sub = payload.get("sub")
    if not sub:
        raise ValueError("missing subject")
    return UUID(sub)


async def get_optional_current_user(
    token: Optional[str] = Depends(optional_oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> Optional[Employee]:
    """Returns the user if a VALID access token is supplied, else None.

    NOTE: Do not use this on endpoints that return or mutate employee data. Anonymous
    access to those was a critical vulnerability; use `get_current_user` instead.
    """
    if not token:
        return None
    try:
        employee_id = _employee_id_from_access_token(token)
    except Exception:
        return None
    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    emp = result.scalar_one_or_none()
    if emp and emp.is_active:
        return emp
    return None


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> Employee:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        employee_id = _employee_id_from_access_token(token)
    except Exception:
        raise credentials_exception

    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    employee = result.scalar_one_or_none()
    if employee is None:
        raise credentials_exception
    if not employee.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")
    return employee


def require_roles(allowed_roles: List[UserRole]):
    def role_checker(current_user: Employee = Depends(get_current_user)) -> Employee:
        if current_user.role not in allowed_roles:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Operation not permitted. Required role: {[r.value for r in allowed_roles]}"
            )
        return current_user
    return role_checker


def require_executive():
    def exec_checker(current_user: Employee = Depends(get_current_user)) -> Employee:
        if current_user.executive_tier not in [ExecutiveTier.CEO, ExecutiveTier.CTO] and current_user.role != UserRole.SUPER_ADMIN:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Operation permitted only for CEO or CTO executives"
            )
        return current_user
    return exec_checker
