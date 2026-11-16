import uuid
from sqlalchemy import Column, String, Boolean, DateTime, Date, Integer, Float, Text, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.dialects.postgresql import UUID, ENUM
from sqlalchemy.sql import func
from app.core.database import Base
from app.models.enums import AttendanceStatus, AttendanceMethod, BreakType

attendance_status_pg_enum = ENUM(AttendanceStatus, name="attendance_status_enum", create_type=False)
attendance_method_pg_enum = ENUM(AttendanceMethod, name="attendance_method_enum", create_type=False)
break_type_pg_enum = ENUM(BreakType, name="break_type_enum", create_type=False)

class AttendanceRecord(Base):
    __tablename__ = "attendance_records"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("employees.id"), nullable=False, index=True)
    date = Column(Date, nullable=False, index=True)
    status = Column(attendance_status_pg_enum, default=AttendanceStatus.PRESENT, nullable=False)
    check_in_at = Column(DateTime(timezone=True), nullable=True)
    check_out_at = Column(DateTime(timezone=True), nullable=True)
    working_minutes = Column(Integer, default=0, nullable=False)
    is_wfh = Column(Boolean, default=False, nullable=False)
    location_verified = Column(Boolean, default=False, nullable=False)
    check_in_lat = Column(Float, nullable=True)
    check_in_lon = Column(Float, nullable=True)
    attendance_method = Column(attendance_method_pg_enum, default=AttendanceMethod.PORTAL_1CLICK, nullable=True)
    corrected_by_id = Column(UUID(as_uuid=True), nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

    breaks = relationship("AttendanceBreak", lazy="selectin", cascade="all, delete-orphan", order_by="AttendanceBreak.start_time")

class AttendanceBreak(Base):
    __tablename__ = "attendance_breaks"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    attendance_id = Column(UUID(as_uuid=True), ForeignKey("attendance_records.id"), nullable=False, index=True)
    type = Column(break_type_pg_enum, default=BreakType.TEA_BREAK, nullable=False)
    start_time = Column(DateTime(timezone=True), nullable=False)
    end_time = Column(DateTime(timezone=True), nullable=True)
    duration_minutes = Column(Integer, default=0, nullable=False)
