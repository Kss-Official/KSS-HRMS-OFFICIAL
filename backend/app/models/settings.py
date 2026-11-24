from sqlalchemy import Column, String, Float, Boolean, Integer, JSON
from app.core.database import Base

class CompanySettings(Base):
    __tablename__ = "company_settings"

    id = Column(Integer, primary_key=True, default=1)
    office_name = Column(String, default="Kalpanaaa Software Solutions HQ")
    geofence_lat = Column(Float, default=13.014361)
    geofence_lon = Column(Float, default=77.645888)
    geofence_radius_meters = Column(Float, default=500.0)
    geofence_enforced = Column(Boolean, default=True)
    timezone = Column(String, default="Asia/Kolkata")
    allowed_wfh_roles = Column(JSON, default=list)
