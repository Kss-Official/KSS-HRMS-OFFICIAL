from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse
import asyncio
import json
from datetime import datetime, timezone

router = APIRouter()

attendance_event_queue: asyncio.Queue = asyncio.Queue()

@router.get("/attendance-radar")
async def stream_attendance_events(request: Request):
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
