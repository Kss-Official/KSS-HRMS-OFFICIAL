from pydantic import BaseModel, EmailStr
from uuid import UUID
from datetime import date, datetime
from typing import Optional, List, Any
from app.models.enums import UserRole, ExecutiveTier, EmploymentType

class EmployeeBase(BaseModel):
    employee_code: str
    email: str
    full_name: str
    role: UserRole = UserRole.EMPLOYEE
    executive_tier: ExecutiveTier = ExecutiveTier.NONE
    employment_type: EmploymentType = EmploymentType.FULL_TIME
    department: str
    designation: str
    joining_date: date
    work_location: Optional[str] = None
    reporting_manager_id: Optional[UUID] = None
    phone: Optional[str] = None
    gender: Optional[str] = None
    date_of_birth: Optional[date] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    emergency_contact: Optional[str] = None
    emergency_relationship: Optional[str] = None
    profile_photo_url: Optional[str] = None
    bio: Optional[str] = None
    linkedin_url: Optional[str] = None
    is_active: bool = True

class EmployeeCreate(EmployeeBase):
    password: str
    earn_leave_balance: float = 0.0
    sick_leave_balance: float = 0.0
    casual_leave_balance: float = 0.0
    face_descriptor: Optional[List[float]] = None
    face_embedding: Optional[List[float]] = None

class EmployeeUpdate(BaseModel):
    full_name: Optional[str] = None
    role: Optional[UserRole] = None
    executive_tier: Optional[ExecutiveTier] = None
    employment_type: Optional[EmploymentType] = None
    department: Optional[str] = None
    designation: Optional[str] = None
    work_location: Optional[str] = None
    reporting_manager_id: Optional[UUID] = None
    phone: Optional[str] = None
    gender: Optional[str] = None
    date_of_birth: Optional[date] = None
    address: Optional[str] = None
    city: Optional[str] = None
    state: Optional[str] = None
    postal_code: Optional[str] = None
    emergency_contact: Optional[str] = None
    emergency_relationship: Optional[str] = None
    profile_photo_url: Optional[str] = None
    bio: Optional[str] = None
    linkedin_url: Optional[str] = None
    is_active: Optional[bool] = None
    earn_leave_balance: Optional[float] = None
    sick_leave_balance: Optional[float] = None
    casual_leave_balance: Optional[float] = None

class EmployeeOut(EmployeeBase):
    id: UUID
    earn_leave_balance: float
    sick_leave_balance: float
    casual_leave_balance: float
    is_face_enrolled: bool
    face_descriptor: Optional[List[float]] = None
    created_at: datetime
    updated_at: datetime
    reporting_manager: Optional[str] = None
    specialization: Optional[str] = None

    class Config:
        from_attributes = True

class FaceEnrollRequest(BaseModel):
    face_descriptor: List[float] # 128 float array
