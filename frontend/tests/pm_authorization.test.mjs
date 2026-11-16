import https from 'https';
import test from 'node:test';
import assert from 'node:assert/strict';

const PROJECT_ID = 'kalpanaaa-employees-website';
const API_KEY = 'AIzaSyB5sN1axynuVlmzK0k6lLrvL3PbsR7x0QA';
const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

function req(url, method, body, token) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const s = body ? JSON.stringify(body) : null;
    const r = https.request(u, { method, headers }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, body: d }); }
      });
    });
    r.on('error', reject);
    if (s) r.write(s);
    r.end();
  });
}

async function signIn(email, password) {
  const authRes = await req(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,
    'POST',
    { email, password, returnSecureToken: true }
  );
  if (authRes.status !== 200) {
    throw new Error(`Sign-in failed for ${email}: ${JSON.stringify(authRes.body)}`);
  }
  return { token: authRes.body.idToken, uid: authRes.body.localId };
}

test('Project Manager Operational & Override Permissions', async (t) => {
  const pmAuth = await signIn('d.koushik@kalpanaaasoftwaresolutions.in', 'Koushik@777');

  await t.test('1. PM can mark an employee absent (create attendance override)', async () => {
    const docId = `autotest_pm_absent_${Date.now()}`;
    const payload = {
      fields: {
        id: { stringValue: docId },
        employeeId: { stringValue: 'emp-KSS2407008' },
        employeeCode: { stringValue: 'KSS2407008' },
        employeeName: { stringValue: 'Pratiksha Harode' },
        status: { stringValue: 'Absent' },
        date: { stringValue: '2026-10-21' },
        workingMinutes: { integerValue: 0 },
        isWfh: { booleanValue: false },
        attendanceMethod: { stringValue: 'HR_CORRECTION' },
        correctedBy: { stringValue: 'D. Koushik' },
        correctedByUid: { stringValue: pmAuth.uid },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/attendance/${docId}`,
      'PATCH',
      payload,
      pmAuth.token
    );
    assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);

    // Clean up
    await req(`${FIRESTORE_BASE}/attendance/${docId}`, 'DELETE', null, pmAuth.token);
  });

  await t.test('2. PM can delete / unmark attendance records', async () => {
    const docId = `autotest_pm_del_${Date.now()}`;
    // Create record first
    await req(
      `${FIRESTORE_BASE}/attendance/${docId}`,
      'PATCH',
      {
        fields: {
          id: { stringValue: docId },
          employeeId: { stringValue: 'emp-KSS2407008' },
          status: { stringValue: 'Present' },
          date: { stringValue: '2026-10-21' },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      },
      pmAuth.token
    );

    // Delete record
    const delRes = await req(
      `${FIRESTORE_BASE}/attendance/${docId}`,
      'DELETE',
      null,
      pmAuth.token
    );
    assert.equal(delRes.status, 200, `Expected 200 on DELETE, got ${delRes.status}`);
  });

  await t.test('3. PM can update employee leave balances and approved WFH dates', async () => {
    const empDocId = 'NTirYBVT1pSuLj5thrdsjM54F303'; // Pratiksha Harode
    const payload = {
      fields: {
        casualLeaveBalance: { integerValue: 2 },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/employees/${empDocId}?updateMask.fieldPaths=casualLeaveBalance&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      pmAuth.token
    );
    assert.equal(res.status, 200, `Expected 200, got ${res.status}`);
  });

  await t.test('4. PM can create and update leave ledger entries', async () => {
    const empDocId = 'NTirYBVT1pSuLj5thrdsjM54F303';
    const txnId = `txn_${Date.now()}`;
    const payload = {
      fields: {
        id: { stringValue: txnId },
        type: { stringValue: 'CREDIT' },
        category: { stringValue: 'Earn Leave' },
        amount: { integerValue: 1 },
        performedBy: { stringValue: 'D. Koushik' },
        timestamp: { stringValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/employees/${empDocId}/leaveLedger/${txnId}`,
      'PATCH',
      payload,
      pmAuth.token
    );
    assert.equal(res.status, 200, `Expected 200 on leave ledger create, got ${res.status}`);
  });

  await t.test('5. PM can update company work zones and settings', async () => {
    const payload = {
      fields: {
        name: { stringValue: 'Kalpanaaa Software Solutions HQ' },
        radiusMeters: { integerValue: 100 },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/workZones/company?updateMask.fieldPaths=name&updateMask.fieldPaths=radiusMeters&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      pmAuth.token
    );
    assert.equal(res.status, 200, `Expected 200 on workZone update, got ${res.status}`);
  });
});

test('Security Restrictions: Unauthorized Regular Employees CANNOT Perform Privileged Actions', async (t) => {
  // Create an ephemeral regular user with no PM/HR role
  const empEmail = `ephemeral_emp_${Date.now()}@kalpanaaa.in`;
  const empPass = 'EphemeralPass@2026!';
  const signUpRes = await req(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    'POST',
    { email: empEmail, password: empPass, returnSecureToken: true }
  );

  let empToken = '';
  if (signUpRes.status === 200) {
    empToken = signUpRes.body.idToken;
  } else {
    // If sign-up is disabled, fallback to anonymous auth
    const anonRes = await req(
      `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
      'POST',
      { returnSecureToken: true }
    );
    empToken = anonRes.body.idToken;
  }
  const empAuth = { token: empToken };

  await t.test('1. Regular employee CANNOT mark another employee absent', async () => {
    const docId = `unauthorized_att_${Date.now()}`;
    const payload = {
      fields: {
        id: { stringValue: docId },
        employeeId: { stringValue: 'emp-KSS2407008' },
        employeeCode: { stringValue: 'KSS2407008' },
        status: { stringValue: 'Absent' },
        date: { stringValue: '2026-10-21' },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/attendance/${docId}`,
      'PATCH',
      payload,
      empAuth.token
    );
    assert.equal(res.status, 403, `Expected 403 PERMISSION_DENIED, got ${res.status}`);
  });

  await t.test('2. Regular employee CANNOT delete attendance records', async () => {
    const res = await req(
      `${FIRESTORE_BASE}/attendance/some_doc_id`,
      'DELETE',
      null,
      empAuth.token
    );
    assert.equal(res.status, 403, `Expected 403 PERMISSION_DENIED on delete, got ${res.status}`);
  });

  await t.test('3. Regular employee CANNOT modify another employee leave balance', async () => {
    const res = await req(
      `${FIRESTORE_BASE}/employees/NTirYBVT1pSuLj5thrdsjM54F303?updateMask.fieldPaths=earnLeaveBalance`,
      'PATCH',
      {
        fields: {
          earnLeaveBalance: { integerValue: 99 }
        }
      },
      empAuth.token
    );
    assert.equal(res.status, 403, `Expected 403 PERMISSION_DENIED on employee balance edit, got ${res.status}`);
  });

  await t.test('4. Regular employee CANNOT update company settings or work zones', async () => {
    const res = await req(
      `${FIRESTORE_BASE}/workZones/company?updateMask.fieldPaths=radiusMeters`,
      'PATCH',
      {
        fields: {
          radiusMeters: { integerValue: 50000 }
        }
      },
      empAuth.token
    );
    assert.equal(res.status, 403, `Expected 403 PERMISSION_DENIED on workZone edit, got ${res.status}`);
  });
});
