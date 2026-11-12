import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const JAVA_PATH = 'C:\\Program Files\\Java\\jdk-26.0.1\\bin\\java.exe';
const JAR_PATH = 'C:\\Users\\koush\\.cache\\firebase\\emulators\\cloud-firestore-emulator-v1.22.0.jar';
const PORT = 8092;
const PROJECT_ID = 'kalpanaaa-employees-website';

let emulatorProc = null;

function makeJwt(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.`;
}

// User tokens
const TOKENS = {
  unauth: null,
  superAdmin: makeJwt({
    sub: 'admin-uid-1',
    user_id: 'admin-uid-1',
    email: 'gaurav@kalpanaaa.in',
    role: 'SUPER_ADMIN',
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  }),
  hrAdmin: makeJwt({
    sub: 'hr-uid-1',
    user_id: 'hr-uid-1',
    email: 'hr@kalpanaaa.in',
    role: 'HR_ADMIN',
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  }),
  projectManager: makeJwt({
    sub: 'pm-uid-1',
    user_id: 'pm-uid-1',
    email: 'koushik@kalpanaaa.in',
    role: 'PROJECT_MANAGER',
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  }),
  alice: makeJwt({
    sub: 'alice-uid',
    user_id: 'alice-uid',
    email: 'alice@kalpanaaa.in',
    role: 'EMPLOYEE',
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  }),
  bob: makeJwt({
    sub: 'bob-uid',
    user_id: 'bob-uid',
    email: 'bob@kalpanaaa.in',
    role: 'EMPLOYEE',
    aud: PROJECT_ID,
    iss: `https://securetoken.google.com/${PROJECT_ID}`
  })
};

function req(method, path, body, token, updateMaskFields) {
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const data = body ? JSON.stringify(body) : null;
    let fullPath = `/v1/projects/${PROJECT_ID}/databases/(default)/documents${path}`;
    if (updateMaskFields && updateMaskFields.length > 0) {
      const q = updateMaskFields.map(f => `updateMask.fieldPaths=${encodeURIComponent(f)}`).join('&');
      fullPath += (fullPath.includes('?') ? '&' : '?') + q;
    }
    const r = http.request({
      host: '127.0.0.1',
      port: PORT,
      method,
      path: fullPath,
      headers
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Start Firestore emulator before running the test suite
before(async () => {
  emulatorProc = spawn(JAVA_PATH, [
    '-jar', JAR_PATH,
    '--host', '127.0.0.1',
    '--port', String(PORT),
    '--rules', 'firestore.rules',
    '--project_id', PROJECT_ID
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  let output = '';
  emulatorProc.stdout.on('data', d => output += d.toString());
  emulatorProc.stderr.on('data', d => output += d.toString());

  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 400));
    if (output.includes('Dev App Server is now running') || output.includes('is now running')) {
      break;
    }
  }

  // Pre-seed user documents
  // Alice user doc
  await req('PATCH', '/users/alice-uid', {
    fields: {
      uid: { stringValue: 'alice-uid' },
      email: { stringValue: 'alice@kalpanaaa.in' },
      role: { stringValue: 'EMPLOYEE' },
      employeeId: { stringValue: 'KSS2407020' },
      employeeDocId: { stringValue: 'emp-alice' },
      fullName: { stringValue: 'Alice Engineer' }
    }
  }, TOKENS.superAdmin);

  // Bob user doc
  await req('PATCH', '/users/bob-uid', {
    fields: {
      uid: { stringValue: 'bob-uid' },
      email: { stringValue: 'bob@kalpanaaa.in' },
      role: { stringValue: 'EMPLOYEE' },
      employeeId: { stringValue: 'KSS2407021' },
      employeeDocId: { stringValue: 'emp-bob' },
      fullName: { stringValue: 'Bob Attacker' }
    }
  }, TOKENS.superAdmin);

  // Alice employee directory doc
  await req('PATCH', '/employees/emp-alice', {
    fields: {
      id: { stringValue: 'emp-alice' },
      uid: { stringValue: 'alice-uid' },
      employeeId: { stringValue: 'KSS2407020' },
      email: { stringValue: 'alice@kalpanaaa.in' },
      role: { stringValue: 'EMPLOYEE' },
      fullName: { stringValue: 'Alice Engineer' },
      earnLeaveBalance: { integerValue: '5' },
      sickLeaveBalance: { integerValue: '3' },
      baseSalary: { integerValue: '50000' }
    }
  }, TOKENS.superAdmin);
});

after(() => {
  if (emulatorProc) {
    emulatorProc.kill();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. AUTHENTICATION & ACCESS GATING TESTS
// ─────────────────────────────────────────────────────────────────────────────

test('AUTH: Unauthenticated access to protected collections is denied', async () => {
  const empRead = await req('GET', '/employees/emp-alice', null, TOKENS.unauth);
  assert.equal(empRead.status, 403, 'Unauthenticated read to employees must be 403');

  const attRead = await req('GET', '/attendance/any_record', null, TOKENS.unauth);
  assert.equal(attRead.status, 403, 'Unauthenticated read to attendance must be 403');

  const leaveRead = await req('GET', '/leaveRequests/any_request', null, TOKENS.unauth);
  assert.equal(leaveRead.status, 403, 'Unauthenticated read to leaveRequests must be 403');

  const settingsRead = await req('GET', '/settings/global', null, TOKENS.unauth);
  assert.equal(settingsRead.status, 403, 'Unauthenticated read to settings must be 403');
});

test('AUTH: Connectivity probe allows public read and blocks write', async () => {
  const probeRead = await req('GET', '/test/probe_doc', null, TOKENS.unauth);
  assert.equal(probeRead.status, 404, 'Connectivity probe read allowed (returns 404 for missing doc)');

  const probeWrite = await req('PATCH', '/test/probe_doc', {
    fields: { text: { stringValue: 'hello' } }
  }, TOKENS.unauth);
  assert.equal(probeWrite.status, 403, 'Connectivity probe write must be denied');
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. USER PROFILE & ROLE SELF-ASSIGNMENT PROTECTION
// ─────────────────────────────────────────────────────────────────────────────

test('USER: Employee can write own user mapping with EMPLOYEE role', async () => {
  const res = await req('PATCH', '/users/alice-uid', {
    fields: {
      uid: { stringValue: 'alice-uid' },
      email: { stringValue: 'alice@kalpanaaa.in' },
      role: { stringValue: 'EMPLOYEE' },
      fullName: { stringValue: 'Alice Engineer Updated' }
    }
  }, TOKENS.alice);
  assert.equal(res.status, 200, 'Employee self user doc update must succeed');
});

test('SECURITY: Employee CANNOT self-escalate role to SUPER_ADMIN, HR_ADMIN, or PM', async () => {
  for (const maliciousRole of ['SUPER_ADMIN', 'HR_ADMIN', 'PROJECT_MANAGER', 'superadmin', 'hr', 'pm']) {
    const res = await req('PATCH', '/users/bob-uid', {
      fields: {
        uid: { stringValue: 'bob-uid' },
        email: { stringValue: 'bob@kalpanaaa.in' },
        role: { stringValue: maliciousRole }
      }
    }, TOKENS.bob);
    assert.equal(res.status, 403, `Self-assigning ${maliciousRole} must be denied (403)`);
  }
});

test('SECURITY: Employee CANNOT modify another user\'s users/{uid} document', async () => {
  const res = await req('PATCH', '/users/alice-uid', {
    fields: {
      uid: { stringValue: 'alice-uid' },
      email: { stringValue: 'alice@kalpanaaa.in' },
      role: { stringValue: 'EMPLOYEE' }
    }
  }, TOKENS.bob);
  assert.equal(res.status, 403, 'Bob modifying Alice user doc must be denied (403)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. EMPLOYEE DIRECTORY & PRIVILEGE BOUNDARIES
// ─────────────────────────────────────────────────────────────────────────────

test('EMPLOYEE: Employee can update only approved personal profile fields', async () => {
  const allowedFields = [
    'phone', 'currentAddress', 'city', 'state', 'skills', 'isFaceEnrolled', 'updatedAt'
  ];
  const res = await req('PATCH', '/employees/emp-alice', {
    fields: {
      phone: { stringValue: '+91 99999 88888' },
      currentAddress: { stringValue: 'Kalyan Nagar, Bengaluru' },
      city: { stringValue: 'Bengaluru' },
      state: { stringValue: 'Karnataka' },
      skills: { arrayValue: { values: [{ stringValue: 'TypeScript' }, { stringValue: 'React' }] } },
      isFaceEnrolled: { booleanValue: true },
      updatedAt: { stringValue: new Date().toISOString() }
    }
  }, TOKENS.alice, allowedFields);
  assert.equal(res.status, 200, `Alice updating permitted profile fields must succeed, got ${res.status}: ${JSON.stringify(res.body)}`);
});

test('SECURITY: Employee CANNOT modify baseSalary, role, or earnLeaveBalance', async () => {
  const salaryAttempt = await req('PATCH', '/employees/emp-alice', {
    fields: { baseSalary: { integerValue: '999999' } }
  }, TOKENS.alice);
  assert.equal(salaryAttempt.status, 403, 'Employee altering baseSalary must be denied (403)');

  const roleAttempt = await req('PATCH', '/employees/emp-alice', {
    fields: { role: { stringValue: 'SUPER_ADMIN' } }
  }, TOKENS.alice);
  assert.equal(roleAttempt.status, 403, 'Employee altering role must be denied (403)');

  const leaveBalanceAttempt = await req('PATCH', '/employees/emp-alice', {
    fields: { earnLeaveBalance: { integerValue: '99' } }
  }, TOKENS.alice);
  assert.equal(leaveBalanceAttempt.status, 403, 'Employee altering leave balance must be denied (403)');
});

test('SECURITY: Employee CANNOT modify another employee\'s directory profile', async () => {
  const res = await req('PATCH', '/employees/emp-alice', {
    fields: { phone: { stringValue: '+91 00000 00000' } }
  }, TOKENS.bob);
  assert.equal(res.status, 403, 'Bob updating Alice profile must be denied (403)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ATTENDANCE & SHIFT INTEGRITY
// ─────────────────────────────────────────────────────────────────────────────

test('ATTENDANCE: Employee can create valid shift check-in for themselves', async () => {
  const dateStr = '2026-11-20';
  const recordId = `alice-uid_${dateStr}`;
  const res = await req('PATCH', `/attendance/${recordId}`, {
    fields: {
      id: { stringValue: recordId },
      employeeUid: { stringValue: 'alice-uid' },
      authUid: { stringValue: 'alice-uid' },
      employeeId: { stringValue: 'emp-alice' },
      employeeCode: { stringValue: 'KSS2407020' },
      date: { stringValue: dateStr },
      status: { stringValue: 'Present' },
      checkInAt: { timestampValue: new Date().toISOString() },
      workingMinutes: { integerValue: '0' },
      breaks: { arrayValue: { values: [] } }
    }
  }, TOKENS.alice);
  assert.equal(res.status, 200, `Employee check-in must succeed, got ${res.status}`);
});

test('ATTENDANCE: Employee can update breaks on their own attendance record', async () => {
  const dateStr = '2026-11-20';
  const recordId = `alice-uid_${dateStr}`;
  const res = await req('PATCH', `/attendance/${recordId}`, {
    fields: {
      breaks: {
        arrayValue: {
          values: [{
            mapValue: {
              fields: {
                type: { stringValue: 'Meal Break' },
                startAt: { stringValue: new Date().toISOString() },
                endAt: { nullValue: null },
                durationMinutes: { integerValue: '0' }
              }
            }
          }]
        }
      },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  }, TOKENS.alice);
  assert.equal(res.status, 200, 'Employee break update must succeed');
});

test('SECURITY: Employee CANNOT modify another employee\'s attendance record', async () => {
  const dateStr = '2026-11-20';
  const recordId = `alice-uid_${dateStr}`;
  const res = await req('PATCH', `/attendance/${recordId}`, {
    fields: { status: { stringValue: 'Absent' } }
  }, TOKENS.bob);
  assert.equal(res.status, 403, 'Bob modifying Alice attendance must be denied (403)');
});

test('SECURITY: Employee CANNOT delete attendance records', async () => {
  const dateStr = '2026-11-20';
  const recordId = `alice-uid_${dateStr}`;
  const res = await req('DELETE', `/attendance/${recordId}`, null, TOKENS.alice);
  assert.equal(res.status, 403, 'Employee deleting attendance must be denied (403)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. LEAVE REQUESTS & ATOMIC DATE LOCKS
// ─────────────────────────────────────────────────────────────────────────────

test('LEAVE: Employee can submit a valid leave request and create date lock', async () => {
  const reqId = 'LR_KSS2407020_2026-12-05_Earn_Leave';
  const lockDate = '2026-12-05';

  // 1. Submit request
  const reqRes = await req('PATCH', `/leaveRequests/${reqId}`, {
    fields: {
      id: { stringValue: reqId },
      employeeUid: { stringValue: 'alice-uid' },
      authUid: { stringValue: 'alice-uid' },
      employeeId: { stringValue: 'KSS2407020' },
      employeeName: { stringValue: 'Alice Engineer' },
      type: { stringValue: 'Earn Leave' },
      startDate: { stringValue: lockDate },
      endDate: { stringValue: lockDate },
      reason: { stringValue: 'Family event' },
      status: { stringValue: 'Pending' },
      ceoStatus: { stringValue: 'Pending' },
      ctoStatus: { stringValue: 'Waiting CEO' },
      pmStatus: { stringValue: 'N/A' },
      hrStatus: { stringValue: 'N/A' },
      _deductionApplied: { booleanValue: false },
      createdAt: { timestampValue: new Date().toISOString() },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  }, TOKENS.alice);
  assert.equal(reqRes.status, 200, `Leave request submit must succeed, got ${reqRes.status}`);

  // 2. Create date lock
  const lockRes = await req('PATCH', `/employees/emp-alice/leaveLocks/${lockDate}`, {
    fields: {
      id: { stringValue: lockDate },
      requestId: { stringValue: reqId },
      employeeUid: { stringValue: 'alice-uid' },
      authUid: { stringValue: 'alice-uid' },
      employeeId: { stringValue: 'emp-alice' },
      type: { stringValue: 'Earn Leave' },
      active: { booleanValue: true },
      reservedAt: { stringValue: new Date().toISOString() }
    }
  }, TOKENS.alice);
  assert.equal(lockRes.status, 200, 'Leave lock create must succeed');
});

test('SECURITY: Employee CANNOT submit pre-approved leave request', async () => {
  const reqId = 'LR_KSS2407021_2026-12-06_Earn_Leave';
  const res = await req('PATCH', `/leaveRequests/${reqId}`, {
    fields: {
      id: { stringValue: reqId },
      employeeUid: { stringValue: 'bob-uid' },
      authUid: { stringValue: 'bob-uid' },
      employeeId: { stringValue: 'KSS2407021' },
      type: { stringValue: 'Earn Leave' },
      startDate: { stringValue: '2026-12-06' },
      endDate: { stringValue: '2026-12-06' },
      reason: { stringValue: 'Pre-approved attempt' },
      status: { stringValue: 'Pending' },
      ceoStatus: { stringValue: 'Approved' }, // Forging CEO approval!
      ctoStatus: { stringValue: 'Waiting CEO' }
    }
  }, TOKENS.bob);
  assert.equal(res.status, 403, 'Pre-approved leave creation must be denied (403)');
});

test('LEAVE: Employee can cancel their own pending leave request and release locks', async () => {
  const reqId = 'LR_KSS2407020_2026-12-05_Earn_Leave';
  const lockDate = '2026-12-05';

  const cancelRes = await req('PATCH', `/leaveRequests/${reqId}`, {
    fields: {
      status: { stringValue: 'Cancelled' },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  }, TOKENS.alice, ['status', 'updatedAt']);
  assert.equal(cancelRes.status, 200, `Alice self-cancel must succeed, got ${cancelRes.status}: ${JSON.stringify(cancelRes.body)}`);

  const releaseLockRes = await req('DELETE', `/employees/emp-alice/leaveLocks/${lockDate}`, null, TOKENS.alice);
  assert.equal(releaseLockRes.status, 200, 'Alice release date lock must succeed');
});

test('SECURITY: Employee CANNOT cancel or delete another employee\'s leave request', async () => {
  const reqId = 'LR_KSS2407020_2026-12-05_Earn_Leave';
  const cancelAttempt = await req('PATCH', `/leaveRequests/${reqId}`, {
    fields: {
      status: { stringValue: 'Cancelled' },
      updatedAt: { timestampValue: new Date().toISOString() }
    }
  }, TOKENS.bob);
  assert.equal(cancelAttempt.status, 403, 'Bob cancelling Alice request must be denied (403)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. ADMINISTRATIVE & APPROVER POWERS
// ─────────────────────────────────────────────────────────────────────────────

test('ADMIN: Super Admin can update company settings and rules', async () => {
  const settingsRes = await req('PATCH', '/settings/global', {
    fields: {
      officeName: { stringValue: 'Kalpanaaa HQ Tested' },
      allowedRadiusMeters: { integerValue: '600' }
    }
  }, TOKENS.superAdmin);
  assert.equal(settingsRes.status, 200, 'Super admin updating settings must succeed');

  const rulesRes = await req('PATCH', '/companyRules/rule-1', {
    fields: {
      title: { stringValue: 'Code of Conduct' },
      content: { stringValue: 'Always act professionally.' }
    }
  }, TOKENS.superAdmin);
  assert.equal(rulesRes.status, 200, 'Super admin updating company rules must succeed');
});

test('SECURITY: Ordinary Employee CANNOT modify settings, rules, or workZones', async () => {
  const settingsRes = await req('PATCH', '/settings/global', {
    fields: { allowedRadiusMeters: { integerValue: '99999' } }
  }, TOKENS.alice);
  assert.equal(settingsRes.status, 403, 'Employee updating settings must be denied (403)');

  const rulesRes = await req('PATCH', '/companyRules/rule-1', {
    fields: { title: { stringValue: 'Malicious Rule' } }
  }, TOKENS.alice);
  assert.equal(rulesRes.status, 403, 'Employee updating rules must be denied (403)');

  const zoneRes = await req('PATCH', '/workZones/company', {
    fields: { radiusMeters: { integerValue: '99999' } }
  }, TOKENS.alice);
  assert.equal(zoneRes.status, 403, 'Employee updating workZones must be denied (403)');
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. AUDIT LOGS & ERROR LOGS (APPEND-ONLY INTEGRITY)
// ─────────────────────────────────────────────────────────────────────────────

test('AUDIT: Any authenticated user can create valid audit log, but update/delete is forbidden', async () => {
  const logId = `audit_log_${Date.now()}`;
  const createRes = await req('PATCH', `/auditLogs/${logId}`, {
    fields: {
      id: { stringValue: logId },
      actorId: { stringValue: 'alice-uid' },
      actorName: { stringValue: 'Alice Engineer' },
      actorRole: { stringValue: 'EMPLOYEE' },
      action: { stringValue: 'CHECK_IN_LOGGED' },
      target: { stringValue: 'Shift 2026-11-20' },
      details: { stringValue: 'GPS check-in verified' },
      timestamp: { stringValue: new Date().toISOString() }
    }
  }, TOKENS.alice);
  assert.equal(createRes.status, 200, 'Creating valid audit log must succeed');

  const updateRes = await req('PATCH', `/auditLogs/${logId}`, {
    fields: { details: { stringValue: 'Tampered details' } }
  }, TOKENS.superAdmin);
  assert.equal(updateRes.status, 403, 'Updating audit log must be denied (append-only)');

  const deleteRes = await req('DELETE', `/auditLogs/${logId}`, null, TOKENS.superAdmin);
  assert.equal(deleteRes.status, 403, 'Deleting audit log must be denied (append-only)');
});

test('ERROR_LOGS: Telemetry can be recorded, but update/delete is forbidden', async () => {
  const errId = `error_log_${Date.now()}`;
  const createRes = await req('PATCH', `/error_logs/${errId}`, {
    fields: {
      timestamp: { stringValue: new Date().toISOString() },
      timestampMs: { integerValue: String(Date.now()) },
      category: { stringValue: 'NETWORK' },
      message: { stringValue: 'Transient socket timeout' },
      uid: { stringValue: 'alice-uid' }
    }
  }, TOKENS.alice);
  assert.equal(createRes.status, 200, 'Recording error log must succeed');

  const updateRes = await req('PATCH', `/error_logs/${errId}`, {
    fields: { message: { stringValue: 'Tampered log' } }
  }, TOKENS.superAdmin);
  assert.equal(updateRes.status, 403, 'Updating error log must be denied (append-only)');

  const deleteRes = await req('DELETE', `/error_logs/${errId}`, null, TOKENS.superAdmin);
  assert.equal(deleteRes.status, 403, 'Deleting error log must be denied (append-only)');
});
