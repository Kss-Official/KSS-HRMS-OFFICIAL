import uuid
from sqlalchemy import Column, String, Boolean, DateTime, Date, Numeric, Text, ForeignKey
from sqlalchemy.dialects.postgresql import UUID, ENUM
from sqlalchemy.sql import func
from app.core.database import Base
from app.models.enums import LeaveType, LeaveStatus, ApprovalStatus, LedgerTransactionType

leave_type_pg_enum = ENUM(LeaveType, name="leave_type_enum", create_type=False)
leave_status_pg_enum = ENUM(LeaveStatus, name="leave_status_enum", create_type=False)
approval_status_pg_enum = ENUM(ApprovalStatus, name="approval_status_enum", create_type=False)
ledger_transaction_type_pg_enum = ENUM(LedgerTransactionType, name="ledger_transaction_type_enum", create_type=False)

class LeaveRequest(Base):
    __tablename__ = "leave_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    request_code = Column(String, unique=True, index=True, nullable=False)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("employees.id"), nullable=False, index=True)
    type = Column(leave_type_pg_enum, nullable=False)
    start_date = Column(Date, nullable=False)
    end_date = Column(Date, nullable=False)
    reason = Column(Text, nullable=False)
    status = Column(leave_status_pg_enum, default=LeaveStatus.PENDING, nullable=False)

    # Executive Review (CEO & CTO)
    ceo_status = Column(approval_status_pg_enum, default=ApprovalStatus.PENDING, nullable=False)
    ceo_reviewed_by = Column(UUID(as_uuid=True), nullable=True)
    ceo_reviewed_at = Column(DateTime(timezone=True), nullable=True)
    ceo_notes = Column(Text, nullable=True)

    cto_status = Column(approval_status_pg_enum, default=ApprovalStatus.PENDING, nullable=False)
    cto_reviewed_by = Column(UUID(as_uuid=True), nullable=True)
    cto_reviewed_at = Column(DateTime(timezone=True), nullable=True)
    cto_notes = Column(Text, nullable=True)

    rejection_reason = Column(Text, nullable=True)
    deduction_applied = Column(Boolean, default=False, nullable=False)

    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at = Column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)

class LeaveLedger(Base):
    __tablename__ = "leave_ledger"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    employee_id = Column(UUID(as_uuid=True), ForeignKey("employees.id"), nullable=False, index=True)
    category = Column(leave_type_pg_enum, nullable=False)
    transaction_type = Column(ledger_transaction_type_pg_enum, nullable=False)
    amount = Column(Numeric(5, 2), nullable=False)
    balance_after = Column(Numeric(5, 2), nullable=False)
    reference_id = Column(String, nullable=True)
    notes = Column(Text, nullable=True)
    created_at = Column(DateTime(timezone=True), server_default=func.now(), nullable=False)
