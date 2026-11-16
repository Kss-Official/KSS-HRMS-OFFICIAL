from pydantic import BaseModel
from uuid import UUID
from datetime import datetime
from typing import Optional

class AuditLogCreate(BaseModel):
    action: str
    target: Optional[str] = None
    details: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None

class AuditLogOut(BaseModel):
    id: UUID
    actor_id: Optional[UUID] = None
    actor_name: Optional[str] = None
    action: str
    target: Optional[str] = None
    details: Optional[str] = None
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    ip_address: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True
