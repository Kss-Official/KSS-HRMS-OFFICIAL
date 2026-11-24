/**
 * Leave & LOP Summary Service
 * 
 * Provides production-ready calculation, classification, and export logic
 * for the HRMS Admin "Leave & LOP Summary" dashboard section using real Firestore data.
 * 
 * Guarantees:
 * 1. Strict date boundary clipping (only days in [startDate, endDate] are counted).
 * 2. Leave taken only (dates <= todayInIST(); future approved leaves excluded).
 * 3. Authoritative approval checks (only approved requests; strictly excludes pending/rejected/cancelled).
 * 4. High-precision classification:
 *    - LOP: explicit type, category, or notes mentioning Loss of Pay/LOP/unpaid, or attendance marked LOP.
 *    - SL: Sick Leave in type or notes.
 *    - EL: Earned / Paid leave.
 *    - WFH: Strictly excluded from leave calculations (remote work is not leave).
 * 5. Weekend & Gazetted holiday handling (Sundays & company holidays not deducted).
 * 6. Zero duplicate counting between leave requests, notes, and attendance.
 * 7. 100% mathematical reconciliation between KPI cards, comparison chart, and employee table.
 * 8. Clean export to CSV and Excel (.xlsx via ExcelJS).
 */

import { Employee, LeaveRequest, AttendanceRecord, CompanySettings } from '../types';
import { 
  OFFICIAL_HOLIDAY_DATES_2026, 
  isNonWorkingDay, 
  isWfhType,
  WEEKLY_OFF_DAYS,
  computeTotalLeaveBalances
} from './attendanceEngine';
import { todayInIST } from './absoluteTime';

export type LeaveLopFilterOption = '7d' | '15d' | '30d' | 'custom';

export interface LeaveLopDayDetail {
  date: string; // YYYY-MM-DD
  dayOfWeek: string;
  leaveType: 'LOP' | 'EL' | 'SL';
  daysValue: number; // 0.5 or 1.0
  isHalfDay: boolean;
  source: 'leave_request' | 'attendance_record';
  requestId?: string;
  reason?: string;
  notes?: string;
}

export interface EmployeeLeaveLopItem {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  department: string;
  designation: string;
  avatarUrl?: string;
  status: string;
  lopDays: number;
  elDays: number;
  slDays: number;
  totalLeaveDays: number;
  elBalance?: number;
  slBalance?: number;
  specialization?: string;
  leaveDays: LeaveLopDayDetail[];
}

export interface LeaveLopChartDatum {
  category: string;
  shortLabel: string;
  days: number;
  fill: string;
  percentage: number;
  uniqueStaff: number;
}

export interface LeaveLopSummaryResult {
  filter: LeaveLopFilterOption;
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  label: string;
  daysCount: number;
  dateList: string[];

  // 3 Primary KPI Cards
  totalLopDays: number;
  totalElDays: number;
  totalSlDays: number;

  // Global totals across all employees
  totalLeaveDays: number;
  uniqueLopCount: number;
  uniqueElCount: number;
  uniqueSlCount: number;
  uniqueLeaveStaffCount: number;
  totalActiveStaff: number;

  // Visual Breakdowns
  distribution: {
    lopPercent: number;
    elPercent: number;
    slPercent: number;
  };
  chartData: LeaveLopChartDatum[];

  // Employee-wise table records
  items: EmployeeLeaveLopItem[];
}

/**
 * Format date string YYYY-MM-DD to localized Indian standard display (e.g. "16 Oct 2026").
 */
export function formatSummaryDisplayDate(dateStr: string): string {
  if (!dateStr) return '';
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return dt.toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'Asia/Kolkata'
  });
}

/**
 * Generates an array of all chronological YYYY-MM-DD dates between start and end inclusive.
 */
export function generateDateRangeList(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  if (!startStr || !endStr) return dates;
  const [sy, sm, sd] = startStr.split('-').map(Number);
  const [ey, em, ed] = endStr.split('-').map(Number);
  if (!sy || !sm || !sd || !ey || !em || !ed) return dates;

  const cur = new Date(Date.UTC(sy, sm - 1, sd, 12, 0, 0));
  const end = new Date(Date.UTC(ey, em - 1, ed, 12, 0, 0));
  if (cur > end) return dates;

  while (cur <= end) {
    const y = cur.getUTCFullYear();
    const m = String(cur.getUTCMonth() + 1).padStart(2, '0');
    const d = String(cur.getUTCDate()).padStart(2, '0');
    dates.push(`${y}-${m}-${d}`);
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return dates;
}

/**
 * Computes canonical start and end dates for the selected date filter in Asia/Kolkata timezone.
 */
export function resolveDateFilterInterval(
  filter: LeaveLopFilterOption,
  customStart?: string,
  customEnd?: string
): { startDate: string; endDate: string; label: string; dateList: string[] } {
  const today = todayInIST();

  if (filter === '7d' || filter === '15d' || filter === '30d') {
    const daysBack = filter === '7d' ? 6 : filter === '15d' ? 14 : 29;
    const [y, m, d] = today.split('-').map(Number);
    const startObj = new Date(Date.UTC(y, m - 1, d - daysBack, 12, 0, 0));
    const startStr = `${startObj.getUTCFullYear()}-${String(startObj.getUTCMonth() + 1).padStart(2, '0')}-${String(startObj.getUTCDate()).padStart(2, '0')}`;
    const dateList = generateDateRangeList(startStr, today);
    const name = filter === '7d' ? 'Last 7 Days' : filter === '15d' ? 'Last 15 Days' : 'Last 30 Days';

    return {
      startDate: startStr,
      endDate: today,
      label: `${name} (${formatSummaryDisplayDate(startStr)} – ${formatSummaryDisplayDate(today)})`,
      dateList
    };
  }

  // Custom filter
  let start = customStart?.trim() || today;
  let end = customEnd?.trim() || today;
  if (start > end) {
    const tmp = start;
    start = end;
    end = tmp;
  }
  const dateList = generateDateRangeList(start, end);
  return {
    startDate: start,
    endDate: end,
    label: `Custom Range (${formatSummaryDisplayDate(start)} – ${formatSummaryDisplayDate(end)})`,
    dateList
  };
}

/**
 * Checks if a leave request is officially approved and authoritative.
 */
export function isAuthoritativeApprovedLeave(r: LeaveRequest): boolean {
  if (!r) return false;
  if (r.status === 'Rejected' || r.status === 'Cancelled') return false;
  if (r.status === 'Approved') return true;

  // Direct CEO -> CTO completed status check
  const ceoOk = r.ceoStatus === 'Approved' || r.ceoStatus === 'N/A' || r.ceoStatus === 'Bypassed';
  const ctoOk = r.ctoStatus === 'Approved' || r.ctoStatus === 'N/A' || r.ctoStatus === 'Bypassed';

  const hasAnyPending = r.ceoStatus === 'Pending' || r.ctoStatus === 'Pending';
  const hasAnyRejected = r.ceoStatus === 'Rejected' || r.ctoStatus === 'Rejected';

  return ceoOk && ctoOk && !hasAnyPending && !hasAnyRejected;
}

/**
 * Classifies an approved leave request into:
 * 'WFH' | 'LOP' | 'SL' | 'EL'
 * Respects explicit type, category, and notes/reasons (e.g. Akash SB's LOP note).
 */
export function classifyLeaveTypeStrict(req: {
  type?: string;
  leaveCategory?: string;
  reason?: string;
  reviewNotes?: string;
  pmNotes?: string;
  hrNotes?: string;
  ceoNotes?: string;
  ctoNotes?: string;
}): 'WFH' | 'LOP' | 'SL' | 'EL' {
  const t = (req.type || '').trim().toLowerCase();
  const cat = (req.leaveCategory || '').trim().toLowerCase();

  // 1. Exclude Work From Home
  if (isWfhType(req.type) || isWfhType(req.leaveCategory)) {
    return 'WFH';
  }

  const textCorpus = [
    req.reason || '',
    req.reviewNotes || '',
    req.pmNotes || '',
    req.hrNotes || '',
    req.ceoNotes || '',
    req.ctoNotes || ''
  ].join(' ').toLowerCase();

  // 2. Loss of Pay (LOP)
  // Matches "loss of pay", "lop", "unpaid", "without pay", "lwp"
  // Whole-word regex prevents false matches on words like "slope", "develop"
  const lopRegex = /\b(loss\s+of\s+pay|lop|unpaid|without\s+pay|lwp|leave\s+without\s+pay)\b/i;
  if (
    t === 'loss of pay' || 
    t === 'lop' || 
    cat === 'loss of pay' || 
    cat === 'lop' || 
    lopRegex.test(textCorpus)
  ) {
    return 'LOP';
  }

  // 3. Sick Leave (SL)
  if (
    t === 'sick leave' || 
    cat === 'sick leave' || 
    t.includes('sick') || 
    cat.includes('sick') || 
    textCorpus.includes('sick leave')
  ) {
    return 'SL';
  }

  // 4. Default: Earned Leave (EL)
  return 'EL';
}

/**
 * Matches an employee against a leave request or attendance record.
 */
export function matchEmployeeToRecord(
  emp: Employee,
  target: {
    employeeId?: string;
    employeeCode?: string;
    employeeUid?: string;
    employeeName?: string;
  }
): boolean {
  if (!emp || !target) return false;

  // Match by Firestore doc ID or corporate code
  if (target.employeeId && (
    target.employeeId === emp.id || 
    target.employeeId === emp.employeeId || 
    target.employeeId === emp.uid
  )) {
    return true;
  }

  if (target.employeeCode && (
    target.employeeCode === emp.employeeId || 
    target.employeeCode === emp.id
  )) {
    return true;
  }

  if (target.employeeUid && (
    target.employeeUid === emp.uid || 
    target.employeeUid === emp.id || 
    target.employeeUid === emp.employeeId
  )) {
    return true;
  }

  // Name match fallback
  if (target.employeeName && emp.fullName) {
    const a = target.employeeName.trim().toLowerCase();
    const b = emp.fullName.trim().toLowerCase();
    if (a === b) return true;
    if (a.replace(/\s+/g, '') === b.replace(/\s+/g, '')) return true;
  }

  return false;
}

/**
 * Deduplicates raw employees array by corporate employeeId / doc ID.
 */
export function deduplicateEmployees(employees: Employee[]): Employee[] {
  const map = new Map<string, Employee>();
  for (const emp of (employees || [])) {
    if (!emp || !emp.id) continue;
    const key = emp.employeeId || emp.id;
    if (!map.has(key)) {
      map.set(key, emp);
    } else {
      // Prefer active profile if one is inactive
      const existing = map.get(key)!;
      if (existing.status === 'Inactive' && emp.status === 'Active') {
        map.set(key, emp);
      }
    }
  }
  return Array.from(map.values());
}

/**
 * Core Calculation Engine: Computes exact Leave & LOP Summary from real Firestore collections.
 */
export function computeLeaveLopSummary(
  rawEmployees: Employee[],
  rawLeaveRequests: LeaveRequest[],
  rawAttendance: AttendanceRecord[],
  settings?: CompanySettings,
  filter: LeaveLopFilterOption = '7d',
  customStart?: string,
  customEnd?: string
): LeaveLopSummaryResult {
  const todayStr = todayInIST();
  const interval = resolveDateFilterInterval(filter, customStart, customEnd);

  const holidays = Array.from(new Set([
    ...OFFICIAL_HOLIDAY_DATES_2026,
    ...(((settings as any)?.holidayDates) || [])
  ]));

  // Deduplicate and filter active staff (exclude Inactive / Terminated accounts)
  const uniqueEmployees = deduplicateEmployees(rawEmployees);
  const activeEmployees = uniqueEmployees.filter(e => 
    e.status !== 'Inactive' && 
    e.status !== 'Terminated'
  );

  // Filter approved leave requests only (strictly exclude pending, rejected, cancelled)
  const approvedRequests = (rawLeaveRequests || []).filter(isAuthoritativeApprovedLeave);

  const employeeItems: EmployeeLeaveLopItem[] = [];

  let grandLopDays = 0;
  let grandElDays = 0;
  let grandSlDays = 0;

  let uniqueLopStaffCount = 0;
  let uniqueElStaffCount = 0;
  let uniqueSlStaffCount = 0;
  let uniqueAnyLeaveStaffCount = 0;

  for (const emp of activeEmployees) {
    const empJoinDate = emp.joiningDate || (emp as any).joining_date || '';
    const leaveDayDetails: LeaveLopDayDetail[] = [];

    let empLop = 0;
    let empEl = 0;
    let empSl = 0;

    // Filter relevant requests for this employee
    const empRequests = approvedRequests.filter(r => matchEmployeeToRecord(emp, r));

    // Filter relevant attendance records for this employee
    const empAttendance = (rawAttendance || []).filter(a => 
      matchEmployeeToRecord(emp, a) &&
      a.date >= interval.startDate &&
      a.date <= interval.endDate
    );

    for (const dateStr of interval.dateList) {
      // Rule 1: Leave taken only (dates > today are future approved leaves, not yet taken)
      if (dateStr > todayStr) continue;

      // Rule 2: Pre-joining days are not counted
      if (empJoinDate && dateStr < empJoinDate) continue;

      // Rule 3: Exclude Sundays and official company holidays from leave deduction
      if (isNonWorkingDay(dateStr, holidays, WEEKLY_OFF_DAYS)) continue;

      const [y, m, d] = dateStr.split('-').map(Number);
      const dateObj = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
      const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });

      // SOURCE 1: Approved Leave Request covering dateStr
      const matchedReq = empRequests.find(r => {
        const s = r.startDate || (r as any).fromDate;
        const e = r.endDate || (r as any).toDate || s;
        return s && e && dateStr >= s && dateStr <= e;
      });

      if (matchedReq) {
        const classified = classifyLeaveTypeStrict(matchedReq);
        if (classified === 'WFH') {
          // Remote work is strictly excluded from leave days
          continue;
        }

        const isHalf = (matchedReq as any).isHalfDay === true || 
                       (matchedReq.reason && matchedReq.reason.toLowerCase().includes('half day'));
        const dayVal = isHalf ? 0.5 : 1.0;

        if (classified === 'LOP') empLop += dayVal;
        else if (classified === 'SL') empSl += dayVal;
        else empEl += dayVal;

        leaveDayDetails.push({
          date: dateStr,
          dayOfWeek,
          leaveType: classified,
          daysValue: dayVal,
          isHalfDay: isHalf,
          source: 'leave_request',
          requestId: matchedReq.id,
          reason: matchedReq.reason,
          notes: matchedReq.reviewNotes
        });

        // Handled authoritative leave request; DO NOT double-count with attendance
        continue;
      }

      // SOURCE 2: Confirmed Loss of Pay recorded directly in Attendance
      const matchedAtt = empAttendance.find(a => a.date === dateStr);
      if (matchedAtt) {
        const attStatus = (matchedAtt.status || '') as string;
        const notes = (matchedAtt.notes || '').toLowerCase();
        const isLop = attStatus === 'Loss of Pay' || 
                      attStatus === 'LOP' || 
                      notes.includes('lop') || 
                      notes.includes('loss of pay');

        if (isLop) {
          const isHalf = attStatus === 'Half Day';
          const dayVal = isHalf ? 0.5 : 1.0;
          empLop += dayVal;

          leaveDayDetails.push({
            date: dateStr,
            dayOfWeek,
            leaveType: 'LOP',
            daysValue: dayVal,
            isHalfDay: isHalf,
            source: 'attendance_record',
            notes: matchedAtt.notes || 'Marked as Loss of Pay in attendance log'
          });
        }
      }
    }

    const empTotal = empLop + empEl + empSl;

    if (empLop > 0) uniqueLopStaffCount++;
    if (empEl > 0) uniqueElStaffCount++;
    if (empSl > 0) uniqueSlStaffCount++;
    if (empTotal > 0) uniqueAnyLeaveStaffCount++;

    grandLopDays += empLop;
    grandElDays += empEl;
    grandSlDays += empSl;

    // Calculate balances at interval end date
    const empBalances = computeTotalLeaveBalances(emp, rawLeaveRequests, new Date(`${interval.endDate}T23:59:59`));

    employeeItems.push({
      employeeId: emp.id,
      employeeCode: emp.employeeId || emp.id,
      fullName: emp.fullName || 'Unknown Employee',
      department: emp.department || 'General',
      designation: emp.designation || 'Staff',
      avatarUrl: emp.profilePhotoUrl,
      status: emp.status,
      lopDays: empLop,
      elDays: empEl,
      slDays: empSl,
      totalLeaveDays: empTotal,
      elBalance: empBalances?.earnLeave?.balance ?? 0,
      slBalance: empBalances?.sickLeave?.balance ?? 0,
      leaveDays: leaveDayDetails
    });
  }

  // Sort employees: highest total leave days taken first, then alphabetically by name
  employeeItems.sort((a, b) => b.totalLeaveDays - a.totalLeaveDays || a.fullName.localeCompare(b.fullName));

  const grandTotalLeaveDays = grandLopDays + grandElDays + grandSlDays;
  const denom = grandTotalLeaveDays > 0 ? grandTotalLeaveDays : 1;

  const lopPercent = grandTotalLeaveDays > 0 ? Math.round((grandLopDays / denom) * 100) : 0;
  const elPercent = grandTotalLeaveDays > 0 ? Math.round((grandElDays / denom) * 100) : 0;
  const slPercent = grandTotalLeaveDays > 0 ? Math.round((grandSlDays / denom) * 100) : 0;

  // Chart comparative data
  const chartData: LeaveLopChartDatum[] = [
    {
      category: 'Loss of Pay (LOP)',
      shortLabel: 'LOP',
      days: grandLopDays,
      fill: '#f43f5e', // Rose
      percentage: lopPercent,
      uniqueStaff: uniqueLopStaffCount
    },
    {
      category: 'Earned Leave (EL)',
      shortLabel: 'EL',
      days: grandElDays,
      fill: '#3b82f6', // Blue
      percentage: elPercent,
      uniqueStaff: uniqueElStaffCount
    },
    {
      category: 'Sick Leave (SL)',
      shortLabel: 'SL',
      days: grandSlDays,
      fill: '#f59e0b', // Amber
      percentage: slPercent,
      uniqueStaff: uniqueSlStaffCount
    }
  ];

  return {
    filter,
    startDate: interval.startDate,
    endDate: interval.endDate,
    label: interval.label,
    daysCount: interval.dateList.length,
    dateList: interval.dateList,
    totalLopDays: grandLopDays,
    totalElDays: grandElDays,
    totalSlDays: grandSlDays,
    totalLeaveDays: grandTotalLeaveDays,
    uniqueLopCount: uniqueLopStaffCount,
    uniqueElCount: uniqueElStaffCount,
    uniqueSlCount: uniqueSlStaffCount,
    uniqueLeaveStaffCount: uniqueAnyLeaveStaffCount,
    totalActiveStaff: activeEmployees.length,
    distribution: {
      lopPercent,
      elPercent,
      slPercent
    },
    chartData,
    items: employeeItems
  };
}

/**
 * Exports the calculated Leave & LOP summary to CSV file with UTF-8 BOM for Microsoft Excel.
 */
export function exportLeaveSummaryToCsv(
  summary: LeaveLopSummaryResult,
  generatedBy: string = 'HRMS Admin'
): void {
  const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

  const lines: string[] = [];

  // Title Header
  lines.push(`"KALPANAAA SOFTWARE SOLUTIONS - LEAVE & LOP SUMMARY REPORT"`);
  lines.push(`"Report Period:","${summary.label}"`);
  lines.push(`"Date Range:","${summary.startDate} to ${summary.endDate} (${summary.daysCount} Calendar Days)"`);
  lines.push(`"Generated By:","${generatedBy}"`);
  lines.push(`"Generated At:","${timestamp} (IST)"`);
  lines.push(``);

  // KPI Summary
  lines.push(`"OVERALL LEAVE & LOP TOTALS"`);
  lines.push(`"Total Loss of Pay (LOP) Days",${summary.totalLopDays},"${summary.uniqueLopCount} staff affected"`);
  lines.push(`"Total Earned Leave (EL) Days",${summary.totalElDays},"${summary.uniqueElCount} staff took EL"`);
  lines.push(`"Total Sick Leave (SL) Days",${summary.totalSlDays},"${summary.uniqueSlCount} staff took SL"`);
  lines.push(`"Total Leave Days Taken",${summary.totalLeaveDays},"${summary.uniqueLeaveStaffCount} of ${summary.totalActiveStaff} active staff on leave"`);
  lines.push(``);

  // Employee-wise Breakdown Table
  lines.push(`"EMPLOYEE-WISE LEAVE BREAKDOWN"`);
  lines.push(`"Employee Code","Employee Name","Department","Designation","LOP Days","EL Days","SL Days","Total Days Taken","Detailed Leave Dates & Notes"`);

  for (const emp of summary.items) {
    const detailsStr = emp.leaveDays.map(d => 
      `${d.date} (${d.leaveType}: ${d.daysValue}d${d.reason ? ` - ${d.reason.replace(/"/g, "'")}` : ''})`
    ).join(' | ');

    lines.push([
      `"${emp.employeeCode}"`,
      `"${emp.fullName.replace(/"/g, '""')}"`,
      `"${emp.department.replace(/"/g, '""')}"`,
      `"${emp.designation.replace(/"/g, '""')}"`,
      emp.lopDays,
      emp.elDays,
      emp.slDays,
      emp.totalLeaveDays,
      `"${detailsStr.replace(/"/g, '""')}"`
    ].join(','));
  }

  // Table Totals
  lines.push([
    `"TOTAL"`,
    `"ALL STAFF"`,
    `"-"`,
    `"-"`,
    summary.totalLopDays,
    summary.totalElDays,
    summary.totalSlDays,
    summary.totalLeaveDays,
    `"Reconciled Report Total"`
  ].join(','));

  const csvContent = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const fileName = `Leave_and_LOP_Summary_${summary.startDate}_to_${summary.endDate}.csv`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Exports the calculated Leave & LOP summary to a formatted Excel (.xlsx) file using ExcelJS.
 */
export async function exportLeaveSummaryToExcel(
  summary: LeaveLopSummaryResult,
  generatedBy: string = 'HRMS Admin'
): Promise<void> {
  const excelModule: any = await import('exceljs');
  const ExcelJSClass = excelModule.default || excelModule;
  const workbook = new ExcelJSClass.Workbook();
  workbook.creator = 'Kalpanaaa HRMS';
  workbook.created = new Date();

  const ws = workbook.addWorksheet('Leave & LOP Summary', {
    views: [{ showGridLines: true }]
  });

  // Title Row
  const titleRow = ws.addRow(['KALPANAAA SOFTWARE SOLUTIONS - LEAVE & LOP SUMMARY']);
  titleRow.font = { name: 'Arial', size: 14, bold: true, color: { argb: 'FFFFFF' } };
  titleRow.alignment = { vertical: 'middle' };
  titleRow.height = 28;
  ws.mergeCells('A1:K1');
  ws.getCell('A1').fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: '0F172A' } // Slate 900
  };

  // Subtitle Metadata Rows
  ws.addRow([`Report Period: ${summary.label}`]);
  ws.addRow([`Date Window: ${summary.startDate} to ${summary.endDate} (${summary.daysCount} Calendar Days)`]);
  ws.addRow([`Generated By: ${generatedBy} | Timestamp: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} (IST)`]);
  ws.addRow([]); // Blank spacer

  // KPI Summary Block
  const kpiHeader = ws.addRow(['Metric Category', 'Days Taken', 'Staff Share / Unique Count', 'Percentage Share']);
  kpiHeader.font = { bold: true, color: { argb: 'FFFFFF' } };
  kpiHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '1E293B' } };
  });

  ws.addRow(['Loss of Pay (LOP)', summary.totalLopDays, `${summary.uniqueLopCount} staff affected`, `${summary.distribution.lopPercent}%`]);
  ws.addRow(['Earned Leave (EL)', summary.totalElDays, `${summary.uniqueElCount} staff took EL`, `${summary.distribution.elPercent}%`]);
  ws.addRow(['Sick Leave (SL)', summary.totalSlDays, `${summary.uniqueSlCount} staff took SL`, `${summary.distribution.slPercent}%`]);
  
  const totalKpiRow = ws.addRow(['Total Leave Days', summary.totalLeaveDays, `${summary.uniqueLeaveStaffCount} of ${summary.totalActiveStaff} staff`, '100%']);
  totalKpiRow.font = { bold: true };
  ws.addRow([]); // Blank spacer

  // Employee Table Header
  const tableHeader = ws.addRow([
    'Employee Code',
    'Employee Name',
    'Department',
    'Designation',
    'LOP Days',
    'EL Days',
    'SL Days',
    'Total Days',
    'EL Balance',
    'SL Balance',
    'Dates & Notes Detail'
  ]);
  tableHeader.font = { bold: true, color: { argb: 'FFFFFF' } };
  tableHeader.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '2563EB' } }; // Blue 600
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
  tableHeader.height = 24;

  // Add Employee Rows
  for (const emp of summary.items) {
    const detailsStr = emp.leaveDays.map(d => 
      `${d.date} (${d.leaveType}: ${d.daysValue}d${d.reason ? ` - ${d.reason}` : ''})`
    ).join(' | ');

    const row = ws.addRow([
      emp.employeeCode,
      emp.fullName,
      emp.department,
      emp.designation,
      emp.lopDays,
      emp.elDays,
      emp.slDays,
      emp.totalLeaveDays,
      emp.elBalance ?? 0,
      emp.slBalance ?? 0,
      detailsStr
    ]);

    row.getCell(5).alignment = { horizontal: 'right' };
    row.getCell(6).alignment = { horizontal: 'right' };
    row.getCell(7).alignment = { horizontal: 'right' };
    row.getCell(8).alignment = { horizontal: 'right' };
    row.getCell(9).alignment = { horizontal: 'right' };
    row.getCell(10).alignment = { horizontal: 'right' };
  }

  // Summary Reconciled Row
  const totalElBal = summary.items.reduce((s, e) => s + (e.elBalance || 0), 0);
  const totalSlBal = summary.items.reduce((s, e) => s + (e.slBalance || 0), 0);

  const totalRow = ws.addRow([
    'TOTAL',
    'ALL ACTIVE STAFF',
    '-',
    '-',
    summary.totalLopDays,
    summary.totalElDays,
    summary.totalSlDays,
    summary.totalLeaveDays,
    totalElBal,
    totalSlBal,
    'Reconciled Overall Total'
  ]);
  totalRow.font = { bold: true };
  totalRow.eachCell(cell => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'E2E8F0' } };
  });
  totalRow.getCell(5).alignment = { horizontal: 'right' };
  totalRow.getCell(6).alignment = { horizontal: 'right' };
  totalRow.getCell(7).alignment = { horizontal: 'right' };
  totalRow.getCell(8).alignment = { horizontal: 'right' };
  totalRow.getCell(9).alignment = { horizontal: 'right' };
  totalRow.getCell(10).alignment = { horizontal: 'right' };

  // Set Column Widths
  ws.columns = [
    { width: 16 }, // Code
    { width: 26 }, // Name
    { width: 20 }, // Dept
    { width: 22 }, // Designation
    { width: 12 }, // LOP
    { width: 12 }, // EL
    { width: 12 }, // SL
    { width: 14 }, // Total
    { width: 13 }, // EL Bal
    { width: 13 }, // SL Bal
    { width: 45 }  // Details
  ];

  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  });

  const fileName = `Leave_and_LOP_Summary_${summary.startDate}_to_${summary.endDate}.xlsx`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
