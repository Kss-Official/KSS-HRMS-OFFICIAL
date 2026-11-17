import asyncio
import numpy as np
import httpx
from app.main import app
from app.core.database import AsyncSessionLocal
from app.models.employee import Employee
from app.models.attendance import AttendanceRecord
from sqlalchemy import select, text

def generate_face_descriptor(seed: int) -> list[float]:
    rng = np.random.RandomState(seed)
    vec = rng.randn(128)
    vec = vec / np.linalg.norm(vec)
    return [round(float(x), 6) for x in vec]

async def run_tests():
    print("======================================================================")
    print("STARTING BIOMETRIC FACE REGISTRATION & CHECK-IN WORKFLOW VERIFICATION")
    print("======================================================================")

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        # Step 1: Ensure Fresh Registration state (reset to 0 enrolled)
        async with AsyncSessionLocal() as session:
            await session.execute(text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false"))
            await session.commit()
            count_res = await session.execute(text("SELECT count(*) FROM employees WHERE is_face_enrolled = true"))
            enrolled_count = count_res.scalar()
            print(f"Step 1: Enrolled count in database after reset: {enrolled_count}")
            assert enrolled_count == 0, f"Expected 0 enrolled employees, found {enrolled_count}"
            print("  ✓ PASSED: System is completely fresh. No employees are currently registered.")

            # Get 2 real employees for testing: Akash SB and Gaurav Kumar Tripathi
            akash = (await session.execute(select(Employee).where(Employee.employee_code == 'KSS2407013'))).scalar_one()
            gaurav = (await session.execute(select(Employee).where(Employee.employee_code == 'KSS2407001'))).scalar_one()

            # Clean today's attendance for these 2 employees so we can test clean check-in
            await session.execute(text("DELETE FROM attendance_breaks WHERE attendance_id IN (SELECT id FROM attendance_records WHERE employee_id IN (:e1, :e2) AND date = CURRENT_DATE)"), {"e1": akash.id, "e2": gaurav.id})
            await session.execute(text("DELETE FROM attendance_records WHERE employee_id IN (:e1, :e2) AND date = CURRENT_DATE"), {"e1": akash.id, "e2": gaurav.id})
            await session.commit()

        # Step 2: Unenrolled face check-in attempt
        # Generating face descriptors
        face_akash = generate_face_descriptor(seed=101)
        face_gaurav = generate_face_descriptor(seed=202)

        # Login as Akash
        res = await client.post("/api/v1/auth/login", json={"email": akash.email, "password": "SecurePassword123!"})
        if res.status_code != 200:
            # Try default pass
            res = await client.post("/api/v1/auth/login", json={"email": akash.email, "password": "Password@123"})
        if res.status_code != 200:
            res = await client.post("/api/v1/auth/login", json={"employee_code": "KSS2407013", "password": "Password@123"})
        
        # If password hash is different, let's create a temporary token directly
        from app.core.security import create_access_token
        akash_token = create_access_token(akash.id)
        gaurav_token = create_access_token(gaurav.id)
        print("  ✓ Generated JWT session tokens for Akash and Gaurav")

        # Attempt check-in without enrollment -> Must be blocked
        res = await client.post(
            "/api/v1/attendance/check-in",
            headers={"Authorization": f"Bearer {akash_token}"},
            json={"employee_code": "KSS2407013", "face_descriptor": face_akash}
        )
        print(f"Step 2: Unenrolled check-in status: {res.status_code}, response: {res.json()}")
        assert res.status_code == 400, "Unenrolled employee check-in must fail with 400"
        assert "Please register your face first" in res.json().get("detail", "")
        print("  ✓ PASSED: Unenrolled employee correctly blocked from biometric check-in.")

        # Step 3: Register / Enroll Akash's face
        res = await client.post(
            f"/api/v1/employees/{akash.id}/enroll-face",
            headers={"Authorization": f"Bearer {akash_token}"},
            json={"face_descriptor": face_akash}
        )
        print(f"Step 3: Face enrollment status: {res.status_code}, message: {res.json().get('message')}")
        assert res.status_code == 200, "Face enrollment failed"
        assert res.json().get("employee_code") == "KSS2407013"
        print("  ✓ PASSED: Akash's biometric face successfully registered to his account.")

        # Step 4: Verify Akash's face against his own profile (Targeted 1:1 match)
        res = await client.post(
            "/api/v1/attendance/verify-face",
            json={"face_descriptor": face_akash, "threshold": 0.45, "employee_code": "KSS2407013"}
        )
        data = res.json()
        print(f"Step 4: Self face verification: matched={data.get('matched')}, distance={data.get('distance')}, confidence={data.get('confidence')}")
        assert data.get("matched") is True, "Akash face must match his own profile"
        assert data.get("distance") <= 0.01, f"Distance should be ~0, got {data.get('distance')}"
        print("  ✓ PASSED: Accurate 1:1 face matching confirmed for own profile.")

        # Step 5: Verify cross-employee rejection: Akash's face tested against Gaurav
        res = await client.post(
            "/api/v1/attendance/verify-face",
            json={"face_descriptor": face_akash, "threshold": 0.45, "employee_code": "KSS2407001"}
        )
        data = res.json()
        print(f"Step 5: Akash face tested against Gaurav profile: matched={data.get('matched')}, message={data.get('message')}")
        assert data.get("matched") is False, "Cross-employee face match must be rejected"
        print("  ✓ PASSED: Cross-employee face matching correctly rejected.")

        # Step 6: Enroll Gaurav's face with distinct face descriptor
        res = await client.post(
            f"/api/v1/employees/{gaurav.id}/enroll-face",
            headers={"Authorization": f"Bearer {gaurav_token}"},
            json={"face_descriptor": face_gaurav}
        )
        assert res.status_code == 200
        print("  ✓ PASSED: Gaurav's biometric face successfully registered to his account.")

        # Step 7: Attempt check-in for Gaurav using Akash's face -> MUST FAIL with 400
        res = await client.post(
            "/api/v1/attendance/check-in",
            headers={"Authorization": f"Bearer {gaurav_token}"},
            json={"employee_code": "KSS2407001", "face_descriptor": face_akash}
        )
        print(f"Step 7: Impostor check-in attempt status: {res.status_code}, error: {res.json().get('detail')}")
        assert res.status_code == 400, "Impostor check-in must fail with 400"
        assert "Biometric mismatch" in res.json().get("detail", "")
        print("  ✓ PASSED: One employee CANNOT check in using another employee's face.")

        # Step 8: Genuine Check-in: Akash checking in with his own registered face
        res = await client.post(
            "/api/v1/attendance/check-in",
            headers={"Authorization": f"Bearer {akash_token}"},
            json={"employee_code": "KSS2407013", "face_descriptor": face_akash, "latitude": 13.014333, "longitude": 77.646000}
        )
        print(f"Step 8: Genuine check-in status: {res.status_code}, method: {res.json().get('attendance_method')}")
        assert res.status_code == 200, f"Check-in failed: {res.text}"
        assert res.json().get("attendance_method") == "BIOMETRIC_FACE", f"Expected BIOMETRIC_FACE, got {res.json().get('attendance_method')}"
        print("  ✓ PASSED: Immediate check-in recorded with BIOMETRIC_FACE.")

        # Step 9: Duplicate check-in attempt -> MUST FAIL
        res = await client.post(
            "/api/v1/attendance/check-in",
            headers={"Authorization": f"Bearer {akash_token}"},
            json={"employee_code": "KSS2407013", "face_descriptor": face_akash}
        )
        assert res.status_code == 400
        assert "already checked in today" in res.json().get("detail", "")
        print("  ✓ PASSED: Duplicate check-in correctly rejected.")

        # Step 10: Reset all face biometrics fresh as final state for real user onboarding
        async with AsyncSessionLocal() as session:
            await session.execute(text("DELETE FROM attendance_breaks WHERE attendance_id IN (SELECT id FROM attendance_records WHERE employee_id IN (:e1, :e2) AND date = CURRENT_DATE)"), {"e1": akash.id, "e2": gaurav.id})
            await session.execute(text("DELETE FROM attendance_records WHERE employee_id IN (:e1, :e2) AND date = CURRENT_DATE"), {"e1": akash.id, "e2": gaurav.id})
            await session.execute(text("UPDATE employees SET face_descriptor = NULL, face_embedding = NULL, is_face_enrolled = false"))
            await session.commit()
            print("Step 10: Reset face registrations in PostgreSQL to fresh state.")

    print("\n======================================================================")
    print("ALL 10 BIOMETRIC WORKFLOW TESTS COMPLETED SUCCESSFULLY (100% PASSED)")
    print("======================================================================")

if __name__ == '__main__':
    asyncio.run(run_tests())
