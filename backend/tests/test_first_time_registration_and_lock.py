import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import asyncio
import json
from datetime import date
from sqlalchemy import text, delete, select
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.core.database import AsyncSessionLocal
from app.core.security import create_access_token
from app.models.attendance import AttendanceRecord
from app.models.employee import Employee
from app.models.enums import UserRole

async def test_registration_and_strict_lock():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        # Step 1: Query Akash SB (already enrolled) and Gaurav (currently unenrolled)
        async with AsyncSessionLocal() as db:
            res_akash = await db.execute(text("SELECT id, employee_code, full_name, face_descriptor, is_face_enrolled FROM employees WHERE employee_code = 'KSS2407013'"))
            akash = res_akash.fetchone()
            assert akash[4] == True, "Akash SB must be enrolled"
            akash_desc = json.loads(akash[3]) if isinstance(akash[3], str) else akash[3]

            res_gaurav = await db.execute(text("SELECT id, employee_code, full_name, is_face_enrolled FROM employees WHERE employee_code = 'KSS2407001'"))
            gaurav = res_gaurav.fetchone()
            assert gaurav[3] == False, "Gaurav must be unenrolled before first registration"

            # Clean any test attendance records for today
            today = date.today()
            await db.execute(delete(AttendanceRecord).where(AttendanceRecord.employee_id.in_([akash[0], gaurav[0]])))
            await db.commit()

        token_akash = create_access_token(subject=str(akash[0]))
        token_gaurav = create_access_token(subject=str(gaurav[0]))
        headers_akash = {"Authorization": f"Bearer {token_akash}"}
        headers_gaurav = {"Authorization": f"Bearer {token_gaurav}"}

        # Step 2: Unenrolled employee tries to check in before registering face
        print("\n--- TEST: Unenrolled Employee Must Register Face First ---")
        unregistered_checkin = await client.post(
            "/api/v1/attendance/check-in",
            headers=headers_gaurav,
            json={
                "face_descriptor": [0.1] * 128,  # Attempting check-in without enrolled template
                "latitude": 12.9716,
                "longitude": 77.5946
            }
        )
        print(f"Status: {unregistered_checkin.status_code}")
        print(f"Detail: {unregistered_checkin.json()['detail']}")
        assert unregistered_checkin.status_code == 400
        assert "No registered face biometric template found" in unregistered_checkin.json()["detail"]

        # Step 3: Employee registers their face for the first time
        print("\n--- TEST: Employee Registers Face Biometrics ---")
        # Distinct test face vector for Gaurav
        gaurav_new_face = [0.08] * 64 + [-0.08] * 64
        # Unit normalize
        norm = sum(x*x for x in gaurav_new_face) ** 0.5
        gaurav_new_face = [round(x / norm, 6) for x in gaurav_new_face]

        enroll_res = await client.post(
            f"/api/v1/employees/{gaurav[0]}/enroll-face",
            headers=headers_gaurav,
            json={"face_descriptor": gaurav_new_face}
        )
        print(f"Status: {enroll_res.status_code}")
        assert enroll_res.status_code == 200
        print("✓ Face biometrics successfully registered and locked in Neon Vector DB")

        # Step 4: After registering, ONLY that face works for check-in
        print("\n--- TEST: Genuine Face Check-In (Should SUCCEED) ---")
        genuine_checkin = await client.post(
            "/api/v1/attendance/check-in",
            headers=headers_gaurav,
            json={
                "face_descriptor": gaurav_new_face,
                "latitude": 12.9716,
                "longitude": 77.5946
            }
        )
        print(f"Status: {genuine_checkin.status_code}")
        print(f"Method: {genuine_checkin.json().get('attendance_method')}")
        assert genuine_checkin.status_code == 200
        assert genuine_checkin.json()["attendance_method"] == "BIOMETRIC_FACE"
        print("✓ Genuine registered face check-in succeeded!")

        # Step 5: OTHER face tries to check in as Gaurav (Akash's face on Gaurav's account)
        print("\n--- TEST: Other Face Check-In (Must REJECT with 403) ---")
        # Clear today's check-in to test rejected attempt
        async with AsyncSessionLocal() as db:
            await db.execute(delete(AttendanceRecord).where(AttendanceRecord.employee_id == gaurav[0]))
            await db.commit()

        impostor_checkin = await client.post(
            "/api/v1/attendance/check-in",
            headers=headers_gaurav,
            json={
                "face_descriptor": akash_desc,  # Akash's face on Gaurav's account!
                "latitude": 12.9716,
                "longitude": 77.5946
            }
        )
        print(f"Status: {impostor_checkin.status_code}")
        print(f"Detail: {impostor_checkin.json()['detail']}")
        assert impostor_checkin.status_code == 403
        assert "CRITICAL SECURITY REJECTION" in impostor_checkin.json()["detail"]
        assert "Akash SB" in impostor_checkin.json()["detail"]
        print("✓ Cross-employee check-in blocked! Other faces cannot check in!")

        # Step 6: Verify no attendance record created on failure
        async with AsyncSessionLocal() as db:
            chk = await db.execute(select(AttendanceRecord).where(AttendanceRecord.employee_id == gaurav[0]))
            assert chk.scalar_one_or_none() is None
            print("✓ Confirmed: Failed check-in NEVER creates an attendance record.")

        # Cleanup: Reset Gaurav back to unenrolled so the real user can register on first login
        async with AsyncSessionLocal() as db:
            await db.execute(text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false WHERE id = :id"), {"id": gaurav[0]})
            await db.commit()
            print("✓ Reset test employee back to unenrolled state for fresh real-world onboarding.")

        print("\n>>> ALL REGISTRATION & BIOMETRIC LOCK TESTS PASSED! <<<")

if __name__ == "__main__":
    asyncio.run(test_registration_and_strict_lock())
