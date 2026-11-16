from fastapi import APIRouter
from .endpoints import auth, employees, attendance, leaves, realtime, settings, audit

api_router = APIRouter()

api_router.include_router(auth.router, prefix="/auth", tags=["Authentication"])
api_router.include_router(employees.router, prefix="/employees", tags=["Employees"])
api_router.include_router(attendance.router, prefix="/attendance", tags=["Attendance"])
api_router.include_router(leaves.router, prefix="/leaves", tags=["Leaves"])
api_router.include_router(settings.router, prefix="/settings", tags=["Settings"])
api_router.include_router(audit.router, prefix="/audit", tags=["Audit"])
api_router.include_router(realtime.router, prefix="/realtime", tags=["Realtime"])
