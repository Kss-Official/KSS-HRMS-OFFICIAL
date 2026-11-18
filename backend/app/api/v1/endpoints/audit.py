from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from typing import List, Optional
import uuid

from app.core.database import get_db
from app.models.employee import Employee
from app.models.audit import AuditLog
from app.models.enums import UserRole
from app.schemas.audit import AuditLogOut, AuditLogCreate
from app.api.deps import get_current_user, require_roles

router = APIRouter()

# Written ONLY by the server; a client can never create these.
RESERVED_ACTION_PREFIXES = ("FACE_", "AUTH_", "LEAVE_APPROVED", "LEAVE_REJECTED", "LEAVE_SUBMITTED")
# The UI also reports these; accepted but clearly labelled so they cannot pass as authoritative server records.
CLIENT_REPORTED_PREFIXES = ("EMPLOYEE_", "LEAVE_CANCELLED", "SECURITY_")

@router.get("/", response_model=List[AuditLogOut])
async def list_audit_logs(
    limit: int = Query(100, ge=1, le=1000),
    action: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.SUPER_ADMIN, UserRole.HR_ADMIN]))
):
    stmt = (
        select(AuditLog, Employee.full_name)
        .join(Employee, AuditLog.actor_id == Employee.id, isouter=True)
    )
    if action:
        stmt = stmt.where(AuditLog.action == action)

    stmt = stmt.order_by(AuditLog.created_at.desc()).limit(limit)
    result = await db.execute(stmt)
    rows = result.all()

    out_logs: List[AuditLogOut] = []
    for log, actor_name in rows:
        item = AuditLogOut.model_validate(log)
        item.actor_name = actor_name or "System"
        out_logs.append(item)

    return out_logs

@router.post("/", response_model=AuditLogOut)
async def create_audit_log(
    payload: AuditLogCreate,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    # Client-originated UI events only. Security-relevant actions are written server-side by the
    # endpoints themselves, so a client may not forge those (or impersonate the system).
    if payload.action.upper().startswith(RESERVED_ACTION_PREFIXES):
        raise HTTPException(status_code=403, detail="This audit action is reserved for server-side use")
    new_log = AuditLog(
        id=uuid.uuid4(),
        actor_id=current_user.id,
        action=payload.action[:100],
        target=(payload.target or "")[:255] or None,
        details=(("[client-reported] " if payload.action.upper().startswith(CLIENT_REPORTED_PREFIXES) else "") + (payload.details or ""))[:2000] or None,
        entity_type=(payload.entity_type or "")[:50] or None,
        entity_id=(payload.entity_id or "")[:100] or None,
        ip_address=request.client.host if request.client else None
    )
    db.add(new_log)
    await db.commit()
    await db.refresh(new_log)

    item = AuditLogOut.model_validate(new_log)
    item.actor_name = current_user.full_name
    return item
