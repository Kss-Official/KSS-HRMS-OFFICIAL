"""Server-side audit trail helper. Sensitive operations write their own entries so the
trail cannot be omitted or forged by a client (POST /audit/ is a convenience for UI events only)."""
import uuid
from typing import Optional

from fastapi import Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit import AuditLog


def add_audit(
    db: AsyncSession,
    actor_id: Optional[uuid.UUID],
    action: str,
    target: Optional[str] = None,
    details: Optional[str] = None,
    entity_type: Optional[str] = None,
    entity_id: Optional[str] = None,
    request: Optional[Request] = None,
) -> None:
    """Adds (does not commit) an audit row; it commits atomically with the caller's transaction."""
    ip = request.client.host if (request is not None and request.client) else None
    db.add(AuditLog(
        id=uuid.uuid4(),
        actor_id=actor_id,
        action=action[:100],
        entity_type=entity_type,
        entity_id=entity_id,
        target=(target or "")[:255] or None,
        details=(details or "")[:2000] or None,
        ip_address=ip,
    ))
