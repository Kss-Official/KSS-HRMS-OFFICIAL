import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import pytest
import asyncio
import uuid
import json
import math
import random
from datetime import date
from sqlalchemy import text, select, delete
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.core.database import AsyncSessionLocal
from app.models.employee import Employee
from app.models.attendance import AttendanceRecord
from app.core.security import create_access_token
from app.models.enums import UserRole


def _make_distinct_descriptor(seed: int) -> list:
    """Generate a reproducible L2-normalized 128D face descriptor with given seed."""
    rng = random.Random(seed)
    vec = [rng.gauss(0, 1) for _ in range(128)]
    norm = math.sqrt(sum(x * x for x in vec))
    return [x / norm for x in vec]


@pytest.mark.asyncio
async def test_biometric_end_to_end_security():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:

        # Create two isolated, dedicated test employee accounts
        test_a_id = uuid.uuid4()
        test_b_id = uuid.uuid4()
        test_a_code = f"TEST{random.randint(10000, 99999)}"
        test_b_code = f"TEST{random.randint(10000, 99999)}"

        desc_a = _make_distinct_descriptor(seed=101)
        desc_b = _make_distinct_descriptor(seed=202)
        vec_a_str = "[" + ",".join(str(x) for x in desc_a) + "]"
        vec_b_str = "[" + ",".join(str(x) for x in desc_b) + "]"

        try:
            async with AsyncSessionLocal() as db:
                emp_a = Employee(
                    id=test_a_id,
                    employee_code=test_a_code,
                    full_name="Biometric Test User A",
                    email=f"{test_a_code.lower()}@kss.com",
                    password_hash="$2b$12$e80MvX9/TjPjC9K..fakehashforautotesting",
                    department="Engineering",
                    designation="Software Engineer",
                    joining_date=date.today(),
                    role=UserRole.EMPLOYEE,
                    is_active=True,
                    is_face_enrolled=True,
                    face_descriptor=desc_a,
                )
                emp_b = Employee(
                    id=test_b_id,
                    employee_code=test_b_code,
                    full_name="Biometric Test User B",
                    email=f"{test_b_code.lower()}@kss.com",
                    password_hash="$2b$12$e80MvX9/TjPjC9K..fakehashforautotesting",
                    department="Engineering",
                    designation="Software Engineer",
                    joining_date=date.today(),
                    role=UserRole.EMPLOYEE,
                    is_active=True,
                    is_face_enrolled=True,
                    face_descriptor=desc_b,
                )
                db.add(emp_a)
                db.add(emp_b)
                await db.commit()

                # Set vector embeddings using pgvector cast
                await db.execute(text(
                    "UPDATE employees SET face_embedding = CAST(:vec AS vector) WHERE id = :eid"
                ), {"vec": vec_a_str, "eid": test_a_id})
                await db.execute(text(
                    "UPDATE employees SET face_embedding = CAST(:vec AS vector) WHERE id = :eid"
                ), {"vec": vec_b_str, "eid": test_b_id})
                await db.commit()

            token_a = create_access_token(subject=str(test_a_id))
            token_b = create_access_token(subject=str(test_b_id))
            headers_a = {"Authorization": f"Bearer {token_a}"}
            headers_b = {"Authorization": f"Bearer {token_b}"}

            # ══════════════════════════════════════════════════════════
            # TEST 1: Cross-Employee Impersonation Attack → MUST REJECT
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 1: Cross-Employee Impersonation Attack ---")
            resp1 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_a,   # Logged in as Test User A
                json={
                    "face_descriptor": desc_b,   # Scanning Test User B's face!
                    "latitude": 12.9716,
                    "longitude": 77.5946
                }
            )
            print(f"Status: {resp1.status_code} | Response: {resp1.json()}")
            assert resp1.status_code in (400, 403), (
                f"Cross-employee impersonation must be rejected (got {resp1.status_code})"
            )

            # ══════════════════════════════════════════════════════════
            # TEST 2: Reverse Impersonation Attack → MUST REJECT
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 2: Reverse Impersonation Attack ---")
            resp2 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_b,   # Logged in as Test User B
                json={
                    "face_descriptor": desc_a,   # Scanning Test User A's face!
                    "latitude": 12.9716,
                    "longitude": 77.5946
                }
            )
            print(f"Status: {resp2.status_code} | Response: {resp2.json()}")
            assert resp2.status_code in (400, 403), (
                f"Reverse impersonation must be rejected (got {resp2.status_code})"
            )

            # ══════════════════════════════════════════════════════════
            # TEST 3: Unauthorized Proxy Check-In Attack → 403
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 3: Unauthorized Proxy Check-In Attack ---")
            resp3 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_b,
                json={
                    "employee_code": test_a_code,   # Specifying User A's code
                    "face_descriptor": desc_b,
                    "latitude": 12.9716,
                    "longitude": 77.5946
                }
            )
            print(f"Status: {resp3.status_code} | Response: {resp3.json()}")
            assert resp3.status_code == 403, f"Non-admin proxy check-in must be 403 (got {resp3.status_code})"

            # ══════════════════════════════════════════════════════════
            # TEST 4: Enrolled employee submits no face descriptor → 400
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 4: Bypassing Biometrics Attack ---")
            resp4 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_a,
                json={"latitude": 12.9716, "longitude": 77.5946}
            )
            print(f"Status: {resp4.status_code} | Response: {resp4.json()}")
            assert resp4.status_code == 400, "Enrolled employee must require face scan"
            assert "Biometric verification required" in resp4.json()["detail"]

            # ══════════════════════════════════════════════════════════
            # TEST 5: User A checks in with their own genuine face → 200
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 5: Legitimate User A Check-In ---")
            resp5 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_a,
                json={
                    "face_descriptor": desc_a,
                    "latitude": 12.9716,
                    "longitude": 77.5946
                }
            )
            print(f"Status: {resp5.status_code} | Response: {resp5.json()}")
            assert resp5.status_code == 200, f"Genuine User A face must succeed (got {resp5.status_code}: {resp5.json()})"
            assert resp5.json()["attendance_method"] == "BIOMETRIC_FACE"

            # ══════════════════════════════════════════════════════════
            # TEST 6: User B checks in with their own genuine face → 200
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 6: Legitimate User B Check-In ---")
            resp6 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_b,
                json={
                    "face_descriptor": desc_b,
                    "latitude": 12.9716,
                    "longitude": 77.5946
                }
            )
            print(f"Status: {resp6.status_code} | Response: {resp6.json()}")
            assert resp6.status_code == 200, f"Genuine User B face must succeed (got {resp6.status_code}: {resp6.json()})"
            assert resp6.json()["attendance_method"] == "BIOMETRIC_FACE"

            # ══════════════════════════════════════════════════════════
            # TEST 7: Duplicate check-in on same day → 400
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 7: Duplicate Check-In Prevention ---")
            resp7 = await client.post(
                "/api/v1/attendance/check-in",
                headers=headers_a,
                json={
                    "face_descriptor": desc_a,
                    "latitude": 12.9716,
                    "longitude": 77.5946
                }
            )
            print(f"Status: {resp7.status_code}")
            assert resp7.status_code == 400
            assert "already checked in" in resp7.json()["detail"].lower()

            # ══════════════════════════════════════════════════════════
            # TEST 8: Anti-collision — User B tries to enroll User A's face → 409
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 8: Biometric Re-registration Collision Protection ---")
            resp8 = await client.post(
                f"/api/v1/employees/{test_b_id}/enroll-face",
                headers=headers_b,
                json={"face_descriptor": desc_a}   # User B tries to register User A's face!
            )
            print(f"Status: {resp8.status_code} | Response: {resp8.json()}")
            assert resp8.status_code == 409, f"Duplicate face enrollment must be rejected 409 (got {resp8.status_code})"
            assert "Security Violation: This face is already enrolled under" in resp8.json()["detail"]

            # ══════════════════════════════════════════════════════════
            # TEST 9: Authenticated 1:1 Face Verification Endpoint
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 9: 1:1 Face Verification ---")
            resp9 = await client.post(
                "/api/v1/attendance/verify-face",
                headers=headers_a,
                json={
                    "face_descriptor": desc_a,
                    "employee_id": str(test_a_id),
                    "employee_code": test_a_code
                }
            )
            print(f"Status: {resp9.status_code} | Response: {resp9.json()}")
            assert resp9.status_code == 200
            data9 = resp9.json()
            assert data9["matched"] is True
            assert data9["confidence"] >= 0.95, f"Confidence must be >= 0.95 (got {data9['confidence']})"

            # ══════════════════════════════════════════════════════════
            # TEST 10: Employees Alias Endpoint /employees/verify-face
            # ══════════════════════════════════════════════════════════
            print("\n--- TEST 10: Alias /employees/verify-face ---")
            resp10 = await client.post(
                "/api/v1/employees/verify-face",
                headers=headers_a,
                json={
                    "face_descriptor": desc_a,
                    "employee_id": str(test_a_id),
                    "employee_code": test_a_code
                }
            )
            print(f"Status: {resp10.status_code} | Response: {resp10.json()}")
            assert resp10.status_code == 200
            assert resp10.json()["matched"] is True

            print("\n>>> ALL 10 BIOMETRIC SECURITY TESTS PASSED PERFECTLY! <<<")

        finally:
            # CLEANUP: strictly delete ONLY the two test employees and their test records
            async with AsyncSessionLocal() as db:
                await db.execute(delete(AttendanceRecord).where(
                    AttendanceRecord.employee_id.in_([test_a_id, test_b_id])
                ))
                await db.execute(delete(Employee).where(
                    Employee.id.in_([test_a_id, test_b_id])
                ))
                await db.commit()


if __name__ == "__main__":
    asyncio.run(test_biometric_end_to_end_security())
