from fastapi import APIRouter, Depends, Request
from app.api.deps import require_roles
from app.models.enums import UserRole
from fastapi.responses import StreamingResponse
import asyncio
import json
from datetime import datetime, timezone

router = APIRouter()

# NOTE: nothing publishes to this queue yet and a single shared queue gives each event to only ONE
# subscriber. Restricted to admins and bounded until a real per-subscriber pub/sub is implemented.
attendance_event_queue: asyncio.Queue = asyncio.Queue(maxsize=1000)

@router.get("/attendance-radar")
async def stream_attendance_events(
    request: Request,
    _admin=Depends(require_roles([UserRole.SUPER_ADMIN, UserRole.HR_ADMIN, UserRole.PROJECT_MANAGER])),
):
    """
    Server-Sent Events (SSE) live radar feed replacing Firestore onSnapshot() listeners.
    """
    async def event_generator():
        # Send initial connection ping
        init_event = {"type": "CONNECTED", "timestamp": datetime.now(timezone.utc).isoformat()}
        yield f"data: {json.dumps(init_event)}\n\n"
        
        while True:
            if await request.is_disconnected():
                break
            try:
                # Wait for next event with a 15-second heartbeat
                event = await asyncio.wait_for(attendance_event_queue.get(), timeout=15.0)
                yield f"data: {json.dumps(event)}\n\n"
            except asyncio.TimeoutError:
                # Heartbeat keepalive
                yield f": heartbeat\n\n"

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )
