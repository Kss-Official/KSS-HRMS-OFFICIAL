from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, or_
from app.core.database import get_db
from app.core.security import verify_password, get_password_hash, create_access_token, create_refresh_token
from app.models.employee import Employee
from app.schemas.auth import LoginRequest, Token, PasswordChangeRequest
from app.schemas.employee import EmployeeOut
from app.api.deps import get_current_user

router = APIRouter()

@router.post("/login", response_model=Token)
async def login(credentials: LoginRequest, db: AsyncSession = Depends(get_db)):
    # Support login with either email or employee_code
    stmt = select(Employee).where(
        or_(
            Employee.email.ilike(credentials.email.strip()),
            Employee.employee_code.ilike(credentials.email.strip())
        )
    )
    result = await db.execute(stmt)
    employee = result.scalar_one_or_none()

    if not employee:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    # Check password hash (bcrypt)
    is_valid = False
    if employee.password_hash:
        try:
            is_valid = verify_password(credentials.password, employee.password_hash)
        except Exception:
            # Fallback if plain or other hash format during migration
            is_valid = (credentials.password == employee.password_hash)

    if not is_valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )

    if not employee.is_active:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inactive account")

    access_token = create_access_token(subject=str(employee.id))
    refresh_token = create_refresh_token(subject=str(employee.id))

    return {
        "access_token": access_token,
        "refresh_token": refresh_token,
        "token_type": "bearer",
        "employee_id": employee.id,
        "employee_code": employee.employee_code,
        "email": employee.email,
        "full_name": employee.full_name,
        "role": employee.role,
        "executive_tier": employee.executive_tier
    }

@router.get("/me", response_model=EmployeeOut)
async def get_current_profile(current_user: Employee = Depends(get_current_user)):
    return current_user

@router.post("/change-password")
async def change_password(
    payload: PasswordChangeRequest,
    current_user: Employee = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    if not verify_password(payload.old_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Incorrect current password")

    current_user.password_hash = get_password_hash(payload.new_password)
    await db.commit()
    return {"message": "Password updated successfully"}
