from enum import Enum

class UserRole(str, Enum):
    SUPER_ADMIN = "SUPER_ADMIN"
    HR_ADMIN = "HR_ADMIN"
    PROJECT_MANAGER = "PROJECT_MANAGER"
    TECH_LEAD = "TECH_LEAD"
    EMPLOYEE = "EMPLOYEE"

class ExecutiveTier(str, Enum):
    CEO = "CEO"
    CTO = "CTO"
    NONE = "NONE"

class EmploymentType(str, Enum):
    FULL_TIME = "FULL_TIME"
    TRAINEE = "TRAINEE"
    INTERN = "INTERN"
    CONTRACT = "CONTRACT"

class AttendanceStatus(str, Enum):
    PRESENT = "PRESENT"
    LATE = "LATE"
    HALF_DAY = "HALF_DAY"
    ON_LEAVE = "ON_LEAVE"
    WORK_FROM_HOME = "WORK_FROM_HOME"
    ABSENT = "ABSENT"
    HOLIDAY = "HOLIDAY"

class AttendanceMethod(str, Enum):
    BIOMETRIC_FACE = "BIOMETRIC_FACE"
    PORTAL_1CLICK = "PORTAL_1CLICK"
    GEO_ATTENDANCE = "GEO_ATTENDANCE"
    HR_CORRECTION = "HR_CORRECTION"

class BreakType(str, Enum):
    TEA_BREAK = "TEA_BREAK"
    SNACK_BREAK = "SNACK_BREAK"
    LUNCH_BREAK = "LUNCH_BREAK"
    TEAM_HUDDLE = "TEAM_HUDDLE"
    TEAM_MEETING = "TEAM_MEETING"
    TRAINING = "TRAINING"
    ACTIVITY = "ACTIVITY"
    OTHER = "OTHER"

class LeaveType(str, Enum):
    EARN_LEAVE = "EARN_LEAVE"
    SICK_LEAVE = "SICK_LEAVE"
    CASUAL_LEAVE = "CASUAL_LEAVE"
    WFH = "WFH"
    LOSS_OF_PAY = "LOSS_OF_PAY"

class LeaveStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    CANCELLED = "CANCELLED"

class ApprovalStatus(str, Enum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    WAITING_CEO = "WAITING_CEO"
    NA = "NA"

class LedgerTransactionType(str, Enum):
    MONTHLY_CREDIT = "MONTHLY_CREDIT"
    APPROVED_DEBIT = "APPROVED_DEBIT"
    REVERSAL_CREDIT = "REVERSAL_CREDIT"
    MANUAL_ADJUSTMENT = "MANUAL_ADJUSTMENT"

class PayrollStatus(str, Enum):
    DRAFT = "DRAFT"
    APPROVED = "APPROVED"
    PAID = "PAID"
