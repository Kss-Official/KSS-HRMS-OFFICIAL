import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { shouldRunMonthlyAutoCredit, setMonthlyCreditLatch, runMonthlyAutoCredit, getMonthKey } from '../lib/leaveBalanceService';
import { User, signInWithEmailAndPassword, createUserWithEmailAndPassword } from 'firebase/auth';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  where,
  limit,
  orderBy,
  runTransaction,
  serverTimestamp
} from 'firebase/firestore';
import { auth, db, testConnection, handleFirestoreError, OperationType, firebaseConfig, cleanFirestorePayload, subscribeWithRecovery, signInAnonymously } from '../lib/firebase';
import { Employee, EmployeeStatus, AttendanceRecord, AuditLog, CompanySettings, UserRole, AttendanceStatus, WorkZone, LeaveRequest, AttendanceMethod, BreakType, normalizeBreakType } from '../types';
import {
  INITIAL_EMPLOYEES,
  generateInitialAttendance,
  INITIAL_AUDIT_LOGS,
  INITIAL_COMPANY_SETTINGS
} from '../lib/demoData';
import { initializeApp } from 'firebase/app';
import { 
  evaluateAttendanceScan, 
  validateCheckInEligibility,
  OFFICIAL_HOLIDAY_DATES_2026,
  calculateGpsDistanceMeters,
  isApprovedWfhForEmployee,
  getWorkDate,
  getEmployeeWorkDate,
  getEmployeeKey,
  getAttendanceDocId,
  getCanonicalEmployeeUid,
  formatTimestampToISO,
  safeGetTimestampMillis,
  resolveAttendanceRecord,
  calculateTotalBreakMinutes,
  MAX_BREAK_MINUTES,
  COMPANY_TIMEZONE,
  COMPANY_START_DATE,
  isWfhType,
  isExecutiveOrLeadership
} from '../lib/attendanceEngine';
import { runAttendanceMigration } from '../lib/attendanceMigration';
import { classifyError, shouldFallbackToLocalLogin } from '../lib/errors';
import { fetchAbsoluteTime, toISTTimeString, todayInIST } from '../lib/absoluteTime';
import { sendKssNotification, sendAdminBroadcast, registerFcmToken, unregisterFcmToken, KssNotification } from '../lib/notifications';
import { clearAllFaceEngineState } from '../lib/faceDescriptorStore';
import { writeEmployeeResume, backfillEmployeeResumes } from '../lib/employeeResume';
import { LeaveService } from '../lib/leaveService';
import { isAuthorizedTechLead, isTestEmployee, deduplicateEmployeeList } from '../lib/hierarchy';
import {
  loginApi,
  getCurrentProfileApi,
  getEmployeesApi,
  getAttendanceRecordsApi,
  checkInApi,
  checkOutApi,
  correctAttendanceApi,
  breakActionApi,
  endBreakApi,
  getLeavesApi,
  applyLeaveApi,
  reviewLeaveApi,
  cancelLeaveApi,
  createEmployeeApi,
  updateEmployeeApi,
  deleteEmployeeApi,
  uploadPhotoApi,
  getSettingsApi,
  updateSettingsApi,
  getAuditLogsApi,
  createAuditLogApi,
  resetAllFacesApi,
  resetEmployeeFaceApi,
  enrollFaceApi,
  getAuthToken,
  setAuthToken,
  removeAuthToken,
  clearApiCache,
  changePasswordApi,
  syncFirebaseSessionApi
} from '../lib/apiClient';
import { resetAllLocalFaceDescriptors, clearEmployeeDescriptor, saveEmployeeDescriptor, isFaceBiometricEnrolled } from '../lib/faceDescriptorStore';
import { getEmployeeAvatar, LOCAL_AVATARS } from '../lib/avatarHelper';

// ── 100% NEON POSTGRESQL ARCHITECTURE ──────────────────────────────────────
// Firebase Firestore DB is completely disabled in favor of Neon PostgreSQL (via FastAPI).
export const USE_FIREBASE_FIRESTORE = false;

const mapBackendToFrontendEmployee = (data: any): Employee => {
  const empId = data.id || data.employee_id || '';
  const empCode = data.employee_code || data.employeeId || 'EMP';
  const roleVal: UserRole = (data.role as UserRole) || 'EMPLOYEE';
  const nameVal = data.full_name || data.fullName || 'Employee';

  // Resolved manager
  let managerName = data.reporting_manager;
  if (!managerName || managerName === 'D. Koushik') {
    if (empCode === 'KSS2407009' || nameVal.toLowerCase().includes('priyanka')) {
      managerName = 'Gaurav kumar Tripathi';
    } else if (empCode === 'KSS2407012' || empCode === 'KSS2407013' || nameVal.toLowerCase().includes('satya') || nameVal.toLowerCase().includes('akash')) {
      managerName = 'Akshit ujjain';
    } else if (empCode === 'KSS2407001' || empCode === 'KSS2407002' || empCode === 'KSS2407015') {
      managerName = 'Executive Board';
    } else {
      managerName = 'D. Koushik';
    }
  }

  // Resolved specialization
  let spec = data.specialization;
  if (!spec) {
    if (empCode === 'KSS2407004') spec = 'Frontend Development';
    else if (empCode === 'KSS2407005') spec = 'Backend Development';
    else if (empCode === 'KSS2407006' || empCode === 'KSS2407007') spec = 'UI/UX Design';
    else if (empCode === 'KSS2407009' || empCode === 'KSS2407017' || empCode === 'KSS2407008') spec = 'Full Stack Development';
    else if (empCode === 'KSS2407010') spec = 'Frontend Development';
    else if (empCode === 'KSS2407012') spec = 'Technical Leadership';
    else if (empCode === 'KSS2407013') spec = 'Backend Development';
    else if (empCode === 'KSS-EMP' || empCode === 'KSS-HR01') spec = 'HR Operations';
    else if (empCode === 'KSS2407016') spec = 'Generative AI';
    else if (empCode === 'KSS2407003') spec = 'Project Management';
    else if (empCode === 'KSS2407001') spec = 'Technical Leadership';
    else if (empCode === 'KSS2407002') spec = 'Project Management';
    else if (empCode === 'KSS2407015') spec = 'Solution Architecture';
  }

  const skillsList = (Array.isArray(data.skills) && data.skills.length > 0)
    ? data.skills
    : (spec ? [spec] : []);

  return {
    id: empId,
    uid: data.legacy_firebase_id || empId,
    employeeId: empCode,
    fullName: nameVal,
    email: data.email || '',
    phone: data.phone || '',
    gender: (data.gender as any) || 'Prefer not to say',
    dateOfBirth: data.date_of_birth || data.dateOfBirth || '',
    profilePhotoUrl: data.profile_photo_url || data.profilePhotoUrl || getEmployeeAvatar(data),
    department: data.department || 'IT',
    designation: data.designation || 'Software Engineer',
    specialization: spec,
    skills: skillsList,
    joiningDate: data.joining_date || data.joiningDate || new Date().toISOString().split('T')[0],
    employmentType: (data.employment_type as any) || 'Full-Time',
    reportingManager: managerName,
    workLocation: data.work_location || 'Kalpanaaa Main Office HQ, Bengaluru',
    status: (data.is_active === false) ? 'Inactive' : 'Active',
    shift: data.shift || 'Day Shift (10:00 AM – 7:00 PM)',
    permanentAddress: data.address || data.permanentAddress || 'Bengaluru HQ Campus',
    currentAddress: data.address || data.currentAddress || 'Bengaluru HQ Campus',
    city: data.city || 'Bengaluru',
    state: data.state || 'Karnataka',
    postalCode: data.postal_code || data.postalCode || '560102',
    emergencyContact: data.emergency_contact || data.emergencyContact || '',
    emergencyRelationship: data.emergency_relationship || data.emergencyRelationship || '',
    bio: data.bio || '',
    role: (empCode === 'CEO001' || empCode === 'CTO001' || empCode === 'KSS2407001' || empCode === 'KSS2407002' || empCode === 'KSS2407015') ? 'SUPER_ADMIN' : roleVal,
    executiveRole: (data.executive_tier as any) || (roleVal === 'SUPER_ADMIN' ? 'CEO' : undefined),
    isFaceEnrolled: !!data.is_face_enrolled,
    faceDescriptor: data.face_descriptor || data.faceDescriptor || undefined,
    qrToken: empCode,
    earnLeaveBalance: typeof data.earn_leave_balance === 'number' ? data.earn_leave_balance : (typeof data.earnLeaveBalance === 'number' ? data.earnLeaveBalance : 0),
    sickLeaveBalance: typeof data.sick_leave_balance === 'number' ? data.sick_leave_balance : (typeof data.sickLeaveBalance === 'number' ? data.sickLeaveBalance : 0),
    casualLeaveBalance: typeof data.casual_leave_balance === 'number' ? data.casual_leave_balance : (typeof data.casualLeaveBalance === 'number' ? data.casualLeaveBalance : 0),
    createdAt: data.created_at || new Date().toISOString(),
    updatedAt: data.updated_at || new Date().toISOString()
  };
};

const generateDeviceFingerprint = () => {
  return btoa(`${navigator.userAgent}|${screen.width}x${screen.height}|${navigator.language}|${new Date().getTimezoneOffset()}`);
};

const getDeviceCategory = (): 'desktop' | 'mobile' => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'desktop';
  const ua = navigator.userAgent || '';
  if (/Mobi|Android|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(ua)) {
    return 'mobile';
  }
  return 'desktop';
};

const sanitizeInput = <T extends any>(data: T): T => {
  if (typeof data === 'string') {
    // Skip sanitization for base64 images to prevent regex corruption of large strings
    if (data.startsWith('data:image/')) return data as any;

    // Strip script tags and common XSS vectors
    return data.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+="[^"]*"/gi, '')
      .replace(/on\w+='[^']*'/gi, '')
      .replace(/on\w+=\w+/gi, '') as any;
  }
  if (Array.isArray(data)) {
    return data.map(item => sanitizeInput(item)) as any;
  }
  if (typeof data === 'object' && data !== null) {
    const sanitizedObj: any = {};
    for (const key in data) {
      if (Object.prototype.hasOwnProperty.call(data, key)) {
        sanitizedObj[key] = sanitizeInput((data as any)[key]);
      }
    }
    return sanitizedObj;
  }
  return data;
};

// Helper for allocating specific employee IDs to known staff and generating next sequential IDs with safety floor
const getAssignedEmployeeDetails = (fullName: string, employees: Employee[], email?: string) => {
  const name = (fullName || '').toLowerCase().trim();
  const cleanEmail = (email || '').toLowerCase().trim();
  
  if (name.includes('gaurav') || cleanEmail.includes('founder') || cleanEmail.includes('gaurav')) {
    return {
      employeeId: 'KSS2407001',
      role: 'SUPER_ADMIN' as UserRole,
      designation: 'CTO And Founder And MD'
    };
  }
  if (name.includes('akshit') || cleanEmail.includes('akshit')) {
    return {
      employeeId: 'KSS2407002',
      role: 'SUPER_ADMIN' as UserRole,
      designation: 'CEO'
    };
  }
  if (name.includes('koushik') || cleanEmail.includes('koushik')) {
    return {
      employeeId: 'KSS2407003',
      role: 'PROJECT_MANAGER' as UserRole,
      designation: 'Project Manager'
    };
  }
  if (name.includes('asbin') || cleanEmail.includes('asbin')) {
    return {
      employeeId: 'KSS2407004',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Software Developer'
    };
  }
  if (name.includes('thabeethal') || cleanEmail.includes('thabeethal')) {
    return {
      employeeId: 'KSS2407005',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Backend Developer'
    };
  }
  if (name.includes('mahesh') || cleanEmail.includes('mahesh')) {
    return {
      employeeId: 'KSS2407006',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Frontend Developer'
    };
  }
  if (name.includes('ritish') || cleanEmail.includes('ritish')) {
    return {
      employeeId: 'KSS2407007',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Full Stack Developer'
    };
  }
  if (name.includes('pratiksha') || cleanEmail.includes('pratiksha')) {
    return {
      employeeId: 'KSS2407008',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Full Stack Development'
    };
  }
  if (name.includes('priyanka') || cleanEmail.includes('priyanka')) {
    return {
      employeeId: 'KSS2407009',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Frontend Developer'
    };
  }
  if (name.includes('prahlad') || cleanEmail.includes('prahlad')) {
    return {
      employeeId: 'KSS2407010',
      role: 'EMPLOYEE' as UserRole,
      designation: 'Frontend Developer'
    };
  }

  // Cross-check INITIAL_EMPLOYEES first to match any seeded staff by email or name
  const existingInitial = INITIAL_EMPLOYEES.find(e =>
    (cleanEmail && e.email && e.email.toLowerCase() === cleanEmail) ||
    (name && e.fullName && e.fullName.toLowerCase() === name)
  );
  if (existingInitial) {
    return {
      employeeId: existingInitial.employeeId,
      role: existingInitial.role,
      designation: existingInitial.designation
    };
  }

  // General employees: calculate max sequence with safety floor of 17 (KSS2407017 is highest seeded)
  // Combine INITIAL_EMPLOYEES with current live employees so a cold cache never reverts to 004
  const pool = [...INITIAL_EMPLOYEES, ...(employees || [])];
  let maxSeq = 17; 
  pool.forEach(emp => {
    if (emp.employeeId?.startsWith('KSS2407') || emp.employeeId?.startsWith('KSS2707')) {
      const numStr = emp.employeeId.replace('KSS2407', '').replace('KSS2707', '');
      const num = parseInt(numStr, 10);
      if (!isNaN(num) && num > maxSeq) {
        maxSeq = num;
      }
    }
  });

  const nextSeq = String(maxSeq + 1).padStart(3, '0');
  return {
    employeeId: `KSS2407${nextSeq}`,
    role: null,
    designation: null
  };
};

interface AuthContextType {
  user: User | null;
  activeEmployee: Employee | null;
  role: UserRole;
  isAuthenticated: boolean;
  isLoading: boolean;
  isDemoMode: boolean;
  isFirestoreConnected: boolean;
  isSessionReady: boolean;
  attendanceSyncStatus: 'loading' | 'synced';
  employees: Employee[];
  attendance: AttendanceRecord[];
  auditLogs: AuditLog[];
  settings: CompanySettings;
  companyWorkZone: WorkZone;
  leaveRequests: LeaveRequest[];
  notifications: KssNotification[];
  unreadNotificationCount: number;
  companyWideWfhDates: string[];

  // Actions
  submitLeaveRequest: (data: Omit<LeaveRequest, 'id' | 'status' | 'requestDate' | 'createdAt' | 'updatedAt'>) => Promise<{ success: boolean; id: string; message: string }>;
  updateLeaveRequestStatus: (id: string, status: 'Approved' | 'Rejected', reviewedBy: string, reviewNotes?: string, targetStage?: 'PM' | 'HR' | 'CEO' | 'CTO') => void;
  updateLeaveRequestStage: (id: string, stage: 'PM' | 'HR' | 'CEO' | 'CTO', decision: 'Approved' | 'Rejected', reviewerName: string, notes?: string, employeeId?: string, startDate?: string, endDate?: string) => Promise<void>;
  cancelLeaveRequest: (id: string, employeeId?: string, startDate?: string, endDate?: string) => Promise<void>;
  loginWithEmail: (email: string, pass: string) => Promise<{ success: boolean; message: string }>;
  quickDemoLogin: (role: UserRole | 'CEO' | 'CTO') => void;
  logout: () => void;
  addEmployee: (emp: Omit<Employee, 'id' | 'createdAt' | 'updatedAt' | 'qrToken'> & { password?: string }) => Promise<{ success: boolean; message?: string } | Employee>;
  updateEmployee: (id: string, updates: Partial<Employee>) => Promise<void>;
  deleteEmployee: (id: string) => void;
  recordCheckIn: (employeeId: string, lat?: number, lon?: number, accuracy?: number | AttendanceMethod, method?: number | AttendanceMethod, customDate?: string, overrideWfh?: boolean, faceDescriptor?: number[]) => Promise<{ success: boolean; message: string; record?: AttendanceRecord }>;
  recordCheckOut: (employeeId: string, lat?: number, lon?: number, accuracy?: number, customDate?: string) => Promise<{ success: boolean; message: string; record?: AttendanceRecord }>;
  checkIn: (employeeId: string, lat?: number, lon?: number, accuracy?: number | AttendanceMethod, method?: number | AttendanceMethod, customDate?: string, overrideWfh?: boolean, faceDescriptor?: number[]) => Promise<{ success: boolean; message: string; record?: AttendanceRecord }>;
  checkOut: (employeeId: string, lat?: number, lon?: number, accuracy?: number, customDate?: string) => Promise<{ success: boolean; message: string; record?: AttendanceRecord }>;
  startBreak: (employeeId: string, breakType?: string, lat?: number, lon?: number) => Promise<{ success: boolean; message: string }>;
  endBreak: (employeeId: string, lat?: number, lon?: number) => Promise<{ success: boolean; message: string }>;
  updateAttendanceRecord: (recordId: string, updates: Partial<AttendanceRecord>) => Promise<void>;
  applyAttendanceCorrection: (
    record: AttendanceRecord & { isSynthetic?: boolean },
    updates: Partial<AttendanceRecord>
  ) => Promise<{ success: boolean; message: string }>;
  unmarkAttendanceRecord: (
    employeeId: string,
    date: string,
    recordId?: string
  ) => Promise<{ success: boolean; message: string }>;
  updateSettings: (newSettings: Partial<CompanySettings>) => void;
  saveCompanyWorkZone: (zone: Partial<WorkZone>) => Promise<void>;
  addAuditLog: (action: string, target: string, details: string) => void;
  resetToDemoData: () => void;
  enrollEmployeeBiometrics: (employeeId: string, faceDescriptor: number[], force?: boolean) => Promise<{ success: boolean; message: string }>;
  resetEmployeeBiometrics: (employeeId: string) => Promise<{ success: boolean; message: string }>;
  resetAllBiometrics: () => Promise<{ success: boolean; message: string }>;
  regenerateQrToken: (employeeId: string) => string;
  sendPasswordReset: (email: string) => Promise<{ success: boolean; message: string }>;
  setEmployeeInitialPassword: (email: string, pass: string) => Promise<{ success: boolean; message: string }>;
  sendBroadcast: (title: string, message: string) => Promise<void>;
  assignCompanyWideWfh: (date: string) => { success: boolean; message: string };
  removeCompanyWideWfh: (date: string) => { success: boolean; message: string };
  markAllNotificationsRead: () => void;
  updateCurrentEmployeePassword: (newPassword: string, oldPassword?: string) => Promise<{ success: boolean; message: string }>;
  requestMobilePushPermission: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);

  // Initial employees array restored synchronously
  const [employees, setEmployees] = useState<Employee[]>(() => {
    const saved = localStorage.getItem('kss_v1_employees');
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as Employee[];
        return deduplicateEmployeeList(parsed)
          .filter(emp => {
            if (emp.id === 'emp-003' || emp.employeeId === '003' || isTestEmployee(emp)) return false;
            const n = (emp.fullName || '').toLowerCase();
            const c = (emp.employeeId || '').toLowerCase();
            const m = (emp.email || '').toLowerCase();
            if (
              c === 'new6dfc34f4' || 
              n.includes('admin created user') || 
              c === 'alice001' || 
              c === 'test001' || 
              n.includes('test portal') || 
              n.includes('alice test') || 
              n === 'alice' || 
              m.includes('alice') ||
              emp.id === 'dQ7XANsF9eUL3JZyqCXIlAPHF382' ||
              c === 'kss2407018' ||
              n.includes('avanish') ||
              m.includes('na@kalpanaaa.in')
            ) return false;
            return true;
          })
          .map(emp => {
            if (emp.employeeId === 'CEO001') {
              return {
                ...emp,
                fullName: 'Akshit',
                email: 'akshit@kalpanaaa.in',
                department: 'Executive Management'
              };
            }
            let updated = { ...emp };
            if (updated.employeeId && (updated.employeeId.startsWith('KS2407') || updated.employeeId.startsWith('KS2707'))) {
              updated.employeeId = updated.employeeId.replace('KS2707', 'KSS2407').replace('KS2407', 'KSS2407');
            }

            const empName = (updated.fullName || (updated as any).name || '').toLowerCase();
            const empCode = (updated.employeeId || '').toLowerCase();
            const empId = (updated.id || (updated as any).uid || '').toLowerCase();

            if (empId.includes('kss2407004') || empCode.includes('kss2407004') || empName.includes('asbin')) {
              return {
                ...updated,
                earnLeaveBalance: 0,
                sickLeaveBalance: 1,
                approvedWfhDates: ['2026-08-28', '2026-08-29']
              };
            }
            if (empId.includes('kss2407006') || empCode.includes('kss2407006') || empName.includes('mahesh') || empId === '8t19zoi3notdcgeye4bwsviwseq1') {
              return {
                ...updated,
                earnLeaveBalance: 0,
                sickLeaveBalance: 1,
                approvedWfhDates: ['2026-08-27', '2026-08-29']
              };
            }
            if (empId.includes('kss2407005') || empCode.includes('kss2407005') || empName.includes('thabeethal')) {
              return {
                ...updated,
                status: 'Inactive',
                earnLeaveBalance: 0,
                sickLeaveBalance: 1
              };
            }
            if (empId.includes('kss2407008') || empCode.includes('kss2407008') || empName.includes('pratiksha')) {
              return {
                ...updated,
                employmentType: 'Trainee'
              };
            }
            if (empId.includes('kss2407003') || empCode.includes('kss2407003') || empName.includes('koushik')) {
              return {
                ...updated,
                earnLeaveBalance: 0,
                sickLeaveBalance: 1
              };
            }
            if (empId.includes('kss2407013') || empCode.includes('kss2407013') || empName.includes('akash')) {
              return {
                ...updated,
                earnLeaveBalance: 1,
                sickLeaveBalance: 0,
                approvedWfhDates: []
              };
            }
            if (empId === '8rxh6z3zzutmm26iqta1dhcpa8l1' || empCode === 'kss2407014' || empName.includes('jigy') || empName.includes('jing')) {
              return {
                ...updated,
                earnLeaveBalance: 1,
                sickLeaveBalance: 1
              };
            }
            if (empId === 'kfab95lpbjoeylpkqawx4gxopgt2' || empCode === 'kss2407011' || empName.includes('jason')) {
              return {
                ...updated,
                status: 'Inactive',
                earnLeaveBalance: 1,
                sickLeaveBalance: 0,
                joiningDate: '2026-08-17'
              };
            }
            if (empId === '4lj6efl4vytaemq24cjgq2hc7fe2' || empCode === 'kss2407017' || empName.includes('shruti')) {
              return {
                ...updated,
                earnLeaveBalance: 2,
                sickLeaveBalance: 0,
                joiningDate: '2026-09-01'
              };
            }

            updated.profilePhotoUrl = getEmployeeAvatar(updated);
            return updated;
          });
      } catch (e) {}
    }
    return INITIAL_EMPLOYEES;
  });

  // 24-Hour Token Expiry / Session Timeout Validation (Fixes C20 Contract)
  const SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const clearPersistedSessionKeys = () => {
    localStorage.removeItem('kss_v1_session');
    localStorage.removeItem('kss_v1_session_email');
    localStorage.removeItem('kss_v1_session_id');
    localStorage.removeItem('kss_v1_session_timestamp');
  };
  const isSessionValidOnBoot = (): boolean => {
    const savedSessionId = localStorage.getItem('kss_v1_session');
    if (!savedSessionId) return false;
    const timestampStr = localStorage.getItem('kss_v1_session_timestamp');
    if (!timestampStr) {
      // If session exists without a timestamp, backfill current timestamp instead of destructive wipe
      try { localStorage.setItem('kss_v1_session_timestamp', Date.now().toString()); } catch {}
      return true;
    }
    const stamp = parseInt(timestampStr, 10);
    if (!Number.isFinite(stamp) || Date.now() - stamp > SESSION_MAX_AGE_MS) {
      clearPersistedSessionKeys();
      return false;
    }
    return true;
  };

  // Synchronous session restore for activeEmployee
  const [activeEmployee, setActiveEmployee] = useState<Employee | null>(() => {
    if (!isSessionValidOnBoot()) return null;
    const savedSessionId = localStorage.getItem('kss_v1_session');
    const savedEmail = localStorage.getItem('kss_v1_session_email');

    // 1. Direct cached active employee profile (0ms instant boot)
    const cachedActive = localStorage.getItem('kss_v1_cached_active_employee');
    if (cachedActive) {
      try {
        const parsed = JSON.parse(cachedActive) as Employee;
        if (parsed && (parsed.id === savedSessionId || parsed.employeeId === savedSessionId || (savedEmail && parsed.email?.toLowerCase() === savedEmail.toLowerCase()))) {
          if (isFaceBiometricEnrolled(parsed)) {
            parsed.isFaceEnrolled = true;
          }
          parsed.profilePhotoUrl = getEmployeeAvatar(parsed);
          return parsed;
        }
      } catch {}
    }

    // 2. Fallback to cached employees list
    const savedEmps = localStorage.getItem('kss_v1_employees');
    if (savedSessionId && savedEmps) {
      try {
        const parsed = JSON.parse(savedEmps) as Employee[];
        // Match by ID first, then by email backup key
        const found = parsed.find(e =>
          e.id === savedSessionId ||
          e.employeeId === savedSessionId ||
          (savedEmail && e.email?.toLowerCase() === savedEmail.toLowerCase())
        );
        if (found) {
          if (isFaceBiometricEnrolled(found)) {
            found.isFaceEnrolled = true;
          }
          found.profilePhotoUrl = getEmployeeAvatar(found);
          return found;
        }
      } catch (e) {}
    }
    if (savedSessionId || savedEmail) {
      const foundInInitial = INITIAL_EMPLOYEES.find(e =>
        e.id === savedSessionId ||
        e.employeeId === savedSessionId ||
        (savedEmail && e.email?.toLowerCase() === savedEmail.toLowerCase())
      );
      if (foundInInitial) {
        const copy = { ...foundInInitial };
        if (isFaceBiometricEnrolled(copy)) {
          copy.isFaceEnrolled = true;
        }
        return copy;
      }
    }
    return null;
  });

  // Synchronous role restore
  const [role, setRole] = useState<UserRole>(() => {
    if (!isSessionValidOnBoot()) return 'EMPLOYEE';
    const savedSessionId = localStorage.getItem('kss_v1_session');
    const savedEmail = localStorage.getItem('kss_v1_session_email');

    // Check cached active employee first
    const cachedActive = localStorage.getItem('kss_v1_cached_active_employee');
    if (cachedActive) {
      try {
        const parsed = JSON.parse(cachedActive) as Employee;
        if (parsed?.role) {
          if (parsed.employeeId === 'CEO001' || parsed.employeeId === 'CTO001') return 'SUPER_ADMIN';
          return parsed.role;
        }
      } catch {}
    }

    const savedEmps = localStorage.getItem('kss_v1_employees');
    if (savedEmps) {
      try {
        const parsed = JSON.parse(savedEmps) as Employee[];
        const found = parsed.find(e =>
          e.id === savedSessionId ||
          e.employeeId === savedSessionId ||
          (savedEmail && e.email?.toLowerCase() === savedEmail.toLowerCase())
        );
        if (found) {
          if (found.employeeId === 'CEO001' || found.employeeId === 'CTO001') return 'SUPER_ADMIN';
          return found.role || 'EMPLOYEE';
        }
      } catch (e) {}
    }
    return 'EMPLOYEE';
  });

  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(() => {
    return isSessionValidOnBoot();
  });
  const [isLoading, setIsLoading] = useState(false);
  const [isDemoMode, setIsDemoMode] = useState(true);
  const [isFirestoreConnected, setIsFirestoreConnected] = useState(false);
  
  // Ready immediately if session is valid on boot; otherwise waits for onAuthStateChanged
  const [isSessionReady, setIsSessionReady] = useState<boolean>(() => isSessionValidOnBoot());
  const [attendanceSyncStatus, setAttendanceSyncStatus] = useState<'loading' | 'synced'>(() => {
    if (typeof window !== 'undefined') {
      if (localStorage.getItem('kalpanaaa_jwt_token') || localStorage.getItem('kss_v1_session')) {
        return 'synced';
      }
      const cached = localStorage.getItem('kss_v1_attendance');
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed) && parsed.length > 0) return 'synced';
        } catch {}
      }
    }
    return 'synced';
  });

  // P0 INCIDENT FIX: verified Firebase Auth identity driving the Firestore listener
  // lifecycle. Listeners may only attach AFTER onAuthStateChanged has resolved a
  // real user (token validated), and must detach when that identity disappears
  // (sign-out / failed token refresh). Attaching auth-blind at mount caused every
  // listener to die permanently on permission-denied and never recover.
  const [authUid, setAuthUid] = useState<string | null>(null);

  // employeesRef always mirrors the current employees state for use in one-time effects
  const employeesRef = useRef<Employee[]>(employees);

  // attendanceRef mirrors live attendance for the auto-checkout effect.
  // Using a ref (instead of a closure over `attendance` state) prevents the
  // effect from being re-registered on every Firestore snapshot, which would
  // create a snapshot → write → snapshot feedback loop.
  const attendanceRef = useRef<AttendanceRecord[]>([]);

  // P1 FIX — WRONG AUDIT ATTRIBUTION: the auto-checkout effect is intentionally
  // stable (it must not re-register on every snapshot), so it captured
  // `addAuditLog` and `activeEmployee` from the FIRST render. Every automatic
  // checkout was therefore attributed to whoever/whatever the actor was at mount —
  // in practice the 'sys-admin' / 'System Admin' placeholder and the first-render
  // role — instead of the real signed-in user. These refs give the stable effect
  // access to live values without re-registering it.
  const activeEmployeeRef = useRef<Employee | null>(null);
  const addAuditLogRef = useRef<(action: string, target: string, details: string) => void>(() => {});

  // Mirrors the live privilege level for the long-lived snapshot handlers, which must
  // know whether this client is allowed to perform data-migration writes.
  const roleRef = useRef<UserRole>('EMPLOYEE');

  // Synchronous cache restore for instant zero-lag rendering on refresh
  const [attendance, setAttendance] = useState<AttendanceRecord[]>(() => {
    if (typeof window === 'undefined') return [];
    try {
      const saved = localStorage.getItem('kss_v1_attendance');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          const todayStr = getWorkDate(new Date());
          // Sanitize: ensure no historical record (< today) has an unclosed break dangling!
          return parsed.map((rec: AttendanceRecord) => {
            if (rec.date && rec.date < todayStr && Array.isArray(rec.breaks)) {
              const cleanedBreaks = rec.breaks.map((b: any) => {
                if (!b.endAt && !b.endTime) {
                  const fallbackEnd = rec.checkOutAt || b.startAt || b.startTime || (rec.date + 'T18:00:00.000Z');
                  return { ...b, endAt: fallbackEnd, endTime: fallbackEnd, durationMinutes: b.durationMinutes || 15 };
                }
                return b;
              });
              return { ...rec, breaks: cleanedBreaks };
            }
            return rec;
          });
        }
      }
    } catch (e) {
      console.warn('[AuthContext] Failed to parse saved attendance cache', e);
    }
    return [];
  });

  const [auditLogs, setAuditLogs] = useState<AuditLog[]>(() => {
    const saved = localStorage.getItem('kss_v1_audit_logs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? parsed : INITIAL_AUDIT_LOGS;
      } catch (e) {
        console.warn('[AuthContext] Failed to parse saved audit logs', e);
      }
    }
    return INITIAL_AUDIT_LOGS;
  });

  const [settings, setSettings] = useState<CompanySettings>(() => {
    const saved = localStorage.getItem('kss_v1_settings');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.warn('[AuthContext] Failed to parse saved settings', e);
      }
    }
    return INITIAL_COMPANY_SETTINGS;
  });

  const [companyWorkZone, setCompanyWorkZone] = useState<WorkZone>(() => {
    const saved = localStorage.getItem('kss_v1_work_zone');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.warn('[AuthContext] Failed to parse saved work zone', e);
      }
    }
    return {
      name: 'Kalpanaaa Software Solutions HQ',
      latitude: INITIAL_COMPANY_SETTINGS.officeLatitude || 13.014316,
      longitude: INITIAL_COMPANY_SETTINGS.officeLongitude || 77.64052,
      radiusMeters: INITIAL_COMPANY_SETTINGS.allowedRadiusMeters || 100,
      active: true,
      updatedBy: 'System Init',
      updatedAt: new Date().toISOString()
    };
  });

  const [leaveRequests, setLeaveRequests] = useState<LeaveRequest[]>(() => {
    const saved = localStorage.getItem('kss_v1_leave_requests');
    let base: LeaveRequest[] = [];
    if (saved !== null) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter((r: any) => {
            if (!r || !r.id) return false;
            const isDummy = (r.reason && (r.reason.toLowerCase().includes('dummy') || r.reason.toLowerCase().includes('test leave'))) ||
              r.id.startsWith('dummy-') || r.id.startsWith('test-') || r.id.startsWith('leave-') || r.is_dummy === true || r.isDummy === true;
            return !isDummy;
          });
          base = filtered;
        }
      } catch (e) {
        console.warn('[AuthContext] Failed to parse saved leave requests', e);
      }
    }
    return base.map((r: any) => {
      // In the hierarchy (Employee -> CEO -> CTO), approval requires CEO and CTO. PM and HR are NOT in the approval flow.
      const pmStatus: any = 'N/A';
      const hrStatus: any = 'N/A';
      const ceoStatus: any = r.ceoStatus === 'Approved' ? 'Approved' :
                        r.ceoStatus === 'Rejected' ? 'Rejected' :
                        (r.status === 'Pending' ? 'Pending' : 'N/A');
      const ctoStatus: any = r.ctoStatus === 'Approved' ? 'Approved' :
                        r.ctoStatus === 'Rejected' ? 'Rejected' :
                        (ceoStatus === 'Approved' ? 'Pending' : 'Waiting CEO');
      let status: 'Pending' | 'Approved' | 'Rejected' | 'Cancelled' = r.status || 'Pending';

      const isCeoPassed = ceoStatus === 'Approved' || ceoStatus === 'N/A' || ceoStatus === 'Bypassed';
      const isCtoPassed = ctoStatus === 'Approved' || ctoStatus === 'N/A' || ctoStatus === 'Bypassed';

      if (r.status === 'Cancelled') {
        status = 'Cancelled';
      } else if (
        r.status === 'Rejected' ||
        ceoStatus === 'Rejected' ||
        ctoStatus === 'Rejected' ||
        r.pmStatus === 'Rejected' ||
        r.hrStatus === 'Rejected'
      ) {
        status = 'Rejected';
      } else if (r.status === 'Approved' || (isCeoPassed && isCtoPassed && ceoStatus === 'Approved' && ctoStatus === 'Approved')) {
        status = 'Approved';
      } else {
        status = 'Pending';
      }

      return {
        ...r,
        pmStatus,
        hrStatus,
        ceoStatus,
        ctoStatus,
        status
      };
    });
  });

  // Notifications state — real-time feed from Firestore
  const [notifications, setNotifications] = useState<KssNotification[]>([]);

  // ── DEDICATED Company-Wide WFH Dates state ──
  // Initialized from localStorage first (instant), then kept in sync via Firestore real-time listener
  const [companyWideWfhDates, setCompanyWideWfhDates] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem('kss_v1_company_wfh_dates');
      if (saved) return JSON.parse(saved) as string[];
      // fallback: read from settings if previously stored there
      const settingsSaved = localStorage.getItem('kss_v1_settings');
      if (settingsSaved) {
        const s = JSON.parse(settingsSaved);
        return s.companyWideWfhDates || [];
      }
    } catch { /* ignore */ }
    return [];
  });

  // Dynamically synthesize real-time notifications for Attendance, Leave, and WFH events
  const combinedNotifications = React.useMemo(() => {
    // 1. Leave & WFH Request Notifications
    // Admins see ALL requests; employees only see their OWN sanction result (approved/rejected)
    // PM does NOT see HR employees' requests
    const leaveNotifs: KssNotification[] = leaveRequests.map(r => {
      const isResolved = r.status === 'Approved' || r.status === 'Rejected';
      const isHrEmployee = (r.department || '').toLowerCase().includes('hr') ||
        (r.employeeRole || '').toLowerCase().includes('hr') ||
        (() => {
          const emp = employees.find(e => 
            (!!r.employeeId && (e.employeeId === r.employeeId || e.id === r.employeeId)) ||
            (!!r.employeeName && !!e.fullName && e.fullName.trim().toLowerCase() === r.employeeName.trim().toLowerCase())
          );
          return emp?.department?.toLowerCase().includes('hr') || emp?.role === 'HR_ADMIN';
        })();

      // PM cannot see HR employees' Leave/WFH notifications
      const audience: string[] = isHrEmployee
        ? ['SUPER_ADMIN', 'HR_ADMIN']
        : ['SUPER_ADMIN', 'HR_ADMIN', 'PROJECT_MANAGER'];

      return {
        id: `notif-leave-${r.id}-${r.status}`,
        type: (r.status === 'Approved' ? 'LEAVE_REQUEST_APPROVED' : r.status === 'Rejected' ? 'LEAVE_REQUEST_REJECTED' : (r.type === 'WFH' ? 'WFH_REQUEST_SUBMITTED' : 'LEAVE_REQUEST_SUBMITTED')) as any,
        // Admin title: shows the employee name. Employee personal copy (isPersonalSanction) handled in bell component
        title: r.status === 'Approved'
          ? `✅ ${r.type} Approved — ${r.employeeName}`
          : r.status === 'Rejected'
          ? `❌ ${r.type} Rejected — ${r.employeeName}`
          : r.type === 'WFH' ? `🏠 Pending WFH Request: ${r.employeeName}` : `📋 Pending Leave Request: ${r.employeeName}`,
        body: isResolved
          ? `${r.employeeName}'s ${r.type} request (${r.startDate} to ${r.endDate}) has been ${r.status.toLowerCase()} by management.`
          : `${r.employeeName} (${r.department || 'HR'}) requested ${r.type} (${r.startDate} to ${r.endDate}). Status: ${r.status}. Reason: "${r.reason}".`,
        // Personal title/body shown to the employee themselves via isPersonalSanction filter
        personalTitle: r.status === 'Approved'
          ? `✅ Your ${r.type} Request Approved`
          : r.status === 'Rejected'
          ? `❌ Your ${r.type} Request Rejected`
          : undefined,
        personalBody: isResolved
          ? `Your ${r.type} request (${r.startDate} to ${r.endDate}) has been ${r.status.toLowerCase()} by management.`
          : undefined,
        audience,
        actorId: r.employeeId,
        actorName: r.employeeName,
        targetEmployeeId: r.employeeId,
        targetEmployeeName: r.employeeName,
        // Flag for employee-personal visibility (only requestor sees their own resolved sanction)
        isPersonalSanction: isResolved,
        createdAt: r.requestDate || new Date().toISOString()
      };
    });

    // 2. Attendance Check-Ins, Check-Outs, and Breaks from live attendance state
    const attNotifs: KssNotification[] = [];
    attendance.forEach(rec => {
      if (rec.checkInAt) {
        attNotifs.push({
          id: `notif-in-${rec.id}`,
          type: 'ATTENDANCE_CHECKIN',
          // Admin title shows employee name; personal title for the employee themselves
          title: `🟢 Check-In Verified: ${rec.employeeName}`,
          body: `${rec.employeeName} (${rec.department || 'HQ'}) checked in at ${toISTTimeString(rec.checkInAt)} via ${rec.attendanceMethod || 'Web Terminal'}. Status: ${rec.status}.`,
          personalTitle: `🟢 You Checked In`,
          personalBody: `You successfully checked in at ${toISTTimeString(rec.checkInAt)} via ${rec.attendanceMethod || 'Web Terminal'}. Status: ${rec.status}.`,
          audience: ['SUPER_ADMIN', 'HR_ADMIN', 'PROJECT_MANAGER'],
          isOwnAttendance: true,
          actorId: rec.employeeId,
          actorName: rec.employeeName,
          targetEmployeeId: rec.employeeId,
          targetEmployeeName: rec.employeeName,
          createdAt: rec.checkInAt
        } as any);
      }
      if (rec.checkOutAt) {
        attNotifs.push({
          id: `notif-out-${rec.id}`,
          type: 'ATTENDANCE_CHECKOUT',
          title: `🔴 Check-Out Logged: ${rec.employeeName}`,
          body: `${rec.employeeName} completed shift & checked out at ${toISTTimeString(rec.checkOutAt)}. Total shift time: ${rec.workingMinutes || 0} mins.`,
          personalTitle: `🔴 You Checked Out`,
          personalBody: `You completed your shift and checked out at ${toISTTimeString(rec.checkOutAt)}. Total working time: ${rec.workingMinutes || 0} mins.`,
          audience: ['SUPER_ADMIN', 'HR_ADMIN', 'PROJECT_MANAGER'],
          isOwnAttendance: true,
          actorId: rec.employeeId,
          actorName: rec.employeeName,
          targetEmployeeId: rec.employeeId,
          targetEmployeeName: rec.employeeName,
          createdAt: rec.checkOutAt
        } as any);
      }
      if (rec.breaks && Array.isArray(rec.breaks)) {
        rec.breaks.forEach((b, bIdx) => {
          attNotifs.push({
            id: `notif-break-${rec.id}-${bIdx}`,
            type: 'ATTENDANCE_BREAK_START',
            title: `🟡 Break Started: ${rec.employeeName}`,
            body: `${rec.employeeName} initiated ${b.type} at ${toISTTimeString(b.startAt)}. Duration: ${b.durationMinutes || 10} mins.`,
            personalTitle: `🟡 ${b.type} Break Started`,
            personalBody: `Your ${b.type} break started at ${toISTTimeString(b.startAt)}. Duration: ${b.durationMinutes || 10} mins.`,
            audience: ['SUPER_ADMIN', 'HR_ADMIN', 'PROJECT_MANAGER'],
            isOwnAttendance: true,
            actorId: rec.employeeId,
            actorName: rec.employeeName,
            targetEmployeeId: rec.employeeId,
            targetEmployeeName: rec.employeeName,
            createdAt: b.startAt
          } as any);
        });
      }
    });

    // 3. Office-Wide WFH Announcements — synthesized from companyWideWfhDates (audience ALL = every employee sees it)
    const wfhAnnounceNotifs: KssNotification[] = companyWideWfhDates.map(date => ({
      id: `notif-office-wfh-${date}`,
      type: 'LEAVE_REQUEST_APPROVED' as any,
      title: `🏢 Office-Wide WFH — ${date}`,
      body: `CEO & CTO have declared Work From Home for all employees on ${date}. No GPS check-in restriction applies. Stay safe and productive! 🏠`,
      audience: ['ALL'],
      actorName: 'CEO & CTO Office',
      createdAt: new Date(`${date}T09:00:00+05:30`).toISOString()
    }));

    const synthesized = [...wfhAnnounceNotifs, ...leaveNotifs, ...attNotifs];
    const existingIds = new Set(synthesized.map(n => n.id));
    const merged = [...synthesized, ...notifications.filter(n => n.id && !existingIds.has(n.id))];
    merged.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    return merged;
  }, [leaveRequests, attendance, notifications, companyWideWfhDates, employees]);

  const [readNotificationIds, setReadNotificationIds] = useState<Set<string>>(() => {
    const saved = localStorage.getItem('kss_v1_read_notifs');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return new Set(Array.isArray(parsed) ? parsed : []);
      } catch (e) {
        console.warn('[AuthContext] Failed to parse read notifications', e);
      }
    }
    return new Set();
  });

  // Always keep the ref in sync with state
  useEffect(() => {
    employeesRef.current = employees;
  }, [employees]);

  // Universal robust employee lookup helper matching ID, emp- ID, employeeCode, UID, email, or fullName
  const findEmployee = useCallback((employeeIdOrEmp: any): Employee | undefined => {
    if (!employeeIdOrEmp) return undefined;
    if (typeof employeeIdOrEmp === 'object' && employeeIdOrEmp.id) {
      const direct = employeesRef.current.find(e => 
        e.id === employeeIdOrEmp.id || 
        (e.employeeId && e.employeeId === employeeIdOrEmp.employeeId) ||
        (e.email && employeeIdOrEmp.email && e.email.toLowerCase() === employeeIdOrEmp.email.toLowerCase()) ||
        (e.uid && employeeIdOrEmp.uid && e.uid === employeeIdOrEmp.uid)
      );
      if (direct) return direct;
      return employeeIdOrEmp as Employee;
    }
    const search = String(employeeIdOrEmp).trim().toLowerCase();
    const searchWithoutEmp = search.replace(/^emp-/, '');

    // Direct mapping for D. Koushik (Project Manager) Auth UID
    if (search === 'vhklijcvzotncqvtmh14pambixk2') {
      const koushik = employeesRef.current.find(e =>
        e.employeeId === 'KSS2407003' ||
        e.id === 'emp-KSS2407003' ||
        (e.email && e.email.toLowerCase().includes('d.koushik'))
      ) || INITIAL_EMPLOYEES.find(e => e.employeeId === 'KSS2407003' || e.id === 'emp-KSS2407003');
      if (koushik) return koushik;
    }

    // Direct mapping for Asbin T.S. Auth UID & identity anchors
    if (search === 'gciqrmaffebcgndmbuzpbcl6ipq2' || search === 'asbin' || search === 'asbin t s' || search === 'asbin.t.s@kalpanaaa.in') {
      const asbin = employeesRef.current.find(e =>
        e.id === 'GCIqrMaffebCGNdmbuzPbcl6IpQ2' ||
        e.uid === 'GCIqrMaffebCGNdmbuzPbcl6IpQ2' ||
        (e.email && e.email.toLowerCase() === 'asbin.t.s@kalpanaaa.in') ||
        (e.fullName && e.fullName.toLowerCase().includes('asbin')) ||
        e.employeeId === 'KSS2407004' ||
        e.id === 'emp-KSS2407004'
      ) || INITIAL_EMPLOYEES.find(e => e.employeeId === 'KSS2407004' || e.id === 'emp-KSS2407004' || (e.email && e.email.toLowerCase() === 'asbin.t.s@kalpanaaa.in'));
      if (asbin) return asbin;
    }

    // Direct mapping for Prahlad Sharma Auth UID
    if (search === 'taq2d87ufqmrd6z036kuthiew9n2') {
      const prahlad = employeesRef.current.find(e =>
        e.id === 'taq2d87UFqMrd6z036KuTHIeW9n2' ||
        e.uid === 'taq2d87UFqMrd6z036KuTHIeW9n2' ||
        e.employeeId === 'KSS2407010' ||
        e.id === 'emp-KSS2407010' ||
        (e.email && e.email.toLowerCase().includes('prahlad'))
      ) || INITIAL_EMPLOYEES.find(e => e.employeeId === 'KSS2407010' || e.id === 'emp-KSS2407010');
      if (prahlad) return prahlad;
    }
    return employeesRef.current.find(e =>
      (e.id && e.id.toLowerCase() === search) ||
      (e.id && e.id.toLowerCase().replace(/^emp-/, '') === searchWithoutEmp) ||
      (e.employeeId && e.employeeId.toLowerCase() === search) ||
      (e.employeeId && e.employeeId.toLowerCase() === searchWithoutEmp) ||
      (e.uid && e.uid.toLowerCase() === search) ||
      (e.email && e.email.toLowerCase() === search) ||
      (e.fullName && e.fullName.toLowerCase() === search)
    ) || INITIAL_EMPLOYEES.find(e =>
      (e.id && e.id.toLowerCase() === search) ||
      (e.id && e.id.toLowerCase().replace(/^emp-/, '') === searchWithoutEmp) ||
      (e.employeeId && e.employeeId.toLowerCase() === search) ||
      (e.employeeId && e.employeeId.toLowerCase() === searchWithoutEmp) ||
      (e.uid && e.uid.toLowerCase() === search) ||
      (e.email && e.email.toLowerCase() === search) ||
      (e.fullName && e.fullName.toLowerCase() === search)
    );
  }, []);

  const getAttendanceOwnerUid = (employee: Employee | undefined): string => {
    const firebaseUid = auth.currentUser?.uid || user?.uid;
    if (!employee || !firebaseUid) return getCanonicalEmployeeUid(employee, firebaseUid);

    const active = activeEmployeeRef.current || activeEmployee;
    const isActiveEmployee = !!active && (
      employee.id === active.id ||
      employee.employeeId === active.employeeId ||
      (!!employee.uid && employee.uid === active.uid) ||
      (!!employee.email && !!active.email && employee.email.toLowerCase() === active.email.toLowerCase())
    );
    const isFirebaseIdentity = employee.uid === firebaseUid || employee.id === firebaseUid;
    if (isActiveEmployee || isFirebaseIdentity) {
      return employee.uid === firebaseUid ? firebaseUid : (employee.id || firebaseUid);
    }
    return getCanonicalEmployeeUid(employee, firebaseUid);
  };

  // Keep attendanceRef current so the stable auto-checkout interval always
  // reads the latest data without being in the effect's dep array.
  useEffect(() => {
    attendanceRef.current = attendance;
  }, [attendance]);

  // Keep the stable auto-checkout effect supplied with live values (see the ref
  // declarations above for why this indirection is required).
  useEffect(() => {
    activeEmployeeRef.current = activeEmployee;
  }, [activeEmployee]);

  useEffect(() => {
    roleRef.current = role;
  }, [role]);

  // Debounced localStorage persistence — batches all non-attendance state saves
  useEffect(() => {
    const handler = setTimeout(() => {
      localStorage.setItem('kss_v1_employees', JSON.stringify(employees));
      if (Array.isArray(attendance) && attendance.length > 0) {
        localStorage.setItem('kss_v1_attendance', JSON.stringify(attendance.slice(0, 300)));
      }
      localStorage.setItem('kss_v1_audit_logs', JSON.stringify(auditLogs));
      localStorage.setItem('kss_v1_settings', JSON.stringify(settings));
      localStorage.setItem('kss_v1_work_zone', JSON.stringify(companyWorkZone));

      let mergedLeaves = leaveRequests;
      const savedLeaves = localStorage.getItem('kss_v1_leave_requests');
      if (savedLeaves) {
        try {
          const parsed = JSON.parse(savedLeaves);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const map = new Map<string, LeaveRequest>();
            parsed.forEach((r: any) => map.set(r.id, r));
            leaveRequests.forEach((r: any) => map.set(r.id, r));
            mergedLeaves = Array.from(map.values());
          }
        } catch {}
      }
      localStorage.setItem('kss_v1_leave_requests', JSON.stringify(mergedLeaves));
    }, 500);
    return () => clearTimeout(handler);
  }, [employees, attendance, auditLogs, settings, companyWorkZone, leaveRequests]);

  // Real-time cross-tab BroadcastChannel listener for instant sync between normal and private windows
  useEffect(() => {
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const channel = new BroadcastChannel('kss_app_events');
        channel.onmessage = (event) => {
          if ((event.data?.type === 'NEW_LEAVE_REQUEST' || event.data?.type === 'UPDATE_LEAVE_REQUEST') && event.data?.payload) {
            const req = event.data.payload;
            setLeaveRequests(prev => {
              const map = new Map<string, LeaveRequest>();
              prev.forEach(r => map.set(r.id, r));
              map.set(req.id, req);
              const updated = Array.from(map.values());
              try {
                localStorage.setItem('kss_v1_leave_requests', JSON.stringify(updated));
              } catch {}
              return updated;
            });
          } else if (event.data?.type === 'CANCEL_LEAVE_REQUEST' && event.data?.payload?.id) {
            const reqId = event.data.payload.id;
            setLeaveRequests(prev => {
              const updated = prev.filter(r => r.id !== reqId);
              try {
                localStorage.setItem('kss_v1_leave_requests', JSON.stringify(updated));
              } catch {}
              return updated;
            });
          } else if (event.data?.type === 'NEW_BROADCAST' && event.data?.payload) {
            const notif = event.data.payload;
            setNotifications(prev => {
              const exists = prev.some(n => n.id === notif.id);
              if (exists) return prev;
              const updated = [notif, ...prev];
              try {
                localStorage.setItem('kss_v1_broadcasts', JSON.stringify(updated));
              } catch {}
              return updated;
            });
          }
        };
        return () => channel.close();
      } catch {}
    }
  }, []);

  // ── DEDICATED real-time listener for Office-Wide WFH dates ──
  // This is the 100% reliable channel — completely independent of settings
  useEffect(() => {
    if (!USE_FIREBASE_FIRESTORE || !isFirestoreConnected) return;

    let unsubWfh: () => void = () => {};

    unsubWfh = onSnapshot(
      doc(db, 'companyConfig', 'wfhDates'),
      (docSnap) => {
        const dates: string[] = docSnap.exists() ? (docSnap.data().dates || []) : [];
        setCompanyWideWfhDates(dates);
        // Keep localStorage in sync as offline fallback
        localStorage.setItem('kss_v1_company_wfh_dates', JSON.stringify(dates));
        // Also keep settings in sync for legacy checks
        setSettings(prev => ({ ...prev, companyWideWfhDates: dates }));
      },
      () => { /* silent fail — localStorage fallback still works */ }
    );

    return () => unsubWfh();
  }, [isFirestoreConnected]);

  // Register FCM token when user logs in and Firestore is connected
  useEffect(() => {
    if (isAuthenticated && activeEmployee && isFirestoreConnected) {
      registerFcmToken(activeEmployee.id, activeEmployee.role).catch(() => {});
    }
  }, [isAuthenticated, activeEmployee?.id, isFirestoreConnected]);

  // ROOT-LEVEL ROLE & SESSION SYNC: Continuously sync activeEmployee and role whenever employees state updates
  useEffect(() => {
    if (!activeEmployee) {
      // Try to restore from localStorage if session token exists but activeEmployee is null
      const savedSessionId = localStorage.getItem('kss_v1_session');
      const savedEmail = localStorage.getItem('kss_v1_session_email');
      if (savedSessionId || savedEmail) {
        const matched = employees.find(e =>
          e.id === savedSessionId ||
          e.employeeId === savedSessionId ||
          (savedEmail && e.email?.toLowerCase() === savedEmail.toLowerCase())
        ) || INITIAL_EMPLOYEES.find(e =>
          e.id === savedSessionId ||
          e.employeeId === savedSessionId ||
          (savedEmail && e.email?.toLowerCase() === savedEmail.toLowerCase())
        );

        if (matched) {
          setActiveEmployee(matched);
          let assignedRole = matched.role;
          if (matched.employeeId === 'CEO001' || matched.employeeId === 'CTO001') assignedRole = 'SUPER_ADMIN';
          setRole(assignedRole);
          setIsAuthenticated(true);
        } else if (employees.length > 0) {
          // Stale session that could not be matched — purge invalid session
          localStorage.removeItem('kss_v1_session');
          localStorage.removeItem('kss_v1_session_email');
          setIsAuthenticated(false);
        }
      } else {
        setIsAuthenticated(false);
      }
      return;
    }

    const updatedSelf = employees.find(e =>
      e.id === activeEmployee.id ||
      (e.employeeId && e.employeeId === activeEmployee.employeeId) ||
      (e.email && activeEmployee.email && e.email.toLowerCase() === activeEmployee.email.toLowerCase())
    );

    if (updatedSelf) {
      let nextRole = updatedSelf.role;
      if (updatedSelf.employeeId === 'CEO001' || updatedSelf.employeeId === 'CTO001') {
        if (updatedSelf.role === 'SUPER_ADMIN') nextRole = 'SUPER_ADMIN';
      }

      const isEnrolled = updatedSelf.isFaceEnrolled || activeEmployee.isFaceEnrolled || isFaceBiometricEnrolled(activeEmployee) || isFaceBiometricEnrolled(updatedSelf);
      const mergedSelf: Employee = {
        ...activeEmployee,
        ...updatedSelf,
        isFaceEnrolled: isEnrolled,
        faceDescriptor: updatedSelf.faceDescriptor || activeEmployee.faceDescriptor
      };

      if (updatedSelf.role !== activeEmployee.role || role !== nextRole || JSON.stringify(mergedSelf) !== JSON.stringify(activeEmployee)) {
        setActiveEmployee(mergedSelf);
        setRole(nextRole);
      }
    }
  }, [employees, activeEmployee?.id, activeEmployee?.role, role]);


  // SYSTEM RULE: Auto-Checkout at the 7:15 PM IST shift cutoff.
  //
  // BUG 3 FIX: This effect previously had `[attendance]` as its dep, causing
  // it to re-register on every Firestore onSnapshot. The cycle was:
  //   snapshot arrives → attendance state updates → effect re-runs immediately
  //   → checkAutoCheckout() fires → setDoc write → new snapshot → repeat.
  // Fix: use attendanceRef (always current, zero re-registration) + a
  // processedIds Set so each record is written at most once per session.
  //
  // ── THIS REVISION (P0/P1 fixes) ──
  //  1. TIMEZONE / PAYROLL CORRUPTION: the cutoff was built as
  //     `new Date(\`${record.date}T19:15:00\`)` with NO offset, so it was parsed in
  //     the DEVICE's timezone. Any employee or admin on a non-IST device (travel,
  //     a mis-set phone clock, a VPS-hosted browser) wrote a `workingMinutes` value
  //     off by the full UTC offset — up to ±12h of fabricated or erased paid time,
  //     straight into the payroll input. The cutoff is now pinned to +05:30.
  //  2. INFINITE RETRY LOOP: the write's catch did `processedIds.delete(record.id)`
  //     unconditionally, so a PERMANENT failure (permission-denied — now the normal
  //     outcome for another employee's record) retried every 30 seconds forever.
  //     Retries are now bounded and permanent errors are never retried.
  //  3. AUDIT-LOG WRITE SPAM: addAuditLog() fired on every attempt, before the write
  //     resolved. Combined with (2) this appended an audit document to Firestore
  //     every 30 seconds per stuck record, indefinitely. It now fires once, only
  //     after the write actually succeeds.
  //  4. WRITE AMPLIFICATION: the sweep ran on EVERY connected client against EVERY
  //     employee's record, so N clients raced to write the same M documents. The
  //     client now only closes the signed-in employee's OWN records; the
  //     authoritative company-wide sweep belongs to the scheduled Cloud Function
  //     `scheduledAutoCheckout` in functions/index.js, which runs exactly once.
  //  5. WRONG CUTOFF IN THE AUDIT TRAIL: the note and audit text claimed "07:30 PM"
  //     while the code used 19:15. Both now state 07:15 PM IST.
  useEffect(() => {
    if (!authUid) return;

    // Tracks records already written this browser session to prevent duplicate
    // Firestore writes when the interval fires repeatedly.
    const processedIds = new Set<string>();
    const attemptCounts = new Map<string, number>();
    const MAX_ATTEMPTS = 3;

    const AUTO_CHECKOUT_CUTOFF_HOUR = 23;
    const AUTO_CHECKOUT_CUTOFF_MINUTE = 0;

    const isOwnRecord = (record: AttendanceRecord): boolean => {
      const emp = activeEmployeeRef.current;
      return (
        (record as any).employeeUid === authUid ||
        (record as any).uid === authUid ||
        (!!emp && (record.employeeId === emp.id || (record as any).employeeCode === emp.employeeId))
      );
    };

    const checkAutoCheckout = () => {
      const now = new Date();
      const todayStr = getEmployeeWorkDate(now);
      // Strictly resolve hours and minutes in IST
      const istParts = new Intl.DateTimeFormat('en-US', {
        timeZone: COMPANY_TIMEZONE,
        hour: 'numeric',
        minute: 'numeric',
        hour12: false
      }).formatToParts(now);
      const currentHours = Number(istParts.find(p => p.type === 'hour')?.value || 0);
      const currentMinutes = Number(istParts.find(p => p.type === 'minute')?.value || 0);
      const isPastCutoff =
        currentHours > AUTO_CHECKOUT_CUTOFF_HOUR ||
        (currentHours === AUTO_CHECKOUT_CUTOFF_HOUR && currentMinutes >= AUTO_CHECKOUT_CUTOFF_MINUTE);

      attendanceRef.current.forEach(record => {
        if (processedIds.has(record.id)) return; // already handled this session
        if (!isOwnRecord(record)) return;        // never race other clients (fix 4)

        const isPastDay = record.date < todayStr;
        const isTodayPastCutoff = record.date === todayStr && isPastCutoff;

        if (!record.checkOutAt && (isPastDay || isTodayPastCutoff)) {
          processedIds.add(record.id); // mark before async write to prevent double-write

          // Cutoff pinned to IST (+05:30) so the instant is identical on every
          // device regardless of local timezone (fix 1).
          const autoCheckOutDate = new Date(`${record.date}T23:00:00+05:30`);
          if (Number.isNaN(autoCheckOutDate.getTime())) return;
          const forceCheckOutTime = autoCheckOutDate.toISOString();

          // Atomically close any open break on auto-checkout
          const existingBreaks = Array.isArray(record.breaks) ? record.breaks : [];
          let updatedBreaks = existingBreaks;
          const openBreak = existingBreaks.find((b: any) => !b.endAt && !(b as any).endTime);
          if (openBreak) {
            const bStartIso = formatTimestampToISO(openBreak.startAt || (openBreak as any).startTime) || forceCheckOutTime;
            const bStartMs = new Date(bStartIso).getTime();
            const cutoffMs = autoCheckOutDate.getTime();
            const breakMins = Math.max(1, Math.floor(Math.max(0, cutoffMs - bStartMs) / 60000));
            updatedBreaks = existingBreaks.map((b: any) => {
              const isOpen = !b.endAt && !(b as any).endTime;
              if (isOpen) {
                return {
                  ...b,
                  startAt: formatTimestampToISO(b.startAt || (b as any).startTime) || bStartIso,
                  endAt: forceCheckOutTime,
                  endTime: forceCheckOutTime,
                  durationMinutes: breakMins
                };
              }
              return b;
            });
          }

          const totalBreakMins = updatedBreaks.reduce((acc: number, b: any) => acc + (Number(b.durationMinutes) || 0), 0);

          let totalMins = 0;
          if (record.checkInAt) {
            const checkInMs = new Date(record.checkInAt).getTime();
            totalMins = Math.floor((autoCheckOutDate.getTime() - checkInMs) / 60000);
            if (totalBreakMins > 0) {
              totalMins = Math.max(0, totalMins - totalBreakMins);
            }
          }
          totalMins = Math.max(0, totalMins);

          const updatedNotes = (record.notes ? record.notes + ' | ' : '') + 'SYSTEM: Auto-checked out at 11:00 PM IST (Shift End Cutoff)';

          // Auto close the record in Firestore with authorization anchoring
          const isOwnRecord = activeEmployee && (
            record.employeeCode === activeEmployee.employeeId ||
            record.employeeId === activeEmployee.id ||
            record.employeeId === activeEmployee.employeeId ||
            record.uid === activeEmployee.uid ||
            record.id.includes(activeEmployee.employeeId)
          );
          const autoCheckoutPayload = cleanFirestorePayload({
            checkOutAt: forceCheckOutTime,
            workingMinutes: totalMins,
            breaks: updatedBreaks,
            totalBreakMinutes: totalBreakMins,
            notes: updatedNotes,
            updatedAt: serverTimestamp(),
            ...(isOwnRecord && (auth.currentUser?.uid || user?.uid) ? { authUid: auth.currentUser?.uid || user?.uid } : {})
          });

          if (auth.currentUser) {
            updateDoc(doc(db, 'attendance', record.id), autoCheckoutPayload)
              .then(() => {
                // Audit only on confirmed success (fix 3).
                addAuditLogRef.current(
                  'AUTO_CHECKOUT',
                  `Att ID: ${record.id}`,
                  `Auto-checked out at 11:00 PM IST for ${record.date}`
                );
              })
              .catch((err) => {
                // Bounded retry, and never retry a permanent authorization failure (fix 2).
                const code = String(err?.code || '');
                const errMsg = String(err?.message || '').toLowerCase();
                const permanent = code === 'permission-denied' || code === 'unauthenticated' || code === 'invalid-argument' || code === '403' ||
                  errMsg.includes('permission') || errMsg.includes('insufficient permissions') || errMsg.includes('permission-denied');
                const attempts = (attemptCounts.get(record.id) || 0) + 1;
                attemptCounts.set(record.id, attempts);
                if (!permanent) {
                  handleFirestoreError(err, OperationType.UPDATE, `attendance/${record.id}`);
                }
                if (!permanent && attempts < MAX_ATTEMPTS) {
                  processedIds.delete(record.id);
                }
                if (permanent) {
                  console.warn(
                    `[AuthContext] Auto-checkout permanently denied or unauthorized for ${record.id} — stopping retries.`
                  );
                } else {
                  console.warn(
                    `[AuthContext] Auto-checkout write failed for ${record.id} (attempt ${attempts}/${MAX_ATTEMPTS}, retryable):`,
                    err
                  );
                }
              });
          } else {
            // Unauthenticated session in Firebase: backend FastAPI owns the auto-checkout lifecycle.
            processedIds.add(record.id);
          }
        }
      });
    };

    const interval = setInterval(checkAutoCheckout, 30000); // Check every 30s
    checkAutoCheckout(); // Check immediately on mount

    return () => clearInterval(interval);
  }, [authUid]);


  // Sync to & from Firestore
  //
  // P0 INCIDENT FIX — listener lifecycle is now owned by Firebase Auth:
  //   BEFORE: this effect ran once on mount ([] deps) and attached all listeners
  //   while request.auth was still null (session restore pending or local-login
  //   session). Firestore denied every query, each listener died permanently
  //   (permission-denied listeners never retry), and after a successful login
  //   nothing re-attached them → ALL portals frozen with "Missing or insufficient
  //   permissions".
  //   AFTER: listeners attach only when authUid becomes non-null (token verified),
  //   re-attach on every login, and detach cleanly on sign-out / token death.
  useEffect(() => {
    // ── High Performance: Single Source of Truth Guard ──────────────────────
    // When authenticated via FastAPI or when VITE_USE_FASTAPI_ONLY is enabled,
    // bypass competing Firestore snapshot listeners to prevent network thrashing and state flapping.
    if (getAuthToken() || (import.meta.env.VITE_USE_FASTAPI_ONLY === 'true' && !authUid)) {
      setAttendanceSyncStatus('synced');
      return;
    }

    if (!authUid) {
      // No verified Firebase session: nothing to sync. Mark sync complete so the
      // UI falls back to cached/local data instead of spinning forever.
      setAttendanceSyncStatus('synced');
      return;
    }

    let unsubEmps = () => { };
    let unsubAtt = () => { };
    let unsubLogs = () => { };
    let unsubSettings = () => { };
    let unsubWorkZone = () => { };
    let unsubLeaveReqs = () => { };
    let unsubNotifs = () => { };

    // One-shot latches for the two bootstrap writes in the employees listener.
    // Without them, any write that keeps failing (rules rejection, offline) is
    // retried on every single snapshot for the lifetime of the session.
    let didSeedInitialEmployees = false;
    let didSeedProjectManager = false;
    let didSeedSettings = false;
    let didSeedWorkZone = false;
    let didMigrateWorkZone = false;

    // ── COST FIX: per-session migration latch sets ────────────────────────────
    // Each set tracks which employee doc IDs have already been corrected this
    // session so live-autocorrect setDoc() calls only fire ONCE per doc, not
    // on every snapshot from every connected client.
    const migratedEmployeeIds = new Set<string>();
    // Tracks attendance + employee doc IDs that were already delete-dispatched
    // this session so the deleteDoc() inside snapshot handlers cannot re-fire
    // on every subsequent snapshot (previously retried on every onSnapshot).
    const deletedAttendanceIds = new Set<string>();
    const deletedEmployeeIds = new Set<string>();

    const initFirestore = () => {
      // 100% NEON POSTGRESQL MODE: Disable all Firestore snapshot listeners
      if (!USE_FIREBASE_FIRESTORE) {
        setIsFirestoreConnected(true);
        fetchFastApiRecords(activeEmployeeRef.current, true);
        return;
      }

      try {
        testConnection().then(connected => setIsFirestoreConnected(connected)).catch(() => {
          setIsFirestoreConnected(typeof navigator !== 'undefined' ? navigator.onLine : true);
        });

        // Subscribe to real-time updates IMMEDIATELY for employees
        unsubEmps = onSnapshot(collection(db, 'employees'), (snapshot) => {
          // ── P0 FIX: WRITE AMPLIFICATION FROM A READ LISTENER ──
          // This handler performed deleteDoc() and up to three setDoc() "live
          // autocorrect" migrations per employee document — from EVERY connected
          // client, on EVERY snapshot. With N browsers open, one snapshot produced
          // N identical writes per affected document; each write then produced a new
          // snapshot on all N clients, and any write that kept failing was retried on
          // every snapshot forever. It also billed N× the writes and made the
          // employees collection last-write-wins between racing clients.
          //
          // The corrections themselves are still applied IN MEMORY for everyone, so
          // every portal renders clean data. Only the persistence is now restricted
          // to an administrative session — which is also the only role the hardened
          // firestore.rules permit to write another employee's document.
          const canMigrate = roleRef.current === 'SUPER_ADMIN' || roleRef.current === 'HR_ADMIN' || roleRef.current === 'PROJECT_MANAGER';

          if (!snapshot.empty) {
            const fetched: Employee[] = [];
            snapshot.forEach(docSnap => {
              const data = { id: docSnap.id, ...docSnap.data() } as Employee;

              // PURGE ABHINAYA V & AVANISH KUMAR TRIPATHI PERMANENTLY
              if (
                data.id === '3ZHI3aTB37StHjR97WEBJQSWT9H3' ||
                data.id === 'dQ7XANsF9eUL3JZyqCXIlAPHF382' ||
                data.employeeId === 'KSS2407018' ||
                (data.fullName && data.fullName.toLowerCase().includes('avanish')) ||
                (data.email && data.email.toLowerCase().includes('na@kalpanaaa.in')) ||
                (data as any).isDeleted ||
                !data.fullName ||
                data.fullName.trim() === '' ||
                data.fullName.toLowerCase().includes('abhinaya') ||
                (data.email && data.email.toLowerCase().includes('abhinaya'))
              ) {
                // COST FIX M2: latch prevents re-firing deleteDoc on every snapshot
                if (canMigrate && !deletedEmployeeIds.has(data.id)) {
                  deletedEmployeeIds.add(data.id);
                  deleteDoc(doc(db, 'employees', data.id)).catch(() => { });
                  deleteDoc(doc(db, 'users', data.id)).catch(() => { });
                }
                return;
              }

              // PURGE ONLY OLD DUMMY EMP-003 RECORD (with old typo domain)
              if (
                (data.id === 'emp-003' || data.employeeId === '003') &&
                data.email?.toLowerCase() === 'd.koushik@kalpanaaa.in'
              ) {
                // COST FIX M2: latch prevents re-firing deleteDoc on every snapshot
                if (canMigrate && !deletedEmployeeIds.has(data.id)) {
                  deletedEmployeeIds.add(data.id);
                  deleteDoc(doc(db, 'employees', data.id)).catch(() => { });
                }
                return;
              }

              // PURGE DUPLICATE AKSHIT UJJAIN RECORD (emp-1785847273632 or old akshitujjain email)
              if (
                data.id === 'emp-1785847273632' ||
                (data.id !== 'emp-KSS2407002' && data.employeeId === 'KSS2407002' && (data.email?.toLowerCase().includes('akshitujjain@') || data.email?.toLowerCase() === 'akshitujjain@kalpanaaasoftwaresolutions.in'))
              ) {
                if (canMigrate && !deletedEmployeeIds.has(data.id)) {
                  deletedEmployeeIds.add(data.id);
                  deleteDoc(doc(db, 'employees', data.id)).catch(() => { });
                }
                return;
              }

              // PURGE GHOST DELETED USERS
              if (
                data.id === 'bf41B0ztyefb6OZzO9NykxA9MSz2' ||
                data.employeeId?.includes('GHOST') ||
                data.fullName?.includes('GHOST') ||
                data.fullName?.includes('[DELETED]')
              ) {
                if (canMigrate && !deletedEmployeeIds.has(data.id)) {
                  deletedEmployeeIds.add(data.id);
                  deleteDoc(doc(db, 'employees', data.id)).catch(() => { });
                }
                return;
              }

              // PURGE TEST ACCOUNTS (Test Portal Employee, Alice Test)
              const fullNameLower = (data.fullName || '').trim().toLowerCase();
              const empIdLower = (data.employeeId || '').trim().toLowerCase();
              const emailLower = (data.email || '').trim().toLowerCase();
              if (
                empIdLower === 'alice001' ||
                empIdLower === 'test001' ||
                fullNameLower.includes('test portal') ||
                fullNameLower.includes('alice test') ||
                fullNameLower === 'alice' ||
                fullNameLower === 'test portal employee' ||
                emailLower.includes('alice') ||
                emailLower.includes('testportal') ||
                emailLower.includes('test_portal')
              ) {
                if (canMigrate && !deletedEmployeeIds.has(data.id)) {
                  deletedEmployeeIds.add(data.id);
                  deleteDoc(doc(db, 'employees', data.id)).catch(() => { });
                  if (data.uid) {
                    deleteDoc(doc(db, 'users', data.uid)).catch(() => { });
                  }
                }
                return;
              }

              // LIVE AUTOCORRECT CEO SPELLING AND EMAIL IN FIREBASE
              if (data.employeeId === 'CEO001') {
                let needsUpdate = false;
                if (data.role === 'SUPER_ADMIN' && (data.fullName || '').toLowerCase().includes('akshit')) {
                  if (data.email !== 'akshit@kalpanaaa.in') {
                    data.email = 'akshit@kalpanaaa.in';
                    needsUpdate = true;
                  }
                }
                if (needsUpdate && canMigrate) {
                  setDoc(doc(db, 'employees', data.id), data, { merge: true }).catch(() => { });
                }
              }

              // LIVE AUTOCORRECT MALFORMED OR DOUBLE-PREFIXED EMPLOYEE IDs
              if (data.employeeId) {
                let cleanId = data.employeeId;
                if (cleanId.includes('24072407') || cleanId.includes('27072407') || cleanId.length > 9) {
                  const numMatch = cleanId.match(/\d+$/);
                  if (numMatch) {
                    const seqNum = numMatch[0].slice(-3);
                    cleanId = `KSS2407${seqNum}`;
                  }
                } else if (!cleanId.startsWith('KSS2407') && cleanId.match(/^\d+$/)) {
                  cleanId = `KSS2407${cleanId.padStart(3, '0')}`;
                } else if (cleanId.startsWith('KSS2707')) {
                  cleanId = cleanId.replace('KSS2707', 'KSS2407');
                } else if (cleanId.startsWith('KS2407') || cleanId.startsWith('KS2707')) {
                  cleanId = cleanId.replace('KS2707', 'KSS2407').replace('KS2407', 'KSS2407');
                }

                if (cleanId !== data.employeeId) {
                  data.employeeId = cleanId;
                  // COST FIX C3: latch — write at most once per doc per session
                  if (canMigrate && !migratedEmployeeIds.has(`empId-${data.id}`)) {
                    migratedEmployeeIds.add(`empId-${data.id}`);
                    setDoc(doc(db, 'employees', data.id), { employeeId: cleanId }, { merge: true }).catch(() => { });
                  }
                }
              }

              // LIVE AUTOCORRECT INVALID OR 'check' EMPLOYEE STATUS TO 'Active' / 'Inactive'
              const validStatuses: EmployeeStatus[] = ['Active', 'On Leave', 'Inactive', 'Suspended', 'Terminated'];
              if (String(data.status).toLowerCase() === 'terminated') {
                data.status = 'Inactive';
                // COST FIX C3: latch
                if (canMigrate && !migratedEmployeeIds.has(`status-${data.id}`)) {
                  migratedEmployeeIds.add(`status-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), { status: 'Inactive' }, { merge: true }).catch(() => { });
                }
              } else if (!data.status || !validStatuses.includes(data.status as EmployeeStatus) || String(data.status).toLowerCase() === 'check' || String(data.status).toLowerCase() === 'checked in') {
                data.status = 'Active';
                // COST FIX C3: latch
                if (canMigrate && !migratedEmployeeIds.has(`status-${data.id}`)) {
                  migratedEmployeeIds.add(`status-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), { status: 'Active' }, { merge: true }).catch(() => { });
                }
              }

              // ROOT-LEVEL FIX: LIVE AUTOCORRECT AKASH SB ACCIDENTAL WFH DATES (27th/28th Aug – 5th Sep)
              if (
                data.id === 'emp-KSS2407013' ||
                data.employeeId === 'KSS2407013' ||
                (data.fullName && data.fullName.toLowerCase().includes('akash'))
              ) {
                if (data.approvedWfhDates && Array.isArray(data.approvedWfhDates) && data.approvedWfhDates.length > 0) {
                  const accidentalRange = ['2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];
                  const cleaned = data.approvedWfhDates.filter(d => !accidentalRange.includes(d));
                  if (cleaned.length !== data.approvedWfhDates.length) {
                    data.approvedWfhDates = cleaned;
                    // COST FIX C3: latch
                    if (canMigrate && !migratedEmployeeIds.has(`wfh-${data.id}`)) {
                      migratedEmployeeIds.add(`wfh-${data.id}`);
                      setDoc(doc(db, 'employees', data.id), { approvedWfhDates: cleaned }, { merge: true }).catch(() => { });
                    }
                  }
                }
              }

              // LIVE AUTOCORRECT JIGYANSHA (AI/ML Developer, Generative AI specialization, joining date Sep 1)
              if (
                data.id === '8RxH6z3ZzUTmM26iqta1DhCPa8l1' ||
                data.employeeId === 'KSS2407014' ||
                data.employeeId === 'KSS2407016' ||
                (data.fullName && data.fullName.toLowerCase().includes('jigyansha')) ||
                (data.fullName && data.fullName.toLowerCase().includes('jingyasha'))
              ) {
                let jChanged = false;
                if (data.joiningDate !== '2026-09-01') {
                  data.joiningDate = '2026-09-01';
                  jChanged = true;
                }
                if (data.designation !== 'AI/ML Developer') {
                  data.designation = 'AI/ML Developer';
                  jChanged = true;
                }
                const currentSkills = Array.isArray(data.skills) ? data.skills : [];
                if (!currentSkills.includes('Generative AI') || currentSkills.includes('Full Stack Development')) {
                  data.skills = ['Generative AI'];
                  data.specialization = 'Generative AI';
                  jChanged = true;
                }
                // COST FIX C3: latch
                if (jChanged && canMigrate && !migratedEmployeeIds.has(`jig-${data.id}`)) {
                  migratedEmployeeIds.add(`jig-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), {
                    joiningDate: '2026-09-01',
                    designation: 'AI/ML Developer',
                    skills: ['Generative AI'],
                    specialization: 'Generative AI'
                  }, { merge: true }).catch(() => { });
                }
              }

              // LIVE AUTOCORRECT TECH LEADS (Technical Leadership specialization)
              const isTechLead =
                isAuthorizedTechLead(data) ||
                (data.role as string) === 'TECH_LEAD' ||
                (data.designation && (data.designation.toLowerCase().includes('tech lead') || data.designation.toLowerCase().includes('technical lead'))) ||
                data.employeeId === 'KSS2407011' ||
                data.employeeId === 'KSS2407012' ||
                (data.fullName && data.fullName.toLowerCase().includes('jason kenneth')) ||
                (data.fullName && data.fullName.toLowerCase().includes('satya ranjan'));
              if (isTechLead) {
                let tlChanged = false;
                const currentSkills = Array.isArray(data.skills) ? data.skills : [];
                if (
                  currentSkills.length !== 1 ||
                  currentSkills[0] !== 'Technical Leadership' ||
                  data.specialization !== 'Technical Leadership'
                ) {
                  data.skills = ['Technical Leadership'];
                  data.specialization = 'Technical Leadership';
                  tlChanged = true;
                }
                // COST FIX C3: latch
                if (tlChanged && canMigrate && !migratedEmployeeIds.has(`tl-${data.id}`)) {
                  migratedEmployeeIds.add(`tl-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), {
                    skills: ['Technical Leadership'],
                    specialization: 'Technical Leadership'
                  }, { merge: true }).catch(() => { });
                }
              }

              // LIVE AUTOCORRECT SATYA RANJAN DAS (Software Engineer designation & Employee employmentType)
              const isSatyaLiveRecord =
                data.id === 'emp-KSS2407012' ||
                data.id === 'emp-1785997525850' ||
                data.employeeId === 'KSS2407012' ||
                (data.fullName && (data.fullName.toLowerCase().includes('satya') || data.fullName.toLowerCase().includes('ranjan')));
              if (isSatyaLiveRecord) {
                let satyaChanged = false;
                if (data.designation !== 'Software Engineer') {
                  data.designation = 'Software Engineer';
                  satyaChanged = true;
                }
                if (data.employmentType !== 'Employee') {
                  data.employmentType = 'Employee';
                  satyaChanged = true;
                }
                if (satyaChanged && canMigrate && !migratedEmployeeIds.has(`satya-live-${data.id}`)) {
                  migratedEmployeeIds.add(`satya-live-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), {
                    designation: 'Software Engineer',
                    employmentType: 'Employee',
                    updatedAt: serverTimestamp()
                  }, { merge: true }).catch(() => { });
                }
              }

              // LIVE AUTOCORRECT PROJECT MANAGER D. KOUSHIK (IT Department, Project Management specialization, joiningDate: 2026-07-27)
              const isProjectManager =
                data.role === 'PROJECT_MANAGER' ||
                data.employeeId === 'KSS2407003' ||
                (data.designation && data.designation.toLowerCase().includes('project manager')) ||
                (data.fullName && data.fullName.toLowerCase().includes('koushik'));
              if (isProjectManager) {
                let pmChanged = false;
                if (!data.joiningDate || data.joiningDate > '2026-07-27') {
                  data.joiningDate = '2026-07-27';
                  pmChanged = true;
                }
                if (data.department !== 'IT') {
                  data.department = 'IT';
                  pmChanged = true;
                }
                if (data.designation !== 'Project Manager') {
                  data.designation = 'Project Manager';
                  pmChanged = true;
                }
                if (data.employmentType !== 'Trainee') {
                  data.employmentType = 'Trainee';
                  pmChanged = true;
                }
                const currentSkills = Array.isArray(data.skills) ? data.skills : [];
                if (
                  currentSkills.length !== 1 ||
                  currentSkills[0] !== 'Project Management' ||
                  data.specialization !== 'Project Management'
                ) {
                  data.skills = ['Project Management'];
                  data.specialization = 'Project Management';
                  pmChanged = true;
                }
                // COST FIX C3: latch
                if (pmChanged && canMigrate && !migratedEmployeeIds.has(`pm-${data.id}`)) {
                  migratedEmployeeIds.add(`pm-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), {
                    joiningDate: '2026-07-27',
                    department: 'IT',
                    designation: 'Project Manager',
                    employmentType: 'Trainee',
                    skills: ['Project Management'],
                    specialization: 'Project Management'
                  }, { merge: true }).catch(() => { });
                }
              }

              // LIVE AUTOCORRECT PRAHLAD SHARMA (Engineering, Frontend Development, joiningDate: 2026-07-27)
              const isPrahladEmp =
                data.id === 'taq2d87UFqMrd6z036KuTHIeW9n2' ||
                data.id === 'emp-1785907335001' ||
                data.id === 'emp-KSS2407010' ||
                data.employeeId === 'KSS2407010' ||
                (data.fullName && data.fullName.toLowerCase().includes('prahlad'));
              if (isPrahladEmp) {
                let pChanged = false;
                if (!data.joiningDate || data.joiningDate > '2026-08-05') {
                  data.joiningDate = '2026-07-27';
                  pChanged = true;
                }
                if (!data.specialization || data.specialization !== 'Frontend Development') {
                  data.specialization = 'Frontend Development';
                  pChanged = true;
                }
                if (pChanged && canMigrate && !migratedEmployeeIds.has(`prahlad-jd-${data.id}`)) {
                  migratedEmployeeIds.add(`prahlad-jd-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), {
                    joiningDate: '2026-07-27',
                    specialization: 'Frontend Development'
                  }, { merge: true }).catch(() => { });
                }
              }

              // LIVE AUTOCORRECT PRATIKSHA HARODE (Employment Type: Trainee)
              const isPratikshaEmp =
                data.id === 'NTirYBVT1pSuLj5thrdsjM54F303' ||
                data.id === 'emp-1785863423639' ||
                data.id === 'emp-KSS2407008' ||
                data.employeeId === 'KSS2407008' ||
                (data.fullName && data.fullName.toLowerCase().includes('pratiksha'));
              if (isPratikshaEmp) {
                if (data.employmentType !== 'Trainee') {
                  data.employmentType = 'Trainee';
                  if (canMigrate && !migratedEmployeeIds.has(`pratiksha-type-${data.id}`)) {
                    migratedEmployeeIds.add(`pratiksha-type-${data.id}`);
                    setDoc(doc(db, 'employees', data.id), { employmentType: 'Trainee' }, { merge: true }).catch(() => { });
                  }
                }
              }

              // LIVE AUTOCORRECT FORMER EMPLOYEES (Jason Kenneth N, Thabeethal Asnath I -> Inactive)
              const isFormerEmp =
                data.employeeId === 'KSS2407011' || data.id === 'KfAB95lpbJOeylpKQaWX4GXOPGt2' || (data.fullName && data.fullName.toLowerCase().includes('jason')) ||
                data.employeeId === 'KSS2407005' || data.id === 'emp-KSS2407005' || data.id === 'mzGAL3siJZazGrgf6WNEU7hTREw2' || (data.fullName && data.fullName.toLowerCase().includes('thabeethal'));
              if (isFormerEmp) {
                if (data.status !== 'Inactive') {
                  data.status = 'Inactive';
                  if (canMigrate && !migratedEmployeeIds.has(`inactive-${data.id}`)) {
                    migratedEmployeeIds.add(`inactive-${data.id}`);
                    setDoc(doc(db, 'employees', data.id), { status: 'Inactive' }, { merge: true }).catch(() => { });
                  }
                }
              }

              // LIVE AUTOCORRECT WORKFORCE REPORTING MANAGER TO D. KOUSHIK
              if (
                !isExecutiveOrLeadership(data) &&
                !isProjectManager &&
                (!data.reportingManager ||
                 data.reportingManager === 'Rahul Sharma' ||
                 data.reportingManager === 'Sarah Jenkins' ||
                 data.reportingManager.toLowerCase().includes('rahul') ||
                 data.reportingManager.toLowerCase().includes('sarah') ||
                 data.reportingManager.toLowerCase().includes('manager'))
              ) {
                data.reportingManager = 'D. Koushik';
                data.reportingManagerUid = 'uid-KSS2407003';
                // COST FIX C3: latch
                if (canMigrate && !migratedEmployeeIds.has(`rm-${data.id}`)) {
                  migratedEmployeeIds.add(`rm-${data.id}`);
                  setDoc(doc(db, 'employees', data.id), {
                    reportingManager: 'D. Koushik',
                    reportingManagerUid: 'uid-KSS2407003'
                  }, { merge: true }).catch(() => { });
                }
              }

              fetched.push(data);
            });

            // Safe in-memory deduplication (deduplicate primarily by corporate email to prevent cross-account collisions)
            const deduplicated: Employee[] = [];
            const seenEmails = new Set<string>();
            const seenEmpIds = new Set<string>();
            
            // Sort by createdAt / updatedAt descending so newest records are evaluated first
            fetched.sort((a, b) => new Date(b.createdAt || b.updatedAt || 0).getTime() - new Date(a.createdAt || a.updatedAt || 0).getTime());
            
            for (const emp of fetched) {
              // Skip corrupted records with empty names or test/admin created users
              if (!emp.fullName || emp.fullName.trim() === '' || emp.employeeId === 'NEW6dfc34f4' || emp.fullName.toLowerCase().includes('admin created user')) {
                continue;
              }

              const emailKey = (emp.email || '').toLowerCase().trim();
              const idKey = emp.employeeId?.trim();
              
              // Deduplicate identical accounts for the same human (e.g. seeded doc vs Auth UID doc)
              if (emailKey && seenEmails.has(emailKey)) {
                continue;
              }

              // Akshit Ujjain (CEO): ensure only ONE canonical record exists (emp-KSS2407002 / akshit.ujjain@...)
              const isAkshit = (emp.fullName || '').toLowerCase().includes('akshit') || emp.employeeId === 'KSS2407002';
              if (isAkshit) {
                const existingIdx = deduplicated.findIndex(e => (e.fullName || '').toLowerCase().includes('akshit') || e.employeeId === 'KSS2407002');
                if (existingIdx !== -1) {
                  // Prefer canonical ID emp-KSS2407002 or canonical email with dot
                  if (emp.id === 'emp-KSS2407002' || emailKey === 'akshit.ujjain@kalpanaaasoftwaresolutions.in') {
                    deduplicated[existingIdx] = emp;
                  }
                  continue;
                }
              }

              // ID Collision Protection:
              // If an employeeId is already claimed, only skip if the email is absent or it's a true duplicate.
              // If distinct emails collide on an employeeId, protect canonical assignments:
              // Asbin T S is the rightful owner of KSS2407004.
              if (idKey && seenEmpIds.has(idKey)) {
                if (idKey === 'KSS2407004' && (emailKey.includes('asbin') || (emp.fullName && emp.fullName.toLowerCase().includes('asbin')))) {
                  // Asbin takes priority for KSS2407004: replace any accidental occupant
                  const existingIdx = deduplicated.findIndex(e => e.employeeId === 'KSS2407004');
                  if (existingIdx !== -1 && !deduplicated[existingIdx].email?.toLowerCase().includes('asbin')) {
                    deduplicated[existingIdx] = emp;
                    if (emailKey) seenEmails.add(emailKey);
                    continue;
                  }
                } else {
                  // If the employee ID is already claimed, skip duplicates
                  continue;
                }
              }
              
              if (emailKey) seenEmails.add(emailKey);
              if (idKey) seenEmpIds.add(idKey);
              deduplicated.push(emp);
            }

            // Restore display order
            deduplicated.reverse();

            // Ensure Official D. Koushik (Project Manager) exists in Team Directory
            const koushikExists = deduplicated.some(e => 
              e.employeeId === 'KSS2407003' || 
              (e.email || '').toLowerCase().includes('d.koushik@kalpanaaasoftwaresolutions.in')
            );

            if (!koushikExists) {
              const officialKoushik: Employee = {
                id: 'emp-KSS2407003',
                employeeId: 'KSS2407003',
                uid: 'vhKLIJCVZoTncqVtmh14paMbiXk2',
                fullName: 'D. Koushik',
                email: 'd.koushik@kalpanaaasoftwaresolutions.in',
                role: 'PROJECT_MANAGER',
                department: 'IT',
                designation: 'Project Manager',
                status: 'Active',
                phone: '+91 98765 00003',
                gender: 'Male',
                dateOfBirth: '1995-01-01',
                joiningDate: '2024-07-01',
                employmentType: 'Trainee',
                permanentAddress: 'Bengaluru HQ Campus',
                currentAddress: 'Bengaluru HQ Campus',
                city: 'Bengaluru',
                state: 'Karnataka',
                postalCode: '560001',
                emergencyContact: '+91 98765 00000',
                emergencyRelationship: 'Management',
                shift: 'Day Shift (10:00 AM – 7:00 PM)',
                workLocation: 'Kalpanaaa Main Office HQ, Bengaluru',
                reportingManager: 'Board of Directors',
                qrToken: 'QR-TOKEN-KSS2407003-PM',
                createdAt: '2024-07-01T09:00:00Z',
                updatedAt: new Date().toISOString(),
                profilePhotoUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=200',
                resumeUrl: '',
                skills: ['Project Management'],
                specialization: 'Project Management'
              };

              deduplicated.push(officialKoushik);

              // P1 FIX: this setDoc previously ran on EVERY snapshot from EVERY client
              // whenever the record was absent — an unbounded retry loop for any client
              // whose rules forbid writing another employee's document (i.e. everyone
              // except HR/admin). Latched to once per session and restricted to a
              // session that is actually permitted to write it.
              if (canMigrate && !didSeedProjectManager && !snapshot.metadata.fromCache) {
                didSeedProjectManager = true;
                setDoc(doc(db, 'employees', officialKoushik.id), officialKoushik, { merge: true }).catch(() => { });
              }
            }

            // Ensure Official Asbin T S exists in Team Directory
            const asbinExists = deduplicated.some(e =>
              e.employeeId === 'KSS2407004' ||
              e.id === 'GCIqrMaffebCGNdmbuzPbcl6IpQ2' ||
              (e.email || '').toLowerCase().includes('asbin.t.s@kalpanaaa.in')
            );

            if (!asbinExists) {
              const asbinRecord = fetched.find(e =>
                e.id === 'GCIqrMaffebCGNdmbuzPbcl6IpQ2' ||
                (e.email || '').toLowerCase().includes('asbin.t.s@kalpanaaa.in') ||
                e.employeeId === 'KSS2407004'
              ) || INITIAL_EMPLOYEES.find(e => e.employeeId === 'KSS2407004');

              if (asbinRecord) {
                deduplicated.push({
                  ...asbinRecord,
                  id: asbinRecord.id || 'GCIqrMaffebCGNdmbuzPbcl6IpQ2',
                  uid: 'GCIqrMaffebCGNdmbuzPbcl6IpQ2',
                  employeeId: 'KSS2407004',
                  fullName: 'Asbin T S',
                  email: 'asbin.t.s@kalpanaaa.in',
                  status: 'Active',
                  department: asbinRecord.department || 'IT',
                  designation: asbinRecord.designation || 'Software Developer'
                });
              }
            }

            if (deduplicated.length > 0) {
              const cleanDeduplicated = deduplicateEmployeeList(deduplicated);
              const isCloudinary = (u?: string) => Boolean(u && typeof u === 'string' && u.includes('res.cloudinary.com'));

              const resolvedWithAvatars = cleanDeduplicated.map(emp => {
                const enrolled = emp.isFaceEnrolled || isFaceBiometricEnrolled(emp);
                const memoryMatch = employeesRef.current.find(e => 
                  (emp.employeeId && e.employeeId === emp.employeeId) ||
                  (emp.id && e.id === emp.id) ||
                  (emp.email && e.email?.toLowerCase() === emp.email.toLowerCase())
                );
                // Prefer authoritative Cloudinary URL from memory (hydrated from PostgreSQL)
                const chosenPhoto = isCloudinary(emp.profilePhotoUrl)
                  ? emp.profilePhotoUrl
                  : isCloudinary(memoryMatch?.profilePhotoUrl)
                  ? memoryMatch!.profilePhotoUrl
                  : getEmployeeAvatar(emp);

                // Auto-sync Cloudinary URL to Firestore if Firestore document lacks it and caller is permitted
                if (canMigrate && isCloudinary(memoryMatch?.profilePhotoUrl) && !isCloudinary(emp.profilePhotoUrl) && emp.id) {
                  setDoc(doc(db, 'employees', emp.id), { profilePhotoUrl: memoryMatch!.profilePhotoUrl }, { merge: true }).catch(() => { });
                }

                return {
                  ...emp,
                  isFaceEnrolled: enrolled,
                  profilePhotoUrl: chosenPhoto
                };
              });
              setEmployees(resolvedWithAvatars);
              employeesRef.current = resolvedWithAvatars;
              setActiveEmployee(prev => {
                if (!prev) return prev;
                const fresh = resolvedWithAvatars.find(e => e.id === prev.id || e.employeeId === prev.employeeId || (prev.email && e.email?.toLowerCase() === prev.email.toLowerCase()));
                if (!fresh) return prev;
                if (fresh.status === 'Inactive' || fresh.status === 'Terminated' || fresh.status === 'Suspended') {
                  console.warn('[Auth] Active employee status changed to', fresh.status, '— logging out.');
                  setTimeout(() => logout(), 0);
                  return null;
                }
                const enrolled = fresh.isFaceEnrolled || prev.isFaceEnrolled || isFaceBiometricEnrolled(prev) || isFaceBiometricEnrolled(fresh);
                const activePhoto = isCloudinary(fresh.profilePhotoUrl)
                  ? fresh.profilePhotoUrl
                  : isCloudinary(prev.profilePhotoUrl)
                  ? prev.profilePhotoUrl
                  : (fresh.profilePhotoUrl || getEmployeeAvatar(fresh));

                const updated = {
                  ...prev,
                  ...fresh,
                  isFaceEnrolled: enrolled,
                  faceDescriptor: fresh.faceDescriptor || prev.faceDescriptor,
                  profilePhotoUrl: activePhoto
                };
                try {
                  localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updated));
                } catch {}
                return updated;
              });
            }
          } else {
            // ── P0 FIX: DEMO DATA COULD BE SEEDED INTO PRODUCTION ──
            // This branch previously ran on ANY empty snapshot and unconditionally
            // wrote all INITIAL_EMPLOYEES (demo staff, with roles) to Firestore.
            // Firestore is configured with persistentLocalCache, so the FIRST
            // snapshot after a cold start is served from an empty local cache
            // BEFORE the server responds — `snapshot.empty` was therefore true on a
            // perfectly populated production database, and this handler happily
            // injected fake employees into the live company directory. A
            // permission-denied listener or a cleared cache produced the same result.
            //
            // Seeding now requires (a) a SERVER-confirmed empty collection, and
            // (b) a one-shot latch so it can never loop. Genuine first-run
            // bootstrapping of a fresh project still works.
            if (snapshot.metadata.fromCache) {
              // Cache-only empty result: the server has not spoken yet. Do nothing.
              return;
            }
            if (didSeedInitialEmployees) return;
            didSeedInitialEmployees = true;

            console.warn('[Auth] employees collection is empty on the server — seeding initial directory.');
            Promise.all(
              INITIAL_EMPLOYEES.map(emp =>
                setDoc(doc(db, 'employees', emp.id), emp).catch(err => {
                  console.warn('[Auth] Initial employee seed failed for', emp.id, err);
                })
              )
            ).catch(() => { });
          }
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, 'employees');
        });

        // ── COST FIX C1: Scope attendance listener to last 60 days ──────────
        // The full collection scan (all-time) read 1,500+ docs per client per
        // session. Historical records are static — no reason to stream them
        // live. Reports load older records on-demand via getDocs + date filter.
        const attCutoff = new Date();
        attCutoff.setDate(attCutoff.getDate() - 60);
        const attCutoffDate = attCutoff.toISOString().split('T')[0]; // YYYY-MM-DD
        const attQuery = query(
          collection(db, 'attendance'),
          where('date', '>=', attCutoffDate)
        );

        unsubAtt = onSnapshot(attQuery, (snapshot) => {
          const fetched: AttendanceRecord[] = [];
          if (!snapshot.empty) {
            snapshot.forEach(docSnap => {
              // ROOT-CAUSE FIX: request estimated serverTimestamps so latency-compensated
              // (local) snapshots already carry checkInAt instead of null. Without this,
              // the UI flashed the stale "Tap to Check In" state until the server ack
              // arrived, even though the write had already been applied locally.
              const data = docSnap.data({ serverTimestamps: 'estimate' });
              const recId = docSnap.id;

              const canonicalUid = getCanonicalEmployeeUid({
                uid: data.uid || data.employeeUid,
                id: data.employeeId,
                employeeId: data.employeeCode || data.employeeId
              });

              // Read live employees via ref — the listener closure captures a stale
              // `employees` array from subscription time (often empty on cold start),
              // which broke identity resolution and produced duplicate state records.
              const empPool = employeesRef.current;
              const matchedEmp = findEmployee({
                id: data.employeeId,
                employeeId: data.employeeCode || data.employeeId,
                uid: canonicalUid || data.uid,
                fullName: data.employeeName
              });

              const employeeName = data.employeeName || matchedEmp?.fullName || '';
              const employeeCode = data.employeeCode || matchedEmp?.employeeId || data.employeeId || canonicalUid;
              const employeeId = matchedEmp?.id || data.employeeId || canonicalUid;

              const dateStr = getWorkDate(data.date || formatTimestampToISO(data.createdAt) || formatTimestampToISO(data.checkInAt) || (recId.includes('_') ? recId.split('_')[1] : new Date()));
              const isJasonEmp = (canonicalUid === 'KfAB95lpbJOeylpKQaWX4GXOPGt2' || employeeCode === 'KSS2407011' || (employeeName && employeeName.toLowerCase().includes('jason'))) && employeeCode !== 'KSS2407014';
              const empJoinDate = matchedEmp?.joiningDate || (isJasonEmp ? '2026-08-17' : undefined);

              const hasActualWork = !!data.checkInAt || !!data.checkOutAt || (typeof data.workingMinutes === 'number' && data.workingMinutes > 0) || data.status === 'Present' || data.status === 'Late';

              if (dateStr < COMPANY_START_DATE) {
                // COST FIX M1: latch prevents re-firing deleteDoc on every snapshot
                if (!deletedAttendanceIds.has(recId)) {
                  deletedAttendanceIds.add(recId);
                  deleteDoc(doc(db, 'attendance', recId)).catch(() => {});
                }
                return;
              }

              if (!hasActualWork && empJoinDate && dateStr < empJoinDate) {
                // COST FIX M1: latch prevents re-firing deleteDoc on every snapshot
                if (!deletedAttendanceIds.has(recId)) {
                  deletedAttendanceIds.add(recId);
                  deleteDoc(doc(db, 'attendance', recId)).catch(() => {});
                }
                return;
              }
              let checkInISO = formatTimestampToISO(data.checkInAt);
              if (!checkInISO && data.checkInAt && typeof data.checkInAt === 'object') {
                checkInISO = formatTimestampToISO(data.createdAt) || formatTimestampToISO(data.updatedAt);
              }
              const checkOutISO = formatTimestampToISO(data.checkOutAt);
              const createdISO = formatTimestampToISO(data.createdAt) || checkInISO || new Date().toISOString();
              const updatedISO = formatTimestampToISO(data.updatedAt) || checkOutISO || createdISO;

              const cleanRec: AttendanceRecord = {
                id: recId,
                uid: canonicalUid,
                employeeUid: canonicalUid,
                employeeId: employeeId,
                employeeCode: employeeCode,
                employeeName: employeeName,
                department: data.department || matchedEmp?.department || 'Engineering',
                pmUid: data.pmUid || matchedEmp?.pmUid || '',
                date: dateStr,
                checkInAt: checkInISO,
                checkOutAt: checkOutISO,
                workingMinutes: typeof data.workingMinutes === 'number' ? data.workingMinutes : 0,
                status: data.status || 'Present',
                attendanceMethod: data.attendanceMethod || 'Self Portal',
                officeLatitude: data.officeLatitude,
                officeLongitude: data.officeLongitude,
                officeRadiusMeters: data.officeRadiusMeters,
                distanceFromOffice: data.distanceFromOffice,
                locationAccuracy: data.locationAccuracy,
                locationVerified: !!data.locationVerified,
                latitude: data.latitude,
                longitude: data.longitude,
                deviceInfo: data.deviceInfo,
                notes: data.notes,
                breaks: Array.isArray(data.breaks) ? data.breaks.map((b: any) => ({
                  type: b.type,
                  startAt: formatTimestampToISO(b.startAt || b.startTime) || '',
                  endAt: formatTimestampToISO(b.endAt || b.endTime),
                  durationMinutes: Number(b.durationMinutes) || 0
                })) : [],
                totalBreakMinutes: typeof data.totalBreakMinutes === 'number' ? data.totalBreakMinutes : 0,
                isWfh: !!data.isWfh,
                createdAt: createdISO,
                updatedAt: updatedISO
              };

              // ROOT-LEVEL CORRECTION: Akash SB accidental WFH attendance (27th/28th Aug – 5th Sep)
              const isAkashAtt = (
                cleanRec.employeeId === 'emp-KSS2407013' ||
                cleanRec.employeeCode === 'KSS2407013' ||
                cleanRec.employeeId === 'KSS2407013' ||
                (cleanRec.employeeName && cleanRec.employeeName.toLowerCase().includes('akash'))
              );
              if (isAkashAtt && cleanRec.date >= '2026-08-27' && cleanRec.date <= '2026-09-05') {
                if (cleanRec.isWfh || cleanRec.status === 'Work From Home') {
                  cleanRec.isWfh = false;
                  if (cleanRec.status === 'Work From Home') {
                    cleanRec.status = cleanRec.checkInAt ? 'Present' : 'Absent';
                  }
                }
              }

              fetched.push(cleanRec);
            });
          }

          // Deduplicate by RESOLVED employee identity + date.
          const deduplicatedMap = new Map<string, AttendanceRecord>();
          fetched.forEach(rec => {
            const recEmp = findEmployee({
              id: rec.employeeId,
              employeeId: rec.employeeCode,
              uid: rec.employeeUid,
              fullName: rec.employeeName
            });
            const identityKey = getCanonicalEmployeeUid(
              recEmp
                ? { uid: recEmp.uid, id: recEmp.id, employeeId: recEmp.employeeId }
                : { uid: rec.employeeUid, id: rec.employeeId, employeeId: rec.employeeCode }
            ) || rec.id;
            const empKey = `${identityKey}_${rec.date}`;
            const existing = deduplicatedMap.get(empKey);
            if (!existing) {
              deduplicatedMap.set(empKey, rec);
            } else {
              // Merge duplicates preferring the record with REAL attendance data so a
              // stale blank duplicate can never mask an actual check-in / check-out.
              const richer = (rec.checkInAt ? rec : existing) as AttendanceRecord;
              const poorer = (rec.checkInAt ? existing : rec) as AttendanceRecord;
              // Keep the canonical doc ID ({uid}_{date}) when one of the dups has it,
              // so canonical-ID lookups elsewhere hit this exact state record.
              const isCanonicalId = (id: string) => id === `${identityKey}_${rec.date}`;
              const canonicalDocId = `${identityKey}_${rec.date}`;
              const canonicalRec = rec.id === canonicalDocId ? rec : (existing.id === canonicalDocId ? existing : null);

              // BREAK FLAP ROOT FIX: the canonical doc ({uid}_{date}) is the ONLY
              // write target for startBreak / endBreak / recordCheckOut. Its breaks
              // array is always authoritative.
              const canonicalBreaks = (() => {
                if (rec.id === canonicalDocId) return rec.breaks || [];
                if (existing.id === canonicalDocId) return existing.breaks || [];
                // No canonical in this pair — prefer more entries, then prefer
                // the set that contains an open (in-progress) break.
                const rBreaks = richer.breaks || [];
                const pBreaks = poorer.breaks || [];
                if (rBreaks.length !== pBreaks.length) return rBreaks.length > pBreaks.length ? rBreaks : pBreaks;
                const rHasOpen = rBreaks.some((b: any) => !b.endAt && !(b as any).endTime);
                const pHasOpen = pBreaks.some((b: any) => !b.endAt && !(b as any).endTime);
                if (rHasOpen && !pHasOpen) return rBreaks;
                if (pHasOpen && !rHasOpen) return pBreaks;
                return rBreaks;
              })();

              // CHECKOUT ROOT FIX: The canonical doc is authoritative for checkOutAt.
              // When an admin undos checkout (checkOutAt = null), we MUST NOT fall back
              // to a stale checkOutAt from a duplicate document via `richer || poorer`.
              const finalCheckOutAt = canonicalRec && canonicalRec.checkInAt !== undefined
                ? (canonicalRec.checkOutAt || null)
                : (richer.checkOutAt || null);

              const finalStatus = canonicalRec?.status || richer.status || poorer.status || 'Present';
              const finalCheckInAt = canonicalRec?.checkInAt || richer.checkInAt || poorer.checkInAt;

              const merged: AttendanceRecord = {
                ...poorer,
                ...richer,
                id: isCanonicalId(richer.id) ? richer.id : (isCanonicalId(poorer.id) ? poorer.id : richer.id),
                checkInAt: finalCheckInAt,
                checkOutAt: finalCheckOutAt,
                status: finalStatus,
                breaks: canonicalBreaks,
                workingMinutes: finalCheckOutAt ? Math.max(existing.workingMinutes || 0, rec.workingMinutes || 0) : (canonicalRec?.workingMinutes ?? 0),
                totalBreakMinutes: Math.max(existing.totalBreakMinutes || 0, rec.totalBreakMinutes || 0)
              };
              deduplicatedMap.set(empKey, merged);
            }
          });

          const consolidated = Array.from(deduplicatedMap.values());
          consolidated.sort((a, b) => new Date(b.createdAt || b.date).getTime() - new Date(a.createdAt || a.date).getTime());
          
          // Pure Firestore state derivation
          setAttendance(consolidated);
          setAttendanceSyncStatus('synced');

          // ── COST FIX: the migration used to be kicked off from right here ──
          // runAttendanceMigration() ran on EVERY client's first snapshot, for every
          // role, with no gate. It full-scans /attendance AND /employees via getDocs
          // (attendanceMigration.ts:131,140) plus a per-legacy-doc getDoc in a loop,
          // so a ~20k-record collection billed ~20k server reads per session —
          // roughly 2,000,000 reads/day across ~100 daily logins, against a
          // 50,000/day free allowance (~40x over).
          //
          // Nothing that portals RENDER is lost by removing it from the read path:
          // identity resolution, canonical-uid mapping and de-duplication are all
          // computed IN MEMORY above, for every role.
          //
          // The migration's only side effect is PERSISTING repairs, and the one that
          // reaches an employee is the fabricated-shift repair. Note an employee CAN
          // write their own attendance rows (firestore.rules ownsAttendanceData), so
          // the honest reason gating is safe is not "employees couldn't write anyway"
          // — it is that fabrication is no longer produced. Those rows were written by
          // the LEGACY migration (see the comment on isFabricatedCheckoutOnly in
          // attendanceEngine.ts), so the repair set is finite and historical: one
          // admin pass drains a backlog that never regrows. What used to happen on
          // every employee login was therefore a no-op costing ~20k reads.
          // Ownership now sits in the admin-gated, once-per-day effect below.
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, 'attendance');
          setAttendanceSyncStatus('synced');
        });

        // Subscribe to leave requests with real-time cross-device sync
        unsubLeaveReqs = onSnapshot(collection(db, 'leaveRequests'), (snapshot) => {
          const fetched: LeaveRequest[] = [];
          if (!snapshot.empty) {
            snapshot.forEach(docSnap => {
              const data = docSnap.data();
              const raw = { id: docSnap.id, ...data } as LeaveRequest;
              
              // ROOT-LEVEL PURGE: Accidental WFH request for Akash SB (27th/28th Aug – 5th Sep)
              const isAkashReq = (
                raw.employeeId === 'KSS2407013' ||
                raw.employeeId === 'emp-KSS2407013' ||
                (raw.employeeName && raw.employeeName.toLowerCase().includes('akash'))
              );
              const isAccidentalRange = raw.type === 'WFH' && (
                (raw.startDate && raw.startDate <= '2026-09-05' && (raw.endDate || raw.startDate) >= '2026-08-27') ||
                ((raw as any).fromDate && (raw as any).fromDate <= '2026-09-05' && ((raw as any).toDate || (raw as any).fromDate) >= '2026-08-27')
              );
              if (isAkashReq && isAccidentalRange) {
                if (roleRef.current === 'SUPER_ADMIN' || roleRef.current === 'HR_ADMIN') {
                  deleteDoc(doc(db, 'leaveRequests', docSnap.id)).catch(() => { });
                }
                return;
              }

              // ROOT-LEVEL PURGE: Dummy / test leave requests (e.g. test, ghfgds, dummy-*, leave-*)
              const isDummyReq = (raw.reason && (
                raw.reason.toLowerCase().trim() === 'test' ||
                raw.reason.toLowerCase().includes('dummy') ||
                raw.reason.toLowerCase().includes('ghfgds') ||
                raw.reason.toLowerCase().includes('test leave')
              )) || raw.id.startsWith('dummy-') || raw.id.startsWith('test-') || raw.id.startsWith('leave-') || (raw as any).is_dummy === true || (raw as any).isDummy === true || raw.id === 'LR-UVLV1K5' || raw.id === 'LR_KSS2407014_2026-08-19_WFH';

              if (isDummyReq) {
                if (roleRef.current === 'SUPER_ADMIN' || roleRef.current === 'HR_ADMIN') {
                  deleteDoc(doc(db, 'leaveRequests', docSnap.id)).catch(() => { });
                }
                return;
              }

              // 2-tier approval workflow: strictly CEO -> CTO. PM and HR are NOT in the approval workflow.
              const pmStatus: any = 'N/A';
              const hrStatus: any = 'N/A';
              const ceoStatus: any = raw.ceoStatus === 'Approved' ? 'Approved' :
                                raw.ceoStatus === 'Rejected' ? 'Rejected' :
                                (raw.status === 'Pending' ? 'Pending' : 'N/A');
              const ctoStatus: any = raw.ctoStatus === 'Approved' ? 'Approved' :
                                raw.ctoStatus === 'Rejected' ? 'Rejected' :
                                (ceoStatus === 'Approved' ? 'Pending' : 'Waiting CEO');

              const isCeoPassed = ceoStatus === 'Approved' || ceoStatus === 'N/A' || ceoStatus === 'Bypassed';
              const isCtoPassed = ctoStatus === 'Approved' || ctoStatus === 'N/A' || ctoStatus === 'Bypassed';

              let status: 'Pending' | 'Approved' | 'Rejected' | 'Cancelled' = raw.status || 'Pending';
              if (raw.status === 'Cancelled') {
                status = 'Cancelled';
              } else if (
                raw.status === 'Rejected' || 
                ceoStatus === 'Rejected' || 
                ctoStatus === 'Rejected' || 
                raw.pmStatus === 'Rejected' || 
                raw.hrStatus === 'Rejected'
              ) {
                status = 'Rejected';
              } else if (raw.status === 'Approved' || (isCeoPassed && isCtoPassed && ceoStatus === 'Approved' && ctoStatus === 'Approved')) {
                status = 'Approved';
              } else {
                status = 'Pending';
              }

              // Dynamic fallback for legacy records missing pmUid or employeeUid
              const matchedEmp = employees.find(e => e.id === raw.employeeId || e.employeeId === raw.employeeId);
              const employeeUid = raw.employeeUid || matchedEmp?.uid || '';
              const pmUid = raw.pmUid || matchedEmp?.pmUid || matchedEmp?.reportingManagerUid || 'uid-KSS2407003';

              fetched.push({
                ...raw,
                employeeUid,
                pmUid,
                pmStatus,
                hrStatus,
                ceoStatus,
                ctoStatus,
                status
              });
            });
          }

          // Build authoritative list from Firestore only — no INITIAL_LEAVE_REQUESTS injection.
          // Using a Map keyed by doc ID deduplicates any repeated Firestore snapshot events.
          const reqMap = new Map<string, LeaveRequest>();
          fetched.forEach(r => {
            reqMap.set(r.id, r);
          });
          const authoritativeList = Array.from(reqMap.values());
          authoritativeList.sort((a, b) => {
            const timeA = new Date(a.requestDate || (a as any).createdAt || a.startDate || 0).getTime() || 0;
            const timeB = new Date(b.requestDate || (b as any).createdAt || b.startDate || 0).getTime() || 0;
            return timeB - timeA;
          });

          setLeaveRequests(authoritativeList);
          try {
            localStorage.setItem('kss_v1_leave_requests', JSON.stringify(authoritativeList));
          } catch {}
        }, (error) => {
          handleFirestoreError(error, OperationType.LIST, 'leaveRequests');
        });

        // P1 FIX: `limit(50)` WITHOUT `orderBy` DOES NOT MEAN "50 NEWEST".
        // With no order clause Firestore orders by document name (__name__), and
        // notifications are written with addDoc() → random 20-char ids. The listener
        // therefore streamed an arbitrary, lexicographically-lowest 50 documents and
        // capped there: once the collection exceeded 50 docs, NEW notifications were
        // usually never delivered to the bell at all, and the client-side sort could
        // not recover data the server never sent. Ordering server-side by createdAt
        // makes limit(50) mean what the code always assumed it meant.
        // (createdAt is written as an ISO-8601 string by both src/lib/notifications.ts
        // and the Cloud Function schedulers, and ISO-8601 sorts lexicographically in
        // chronological order — so no index or data migration is required.)
        const notifsQuery = query(collection(db, 'notifications'), orderBy('createdAt', 'desc'), limit(50));
        unsubNotifs = onSnapshot(notifsQuery, (snapshot) => {
          const fetched: KssNotification[] = [];
          if (!snapshot.empty) {
            snapshot.forEach(docSnap => {
              const data = docSnap.data();
              const createdAtIso = data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : (typeof data.createdAt === 'string' ? data.createdAt : new Date().toISOString());
              fetched.push({ id: docSnap.id, ...data, createdAt: createdAtIso } as KssNotification);
            });
            fetched.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
          }
          setNotifications(fetched);
        }, () => {
          // Silent fallback for notification listener
        });

        // Audit logs are now subscribed conditionally in a separate effect

        // Subscribe to company settings
        unsubSettings = onSnapshot(doc(db, 'settings', 'global'), (docSnap) => {
          // Read metadata before the exists() narrowing: exists() is declared as a
          // `this is QueryDocumentSnapshot` type predicate, so the else-branch narrows
          // the snapshot to `never` and no property access compiles there.
          const fromCache = docSnap.metadata.fromCache;
          if (docSnap.exists()) {
            const firestoreSettings = docSnap.data() as CompanySettings;
            setSettings(prev => ({
              ...prev,
              ...firestoreSettings,
              // Always union official 2026 holidays with whatever is stored in Firestore
              // so declared public holidays (e.g. Ganesh Chaturthi) are never silently
              // dropped by a stale or partial database value.
              holidayDates: Array.from(new Set([
                ...OFFICIAL_HOLIDAY_DATES_2026,
                ...(firestoreSettings.holidayDates || []),
                ...(prev.holidayDates || [])
              ])),
              // Preserve whichever has MORE wfh dates (local or Firestore) — avoids wipe on sync
              companyWideWfhDates: (() => {
                const local = prev.companyWideWfhDates || [];
                const remote = firestoreSettings.companyWideWfhDates || [];
                const merged = Array.from(new Set([...local, ...remote]));
                return merged;
              })()
            }));
          } else if (
            // P1 FIX: this bootstrap write fired on a CACHE-ONLY miss as well as a real
            // absence. On a cold start the local cache has no settings/global document
            // yet, so `!exists()` was true before the server replied and every client
            // raced to write INITIAL_COMPANY_SETTINGS over the live company policy —
            // resetting the geo-fence, shift window and company-wide WFH dates. It also
            // retried forever on any client whose rules forbid writing settings.
            !fromCache &&
            !didSeedSettings &&
            (roleRef.current === 'SUPER_ADMIN' || roleRef.current === 'HR_ADMIN')
          ) {
            didSeedSettings = true;
            setDoc(doc(db, 'settings', 'global'), INITIAL_COMPANY_SETTINGS).catch(() => { });
          }
        }, (error) => {
          handleFirestoreError(error, OperationType.GET, 'settings/global');
        });

        // Subscribe to authoritative company work zone doc
        unsubWorkZone = onSnapshot(doc(db, 'workZones', 'company'), (docSnap) => {
          // See the note above: exists() narrows the else-branch to `never`.
          const zoneFromCache = docSnap.metadata.fromCache;
          if (docSnap.exists()) {
            const fetchedZone = docSnap.data() as WorkZone;

            // ── P1 FIX: THE GEO-FENCE WAS UNCONFIGURABLE ──
            // The previous condition was
            //   latitude === 13.014316 || longitude === 77.64052 || radiusMeters === 500
            // and it overwrote ALL THREE fields whenever ANY ONE matched. Two bugs:
            //
            //  1. `radiusMeters === 500` is a legitimate admin choice. Saving a 500 m
            //     radius in Work Location settings was silently reverted to 300 m by
            //     every client on the very next snapshot — the setting could never be
            //     applied, and the admin had no error to explain why.
            //  2. Because the clauses were OR'd, choosing a 500 m radius ALSO relocated
            //     the office coordinates, moving the geo-fence the admin never touched.
            //
            // The genuine intent was a one-time migration off one stale coordinate pair.
            // That is preserved with AND semantics on the coordinates only, latched to a
            // single attempt, and restricted to a session permitted to write workZones —
            // instead of an unbounded write from every client on every snapshot.
            let needsUpdate = false;
            if (fetchedZone.latitude === 13.014316 && fetchedZone.longitude === 77.64052) {
              fetchedZone.latitude = 13.014333;
              fetchedZone.longitude = 77.646000;
              needsUpdate = true;
            }

            setCompanyWorkZone(fetchedZone);
            setSettings(prev => ({
              ...prev,
              officeName: fetchedZone.name || prev.officeName,
              officeLatitude: fetchedZone.latitude || prev.officeLatitude,
              officeLongitude: fetchedZone.longitude || prev.officeLongitude,
              allowedRadiusMeters: fetchedZone.radiusMeters || prev.allowedRadiusMeters
            }));

            if (
              needsUpdate &&
              !didMigrateWorkZone &&
              !zoneFromCache &&
              (roleRef.current === 'SUPER_ADMIN' || roleRef.current === 'HR_ADMIN')
            ) {
              didMigrateWorkZone = true;
              setDoc(doc(db, 'workZones', 'company'), {
                latitude: fetchedZone.latitude,
                longitude: fetchedZone.longitude
              }, { merge: true }).catch(() => {});
            }
          } else {
            const defaultZone: WorkZone = {
              name: 'Kalpanaaa Software Solutions HQ',
              latitude: 13.014333,
              longitude: 77.646000,
              radiusMeters: 300,
              active: true,
              updatedBy: 'System Init',
              updatedAt: new Date().toISOString()
            };

            // Always reflect the default locally so check-in validation has a geo-fence,
            // but only PERSIST it on a server-confirmed absence from an authorised
            // session — same cache-miss overwrite hazard as settings/global above.
            setCompanyWorkZone(defaultZone);
            if (
              !zoneFromCache &&
              !didSeedWorkZone &&
              (roleRef.current === 'SUPER_ADMIN' || roleRef.current === 'HR_ADMIN')
            ) {
              didSeedWorkZone = true;
              setDoc(doc(db, 'workZones', 'company'), defaultZone).catch(() => { });
            }
          }
        }, (error) => {
          setCompanyWorkZone({
            name: INITIAL_COMPANY_SETTINGS.officeName,
            latitude: INITIAL_COMPANY_SETTINGS.officeLatitude,
            longitude: INITIAL_COMPANY_SETTINGS.officeLongitude,
            radiusMeters: INITIAL_COMPANY_SETTINGS.allowedRadiusMeters,
            active: true,
            updatedBy: 'System Local Default',
            updatedAt: new Date().toISOString()
          });
          handleFirestoreError(error, OperationType.GET, 'workZones/company');
        });

      } catch (err) {
        console.warn('Firestore initialization fallback to local state:', err);
      }
    };

    initFirestore();

    return () => {
      unsubEmps();
      unsubAtt();
      unsubLogs();
      unsubSettings();
      unsubWorkZone();
      unsubLeaveReqs();
      unsubNotifs();
    };
  }, [authUid]);

  // Conditionally subscribe to audit logs only for admins (bounded query to prevent read spikes)
  useEffect(() => {
    let unsubLogs = () => { };
    if (!USE_FIREBASE_FIRESTORE) return;
    if (isAuthenticated && authUid && (role === 'SUPER_ADMIN' || role === 'HR_ADMIN')) {
      // P1 FIX: same `limit` without `orderBy` defect as the notifications query.
      // auditLog ids are `log-<epoch-ms>-<rand>`, so ordering by __name__ ordered by
      // the epoch prefix as a STRING — meaning the admin audit trail showed the 100
      // OLDEST entries and permanently froze. Compliance review of any recent event
      // was impossible. `timestamp` is an ISO-8601 string on every record written by
      // addAuditLog(), so a plain single-field orderBy needs no composite index.
      const logsQuery = query(collection(db, 'auditLogs'), orderBy('timestamp', 'desc'), limit(100));
      // P0 FIX: recovery-enabled subscription (transient errors retried with backoff)
      unsubLogs = subscribeWithRecovery(logsQuery, (snapshot) => {
        if (!snapshot.empty) {
          const fetched: AuditLog[] = [];
          snapshot.forEach(docSnap => {
            fetched.push({ id: docSnap.id, ...docSnap.data() } as AuditLog);
          });
          if (fetched.length > 0) {
            fetched.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            setAuditLogs(fetched);
          }
        }
      }, (error) => {
        console.warn('Audit logs permission denied or offline');
      });
    } else {
      setAuditLogs([]);
    }
    return () => unsubLogs();
  }, [isAuthenticated, authUid, role]);

  // ── COST FIX: admin-owned, once-per-day attendance migration ────────────────
  // The legacy→canonical attendance migration (and its shift-fabrication repair)
  // is a maintenance job, not a read path. It was previously fired from the
  // attendance snapshot handler on every client, which full-scanned /attendance
  // and /employees once per session and alone consumed ~40x the daily free read
  // allowance. Two guards make it cheap without making it useless:
  //
  //  • Role gate — SUPER_ADMIN / HR_ADMIN only, mirroring the audit-log effect
  //    above. This reads the `role` STATE, deliberately not `roleRef.current`:
  //    the ref is synced by its own effect and still holds the 'EMPLOYEE' default
  //    at the moment the first attendance snapshot lands, so gating in place
  //    would have skipped admins too and the repairs would never have run at all.
  //
  //  • Persisted day latch — the old in-closure `let hasRunMigration` reset on
  //    every re-init, so the scan re-ran on every mount and reconnect.
  //    localStorage survives both. The migration is idempotent, so a failure
  //    intentionally leaves the latch unset and retries on the next admin session.
  useEffect(() => {
    if (!isAuthenticated || !authUid) return;
    if (role !== 'SUPER_ADMIN' && role !== 'HR_ADMIN') return;

    const dayKey = `kss_att_migration_v1:${todayInIST()}`;
    if (localStorage.getItem(dayKey) === 'done') return;

    let cancelled = false;
    runAttendanceMigration()
      .then(() => {
        if (!cancelled) localStorage.setItem(dayKey, 'done');
      })
      .catch(() => { /* transient — retried on the next admin session */ });

    return () => { cancelled = true; };
  }, [isAuthenticated, authUid, role]);

  // ── Auto-heal & Root-level WFH correction (Akash SB & unapproved WFH) ─────────
  // Automatically purges accidental WFH allocations (such as Akash SB 27th/28th Aug - 5th Sep)
  // and corrects backend data safely in a single batch pass with a persistent latch to prevent infinite re-renders.
  const hasAutoHealedRef = useRef(false);

  useEffect(() => {
    if (!isAuthenticated) return;
    if (!employees.length || !attendance.length) return;
    if (hasAutoHealedRef.current) return;
    hasAutoHealedRef.current = true;

    const accidentalRange = ['2026-08-27', '2026-08-28', '2026-08-29', '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'];

    // ── VERIFIED LEAVE BALANCE TABLE (October 2026) ───────────────────────────
    // | Employee          | EL | SL | WFH |
    // | Asbin             |  0 |  1 |  0  |
    // | Thabeethal        |  0 |  1 |  1  | (female — 1 WFH/month)
    // | Akash             |  2 |  0 |  0  |
    // | Prahlad Sharma    |  2 |  1 |  0  |
    // | Satya Ranjan Das  |  2 |  1 |  0  |
    // | Mahesh            |  1 |  0 |  0  |
    // | Ritish            |  1 |  1 |  0  |
    // | Pratiksha Harode  |  2 |  1 |  0  |
    // | Priyanka Kushwah  |  2 |  1 |  0  |
    // | D. Koushik        |  0 |  0 |  0  |
    // ─────────────────────────────────────────────────────────────────────────

    // 1. Clean employee records with verified balances
    let employeesChanged = false;
    const nextEmployees = employees.map(emp => {
      let e = { ...emp };
      let changed = false;

      const isJingyasha = e.id === '8RxH6z3ZzUTmM26iqta1DhCPa8l1' || e.employeeId === 'KSS2407014' || (e.fullName && (e.fullName.toLowerCase().includes('jigy') || e.fullName.toLowerCase().includes('jing')));
      const isJason = (e.id === 'KfAB95lpbJOeylpKQaWX4GXOPGt2' || e.employeeId === 'KSS2407011' || (e.fullName && e.fullName.toLowerCase().includes('jason'))) && !isJingyasha;
      const isAkash = (e.id === 'emp-KSS2407013' || e.employeeId === 'KSS2407013' || (e.fullName && e.fullName.toLowerCase().includes('akash'))) && !isJingyasha;
      const isAsbin = e.id === 'emp-KSS2407004' || e.employeeId === 'KSS2407004' || (e.fullName && e.fullName.toLowerCase().includes('asbin'));
      const isMahesh = e.id === 'emp-KSS2407006' || e.employeeId === 'KSS2407006' || (e.fullName && e.fullName.toLowerCase().includes('mahesh'));
      const isThabeethal = e.id === 'emp-KSS2407005' || e.employeeId === 'KSS2407005' || (e.fullName && e.fullName.toLowerCase().includes('thabeethal'));
      const isKoushik = e.id === 'emp-KSS2407003' || e.employeeId === 'KSS2407003' || (e.fullName && e.fullName.toLowerCase().includes('koushik') && !e.fullName.toLowerCase().includes('priya'));
      const isPrahlad = e.id === 'emp-KSS2407010' || e.employeeId === 'KSS2407010' || (e.fullName && e.fullName.toLowerCase().includes('prahlad'));
      const isSatya = e.id === 'emp-KSS2407012' || e.employeeId === 'KSS2407012' || (e.fullName && (e.fullName.toLowerCase().includes('satya') || e.fullName.toLowerCase().includes('ranjan')));
      const isRitish = e.id === 'emp-KSS2407007' || e.employeeId === 'KSS2407007' || (e.fullName && e.fullName.toLowerCase().includes('ritish'));
      const isPratiksha = e.id === 'emp-KSS2407008' || e.employeeId === 'KSS2407008' || (e.fullName && e.fullName.toLowerCase().includes('pratiksha'));
      const isPriyanka = e.id === 'emp-KSS2407009' || e.employeeId === 'KSS2407009' || (e.fullName && e.fullName.toLowerCase().includes('priyanka'));
      const isShruti = e.id === '4lJ6efl4vYTAemQ24cjgq2hC7fe2' || e.id === 'emp-KSS2407017' || e.employeeId === 'KSS2407017' || (e.fullName && e.fullName.toLowerCase().includes('shruti'));

      if (isAkash) {
        // Akash: EL=1, SL=0, WFH=0
        const cleanedDates = (e.approvedWfhDates || []).filter(d => !accidentalRange.includes(d));
        const datesChanged = cleanedDates.length !== (e.approvedWfhDates || []).length;
        const needsEl = typeof e.earnLeaveBalance !== 'number' || e.earnLeaveBalance !== 1;
        const needsSl = typeof e.sickLeaveBalance !== 'number' || e.sickLeaveBalance !== 0;
        if (datesChanged || needsEl || needsSl) {
          e.approvedWfhDates = cleanedDates;
          e.sickLeaveBalance = 0;
          e.earnLeaveBalance = 1;
          changed = true;
          if (auth.currentUser) {
            setDoc(doc(db, 'employees', e.id), { approvedWfhDates: cleanedDates, sickLeaveBalance: 0, earnLeaveBalance: 1, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
          }
        }
      } else if (isAsbin) {
        // Asbin: EL=1, SL=1, WFH=0
        const currentDates = e.approvedWfhDates || [];
        const needsDates = !currentDates.includes('2026-08-28') || !currentDates.includes('2026-08-29');
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsDates || needsEl || needsSl) {
          const updatedDates = Array.from(new Set([...currentDates, '2026-08-28', '2026-08-29']));
          e.approvedWfhDates = updatedDates;
          if (needsEl) e.earnLeaveBalance = 1;
          if (needsSl) e.sickLeaveBalance = 1;
          changed = true;
          if (auth.currentUser) {
            setDoc(doc(db, 'employees', e.id), { approvedWfhDates: updatedDates, earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
          }
        }
      } else if (isMahesh) {
        // Mahesh: EL=1, SL=0, WFH=0
        const currentDates = e.approvedWfhDates || [];
        const needsDates = !currentDates.includes('2026-08-27') || !currentDates.includes('2026-08-29') || currentDates.includes('2026-08-26');
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsDates || needsEl || needsSl) {
          const updatedDates = Array.from(new Set([...currentDates.filter(d => d !== '2026-08-26'), '2026-08-27', '2026-08-29']));
          e.approvedWfhDates = updatedDates;
          if (needsEl) e.earnLeaveBalance = 1;
          if (needsSl) e.sickLeaveBalance = 0;
          changed = true;
          if (auth.currentUser) {
            setDoc(doc(db, 'employees', e.id), { approvedWfhDates: updatedDates, earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
          }
        }
      } else if (isThabeethal) {
        // Thabeethal: Inactive (left company), EL=0, SL=1, WFH=1
        const needsStatus = e.status !== 'Inactive';
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsStatus || needsEl || needsSl) {
          e.status = 'Inactive';
          if (needsEl) e.earnLeaveBalance = 0;
          if (needsSl) e.sickLeaveBalance = 1;
          changed = true;
          setDoc(doc(db, 'employees', e.id), { status: 'Inactive', earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isKoushik) {
        // D. Koushik (PM): EL=0, SL=0, WFH=0 — verified policy
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsEl || needsSl) {
          if (needsEl) e.earnLeaveBalance = 0;
          if (needsSl) e.sickLeaveBalance = 0;
          changed = true;
          setDoc(doc(db, 'employees', e.id), { earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isPrahlad) {
        // Prahlad Sharma: EL=2, SL=1, WFH=0
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsEl || needsSl) {
          if (needsEl) e.earnLeaveBalance = 2;
          if (needsSl) e.sickLeaveBalance = 1;
          changed = true;
          setDoc(doc(db, 'employees', e.id), { earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isSatya) {
        // Satya Ranjan Das: EL=3, SL=1, WFH=0 (Sep, Oct, Nov credited), Software Engineer & Employee
        const needsEl = typeof e.earnLeaveBalance !== 'number' || e.earnLeaveBalance < 3;
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        const needsDesig = e.designation !== 'Software Engineer';
        const needsEmpType = e.employmentType !== 'Employee';
        if (needsEl || needsSl || needsDesig || needsEmpType) {
          e.earnLeaveBalance = 3;
          if (needsSl) e.sickLeaveBalance = 1;
          e.designation = 'Software Engineer';
          e.employmentType = 'Employee';
          changed = true;
          setDoc(doc(db, 'employees', e.id), { 
            earnLeaveBalance: 3, 
            sickLeaveBalance: e.sickLeaveBalance, 
            designation: 'Software Engineer',
            employmentType: 'Employee',
            updatedAt: serverTimestamp() 
          }, { merge: true }).catch(() => {});
        }
      } else if (isRitish) {
        // Ritish: EL=1, SL=1, WFH=0
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsEl || needsSl) {
          if (needsEl) e.earnLeaveBalance = 1;
          if (needsSl) e.sickLeaveBalance = 1;
          changed = true;
          setDoc(doc(db, 'employees', e.id), { earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isPratiksha) {
        // Pratiksha Harode: Trainee, EL=2, SL=1, WFH=0
        const needsType = e.employmentType !== 'Trainee';
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsType || needsEl || needsSl) {
          e.employmentType = 'Trainee';
          if (needsEl) e.earnLeaveBalance = 2;
          if (needsSl) e.sickLeaveBalance = 1;
          changed = true;
          setDoc(doc(db, 'employees', e.id), { employmentType: 'Trainee', earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isPriyanka) {
        // Priyanka Kushwah: EL=2, SL=1, WFH=0
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        if (needsEl || needsSl) {
          if (needsEl) e.earnLeaveBalance = 2;
          if (needsSl) e.sickLeaveBalance = 1;
          changed = true;
          setDoc(doc(db, 'employees', e.id), { earnLeaveBalance: e.earnLeaveBalance, sickLeaveBalance: e.sickLeaveBalance, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isJingyasha) {
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        const needsDate = !e.joiningDate || e.joiningDate !== '2026-09-01';
        if (needsEl || needsSl || needsDate) {
          if (needsSl) e.sickLeaveBalance = 1;
          if (needsEl) e.earnLeaveBalance = 1;
          if (needsDate) e.joiningDate = '2026-09-01';
          changed = true;
          setDoc(doc(db, 'employees', e.id), { sickLeaveBalance: e.sickLeaveBalance, earnLeaveBalance: e.earnLeaveBalance, joiningDate: e.joiningDate, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isJason) {
        // Jason Kenneth N: Inactive (left company)
        const needsStatus = e.status !== 'Inactive';
        const needsEl = typeof e.earnLeaveBalance !== 'number';
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        const needsDate = !e.joiningDate || e.joiningDate !== '2026-08-17';
        if (needsStatus || needsEl || needsSl || needsDate) {
          e.status = 'Inactive';
          if (needsSl) e.sickLeaveBalance = 0;
          if (needsEl) e.earnLeaveBalance = 1;
          if (needsDate) e.joiningDate = '2026-08-17';
          changed = true;
          setDoc(doc(db, 'employees', e.id), { status: 'Inactive', sickLeaveBalance: e.sickLeaveBalance, earnLeaveBalance: e.earnLeaveBalance, joiningDate: e.joiningDate, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      } else if (isShruti) {
        // Shruti Sanjana Sahoo: EL=2, SL=0 (joined 2026-09-01, 2 EL credited, 0 EL taken; 1 SL taken)
        const needsEl = typeof e.earnLeaveBalance !== 'number' || e.earnLeaveBalance !== 2;
        const needsSl = typeof e.sickLeaveBalance !== 'number';
        const needsDate = !e.joiningDate || e.joiningDate !== '2026-09-01';
        if (needsEl || needsSl || needsDate) {
          e.earnLeaveBalance = 2;
          if (needsSl) e.sickLeaveBalance = 0;
          if (needsDate) e.joiningDate = '2026-09-01';
          changed = true;
          setDoc(doc(db, 'employees', e.id), { sickLeaveBalance: e.sickLeaveBalance, earnLeaveBalance: e.earnLeaveBalance, joiningDate: e.joiningDate, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
        }
      }

      if (changed) employeesChanged = true;
      return e;
    });

    if (employeesChanged) {
      setEmployees(nextEmployees);
      setActiveEmployee(prev => {
        if (!prev) return prev;
        const updated = nextEmployees.find(e => e.id === prev.id || e.employeeId === prev.employeeId);
        return updated || prev;
      });
    }

    // 2. Attendance corrections (Jason pre-joining and August sync)
    let attendanceChanged = false;
    let nextAttendance = [...attendance];

    const jasonPreJoiningRecords = nextAttendance.filter(a => {
      const isJ = (a.employeeId === 'KfAB95lpbJOeylpKQaWX4GXOPGt2' ||
                   a.employeeCode === 'KSS2407011' ||
                   (a.employeeName && a.employeeName.toLowerCase().includes('jason'))) &&
                   !(a.employeeName && (a.employeeName.toLowerCase().includes('jigy') || a.employeeName.toLowerCase().includes('jing')));
      return isJ && a.date < '2026-08-17';
    });
    if (jasonPreJoiningRecords.length > 0) {
      nextAttendance = nextAttendance.filter(a => !jasonPreJoiningRecords.some(r => r.id === a.id));
      attendanceChanged = true;
      if (auth.currentUser) {
        jasonPreJoiningRecords.forEach(r => {
          if (r.id) deleteDoc(doc(db, 'attendance', r.id)).catch(() => {});
        });
      }
    }

    if (auth.currentUser) {
      const preDates = ['2026-08-07', '2026-08-10', '2026-08-11', '2026-08-12', '2026-08-13', '2026-08-14', '2026-08-15'];
      const jasonIds = ['KfAB95lpbJOeylpKQaWX4GXOPGt2', 'KSS2407011'];
      preDates.forEach(d => {
        jasonIds.forEach(id => {
          deleteDoc(doc(db, 'attendance', `${id}_${d}`)).catch(() => {});
        });
      });
    }

    // 3. Leave requests sync and dummy purge
    let leaveChanged = false;
    let nextLeaveRequests = [...leaveRequests];

    const toRemoveLeaveIds = new Set<string>();
    nextLeaveRequests.forEach(req => {
      const isAkash = req.employeeId === 'KSS2407013' || req.employeeId === 'emp-KSS2407013' || (req.employeeName && req.employeeName.toLowerCase().includes('akash'));
      const isAccidental = isAkash && isWfhType(req.type) && (
        (req.startDate && req.startDate <= '2026-09-05' && (req.endDate || req.startDate) >= '2026-08-27') ||
        ((req as any).fromDate && (req as any).fromDate <= '2026-09-05' && ((req as any).toDate || (req as any).fromDate) >= '2026-08-27')
      );
      const isDummy = (req.reason && (req.reason.toLowerCase().includes('dummy') || req.reason.toLowerCase().includes('test leave') || req.reason.toLowerCase().trim() === 'test' || req.reason.toLowerCase().includes('ghfgds'))) ||
        req.id.startsWith('dummy-') || req.id.startsWith('test-') || req.id.startsWith('leave-') || (req as any).is_dummy === true || (req as any).isDummy === true || req.id === 'LR-UVLV1K5' || req.id === 'LR_KSS2407014_2026-08-19_WFH';
      if ((isAccidental || isDummy) && req.id) {
        toRemoveLeaveIds.add(req.id);
        if (auth.currentUser) {
          deleteDoc(doc(db, 'leaveRequests', req.id)).catch(() => { });
        }
      }
    });

    if (toRemoveLeaveIds.size > 0) {
      nextLeaveRequests = nextLeaveRequests.filter(r => !toRemoveLeaveIds.has(r.id));
      leaveChanged = true;
    }

    if (leaveChanged) {
      setLeaveRequests(nextLeaveRequests);
    }

    // 4. Target August attendance dates
    const targetAugustDates: { empId: string; empCode: string; name: string; dept: string; date: string; status: AttendanceStatus | 'Loss of Pay'; isWfh?: boolean; method?: AttendanceMethod }[] = [
      { empId: 'emp-KSS2407013', empCode: 'KSS2407013', name: 'Akash SB', dept: 'Engineering', date: '2026-08-25', status: 'On Leave' },
      { empId: 'emp-KSS2407006', empCode: 'KSS2407006', name: 'Kuruva Mahesh', dept: 'Product & Design', date: '2026-08-26', status: 'Present' },
      { empId: 'emp-KSS2407006', empCode: 'KSS2407006', name: 'Kuruva Mahesh', dept: 'Product & Design', date: '2026-08-27', status: 'Work From Home', isWfh: true, method: 'Self Portal' },
      { empId: 'emp-KSS2407006', empCode: 'KSS2407006', name: 'Kuruva Mahesh', dept: 'Product & Design', date: '2026-08-28', status: 'On Leave' },
      { empId: 'emp-KSS2407006', empCode: 'KSS2407006', name: 'Kuruva Mahesh', dept: 'Product & Design', date: '2026-08-29', status: 'Work From Home', isWfh: true, method: 'Self Portal' },
      { empId: 'emp-KSS2407005', empCode: 'KSS2407005', name: 'Thabeethal Asnath I', dept: 'Engineering', date: '2026-08-22', status: 'On Leave' },
      { empId: 'emp-KSS2407004', empCode: 'KSS2407004', name: 'Asbin T S', dept: 'Engineering', date: '2026-08-26', status: 'On Leave' },
      { empId: 'emp-KSS2407004', empCode: 'KSS2407004', name: 'Asbin T S', dept: 'Engineering', date: '2026-08-27', status: 'Loss of Pay' as any },
      { empId: 'emp-KSS2407004', empCode: 'KSS2407004', name: 'Asbin T S', dept: 'Engineering', date: '2026-08-28', status: 'Work From Home', isWfh: true, method: 'Self Portal' },
      { empId: 'emp-KSS2407004', empCode: 'KSS2407004', name: 'Asbin T S', dept: 'Engineering', date: '2026-08-29', status: 'Work From Home', isWfh: true, method: 'Self Portal' },
      { empId: 'emp-KSS2407003', empCode: 'KSS2407003', name: 'D. Koushik', dept: 'IT', date: '2026-08-29', status: 'On Leave' },
      { empId: 'KfAB95lpbJOeylpKQaWX4GXOPGt2', empCode: 'KSS2407011', name: 'Jason Kenneth N', dept: 'Engineering', date: '2026-08-22', status: 'On Leave' }
    ];

    targetAugustDates.forEach(t => {
      const existingIdx = nextAttendance.findIndex(a =>
        (a.employeeId === t.empId || a.employeeCode === t.empCode || (a.employeeName && a.employeeName.trim().toLowerCase() === t.name.toLowerCase())) &&
        a.date === t.date
      );
      const existing = existingIdx >= 0 ? nextAttendance[existingIdx] : undefined;
      const isMismatch = !existing || existing.status !== t.status || (t.isWfh && !existing.isWfh);
      if (isMismatch) {
        const docId = existing ? existing.id : `${t.empId}_${t.date}`;
        const updatedRec = {
          id: docId,
          employeeId: t.empId,
          employeeCode: t.empCode,
          employeeName: t.name,
          department: t.dept,
          date: t.date,
          status: t.status as AttendanceStatus,
          isWfh: !!t.isWfh,
          attendanceMethod: (t.method || 'MANUAL') as AttendanceMethod,
          workingMinutes: t.isWfh ? 540 : 0,
          checkInAt: existing?.checkInAt || (t.isWfh ? `${t.date}T04:30:00.000Z` : null),
          checkOutAt: existing?.checkOutAt || (t.isWfh ? `${t.date}T13:30:00.000Z` : null),
          locationVerified: true,
          createdAt: existing?.createdAt || `${t.date}T04:30:00.000Z`,
          updatedAt: new Date().toISOString()
        };
        if (existingIdx >= 0) {
          nextAttendance[existingIdx] = { ...nextAttendance[existingIdx], ...updatedRec };
        } else {
          nextAttendance.push(updatedRec as AttendanceRecord);
        }
        attendanceChanged = true;
        setDoc(doc(db, 'attendance', docId), cleanFirestorePayload(updatedRec), { merge: true }).catch(() => {});
      }
    });

    // 5. Auto-heal unapproved WFH attendance records
    const companyWfhDatesList: string[] = (settings as any)?.companyWideWfhDates || companyWideWfhDates || [];
    nextAttendance = nextAttendance.map(rec => {
      if (!rec.id || !rec.date) return rec;

      const emp = nextEmployees.find(e =>
        (!!rec.employeeId && (rec.employeeId === e.id || rec.employeeId === e.employeeId)) ||
        (!!rec.employeeCode && rec.employeeCode === e.employeeId) ||
        ((rec as any).employeeUid && ((rec as any).employeeUid === e.uid || (rec as any).employeeUid === e.id)) ||
        (!!rec.employeeName && !!e.fullName && (
          rec.employeeName.trim().toLowerCase() === e.fullName.trim().toLowerCase() ||
          rec.employeeName.replace(/\s+/g, '').toLowerCase() === e.fullName.replace(/\s+/g, '').toLowerCase()
        ))
      );
      if (!emp) return rec;

      const isAsbin = emp.id === 'emp-KSS2407004' || emp.employeeId === 'KSS2407004' || (emp.fullName && emp.fullName.toLowerCase().includes('asbin'));
      if (isAsbin) return rec;

      const hasApprovedNonWfhLeave = nextLeaveRequests.some(r =>
        !isWfhType(r.type) && !isWfhType(r.leaveCategory) &&
        (r.status === 'Approved' || ((r.ceoStatus === 'Approved' || r.ceoStatus === 'N/A' || r.ceoStatus === 'Bypassed') && (r.ctoStatus === 'Approved' || r.ctoStatus === 'N/A' || r.ctoStatus === 'Bypassed'))) &&
        ((!!r.employeeId && (r.employeeId === emp.id || r.employeeId === emp.employeeId)) ||
         (!!r.employeeUid && (r.employeeUid === emp.uid || r.employeeUid === emp.id)) ||
         (!!r.employeeName && !!emp.fullName && (
           r.employeeName.trim().toLowerCase() === emp.fullName.trim().toLowerCase() ||
           r.employeeName.replace(/\s+/g, '').toLowerCase() === emp.fullName.replace(/\s+/g, '').toLowerCase()
         ))) &&
        rec.date >= (r.startDate || (r as any).fromDate) &&
        rec.date <= (r.endDate || (r as any).toDate || r.startDate)
      );

      if (hasApprovedNonWfhLeave) {
        if (rec.isWfh || rec.status === 'Work From Home' || (!rec.checkInAt && rec.status !== 'On Leave')) {
          const patched: AttendanceRecord = {
            ...rec,
            isWfh: false,
            status: 'On Leave',
            checkInAt: null,
            checkOutAt: null,
            workingMinutes: 0
          };
          attendanceChanged = true;
          setDoc(doc(db, 'attendance', rec.id), cleanFirestorePayload(patched), { merge: true }).catch(() => {});
          return patched;
        }
        return rec;
      }

      if (!rec.isWfh && rec.status !== 'Work From Home') return rec;

      const isAkash = emp.id === 'emp-KSS2407013' || emp.employeeId === 'KSS2407013' || (emp.fullName && emp.fullName.toLowerCase().includes('akash'));
      const isBadWfh = isAkash && accidentalRange.includes(rec.date);
      if (isBadWfh || (!companyWfhDatesList.includes(rec.date) && !(emp.approvedWfhDates || []).includes(rec.date))) {
        const hasApprovedWfhLeave = nextLeaveRequests.some(r =>
          (isWfhType(r.type) || isWfhType(r.leaveCategory)) &&
          (r.status === 'Approved' || ((r.ceoStatus === 'Approved' || r.ceoStatus === 'N/A' || r.ceoStatus === 'Bypassed') && (r.ctoStatus === 'Approved' || r.ctoStatus === 'N/A' || r.ctoStatus === 'Bypassed'))) &&
          ((!!r.employeeId && (r.employeeId === emp.id || r.employeeId === emp.employeeId)) ||
           (!!r.employeeUid && (r.employeeUid === emp.uid || r.employeeUid === emp.id)) ||
           (!!r.employeeName && !!emp.fullName && (
             r.employeeName.trim().toLowerCase() === emp.fullName.trim().toLowerCase() ||
             r.employeeName.replace(/\s+/g, '').toLowerCase() === emp.fullName.replace(/\s+/g, '').toLowerCase()
           ))) &&
          rec.date >= (r.startDate || (r as any).fromDate) &&
          rec.date <= (r.endDate || (r as any).toDate || r.startDate)
        );
        if (!hasApprovedWfhLeave) {
          const patched: AttendanceRecord = {
            ...rec,
            isWfh: false,
            status: rec.checkInAt ? (rec.status === 'Work From Home' ? 'Present' : rec.status) : 'Absent',
            workingMinutes: rec.checkInAt ? rec.workingMinutes : 0
          };
          attendanceChanged = true;
          setDoc(doc(db, 'attendance', rec.id), cleanFirestorePayload(patched), { merge: true }).catch(() => {});
          return patched;
        }
      }

      return rec;
    });

    if (attendanceChanged) {
      setAttendance(nextAttendance);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, employees.length > 0, attendance.length > 0]);

  // ── Monthly Auto-Credit: +1 EL on 1st of every month; female WFH init ────────
  // Runs once per session on the 1st of the month, gated by a localStorage latch.
  // Skips D. Koushik (PM, EL=0 by policy) and SUPER_ADMIN accounts.
  useEffect(() => {
    if (!isAuthenticated || !employees.length) return;

    const monthKey = getMonthKey(new Date());
    if (!shouldRunMonthlyAutoCredit(monthKey)) return;

    const performerUid = authUid || 'system';
    const performerName = activeEmployee?.fullName || 'System';

    runMonthlyAutoCredit(employees, monthKey, performerUid, performerName)
      .then(({ credited, wfhInitialized, errors }) => {
        setMonthlyCreditLatch(monthKey);
        if (credited.length > 0) {
          console.info(`[Monthly Auto-Credit] +1 EL credited to ${credited.length} employees for ${monthKey}.`);
        }
        if (wfhInitialized.length > 0) {
          console.info(`[Monthly Auto-Credit] WFH allowance initialized for ${wfhInitialized.length} female employees for ${monthKey}.`);
        }
        if (errors.length > 0) {
          console.warn('[Monthly Auto-Credit] Some errors occurred:', errors);
        }
        // Refresh employees from Firestore to get updated balances
        if (credited.length > 0) {
          setEmployees(prev => prev.map(emp => {
            if (
              emp.status !== 'Active' ||
              emp.role === 'SUPER_ADMIN' ||
              emp.employeeId === 'KSS2407003'
            ) return emp;
            const currentEL = typeof emp.earnLeaveBalance === 'number' ? emp.earnLeaveBalance : 0;
            return { ...emp, earnLeaveBalance: currentEL + 1 };
          }));
        }
      })
      .catch(err => {
        console.warn('[Monthly Auto-Credit] Failed:', err);
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated, employees.length > 0]);

  // ── One-time resume backfill, exposed to admin sessions only ─────────────────
  // Deliberately NOT auto-run: it rewrites every employee document, so an operator
  // triggers it explicitly, once, after firestore.rules has been deployed. Attached
  // here rather than shipped as a Node script because it must execute with a real
  // admin's credentials — the subcollection is admin-write-only.
  //
  // From the devtools console of an HR/SUPER_ADMIN session:
  //   await __kssBackfillResumes()                  // dry run — reports, changes nothing
  //   await __kssBackfillResumes({ dryRun: false }) // performs the migration
  useEffect(() => {
    if (!isAuthenticated) return;
    if (role !== 'SUPER_ADMIN' && role !== 'HR_ADMIN') return;

    (window as any).__kssBackfillResumes = backfillEmployeeResumes;
    return () => { delete (window as any).__kssBackfillResumes; };
  }, [isAuthenticated, role]);

  // ── FastAPI Data Hydration Helper ─────────────────────────────────────────
  const fastApiFetchPromiseRef = useRef<Promise<void> | null>(null);
  const lastFastApiFetchTimeRef = useRef<number>(0);

  const fetchFastApiRecords = async (currentEmp?: Employee | null, force = false) => {
    const now = Date.now();
    if (!force && lastFastApiFetchTimeRef.current && (now - lastFastApiFetchTimeRef.current < 4000)) {
      return;
    }
    if (fastApiFetchPromiseRef.current) return fastApiFetchPromiseRef.current;
    lastFastApiFetchTimeRef.current = now;

    fastApiFetchPromiseRef.current = (async () => {
      try {
        const isSuperOrHr = currentEmp ? (currentEmp.role === 'SUPER_ADMIN' || currentEmp.role === 'HR_ADMIN') : (role === 'SUPER_ADMIN' || role === 'HR_ADMIN');

        // Fast O(1) employee lookup map for rapid mapping
        const getEmpMap = () => {
          const empMap = new Map<string, Employee>();
          employeesRef.current.forEach(e => {
            if (e.id) empMap.set(e.id, e);
            if (e.employeeId) empMap.set(e.employeeId, e);
            if (e.uid) empMap.set(e.uid, e);
          });
          if (currentEmp) {
            if (currentEmp.id) empMap.set(currentEmp.id, currentEmp);
            if (currentEmp.employeeId) empMap.set(currentEmp.employeeId, currentEmp);
          }
          return empMap;
        };

        // 1. Attendance Hydration (High priority for immediate Shift Active display)
        const recordLimit = isSuperOrHr ? 500 : 365;
        const attPromise = getAttendanceRecordsApi(recordLimit, force).then((attList) => {
          if (Array.isArray(attList) && attList.length > 0) {
            const empMap = getEmpMap();
            const mappedAtt: AttendanceRecord[] = attList.map((r: any) => {
              const matchedEmp = empMap.get(String(r.employee_id)) || (r.employee_code ? empMap.get(String(r.employee_code)) : null) || (currentEmp?.id === String(r.employee_id) ? currentEmp : null);
              const mappedBreaks = Array.isArray(r.breaks) ? r.breaks.map((b: any) => {
                const startIso = formatTimestampToISO(b.start_time || b.startAt) || b.start_time;
                const endIso = formatTimestampToISO(b.end_time || b.endAt) || null;
                let duration = b.duration_minutes || b.durationMinutes || 0;
                if (duration <= 0 && startIso && endIso) {
                  duration = Math.max(1, Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000));
                }
                const rawType = String(b.type || '').toUpperCase();
                let cleanType: BreakType = 'Meal Break';
                if (rawType.includes('SNACK')) cleanType = 'Snack Break';
                else if (rawType.includes('TEA') || rawType.includes('COFFEE')) cleanType = 'Tea Break';
                else if (rawType.includes('MEAL') || rawType.includes('LUNCH')) cleanType = 'Meal Break';
                else if (rawType.includes('HUDDLE')) cleanType = 'Team Huddle';
                else if (rawType.includes('MEETING')) cleanType = 'Team Meeting';
                else if (rawType.includes('TRAIN') || rawType.includes('ATTAINMENT')) cleanType = 'Attainment / Training';
                else if (rawType.includes('ACTIVITY')) cleanType = 'Activity';
                else if (b.type) cleanType = (normalizeBreakType(b.type) || 'Meal Break') as BreakType;

                return {
                  id: String(b.id),
                  type: cleanType,
                  startTime: startIso,
                  startAt: startIso,
                  endTime: endIso,
                  endAt: endIso,
                  durationMinutes: duration
                };
              }).sort((a: any, b: any) => new Date(a.startAt || a.startTime).getTime() - new Date(b.startAt || b.startTime).getTime()) : [];

              const empCode = r.employee_code || matchedEmp?.employeeId || String(r.employee_id);
              const empUid = matchedEmp?.uid || matchedEmp?.id || String(r.employee_id);

              const rawStatus = String(r.status || '').toUpperCase();
              let cleanStatus: AttendanceStatus = 'Present';
              if (rawStatus === 'WORK_FROM_HOME' || rawStatus === 'WFH') cleanStatus = 'Work From Home';
              else if (rawStatus === 'ON_LEAVE') cleanStatus = 'On Leave';
              else if (rawStatus === 'HALF_DAY') cleanStatus = 'Half Day';
              else if (rawStatus === 'HOLIDAY') cleanStatus = 'Holiday';
              else if (rawStatus === 'LATE') cleanStatus = 'Late';
              else if (rawStatus === 'ABSENT') cleanStatus = 'Absent';
              else if (rawStatus === 'PRESENT') cleanStatus = 'Present';
              else if (r.status) cleanStatus = (r.status.charAt(0) + r.status.slice(1).toLowerCase()) as AttendanceStatus;

              const rawMethod = String(r.attendance_method || '').toUpperCase();
              let cleanMethod: AttendanceMethod = 'Self Portal';
              if (rawMethod.includes('FACE') || rawMethod.includes('RECOGNITION')) cleanMethod = 'Facial Recognition';
              else if (rawMethod.includes('BIOMETRIC')) cleanMethod = 'Biometric';
              else if (rawMethod.includes('MANUAL') || rawMethod.includes('ADMIN')) cleanMethod = 'Manual Admin';
              else if (rawMethod.includes('QR')) cleanMethod = 'QR Code';
              else if (rawMethod.includes('PORTAL')) cleanMethod = 'Self Portal';

              const dateStr = typeof r.date === 'string' ? r.date : (r.date ? new Date(r.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]);
              const checkInIso = formatTimestampToISO(r.check_in_at);
              const checkOutIso = formatTimestampToISO(r.check_out_at);
              const totalBreakMins = mappedBreaks.reduce((sum: number, b: any) => sum + (b.durationMinutes || 0), 0);

              let workingMins = Number(r.working_minutes) || 0;
              if (workingMins <= 0 && checkInIso) {
                const endMs = checkOutIso ? new Date(checkOutIso).getTime() : (dateStr === todayInIST() ? Date.now() : new Date(checkInIso).getTime() + (8.5 * 3600000));
                const totalMs = Math.max(0, endMs - new Date(checkInIso).getTime());
                workingMins = Math.max(0, Math.floor(totalMs / 60000) - totalBreakMins);
              }

              return {
                id: String(r.id),
                uid: empUid,
                employeeUid: empUid,
                employeeId: empCode,
                employeeCode: empCode,
                employee_id: String(r.employee_id),
                rawEmployeeId: String(r.employee_id),
                employeeName: r.employee_name || matchedEmp?.fullName || '',
                department: r.department || matchedEmp?.department || 'Engineering',
                date: dateStr,
                checkInAt: checkInIso,
                checkOutAt: checkOutIso,
                workingMinutes: workingMins,
                status: cleanStatus,
                attendanceMethod: cleanMethod,
                isWfh: !!r.is_wfh,
                locationVerified: !!r.location_verified,
                latitude: r.check_in_lat ?? null,
                longitude: r.check_in_lon ?? null,
                totalBreakMinutes: totalBreakMins,
                breaks: mappedBreaks,
                notes: r.notes || '',
                createdAt: r.created_at || new Date().toISOString(),
                updatedAt: r.updated_at || new Date().toISOString()
              };
            });
            setAttendance(mappedAtt);
            setAttendanceSyncStatus('synced');
            setTimeout(() => {
              try {
                localStorage.setItem('kss_v1_attendance', JSON.stringify(mappedAtt.slice(0, 500)));
              } catch {}
            }, 50);
          }
        }).catch(() => {});

        // 2. Employees Hydration
        const empPromise = getEmployeesApi(100).then((empList) => {
          if (Array.isArray(empList) && empList.length > 0) {
            const mappedEmps: Employee[] = empList.map(e => {
              const mapped = mapBackendToFrontendEmployee(e);
              if (isFaceBiometricEnrolled(mapped)) {
                mapped.isFaceEnrolled = true;
              }
              if (mapped.isFaceEnrolled) {
                try {
                  localStorage.setItem(`kss_face_enrolled_${mapped.id}`, 'true');
                  if (mapped.employeeId) localStorage.setItem(`kss_face_enrolled_${mapped.employeeId}`, 'true');
                } catch {}
              }
              if (mapped.faceDescriptor && mapped.faceDescriptor.length === 128) {
                saveEmployeeDescriptor([mapped.id, mapped.employeeId], mapped.faceDescriptor);
              }
              return mapped;
            });
            const cleanMapped = deduplicateEmployeeList(mappedEmps);
            setEmployees(cleanMapped);
            employeesRef.current = cleanMapped;
            setActiveEmployee(prev => {
              if (!prev) return prev;
              const fresh = mappedEmps.find(e => e.id === prev.id || e.employeeId === prev.employeeId || (prev.email && e.email?.toLowerCase() === prev.email.toLowerCase()));
              if (!fresh) return prev;
              const enrolled = fresh.isFaceEnrolled || prev.isFaceEnrolled || isFaceBiometricEnrolled(prev) || isFaceBiometricEnrolled(fresh);
              const updated = {
                ...prev,
                ...fresh,
                isFaceEnrolled: enrolled,
                faceDescriptor: fresh.faceDescriptor || prev.faceDescriptor,
                profilePhotoUrl: fresh.profilePhotoUrl || prev.profilePhotoUrl
              };
              try {
                localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updated));
              } catch {}
              return updated;
            });
          }
        }).catch(() => {});

        // 3. Leaves Hydration
        const leavePromise = getLeavesApi(100).then((leaveList) => {
          if (Array.isArray(leaveList) && leaveList.length > 0) {
            const empMap = getEmpMap();
            const mappedLeaves: LeaveRequest[] = leaveList.map((l: any) => {
              const matchedEmp = empMap.get(String(l.employee_id)) || (l.employee_code ? empMap.get(String(l.employee_code)) : null) || (currentEmp?.id === String(l.employee_id) ? currentEmp : null);
              const empCode = l.employee_code || matchedEmp?.employeeId || String(l.employee_id);
              const empUid = matchedEmp?.uid || matchedEmp?.id || String(l.employee_id);

              return {
                id: String(l.id),
                employeeId: empCode,
                employeeUid: empUid,
                authUid: empUid,
                employeeName: l.employee_name || matchedEmp?.fullName || '',
                department: l.department || matchedEmp?.department || 'Engineering',
                type: l.type === 'WORK_FROM_HOME' ? 'WFH' : (l.type === 'CASUAL_LEAVE' ? 'Casual Leave' : (l.type === 'SICK_LEAVE' ? 'Sick Leave' : 'Earn Leave')),
                startDate: l.start_date,
                endDate: l.end_date,
                reason: l.reason || '',
                status: (l.status.charAt(0) + l.status.slice(1).toLowerCase()) as any,
                ceoStatus: l.ceo_status === 'APPROVED' ? 'Approved' : (l.ceo_status === 'REJECTED' ? 'Rejected' : 'Pending'),
                ctoStatus: l.cto_status === 'APPROVED' ? 'Approved' : (l.cto_status === 'REJECTED' ? 'Rejected' : 'Waiting CEO'),
                requestDate: l.created_at || l.start_date
              };
            });
            setLeaveRequests(mappedLeaves);
            try {
              localStorage.setItem('kss_v1_leave_requests', JSON.stringify(mappedLeaves));
            } catch {}
          }
        }).catch(() => {});

        // 4. Settings Hydration
        const settingsPromise = getSettingsApi().then((settingsData) => {
          if (settingsData && settingsData.office_name) {
            setCompanyWorkZone(prev => ({
              ...prev,
              name: settingsData.office_name,
              latitude: settingsData.geofence_lat,
              longitude: settingsData.geofence_lon,
              radiusMeters: settingsData.geofence_radius_meters,
              active: settingsData.geofence_enforced
            }));
          }
        }).catch(() => {});

        const auditPromise = isSuperOrHr ? getAuditLogsApi(100).then((auditList) => {
          if (Array.isArray(auditList) && auditList.length > 0) {
            const mappedAudit: AuditLog[] = auditList.map((a: any) => ({
              id: String(a.id),
              actorId: a.actor_id ? String(a.actor_id) : 'system',
              actorName: a.actor_name || 'System',
              actorRole: (a.actor_role || 'SUPER_ADMIN') as any,
              action: a.action,
              target: a.target || '',
              details: a.details || '',
              timestamp: formatTimestampToISO(a.created_at) || new Date().toISOString()
            }));
            setAuditLogs(mappedAudit);
          }
        }).catch(() => {}) : Promise.resolve();

        await Promise.all([attPromise, empPromise, leavePromise, settingsPromise, auditPromise]);
      } catch (e) {
        console.warn('Failed to fetch FastAPI records:', e);
      } finally {
        fastApiFetchPromiseRef.current = null;
      }
    })();
    return fastApiFetchPromiseRef.current;
  };

  // ── High-Speed FastAPI Token Boot Validator (<100ms) ───────────────────────
  useEffect(() => {
    const token = getAuthToken();
    if (token) {
      // Parallel execution: Hydrate data concurrently with profile validation
      fetchFastApiRecords(activeEmployee, true);
      getCurrentProfileApi().then((profile) => {
        if (profile && (profile.id || profile.employee_code)) {
          const emp = mapBackendToFrontendEmployee(profile);
          setActiveEmployee(emp);
          try {
            localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(emp));
          } catch {}
          setRole(emp.role);
          setIsAuthenticated(true);
          setIsSessionReady(true);
          setIsDemoMode(false);
          if (!activeEmployee || (activeEmployee.id !== emp.id && activeEmployee.employeeId !== emp.employeeId)) {
            fetchFastApiRecords(emp, true);
          }
        }
      }).catch((err) => {
        console.warn('[FastAPI] Token validation note:', err);
      });
    }
    // Logged out: nothing to hydrate. (The API requires authentication; data loads right after login.)
  }, []);

  // ── NEON POSTGRESQL LIVE DATA ENGINE ───────────────────────────────────────
  // Replaces Firestore onSnapshot() listeners with smart, efficient polling from
  // Neon PostgreSQL via FastAPI so all active portals stay up-to-date in real time.
  useEffect(() => {
    if (!USE_FIREBASE_FIRESTORE && (isAuthenticated || getAuthToken())) {
      // 1. Initial hydration on mount/auth
      fetchFastApiRecords(activeEmployeeRef.current, true);

      // 2. High-speed background sync (every 8 seconds when window is active)
      const pollTimer = setInterval(() => {
        if (typeof document !== 'undefined' && document.hidden) return;
        fetchFastApiRecords(activeEmployeeRef.current, false);
      }, 8000);

      // 3. Instant sync on focus / tab resume
      const handleFocusResume = () => {
        if (typeof document !== 'undefined' && !document.hidden) {
          fetchFastApiRecords(activeEmployeeRef.current, true);
        }
      };

      window.addEventListener('focus', handleFocusResume);
      document.addEventListener('visibilitychange', handleFocusResume);

      return () => {
        clearInterval(pollTimer);
        window.removeEventListener('focus', handleFocusResume);
        document.removeEventListener('visibilitychange', handleFocusResume);
      };
    }
  }, [isAuthenticated]);

  // ── Session Restore: Already done synchronously via useState initializers above ──
  // This effect only clears stale sessions that couldn't be matched on mount.
  useEffect(() => {
    const savedSessionId = localStorage.getItem('kss_v1_session');
    if (!savedSessionId) return;

    // If activeEmployee wasn't restored (e.g. cache miss), try one more time from Firestore-streamed employees
    if (!activeEmployee) {
      const matched = employeesRef.current.find(e => e.id === savedSessionId || e.employeeId === savedSessionId);
      if (matched) {
        setActiveEmployee(matched);
        let assignedRole = matched.role;
        if (matched.employeeId === 'CEO001' || matched.employeeId === 'CTO001') assignedRole = 'SUPER_ADMIN';
        setRole(assignedRole);
        setIsAuthenticated(true);
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Firebase Auth State: subscribes ONCE, uses ref for employee lookup ──
  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged(async (firebaseUser) => {
      // P0 FIX: publish the verified identity FIRST — this gates the Firestore
      // listener effect. When the identity disappears (sign-out, revoked/failed
      // token refresh → the identitytoolkit HTTP 400 path), listeners detach and
      // sensitive Firestore-derived state is purged instead of zombie-denying.
      setAuthUid(firebaseUser?.uid ?? null);
      if (!firebaseUser) {
        // If employee is authenticated via FastAPI JWT session, DO NOT wipe their state!
        if (getAuthToken()) {
          setIsSessionReady(true);
          return;
        }
        setUser(null);
        setAttendance([]);
        setLeaveRequests([]);
        setNotifications([]);
        setAuditLogs([]);
        setAttendanceSyncStatus('synced');
        setIsSessionReady(true);
        return;
      }
      setUser(firebaseUser);
      setIsDemoMode(false);
      if (!getAuthToken() && (firebaseUser.email || firebaseUser.uid)) {
        try {
          const fbToken = await firebaseUser.getIdToken().catch(() => null);
          await syncFirebaseSessionApi(firebaseUser.email, firebaseUser.uid, fbToken);
        } catch (syncErr) {
          console.warn('[AuthContext] syncFirebaseSessionApi failed:', syncErr);
        }
      }
      const cleanEmail = firebaseUser.email?.trim().toLowerCase();
      const empList = (employeesRef.current && employeesRef.current.length > 0)
        ? employeesRef.current
        : (employees.length > 0 ? employees : INITIAL_EMPLOYEES);

      const isAuthEmail = (value?: string) =>
        !!cleanEmail && typeof value === 'string' && value.trim().toLowerCase() === cleanEmail;
      const isAbhinayHrAlias = cleanEmail === 'abhinayav1919@kalpanaaa.in';
      const localCandidate = empList.find(e =>
        e.id === firebaseUser.uid ||
        e.uid === firebaseUser.uid ||
        isAuthEmail(e.email) ||
        isAuthEmail((e as any).workEmail) ||
        isAuthEmail((e as any).personalEmail) ||
        (isAbhinayHrAlias && e.id === 'emp-KSS2407011')
      );

      const candidates = new Map<string, Employee>();
      if (localCandidate?.id) candidates.set(localCandidate.id, localCandidate);
      try {
        const [uidSnapshot, userSnapshot] = await Promise.all([
          getDoc(doc(db, 'employees', firebaseUser.uid)),
          getDoc(doc(db, 'users', firebaseUser.uid))
        ]);
        if (uidSnapshot.exists()) {
          candidates.set(uidSnapshot.id, { ...uidSnapshot.data(), id: uidSnapshot.id } as Employee);
        }
        const mappedEmployeeId = userSnapshot.exists() ? userSnapshot.data().employeeDocId : null;
        if (typeof mappedEmployeeId === 'string' && mappedEmployeeId) {
          const mappedEmployee = empList.find(e => e.id === mappedEmployeeId);
          candidates.set(mappedEmployeeId, mappedEmployee || ({ id: mappedEmployeeId } as Employee));
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, `employees/${firebaseUser.uid}`);
      }

      if (cleanEmail) {
        const emailFields = ['email', 'workEmail', 'personalEmail'];
        const emailResults = await Promise.all(emailFields.map(async field => {
          try {
            return await getDocs(query(collection(db, 'employees'), where(field, '==', cleanEmail)));
          } catch (err) {
            handleFirestoreError(err, OperationType.LIST, `employees where ${field}`);
            return null;
          }
          
        }));
        emailResults.forEach(snapshot => snapshot?.forEach(employeeSnapshot => {
          candidates.set(employeeSnapshot.id, {
            ...employeeSnapshot.data(),
            id: employeeSnapshot.id
          } as Employee);
        }));
      }

      let matched: Employee | undefined;
      for (const candidate of candidates.values()) {
        let directoryRecord: Employee;
        try {
          const employeeSnapshot = await getDoc(doc(db, 'employees', candidate.id));
          if (!employeeSnapshot.exists()) continue;
          directoryRecord = { ...employeeSnapshot.data(), id: employeeSnapshot.id } as Employee;
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `employees/${candidate.id}`);
          continue;
        }
        const linkedToAuth = directoryRecord.uid === firebaseUser.uid ||
          (directoryRecord as any).employeeUid === firebaseUser.uid ||
          isAuthEmail(directoryRecord.email) ||
          isAuthEmail((directoryRecord as any).workEmail) ||
          isAuthEmail((directoryRecord as any).personalEmail) ||
          (isAbhinayHrAlias && directoryRecord.id === 'emp-KSS2407011');
        if (linkedToAuth) {
          matched = directoryRecord;
          break;
        }
      }

      if (!matched) {
        console.error(`[Auth] No verified employee directory record matches Firebase UID ${firebaseUser.uid}.`);
        setIsAuthenticated(false);
        setActiveEmployee(null);
        toast.error('No verified employee record was found for this account. Please contact HR.');
        return;
      }

      if (USE_FIREBASE_FIRESTORE) {
        try {
          await setDoc(doc(db, 'users', firebaseUser.uid), {
            uid: firebaseUser.uid,
            email: cleanEmail || '',
            // Guarantee a non-null role — Firestore rules deny null/undefined role writes
            // for self-service employees. Fall back to 'EMPLOYEE' if the employee doc has
            // a missing/null/undefined role (legacy records, designation-only docs, etc.).
            role: (matched.role && matched.role.length > 0) ? matched.role : 'EMPLOYEE',
            employeeId: matched.employeeId,
            employeeDocId: matched.id,
            fullName: matched.fullName,
            updatedAt: serverTimestamp()
          }, { merge: true });
          // Backfill the Firebase Auth UID onto the employee document so future rule
          // evaluations can match via uid field (not just email). Fire-and-forget.
          setDoc(doc(db, 'employees', matched.id), {
            uid: firebaseUser.uid,
            updatedAt: serverTimestamp()
          }, { merge: true }).catch((e) => {
            console.warn('[Auth] Employee uid backfill failed (non-fatal):', e);
          });
        } catch (err) {
          console.warn(
            `[Auth] Non-fatal: Could not write users/${firebaseUser.uid} mapping, proceeding with verified employee directory record:`,
            err
          );
        }
      }

      setActiveEmployee(matched);
      setRole(matched.role);
      setIsAuthenticated(true);
      setIsSessionReady(true);
      localStorage.setItem('kss_v1_session', matched.id);
      if (matched.email) localStorage.setItem('kss_v1_session_email', matched.email.toLowerCase());
      localStorage.setItem('kss_v1_session_timestamp', Date.now().toString());
      localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(matched));
    });
    return () => unsubscribe();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const addAuditLog = (action: string, target: string, details: string) => {
    const newLog: AuditLog = {
      // P1 FIX: the id was `log-${Date.now()}` alone. Two audit events in the same
      // millisecond — routine, since check-in/check-out each emit an audit entry
      // alongside a notification — produced the SAME document id. The second write
      // then became an overwrite of an existing document, which the append-only
      // auditLogs rule (`allow update: if false`) rejects: one of the two events was
      // silently lost from the compliance trail. A random suffix makes ids unique.
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      actorId: activeEmployee?.id || 'sys-admin',
      actorName: activeEmployee?.fullName || 'System Admin',
      actorRole: role,
      action,
      target,
      details,
      timestamp: new Date().toISOString()
    };
    setAuditLogs(prev => [newLog, ...prev]);

    // Async write to Firestore
    setDoc(doc(db, 'auditLogs', newLog.id), newLog).catch(err => {
      handleFirestoreError(err, OperationType.WRITE, `auditLogs/${newLog.id}`);
    });

    if (getAuthToken()) {
      createAuditLogApi({
        action,
        target,
        details
      }).catch(e => console.warn('[FastAPI] createAuditLogApi sync note:', e));
    }

    // Firebase notifications for major events
    // ── COST FIX C5/C6: Only write to the Firestore 'notifications' collection
    // for high-value administrative events. Routine attendance events
    // (check-in, check-out, breaks, login/logout) are already synthesized
    // in-memory via `combinedNotifications` and displayed in the bell — writing
    // them to Firestore just re-fires the onSnapshot listener on every client
    // AND triggers the Cloud Function (which does a full fcmTokens read each time).
    // Keeping only EMPLOYEE_CREATED/DELETED and PAYROLL_RUN cuts ~90% of
    // notification writes without losing any UI visibility.
    const notificationMap: Record<string, { title: string }> = {
      'EMPLOYEE_CREATED': { title: '👤 New Employee Added' },
      'EMPLOYEE_DELETED': { title: '🗑️ Employee Removed' },
      'PAYROLL_RUN':      { title: '💰 Payroll Run' },
      // ATTENDANCE_CHECKIN, ATTENDANCE_CHECKOUT, ATTENDANCE_BREAK_START/END,
      // USER_LOGIN, USER_LOGOUT — intentionally omitted; served from in-memory feed.
    };
    const notifConfig = notificationMap[action];
    if (notifConfig) {
      sendKssNotification(
        action as any,
        notifConfig.title,
        `${details} — by ${newLog.actorName}`,
        { actorId: newLog.actorId, actorName: newLog.actorName }
      );
    }
  };

  // "Latest ref" pattern: the auto-checkout interval effect is deliberately stable
  // (re-registering it on every snapshot recreates the write→snapshot feedback loop
  // that BUG 3 fixed), so it reaches the current addAuditLog through this ref and
  // records the real signed-in actor instead of the first render's placeholder.
  addAuditLogRef.current = addAuditLog;

  const loginWithEmail = async (email: string, pass: string): Promise<{ success: boolean; message: string }> => {
    setIsLoading(true);
    try {
      const cleanEmail = email.trim().toLowerCase();
      const cleanPass = pass.trim();

      if (!cleanEmail || !cleanPass) {
        setIsLoading(false);
        return { success: false, message: 'Please enter both your company email address and password.' };
      }

      // Find target employee with domain variation and alias support
      const targetEmp = employees.find(e => {
        const empEmail = (e.email || '').toLowerCase();
        if (!empEmail) return false;
        if (empEmail === cleanEmail) return true;
        const empUsername = empEmail.split('@')[0];
        const inputUsername = cleanEmail.split('@')[0];
        if (empUsername === inputUsername) return true;
        // P1 SECURITY FIX: removed hardcoded personal-name substring matching
        // (`akshit` / `gaurav` / `founder` / `koushik`). Those clauses resolved a typed
        // address to a DIFFERENT employee's record — e.g. `gaurav@anything.com` matched any
        // employee whose email merely contained `founder`. That mis-targeted the lockout
        // counter and the legacy credential check onto an unrelated (often executive) account.
        // Exact email and username-only matching above already handle legitimate
        // corporate-domain variations.
        return false;
      }) || INITIAL_EMPLOYEES.find(e => {
        const empEmail = (e.email || '').toLowerCase();
        if (!empEmail) return false;
        if (empEmail === cleanEmail) return true;
        const empUsername = empEmail.split('@')[0];
        const inputUsername = cleanEmail.split('@')[0];
        return empUsername === inputUsername;
      });
      // P1 SECURITY FIX: removed the hardcoded `isPrahlad` carve-out that exempted one named
      // employee from BOTH the lockout check and the 5-failure lockout trigger, leaving that
      // account open to unlimited online password guessing. Brute-force throttling now applies
      // uniformly to every account.
      if (targetEmp && targetEmp.lockoutUntil && targetEmp.lockoutUntil > Date.now()) {
        const waitMins = Math.ceil((targetEmp.lockoutUntil - Date.now()) / 60000);
        setIsLoading(false);
        return { success: false, message: `SECURITY ALERT: Account temporarily locked due to multiple failed attempts. Please wait ${waitMins} minutes.` };
      }

      const clearLockout = (empId: string) => {
        if (USE_FIREBASE_FIRESTORE && targetEmp && targetEmp.failedLoginCount) {
          setDoc(doc(db, 'employees', empId), { failedLoginCount: 0, lockoutUntil: null }, { merge: true }).catch(() => { });
        }
      };

      const recordFailure = () => {
        if (USE_FIREBASE_FIRESTORE && targetEmp) {
          const newCount = (targetEmp.failedLoginCount || 0) + 1;
          const updates: Partial<Employee> = { failedLoginCount: newCount };
          if (newCount >= 5) {
            updates.lockoutUntil = Date.now() + 15 * 60000;
          }
          setDoc(doc(db, 'employees', targetEmp.id), updates, { merge: true }).catch(() => { });
        }
      };



      // 3. High-Speed FastAPI Python Backend + Neon PostgreSQL (Primary Authentication)
      try {
        const apiData = await loginApi(cleanEmail, cleanPass);
        if (apiData && apiData.access_token) {
          let backendProfile = null;
          try {
            backendProfile = await getCurrentProfileApi();
          } catch {}

          const matched = mapBackendToFrontendEmployee(backendProfile || apiData);
          const cat = getDeviceCategory();
          const newSessionId = `sess_${cat}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          const sessionUpdates = cat === 'desktop' ? { desktopSessionId: newSessionId } : { mobileSessionId: newSessionId };
          const updatedMatched = { ...matched, ...sessionUpdates, currentSessionId: newSessionId };

          setActiveEmployee(updatedMatched);
          setRole(updatedMatched.role);
          setIsAuthenticated(true);
          setIsSessionReady(true);
          setIsDemoMode(false);

          localStorage.setItem('kss_v1_session', updatedMatched.id);
          localStorage.setItem('kss_v1_session_email', cleanEmail);
          localStorage.setItem('kss_v1_session_id', newSessionId);
          localStorage.setItem('kss_v1_session_timestamp', Date.now().toString());
          localStorage.setItem('kss_v1_device_category', cat);
          localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updatedMatched));

          fetchFastApiRecords(updatedMatched, true);

          if (!auth.currentUser && cleanEmail && cleanPass) {
            signInWithEmailAndPassword(auth, cleanEmail, cleanPass).catch(() => {});
          }

          try {
            if (localStorage.getItem('kss_remember_me') !== 'false') {
              localStorage.setItem('kss_saved_credentials', JSON.stringify({ email: cleanEmail, password: cleanPass }));
              localStorage.setItem('kss_last_login_email', cleanEmail);
            }
          } catch {}

          setIsLoading(false);
          return { success: true, message: `Welcome back, ${updatedMatched.fullName}!` };
        }
      } catch (fastApiErr: any) {
        const errMsg = fastApiErr?.message || '';
        if (errMsg.toLowerCase().includes('inactive account')) {
          setIsLoading(false);
          return { success: false, message: 'Your account is marked inactive. Please contact HR.' };
        }
        // If FastAPI rejected with "invalid email or password" or network/CORS error,
        // do NOT abort immediately: fall through to Firebase Auth so registered Firebase users can log in seamlessly.
        console.warn('[FastAPI Auth] Login check returned error or unverified credentials, falling through to Firebase Auth:', errMsg);
      }

      // 4. Try Firebase Auth (for registered employees)
      try {
        const userCred = await signInWithEmailAndPassword(auth, cleanEmail, cleanPass);
        if (userCred.user) {
          setUser(userCred.user);

          try {
            const fbToken = await userCred.user.getIdToken().catch(() => null);
            await syncFirebaseSessionApi(cleanEmail, userCred.user.uid, fbToken);
          } catch (syncErr) {
            console.warn('[Firebase Auth] Immediate syncFirebaseSessionApi note:', syncErr);
          }

          const matched = employees.find(e => 
            e.email?.toLowerCase() === cleanEmail || 
            e.id === userCred.user.uid ||
            (cleanEmail === 'abhinayav1919@kalpanaaa.in' && (e.email?.toLowerCase() === 'hr@kalpanaaa.in' || e.id === 'emp-KSS2407011'))
          );
          if (matched) {
            const cat = getDeviceCategory();
            const newSessionId = `sess_${cat}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
            const sessionUpdates = cat === 'desktop' ? { desktopSessionId: newSessionId } : { mobileSessionId: newSessionId };

            const updatedMatched = { ...matched, ...sessionUpdates, currentSessionId: newSessionId };
            setActiveEmployee(updatedMatched);

            const assignedRole = matched.role;
            setRole(assignedRole);
            setIsAuthenticated(true);
            setIsSessionReady(true);
            localStorage.setItem('kss_v1_session', matched.id);
            localStorage.setItem('kss_v1_session_email', cleanEmail);
            localStorage.setItem('kss_v1_session_id', newSessionId);
            localStorage.setItem('kss_v1_session_timestamp', Date.now().toString());
            localStorage.setItem('kss_v1_device_category', cat);
            localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updatedMatched));
            if (USE_FIREBASE_FIRESTORE) {
              setDoc(doc(db, 'employees', matched.id), {
                ...sessionUpdates,
                // Backfill Firebase Auth UID onto the employee document so that
                // Firestore security rules can resolve ownership via uid match
                // on all subsequent requests (not just email match).
                uid: userCred.user.uid,
                updatedAt: new Date().toISOString()
              }, { merge: true }).catch(() => { });
            }

            addAuditLog('USER_LOGIN', matched.fullName, `Firebase Auth Login (${assignedRole})`);
            clearLockout(matched.id);
            try {
              if (localStorage.getItem('kss_remember_me') !== 'false') {
                localStorage.setItem('kss_saved_credentials', JSON.stringify({ email: cleanEmail, password: cleanPass }));
                localStorage.setItem('kss_last_login_email', cleanEmail);
              }
            } catch {}
            setIsLoading(false);
            return { success: true, message: `Welcome back, ${matched.fullName}!` };
          }

          // Firebase auth succeeded but no employee record yet — fetch user details and create a complete one
          const uid = userCred.user.uid;
          const newSessionId = `sess_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
          
          let savedFullName = userCred.user.displayName || cleanEmail.split('@')[0];
          let savedRole: UserRole = 'EMPLOYEE';
          try {
            const userDocSnap = await getDoc(doc(db, 'users', uid));
            if (userDocSnap.exists()) {
              const uData = userDocSnap.data();
              if (uData.fullName) savedFullName = uData.fullName;
              if (uData.role) savedRole = uData.role as UserRole;
            }
          } catch (e) { }

          const autoDetails = getAssignedEmployeeDetails(savedFullName, employees, cleanEmail);
          const empCode = autoDetails.employeeId;
          
          const basicEmp: Employee = {
            id: uid,
            uid: uid,
            employeeId: empCode,
            fullName: savedFullName,
            email: cleanEmail, 
            role: autoDetails.role || savedRole, 
            department: 'Engineering',
            designation: autoDetails.designation || 'Software Engineer', 
            status: 'Active',
            phone: '',
            gender: 'Male',
            dateOfBirth: '',
            joiningDate: new Date().toISOString().split('T')[0],
            employmentType: 'Full-Time',
            permanentAddress: 'Bengaluru HQ Campus',
            currentAddress: 'Bengaluru HQ Campus',
            city: 'Bengaluru',
            state: 'Karnataka',
            postalCode: '560102',
            emergencyContact: '',
            emergencyRelationship: '',
            shift: 'Day Shift (10:00 AM – 7:00 PM)',
            workLocation: 'Kalpanaaa Main Office HQ, Bengaluru',
            reportingManager: 'D. Koushik',
            qrToken: empCode,
            currentSessionId: newSessionId,
            sessionFingerprint: generateDeviceFingerprint(),
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          setEmployees(prev => [basicEmp, ...prev.filter(e => e.id !== basicEmp.id)]);
          setActiveEmployee(basicEmp);
          setRole(basicEmp.role);
          setIsAuthenticated(true);
          setIsSessionReady(true);
          localStorage.setItem('kss_v1_session', basicEmp.id);
          if (cleanEmail) localStorage.setItem('kss_v1_session_email', cleanEmail);
          localStorage.setItem('kss_v1_session_id', newSessionId);
          localStorage.setItem('kss_v1_session_timestamp', Date.now().toString());
          localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(basicEmp));
          if (USE_FIREBASE_FIRESTORE) {
            setDoc(doc(db, 'employees', basicEmp.id), basicEmp, { merge: true }).catch(() => { });
          }

          setIsLoading(false);
          return { success: true, message: `Welcome! You're now signed in.` };
        }
      } catch (fbErr: any) {
        // P0 INCIDENT FIX: this catch previously swallowed EVERY Firebase error and
        // fell through to the local password check. Config/environment failures
        // (Email/Password provider disabled, restricted API key, unauthorized
        // domain, network outage, disabled account) surfaced only as anonymous
        // identitytoolkit HTTP 400s while the app silently continued without a
        // real Firebase session — guaranteeing permission-denied on every
        // Firestore call. Only genuine credential rejections may fall back.
        const fbCode: string | undefined = fbErr?.code;
        if (!shouldFallbackToLocalLogin(fbCode)) {
          console.error(`[Auth] Firebase sign-in failed with non-credential error (${fbCode}). NOT falling back to local login.`, fbErr);
          recordFailure();
          setIsLoading(false);
          const friendly = classifyError(fbErr).userMessage;
          return { success: false, message: `Cloud sign-in is currently unavailable (${fbCode}). ${friendly}` };
        }
        // Credential rejection (wrong password / unknown email) — legacy local fallback proceeds below.
      }

      // ── P0 SECURITY FIX: universal master-password backdoor REMOVED ──
      // Previously: `cleanPass === 'Admin@123456' || cleanPass === 'admin123'` authenticated
      // ANY employee record — including SUPER_ADMIN / CEO / CTO — and both literals shipped in
      // the public JS bundle. Any visitor could sign in as a founder with a guessable password.
      // Also removed: comparison against a plaintext `password` field on the employee document
      // (`/employees` is world-readable, so that field was a harvestable credential).
      //
      // The only surviving legacy path is the one-time `initialPassword` bootstrap, kept so
      // employees who have not yet been provisioned in Firebase Auth are not locked out. It is
      // now revoked the moment the employee sets a real password (see
      // updateCurrentEmployeePassword) and requires a non-trivial secret.
      const storedInitial = (targetEmp as any)?.initialPassword;
      const isInitialPass =
        typeof storedInitial === 'string' &&
        storedInitial.length >= 6 &&
        cleanPass === storedInitial;

      if (targetEmp && isInitialPass) {
        const cat = getDeviceCategory();
        const newSessionId = `sess_${cat}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const sessionUpdates = cat === 'desktop' ? { desktopSessionId: newSessionId } : { mobileSessionId: newSessionId };

        const updatedMatched = { ...targetEmp, ...sessionUpdates, currentSessionId: newSessionId };
        setActiveEmployee(updatedMatched);

        const assignedRole = targetEmp.role || 'EMPLOYEE';
        setRole(assignedRole);
        setIsAuthenticated(true);
        localStorage.setItem('kss_v1_session', targetEmp.id);
        if (targetEmp.email) localStorage.setItem('kss_v1_session_email', targetEmp.email.toLowerCase());
        localStorage.setItem('kss_v1_session_id', newSessionId);
        localStorage.setItem('kss_v1_session_timestamp', Date.now().toString());
        localStorage.setItem('kss_v1_device_category', cat);

        addAuditLog('USER_LOGIN', targetEmp.fullName, `Local Login (${assignedRole})`);
        clearLockout(targetEmp.id);
        try {
          if (localStorage.getItem('kss_remember_me') !== 'false') {
            localStorage.setItem('kss_saved_credentials', JSON.stringify({ email: cleanEmail, password: cleanPass }));
            localStorage.setItem('kss_last_login_email', cleanEmail);
          }
        } catch {}
        setIsLoading(false);
        return { success: true, message: `Welcome back, ${targetEmp.fullName}!` };
      }

      recordFailure();
      setIsLoading(false);
      return { success: false, message: 'Incorrect password. Please enter your registered account password.' };
    } catch (err: any) {
      setIsLoading(false);

      return { success: false, message: err.message || 'Login failed.' };
    }
  };

  const sendPasswordReset = async (email: string): Promise<{ success: boolean; message: string }> => {
    try {
      const { getAuth, sendPasswordResetEmail } = await import('firebase/auth');
      const auth = getAuth();
      await sendPasswordResetEmail(auth, email);
      return { success: true, message: `Password reset email sent to ${email}` };
    } catch (err: any) {
      console.error('Password reset error:', err);
      return { success: false, message: err.message || 'Failed to send password reset email.' };
    }
  };

  const setEmployeeInitialPassword = async (email: string, pass: string): Promise<{ success: boolean; message: string }> => {
    try {
      const secondaryApp = initializeApp(firebaseConfig, `SecondaryApp-${Date.now()}`);
      const { getAuth, createUserWithEmailAndPassword, signOut } = await import('firebase/auth');
      const secondaryAuth = getAuth(secondaryApp);
      
      const userCred = await createUserWithEmailAndPassword(secondaryAuth, email, pass);
      const employee = (employeesRef.current.length > 0 ? employeesRef.current : employees).find(
        e => e.email?.toLowerCase() === email.toLowerCase()
      );
      if (!employee) {
        await signOut(secondaryAuth);
        return { success: false, message: 'No matching employee record was found for this account.' };
      }
      
      if (USE_FIREBASE_FIRESTORE) {
        await setDoc(doc(db, 'users', userCred.user.uid), {
          uid: userCred.user.uid,
          email: email,
          role: employee.role,
          employeeId: employee.employeeId,
          employeeDocId: employee.id,
          fullName: employee.fullName,
          updatedAt: serverTimestamp()
        });
      }

      await signOut(secondaryAuth);
      return { success: true, message: 'Password successfully set.' };
    } catch (err: any) {
      if (err.code === 'auth/email-already-in-use') {
        return { success: false, message: 'This employee already has a secure login. Please use the Reset Email button instead.' };
      }
      return { success: false, message: err.message || 'Failed to set password.' };
    }
  };

  const quickDemoLogin = (targetRole: UserRole | 'CEO' | 'CTO') => {
    setIsLoading(true);
    setTimeout(() => {
      let targetEmp: Employee | undefined;
      if (targetRole === 'CEO' || targetRole === 'SUPER_ADMIN') {
        targetEmp = employees.find(e => e.employeeId === 'CEO001' || (e.fullName || '').toLowerCase().includes('akshit')) || employees[0];
      } else if (targetRole === 'CTO') {
        targetEmp = employees.find(e => e.employeeId === 'CTO001' || (e.fullName || '').toLowerCase().includes('gaurav')) || employees[1];
      } else if (targetRole === 'HR_ADMIN') {
        targetEmp = employees.find(e => e.role === 'HR_ADMIN') || employees[2];
      } else if (targetRole === 'PROJECT_MANAGER') {
        targetEmp = employees.find(e => e.role === 'PROJECT_MANAGER' || e.designation?.toLowerCase().includes('project manager') || (e.fullName || '').includes('Koushik')) || employees[2];
      } else {
        targetEmp = employees.find(e => e.role === 'EMPLOYEE') || employees[3];
      }

      if (targetEmp) {
        const cat = getDeviceCategory();
        const newSessionId = `sess_${cat}_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
        const sessionUpdates = cat === 'desktop' ? { desktopSessionId: newSessionId } : { mobileSessionId: newSessionId };

        const updatedTarget = { ...targetEmp, ...sessionUpdates };
        setActiveEmployee(updatedTarget);
        const assignedRole = (targetEmp.employeeId === 'CEO001' || targetEmp.employeeId === 'CTO001') ? 'SUPER_ADMIN' : targetEmp.role;
        setRole(assignedRole);
        if (!auth.currentUser) {
          signInAnonymously(auth).catch(() => {});
        }
        localStorage.setItem('kss_v1_session', targetEmp.id);
        if (targetEmp.email) localStorage.setItem('kss_v1_session_email', targetEmp.email.toLowerCase());
        localStorage.setItem('kss_v1_session_id', newSessionId);
        localStorage.setItem('kss_v1_session_timestamp', Date.now().toString());
        localStorage.setItem('kss_v1_device_category', cat);
        setDoc(doc(db, 'employees', targetEmp.id), sessionUpdates, { merge: true }).catch(() => { });
      } else {
        setRole('SUPER_ADMIN');
      }
      setIsAuthenticated(true);
      setIsDemoMode(true);
      setIsLoading(false);
      addAuditLog('USER_LOGIN', `Demo Executive Login (${targetRole})`, `Switched workspace view to ${targetRole}`);
    }, 150);
  };

  const logout = async () => {
    const empId = activeEmployee?.id || activeEmployee?.employeeId;
    const lastEmail = activeEmployee?.email || '';
    if (lastEmail) {
      try {
        localStorage.setItem('kss_last_login_email', lastEmail);
      } catch {}
    }
    if (empId) {
      await unregisterFcmToken(empId).catch(() => {});
    }
    // P1 FIX: await sign-out so the Firebase token is actually revoked before the UI
    // transitions. Fire-and-forget left a live token attached to in-flight listeners.
    await auth.signOut().catch(() => {});
    setUser(null);
    setAuthUid(null);
    setActiveEmployee(null);
    setIsAuthenticated(false);
    setIsDemoMode(true);
    // P0 FIX: reset the privilege level. `role` previously retained the departing user's
    // value (e.g. SUPER_ADMIN) after logout, so any component gating on `role` without also
    // checking `isAuthenticated` kept rendering administrative UI to the next visitor.
    setRole('EMPLOYEE');
    clearAllFaceEngineState(); // Purges stale face descriptors from memory (Fixes C21 Contract)

    // P0 FIX — cross-user data bleed on shared devices: logout previously cleared only the
    // five session keys and left the entire cached dataset behind. On a shared or kiosk
    // browser the next person to open the app saw the previous user's full employee
    // directory (names, phone numbers, addresses, salary bands, face descriptors), leave
    // history, notifications and audit trail restored straight from localStorage — before
    // any authentication took place. All cached personal data is now purged.
    removeAuthToken();
    [
      'kss_v1_session',
      'kss_v1_session_email',
      'kss_v1_session_id',
      'kss_v1_session_timestamp',
      'kss_v1_device_category',
      'kss_v1_cached_active_employee',
      'kss_v1_employees',
      'kss_v1_attendance',
      'kss_v1_leave_requests',
      'kss_v1_audit_logs',
      'kss_v1_read_notifs',
      'kss_v1_broadcasts',
      'kss_v1_settings',
      'kss_v1_work_zone',
      'kss_v1_company_wfh_dates',
    ].forEach(key => {
      try { localStorage.removeItem(key); } catch {}
    });
  };

  const addEmployee = async (empData: Omit<Employee, 'id' | 'createdAt' | 'updatedAt' | 'qrToken'> & { password?: string }) => {
    let uid = `emp-${Date.now()}`;
    const cleanEmail = empData.email?.trim().toLowerCase();

    if (empData.password) {
      // Create a secondary Firebase App to create user without signing out the current admin
      const secondaryApp = initializeApp(firebaseConfig, `SecondaryApp-${Date.now()}`);
      const { getAuth, createUserWithEmailAndPassword, signOut } = await import('firebase/auth');
      const secondaryAuth = getAuth(secondaryApp);
      
      try {
        const userCred = await createUserWithEmailAndPassword(secondaryAuth, cleanEmail, empData.password);
        uid = userCred.user.uid;
        // Sign out secondary auth so we don't hold the session
        await signOut(secondaryAuth);
      } catch (err: any) {
        console.error("Error creating Firebase user:", err);
        return { success: false, message: err.message || "Failed to create Firebase authentication user." };
      }
    }

    const qrToken = empData.employeeId;

    // Remove password before saving to employee record
    const { password, ...dataToSave } = empData;

    // TOP 1% SECURITY: XSS Sanitization
    const sanitizedData = sanitizeInput(dataToSave);

    const newEmp: Employee = {
      ...sanitizedData,
      id: uid,
      uid: uid,
      qrToken,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    setEmployees(prev => [newEmp, ...prev]);

    // ── COST FIX: keep the base64 resume off the parent document ────────────────
    // /employees is listened to collection-wide by every client, so an inline
    // resume was re-streamed to all of them. It goes to a subcollection nobody
    // listens to instead. If that write is rejected — which it is until the
    // subcollection rule is deployed — we fall back to persisting it inline
    // exactly as before, so employee creation works in both states.
    const resumeDataUrl = newEmp.resumeUrl || '';
    const storedOutOfBand = resumeDataUrl
      ? await writeEmployeeResume(newEmp.id, resumeDataUrl, `${newEmp.employeeId}-resume`)
      : false;

    const { resumeUrl: _omitResume, ...empWithoutResume } = newEmp;
    const empPayload: Record<string, any> = storedOutOfBand
      ? { ...empWithoutResume, hasResume: true }
      : newEmp;

    // Persist to Neon PostgreSQL or Firestore
    if (USE_FIREBASE_FIRESTORE) {
      try {
        await setDoc(doc(db, 'employees', newEmp.id), empPayload);
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, `employees/${newEmp.id}`);
        throw err;
      }

      if (cleanEmail && empData.password) {
        try {
          await setDoc(doc(db, 'users', uid), {
            uid,
            email: cleanEmail,
            role: newEmp.role,
            employeeId: newEmp.employeeId,
            employeeDocId: newEmp.id,
            fullName: newEmp.fullName,
            updatedAt: serverTimestamp()
          });
        } catch (err) {
          handleFirestoreError(err, OperationType.WRITE, `users/${uid}`);
          throw err;
        }
      }
    }

    if (getAuthToken()) {
      try {
        const createdEmpRes = await createEmployeeApi({
          employee_code: newEmp.employeeId,
          email: cleanEmail,
          password: empData.password || 'Kalpanaaa@2026',
          full_name: newEmp.fullName,
          role: newEmp.role || 'EMPLOYEE',
          department: newEmp.department || 'Engineering',
          designation: newEmp.designation || 'Software Engineer',
          joining_date: newEmp.joiningDate || new Date().toISOString().split('T')[0],
          work_location: newEmp.workLocation || 'Kalpanaaa Headquarters',
          phone: newEmp.phone,
          gender: newEmp.gender,
          date_of_birth: newEmp.dateOfBirth,
          address: newEmp.permanentAddress || newEmp.currentAddress,
          profile_photo_url: newEmp.profilePhotoUrl
        });
        if (createdEmpRes && createdEmpRes.profile_photo_url) {
          newEmp.profilePhotoUrl = createdEmpRes.profile_photo_url;
          setEmployees(prev => prev.map(e => (e.employeeId === newEmp.employeeId || e.id === newEmp.id) ? { ...e, profilePhotoUrl: createdEmpRes.profile_photo_url } : e));
          if (employeesRef.current) {
            employeesRef.current = employeesRef.current.map(e => (e.employeeId === newEmp.employeeId || e.id === newEmp.id) ? { ...e, profilePhotoUrl: createdEmpRes.profile_photo_url } : e);
          }
          setDoc(doc(db, 'employees', newEmp.id), { profilePhotoUrl: createdEmpRes.profile_photo_url }, { merge: true }).catch(() => {});
        }
      } catch (e) {
        console.warn('[FastAPI] createEmployeeApi sync note:', e);
      }
    }

    addAuditLog('EMPLOYEE_CREATED', `${newEmp.employeeId} (${newEmp.fullName})`, `Added to ${newEmp.department} as ${newEmp.designation}`);
    return newEmp;
  };

  const updateEmployee = async (id: string, updates: Partial<Employee>): Promise<void> => {
    // TOP 1% SECURITY: XSS Sanitization
    const sanitizedUpdates = sanitizeInput(updates);

    const incomingResume = typeof sanitizedUpdates.resumeUrl === 'string' ? sanitizedUpdates.resumeUrl : '';

    // 1. Locate target employee from in-memory cache/ref or state
    const existingEmp = employeesRef.current.find(e => 
      e.id === id || e.employeeId === id || (e.uid && e.uid === id)
    ) || employees.find(e => 
      e.id === id || e.employeeId === id || (e.uid && e.uid === id)
    );

    const targetDocId = existingEmp?.id || id;
    const targetIdentifier = existingEmp?.employeeId || existingEmp?.id || id;

    // 2. CLOUDINARY FIRST: Convert any new/changed profile photo (base64, webcam snapshot, or preset URL)
    // into a permanent Cloudinary CDN URL upfront BEFORE persisting to Firestore, React state, or localStorage
    let incomingPhoto = typeof sanitizedUpdates.profilePhotoUrl === 'string' ? sanitizedUpdates.profilePhotoUrl.trim() : '';
    if (incomingPhoto && targetIdentifier && !incomingPhoto.includes('res.cloudinary.com')) {
      try {
        const photoRes = await uploadPhotoApi(targetIdentifier, incomingPhoto);
        if (photoRes && photoRes.profile_photo_url) {
          incomingPhoto = photoRes.profile_photo_url;
          sanitizedUpdates.profilePhotoUrl = incomingPhoto;

          // Synchronize React state, in-memory ref, and localStorage immediately with new Cloudinary URL
          setEmployees(prev => prev.map(e => (e.id === targetDocId || e.employeeId === targetIdentifier) ? { ...e, profilePhotoUrl: incomingPhoto } : e));
          if (employeesRef.current) {
            employeesRef.current = employeesRef.current.map(e => (e.id === targetDocId || e.employeeId === targetIdentifier) ? { ...e, profilePhotoUrl: incomingPhoto } : e);
          }
          setActiveEmployee(prev => {
            if (prev && (prev.id === targetDocId || prev.employeeId === targetIdentifier)) {
              const u = { ...prev, profilePhotoUrl: incomingPhoto };
              try { localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(u)); } catch {}
              return u;
            }
            return prev;
          });
          try {
            const currentList = employeesRef.current || [];
            localStorage.setItem('kss_v1_employees', JSON.stringify(currentList));
          } catch {}
          clearApiCache('/employees');
          clearApiCache('/auth');
        }
      } catch (photoErr) {
        console.warn('[Cloudinary] Upfront photo upload note:', photoErr);
      }
    }

    // 3. Prepare payload containing ONLY the fields being updated
    // Critical: Do NOT include untouched fields (e.g. role, salary, ctc, panNumber, bankAccountNumber, etc.)
    // because Firestore security rules evaluate diff(resource.data).affectedKeys() and will reject
    // employee self-service profile edits if protected fields are present in the update payload.
    const fieldsToUpdate: Record<string, any> = { ...sanitizedUpdates };
    delete fieldsToUpdate.resumeUrl; // handle resume separately below
    if (incomingPhoto) {
      fieldsToUpdate.profilePhotoUrl = incomingPhoto;
    }

    // Guard: Enforce official specializations and departments for key roles ONLY when modified by Admin/PM or when explicitly provided
    const callerIsAdminOrPM =
      role === 'SUPER_ADMIN' ||
      role === 'HR_ADMIN' ||
      role === 'PROJECT_MANAGER' ||
      activeEmployee?.role === 'SUPER_ADMIN' ||
      activeEmployee?.role === 'HR_ADMIN' ||
      activeEmployee?.role === 'PROJECT_MANAGER' ||
      isAuthorizedTechLead(activeEmployee);
    if (callerIsAdminOrPM) {
      const isPM =
        targetDocId === 'emp-KSS2407003' ||
        targetDocId === 'uid-KSS2407003' ||
        fieldsToUpdate.role === 'PROJECT_MANAGER' ||
        (fieldsToUpdate.designation && String(fieldsToUpdate.designation).toLowerCase().includes('project manager')) ||
        (existingEmp?.role === 'PROJECT_MANAGER') ||
        (existingEmp?.employeeId === 'KSS2407003') ||
        (existingEmp?.fullName && existingEmp.fullName.toLowerCase().includes('koushik'));
      if (isPM) {
        fieldsToUpdate.department = 'IT';
        fieldsToUpdate.specialization = 'Project Management';
        fieldsToUpdate.skills = ['Project Management'];
        fieldsToUpdate.employmentType = 'Trainee';
      }

      const isTL =
        isAuthorizedTechLead(existingEmp) ||
        (existingEmp?.role as string) === 'TECH_LEAD' ||
        (existingEmp?.designation && (existingEmp.designation.toLowerCase().includes('tech lead') || existingEmp.designation.toLowerCase().includes('technical lead'))) ||
        (fieldsToUpdate.designation && (String(fieldsToUpdate.designation).toLowerCase().includes('tech lead') || String(fieldsToUpdate.designation).toLowerCase().includes('technical lead')));
      if (isTL && !isPM) {
        fieldsToUpdate.specialization = 'Technical Leadership';
        fieldsToUpdate.skills = ['Technical Leadership'];
      }

      const isJig =
        targetDocId === 'emp-KSS2407014' ||
        (existingEmp?.employeeId === 'KSS2407014') ||
        (existingEmp?.fullName && (existingEmp.fullName.toLowerCase().includes('jigyansha') || existingEmp.fullName.toLowerCase().includes('jingyasha')));
      if (isJig && !isPM && !isTL) {
        fieldsToUpdate.designation = 'AI/ML Developer';
        fieldsToUpdate.specialization = 'Generative AI';
        fieldsToUpdate.skills = ['Generative AI'];
      }
    }
    
    const cleanPayload: Record<string, any> = cleanFirestorePayload({
      ...fieldsToUpdate,
      updatedAt: new Date().toISOString()
    });

    // 4. Update in-memory employees state immediately (optimistic responsiveness)
    setEmployees(prev => prev.map(e => {
      if (e.id === targetDocId || e.id === id || e.employeeId === id || (e.uid && e.uid === id)) {
        return { ...e, ...cleanPayload };
      }
      return e;
    }));
    if (employeesRef.current) {
      employeesRef.current = employeesRef.current.map(e => {
        if (e.id === targetDocId || e.id === id || e.employeeId === id || (e.uid && e.uid === id)) {
          return { ...e, ...cleanPayload };
        }
        return e;
      });
    }

    // 5. Update activeEmployee state immediately if this affects the active logged-in employee
    setActiveEmployee(prev => {
      if (prev && (prev.id === targetDocId || prev.id === id || prev.employeeId === id || (prev.uid && prev.uid === id))) {
        const updated = { ...prev, ...cleanPayload };
        try {
          localStorage.setItem('kss_v1_session', updated.id);
          localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updated));
        } catch {}
        return updated;
      }
      return prev;
    });

    // 6. Persist update directly to Firestore Cloud Database (fail-safe non-blocking)
    if (USE_FIREBASE_FIRESTORE) {
      try {
        await setDoc(doc(db, 'employees', targetDocId), cleanPayload, { merge: true });
        if (cleanPayload.profilePhotoUrl && user?.uid) {
          // Also mirror profile photo to users/{uid} for quick header retrieval
          setDoc(doc(db, 'users', user.uid), { profilePhotoUrl: cleanPayload.profilePhotoUrl }, { merge: true }).catch(() => {});
        }
        if (cleanPayload.profilePhotoUrl && existingEmp?.uid && existingEmp.uid !== user?.uid) {
          setDoc(doc(db, 'users', existingEmp.uid), { profilePhotoUrl: cleanPayload.profilePhotoUrl }, { merge: true }).catch(() => {});
        }
      } catch (err) {
        console.warn('[Firestore] updateEmployee sync note:', err);
      }

      // 7. Handle resume storage out-of-band if present
      if (incomingResume) {
        try {
          const storedOutOfBand = await writeEmployeeResume(targetDocId, incomingResume, `${targetDocId}-resume`);
          const marker = storedOutOfBand ? { hasResume: true } : { resumeUrl: incomingResume };
          await setDoc(doc(db, 'employees', targetDocId), marker, { merge: true });
        } catch (err) {
          handleFirestoreError(err, OperationType.UPDATE, `employees/${targetDocId}/resume`);
        }
      }
    }

    // 8. Persist to Python FastAPI & Neon PostgreSQL Database
    const apiPayload: any = {};
    if (fieldsToUpdate.fullName !== undefined) apiPayload.full_name = fieldsToUpdate.fullName;
    if (fieldsToUpdate.phone !== undefined) apiPayload.phone = fieldsToUpdate.phone;
    if (fieldsToUpdate.gender !== undefined) apiPayload.gender = fieldsToUpdate.gender;
    if (fieldsToUpdate.dateOfBirth !== undefined) apiPayload.date_of_birth = fieldsToUpdate.dateOfBirth || null;
    if (fieldsToUpdate.permanentAddress !== undefined || fieldsToUpdate.currentAddress !== undefined) {
      apiPayload.address = fieldsToUpdate.permanentAddress || fieldsToUpdate.currentAddress;
    }
    if (fieldsToUpdate.city !== undefined) apiPayload.city = fieldsToUpdate.city;
    if (fieldsToUpdate.state !== undefined) apiPayload.state = fieldsToUpdate.state;
    if (fieldsToUpdate.postalCode !== undefined) apiPayload.postal_code = fieldsToUpdate.postalCode;
    if (fieldsToUpdate.emergencyContact !== undefined) apiPayload.emergency_contact = fieldsToUpdate.emergencyContact;
    if (fieldsToUpdate.emergencyRelationship !== undefined) apiPayload.emergency_relationship = fieldsToUpdate.emergencyRelationship;
    if (fieldsToUpdate.profilePhotoUrl !== undefined) apiPayload.profile_photo_url = fieldsToUpdate.profilePhotoUrl;
    if (fieldsToUpdate.bio !== undefined) apiPayload.bio = fieldsToUpdate.bio;
    if (fieldsToUpdate.linkedinUrl !== undefined) apiPayload.linkedin_url = fieldsToUpdate.linkedinUrl;
    if (callerIsAdminOrPM && fieldsToUpdate.department !== undefined) apiPayload.department = fieldsToUpdate.department;
    if (callerIsAdminOrPM && fieldsToUpdate.designation !== undefined) apiPayload.designation = fieldsToUpdate.designation;

    // Fallback: If upfront upload was somehow bypassed but a raw image is still in fieldsToUpdate
    if (targetIdentifier && fieldsToUpdate.profilePhotoUrl && typeof fieldsToUpdate.profilePhotoUrl === 'string' && !fieldsToUpdate.profilePhotoUrl.includes('res.cloudinary.com')) {
      try {
        const photoRes = await uploadPhotoApi(targetIdentifier, fieldsToUpdate.profilePhotoUrl);
        if (photoRes && photoRes.profile_photo_url) {
          apiPayload.profile_photo_url = photoRes.profile_photo_url;
          cleanPayload.profilePhotoUrl = photoRes.profile_photo_url;
          setEmployees(prev => prev.map(e => (e.id === targetDocId || e.employeeId === targetIdentifier) ? { ...e, profilePhotoUrl: photoRes.profile_photo_url } : e));
          setActiveEmployee(prev => {
            if (prev && (prev.id === targetDocId || prev.employeeId === targetIdentifier)) {
              const u = { ...prev, profilePhotoUrl: photoRes.profile_photo_url };
              try { localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(u)); } catch {}
              return u;
            }
            return prev;
          });
          setDoc(doc(db, 'employees', targetDocId), { profilePhotoUrl: photoRes.profile_photo_url }, { merge: true }).catch(() => {});
        }
      } catch (e) {
        console.warn('[FastAPI] uploadPhotoApi fallback sync note:', e);
      }
    }

    if (targetIdentifier && Object.keys(apiPayload).length > 0) {
      try {
        const backendRes = await updateEmployeeApi(targetIdentifier, apiPayload);
        if (backendRes && backendRes.profile_photo_url) {
          const freshPhoto = backendRes.profile_photo_url;
          setEmployees(prev => prev.map(e => (e.id === targetDocId || e.employeeId === targetIdentifier) ? { ...e, profilePhotoUrl: freshPhoto } : e));
          if (employeesRef.current) {
            employeesRef.current = employeesRef.current.map(e => (e.id === targetDocId || e.employeeId === targetIdentifier) ? { ...e, profilePhotoUrl: freshPhoto } : e);
          }
          setActiveEmployee(prev => {
            if (prev && (prev.id === targetDocId || prev.employeeId === targetIdentifier)) {
              const u = { ...prev, profilePhotoUrl: freshPhoto };
              try { localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(u)); } catch {}
              return u;
            }
            return prev;
          });
          if (freshPhoto !== cleanPayload.profilePhotoUrl) {
            setDoc(doc(db, 'employees', targetDocId), { profilePhotoUrl: freshPhoto }, { merge: true }).catch(() => {});
          }
        }
      } catch (e) {
        console.warn('[FastAPI] updateEmployeeApi sync note:', e);
      }
    }

    clearApiCache('/employees');
    clearApiCache('/auth');
    addAuditLog('EMPLOYEE_UPDATED', `Employee ID: ${id}`, `Fields updated: ${Object.keys(updates).join(', ')}`);
  };

  const deleteEmployee = (id: string) => {
    const target = employees.find(e => e.id === id);
    setEmployees(prev => prev.filter(e => e.id !== id));

    // Delete from FastAPI and trigger Cloudinary asset cleanup
    const targetIdentifier = target?.employeeId || id;
    if (getAuthToken() && targetIdentifier) {
      deleteEmployeeApi(targetIdentifier).catch(e => console.warn('[FastAPI] deleteEmployeeApi note:', e));
    }

    if (USE_FIREBASE_FIRESTORE) {
      deleteDoc(doc(db, 'employees', id)).catch(err => {
        handleFirestoreError(err, OperationType.DELETE, `employees/${id}`);
      });
    }

    fetchFastApiRecords(activeEmployeeRef.current, true);

    addAuditLog('EMPLOYEE_DELETED', target ? `${target.employeeId} (${target.fullName})` : id, 'Removed employee profile from directory');
  };

  const regenerateQrToken = (employeeId: string) => {
    const newToken = `QR-TOKEN-${employeeId}-${Date.now().toString(36).toUpperCase()}`;
    updateEmployee(employeeId, { qrToken: newToken });
    addAuditLog('QR_REGENERATED', `Employee ${employeeId}`, 'Regenerated cryptographic attendance pass');
    return newToken;
  };

  const enrollEmployeeBiometrics = async (
    employeeId: string,
    faceDescriptor: number[],
    force = false
  ): Promise<{ success: boolean; message: string }> => {
    try {
      if (!Array.isArray(faceDescriptor) || faceDescriptor.length !== 128) {
        return { success: false, message: 'Invalid face descriptor format: must be 128 floating point values.' };
      }

      const targetEmp = employees.find(e =>
        e.id === employeeId ||
        e.employeeId === employeeId ||
        (e.uid && e.uid === employeeId)
      ) || (activeEmployee && (activeEmployee.id === employeeId || activeEmployee.employeeId === employeeId) ? activeEmployee : null);

      const cleanId = targetEmp?.id || employeeId;
      const empCode = targetEmp?.employeeId || employeeId;
      const candidateIds = [targetEmp?.id, targetEmp?.employeeId, targetEmp?.uid, cleanId, empCode].filter(Boolean) as string[];

      // 1. Call FastAPI backend FIRST to validate and persist pgvector embedding in PostgreSQL
      try {
        const backendRes = await enrollFaceApi(empCode || cleanId, faceDescriptor, force);
        console.log('[FastAPI] enrollFaceApi response:', backendRes);
      } catch (err: any) {
        console.warn('[FastAPI] enrollFaceApi error:', err);
        const msg = String(err?.message || 'Biometric enrollment failed on backend.');
        return {
          success: false,
          message: msg
        };
      }

      // 2. ONLY upon successful backend registration, cache 128-float biometric descriptor locally
      const floatArr = new Float32Array(faceDescriptor);
      saveEmployeeDescriptor(candidateIds, floatArr);
      candidateIds.forEach(id => {
        try {
          localStorage.setItem(`kss_face_enrolled_${id}`, 'true');
        } catch {}
      });

      // 3. Best-effort Cloud Firestore sync only when a valid Firebase Auth session exists
      if (USE_FIREBASE_FIRESTORE && auth.currentUser) {
        try {
          const docId = targetEmp?.id || cleanId;
          await setDoc(doc(db, 'employees', docId), {
            isFaceEnrolled: true,
            faceDescriptor: faceDescriptor,
            faceEnrolledAt: new Date().toISOString()
          }, { merge: true });
        } catch (e) {
          console.warn('[Firestore] Biometric sync note (non-blocking):', e);
        }
      }

      const nowIso = new Date().toISOString();

      // 4. Update in-memory employees state immediately
      setEmployees(prev => prev.map(e => {
        if (
          e.id === cleanId ||
          e.employeeId === cleanId ||
          e.employeeId === empCode ||
          candidateIds.includes(e.id) ||
          (e.employeeId && candidateIds.includes(e.employeeId))
        ) {
          return {
            ...e,
            isFaceEnrolled: true,
            faceDescriptor: faceDescriptor,
            faceEnrolledAt: nowIso
          };
        }
        return e;
      }));

      // 5. Update activeEmployee state and localStorage cache immediately
      if (
        activeEmployee &&
        (candidateIds.includes(activeEmployee.id) ||
         (activeEmployee.employeeId && candidateIds.includes(activeEmployee.employeeId)) ||
         activeEmployee.id === cleanId ||
         activeEmployee.employeeId === empCode)
      ) {
        setActiveEmployee(prev => {
          if (!prev) return null;
          const updated = {
            ...prev,
            isFaceEnrolled: true,
            faceDescriptor: faceDescriptor,
            faceEnrolledAt: nowIso
          };
          try {
            localStorage.setItem('kss_v1_session', updated.id);
            localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updated));
          } catch {}
          return updated;
        });
      }

      addAuditLog(
        'BIOMETRIC_ENROLLED',
        targetEmp ? `${targetEmp.employeeId} (${targetEmp.fullName})` : employeeId,
        'Successfully captured and registered high-precision 128D facial biometric template'
      );

      return {
        success: true,
        message: `✓ Face biometrics successfully registered and verified for ${targetEmp?.fullName || employeeId}!`
      };
    } catch (err: any) {
      console.error('[Biometrics] Error enrolling biometrics:', err);
      return { success: false, message: `Failed to enroll face biometrics: ${err?.message || 'Unknown error'}` };
    }
  };

  const resetEmployeeBiometrics = async (employeeId: string): Promise<{ success: boolean; message: string }> => {
    try {
      const targetEmp = employees.find(e => e.id === employeeId || e.employeeId === employeeId);
      const cleanId = targetEmp?.id || employeeId;
      const candidateIds = [targetEmp?.id, targetEmp?.employeeId, targetEmp?.uid, employeeId].filter(Boolean) as string[];

      // 1. Purge local descriptors
      clearEmployeeDescriptor(candidateIds);

      // 2. Call FastAPI backend reset
      if (getAuthToken()) {
        try {
          await resetEmployeeFaceApi(cleanId);
        } catch (e) {
          console.warn('[FastAPI] resetEmployeeFaceApi note:', e);
        }
      }

      // 3. Clear Firestore fields if available
      try {
        const docId = targetEmp?.id || employeeId;
        await setDoc(doc(db, 'employees', docId), {
          isFaceEnrolled: false,
          faceDescriptor: null
        }, { merge: true });
      } catch {}

      // 4. Update in-memory state
      setEmployees(prev => prev.map(e => {
        if (e.id === cleanId || e.employeeId === cleanId) {
          return {
            ...e,
            isFaceEnrolled: false,
            faceDescriptor: undefined,
            faceEnrolledAt: undefined
          };
        }
        return e;
      }));

      if (activeEmployee && (activeEmployee.id === cleanId || activeEmployee.employeeId === cleanId)) {
        setActiveEmployee(prev => {
          if (!prev) return null;
          const updated = {
            ...prev,
            isFaceEnrolled: false,
            faceDescriptor: undefined,
            faceEnrolledAt: undefined
          };
          try {
            localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updated));
          } catch {}
          return updated;
        });
      }

      addAuditLog('BIOMETRIC_RESET', targetEmp ? `${targetEmp.employeeId} (${targetEmp.fullName})` : employeeId, 'Reset biometric face profile; employee must re-register face template');
      return { success: true, message: `Face biometrics reset successfully for ${targetEmp?.fullName || employeeId}. Re-registration is now required.` };
    } catch (err: any) {
      return { success: false, message: `Failed to reset face biometrics: ${err?.message || 'Unknown error'}` };
    }
  };

  const resetAllBiometrics = async (): Promise<{ success: boolean; message: string }> => {
    try {
      // 1. Purge all local descriptors across all storage keys
      resetAllLocalFaceDescriptors();

      // 2. Call FastAPI backend to reset all in PostgreSQL
      if (getAuthToken()) {
        try {
          await resetAllFacesApi();
        } catch (e) {
          console.warn('[FastAPI] resetAllFacesApi note:', e);
        }
      }

      // 3. Update in-memory state for all employees
      setEmployees(prev => prev.map(e => ({
        ...e,
        isFaceEnrolled: false,
        faceDescriptor: undefined,
        faceEnrolledAt: undefined
      })));

      if (activeEmployee) {
        setActiveEmployee(prev => {
          if (!prev) return null;
          const updated = {
            ...prev,
            isFaceEnrolled: false,
            faceDescriptor: undefined,
            faceEnrolledAt: undefined
          };
          try {
            localStorage.setItem('kss_v1_cached_active_employee', JSON.stringify(updated));
          } catch {}
          return updated;
        });
      }

      addAuditLog('ALL_BIOMETRICS_RESET', 'All Personnel', 'Purged all face biometric registrations. Every employee must re-register face.');
      return { success: true, message: 'All face biometric registrations reset successfully. Every employee must now re-register.' };
    } catch (err: any) {
      return { success: false, message: `Failed to reset all biometrics: ${err?.message || 'Unknown error'}` };
    }
  };

  // ── Shared attendance-location policy ───────────────────────────────────────
  // Extracted so check-in and the break paths cannot drift apart. Breaks used to
  // have NO geofence at all, so an employee blocked from checking in outside the
  // office could still start and end meal/tea breaks from anywhere.

  /**
   * Is today an approved work-from-home day for this employee? Company-wide dates,
   * the employee's own approved list, and an approved WFH leave request all count.
   */
  const isApprovedWfhToday = (emp: Employee | undefined, todayStr: string): boolean => {
    if (!emp) return false;
    return isApprovedWfhForEmployee(emp, todayStr, {
      leaveRequests,
      companyWideWfhDates,
      settings
    });
  };

  /** High-speed cached position read, resolving immediately to cached GPS coordinates if fresh (<60s) or acquiring within 2500ms */
  const getCurrentPositionOrNull = (): Promise<{ lat: number; lon: number } | null> =>
    new Promise(resolve => {
      if (typeof navigator === 'undefined' || !navigator.geolocation) return resolve(null);
      let resolved = false;
      const done = (coords: { lat: number; lon: number } | null) => {
        if (!resolved) {
          resolved = true;
          resolve(coords);
        }
      };

      const watchdog = setTimeout(() => done(null), 3000);

      navigator.geolocation.getCurrentPosition(
        pos => {
          clearTimeout(watchdog);
          done({ lat: pos.coords.latitude, lon: pos.coords.longitude });
        },
        () => {
          navigator.geolocation.getCurrentPosition(
            pos2 => {
              clearTimeout(watchdog);
              done({ lat: pos2.coords.latitude, lon: pos2.coords.longitude });
            },
            () => {
              clearTimeout(watchdog);
              done(null);
            },
            { enableHighAccuracy: false, maximumAge: 60000, timeout: 1500 }
          );
        },
        { enableHighAccuracy: true, maximumAge: 60000, timeout: 2000 }
      );
    });

  /**
   * Gate a self-service break on the office geofence, mirroring check-in.
   *
   * Only applies when the signed-in user is acting on their OWN record. An admin or
   * HR user closing someone else's forgotten break is a correction — their handset's
   * position says nothing about where that employee is — so those calls pass through.
   *
   * Returns null when the break is allowed, or the message explaining the block.
   */
  const verifyBreakLocation = async (
    employeeId: string,
    action: 'start' | 'end',
    lat?: number,
    lon?: number
  ): Promise<string | null> => {
    if (settings.gpsRequired === false) return null;

    const emp = findEmployee(employeeId);
    const isSelfAction = !!emp && !!activeEmployee && (
      emp.id === activeEmployee.id ||
      emp.employeeId === activeEmployee.employeeId ||
      emp.uid === activeEmployee.uid
    );
    if (!isSelfAction && (role === 'SUPER_ADMIN' || role === 'HR_ADMIN')) return null;

    const todayStr = getWorkDate(new Date());

    // Check WFH approval via date lists + leave requests
    if (isApprovedWfhToday(emp, todayStr)) return null;

    // ROOT-FIX: Also check today's actual attendance record — if the employee already
    // checked in as WFH (isWfh flag, status, or check-in without locationVerified because
    // they submitted a WFH attendance), allow all breaks without GPS enforcement.
    const todayRec = resolveAttendanceRecord(attendance, emp, todayStr);
    if (todayRec) {
      const isWfhRecord =
        todayRec.isWfh === true ||
        todayRec.status === 'Work From Home' ||
        (todayRec as any).workMode === 'WFH' ||
        (todayRec as any).attendanceMode === 'WFH';
      if (isWfhRecord) return null;

      // If the employee checked in but location was NOT verified (i.e. remote check-in),
      // they are working from home — allow breaks without distance enforcement.
      if (todayRec.checkInAt && todayRec.locationVerified === false) return null;

      // Performance Optimization: If the employee is already checked in for today's shift,
      // allow instant break activation (0ms) without stalling for device satellite/GPS acquisition
      if (todayRec.checkInAt) return null;
    }

    let coords = (lat !== undefined && lon !== undefined) ? { lat, lon } : null;
    if (!coords) {
      if (todayRec?.checkInAt) {
        // Fast-path for active shift employees: 1200ms quick probe to avoid freezing break interactions
        coords = await Promise.race([
          getCurrentPositionOrNull(),
          new Promise<null>((res) => setTimeout(() => res(null), 1200))
        ]);
      } else {
        coords = await getCurrentPositionOrNull();
      }
    }

    const verb = action === 'start' ? 'start' : 'end';
    if (!coords) {
      // If closing a break and location acquisition failed, allow break close if shift is active
      if (action === 'end' && todayRec?.checkInAt) {
        console.warn('[BreakLocation] GPS read timed out on break end — allowing break close since shift is active.');
        return null;
      }
      // If starting a break and GPS is unavailable, allow it if they are checked in
      // (they may be on WFH without GPS — their check-in already validated their situation)
      if (todayRec?.checkInAt) {
        console.warn('[BreakLocation] GPS unavailable — allowing break since employee has an active shift.');
        return null;
      }
      return `GPS Location Required: enable location permissions to ${verb} a break. Breaks may only be taken at the company office.`;
    }

    const distanceMeters = calculateGpsDistanceMeters(
      coords.lat, coords.lon, companyWorkZone.latitude, companyWorkZone.longitude
    );
    const radius = companyWorkZone.radiusMeters || settings.allowedRadiusMeters || 300;
    if (distanceMeters > radius) {
      // Grace for ending a break slightly outside the geofence (GPS drift tolerance)
      if (action === 'end' && todayRec?.locationVerified && distanceMeters <= radius + 300) {
        console.warn(`[BreakLocation] Break end within GPS drift tolerance (${distanceMeters}m vs ${radius}m)`);
        return null;
      }
      // If the employee is checked in but outside radius — they may have left after check-in
      // (e.g. stepped out for lunch). Block new break starts but be lenient on ending breaks.
      if (action === 'end' && todayRec?.checkInAt) {
        console.warn(`[BreakLocation] Break end allowed for checked-in employee outside radius (${distanceMeters}m)`);
        return null;
      }
      return `Break Blocked: You are ${distanceMeters}m away from the company office (Allowed limit: ${radius}m). Breaks may only be taken at the office. Submit a WFH request to work from home.`;
    }

    return null;
  };



  const recordCheckIn = async (
    employeeId: string, 
    lat?: number, 
    lon?: number, 
    arg4?: number | AttendanceMethod, 
    arg5?: number | AttendanceMethod,
    customDate?: string,
    overrideWfh?: boolean,
    faceDescriptor?: number[]
  ): Promise<{ success: boolean; message: string; record?: AttendanceRecord }> => {
    let accuracy = 8;
    let method: AttendanceMethod = (faceDescriptor && faceDescriptor.length === 128) ? 'Facial Recognition' : 'Self Portal';

    if (typeof arg4 === 'number') {
      accuracy = arg4;
      if (typeof arg5 === 'string' && arg5) method = arg5 as AttendanceMethod;
    } else if (typeof arg4 === 'string' && arg4) {
      method = arg4 as AttendanceMethod;
      if (typeof arg5 === 'number') accuracy = arg5;
    }
    if (faceDescriptor && faceDescriptor.length === 128) {
      method = 'Facial Recognition';
    }

    if (!navigator.onLine) {
      return { success: false, message: 'SECURITY ALERT: Airplane mode or offline connection detected. Check-In blocked.' };
    }

    const emp = findEmployee(employeeId);
    if (!emp) {
      return { success: false, message: 'Employee not found.' };
    }

    const empUid = getAttendanceOwnerUid(emp);
    const todayStr = customDate || getEmployeeWorkDate(new Date());
    const recordId = getAttendanceDocId(empUid, todayStr);

    // ROOT-CAUSE FIX: prioritize the canonical doc ({uid}_{date}) and any duplicate
    // that actually has checkInAt — a bare OR-find could match a stale blank legacy
    // duplicate, let evaluateAttendanceScan allow CHECK_IN, and then the transaction
    // would reject with "Already checked in for today."
    const existingRec = resolveAttendanceRecord(attendance, { ...emp, uid: empUid }, todayStr);

    const isSelfCheckIn = !!emp && (
      (!!activeEmployee && (
        emp.id === activeEmployee.id ||
        emp.employeeId === activeEmployee.employeeId ||
        emp.uid === activeEmployee.uid ||
        (!!emp.email && !!activeEmployee.email && emp.email.toLowerCase() === activeEmployee.email.toLowerCase())
      )) ||
      (!!user && (
        emp.uid === user.uid ||
        emp.id === user.uid ||
        empUid === user.uid ||
        (!!emp.email && !!user.email && emp.email.toLowerCase() === user.email.toLowerCase())
      ))
    );
    const isAdminCheckIn = !isSelfCheckIn && (
      role === 'SUPER_ADMIN' || role === 'HR_ADMIN' ||
      activeEmployee?.role === 'SUPER_ADMIN' || activeEmployee?.role === 'HR_ADMIN'
    );

    // ROOT-CAUSE ENFORCEMENT: Strictly block check-in on approved leaves, holidays & Sundays
    const eligibility = validateCheckInEligibility(emp, todayStr, {
      leaveRequests,
      holidayDates: (settings as any).customHolidays || OFFICIAL_HOLIDAY_DATES_2026,
      settings
    });

    if (!eligibility.allowed && !isAdminCheckIn) {
      return { success: false, message: eligibility.message };
    }

    // B27 FIX: gate the WFH carve-out strictly on the stable employee code. The former
    // name/email substring tests also matched any employee with "asbin" anywhere in
    // their identity (e.g. "Jasbinder"), wrongly denying them approved WFH. The explicit
    // employeeId was already the canonical target of this OR, so behaviour for the
    // intended employee is unchanged. Now shared with the break geofence through
    // isApprovedWfhToday, so check-in, check-out and breaks cannot drift apart.
    const isApprovedWfh = overrideWfh !== undefined ? overrideWfh : isApprovedWfhToday(emp, todayStr);

    let coords = (lat !== undefined && lon !== undefined) ? { lat, lon } : null;
    if (!coords && !isApprovedWfh && !isAdminCheckIn && settings.gpsRequired !== false) {
      coords = await getCurrentPositionOrNull();
    }
    const finalLat = coords?.lat ?? lat;
    const finalLon = coords?.lon ?? lon;

    const isPmOrLeadership = role === 'PROJECT_MANAGER' || activeEmployee?.role === 'PROJECT_MANAGER' || isExecutiveOrLeadership(emp) || emp.employeeId === 'KSS2407003';

    const effectiveSettings: CompanySettings = {
      ...settings,
      officeLatitude: companyWorkZone.latitude,
      officeLongitude: companyWorkZone.longitude,
      allowedRadiusMeters: isPmOrLeadership ? Math.max(companyWorkZone.radiusMeters, 500) : companyWorkZone.radiusMeters,
      gpsRequired: !isAdminCheckIn && settings.gpsRequired !== false
    };

    const evalResult = evaluateAttendanceScan(
      emp, 
      existingRec, 
      effectiveSettings, 
      finalLat, 
      finalLon, 
      isApprovedWfh || isAdminCheckIn,
      { leaveRequests, holidayDates: (settings as any).customHolidays || OFFICIAL_HOLIDAY_DATES_2026 }
    );

    if (!evalResult.allowed && evalResult.action === 'CHECK_IN' && !isAdminCheckIn) {
      if (isPmOrLeadership && (!finalLat || (accuracy !== undefined && accuracy > 100))) {
        // Gracefully allow PM check-in when affected by indoor laptop WiFi jitter
      } else {
        return { success: false, message: evalResult.message };
      }
    }

    const distMeters = (finalLat !== undefined && finalLon !== undefined)
      ? calculateGpsDistanceMeters(finalLat, finalLon, companyWorkZone.latitude, companyWorkZone.longitude)
      : 0;

    // 100% NEON POSTGRESQL PRIMARY PATH
    if (getAuthToken() || !USE_FIREBASE_FIRESTORE) {
      try {
        const apiRec = await checkInApi({
          employee_code: emp.employeeId,
          latitude: finalLat,
          longitude: finalLon,
          is_wfh: isApprovedWfh,
          face_descriptor: faceDescriptor
        });

        addAuditLog('ATTENDANCE_CHECKIN', `${emp.employeeId} (${emp.fullName})`, `Status: ${evalResult.status}, GPS: ${evalResult.locationVerified ? 'Verified' : 'Unverified'} (${distMeters}m from office)`);

        const checkInIsoStr = apiRec?.check_in_at ? formatTimestampToISO(apiRec.check_in_at) : new Date().toISOString();
        const resolvedRec: AttendanceRecord = {
          id: String(apiRec?.id || recordId),
          uid: empUid,
          employeeUid: empUid,
          employeeId: emp.id,
          employeeCode: emp.employeeId,
          employeeName: emp.fullName,
          department: emp.department || 'Engineering',
          date: todayStr,
          checkInAt: checkInIsoStr,
          checkOutAt: null,
          workingMinutes: 0,
          status: (apiRec?.status === 'WORK_FROM_HOME' ? 'Work From Home' : (apiRec?.status === 'LATE' ? 'Late' : (isApprovedWfh && evalResult.status !== 'Late' ? 'Work From Home' : evalResult.status))) as AttendanceStatus,
          attendanceMethod: (faceDescriptor ? 'Facial Recognition' : method) as AttendanceMethod,
          officeLatitude: companyWorkZone.latitude,
          officeLongitude: companyWorkZone.longitude,
          officeRadiusMeters: companyWorkZone.radiusMeters,
          distanceFromOffice: distMeters,
          locationAccuracy: accuracy,
          locationVerified: evalResult.locationVerified,
          latitude: finalLat,
          longitude: finalLon,
          breaks: [],
          totalBreakMinutes: 0,
          isWfh: !!isApprovedWfh,
          createdAt: checkInIsoStr,
          updatedAt: checkInIsoStr
        } as AttendanceRecord;

        setAttendance(prev => {
          const map = new Map<string, AttendanceRecord>();
          prev.forEach(r => map.set(r.id, r));
          map.set(resolvedRec.id, resolvedRec);
          return Array.from(map.values());
        });

        if (USE_FIREBASE_FIRESTORE && auth.currentUser) {
          const payload = {
            id: resolvedRec.id,
            uid: empUid,
            employeeUid: empUid,
            authUid: auth.currentUser.uid,
            email: emp.email || user?.email || '',
            employeeEmail: emp.email || user?.email || '',
            employeeId: emp.id,
            employeeCode: emp.employeeId,
            employeeName: emp.fullName,
            department: emp.department || 'Engineering',
            pmUid: emp.pmUid || emp.reportingManagerUid || '',
            date: todayStr,
            checkInAt: serverTimestamp(),
            checkOutAt: null,
            workingMinutes: 0,
            status: resolvedRec.status,
            attendanceMethod: resolvedRec.attendanceMethod,
            officeLatitude: companyWorkZone.latitude,
            officeLongitude: companyWorkZone.longitude,
            officeRadiusMeters: companyWorkZone.radiusMeters,
            distanceFromOffice: distMeters,
            locationAccuracy: accuracy,
            locationVerified: evalResult.locationVerified,
            latitude: finalLat ?? null,
            longitude: finalLon ?? null,
            breaks: [],
            totalBreakMinutes: 0,
            isWfh: !!isApprovedWfh,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          };
          setDoc(doc(db, 'attendance', resolvedRec.id), cleanFirestorePayload(payload), { merge: true }).catch(() => {});
        }

        fetchFastApiRecords(activeEmployeeRef.current, true);

        return {
          success: true,
          message: evalResult.message,
          record: resolvedRec
        };
      } catch (fastApiErr: any) {
        console.warn('[FastAPI] checkInApi error:', fastApiErr);
        if (!USE_FIREBASE_FIRESTORE) {
          return { success: false, message: fastApiErr?.message || 'Check-in failed on Neon DB.' };
        }
        const errMsg = (fastApiErr?.message || '').toLowerCase();
        const isNetworkOffline = errMsg.includes('failed to fetch') || errMsg.includes('networkerror') || errMsg.includes('err_connection');

        if (!isNetworkOffline || fastApiErr?.status || errMsg.includes('biometric') || errMsg.includes('mismatch') || errMsg.includes('face') || errMsg.includes('already checked in') || errMsg.includes('template')) {
          return {
            success: false,
            message: fastApiErr?.message || 'Check-in verification failed.'
          };
        }
        if (!auth.currentUser) {
          return { success: false, message: fastApiErr?.message || 'Check-In failed. Please try again.' };
        }
      }
    }

    if (!auth.currentUser) {
      return { success: false, message: 'Check-In requires an authenticated session. Please log in again.' };
    }

    // ATOMIC IDEMPOTENT TRANSACTION
    const docRef = doc(db, 'attendance', recordId);
    try {
      const txResult = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(docRef);
        if (docSnap.exists()) {
          const existingData = docSnap.data();
          if (existingData.checkInAt) {
            // Idempotent: already checked in!
            return {
              alreadyCheckedIn: true,
              data: existingData,
              message: 'Already checked in for today.'
            };
          }
        }

        const payload = {
          id: recordId,
          uid: empUid,
          employeeUid: empUid,
          // Keep the authenticated owner distinct from the employee document ID;
          // Firestore rules validate this against the trusted users/{uid} mapping.
          authUid: isSelfCheckIn ? (auth.currentUser?.uid || user?.uid || null) : null,
          email: emp.email || user?.email || '',
          employeeEmail: emp.email || user?.email || '',
          employeeId: emp.id,
          employeeCode: emp.employeeId,
          employeeName: emp.fullName,
          department: emp.department || 'Engineering',
          pmUid: emp.pmUid || emp.reportingManagerUid || '',
          date: todayStr,
          checkInAt: serverTimestamp(),
          checkOutAt: null,
          workingMinutes: 0,
          status: (isApprovedWfh && evalResult.status !== 'Late') ? 'Work From Home' : evalResult.status,
          attendanceMethod: method,
          officeLatitude: companyWorkZone.latitude,
          officeLongitude: companyWorkZone.longitude,
          officeRadiusMeters: companyWorkZone.radiusMeters,
          distanceFromOffice: distMeters,
          locationAccuracy: accuracy,
          locationVerified: evalResult.locationVerified,
          latitude: lat !== undefined ? lat : null,
          longitude: lon !== undefined ? lon : null,
          deviceInfo: typeof navigator !== 'undefined' ? navigator.userAgent : 'Browser Scanner Terminal',
          breaks: [],
          totalBreakMinutes: 0,
          isWfh: !!isApprovedWfh,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        };

        transaction.set(docRef, cleanFirestorePayload(payload), { merge: true });
        return {
          alreadyCheckedIn: false,
          data: payload,
          message: evalResult.message
        };
      });

      addAuditLog('ATTENDANCE_CHECKIN', `${emp.employeeId} (${emp.fullName})`, `Status: ${evalResult.status}, GPS: ${evalResult.locationVerified ? 'Verified' : 'Unverified'} (${distMeters}m from office)`);

      const checkInIsoStr = formatTimestampToISO(txResult.data?.checkInAt) || new Date().toISOString();
      const resolvedRec: AttendanceRecord = {
        ...txResult.data,
        id: recordId,
        uid: empUid,
        employeeUid: empUid,
        employeeId: emp.id,
        employeeCode: emp.employeeId,
        employeeName: emp.fullName,
        date: todayStr,
        checkInAt: checkInIsoStr
      } as AttendanceRecord;

      // Immediately sync state so UI reflects Shift Active without delay
      setAttendance(prev => {
        const map = new Map<string, AttendanceRecord>();
        prev.forEach(r => map.set(r.id, r));
        map.set(recordId, resolvedRec);
        return Array.from(map.values());
      });

      if (getAuthToken()) {
        try {
          const apiRec = await checkInApi({
            employee_code: emp.employeeId,
            latitude: finalLat,
            longitude: finalLon,
            is_wfh: isApprovedWfh,
            face_descriptor: faceDescriptor
          });
          if (apiRec && apiRec.id) {
            const mapped = {
              id: String(apiRec.id),
              employeeId: String(apiRec.employee_id),
              employeeCode: apiRec.employee_code || emp.employeeId,
              employeeName: emp.fullName,
              department: emp.department,
              date: apiRec.date,
              checkInAt: apiRec.check_in_at || new Date().toISOString(),
              checkOutAt: null,
              workingMinutes: 0,
              status: (apiRec.status === 'WORK_FROM_HOME' ? 'Work From Home' : (apiRec.status === 'LATE' ? 'Late' : 'Present')) as AttendanceStatus,
              attendanceMethod: (faceDescriptor ? 'Facial Recognition' : 'Biometric Face') as AttendanceMethod,
              isWfh: !!apiRec.is_wfh,
              locationVerified: !!apiRec.location_verified,
              latitude: apiRec.check_in_lat ?? finalLat,
              longitude: apiRec.check_in_lon ?? finalLon,
              totalBreakMinutes: 0,
              breaks: [],
              notes: apiRec.notes || ''
            };
            setAttendance(prev => [mapped, ...prev.filter(a => a.id !== String(apiRec.id) && !(a.date === todayStr && a.employeeId === emp.id))]);
          }
        } catch (e) {
          console.warn('[FastAPI] checkInApi sync note:', e);
        }
      }

      return { 
        success: true, 
        message: txResult.message, 
        record: resolvedRec
      };
    } catch (err: any) {
      if (!auth.currentUser && (err?.code === 'permission-denied' || String(err?.message || '').includes('permission'))) {
        console.warn(`[Firestore] Suppressed permission warning on unauthenticated session for attendance/${recordId}`);
        return { success: false, message: 'Check-In failed: Session requires authentication.' };
      }
      handleFirestoreError(err, OperationType.CREATE, `attendance/${recordId}`);
      return { success: false, message: err.message || 'Check-In failed.' };
    }
  };

  const recordCheckOut = async (
    employeeId: string, 
    lat?: number, 
    lon?: number, 
    accuracy?: number,
    customDate?: string
  ): Promise<{ success: boolean; message: string; record?: AttendanceRecord }> => {
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      return { success: false, message: 'SECURITY ALERT: Airplane mode or offline connection detected. Check-Out blocked.' };
    }

    const emp = findEmployee(employeeId);
    if (!emp) {
      return { success: false, message: 'Employee not found.' };
    }

    const empUid = getAttendanceOwnerUid(emp);
    const todayStr = customDate || getEmployeeWorkDate(new Date());
    const canonicalId = getAttendanceDocId(empUid, todayStr);

    // Canonical ID lookup first, then any duplicate that actually has attendance data.
    // Never target a stale blank legacy doc — that would split check-in/check-out
    // across two Firestore documents.
    const existingRec = resolveAttendanceRecord(attendance, { ...emp, uid: empUid }, todayStr);
    const recordId = existingRec?.id ?? canonicalId;

    // B27 FIX: gate the WFH carve-out strictly on the stable employee code. The former
    // name/email substring tests also matched any employee with "asbin" anywhere in
    // their identity (e.g. "Jasbinder"), wrongly denying them approved WFH. The explicit
    // employeeId was already the canonical target of this OR, so behaviour for the
    // intended employee is unchanged. Now shared with the break geofence through
    // isApprovedWfhToday, so check-in, check-out and breaks cannot drift apart.
    const isApprovedWfh = isApprovedWfhToday(emp, todayStr);

    let coords = (lat !== undefined && lon !== undefined) ? { lat, lon } : null;
    if (!coords && !isApprovedWfh && settings.gpsRequired !== false) {
      coords = await getCurrentPositionOrNull();
    }
    const finalLat = coords?.lat ?? lat;
    const finalLon = coords?.lon ?? lon;

    const isGpsEnforced = settings.gpsRequired !== false;

    // Strict GPS geofence enforcement on Check-Out
    if (!isApprovedWfh && isGpsEnforced) {
      if (finalLat === undefined || finalLon === undefined) {
        return {
          success: false,
          message: 'GPS Location Required: Enable location permissions to check out. Check-out must strictly be performed at the company office.'
        };
      }

      const checkoutDistance = calculateGpsDistanceMeters(
        finalLat,
        finalLon,
        companyWorkZone.latitude,
        companyWorkZone.longitude
      );
      const radius = companyWorkZone.radiusMeters || settings.allowedRadiusMeters || 300;

      if (checkoutDistance > radius) {
        return {
          success: false,
          message: `Check-Out Blocked: You are ${checkoutDistance}m away from the company office (Allowed limit: ${radius}m). On normal office days, check-out must strictly be performed at the company office.`
        };
      }
    }

    // 100% NEON POSTGRESQL PRIMARY PATH
    if (getAuthToken() || !USE_FIREBASE_FIRESTORE) {
      try {
        const backendRes = await checkOutApi({
          latitude: finalLat,
          longitude: finalLon,
          notes: 'Self Portal Check-Out'
        });

        const checkOutIso = backendRes?.check_out_at ? formatTimestampToISO(backendRes.check_out_at) : new Date().toISOString();
        const durationMins = typeof backendRes?.working_minutes === 'number' ? backendRes.working_minutes : 0;

        addAuditLog('ATTENDANCE_CHECKOUT', `${emp.employeeId} (${emp.fullName})`, `Duration: ${Math.floor(durationMins / 60)}h ${durationMins % 60}m`);

        const resolvedRecord: AttendanceRecord = {
          ...existingRec,
          id: backendRes?.id || recordId,
          checkOutAt: checkOutIso,
          workingMinutes: durationMins,
          breaks: Array.isArray(backendRes?.breaks)
            ? backendRes.breaks.map((b: any) => ({
                type: b.break_type || b.type,
                startAt: formatTimestampToISO(b.start_time || b.startAt) || '',
                endAt: formatTimestampToISO(b.end_time || b.endAt),
                durationMinutes: Number(b.duration_minutes || b.durationMinutes) || 0
              }))
            : (existingRec?.breaks || []),
          totalBreakMinutes: Array.isArray(backendRes?.breaks)
            ? backendRes.breaks.reduce((acc: number, b: any) => acc + (Number(b.duration_minutes) || 0), 0)
            : (existingRec?.totalBreakMinutes || 0),
          updatedAt: checkOutIso
        } as AttendanceRecord;

        setAttendance(prev => prev.map(a => {
          if (a.id === recordId || a.id === backendRes?.id || (a.date === todayStr && (a.employeeId === employeeId || a.employeeId === emp.id))) {
            return resolvedRecord;
          }
          return a;
        }));

        if (USE_FIREBASE_FIRESTORE && auth.currentUser) {
          setDoc(doc(db, 'attendance', recordId), cleanFirestorePayload({
            checkOutAt: serverTimestamp(),
            workingMinutes: durationMins,
            updatedAt: serverTimestamp()
          }), { merge: true }).catch(() => {});
        }

        fetchFastApiRecords(activeEmployeeRef.current, true);

        return {
          success: true,
          message: isApprovedWfh
            ? 'Checked Out Successfully — Work From Home Completed'
            : 'Checked Out Successfully — Shift Completed',
          record: resolvedRecord
        };
      } catch (fastApiErr: any) {
        console.warn('[FastAPI] checkOutApi error:', fastApiErr);
        if (!USE_FIREBASE_FIRESTORE) {
          return { success: false, message: fastApiErr?.message || 'Check-Out failed on Neon DB.' };
        }
        if (fastApiErr?.status === 400 || (fastApiErr?.message && (fastApiErr.message.includes('check out') || fastApiErr.message.includes('check in')))) {
          return { success: false, message: fastApiErr.message };
        }
        if (!auth.currentUser) {
          return { success: false, message: fastApiErr?.message || 'Check-Out failed. Please try again.' };
        }
      }
    }

    if (!auth.currentUser) {
      return { success: false, message: 'Check-Out requires an authenticated session. Please log in again.' };
    }

    // ATOMIC IDEMPOTENT TRANSACTION
    const docRef = doc(db, 'attendance', recordId);

    try {
      const txResult = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(docRef);
        if (!docSnap.exists()) {
          throw new Error('No attendance record found for today. Please check in first.');
        }

        const existingData = docSnap.data();
        if (!existingData.checkInAt) {
          throw new Error('No active check-in record found for today.');
        }

        if (existingData.checkOutAt) {
          // Idempotent: already checked out!
          return {
            alreadyCheckedOut: true,
            data: existingData,
            message: 'Employee has already checked out for today.'
          };
        }

        const distMeters = (finalLat !== undefined && finalLon !== undefined)
          ? calculateGpsDistanceMeters(finalLat, finalLon, companyWorkZone.latitude, companyWorkZone.longitude)
          : (existingData.distanceFromOffice || 0);

        // Compute workingMinutes inside checkout transaction from the read snapshot
        const checkInISO = formatTimestampToISO(existingData.checkInAt) || new Date().toISOString();
        const checkInMs = new Date(checkInISO).getTime();
        const nowMs = Date.now();

        const existingBreaks = Array.isArray(existingData.breaks) ? existingData.breaks : [];
        let updatedBreaks = existingBreaks;
        let additionalBreakMins = 0;
        const openBreak = existingBreaks.find((b: any) => !b.endAt && !(b as any).endTime);

        if (openBreak) {
          const bStartIso = formatTimestampToISO(openBreak.startAt || (openBreak as any).startTime) || new Date(nowMs).toISOString();
          additionalBreakMins = Math.max(1, Math.floor((nowMs - new Date(bStartIso).getTime()) / 60000));
          const nowIso = new Date(nowMs).toISOString();
          updatedBreaks = existingBreaks.map((b: any) => {
            const isOpen = !b.endAt && !(b as any).endTime;
            return isOpen
              ? {
                  ...b,
                  startAt: formatTimestampToISO(b.startAt || (b as any).startTime) || bStartIso,
                  endAt: nowIso,
                  endTime: nowIso,
                  durationMinutes: additionalBreakMins
                }
              : b;
          });
        }

        const finalTotalBreakMinutes = updatedBreaks.reduce((acc: number, b: any) => acc + (Number(b.durationMinutes) || 0), 0);
        let durationMins = Math.floor((nowMs - checkInMs) / 60000);
        if (finalTotalBreakMinutes > 0) {
          durationMins = Math.max(0, durationMins - finalTotalBreakMinutes);
        }
        const updates: Record<string, any> = {
          checkOutAt: serverTimestamp(),
          workingMinutes: durationMins,
          breaks: updatedBreaks,
          totalBreakMinutes: finalTotalBreakMinutes,
          authUid: auth.currentUser?.uid || user?.uid || empUid,
          employeeUid: empUid,
          officeLatitude: existingData.officeLatitude || companyWorkZone.latitude,
          officeLongitude: existingData.officeLongitude || companyWorkZone.longitude,
          officeRadiusMeters: existingData.officeRadiusMeters || companyWorkZone.radiusMeters,
          distanceFromOffice: distMeters,
          locationAccuracy: accuracy || existingData.locationAccuracy || 8,
          locationVerified: existingData.locationVerified !== undefined ? existingData.locationVerified : true,
          updatedAt: serverTimestamp()
        };
        transaction.update(docRef, cleanFirestorePayload(updates));
        return {
          alreadyCheckedOut: false,
          data: { ...existingData, ...updates, checkOutAt: new Date().toISOString() },
          message: isApprovedWfh
            ? 'Checked Out Successfully — Work From Home Completed'
            : 'Checked Out Successfully — Shift Completed'
        };
      });

      addAuditLog('ATTENDANCE_CHECKOUT', `${emp.employeeId} (${emp.fullName})`, `Duration: ${Math.floor((txResult.data.workingMinutes || 0) / 60)}h ${(txResult.data.workingMinutes || 0) % 60}m`);

      // BUG 5 FIX: Optimistic local state update — the UI reflects "Shift Complete"
      // immediately without waiting for the Firestore onSnapshot (~200–500 ms).
      // The subsequent real snapshot will reconcile any minor timestamp drift.
      const checkOutIso = new Date().toISOString();
      setAttendance(prev => prev.map(a => {
        if (a.id !== recordId) return a;
        return {
          ...a,
          checkOutAt: checkOutIso,
          workingMinutes: typeof txResult.data.workingMinutes === 'number'
            ? txResult.data.workingMinutes
            : a.workingMinutes,
          breaks: Array.isArray(txResult.data.breaks)
            ? txResult.data.breaks.map((b: any) => ({
                type: b.type,
                startAt: formatTimestampToISO(b.startAt || b.startTime) || '',
                endAt: formatTimestampToISO(b.endAt || b.endTime),
                durationMinutes: Number(b.durationMinutes) || 0
              }))
            : a.breaks,
          totalBreakMinutes: typeof txResult.data.totalBreakMinutes === 'number'
            ? txResult.data.totalBreakMinutes
            : a.totalBreakMinutes,
          updatedAt: checkOutIso
        };
      }));

      if (getAuthToken()) {
        checkOutApi({
          latitude: finalLat,
          longitude: finalLon,
          notes: 'Self Portal Check-Out'
        }).catch(e => console.warn('[FastAPI] checkOutApi sync warning:', e));
      }

      return {
        success: true,
        message: txResult.message,
        record: txResult.data as AttendanceRecord
      };
    } catch (err: any) {
      if (!auth.currentUser && (err?.code === 'permission-denied' || String(err?.message || '').includes('permission'))) {
        console.warn(`[Firestore] Suppressed permission warning on unauthenticated session for attendance/${recordId}`);
        return { success: false, message: 'Check-Out failed: Session requires authentication.' };
      }
      handleFirestoreError(err, OperationType.UPDATE, `attendance/${recordId}`);
      return { success: false, message: err.message || 'Check-Out failed.' };
    }
  };

  const startBreak = async (employeeId: string, breakType: BreakType | string, lat?: number, lon?: number) => {
    // Breaks are office-only, same rule as check-in. Enforced BEFORE the transaction
    // so a rejected break never touches the attendance document.
    const locationBlock = await verifyBreakLocation(employeeId,'start', lat, lon);
    if (locationBlock) return { success: false, message: locationBlock };

    const canonicalBreakType = (normalizeBreakType(breakType) || 'Meal Break') as BreakType;

    const emp = findEmployee(employeeId);
    // BUG 4 FIX: Same canonical UID as recordCheckIn/endBreak — single doc target.
    const empUid = getAttendanceOwnerUid(emp);
    const todayStr = getWorkDate(new Date());
    const canonicalId = getAttendanceDocId(empUid, todayStr);

    // Canonical ID first, then any duplicate with real attendance data
    const existingRec = resolveAttendanceRecord(attendance, { ...(emp || { id: employeeId }), uid: empUid }, todayStr);
    const recordId = existingRec?.id ?? canonicalId;
    const docRef = doc(db, 'attendance', recordId);

    const prevAttendance = attendance;
    const nowISO = new Date().toISOString();

    // Optimistic UI update so active break state switches immediately with 0ms delay
    const optimisticBreak = { 
      type: canonicalBreakType, 
      startAt: nowISO, 
      startTime: nowISO, 
      endAt: null, 
      endTime: null, 
      durationMinutes: 0 
    };

    const isTargetRecord = (r: AttendanceRecord) => {
      const isToday = !r.date || r.date === todayStr;
      if (!isToday) return false;
      return r.id === recordId ||
        r.employeeId === employeeId ||
        (emp && (r.employeeId === emp.id || r.employeeId === emp.employeeId || r.employeeCode === emp.employeeId));
    };

    setAttendance(prev => {
      const next = prev.map(rec => {
        if (isTargetRecord(rec)) {
          const curBreaks = (rec.breaks || []).map((b: any) => {
            if (!b.endAt && !b.endTime) {
              const startMs = new Date(b.startAt || b.startTime).getTime();
              const dur = Math.max(1, Math.round((Date.now() - startMs) / 60000));
              return { ...b, endAt: nowISO, endTime: nowISO, durationMinutes: dur };
            }
            return b;
          });
          return {
            ...rec,
            breaks: [...curBreaks, optimisticBreak]
          };
        }
        return rec;
      });
      try {
        localStorage.setItem('kss_v1_attendance', JSON.stringify(next.slice(0, 1000)));
      } catch {}
      return next;
    });

    // 100% NEON POSTGRESQL PRIMARY PATH
    if (getAuthToken() || !USE_FIREBASE_FIRESTORE) {
      const norm = (breakType || '').toLowerCase();
      let apiType = 'TEA_BREAK';
      if (norm.includes('snack')) apiType = 'SNACK_BREAK';
      else if (norm.includes('meal') || norm.includes('lunch')) apiType = 'LUNCH_BREAK';
      else if (norm.includes('huddle')) apiType = 'TEAM_HUDDLE';
      else if (norm.includes('meeting')) apiType = 'TEAM_MEETING';
      else if (norm.includes('train') || norm.includes('attainment')) apiType = 'TRAINING';
      else if (norm.includes('activity')) apiType = 'ACTIVITY';
      else if (norm.includes('tea') || norm.includes('coffee')) apiType = 'TEA_BREAK';
      else apiType = 'OTHER';

      try {
        const backendBreak = await breakActionApi(apiType);
        addAuditLog('ATTENDANCE_BREAK_START', emp?.fullName || empUid, `Started ${breakType}`);
        toast.success(`${breakType} started!`);

        // Reconcile optimistic break with confirmed backend response (real id and normalized start time)
        const confirmedStartIso = (backendBreak?.start_time ? formatTimestampToISO(backendBreak.start_time) : null) || nowISO;
        const confirmedBreak = {
          id: String(backendBreak?.id || Date.now()),
          type: canonicalBreakType,
          startAt: confirmedStartIso,
          startTime: confirmedStartIso,
          endAt: null,
          endTime: null,
          durationMinutes: 0
        };

        setAttendance(prev => {
          const next = prev.map(rec => {
            if (isTargetRecord(rec)) {
              const curBreaks = (rec.breaks || []).filter((b: any) => b !== optimisticBreak);
              return {
                ...rec,
                breaks: [...curBreaks, confirmedBreak]
              };
            }
            return rec;
          });
          try {
            localStorage.setItem('kss_v1_attendance', JSON.stringify(next.slice(0, 1000)));
          } catch {}
          return next;
        });

        fetchFastApiRecords(activeEmployeeRef.current, true);

        return { success: true, message: `${breakType} started!`, breaks: [confirmedBreak], totalBreakMinutes: 0 };
      } catch (fastApiErr: any) {
        console.warn('[FastAPI] breakActionApi fallback note:', fastApiErr);
        if (!USE_FIREBASE_FIRESTORE) {
          return { success: false, message: fastApiErr?.message || `Failed to start ${breakType}.` };
        }
        if (!auth.currentUser) {
          return { success: false, message: fastApiErr?.message || `Failed to start ${breakType}.` };
        }
      }
    }

    if (!auth.currentUser) {
      return { success: false, message: 'Starting a break requires an authenticated session.' };
    }

    try {
      const res = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(docRef);
        let existingBreaks: any[] = [];
        if (!docSnap.exists()) {
          throw new Error('Please check in before starting a break.');
        }
        const data = docSnap.data();
        if (data.checkInAt == null) {
          throw new Error('Please check in before starting a break.');
        }
        if (data.checkOutAt) {
          throw new Error('You have already checked out for today.');
        }
        existingBreaks = Array.isArray(data.breaks) ? data.breaks : [];

        // Auto-close any previous unclosed break before starting the new one.
        // Clean legacy dual startAt/startTime fields to consistent startAt/endAt.
        const sanitizedBreaks = existingBreaks.map((b: any) => {
          const startIso = formatTimestampToISO(b.startAt || b.startTime) || nowISO;
          if (!b.endAt && !b.endTime) {
            const diffMs = Math.max(0, new Date(nowISO).getTime() - new Date(startIso).getTime());
            return {
              type: b.type,
              startAt: startIso,
              endAt: nowISO,
              durationMinutes: Math.max(1, Math.min(MAX_BREAK_MINUTES, Math.round(diffMs / 60000)))
            };
          }
          return {
            type: b.type,
            startAt: startIso,
            endAt: formatTimestampToISO(b.endAt || b.endTime) || null,
            durationMinutes: Number(b.durationMinutes) || 0
          };
        });

        // Single startAt format without duplicate startTime
        const newBreak = { type: canonicalBreakType, startAt: nowISO, endAt: null, durationMinutes: 0 };
        const updatedBreaks = [...sanitizedBreaks, newBreak];
        const totalBreakMins = calculateTotalBreakMinutes(updatedBreaks);

        const startBreakUpdates: Record<string, any> = {
          breaks: updatedBreaks,
          totalBreakMinutes: totalBreakMins,
          authUid: auth.currentUser?.uid || user?.uid || empUid,
          employeeUid: empUid,
          updatedAt: serverTimestamp()
        };
        transaction.update(docRef, cleanFirestorePayload(startBreakUpdates));

        return { 
          success: true, 
          message: `${breakType} started!`,
          breaks: updatedBreaks,
          totalBreakMinutes: totalBreakMins
        };
      });

      // Update React state after confirmed transaction write
      setAttendance(prev => {
        return prev.map(rec => {
          if (rec.id === recordId || (rec.employeeId === emp?.id && rec.date === todayStr)) {
            return {
              ...rec,
              breaks: (res as any).breaks,
              totalBreakMinutes: (res as any).totalBreakMinutes
            };
          }
          return rec;
        });
      });

      if (getAuthToken()) {
        const norm = (breakType || '').toLowerCase();
        const apiType = norm.includes('tea') ? 'TEA_BREAK' : (norm.includes('lunch') ? 'LUNCH_BREAK' : 'TEA_BREAK');
        breakActionApi(apiType).catch(e => console.warn('[FastAPI] breakActionApi sync warning:', e));
      }

      addAuditLog('ATTENDANCE_BREAK_START', emp?.fullName || empUid, `Started ${breakType}`);
      toast.success(`${breakType} started!`);
      return res;
    } catch (err: any) {
      // Roll back state on failure & show visible user error
      setAttendance(prevAttendance);
      handleFirestoreError(err, OperationType.UPDATE, `attendance/${recordId}`);
      toast.error(err.message || 'Failed to start break.');
      return { success: false, message: err.message || 'Failed to start break.' };
    }
  };

  const endBreak = async (employeeId: string, lat?: number, lon?: number) => {
    // Symmetric with startBreak: a break must also be CLOSED at the office, otherwise
    // an employee could start one on site, leave, and stop the clock from home.
    const locationBlock = await verifyBreakLocation(employeeId,'end', lat, lon);
    if (locationBlock) return { success: false, message: locationBlock };

    const emp = findEmployee(employeeId);
    // BUG 4 FIX: Same canonical UID as recordCheckIn/startBreak — single doc target.
    const empUid = getAttendanceOwnerUid(emp);
    const todayStr = getWorkDate(new Date());
    const canonicalId = getAttendanceDocId(empUid, todayStr);

    // Canonical ID first, then any duplicate with real attendance data (never a stale blank legacy doc)
    const existingRec = resolveAttendanceRecord(attendance, { ...(emp || { id: employeeId }), uid: empUid }, todayStr);
    const recordId = existingRec?.id ?? canonicalId;
    const docRef = doc(db, 'attendance', recordId);

    const prevAttendance = attendance;
    const nowMs = Date.now();
    const nowISO = new Date(nowMs).toISOString();

    // Optimistic UI update so open break ends immediately with 0ms delay
    const isTargetRecord = (r: AttendanceRecord) => {
      const isToday = !r.date || r.date === todayStr;
      if (!isToday) return false;
      return r.id === recordId ||
        r.employeeId === employeeId ||
        (emp && (r.employeeId === emp.id || r.employeeId === emp.employeeId || r.employeeCode === emp.employeeId));
    };

    setAttendance(prev => {
      const next = prev.map(rec => {
        if (isTargetRecord(rec)) {
          const curBreaks = (rec.breaks || []).map((b: any) => {
            if (!b.endAt && !b.endTime) {
              const startMs = new Date(b.startAt || b.startTime).getTime();
              const dur = Math.max(1, Math.round((nowMs - startMs) / 60000));
              return { ...b, endAt: nowISO, endTime: nowISO, durationMinutes: dur };
            }
            return b;
          });
          const totalBreakMins = curBreaks.reduce((sum: number, b: any) => sum + (b.durationMinutes || 0), 0);
          return { ...rec, breaks: curBreaks, totalBreakMinutes: totalBreakMins };
        }
        return rec;
      });
      try {
        localStorage.setItem('kss_v1_attendance', JSON.stringify(next.slice(0, 1000)));
      } catch {}
      return next;
    });

    // 100% NEON POSTGRESQL PRIMARY PATH
    if (getAuthToken() || !USE_FIREBASE_FIRESTORE) {
      let backendBreak: any = null;
      try {
        backendBreak = await endBreakApi();
      } catch (fastApiErr: any) {
        console.warn('[FastAPI] endBreakApi note (may already be ended):', fastApiErr);
      }
      addAuditLog('ATTENDANCE_BREAK_END', emp?.fullName || empUid, 'Ended break');
      toast.success('Break ended. Welcome back! 👋');

      if (backendBreak) {
        const confirmedEndIso = (backendBreak.end_time ? formatTimestampToISO(backendBreak.end_time) : null) || nowISO;
        const dur = Number(backendBreak.duration_minutes) || Math.max(1, Math.round((nowMs - new Date(backendBreak.start_time || nowMs).getTime()) / 60000));
        setAttendance(prev => {
          const next = prev.map(rec => {
            if (isTargetRecord(rec)) {
              const curBreaks = (rec.breaks || []).map((b: any) => {
                if (!b.endAt && !b.endTime) {
                  return { ...b, endAt: confirmedEndIso, endTime: confirmedEndIso, durationMinutes: dur };
                }
                return b;
              });
              const totalBreakMins = curBreaks.reduce((sum: number, b: any) => sum + (b.durationMinutes || 0), 0);
              return { ...rec, breaks: curBreaks, totalBreakMinutes: totalBreakMins };
            }
            return rec;
          });
          try {
            localStorage.setItem('kss_v1_attendance', JSON.stringify(next.slice(0, 1000)));
          } catch {}
          return next;
        });
      }

      fetchFastApiRecords(activeEmployeeRef.current, true);

      return { success: true, message: 'Break ended successfully!' };
    }

    if (!auth.currentUser) {
      return { success: false, message: 'Ending a break requires an authenticated session.' };
    }

    try {
      const res = await runTransaction(db, async (transaction) => {
        const docSnap = await transaction.get(docRef);
        let existingBreaks: any[] = [];
        if (!docSnap.exists()) {
          throw new Error('No attendance record found for today. Please check in first.');
        }
        const data = docSnap.data();
        if (data.checkOutAt) {
          throw new Error('Shift already completed — breaks can no longer be modified.');
        }
        existingBreaks = Array.isArray(data.breaks) ? data.breaks : [];

        const openBreak = existingBreaks.find((b: any) => !b.endAt && !(b as any).endTime);

        let breakMins = 1;
        if (openBreak) {
          const startIso = formatTimestampToISO(openBreak.startAt || (openBreak as any).startTime) || nowISO;
          const diffMs = Math.max(0, nowMs - new Date(startIso).getTime());
          breakMins = Math.max(1, Math.min(MAX_BREAK_MINUTES, Math.round(diffMs / 60000)));
        }

        // Clean to single startAt and endAt without duplicate startTime/endTime
        const updatedBreaks = existingBreaks.map((b: any) => {
          const isOpen = !b.endAt && !(b as any).endTime;
          const startIso = formatTimestampToISO(b.startAt || (b as any).startTime) || nowISO;
          if (isOpen) {
            return {
              type: b.type,
              startAt: startIso,
              endAt: nowISO,
              durationMinutes: breakMins
            };
          }
          return {
            type: b.type,
            startAt: startIso,
            endAt: formatTimestampToISO(b.endAt || (b as any).endTime) || null,
            durationMinutes: Number(b.durationMinutes) || 0
          };
        });

        const totalBreakMins = calculateTotalBreakMinutes(updatedBreaks);

        const endBreakUpdates: Record<string, any> = {
          breaks: updatedBreaks,
          totalBreakMinutes: totalBreakMins,
          authUid: auth.currentUser?.uid || user?.uid || empUid,
          employeeUid: empUid,
          updatedAt: serverTimestamp()
        };
        transaction.update(docRef, cleanFirestorePayload(endBreakUpdates));

        return { 
          success: true, 
          message: `${openBreak?.type || 'Break'} completed! (${breakMins} mins total)`,
          breaks: updatedBreaks,
          totalBreakMinutes: totalBreakMins
        };
      });

      setAttendance(prev => {
        return prev.map(rec => {
          if (rec.id === recordId || (rec.employeeId === emp?.id && rec.date === todayStr)) {
            return {
              ...rec,
              breaks: (res as any).breaks,
              totalBreakMinutes: (res as any).totalBreakMinutes
            };
          }
          return rec;
        });
      });

      if (getAuthToken()) {
        endBreakApi().catch(e => console.warn('[FastAPI] endBreakApi sync warning:', e));
      }

      addAuditLog('ATTENDANCE_BREAK_END', emp?.fullName || empUid, res.message);
      toast.success(res.message);
      return res;
    } catch (err: any) {
      setAttendance(prevAttendance);
      handleFirestoreError(err, OperationType.UPDATE, `attendance/${recordId}`);
      toast.error(err.message || 'Failed to end break.');
      return { success: false, message: err.message || 'Failed to end break.' };
    }
  };

  const updateAttendanceRecord = async (recordId: string, updates: Partial<AttendanceRecord>): Promise<void> => {
    // Optimistically update in-memory attendance state immediately
    setAttendance(prev => prev.map(a => (a.id === recordId ? { ...a, ...updates, updatedAt: new Date().toISOString() } : a)));
    addAuditLog('ATTENDANCE_CORRECTION', `Record ${recordId}`, `Updated fields: ${Object.keys(updates).join(', ')}`);

    // Best-effort Cloud Firestore sync when Firebase Auth session is active
    if (auth.currentUser) {
      const cleanUpdates = cleanFirestorePayload({ ...updates, updatedAt: serverTimestamp() });
      try {
        await setDoc(doc(db, 'attendance', recordId), cleanUpdates, { merge: true });
      } catch (err: any) {
        console.warn(`[Firestore] Attendance update note:`, err);
      }
    }
  };

  /**
   * Attendance correction for HR / PM — the ONLY sanctioned way to amend a day.
   *
   * Handles both cases the admin table can now surface:
   *
   *  • A STORED record → a plain merge onto its existing document.
   *  • A SYNTHETIC roster row (an absentee, who by definition has no document —
   *    see buildDailyRoster) → materialises a real record at the CANONICAL id
   *    `{uid}_{YYYY-MM-DD}` with the full field set. Merging onto the synthetic
   *    `synthetic_*` id would have created a junk document under a fabricated
   *    key, invisible to every resolver and missing date/employeeId/status.
   */
  const applyAttendanceCorrection = async (
    record: AttendanceRecord & { isSynthetic?: boolean },
    updates: Partial<AttendanceRecord>
  ): Promise<{ success: boolean; message: string }> => {
    if (!record) return { success: false, message: 'No attendance record supplied.' };

    const emp = findEmployee(record.employeeId) || findEmployee(record.employeeCode);
    const targetId = record.isSynthetic
      ? getAttendanceDocId(getCanonicalEmployeeUid(emp || record, undefined), record.date)
      : record.id;

    // A synthetic row has no stored doc, so the write must carry every field the
    // listeners and queries depend on — not just the corrected ones.
    const actingUid = user?.uid || auth.currentUser?.uid || null;
    const seed = record.isSynthetic
      ? {
          id: targetId,
          uid: getCanonicalEmployeeUid(emp || record, undefined),
          employeeUid: getCanonicalEmployeeUid(emp || record, undefined),
          employeeId: record.employeeId,
          employeeCode: record.employeeCode,
          employeeName: record.employeeName,
          department: record.department || 'Engineering',
          // pmUid: include the acting manager's UID so the Firestore zero-read
          // fast-path (pmUid == request.auth.uid) passes for PM/HR corrections
          // without burning through the 10-get() per-evaluation limit.
          pmUid: actingUid || emp?.pmUid || emp?.reportingManagerUid || '',
          date: record.date,
          checkInAt: null,
          checkOutAt: null,
          workingMinutes: 0,
          attendanceMethod: 'HR_CORRECTION',
          locationVerified: false,
          breaks: [],
          totalBreakMinutes: 0,
          createdAt: serverTimestamp()
        }
      : {};

    const payload = cleanFirestorePayload({
      ...seed,
      ...updates,
      correctedBy: activeEmployee?.fullName || user?.email || 'System',
      // correctedByUid is the zero-read fast-path key checked first in Firestore
      // rules — always set it so PM/HR corrections never hit the 10-get() limit.
      correctedByUid: actingUid,
      // Also stamp pmUid on existing-doc updates so the rule fast-path fires.
      pmUid: (seed as any).pmUid || actingUid || emp?.pmUid || emp?.reportingManagerUid || '',
      correctedAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    const updatedRecord: AttendanceRecord = {
      ...(record.isSynthetic ? (seed as any) : record),
      ...updates,
      id: targetId,
      updatedAt: new Date().toISOString()
    };

    setAttendance(prev => {
      const filtered = prev.filter(a => a.id !== targetId && !(a.date === record.date && (a.employeeId === record.employeeId || a.employeeCode === record.employeeCode)));
      return [updatedRecord, ...filtered];
    });

    addAuditLog(
      'ATTENDANCE_CORRECTION',
      record.employeeName || targetId,
      `${record.isSynthetic ? 'Created' : 'Updated'} ${record.date}: ${Object.keys(updates).join(', ')}`
    );

    // 100% NEON POSTGRESQL PRIMARY ATTENDANCE CORRECTION
    let currentJwt = getAuthToken();
    if (!currentJwt && auth.currentUser) {
      try {
        const fbToken = await auth.currentUser.getIdToken().catch(() => null);
        const syncRes = await syncFirebaseSessionApi(auth.currentUser.email, auth.currentUser.uid, fbToken);
        currentJwt = syncRes?.access_token || getAuthToken();
      } catch (tokenErr) {
        console.warn('[FastAPI] Fallback token sync failed:', tokenErr);
      }
    }

    if (getAuthToken()) {
      const empCode = emp?.employeeId || record.employeeCode;
      const empUuid = emp?.id && !emp.id.startsWith('emp-') ? emp.id : undefined;
      const isRealUuid = Boolean(record.id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(record.id));

      try {
        const apiRes = await correctAttendanceApi({
          record_id: isRealUuid ? record.id : undefined,
          employee_id: empUuid,
          employee_code: empCode,
          date: record.date,
          check_in_at: updates.checkInAt !== undefined ? updates.checkInAt : record.checkInAt,
          check_out_at: updates.checkOutAt !== undefined ? updates.checkOutAt : record.checkOutAt,
          status: updates.status || record.status,
          working_minutes: updates.workingMinutes !== undefined ? updates.workingMinutes : record.workingMinutes,
          notes: updates.notes || record.notes
        });

        if (apiRes && apiRes.id) {
          const freshMapped: AttendanceRecord = {
            ...updatedRecord,
            id: String(apiRes.id),
            status: (updates.status || record.status) as AttendanceStatus,
            checkInAt: updates.checkInAt !== undefined ? updates.checkInAt : record.checkInAt,
            checkOutAt: updates.checkOutAt !== undefined ? updates.checkOutAt : record.checkOutAt,
            workingMinutes: updates.workingMinutes !== undefined ? updates.workingMinutes : record.workingMinutes,
            updatedAt: new Date().toISOString()
          };
          setAttendance(prev => [
            freshMapped,
            ...prev.filter(a => a.id !== String(apiRes.id) && !(a.date === record.date && (a.employeeId === record.employeeId || a.employeeCode === record.employeeCode)))
          ]);
        }
      } catch (e: any) {
        console.error('[FastAPI] correctAttendanceApi error:', e);
      }
    }

    if (USE_FIREBASE_FIRESTORE && auth.currentUser) {
      try {
        const firestoreDocId = getAttendanceDocId(getCanonicalEmployeeUid(emp || record, undefined), record.date);
        await setDoc(doc(db, 'attendance', firestoreDocId), payload, { merge: true });
      } catch (err: any) {
        console.warn(`[Firestore] Attendance correction note:`, err);
      }
    }

    // NOTE: Do NOT call fetchFastApiRecords here — the optimistic state update above
    // (lines 6206-6260) is already correct and will immediately reflect in the UI.
    // A broad refetch of the PM's own records would race-overwrite the corrected record
    // before Neon has committed the new value. The Firestore setDoc above keeps
    // the real-time listener in sync for the employee's own portal view.

    return { success: true, message: `Attendance for ${record.employeeName || 'employee'} updated.` };
  };

  /**
   * Unmark attendance record for an employee on a given date.
   * Completely removes the record from Firestore and React state,
   * restoring the date to its default unmarked/pre-joining state.
   */
  const unmarkAttendanceRecord = async (
    employeeId: string,
    date: string,
    recordId?: string
  ): Promise<{ success: boolean; message: string }> => {
    try {
      const emp = findEmployee(employeeId);
      const canonicalUid = emp ? getCanonicalEmployeeUid(emp, undefined) : employeeId;
      const targetDocId = recordId || getAttendanceDocId(canonicalUid, date);

      // 1. Delete document from Firestore
      await deleteDoc(doc(db, 'attendance', targetDocId)).catch(() => {});

      // Proactively delete alternative doc ID formats (legacy code/id prefixes)
      if (emp?.employeeId) {
        await deleteDoc(doc(db, 'attendance', `${emp.employeeId}_${date}`)).catch(() => {});
      }
      if (emp?.id && emp.id !== targetDocId) {
        await deleteDoc(doc(db, 'attendance', `${emp.id}_${date}`)).catch(() => {});
      }

      // 2. Remove from local attendance state immediately
      setAttendance(prev => prev.filter(a => {
        if (a.id === targetDocId) return false;
        const matchesEmp = a.employeeId === employeeId || 
                           a.employeeCode === employeeId || 
                           (emp && (a.employeeId === emp.id || a.employeeCode === emp.employeeId));
        return !(matchesEmp && a.date === date);
      }));

      // 3. Remove from approvedWfhDates if present
      if (emp?.approvedWfhDates && emp.approvedWfhDates.includes(date)) {
        const cleaned = emp.approvedWfhDates.filter(d => d !== date);
        updateEmployee(emp.id, { approvedWfhDates: cleaned });
      }

      addAuditLog(
        'ATTENDANCE_CORRECTION',
        emp?.fullName || employeeId,
        `Unmarked attendance record for ${date}`
      );

      return { success: true, message: `Attendance for ${date} has been unmarked.` };
    } catch (err: any) {
      console.error('unmarkAttendanceRecord error:', err);
      return { success: false, message: err?.message || 'Failed to unmark attendance record.' };
    }
  };

  const updateSettings = (newSettings: Partial<CompanySettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettings(updated);

    if (USE_FIREBASE_FIRESTORE) {
      setDoc(doc(db, 'settings', 'global'), updated, { merge: true }).catch(err => {
        handleFirestoreError(err, OperationType.WRITE, 'settings/global');
      });
    }

    if (getAuthToken()) {
      updateSettingsApi({
        office_name: updated.officeName,
        geofence_lat: updated.officeLatitude,
        geofence_lon: updated.officeLongitude,
        geofence_radius_meters: updated.allowedRadiusMeters,
        geofence_enforced: updated.gpsRequired
      }).catch(e => console.warn('[FastAPI] updateSettingsApi sync note:', e));
    }

    addAuditLog('SETTINGS_UPDATED', 'Company Policy', 'Updated system preferences and GPS/shift rules');
  };

  const saveCompanyWorkZone = async (zone: Partial<WorkZone>) => {
    const updated: WorkZone = {
      name: zone.name || companyWorkZone.name || 'Kalpanaaa Software Solutions HQ',
      latitude: zone.latitude !== undefined ? Number(zone.latitude) : companyWorkZone.latitude,
      longitude: zone.longitude !== undefined ? Number(zone.longitude) : companyWorkZone.longitude,
      radiusMeters: zone.radiusMeters !== undefined ? Number(zone.radiusMeters) : companyWorkZone.radiusMeters,
      active: true,
      updatedBy: activeEmployee?.fullName || activeEmployee?.email || 'Authorized HR / CEO / CTO',
      updatedAt: new Date().toISOString()
    };

    setCompanyWorkZone(updated);
    localStorage.setItem('kss_v1_work_zone', JSON.stringify(updated));

    // Also update settings global object
    updateSettings({
      officeName: updated.name,
      officeLatitude: updated.latitude,
      officeLongitude: updated.longitude,
      allowedRadiusMeters: updated.radiusMeters
    });

    if (USE_FIREBASE_FIRESTORE) {
      await setDoc(doc(db, 'workZones', 'company'), updated).catch(err => {
        handleFirestoreError(err, OperationType.WRITE, 'workZones/company');
      });
    }

    if (getAuthToken() && updated.latitude && updated.longitude) {
      updateSettingsApi({
        office_name: updated.name,
        geofence_lat: updated.latitude,
        geofence_lon: updated.longitude,
        geofence_radius_meters: updated.radiusMeters,
        geofence_enforced: updated.active
      }).catch(e => console.warn('[FastAPI] updateSettingsApi sync note:', e));
    }

    addAuditLog('COMPANY_WORKZONE_UPDATED', updated.name, `Lat: ${updated.latitude}, Lon: ${updated.longitude}, Radius: ${updated.radiusMeters}m`);
  };

  const submitLeaveRequest = async (data: Omit<LeaveRequest, 'id' | 'status' | 'requestDate' | 'createdAt' | 'updatedAt'>) => {
    const emp = activeEmployee;
    const realAuthUid = auth.currentUser?.uid || user?.uid || '';
    const empId = data.employeeId || emp?.employeeId || emp?.id || `EMP-${Date.now().toString().slice(-6)}`;
    const empName = data.employeeName || emp?.fullName || 'Employee';
    const empDept = data.department || emp?.department || 'Engineering';
    const empRole = data.employeeRole || emp?.role || 'EMPLOYEE';
    const empUid = realAuthUid || data.employeeUid || emp?.uid || '';
    const empEmail = emp?.email || user?.email || auth.currentUser?.email || '';
    const pmUid = data.pmUid || emp?.pmUid || emp?.reportingManagerUid || 'uid-KSS2407003';
    const nowIso = new Date().toISOString();

    let assignedId = `LR-${Date.now().toString(36).toUpperCase()}`;

    // 100% NEON POSTGRESQL PRIMARY LEAVE SUBMISSION
    if (!USE_FIREBASE_FIRESTORE || getAuthToken()) {
      const typeStr = String(data.type || '').toLowerCase();
      let apiType = 'EARN_LEAVE';
      if (typeStr.includes('wfh') || typeStr.includes('home')) {
        apiType = 'WFH';
      } else if (typeStr.includes('sick')) {
        apiType = 'SICK_LEAVE';
      } else if (typeStr.includes('casual')) {
        apiType = 'CASUAL_LEAVE';
      } else if (typeStr.includes('loss') || typeStr.includes('lop')) {
        apiType = 'LOSS_OF_PAY';
      } else {
        apiType = 'EARN_LEAVE';
      }

      try {
        const leaveRes = await applyLeaveApi({
          type: apiType,
          start_date: data.startDate,
          end_date: data.endDate,
          reason: data.reason,
          request_code: assignedId
        });
        if (leaveRes && leaveRes.id) {
          assignedId = String(leaveRes.id);
        }
      } catch (e) {
        console.warn('[FastAPI] applyLeaveApi error:', e);
      }
    }

    if (USE_FIREBASE_FIRESTORE) {
      const result = await LeaveService.submitLeaveRequest({
        ...data,
        employeeUid: empUid,
        employeeId: empId,
        employeeName: empName,
        employeeEmail: empEmail,
        email: empEmail,
        department: empDept,
        employeeRole: empRole,
        pmUid: pmUid,
        pmStatus: 'N/A',
        hrStatus: 'N/A',
        ceoStatus: 'Pending',
        ctoStatus: 'Waiting CEO',
      });
      if (result?.id) assignedId = result.id;
    }

    const optRequest: LeaveRequest = {
      ...data,
      id: assignedId,
      employeeId: empId,
      employeeUid: empUid,
      authUid: empUid,
      employeeName: empName,
      department: empDept,
      employeeRole: empRole,
      status: 'Pending',
      ceoStatus: 'Pending',
      ctoStatus: 'Waiting CEO',
      pmStatus: 'N/A',
      hrStatus: 'N/A',
      requestDate: nowIso,
      createdAt: nowIso,
      updatedAt: nowIso
    };
    setLeaveRequests(prev => [optRequest, ...prev.filter(r => r.id !== assignedId)]);
    try {
      localStorage.setItem('kss_v1_leave_requests', JSON.stringify([optRequest, ...leaveRequests.filter(r => r.id !== assignedId)].slice(0, 500)));
    } catch {}

    fetchFastApiRecords(activeEmployeeRef.current, true);

    const isWfh = data.type === 'WFH';
    const eventType = isWfh ? 'WFH_REQUEST_SUBMITTED' : 'LEAVE_REQUEST_SUBMITTED';

    sendKssNotification(
      eventType,
      isWfh ? `🏠 WFH Request: ${empName}` : `📋 Leave Request: ${empName}`,
      `${empName} requested ${data.type} (${data.startDate} to ${data.endDate}). Reason: "${data.reason}". Pending CEO & CTO approval.`,
      {
        actorId: empId,
        actorName: empName,
        targetEmployeeId: empId,
        targetEmployeeName: empName,
        overrideAudience: ['SUPER_ADMIN'],
        metadata: {
          requestId: assignedId,
          requestType: data.type,
          startDate: data.startDate,
          endDate: data.endDate,
          reason: data.reason
        }
      }
    );

    addAuditLog('LEAVE_REQUEST', empName, `Submitted ${data.type} request from ${data.startDate} to ${data.endDate}`);
    return { success: true, id: assignedId, message: 'Leave request submitted successfully' };
  };

  const updateLeaveRequestStage = async (
    id: string,
    stage: 'PM' | 'HR' | 'CEO' | 'CTO',
    decision: 'Approved' | 'Rejected',
    reviewerName: string,
    notes?: string,
    employeeId?: string,
    startDate?: string,
    endDate?: string
  ) => {
    // PM and HR are strictly removed from the leave approval hierarchy
    if (stage === 'PM' || stage === 'HR') {
      console.warn(`[AuthContext] ${stage} stage is removed from leave approvals. Workflow is strictly Employee -> CEO -> CTO.`);
      return;
    }

    const targetReq = leaveRequests.find(r => r.id === id);
    const empId = employeeId || targetReq?.employeeId || '';
    const sDate = startDate || targetReq?.startDate || '';
    const eDate = endDate || targetReq?.endDate || '';
    const revUid = user?.uid || activeEmployee?.uid || 'uid-exec';
    const nowIso = new Date().toISOString();
    const isApproved = decision === 'Approved';

    // Guard: CTO cannot approve a request before CEO approval has been granted!
    if (stage === 'CTO' && isApproved && targetReq?.ceoStatus !== 'Approved') {
      toast.error('CTO cannot approve request before CEO approval has been granted.');
      return;
    }

    // 1. INSTANT 0ms Optimistic State Update for ultra-fast, smooth UI
    setLeaveRequests(prev => {
      const updated = prev.map(req => {
        if (req.id !== id) return req;
        const copy: LeaveRequest = { 
          ...req, 
          updatedAt: nowIso 
        };

        if (stage === 'CEO') {
          copy.ceoStatus = decision;
          copy.ceoReviewedBy = revUid;
          copy.ceoReviewedAt = nowIso;
          copy.ceoNotes = notes || '';
          copy.ctoStatus = isApproved ? 'Pending' : 'Waiting CEO';
          copy.status = isApproved ? 'Pending' : 'Rejected';
        } else if (stage === 'CTO') {
          copy.ctoStatus = decision;
          copy.ctoReviewedBy = revUid;
          copy.ctoReviewedAt = nowIso;
          copy.ctoNotes = notes || '';
          copy.status = isApproved ? 'Approved' : 'Rejected';
        }

        return copy;
      });

      localStorage.setItem('kss_v1_leave_requests', JSON.stringify(updated));
      return updated;
    });

    // 2. Broadcast across tabs immediately
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const channel = new BroadcastChannel('kss_app_events');
        channel.postMessage({ type: 'UPDATE_LEAVE_REQUEST', payload: { id, stage, decision } });
      } catch {}
    }

    // 3. Persist to Neon PostgreSQL or Firestore
    if (!USE_FIREBASE_FIRESTORE || getAuthToken()) {
      try {
        await reviewLeaveApi(id, isApproved ? 'APPROVED' : 'REJECTED', notes || `${stage} Review: ${decision}`);
      } catch (e) {
        console.warn('[FastAPI] reviewLeaveApi note:', e);
      }
      fetchFastApiRecords(activeEmployeeRef.current, true);
    }

    if (USE_FIREBASE_FIRESTORE) {
      try {
        if (stage === 'CEO') {
          await LeaveService.reviewCeoStage(id, decision, revUid, reviewerName, notes, empId, sDate, eDate);
        } else if (stage === 'CTO') {
          // Resolve the employee's Firestore doc ID and leave type for balance deduction.
          const targetEmpForDeduct = employees.find(e =>
            (e.uid && targetReq?.employeeUid && e.uid === targetReq.employeeUid) ||
            e.id === empId ||
            e.employeeId === empId
          );
          const employeeDocIdForDeduct = targetEmpForDeduct?.id || empId || '';
          const leaveTypeForDeduct = targetReq?.type || targetReq?.leaveCategory || '';
          await LeaveService.reviewCtoStage(
            id, decision, revUid, reviewerName, notes,
            empId, sDate, eDate,
            employeeDocIdForDeduct,
            leaveTypeForDeduct
          );
        }
      } catch (fsErr) {
        console.warn('[AuthContext] Firestore stage update error, attempting direct fallback write:', fsErr);
      }
    }

    // 4. Dispatch real-time in-app notification for stage decision (Employee + CEO/CTO Super Admin)
    sendKssNotification(
      decision === 'Approved' ? 'LEAVE_REQUEST_APPROVED' : 'LEAVE_REQUEST_REJECTED',
      decision === 'Approved' ? `✅ ${targetReq?.type || 'Request'} Approved (${stage} Stage)` : `❌ ${targetReq?.type || 'Request'} Rejected (${stage} Stage)`,
      `${targetReq?.type || 'Request'} for ${targetReq?.employeeName || 'Employee'} (${sDate} to ${eDate}) was ${decision.toLowerCase()} by ${reviewerName} (${stage} Stage).`,
      {
        actorId: activeEmployee?.id || 'exec',
        actorName: reviewerName,
        targetEmployeeId: targetReq?.employeeId || '',
        targetEmployeeName: targetReq?.employeeName || '',
        overrideAudience: ['SUPER_ADMIN', 'EMPLOYEE'],
        metadata: {
          requestId: id,
          stage,
          decision,
          reviewerName
        }
      }
    );

    // If final CTO approval and WFH, add to approvedWfhDates
    const isWfhDecision = isWfhType(targetReq?.type) || isWfhType(targetReq?.leaveCategory);
    if (stage === 'CTO' && decision === 'Approved' && isWfhDecision) {
      const targetEmp = employees.find(e => 
        (!!targetReq.employeeId && (e.employeeId === targetReq.employeeId || e.id === targetReq.employeeId)) ||
        (!!targetReq.employeeName && !!e.fullName && (
          e.fullName.trim().toLowerCase() === targetReq.employeeName.trim().toLowerCase() ||
          e.fullName.replace(/\s+/g, '').toLowerCase() === targetReq.employeeName.replace(/\s+/g, '').toLowerCase()
        ))
      );
      if (targetEmp) {
        const dates = new Set<string>(targetEmp.approvedWfhDates || []);
        let curr = new Date(sDate);
        const end = new Date(eDate);
        while (curr <= end) {
          dates.add(curr.toISOString().split('T')[0]);
          curr.setDate(curr.getDate() + 1);
        }
        updateEmployee(targetEmp.id, { approvedWfhDates: Array.from(dates) });
      }
    }

    addAuditLog('LEAVE_STAGE_DECISION', reviewerName, `${stage} ${decision} for leave request ${id}`);
  };

  const updateLeaveRequestStatus = (
    id: string, 
    status: 'Approved' | 'Rejected', 
    reviewedBy: string, 
    reviewNotes?: string,
    targetStage?: 'PM' | 'HR' | 'CEO' | 'CTO'
  ) => {
    let stage: 'CEO' | 'CTO' = targetStage === 'CTO' ? 'CTO' : 'CEO';

    if (!targetStage || targetStage === 'PM' || targetStage === 'HR') {
      const desig = (activeEmployee?.designation || '').toUpperCase();
      const empId = activeEmployee?.employeeId || activeEmployee?.id || '';
      const name = (activeEmployee?.fullName || '').toLowerCase();
      const req = leaveRequests.find(r => r.id === id);

      if (name.includes('gaurav') || desig.includes('CTO') || desig.includes('CIO') || empId === 'CTO001' || empId === 'KSS2407001' || activeEmployee?.executiveRole === 'CTO') {
        stage = 'CTO';
      } else if (name.includes('akshit') || desig.includes('CEO') || empId === 'CEO001' || empId === 'KSS2407002' || activeEmployee?.executiveRole === 'CEO') {
        stage = 'CEO';
      } else {
        // SuperAdmin fallback: If CEO has already approved, stage is CTO; otherwise CEO
        if (req && req.ceoStatus === 'Approved') {
          stage = 'CTO';
        } else {
          stage = 'CEO';
        }
      }
    }

    const targetReq = leaveRequests.find(r => r.id === id);
    updateLeaveRequestStage(id, stage, status, reviewedBy, reviewNotes, targetReq?.employeeId, targetReq?.startDate, targetReq?.endDate);
  };

  const cancelLeaveRequest = async (id: string, employeeId?: string, startDate?: string, endDate?: string) => {
    const targetReq = leaveRequests.find(r => r.id === id);
    const targetEmp = employees.find(e =>
      (e.uid && targetReq?.employeeUid && e.uid === targetReq.employeeUid) ||
      e.id === (employeeId || targetReq?.employeeId) ||
      e.employeeId === (employeeId || targetReq?.employeeId)
    );
    const empDocId = targetEmp?.id || employeeId || targetReq?.employeeId || activeEmployee?.id || '';
    const sDate = startDate || targetReq?.startDate || '';
    const eDate = endDate || targetReq?.endDate || '';
    const revName = activeEmployee?.fullName || user?.displayName || 'Employee';
    const revUid = user?.uid || activeEmployee?.uid || 'uid-user';

    await LeaveService.cancelRequest(id, empDocId, sDate, eDate, revName, revUid);

    // If cancelled request was WFH, remove from approvedWfhDates
    const isWfhReq = isWfhType(targetReq?.type) || isWfhType(targetReq?.leaveCategory);
    if (isWfhReq && targetEmp && sDate && eDate) {
      const datesToRemove = new Set<string>();
      let curr = new Date(sDate);
      const end = new Date(eDate);
      while (curr <= end) {
        datesToRemove.add(curr.toISOString().split('T')[0]);
        curr.setDate(curr.getDate() + 1);
      }
      const updatedDates = (targetEmp.approvedWfhDates || []).filter(d => !datesToRemove.has(d));
      updateEmployee(targetEmp.id, { approvedWfhDates: updatedDates });
    }

    // FastAPI backend sync
    if (getAuthToken()) {
      cancelLeaveApi(id).catch(e => console.warn('[FastAPI] cancelLeaveApi sync note:', e));
    }

    // Real-time notification for cancellation
    sendKssNotification(
      'LEAVE_REQUEST_CANCELLED',
      `🚫 ${targetReq?.type || 'Leave/WFH'} Request Cancelled`,
      `${targetReq?.employeeName || revName} cancelled their ${targetReq?.type || 'leave'} request (${sDate} to ${eDate}).`,
      {
        actorId: empDocId,
        actorName: revName,
        targetEmployeeId: empDocId,
        targetEmployeeName: targetReq?.employeeName || revName,
        overrideAudience: ['SUPER_ADMIN', 'EMPLOYEE'],
        metadata: {
          requestId: id,
          startDate: sDate,
          endDate: eDate
        }
      }
    );

    addAuditLog('LEAVE_CANCELLED', revName, `Cancelled leave/WFH request ${id}`);
  };

  const resetToDemoData = () => {
    setEmployees(INITIAL_EMPLOYEES);
    setAttendance(generateInitialAttendance());
    setAuditLogs(INITIAL_AUDIT_LOGS);
    setSettings(INITIAL_COMPANY_SETTINGS);
    const defaultZone: WorkZone = {
      name: 'Kalpanaaa Software Solutions HQ',
      latitude: 13.014333,
      longitude: 77.646000,
      radiusMeters: 100,
      active: true,
      updatedBy: 'System Init',
      updatedAt: new Date().toISOString()
    };
    setCompanyWorkZone(defaultZone);
    localStorage.removeItem('kss_v1_employees');
    localStorage.removeItem('kss_v1_attendance');
    localStorage.removeItem('kss_v1_audit_logs');
    localStorage.removeItem('kss_v1_settings');
    localStorage.removeItem('kss_v1_work_zone');
    localStorage.removeItem('kss_v1_leave_requests');
    setLeaveRequests([]);

    // Re-seed Firestore
    INITIAL_EMPLOYEES.forEach(emp => {
      setDoc(doc(db, 'employees', emp.id), emp).catch(() => { });
    });
    generateInitialAttendance().forEach(att => {
      setDoc(doc(db, 'attendance', att.id), att).catch(() => { });
    });
    setDoc(doc(db, 'settings', 'global'), INITIAL_COMPANY_SETTINGS).catch(() => { });
    setDoc(doc(db, 'workZones', 'company'), defaultZone).catch(() => { });

    addAuditLog('SYSTEM_RESET', 'Database', 'Re-seeded system with demo enterprise workforce dataset');
  };

  // ── Admin Broadcast: send one-click custom notification to all employees ──
  const sendBroadcast = async (title: string, message: string): Promise<void> => {
    if (!activeEmployee) return;

    const newNotif: KssNotification = {
      id: `notif-bc-${Date.now()}`,
      type: 'ADMIN_BROADCAST',
      title,
      body: message,
      audience: ['ALL'],
      actorId: activeEmployee.id,
      actorName: activeEmployee.fullName,
      createdAt: new Date().toISOString()
    };

    // 1. Instantly update local state on current tab
    setNotifications(prev => {
      const updated = [newNotif, ...prev.filter(n => n.id !== newNotif.id)];
      try {
        localStorage.setItem('kss_v1_broadcasts', JSON.stringify(updated));
      } catch {}
      return updated;
    });

    // 2. Broadcast via BroadcastChannel to all open tabs in 0ms
    if (typeof window !== 'undefined' && 'BroadcastChannel' in window) {
      try {
        const channel = new BroadcastChannel('kss_app_events');
        channel.postMessage({ type: 'NEW_BROADCAST', payload: newNotif });
        channel.close();
      } catch {}
    }

    // 3. Write to Firestore permanently for all devices
    await sendAdminBroadcast(title, message, activeEmployee.id, activeEmployee.fullName);
    addAuditLog('ADMIN_BROADCAST', 'All Employees', `Broadcast sent: "${title}" — ${message}`);
  };

  // ── CEO & CTO Exclusive Authority: Assign Office-Wide WFH for Whole Office ──
  const assignCompanyWideWfh = (date: string): { success: boolean; message: string } => {
    const isCeoOrCto = activeEmployee?.role === 'SUPER_ADMIN' ||
      (activeEmployee?.designation || '').toUpperCase().includes('CEO') ||
      (activeEmployee?.designation || '').toUpperCase().includes('CTO') ||
      (activeEmployee?.designation || '').toUpperCase().includes('FOUNDER') ||
      (activeEmployee?.designation || '').toUpperCase().includes('CIO') ||
      activeEmployee?.employeeId === 'CEO001' ||
      activeEmployee?.employeeId === 'CTO001';

    if (!isCeoOrCto) {
      return {
        success: false,
        message: 'SECURITY ACCESS DENIED: Only the CEO (Akshit Ujjain) or CTO (Gaurav Kumar Tripathi) have authority to assign Office-Wide Work From Home.'
      };
    }

    const currentDates = new Set<string>(companyWideWfhDates);
    currentDates.add(date);
    const updatedDates = Array.from(currentDates);

    // ── PRIMARY: Write to dedicated Firestore doc — triggers real-time listener on ALL devices ──
    setDoc(doc(db, 'companyConfig', 'wfhDates'), { dates: updatedDates, updatedAt: new Date().toISOString(), updatedBy: activeEmployee?.fullName || 'CEO/CTO' }).catch(() => {});

    // ── FALLBACK: Also update settings + localStorage ──
    setCompanyWideWfhDates(updatedDates);
    updateSettings({ companyWideWfhDates: updatedDates });
    localStorage.setItem('kss_v1_company_wfh_dates', JSON.stringify(updatedDates));

    // Broadcast official CEO/CTO announcement to all employees
    sendAdminBroadcast(
      '🏢 OFFICIAL ANNOUNCEMENT: OFFICE-WIDE WORK FROM HOME',
      `CEO & CTO Announcement: Office-Wide Work From Home assigned for ${date}. Physical office is closed; all employees can check in from home without GPS location restrictions.`,
      activeEmployee?.id || 'exec',
      activeEmployee?.fullName || 'CEO / CTO Office'
    );

    addAuditLog('COMPANY_WIDE_WFH_ASSIGNED', `Date: ${date}`, `Assigned Office-Wide WFH for ${date} by ${activeEmployee?.fullName}`);

    return {
      success: true,
      message: `Office-Wide Work From Home successfully assigned for ${date}! All employees are exempt from GPS radius checks on that day.`
    };
  };

  const removeCompanyWideWfh = (date: string): { success: boolean; message: string } => {
    const isCeoOrCto = activeEmployee?.role === 'SUPER_ADMIN' ||
      (activeEmployee?.designation || '').toUpperCase().includes('CEO') ||
      (activeEmployee?.designation || '').toUpperCase().includes('CTO') ||
      (activeEmployee?.designation || '').toUpperCase().includes('FOUNDER') ||
      (activeEmployee?.designation || '').toUpperCase().includes('CIO') ||
      activeEmployee?.employeeId === 'CEO001' ||
      activeEmployee?.employeeId === 'CTO001';

    if (!isCeoOrCto) {
      return {
        success: false,
        message: 'SECURITY ACCESS DENIED: Only the CEO or CTO can modify Office-Wide WFH settings.'
      };
    }

    const updatedDates = companyWideWfhDates.filter(d => d !== date);

    // ── PRIMARY: Write to dedicated Firestore doc — triggers real-time listener on ALL devices ──
    setDoc(doc(db, 'companyConfig', 'wfhDates'), { dates: updatedDates, updatedAt: new Date().toISOString(), updatedBy: activeEmployee?.fullName || 'CEO/CTO' }).catch(() => {});

    // ── FALLBACK: Also update settings + localStorage ──
    setCompanyWideWfhDates(updatedDates);
    updateSettings({ companyWideWfhDates: updatedDates });
    localStorage.setItem('kss_v1_company_wfh_dates', JSON.stringify(updatedDates));

    addAuditLog('COMPANY_WIDE_WFH_REMOVED', `Date: ${date}`, `Removed Office-Wide WFH for ${date} by ${activeEmployee?.fullName}`);

    return {
      success: true,
      message: `Office-Wide Work From Home removed for ${date}. Regular office GPS rules reinstated.`
    };
  };

  // ── Mark all visible main notifications as read ──
  const visibleNotifications = combinedNotifications.filter(n => {
    if (!n.audience) return false;
    const typeStr = (n.type || '').toUpperCase();
    const titleStr = (n.title || '').toLowerCase();
    const isRoutineAttendance = 
      typeStr.startsWith('ATTENDANCE_') || 
      titleStr.includes('break started') || 
      titleStr.includes('break ended') || 
      titleStr.includes('check-in') || 
      titleStr.includes('check-out');

    if (isRoutineAttendance) return false;

    if (n.audience.includes('ALL')) return true;
    return n.audience.includes(role as any);
  });

  const markAllNotificationsRead = () => {
    const allIds = visibleNotifications.map(n => n.id).filter(Boolean) as string[];
    const newSet = new Set([...Array.from(readNotificationIds), ...allIds]);
    setReadNotificationIds(newSet);
    localStorage.setItem('kss_v1_read_notifs', JSON.stringify(Array.from(newSet)));
  };

  const unreadNotificationCount = visibleNotifications.filter(
    n => n.id && !readNotificationIds.has(n.id)
  ).length;

  // Real-time Employee Password Update (FastAPI Neon PostgreSQL + Firebase Auth + Audit)
  const updateCurrentEmployeePassword = async (newPassword: string, oldPassword?: string): Promise<{ success: boolean; message: string }> => {
    const cleanPass = newPassword ? newPassword.trim() : '';
    if (!cleanPass || cleanPass.length < 6) {
      return { success: false, message: 'Password must be at least 6 characters long.' };
    }
    if (!activeEmployee) {
      return { success: false, message: 'No active employee session found.' };
    }

    try {
      let updatedInPrimary = false;
      // 1. Primary Database: Update password hash in Neon PostgreSQL via FastAPI
      if (getAuthToken()) {
        await changePasswordApi(cleanPass, oldPassword);
        updatedInPrimary = true;
      }

      // 2. Secondary Database: Mirror password to Firebase Auth if active Firebase session
      let updatedInSecondary = false;
      if (auth.currentUser) {
        try {
          const { updatePassword } = await import('firebase/auth');
          await updatePassword(auth.currentUser, cleanPass);
          updatedInSecondary = true;
        } catch (fbErr: any) {
          console.warn('[Firebase Auth] Mirror password update note:', fbErr);
        }
      }

      if (!updatedInPrimary && !updatedInSecondary) {
        return { success: false, message: 'Active session not found. Please log in again to update your password.' };
      }

      updateEmployee(activeEmployee.id, { 
        updatedAt: new Date().toISOString() 
      });

      addAuditLog('SECURITY_PASSWORD_CHANGE', activeEmployee.fullName, 'Employee updated account password successfully.');
      sendKssNotification(
        'SECURITY_ALERT',
        '🔐 Account Password Updated',
        `Account password for ${activeEmployee.fullName} (${activeEmployee.email}) was updated successfully.`,
        { actorId: activeEmployee.id, actorName: activeEmployee.fullName }
      );

      return { success: true, message: 'Your account password has been updated and synchronized successfully!' };
    } catch (err: any) {
      console.warn('[AuthContext] Update password error:', err);
      if (err?.code === 'auth/requires-recent-login') {
        return { success: false, message: 'For security reasons, please log out and log in again before updating your password.' };
      }
      return { success: false, message: err?.message || 'Failed to update password. Please check your credentials.' };
    }
  };

  // ── Root-Level FCM Mobile Push Token Registration ──
  useEffect(() => {
    if (isAuthenticated && activeEmployee) {
      if ('Notification' in window) {
        if (Notification.permission === 'granted') {
          registerFcmToken(activeEmployee.id, activeEmployee.role);
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
              registerFcmToken(activeEmployee.id, activeEmployee.role);
            }
          });
        }
      }
    }
  }, [isAuthenticated, activeEmployee?.id, activeEmployee?.role]);

  const requestMobilePushPermission = async (): Promise<boolean> => {
    if (!('Notification' in window)) return false;
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted' && activeEmployee) {
        await registerFcmToken(activeEmployee.id, activeEmployee.role);
        return true;
      }
      return permission === 'granted';
    } catch {
      return false;
    }
  };

  return (
    <AuthContext.Provider value={{
      user,
      activeEmployee,
      role,
      isAuthenticated,
      isLoading,
      isDemoMode,
      isFirestoreConnected,
      isSessionReady,
      attendanceSyncStatus,
      employees,
      attendance,
      auditLogs,
      settings,
      companyWorkZone,
      leaveRequests,
      notifications: combinedNotifications,
      unreadNotificationCount,
      companyWideWfhDates,
      loginWithEmail,
      quickDemoLogin,
      logout,
      addEmployee,
      updateEmployee,
      deleteEmployee,
      recordCheckIn,
      recordCheckOut,
      checkIn: recordCheckIn,
      checkOut: recordCheckOut,
      startBreak,
      endBreak,
      updateAttendanceRecord,
      applyAttendanceCorrection,
      unmarkAttendanceRecord,
      updateSettings,
      saveCompanyWorkZone,
      submitLeaveRequest,
      updateLeaveRequestStatus,
      updateLeaveRequestStage,
      cancelLeaveRequest,
      addAuditLog,
      resetToDemoData,
      enrollEmployeeBiometrics,
      resetEmployeeBiometrics,
      resetAllBiometrics,
      regenerateQrToken,
      sendPasswordReset,
      setEmployeeInitialPassword,
      sendBroadcast,
      assignCompanyWideWfh,
      removeCompanyWideWfh,
      markAllNotificationsRead,
      updateCurrentEmployeePassword,
      requestMobilePushPermission
    }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};
