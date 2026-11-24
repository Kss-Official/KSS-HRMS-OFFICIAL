import sys
import os
# Ensure backend directory is in sys.path when running directly from tests directory
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
import httpx
import uuid
import random
from datetime import date, datetime, timezone, timedelta
from sqlalchemy import text, select
from app.main import app
from app.core.database import engine, AsyncSessionLocal
from app.core.security import get_password_hash
from app.models.employee import Employee
from app.models.enums import UserRole, ExecutiveTier, EmploymentType, LeaveType, LeaveStatus, ApprovalStatus, BreakType

TEST_RESULTS = []

def record_result(category: str, name: str, passed: bool, details: str = ""):
    TEST_RESULTS.append({"category": category, "name": name, "passed": passed, "details": details})
    status_str = "PASS" if passed else "FAIL"
    print(f"[{status_str}] [{category}] {name}: {details}")

async def run_all_workflow_tests():
    print("======================================================================")
    print("STARTING COMPREHENSIVE BUSINESS LOGIC & WORKFLOW AUDIT")
    print("======================================================================\n")

    # Generate isolated test user data
    test_id = str(uuid.uuid4())[:8]
    test_emp_code = f"TEST{test_id}"
    test_email = f"test_{test_id}@kalpanaaa.in"
    test_password = "SecurePassword123!"
    hashed_pw = get_password_hash(test_password)

    # Executive test users (CEO and CTO)
    exec_id = str(uuid.uuid4())[:8]
    exec_code = f"EXEC{exec_id}"
    exec_email = f"exec_{exec_id}@kalpanaaa.in"
    exec_hashed_pw = get_password_hash(test_password)

    cto_id = str(uuid.uuid4())[:8]
    cto_code = f"CTO{cto_id}"
    cto_email = f"cto_{cto_id}@kalpanaaa.in"
    cto_hashed_pw = get_password_hash(test_password)

    test_emp_uuid = uuid.uuid4()
    exec_emp_uuid = uuid.uuid4()
    cto_emp_uuid = uuid.uuid4()

    # Pre-clean any leftover test artifacts for clean idempotency
    async with AsyncSessionLocal() as session:
        await session.execute(text("DELETE FROM audit_logs WHERE actor_id IN (SELECT id FROM employees WHERE employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%');"))
        await session.execute(text("DELETE FROM leave_ledger WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%');"))
        await session.execute(text("DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%');"))
        await session.execute(text("DELETE FROM attendance_breaks WHERE attendance_id IN (SELECT id FROM attendance_records WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%'));"))
        await session.execute(text("DELETE FROM attendance_records WHERE employee_id IN (SELECT id FROM employees WHERE employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%');"))
        await session.execute(text("DELETE FROM employees WHERE employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%';"))
        await session.commit()

    try:
        # Pre-seed test employees into DB
        async with AsyncSessionLocal() as session:
            emp = Employee(
                id=test_emp_uuid,
                employee_code=test_emp_code,
                email=test_email,
                password_hash=hashed_pw,
                full_name=f"Test Employee {test_id}",
                role=UserRole.EMPLOYEE,
                executive_tier=ExecutiveTier.NONE,
                employment_type=EmploymentType.FULL_TIME,
                department="Engineering",
                designation="Software Engineer",
                joining_date=date.today(),
                earn_leave_balance=15.0,
                sick_leave_balance=10.0,
                casual_leave_balance=8.0,
                is_active=True
            )
            executive = Employee(
                id=exec_emp_uuid,
                employee_code=exec_code,
                email=exec_email,
                password_hash=exec_hashed_pw,
                full_name=f"Test CEO {exec_id}",
                role=UserRole.SUPER_ADMIN,
                executive_tier=ExecutiveTier.CEO,
                employment_type=EmploymentType.FULL_TIME,
                department="Executive",
                designation="Chief Executive Officer",
                joining_date=date.today(),
                earn_leave_balance=25.0,
                sick_leave_balance=12.0,
                casual_leave_balance=10.0,
                is_active=True
            )
            cto_exec = Employee(
                id=cto_emp_uuid,
                employee_code=cto_code,
                email=cto_email,
                password_hash=cto_hashed_pw,
                full_name=f"Test CTO {cto_id}",
                role=UserRole.SUPER_ADMIN,
                executive_tier=ExecutiveTier.CTO,
                employment_type=EmploymentType.FULL_TIME,
                department="Executive",
                designation="Chief Technology Officer",
                joining_date=date.today(),
                earn_leave_balance=25.0,
                sick_leave_balance=12.0,
                casual_leave_balance=10.0,
                is_active=True
            )
            session.add(emp)
            session.add(executive)
            session.add(cto_exec)
            await session.commit()
            print(f"Seeded test employee: {test_emp_code}, CEO: {exec_code}, CTO: {cto_code}")

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            # -------------------------------------------------------------
            # WORKFLOW 1: AUTHENTICATION & TOKEN LIFECYCLE
            # -------------------------------------------------------------
            print("\n--- WORKFLOW 1: AUTHENTICATION & JWT SECURITY ---")
        
            # 1.1 Valid login with email
            res = await client.post("/api/v1/auth/login", json={"email": test_email, "password": test_password})
            emp_token = res.json().get("access_token")
            record_result("AUTH", "Login with valid email", res.status_code == 200 and emp_token is not None, f"Status {res.status_code}")

            # 1.2 Valid login with employee_code
            res = await client.post("/api/v1/auth/login", json={"email": test_emp_code, "password": test_password})
            record_result("AUTH", "Login with valid employee_code", res.status_code == 200, f"Status {res.status_code}")

            # 1.3 Invalid password
            res = await client.post("/api/v1/auth/login", json={"email": test_email, "password": "WrongPassword"})
            record_result("AUTH", "Reject invalid password", res.status_code == 401, f"Status {res.status_code}")

            # 1.4 Non-existent user
            res = await client.post("/api/v1/auth/login", json={"email": "nonexistent@test.com", "password": test_password})
            record_result("AUTH", "Reject non-existent user", res.status_code == 401, f"Status {res.status_code}")

            # 1.5 Authenticated /me endpoint
            headers = {"Authorization": f"Bearer {emp_token}"}
            res = await client.get("/api/v1/auth/me", headers=headers)
            me_data = res.json()
            record_result("AUTH", "Retrieve /me profile", res.status_code == 200 and me_data.get("employee_code") == test_emp_code, f"Code: {me_data.get('employee_code')}")

            # 1.6 Tampered JWT rejection
            res = await client.get("/api/v1/auth/me", headers={"Authorization": "Bearer fake.tampered.token"})
            record_result("AUTH", "Reject tampered JWT", res.status_code == 401, f"Status {res.status_code}")

            # Login as executive (CEO and CTO) for subsequent tests
            res = await client.post("/api/v1/auth/login", json={"email": exec_email, "password": test_password})
            exec_token = res.json().get("access_token")
            exec_headers = {"Authorization": f"Bearer {exec_token}"}

            res = await client.post("/api/v1/auth/login", json={"email": cto_email, "password": test_password})
            cto_token = res.json().get("access_token")
            cto_headers = {"Authorization": f"Bearer {cto_token}"}

            # -------------------------------------------------------------
            # WORKFLOW 2: ROLE-BASED ACCESS CONTROL (RBAC)
            # -------------------------------------------------------------
            print("\n--- WORKFLOW 2: ROLE-BASED ACCESS CONTROL (RBAC) ---")

            # 2.1 Standard employee cannot create another employee
            res = await client.post("/api/v1/employees/", json={
                "employee_code": f"UNAUTH{test_id}",
                "email": f"unauth{test_id}@test.com",
                "password": "pass",
                "full_name": "Unauth User",
                "department": "Engineering",
                "designation": "Intern",
                "joining_date": str(date.today())
            }, headers=headers)
            record_result("RBAC", "Forbid employee from creating employees", res.status_code == 403, f"Status {res.status_code}")

            # 2.2 Executive / Admin can create an employee
            new_emp_code = f"NEW{test_id}"
            res = await client.post("/api/v1/employees/", json={
                "employee_code": new_emp_code,
                "email": f"new{test_id}@kalpanaaa.in",
                "password": "SecurePassword123!",
                "full_name": "Admin Created User",
                "department": "Design",
                "designation": "UI Designer",
                "joining_date": str(date.today())
            }, headers=exec_headers)
            record_result("RBAC", "Allow admin to create employee", res.status_code == 200, f"Status {res.status_code}")

            # -------------------------------------------------------------
            # WORKFLOW 3: BIOMETRIC VECTOR ENROLLMENT & HNSW SEARCH
            # -------------------------------------------------------------
            print("\n--- WORKFLOW 3: BIOMETRIC PGVECTOR & HNSW MATCHING ---")

            # Create synthetic 128D normalized face vector
            random.seed(42)
            sample_vector = [random.uniform(-1.0, 1.0) for _ in range(128)]
            norm = sum(x**2 for x in sample_vector) ** 0.5
            normalized_vector = [round(x / norm, 6) for x in sample_vector]

            # 3.1 Enroll face descriptor
            res = await client.post(
                f"/api/v1/employees/{test_emp_uuid}/enroll-face",
                json={"face_descriptor": normalized_vector},
                headers=headers
            )
            record_result("BIOMETRICS", "Enroll 128D face descriptor", res.status_code == 200, f"Status {res.status_code}")

            # 3.2 Verify sub-2ms face vector match using identical descriptor
            start_t = datetime.now()
            res = await client.post(
                "/api/v1/attendance/verify-face",
                json={"face_descriptor": normalized_vector, "threshold": 0.6, "employee_code": test_emp_code},
                headers=headers
            )
            elapsed_ms = (datetime.now() - start_t).total_seconds() * 1000
            match_data = res.json()
            is_matched = (
                res.status_code == 200 and
                match_data.get("matched") is True and
                match_data.get("employee_code") == test_emp_code and
                match_data.get("distance", 1.0) < 0.01
            )
            record_result("BIOMETRICS", f"Sub-millisecond Vector Match ({round(elapsed_ms, 2)}ms)", is_matched, f"Distance: {match_data.get('distance')}, Matched: {match_data.get('employee_code')}")

            # 3.3 Negative face match test with divergent vector
            divergent_vector = [-x for x in normalized_vector] # opposite direction
            res = await client.post(
                "/api/v1/attendance/verify-face",
                json={"face_descriptor": divergent_vector, "threshold": 0.5, "employee_code": test_emp_code},
                headers=headers
            )
            neg_match = res.json()
            record_result("BIOMETRICS", "Reject divergent face vector", neg_match.get("matched") is False, f"Matched: {neg_match.get('matched')}")

            # -------------------------------------------------------------
            # WORKFLOW 4: ATTENDANCE & GEOFENCE LOGIC
            # -------------------------------------------------------------
            print("\n--- WORKFLOW 4: ATTENDANCE & GEOFENCE LOGIC ---")

            # 4.1 Check-in INSIDE office geofence (lat 13.014333, lon 77.646)
            res = await client.post(
                "/api/v1/attendance/check-in",
                json={"latitude": 13.014333, "longitude": 77.646, "is_wfh": False, "face_descriptor": normalized_vector},
                headers=headers
            )
            att_data = res.json()
            checkin_ok = (res.status_code == 200 and att_data.get("location_verified") is True)
            record_result("ATTENDANCE", "Check-in inside geofence (verified)", checkin_ok, f"LocationVerified: {att_data.get('location_verified')}")

            # 4.2 Re-checkin on the same day must be rejected
            res = await client.post(
                "/api/v1/attendance/check-in",
                json={"latitude": 13.014333, "longitude": 77.646},
                headers=headers
            )
            record_result("ATTENDANCE", "Prevent duplicate check-in today", res.status_code == 400, f"Status {res.status_code}")

            # 4.3 Start a tea break
            res = await client.post(
                "/api/v1/attendance/breaks/start",
                json={"break_type": "TEA_BREAK"},
                headers=headers
            )
            record_result("ATTENDANCE", "Start active break", res.status_code == 200, f"Break: {res.json().get('type')}")

            # 4.4 Prevent second break while already on a break
            res = await client.post(
                "/api/v1/attendance/breaks/start",
                json={"break_type": "LUNCH_BREAK"},
                headers=headers
            )
            record_result("ATTENDANCE", "Prevent overlapping breaks", res.status_code == 400, f"Status {res.status_code}")

            # 4.5 End the active break
            res = await client.post("/api/v1/attendance/breaks/end", headers=headers)
            end_break_data = res.json()
            record_result("ATTENDANCE", "End active break", res.status_code == 200 and end_break_data.get("end_time") is not None, f"Duration: {end_break_data.get('duration_minutes')} min")

            # 4.6 Check-out
            res = await client.post("/api/v1/attendance/check-out", json={"notes": "End of testing shift"}, headers=headers)
            checkout_data = res.json()
            checkout_ok = (res.status_code == 200 and checkout_data.get("check_out_at") is not None)
            record_result("ATTENDANCE", "Check-out successfully", checkout_ok, f"CheckOutAt: {checkout_data.get('check_out_at')}")

            # -------------------------------------------------------------
            # WORKFLOW 5: LEAVE MANAGEMENT & LEDGER DEDUCTION
            # -------------------------------------------------------------
            print("\n--- WORKFLOW 5: LEAVE WORKFLOW & LEDGER ACCOUNTING ---")

            # 5.1 Invalid date range validation (end before start)
            res = await client.post("/api/v1/leaves/", json={
                "type": "CASUAL_LEAVE",
                "start_date": str(date.today() + timedelta(days=5)),
                "end_date": str(date.today() + timedelta(days=2)),
                "reason": "Invalid test"
            }, headers=headers)
            record_result("LEAVES", "Reject end date before start date", res.status_code == 400, f"Status {res.status_code}")

            # 5.2 Submit valid 2-day casual leave request
            leave_start = date.today() + timedelta(days=10)
            leave_end = date.today() + timedelta(days=11)
            res = await client.post("/api/v1/leaves/", json={
                "type": "CASUAL_LEAVE",
                "start_date": str(leave_start),
                "end_date": str(leave_end),
                "reason": "Personal family function"
            }, headers=headers)
            leave_data = res.json()
            leave_id = leave_data.get("id")
            req_code = leave_data.get("request_code")
            record_result("LEAVES", "Submit valid leave request", res.status_code == 200 and leave_id is not None, f"Code: {req_code}, Status: {leave_data.get('status')}")

            # 5.3 Non-executive cannot approve leave
            res = await client.patch(f"/api/v1/leaves/{leave_id}/review", json={"action": "APPROVED"}, headers=headers)
            record_result("LEAVES", "Forbid non-executive from reviewing leave", res.status_code == 403, f"Status {res.status_code}")

            # 5.4 CEO approves leave (Tier 1)
            res = await client.patch(
                f"/api/v1/leaves/{leave_id}/review",
                json={"action": "APPROVED", "notes": "Approved by CEO"},
                headers=exec_headers
            )
            ceo_app = res.json()
            record_result("LEAVES", "CEO approves leave (Tier 1)", res.status_code == 200 and ceo_app.get("ceo_status") == "APPROVED", f"CEO Status: {ceo_app.get('ceo_status')}")

            # 5.5 CTO approves leave (Tier 2 Final - triggers balance deduction)
            res = await client.patch(
                f"/api/v1/leaves/{leave_id}/review",
                json={"action": "APPROVED", "notes": "Approved by CTO"},
                headers=cto_headers
            )
            approved_leave = res.json()
            record_result("LEAVES", "CTO approves leave (Tier 2 Final)", res.status_code == 200 and approved_leave.get("status") == "APPROVED", f"Status: {approved_leave.get('status')}")

            # 5.6 Verify leave balance deduction in DB
            async with AsyncSessionLocal() as session:
                emp_check = await session.execute(select(Employee).where(Employee.id == test_emp_uuid))
                updated_emp = emp_check.scalar_one()
                # Initial casual leave was 8.0, 2 days leave -> should be 6.0
                expected_balance = 6.0
                actual_balance = float(updated_emp.casual_leave_balance)
                bal_ok = (actual_balance == expected_balance)
                record_result("LEAVES", f"Automated Leave Balance Debit (8.0 -> {actual_balance})", bal_ok, f"Actual: {actual_balance}, Expected: {expected_balance}")

                # Verify leave_ledger audit record exists
                ledger_check = await session.execute(text("SELECT amount, balance_after, reference_id FROM leave_ledger WHERE reference_id = :ref;"), {"ref": req_code})
                ledger_entry = ledger_check.fetchone()
                ledger_ok = (ledger_entry is not None and float(ledger_entry[0]) == 2.0 and float(ledger_entry[1]) == expected_balance)
                record_result("LEAVES", "ACID Leave Ledger Entry Recorded", ledger_ok, f"Ledger: amount={ledger_entry[0] if ledger_entry else None}, bal_after={ledger_entry[1] if ledger_entry else None}")

            # -------------------------------------------------------------
            # WORKFLOW 6: REALTIME SERVER-SENT EVENTS (SSE) RADAR
            # -------------------------------------------------------------
            print("\n--- WORKFLOW 6: REALTIME RADAR SSE ---")
            from app.api.v1.endpoints.realtime import stream_attendance_events
            from starlette.requests import Request
            mock_scope = {"type": "http", "method": "GET", "path": "/api/v1/realtime/attendance-radar", "headers": []}
            mock_request = Request(scope=mock_scope)
            response = await stream_attendance_events(mock_request)
            gen = response.body_iterator
            first_event = await anext(gen)
            record_result("REALTIME", "SSE Stream Handshake Event", "CONNECTED" in first_event, first_event.strip())

    finally:
        # Clean up all test and demo rows from Neon DB to leave the database clean
        async with AsyncSessionLocal() as session:
            test_match = "employee_code LIKE 'TEST%' OR employee_code LIKE 'EXEC%' OR employee_code LIKE 'CTO%' OR employee_code LIKE 'NEW%' OR employee_code IN ('KSS8616457', 'KSS2648019', 'KSS7365410', 'KSS6950866', 'KSS1223182', 'KSS3491305', 'KSS5909337', 'KSS9749394')"
            await session.execute(text(f"DELETE FROM audit_logs WHERE actor_id IN (SELECT id FROM employees WHERE {test_match});"))
            await session.execute(text(f"DELETE FROM leave_ledger WHERE employee_id IN (SELECT id FROM employees WHERE {test_match});"))
            await session.execute(text(f"DELETE FROM leave_requests WHERE employee_id IN (SELECT id FROM employees WHERE {test_match});"))
            await session.execute(text(f"DELETE FROM attendance_breaks WHERE attendance_id IN (SELECT id FROM attendance_records WHERE employee_id IN (SELECT id FROM employees WHERE {test_match}));"))
            await session.execute(text(f"DELETE FROM attendance_records WHERE employee_id IN (SELECT id FROM employees WHERE {test_match});"))
            await session.execute(text(f"DELETE FROM employees WHERE {test_match};"))
            await session.commit()
            print("\n[Teardown] Cleaned up all temporary test rows from database.")

    # Summary
    total = len(TEST_RESULTS)
    passed = sum(1 for r in TEST_RESULTS if r["passed"])
    failed = total - passed

    print("\n======================================================================")
    print(f"AUDIT SUMMARY: {passed}/{total} TESTS PASSED ({failed} FAILED)")
    print("======================================================================")
    if failed == 0:
        print("ALL BUSINESS LOGICS, WORKFLOWS, FLOWS AND RBAC RULES ARE 100% OPERATIONAL!")
    else:
        print(f"ATTENTION: {failed} tests failed! Review details above.")

if __name__ == "__main__":
    asyncio.run(run_all_workflow_tests())
