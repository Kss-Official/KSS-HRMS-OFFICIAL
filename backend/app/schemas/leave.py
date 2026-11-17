from pydantic import BaseModel
from uuid import UUID
from datetime import date, datetime
from typing import Optional
from app.models.enums import LeaveType, LeaveStatus, ApprovalStatus

class LeaveRequestCreate(BaseModel):
    type: LeaveType
    start_date: date
    end_date: date
    reason: str
    request_code: Optional[str] = None

class ExecutiveLeaveReview(BaseModel):
    action: ApprovalStatus # APPROVED, REJECTED
    notes: Optional[str] = None

class LeaveReviewRequest(ExecutiveLeaveReview):
    pass

class LeaveRequestOut(BaseModel):
    id: UUID
    request_code: str
    employee_id: UUID
    employee_code: Optional[str] = None
    employee_name: Optional[str] = None
    department: Optional[str] = None
    type: LeaveType
    start_date: date
    end_date: date
    reason: str
    status: LeaveStatus
    ceo_status: ApprovalStatus
    ceo_reviewed_by: Optional[UUID] = None
    ceo_reviewed_at: Optional[datetime] = None
    ceo_notes: Optional[str] = None
    cto_status: ApprovalStatus
    cto_reviewed_by: Optional[UUID] = None
    cto_reviewed_at: Optional[datetime] = None
    cto_notes: Optional[str] = None
    rejection_reason: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
