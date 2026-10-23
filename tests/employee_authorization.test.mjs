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

test('Employee Portal CRUD Authorization & Best Practices', async (t) => {
  // Create an ephemeral authenticated regular employee
  const empEmail = `ephemeral_employee_${Date.now()}@kalpanaaa.in`;
  const empPass = 'EmployeePass@2026!';
  const signUpRes = await req(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`,
    'POST',
    { email: empEmail, password: empPass, returnSecureToken: true }
  );

  assert.equal(signUpRes.status, 200, `Sign-up must succeed: ${JSON.stringify(signUpRes.body)}`);
  const empToken = signUpRes.body.idToken;
  const empUid = signUpRes.body.localId;

  // Initialize employee document
  await req(
    `${FIRESTORE_BASE}/employees/${empUid}`,
    'PATCH',
    {
      fields: {
        id: { stringValue: empUid },
        uid: { stringValue: empUid },
        email: { stringValue: empEmail },
        role: { stringValue: 'EMPLOYEE' },
        fullName: { stringValue: 'Test Portal Employee' },
        createdAt: { timestampValue: new Date().toISOString() }
      }
    },
    empToken
  );

  const testDate = '2026-11-20';
  const testRequestId = `test_leave_req_${Date.now()}`;
  const testLockId = testDate;

  await t.test('1. Employee can create a Leave Request with UID anchor', async () => {
    const payload = {
      fields: {
        id: { stringValue: testRequestId },
        employeeUid: { stringValue: empUid },
        employeeId: { stringValue: empUid },
        employeeName: { stringValue: 'Test Portal Employee' },
        department: { stringValue: 'Engineering' },
        type: { stringValue: 'Leave' },
        leaveCategory: { stringValue: 'Earn Leave' },
        startDate: { stringValue: testDate },
        endDate: { stringValue: testDate },
        reason: { stringValue: 'Verified smooth employee leave request creation' },
        status: { stringValue: 'Pending' },
        requestDate: { timestampValue: new Date().toISOString() },
        createdAt: { timestampValue: new Date().toISOString() },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/leaveRequests/${testRequestId}`,
      'PATCH',
      payload,
      empToken
    );
    if (res.status !== 200) {
      console.error('Test 1 failed with status:', res.status, 'body:', JSON.stringify(res.body));
    }
    assert.equal(res.status, 200, `Expected 200 on leave request create, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('2. Employee can create, read, and delete leaveLocks subcollection entry', async () => {
    const payload = {
      fields: {
        id: { stringValue: testLockId },
        requestId: { stringValue: testRequestId },
        employeeUid: { stringValue: empUid },
        employeeId: { stringValue: empUid },
        type: { stringValue: 'Leave' },
        active: { booleanValue: true },
        reservedAt: { timestampValue: new Date().toISOString() }
      }
    };
    const res = await req(
      `${FIRESTORE_BASE}/employees/${empUid}/leaveLocks/${testLockId}`,
      'PATCH',
      payload,
      empToken
    );
    assert.equal(res.status, 200, `Expected 200 on leaveLock create, got ${res.status}`);

    const delRes = await req(
      `${FIRESTORE_BASE}/employees/${empUid}/leaveLocks/${testLockId}`,
      'DELETE',
      null,
      empToken
    );
    assert.equal(delRes.status, 200, `Expected 200 on leaveLock delete, got ${delRes.status}`);
  });

  await t.test('3. Employee can cancel and delete their own leave request', async () => {
    const cancelRes = await req(
      `${FIRESTORE_BASE}/leaveRequests/${testRequestId}?updateMask.fieldPaths=status&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      {
        fields: {
          status: { stringValue: 'Cancelled' },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );
    assert.equal(cancelRes.status, 200, `Expected 200 on leave request cancel, got ${cancelRes.status}`);

    const delRes = await req(
      `${FIRESTORE_BASE}/leaveRequests/${testRequestId}`,
      'DELETE',
      null,
      empToken
    );
    assert.equal(delRes.status, 200, `Expected 200 on cancelled leave delete, got ${delRes.status}`);
  });

  await t.test('4. Employee can update own profile fields (phone, bio, skills)', async () => {
    const res = await req(
      `${FIRESTORE_BASE}/employees/${empUid}?updateMask.fieldPaths=bio&updateMask.fieldPaths=phone&updateMask.fieldPaths=skills`,
      'PATCH',
      {
        fields: {
          bio: { stringValue: 'Updated bio by employee portal self-service' },
          phone: { stringValue: '+91 99999 88888' },
          skills: {
            arrayValue: {
              values: [{ stringValue: 'TypeScript' }, { stringValue: 'React' }]
            }
          }
        }
      },
      empToken
    );
    assert.equal(res.status, 200, `Expected 200 on employee profile update, got ${res.status}`);
  });

  await t.test('5. Employee can write and read own private resume subcollection', async () => {
    const res = await req(
      `${FIRESTORE_BASE}/employees/${empUid}/private/resume`,
      'PATCH',
      {
        fields: {
          dataUrl: { stringValue: 'data:application/pdf;base64,JVBERi0xLjQKJ...' },
          fileName: { stringValue: 'my-resume.pdf' },
          contentType: { stringValue: 'application/pdf' },
          uploadedAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );
    assert.equal(res.status, 200, `Expected 200 on private resume write, got ${res.status}`);

    const getRes = await req(
      `${FIRESTORE_BASE}/employees/${empUid}/private/resume`,
      'GET',
      null,
      empToken
    );
    assert.equal(getRes.status, 200, `Expected 200 on private resume read, got ${getRes.status}`);
  });

  await t.test('6. Employee can mark notification as read', async () => {
    const notifId = `notif_test_${Date.now()}`;
    // Create notification
    await req(
      `${FIRESTORE_BASE}/notifications/${notifId}`,
      'PATCH',
      {
        fields: {
          type: { stringValue: 'LEAVE_REQUEST_SUBMITTED' },
          title: { stringValue: 'Leave Notification' },
          body: { stringValue: 'Pending review' },
          targetEmployeeId: { stringValue: empUid },
          actorId: { stringValue: empUid },
          audience: { arrayValue: { values: [{ stringValue: 'EMPLOYEE' }] } },
          isRead: { booleanValue: false },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );

    // Update notification (mark as read)
    const readRes = await req(
      `${FIRESTORE_BASE}/notifications/${notifId}?updateMask.fieldPaths=isRead&updateMask.fieldPaths=readAt&updateMask.fieldPaths=updatedAt`,
      'PATCH',
      {
        fields: {
          isRead: { booleanValue: true },
          readAt: { timestampValue: new Date().toISOString() },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );
    assert.equal(readRes.status, 200, `Expected 200 on marking notification read, got ${readRes.status}`);

    // Clean up
    await req(`${FIRESTORE_BASE}/notifications/${notifId}`, 'DELETE', null, empToken);
  });

  await t.test('7. Employee can create, update, and delete own Kanban project task', async () => {
    const taskId = `task_crud_${Date.now()}`;
    const createRes = await req(
      `${FIRESTORE_BASE}/projectTasks/${taskId}`,
      'PATCH',
      {
        fields: {
          id: { stringValue: taskId },
          title: { stringValue: 'Implement Feature A' },
          status: { stringValue: 'TODO' },
          createdByUid: { stringValue: empUid },
          createdAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );
    assert.equal(createRes.status, 200, `Expected 200 on task create, got ${createRes.status}`);

    const updateRes = await req(
      `${FIRESTORE_BASE}/projectTasks/${taskId}?updateMask.fieldPaths=status`,
      'PATCH',
      {
        fields: {
          status: { stringValue: 'IN_PROGRESS' }
        }
      },
      empToken
    );
    assert.equal(updateRes.status, 200, `Expected 200 on task update, got ${updateRes.status}`);

    const delRes = await req(
      `${FIRESTORE_BASE}/projectTasks/${taskId}`,
      'DELETE',
      null,
      empToken
    );
    assert.equal(delRes.status, 200, `Expected 200 on task delete by creator, got ${delRes.status}`);
  });

  await t.test('8. Employee can submit and view feedback quiz response', async () => {
    const quizId = 'quarterly-feedback-2026';
    const respId = `resp_${empUid}`;
    const createRes = await req(
      `${FIRESTORE_BASE}/feedbackQuizzes/${quizId}/responses/${respId}`,
      'PATCH',
      {
        fields: {
          id: { stringValue: respId },
          quizId: { stringValue: quizId },
          employeeUid: { stringValue: empUid },
          employeeId: { stringValue: empUid },
          submittedAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );
    assert.equal(createRes.status, 200, `Expected 200 on quiz response create, got ${createRes.status}`);

    const getRes = await req(
      `${FIRESTORE_BASE}/feedbackQuizzes/${quizId}/responses/${respId}`,
      'GET',
      null,
      empToken
    );
    assert.equal(getRes.status, 200, `Expected 200 on quiz response read, got ${getRes.status}`);

    await req(`${FIRESTORE_BASE}/feedbackQuizzes/${quizId}/responses/${respId}`, 'DELETE', null, empToken);
  });

  await t.test('9. Employee can register and unregister FCM token', async () => {
    const tokenId = `token_${Date.now()}`;
    const res = await req(
      `${FIRESTORE_BASE}/fcmTokens/${tokenId}`,
      'PATCH',
      {
        fields: {
          employeeUid: { stringValue: empUid },
          employeeId: { stringValue: empUid },
          token: { stringValue: 'test-fcm-token-string' },
          updatedAt: { timestampValue: new Date().toISOString() }
        }
      },
      empToken
    );
    assert.equal(res.status, 200, `Expected 200 on FCM token create, got ${res.status}`);

    const delRes = await req(
      `${FIRESTORE_BASE}/fcmTokens/${tokenId}`,
      'DELETE',
      null,
      empToken
    );
    assert.equal(delRes.status, 200, `Expected 200 on FCM token delete, got ${delRes.status}`);
  });

  await t.test('10. Security Boundary: Employee CANNOT modify another employee private resume', async () => {
    const otherEmpDocId = 'NTirYBVT1pSuLj5thrdsjM54F303';
    const res = await req(
      `${FIRESTORE_BASE}/employees/${otherEmpDocId}/private/resume`,
      'PATCH',
      {
        fields: {
          fileName: { stringValue: 'malicious.pdf' }
        }
      },
      empToken
    );
    assert.equal(res.status, 403, `Expected 403 PERMISSION_DENIED, got ${res.status}`);
  });

  // Clean up employee doc
  await req(`${FIRESTORE_BASE}/employees/${empUid}`, 'DELETE', null, empToken);
});
