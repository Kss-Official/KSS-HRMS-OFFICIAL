from pydantic import BaseModel, field_validator
from uuid import UUID
from datetime import date as date_type, datetime as datetime_type
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
    check_out_at: Optional[datetime_type] = None
    notes: Optional[str] = None

class BreakActionRequest(BaseModel):
    break_type: BreakType = BreakType.TEA_BREAK

    @field_validator("break_type", mode="before")
    @classmethod
    def normalize_break_type(cls, v):
        if isinstance(v, str):
            clean = v.strip().upper().replace(" ", "_")
            if clean in BreakType.__members__:
                return BreakType(clean)
            if "TEA" in clean:
                return BreakType.TEA_BREAK
            if "MEAL" in clean or "LUNCH" in clean:
                return BreakType.LUNCH_BREAK
            if "SNACK" in clean:
                return BreakType.SNACK_BREAK
            if "MEETING" in clean or "HUDDLE" in clean:
                return BreakType.TEAM_MEETING
            if "TRAINING" in clean:
                return BreakType.TRAINING
            return BreakType.OTHER
        return v

class AttendanceBreakOut(BaseModel):
    id: UUID
    type: BreakType
    start_time: datetime_type
    end_time: Optional[datetime_type] = None
    duration_minutes: int

    class Config:
        from_attributes = True

class AttendanceRecordOut(BaseModel):
    id: UUID
    employee_id: UUID
    employee_code: Optional[str] = None
    employee_name: Optional[str] = None
    department: Optional[str] = None
    date: date_type
    status: AttendanceStatus
    check_in_at: Optional[datetime_type] = None
    check_out_at: Optional[datetime_type] = None
    working_minutes: int
    is_wfh: bool
    location_verified: bool
    check_in_lat: Optional[float] = None
    check_in_lon: Optional[float] = None
    attendance_method: Optional[AttendanceMethod] = None
    notes: Optional[str] = None
    breaks: List[AttendanceBreakOut] = []
    created_at: datetime_type
    updated_at: datetime_type

    class Config:
        from_attributes = True

class BiometricMatchRequest(BaseModel):
    face_descriptor: List[float] # 128 float array
    threshold: float = 0.45 # Strict L2 Euclidean distance threshold for genuine biometric face match
    employee_id: Optional[UUID] = None
    employee_code: Optional[str] = None

class AttendanceCorrectionRequest(BaseModel):
    record_id: Optional[UUID] = None
    employee_id: Optional[UUID] = None
    employee_code: Optional[str] = None
    date: Optional[date_type] = None
    check_in_at: Optional[datetime_type] = None
    check_out_at: Optional[datetime_type] = None
    status: Optional[str] = None
    working_minutes: Optional[int] = None
    notes: Optional[str] = None
    clear_check_out: Optional[bool] = False

class BiometricMatchResponse(BaseModel):
    matched: bool
    employee_id: Optional[UUID] = None
    employee_code: Optional[str] = None
    full_name: Optional[str] = None
    distance: Optional[float] = None
    confidence: Optional[float] = None
    message: Optional[str] = None
