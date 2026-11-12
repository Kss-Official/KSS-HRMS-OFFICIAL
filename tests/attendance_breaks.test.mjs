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

test('Attendance Break Authorization & Security Boundary Unit Tests', async (t) => {
  // 1. Create two test users: Alice (owner) and Bob (attacker)
  const aliceEmail = `test_alice_${Date.now()}@kalpanaaa.in`;
  const bobEmail = `test_bob_${Date.now()}@kalpanaaa.in`;
  const password = 'TestUserPass@2026!';

  let aliceSign, bobSign;
  try {
    [aliceSign, bobSign] = await Promise.all([
      req(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, 'POST', { email: aliceEmail, password, returnSecureToken: true }),
      req(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, 'POST', { email: bobEmail, password, returnSecureToken: true })
    ]);
  } catch (err) {
    if (err?.code === 'ENOTFOUND' || err?.message?.includes('ENOTFOUND')) {
      t.skip('Skipping live network test in offline sandbox. Run tests/security_rules.test.mjs for hermetic rules testing.');
      return;
    }
    throw err;
  }

  assert.equal(aliceSign.status, 200, 'Alice sign-up must succeed');
  assert.equal(bobSign.status, 200, 'Bob sign-up must succeed');

  const aliceToken = aliceSign.body.idToken;
  const aliceUid = aliceSign.body.localId;
  const bobToken = bobSign.body.idToken;
  const bobUid = bobSign.body.localId;

  // Set up employee directory docs using adminToken
  // Read admin token
  const fs = await import('fs');
  const path = await import('path');
  const os = await import('os');
  const configPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const adminToken = config.tokens?.access_token;

  const empSetup = await req(`${FIRESTORE_BASE}/employees/${aliceUid}`, 'PATCH', {
    fields: {
      id: { stringValue: aliceUid },
      uid: { stringValue: aliceUid },
      email: { stringValue: aliceEmail },
      role: { stringValue: 'EMPLOYEE' },
      employeeId: { stringValue: 'ALICE001' },
      fullName: { stringValue: 'Alice Test' }
    }
  }, adminToken);
  assert.equal(empSetup.status, 200, `Employee doc setup must succeed: ${JSON.stringify(empSetup.body)}`);

  const testDate = '2026-10-27';
  const attendanceId = `${aliceUid}_${testDate}`;
  const nowIso = new Date().toISOString();

  // Create checked-in attendance document for Alice via adminToken setup
  const checkInRes = await req(`${FIRESTORE_BASE}/attendance/${attendanceId}`, 'PATCH', {
    fields: {
      id: { stringValue: attendanceId },
      uid: { stringValue: aliceUid },
      employeeUid: { stringValue: aliceUid },
      authUid: { stringValue: aliceUid },
      email: { stringValue: aliceEmail },
      employeeEmail: { stringValue: aliceEmail },
      employeeId: { stringValue: aliceUid },
      employeeCode: { stringValue: 'ALICE001' },
      employeeName: { stringValue: 'Alice Test' },
      department: { stringValue: 'Engineering' },
      date: { stringValue: testDate },
      checkInAt: { timestampValue: nowIso },
      checkOutAt: { nullValue: null },
      workingMinutes: { integerValue: '0' },
      totalBreakMinutes: { integerValue: '0' },
      status: { stringValue: 'Present' },
      breaks: { arrayValue: { values: [] } }
    }
  }, adminToken);
  assert.equal(checkInRes.status, 200, `Check-in setup must succeed, got ${checkInRes.status}: ${JSON.stringify(checkInRes.body)}`);

  // Test 1: Alice successfully starts a break (assertSucceeds)
  await t.test('1. Owner can start a break with canonical payload', async () => {
    const breakStartIso = new Date().toISOString();
    const payload = {
      fields: {
        breaks: {
          arrayValue: {
            values: [
              {
                mapValue: {
                  fields: {
                    type: { stringValue: 'Tea Break' },
                    startAt: { stringValue: breakStartIso },
                    endAt: { nullValue: null },
                    durationMinutes: { integerValue: '0' }
                  }
                }
              }
            ]
          }
        },
        totalBreakMinutes: { integerValue: '0' },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };

    const res = await req(
      `${FIRESTORE_BASE}/attendance/${attendanceId}?updateMask.fieldPaths=breaks&updateMask.fieldPaths=totalBreakMinutes&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      aliceToken
    );
    assert.equal(res.status, 200, `Owner break start must return 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 2: Alice successfully ends her break (assertSucceeds)
  await t.test('2. Owner can end a break and record duration', async () => {
    const breakStartIso = new Date(Date.now() - 15 * 60000).toISOString();
    const breakEndIso = new Date().toISOString();
    const payload = {
      fields: {
        breaks: {
          arrayValue: {
            values: [
              {
                mapValue: {
                  fields: {
                    type: { stringValue: 'Tea Break' },
                    startAt: { stringValue: breakStartIso },
                    endAt: { stringValue: breakEndIso },
                    durationMinutes: { integerValue: '15' }
                  }
                }
              }
            ]
          }
        },
        totalBreakMinutes: { integerValue: '15' },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };

    const res = await req(
      `${FIRESTORE_BASE}/attendance/${attendanceId}?updateMask.fieldPaths=breaks&updateMask.fieldPaths=totalBreakMinutes&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      aliceToken
    );
    assert.equal(res.status, 200, `Owner break end must return 200, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // Test 3: Negative test - Bob attempts to update Alice's attendance (assertFails: 403)
  await t.test('3. Negative Security: Attacker cannot update other user break record', async () => {
    const payload = {
      fields: {
        totalBreakMinutes: { integerValue: '99' },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };

    const res = await req(
      `${FIRESTORE_BASE}/attendance/${attendanceId}?updateMask.fieldPaths=totalBreakMinutes&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      bobToken
    );
    assert.equal(res.status, 403, `Attacker update must fail with 403 PERMISSION_DENIED, got ${res.status}`);
  });

  // Test 4: Negative test - Alice attempts to update unwhitelisted/unknown field (assertFails: 403)
  await t.test('4. Negative Security: Owner cannot inject unknown or unwhitelisted fields', async () => {
    const payload = {
      fields: {
        unwhitelistedField: { booleanValue: true },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };

    const res = await req(
      `${FIRESTORE_BASE}/attendance/${attendanceId}?updateMask.fieldPaths=unwhitelistedField&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      aliceToken
    );
    assert.equal(res.status, 403, `Unwhitelisted field update must fail with 403 PERMISSION_DENIED, got ${res.status}`);
  });

  // Test 5: Negative test - Alice attempts to mutate immutable authUid/uid (assertFails: 403)
  await t.test('5. Negative Security: Owner cannot modify immutable authUid or employeeUid', async () => {
    const payload = {
      fields: {
        authUid: { stringValue: bobUid },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };

    const res = await req(
      `${FIRESTORE_BASE}/attendance/${attendanceId}?updateMask.fieldPaths=authUid&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      payload,
      aliceToken
    );
    assert.equal(res.status, 403, `Immutable UID modification must fail with 403 PERMISSION_DENIED, got ${res.status}`);
  });

  // Clean up
  await req(`${FIRESTORE_BASE}/attendance/${attendanceId}`, 'DELETE', null, aliceToken);
  await req(`${FIRESTORE_BASE}/employees/${aliceUid}`, 'DELETE', null, aliceToken);
});
