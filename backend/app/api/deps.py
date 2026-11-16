from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import time
from uuid import UUID
from typing import List, Optional, Dict, Tuple

from app.core.database import get_db
from app.core.security import decode_token
from app.models.employee import Employee
from app.models.enums import UserRole, ExecutiveTier

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login")
optional_oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/v1/auth/login", auto_error=False)

# In-memory high-speed auth cache with 60s TTL (avoids cross-continent round-trip per request)
_USER_CACHE: Dict[UUID, Tuple[float, Employee]] = {}
CACHE_TTL_SECONDS = 60.0

def invalidate_user_cache(employee_id: Optional[UUID] = None) -> None:
    if employee_id:
        _USER_CACHE.pop(employee_id, None)
    else:
        _USER_CACHE.clear()

async def get_optional_current_user(
    token: Optional[str] = Depends(optional_oauth2_scheme),
    db: AsyncSession = Depends(get_db)
) -> Optional[Employee]:
    if not token:
        return None
    try:
        payload = decode_token(token)
        employee_id_str: str = payload.get("sub")
        if employee_id_str is None:
            return None
        employee_id = UUID(employee_id_str)
        
        now = time.time()
        cached = _USER_CACHE.get(employee_id)
        if cached and cached[0] > now and cached[1].is_active:
            return cached[1]

        result = await db.execute(select(Employee).where(Employee.id == employee_id))
        emp = result.scalar_one_or_none()
        if emp and emp.is_active:
            _USER_CACHE[employee_id] = (now + CACHE_TTL_SECONDS, emp)
            return emp
        return None
    except Exception:
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
        payload = decode_token(token)
        employee_id_str: str = payload.get("sub")
        if employee_id_str is None:
            raise credentials_exception
        employee_id = UUID(employee_id_str)
    except Exception:
        raise credentials_exception

    now = time.time()
    cached = _USER_CACHE.get(employee_id)
    if cached and cached[0] > now:
        cached_emp = cached[1]
        if not cached_emp.is_active:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")
        return cached_emp

    result = await db.execute(select(Employee).where(Employee.id == employee_id))
    employee = result.scalar_one_or_none()
    if employee is None:
        raise credentials_exception
    if not employee.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive user account")
    
    _USER_CACHE[employee_id] = (now + CACHE_TTL_SECONDS, employee)
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
