from pydantic import BaseModel
from uuid import UUID
from datetime import date, datetime
from typing import Optional, List
from app.models.enums import AttendanceStatus, AttendanceMethod, BreakType

class CheckInRequest(BaseModel):
    employee_code: Optional[str] = None # can be provided or derived from current user
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    is_wfh: bool = False
    face_descriptor: Optional[List[float]] = None

class CheckOutRequest(BaseModel):
    employee_code: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    check_out_at: Optional[datetime] = None
    notes: Optional[str] = None

class BreakActionRequest(BaseModel):
    break_type: BreakType = BreakType.TEA_BREAK

class AttendanceBreakOut(BaseModel):
    id: UUID
    type: BreakType
    start_time: datetime
    end_time: Optional[datetime] = None
    duration_minutes: int

    class Config:
        from_attributes = True

class AttendanceRecordOut(BaseModel):
    id: UUID
    employee_id: UUID
    employee_code: Optional[str] = None
    employee_name: Optional[str] = None
    department: Optional[str] = None
    date: date
    status: AttendanceStatus
    check_in_at: Optional[datetime] = None
    check_out_at: Optional[datetime] = None
    working_minutes: int
    is_wfh: bool
    location_verified: bool
    check_in_lat: Optional[float] = None
    check_in_lon: Optional[float] = None
    attendance_method: Optional[AttendanceMethod] = None
    notes: Optional[str] = None
    breaks: List[AttendanceBreakOut] = []
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True

class BiometricMatchRequest(BaseModel):
    face_descriptor: List[float] # 128 float array
    threshold: float = 0.45 # Strict L2 Euclidean distance threshold for genuine biometric face match
    employee_id: Optional[UUID] = None
    employee_code: Optional[str] = None

class BiometricMatchResponse(BaseModel):
    matched: bool
    employee_id: Optional[UUID] = None
    employee_code: Optional[str] = None
    full_name: Optional[str] = None
    distance: Optional[float] = None
    confidence: Optional[float] = None
    message: Optional[str] = None
