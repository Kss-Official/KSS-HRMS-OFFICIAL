from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
import time
from typing import Optional, Tuple

from app.core.database import get_db
from app.models.employee import Employee
from app.models.settings import CompanySettings
from app.models.enums import UserRole
from app.schemas.settings import CompanySettingsOut, CompanySettingsUpdate
from app.api.deps import get_current_user, get_optional_current_user, require_roles

router = APIRouter()

VALID_ROLES = {r.value for r in UserRole}


def _validate_settings_update(d: dict) -> None:
    import math
    if "geofence_lat" in d and (d["geofence_lat"] is None or not math.isfinite(d["geofence_lat"]) or not -90 <= d["geofence_lat"] <= 90):
        raise HTTPException(status_code=422, detail="Latitude must be between -90 and 90")
    if "geofence_lon" in d and (d["geofence_lon"] is None or not math.isfinite(d["geofence_lon"]) or not -180 <= d["geofence_lon"] <= 180):
        raise HTTPException(status_code=422, detail="Longitude must be between -180 and 180")
    if "geofence_radius_meters" in d and (d["geofence_radius_meters"] is None or not 10 <= d["geofence_radius_meters"] <= 5000):
        raise HTTPException(status_code=422, detail="Geofence radius must be between 10 and 5000 metres")
    if "timezone" in d:
        try:
            from zoneinfo import ZoneInfo
            ZoneInfo(d["timezone"])
        except Exception:
            raise HTTPException(status_code=422, detail="Unknown timezone")
    if "allowed_wfh_roles" in d and d["allowed_wfh_roles"] is not None:
        bad = [r for r in d["allowed_wfh_roles"] if r not in VALID_ROLES]
        if bad:
            raise HTTPException(status_code=422, detail=f"Unknown role(s): {bad}")
    for k in ("office_name", "geofence_lat", "geofence_lon", "geofence_radius_meters", "geofence_enforced", "timezone"):
        if k in d and d[k] is None:
            raise HTTPException(status_code=422, detail=f"{k} cannot be null")

_SETTINGS_CACHE: Optional[Tuple[float, CompanySettingsOut]] = None

def invalidate_settings_cache():
    global _SETTINGS_CACHE
    _SETTINGS_CACHE = None

@router.get("/", response_model=CompanySettingsOut)
async def get_settings(
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(get_current_user)
):
    global _SETTINGS_CACHE
    now = time.time()
    if _SETTINGS_CACHE and _SETTINGS_CACHE[0] > now:
        return _SETTINGS_CACHE[1]

    result = await db.execute(select(CompanySettings).where(CompanySettings.id == 1))
    settings_obj = result.scalar_one_or_none()
    if not settings_obj:
        # Create default
        settings_obj = CompanySettings(
            id=1,
            office_name="Kalpanaaa Software Solutions HQ",
            geofence_lat=12.9121,
            geofence_lon=77.6446,
            geofence_radius_meters=100.0,
            geofence_enforced=True,
            timezone="Asia/Kolkata",
            allowed_wfh_roles=["SUPER_ADMIN", "HR_ADMIN"]
        )
        db.add(settings_obj)
        await db.commit()
        await db.refresh(settings_obj)
    
    out = CompanySettingsOut.model_validate(settings_obj)
    _SETTINGS_CACHE = (now + 60.0, out)
    return out

@router.put("/", response_model=CompanySettingsOut)
async def update_settings(
    payload: CompanySettingsUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: Employee = Depends(require_roles([UserRole.SUPER_ADMIN, UserRole.HR_ADMIN]))
):
    result = await db.execute(select(CompanySettings).where(CompanySettings.id == 1))
    settings_obj = result.scalar_one_or_none()
    if not settings_obj:
        settings_obj = CompanySettings(id=1)
        db.add(settings_obj)

    update_data = payload.model_dump(exclude_unset=True)
    _validate_settings_update(update_data)
    for key, value in update_data.items():
        setattr(settings_obj, key, value)

    await db.commit()
    await db.refresh(settings_obj)
    invalidate_settings_cache()
    try:
        from app.api.v1.endpoints.attendance import invalidate_company_settings_cache
        invalidate_company_settings_cache()
    except Exception:
        pass
    return settings_obj
