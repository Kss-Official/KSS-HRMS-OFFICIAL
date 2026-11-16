from pydantic import BaseModel
from typing import Optional, List

class CompanySettingsOut(BaseModel):
    id: int
    office_name: str
    geofence_lat: float
    geofence_lon: float
    geofence_radius_meters: float
    geofence_enforced: bool
    timezone: str
    allowed_wfh_roles: Optional[List[str]] = []

    class Config:
        from_attributes = True

class CompanySettingsUpdate(BaseModel):
    office_name: Optional[str] = None
    geofence_lat: Optional[float] = None
    geofence_lon: Optional[float] = None
    geofence_radius_meters: Optional[float] = None
    geofence_enforced: Optional[bool] = None
    timezone: Optional[str] = None
    allowed_wfh_roles: Optional[List[str]] = None
