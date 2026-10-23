import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Load the compiled module from KSS_TEST_OUT
const OUT = process.env.KSS_TEST_OUT;
if (!OUT) {
  throw new Error('KSS_TEST_OUT environment variable is missing.');
}

const {
  classifyLeaveTypeStrict,
  resolveDateFilterInterval,
  computeLeaveLopSummary,
  formatSummaryDisplayDate,
  isAuthoritativeApprovedLeave
} = await import(pathToFileURL(join(OUT, 'leaveLopSummaryService.cjs')).href);

test('classification: classifies LOP, EL, SL accurately and excludes WFH', () => {
  // LOP via type
  assert.equal(classifyLeaveTypeStrict({ type: 'Loss of Pay' }), 'LOP');
  assert.equal(classifyLeaveTypeStrict({ type: 'LOP' }), 'LOP');
  assert.equal(classifyLeaveTypeStrict({ leaveCategory: 'LOP' }), 'LOP');

  // LOP via reason / review notes (whole-word boundary safety)
  assert.equal(classifyLeaveTypeStrict({ type: 'Earn Leave', reason: 'LOP' }), 'LOP');
  assert.equal(classifyLeaveTypeStrict({ type: 'Leave', reason: 'Taking 1 day loss of pay' }), 'LOP');
  assert.equal(classifyLeaveTypeStrict({ type: 'Leave', reviewNotes: 'Approved as unpaid leave' }), 'LOP');

  // Whole word safety: 'develop' or 'slope' should NOT match LOP!
  assert.equal(classifyLeaveTypeStrict({ type: 'Leave', reason: 'Assisting developer with release' }), 'EL');

  // Sick Leave (SL)
  assert.equal(classifyLeaveTypeStrict({ type: 'Sick Leave' }), 'SL');
  assert.equal(classifyLeaveTypeStrict({ leaveCategory: 'Sick Leave' }), 'SL');
  assert.equal(classifyLeaveTypeStrict({ type: 'Leave', reason: 'Severe fever and cold sick leave' }), 'SL');

  // Earned Leave (EL)
  assert.equal(classifyLeaveTypeStrict({ type: 'Earn Leave' }), 'EL');
  assert.equal(classifyLeaveTypeStrict({ type: 'Earned Leave' }), 'EL');
  assert.equal(classifyLeaveTypeStrict({ type: 'Leave', reason: 'Attending family wedding' }), 'EL');

  // WFH (Remote work) must be excluded
  assert.equal(classifyLeaveTypeStrict({ type: 'WFH' }), 'WFH');
  assert.equal(classifyLeaveTypeStrict({ leaveCategory: 'WFH' }), 'WFH');
  assert.equal(classifyLeaveTypeStrict({ type: 'Work From Home' }), 'WFH');
});

test('approval qualification: counts only approved and multi-tier completed leaves', () => {
  // Direct Approved
  assert.equal(isAuthoritativeApprovedLeave({ status: 'Approved' }), true);

  // Rejected / Cancelled must never qualify
  assert.equal(isAuthoritativeApprovedLeave({ status: 'Rejected' }), false);
  assert.equal(isAuthoritativeApprovedLeave({ status: 'Cancelled' }), false);

  // Multi-tier chain all approved/bypassed/N/A
  assert.equal(isAuthoritativeApprovedLeave({
    status: 'Pending',
    pmStatus: 'Approved',
    hrStatus: 'Approved',
    ceoStatus: 'Approved',
    ctoStatus: 'Approved'
  }), true);

  // Multi-tier with one pending must NOT qualify
  assert.equal(isAuthoritativeApprovedLeave({
    status: 'Pending',
    pmStatus: 'Approved',
    hrStatus: 'Approved',
    ceoStatus: 'Pending',
    ctoStatus: 'Waiting CEO'
  }), false);

  // Multi-tier with one rejected must NOT qualify
  assert.equal(isAuthoritativeApprovedLeave({
    status: 'Pending',
    pmStatus: 'Approved',
    hrStatus: 'Approved',
    ceoStatus: 'Rejected',
    ctoStatus: 'Waiting CEO'
  }), false);
});

test('date intervals: calculates 7d, 15d, 30d, and custom ranges correctly', () => {
  const i7 = resolveDateFilterInterval('7d');
  assert.equal(i7.dateList.length, 7);
  assert.ok(i7.label.includes('Last 7 Days'));

  const i15 = resolveDateFilterInterval('15d');
  assert.equal(i15.dateList.length, 15);
  assert.ok(i15.label.includes('Last 15 Days'));

  const i30 = resolveDateFilterInterval('30d');
  assert.equal(i30.dateList.length, 30);
  assert.ok(i30.label.includes('Last 30 Days'));

  // Custom range with reversed start/end auto-corrects
  const custom = resolveDateFilterInterval('custom', '2026-08-31', '2026-08-01');
  assert.equal(custom.startDate, '2026-08-01');
  assert.equal(custom.endDate, '2026-08-31');
  assert.equal(custom.dateList.length, 31);
});

test('leave calculation engine: aggregates LOP, EL, and SL with multi-day clipping and holiday exclusion', () => {
  const mockEmployees = [
    {
      id: 'emp-1',
      employeeId: 'KSS2407001',
      fullName: 'Alice Developer',
      department: 'Engineering',
      designation: 'Frontend Engineer',
      status: 'Active',
      joiningDate: '2026-07-01'
    },
    {
      id: 'emp-2',
      employeeId: 'KSS2407002',
      fullName: 'Bob Backend',
      department: 'Engineering',
      designation: 'Backend Engineer',
      status: 'Active',
      joiningDate: '2026-07-01'
    }
  ];

  // Alice: Leave spanning Oct 15 - Oct 16 (Earned Leave)
  // Alice: Leave on Oct 19 with Reason: "LOP" (1 day Loss of Pay)
  // Bob: Sick Leave on Oct 19 (1 day SL)
  const mockRequests = [
    {
      id: 'lr-1',
      employeeId: 'emp-1',
      employeeName: 'Alice Developer',
      type: 'Earn Leave',
      startDate: '2026-10-15',
      endDate: '2026-10-16',
      status: 'Approved',
      reason: 'Personal work'
    },
    {
      id: 'lr-2',
      employeeId: 'emp-1',
      employeeName: 'Alice Developer',
      type: 'Earn Leave',
      startDate: '2026-10-19',
      endDate: '2026-10-19',
      status: 'Approved',
      reason: 'LOP' // Should be counted as LOP
    },
    {
      id: 'lr-3',
      employeeId: 'emp-2',
      employeeName: 'Bob Backend',
      type: 'Sick Leave',
      startDate: '2026-10-19',
      endDate: '2026-10-19',
      status: 'Approved',
      reason: 'Fever'
    }
  ];

  // Window: 2026-10-16 to 2026-10-22 (7 calendar days)
  // Oct 15 is outside window -> clipped! Only Oct 16 counted (1 EL day).
  // Oct 18 is Sunday -> excluded.
  // Oct 19 is Monday: Alice took LOP (1d), Bob took SL (1d).
  // Oct 20 & 21 are official holidays -> excluded.
  const summary = computeLeaveLopSummary(
    mockEmployees,
    mockRequests,
    [],
    undefined,
    'custom',
    '2026-10-16',
    '2026-10-22'
  );

  assert.equal(summary.totalLopDays, 1);
  assert.equal(summary.totalElDays, 1);
  assert.equal(summary.totalSlDays, 1);
  assert.equal(summary.totalLeaveDays, 3);
  assert.equal(summary.uniqueLeaveStaffCount, 2);

  // Reconciled equality
  const tableSumLop = summary.items.reduce((s, i) => s + i.lopDays, 0);
  const tableSumEl = summary.items.reduce((s, i) => s + i.elDays, 0);
  const tableSumSl = summary.items.reduce((s, i) => s + i.slDays, 0);
  const tableSumTotal = summary.items.reduce((s, i) => s + i.totalLeaveDays, 0);

  assert.equal(tableSumLop, summary.totalLopDays);
  assert.equal(tableSumEl, summary.totalElDays);
  assert.equal(tableSumSl, summary.totalSlDays);
  assert.equal(tableSumTotal, summary.totalLeaveDays);
});

test('leave calculation engine: integrates attendance LOP without double-counting', () => {
  const mockEmployees = [
    {
      id: 'emp-1',
      employeeId: 'KSS2407004',
      fullName: 'Asbin T S',
      department: 'Engineering',
      designation: 'Software Developer',
      status: 'Active'
    }
  ];

  // Request on Aug 26: EL
  const mockRequests = [
    {
      id: 'lr-1',
      employeeId: 'emp-1',
      type: 'Earn Leave',
      startDate: '2026-08-26',
      endDate: '2026-08-26',
      status: 'Approved',
      reason: 'Family function'
    }
  ];

  // Attendance on Aug 26 (Leave) and Aug 27 (Loss of Pay)
  const mockAttendance = [
    {
      id: 'att-1',
      employeeId: 'emp-1',
      date: '2026-08-26',
      status: 'On Leave',
      notes: 'Should NOT double-count with approved request'
    },
    {
      id: 'att-2',
      employeeId: 'emp-1',
      date: '2026-08-27',
      status: 'Loss of Pay',
      notes: 'Quick updated to On Leave'
    }
  ];

  const summary = computeLeaveLopSummary(
    mockEmployees,
    mockRequests,
    mockAttendance,
    undefined,
    'custom',
    '2026-08-26',
    '2026-08-27'
  );

  // Exactly 1 EL day (Aug 26) and 1 LOP day (Aug 27) = 2 days total
  assert.equal(summary.totalElDays, 1);
  assert.equal(summary.totalLopDays, 1);
  assert.equal(summary.totalSlDays, 0);
  assert.equal(summary.totalLeaveDays, 2);
});
