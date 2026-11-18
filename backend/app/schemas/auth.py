from pydantic import BaseModel, EmailStr
from uuid import UUID
from typing import Optional
from app.models.enums import UserRole, ExecutiveTier

class Token(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    employee_id: UUID
    employee_code: str
    email: str
    full_name: str
    role: UserRole
    executive_tier: ExecutiveTier
    earn_leave_balance: Optional[float] = 0.0
    sick_leave_balance: Optional[float] = 0.0
    casual_leave_balance: Optional[float] = 0.0

class TokenPayload(BaseModel):
    sub: str | None = None
    type: str | None = None

class LoginRequest(BaseModel):
    email: str # Can be email or employee_code
    password: str

class PasswordChangeRequest(BaseModel):
    old_password: Optional[str] = None
    new_password: str
