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


def _normalize(vec: list) -> list:
    norm = math.sqrt(sum(x * x for x in vec))
    if norm == 0:
        return vec
    return [x / norm for x in vec]


@pytest.mark.asyncio
async def test_biometric_end_to_end_security():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:

        async with AsyncSessionLocal() as db:
            # --- Fetch Employee A (Akash SB — has a real enrolled face) ---
            res_a = await db.execute(text(
                "SELECT id, employee_code, full_name, face_descriptor, face_embedding "
                "FROM employees WHERE employee_code = 'KSS2407013'"
            ))
            emp_a = res_a.fetchone()
            assert emp_a is not None, "Akash SB (KSS2407013) must exist"
            desc_a_raw = emp_a[3]
            desc_a = json.loads(desc_a_raw) if isinstance(desc_a_raw, str) else desc_a_raw
            assert desc_a is not None, "Akash SB must have a face descriptor"
            desc_a = list(desc_a)

            # --- Fetch Employee B (use first unenrolled active employee) ---
            res_b = await db.execute(text(
                "SELECT id, employee_code, full_name FROM employees "
                "WHERE employee_code = 'KSS2407001' AND is_active = true"
            ))
            emp_b = res_b.fetchone()
            assert emp_b is not None, "KSS2407001 must exist"

            # Enroll a DISTINCT synthetic face for Employee B for this test
            desc_b = _make_distinct_descriptor(seed=42)  # unique seed → unique face
            vec_b_str = "[" + ",".join(str(x) for x in desc_b) + "]"
            desc_b_json = json.dumps(desc_b)
            await db.execute(text(
                "UPDATE employees SET face_descriptor = :desc, face_embedding = CAST(:vec AS vector), "
                "is_face_enrolled = true WHERE id = :eid"
            ), {"desc": desc_b_json, "vec": vec_b_str, "eid": emp_b[0]})
            await db.commit()

            # Clear today's attendance for clean test
            await db.execute(delete(AttendanceRecord).where(
                AttendanceRecord.employee_id.in_([emp_a[0], emp_b[0]])
            ))
            await db.commit()

        token_a = create_access_token(subject=str(emp_a[0]))
        token_b = create_access_token(subject=str(emp_b[0]))
        headers_a = {"Authorization": f"Bearer {token_a}"}
        headers_b = {"Authorization": f"Bearer {token_b}"}

        # ══════════════════════════════════════════════════════════
        # TEST 1: Employee B's face used on Employee A's account → MUST REJECT
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 1: Cross-Employee Impersonation Attack ---")
        resp1 = await client.post(
            "/api/v1/attendance/check-in",
            headers=headers_a,   # Logged in as Employee A
            json={
                "face_descriptor": desc_b,   # Scanning Employee B's face!
                "latitude": 12.9716,
                "longitude": 77.5946
            }
        )
        print(f"Status: {resp1.status_code} | Response: {resp1.json()}")
        assert resp1.status_code in (400, 403), (
            f"Cross-employee impersonation must be rejected (got {resp1.status_code})"
        )

        # Verify NO record was created for Employee A
        async with AsyncSessionLocal() as db:
            rec = await db.execute(select(AttendanceRecord).where(
                AttendanceRecord.employee_id == emp_a[0]
            ))
            assert rec.scalar_one_or_none() is None, "Failed check-in must NEVER create an attendance record!"

        # ══════════════════════════════════════════════════════════
        # TEST 2: Employee A's face used on Employee B's account → MUST REJECT
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 2: Reverse Impersonation Attack ---")
        resp2 = await client.post(
            "/api/v1/attendance/check-in",
            headers=headers_b,   # Logged in as Employee B
            json={
                "face_descriptor": desc_a,   # Scanning Employee A's face!
                "latitude": 12.9716,
                "longitude": 77.5946
            }
        )
        print(f"Status: {resp2.status_code} | Response: {resp2.json()}")
        assert resp2.status_code in (400, 403), (
            f"Reverse impersonation must be rejected (got {resp2.status_code})"
        )
        detail2 = (resp2.json().get("detail") or "").lower()
        assert any(kw in detail2 for kw in ("mismatch", "critical", "biometric", "face", "impersonation")), \
            f"Rejection message should reference biometric failure, got: {detail2}"

        # ══════════════════════════════════════════════════════════
        # TEST 3: Employee B specifies Employee A's code in body → 403
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 3: Unauthorized Proxy Header Attack ---")
        resp3 = await client.post(
            "/api/v1/attendance/check-in",
            headers=headers_b,
            json={
                "employee_code": "KSS2407013",   # Specifying Employee A's code
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
        # TEST 5: Employee A checks in with their own genuine face → 200
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 5: Legitimate Employee A Check-In ---")
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
        assert resp5.status_code == 200, f"Genuine Employee A face must succeed (got {resp5.status_code}: {resp5.json()})"
        assert resp5.json()["attendance_method"] == "BIOMETRIC_FACE"

        # ══════════════════════════════════════════════════════════
        # TEST 6: Employee B checks in with their own genuine face → 200
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 6: Legitimate Employee B Check-In ---")
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
        assert resp6.status_code == 200, f"Genuine Employee B face must succeed (got {resp6.status_code}: {resp6.json()})"
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
        # TEST 8: Anti-collision — Employee B tries to enroll Employee A's face → 409
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 8: Biometric Re-registration Collision Protection ---")
        resp8 = await client.post(
            f"/api/v1/employees/{emp_b[0]}/enroll-face",
            headers=headers_b,
            json={"face_descriptor": desc_a}   # Employee B tries to register Employee A's face!
        )
        print(f"Status: {resp8.status_code} | Response: {resp8.json()}")
        assert resp8.status_code == 409, f"Duplicate face enrollment must be rejected 409 (got {resp8.status_code})"
        assert "Security Violation: This face is already enrolled under" in resp8.json()["detail"]

        # ══════════════════════════════════════════════════════════
        # CLEANUP: Reset Employee B's biometric (do not leave synthetic data)
        # ══════════════════════════════════════════════════════════
        async with AsyncSessionLocal() as db:
            await db.execute(text(
                "UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, "
                "is_face_enrolled = false WHERE id = :eid"
            ), {"eid": emp_b[0]})
            await db.execute(delete(AttendanceRecord).where(
                AttendanceRecord.employee_id.in_([emp_a[0], emp_b[0]])
            ))
            await db.commit()

        print("\n>>> ALL BIOMETRIC SECURITY TESTS PASSED PERFECTLY! <<<")


if __name__ == "__main__":
    asyncio.run(test_biometric_end_to_end_security())
