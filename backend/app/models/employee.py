import uuid
from sqlalchemy import Column, String, Boolean, DateTime, Date, Numeric, Text
from sqlalchemy.dialects.postgresql import UUID, JSONB, ENUM
from sqlalchemy.sql import func
from pgvector.sqlalchemy import Vector
from app.core.database import Base
from app.models.enums import UserRole, ExecutiveTier, EmploymentType

user_role_pg_enum = ENUM(UserRole, name="user_role_enum", create_type=False)
executive_tier_pg_enum = ENUM(ExecutiveTier, name="executive_tier_enum", create_type=False)
employment_type_pg_enum = ENUM(EmploymentType, name="employment_type_enum", create_type=False)

class Employee(Base):
    __tablename__ = "employees"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_code = Column(String, unique=True, index=True, nullable=False)
    email = Column(String, unique=True, index=True, nullable=False)
    password_hash = Column(String, nullable=False)
    full_name = Column(String, nullable=False)
    role = Column(user_role_pg_enum, default=UserRole.EMPLOYEE, nullable=False)
    executive_tier = Column(executive_tier_pg_enum, default=ExecutiveTier.NONE, nullable=False)
    employment_type = Column(employment_type_pg_enum, default=EmploymentType.FULL_TIME, nullable=False)
    department = Column(String, nullable=False)
    designation = Column(String, nullable=False)
    joining_date = Column(Date, nullable=False)
    work_location = Column(String, nullable=True)
    reporting_manager_id = Column(UUID(as_uuid=True), nullable=True)

    # Leave Balances
    earn_leave_balance = Column(Numeric(5, 2), default=0.00, nullable=False)
    sick_leave_balance = Column(Numeric(5, 2), default=0.00, nullable=False)
    casual_leave_balance = Column(Numeric(5, 2), default=0.00, nullable=False)

    # Biometrics: JSONB raw descriptor and pgvector 128D Embedding with HNSW index
    face_descriptor = Column(JSONB, nullable=True)
    is_face_enrolled = Column(Boolean, default=False, nullable=False)
    face_embedding = Column(Vector(128), nullable=True)

    # Contact & Details
    phone = Column(String, nullable=True)
    gender = Column(String, nullable=True)
    date_of_birth = Column(Date, nullable=True)
    address = Column(Text, nullable=True)
    city = Column(String, nullable=True)
    state = Column(String, nullable=True)
    postal_code = Column(String, nullable=True)
    emergency_contact = Column(String, nullable=True)
    emergency_relationship = Column(String, nullable=True)
    profile_photo_url = Column(String, nullable=True)
    bio = Column(Text, nullable=True)
    linkedin_url = Column(String, nullable=True)
    legacy_firebase_id = Column(String, nullable=True)

    base_salary = Column(Numeric(10, 2), default=0.00, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
