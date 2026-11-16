from fastapi import APIRouter, Depends, Query
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

@router.get("/", response_model=List[AuditLogOut])
async def list_audit_logs(
    limit: int = 100,
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
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    new_log = AuditLog(
        id=uuid.uuid4(),
        actor_id=current_user.id,
        action=payload.action,
        target=payload.target,
        details=payload.details,
        entity_type=payload.entity_type,
        entity_id=payload.entity_id
    )
    db.add(new_log)
    await db.commit()
    await db.refresh(new_log)

    item = AuditLogOut.model_validate(new_log)
    item.actor_name = current_user.full_name
    return item
