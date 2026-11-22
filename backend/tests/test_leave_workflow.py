import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import pytest
import asyncio

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
import uuid
from datetime import date, timedelta
from sqlalchemy import text, select, delete
from httpx import AsyncClient, ASGITransport

from app.main import app
from app.core.database import AsyncSessionLocal
from app.models.employee import Employee
from app.models.leave import LeaveRequest, LeaveLedger
from app.core.security import create_access_token
from app.models.enums import UserRole, ExecutiveTier, LeaveType, LeaveStatus, ApprovalStatus, LedgerTransactionType


@pytest.fixture(scope="session")
def event_loop():
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    loop = asyncio.get_event_loop_policy().new_event_loop()
    yield loop
    loop.close()


@pytest.mark.asyncio
async def test_leave_and_wfh_full_workflow():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        async with AsyncSessionLocal() as db:
            # 1. Fetch test regular employee (Asbin T S - KSS2407004)
            res_emp = await db.execute(text("SELECT id, employee_code, full_name, earn_leave_balance, sick_leave_balance FROM employees WHERE employee_code = 'KSS2407004'"))
            emp = res_emp.fetchone()
            assert emp is not None, "KSS2407004 must exist"
            emp_id = emp[0]
            orig_el = float(emp[3] or 1.0)
            orig_sl = float(emp[4] or 1.0)

            # Ensure employee has 10 Earn Leave and 5 Sick Leave balance for testing
            await db.execute(text("UPDATE employees SET earn_leave_balance = 10.0, sick_leave_balance = 5.0 WHERE id = :id"), {"id": emp_id})

            # Fetch or ensure CEO and CTO test accounts exist
            res_ceo = await db.execute(select(Employee).where(Employee.executive_tier == ExecutiveTier.CEO))
            ceo = res_ceo.scalars().first()
            if not ceo:
                # Assign CEO tier to KSS2407002
                await db.execute(text("UPDATE employees SET executive_tier = 'CEO', role = 'SUPER_ADMIN' WHERE employee_code = 'KSS2407002'"))
                res_ceo = await db.execute(select(Employee).where(Employee.employee_code == 'KSS2407002'))
                ceo = res_ceo.scalars().first()

            # CTO: KSS2407001 or executive_tier = CTO
            res_cto = await db.execute(select(Employee).where(Employee.executive_tier == ExecutiveTier.CTO))
            cto = res_cto.scalars().first()
            if not cto:
                # Assign CTO tier to KSS2407001
                await db.execute(text("UPDATE employees SET executive_tier = 'CTO', role = 'SUPER_ADMIN' WHERE employee_code = 'KSS2407001'"))
                res_cto = await db.execute(select(Employee).where(Employee.employee_code == 'KSS2407001'))
                cto = res_cto.scalars().first()

            # Clean up existing test leaves for this employee for future dates
            future_start = date.today() + timedelta(days=60)
            await db.execute(delete(LeaveRequest).where(LeaveRequest.employee_id == emp_id, LeaveRequest.start_date >= future_start))
            await db.commit()

        token_emp = create_access_token(subject=str(emp_id))
        token_ceo = create_access_token(subject=str(ceo.id))
        token_cto = create_access_token(subject=str(cto.id))

        headers_emp = {"Authorization": f"Bearer {token_emp}"}
        headers_ceo = {"Authorization": f"Bearer {token_ceo}"}
        headers_cto = {"Authorization": f"Bearer {token_cto}"}

        # ══════════════════════════════════════════════════════════
        # TEST 1: Submit Leave Request with insufficient balance -> 400
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 1: Insufficient Balance Rejection ---")
        d1 = date.today() + timedelta(days=60)
        d2 = date.today() + timedelta(days=75) # 16 days requested > 10 available
        resp_insufficient = await client.post(
            "/api/v1/leaves/",
            headers=headers_emp,
            json={
                "type": "EARN_LEAVE",
                "start_date": str(d1),
                "end_date": str(d2),
                "reason": "Family vacation"
            }
        )
        print("Status:", resp_insufficient.status_code, resp_insufficient.json())
        assert resp_insufficient.status_code == 400
        assert "Insufficient Earn Leave balance" in resp_insufficient.json()["detail"]

        # ══════════════════════════════════════════════════════════
        # TEST 2: Successful Leave Submission (Earn Leave - 2 days)
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 2: Legitimate Leave Submission ---")
        leave_start = date.today() + timedelta(days=60)
        leave_end = date.today() + timedelta(days=61) # 2 days
        custom_code = f"LR_TEST_{uuid.uuid4().hex[:6]}"
        resp_submit = await client.post(
            "/api/v1/leaves/",
            headers=headers_emp,
            json={
                "type": "EARN_LEAVE",
                "start_date": str(leave_start),
                "end_date": str(leave_end),
                "reason": "Personal work",
                "request_code": custom_code
            }
        )
        print("Status:", resp_submit.status_code, resp_submit.json())
        assert resp_submit.status_code == 200
        created_leave = resp_submit.json()
        leave_id = created_leave["id"]
        assert created_leave["status"] == "PENDING"
        assert created_leave["ceo_status"] == "PENDING"
        assert created_leave["cto_status"] == "WAITING_CEO"
        assert created_leave["request_code"] == custom_code

        # ══════════════════════════════════════════════════════════
        # TEST 3: Duplicate / Overlapping Date Rejection -> 400
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 3: Overlapping Date Range Rejection ---")
        resp_overlap = await client.post(
            "/api/v1/leaves/",
            headers=headers_emp,
            json={
                "type": "SICK_LEAVE",
                "start_date": str(leave_start),
                "end_date": str(leave_end),
                "reason": "Doctor appointment"
            }
        )
        print("Status:", resp_overlap.status_code, resp_overlap.json())
        assert resp_overlap.status_code == 400
        assert "overlapping" in resp_overlap.json()["detail"].lower()

        # ══════════════════════════════════════════════════════════
        # TEST 4: CTO cannot review before CEO approves -> 400
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 4: CTO Review Out of Order Rejection ---")
        resp_cto_early = await client.patch(
            f"/api/v1/leaves/{custom_code}/review",
            headers=headers_cto,
            json={"action": "APPROVED", "notes": "Approved early"}
        )
        print("Status:", resp_cto_early.status_code, resp_cto_early.json())
        assert resp_cto_early.status_code == 400
        assert "CTO cannot review leave before CEO has approved" in resp_cto_early.json()["detail"]

        # ══════════════════════════════════════════════════════════
        # TEST 5: CEO Approves -> Tier 1 Approved, CTO Unblocked, Overall Status PENDING
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 5: CEO Review Approval (Tier 1) ---")
        resp_ceo = await client.patch(
            f"/api/v1/leaves/{custom_code}/review",
            headers=headers_ceo,
            json={"action": "APPROVED", "notes": "Approved by CEO"}
        )
        print("Status:", resp_ceo.status_code, resp_ceo.json())
        assert resp_ceo.status_code == 200
        ceo_reviewed = resp_ceo.json()
        assert ceo_reviewed["ceo_status"] == "APPROVED"
        assert ceo_reviewed["cto_status"] == "PENDING"
        assert ceo_reviewed["status"] == "PENDING", "Overall status must remain PENDING until CTO approves!"

        # ══════════════════════════════════════════════════════════
        # TEST 6: CTO Approves -> Tier 2 Approved, Overall Status APPROVED, Balance Deducted
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 6: CTO Review Approval (Tier 2 Final) ---")
        resp_cto = await client.patch(
            f"/api/v1/leaves/{custom_code}/review",
            headers=headers_cto,
            json={"action": "APPROVED", "notes": "Approved by CTO"}
        )
        print("Status:", resp_cto.status_code, resp_cto.json())
        assert resp_cto.status_code == 200
        cto_reviewed = resp_cto.json()
        assert cto_reviewed["ceo_status"] == "APPROVED"
        assert cto_reviewed["cto_status"] == "APPROVED"
        assert cto_reviewed["status"] == "APPROVED"

        # Verify balance deduction in DB
        async with AsyncSessionLocal() as db:
            bal_res = await db.execute(text("SELECT earn_leave_balance FROM employees WHERE id = :id"), {"id": emp_id})
            bal = float(bal_res.scalar())
            assert bal == 8.0, f"Balance must be deducted by 2 days (10 -> 8), got {bal}"

            # Verify ledger debit entry
            ledger_res = await db.execute(select(LeaveLedger).where(LeaveLedger.reference_id == custom_code))
            ledger = ledger_res.scalar_one_or_none()
            assert ledger is not None, "Ledger entry must be recorded"
            assert ledger.transaction_type == LedgerTransactionType.APPROVED_DEBIT
            assert float(ledger.amount) == 2.0

        # ══════════════════════════════════════════════════════════
        # TEST 7: Cancellation of Approved Leave -> Status CANCELLED, Balance Restored
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 7: Cancellation & Automatic Balance Restoration ---")
        resp_cancel = await client.patch(
            f"/api/v1/leaves/{custom_code}/cancel",
            headers=headers_emp
        )
        print("Status:", resp_cancel.status_code, resp_cancel.json())
        assert resp_cancel.status_code == 200
        cancelled = resp_cancel.json()
        assert cancelled["status"] == "CANCELLED"

        # Verify balance is restored in DB
        async with AsyncSessionLocal() as db:
            bal_res2 = await db.execute(text("SELECT earn_leave_balance FROM employees WHERE id = :id"), {"id": emp_id})
            bal2 = float(bal_res2.scalar())
            assert bal2 == 10.0, f"Balance must be restored back to 10 days, got {bal2}"

            # Verify reversal credit ledger entry
            reversal_res = await db.execute(
                select(LeaveLedger).where(
                    LeaveLedger.reference_id == custom_code,
                    LeaveLedger.transaction_type == LedgerTransactionType.REVERSAL_CREDIT
                )
            )
            reversal = reversal_res.scalar_one_or_none()
            assert reversal is not None, "Reversal ledger credit must be recorded"
            assert float(reversal.amount) == 2.0

        # ══════════════════════════════════════════════════════════
        # TEST 8: WFH Request Submission & Full Approval
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 8: WFH Request Full Workflow ---")
        wfh_date = date.today() + timedelta(days=70)
        wfh_code = f"WFH_TEST_{uuid.uuid4().hex[:6]}"
        resp_wfh = await client.post(
            "/api/v1/leaves/",
            headers=headers_emp,
            json={
                "type": "WFH",
                "start_date": str(wfh_date),
                "end_date": str(wfh_date),
                "reason": "Remote development work",
                "request_code": wfh_code
            }
        )
        print("Status:", resp_wfh.status_code, resp_wfh.json())
        assert resp_wfh.status_code == 200
        assert resp_wfh.json()["type"] == "WFH"

        # CEO approves WFH
        await client.patch(f"/api/v1/leaves/{wfh_code}/review", headers=headers_ceo, json={"action": "APPROVED"})
        # CTO approves WFH
        resp_wfh_cto = await client.patch(f"/api/v1/leaves/{wfh_code}/review", headers=headers_cto, json={"action": "APPROVED"})
        assert resp_wfh_cto.status_code == 200
        assert resp_wfh_cto.json()["status"] == "APPROVED"

        # ══════════════════════════════════════════════════════════
        # TEST 9: Loss of Pay (LOP) Submission - No Balance Needed
        # ══════════════════════════════════════════════════════════
        print("\n--- TEST 9: Loss of Pay (LOP) Submission ---")
        lop_date = date.today() + timedelta(days=80)
        lop_code = f"LOP_TEST_{uuid.uuid4().hex[:6]}"
        resp_lop = await client.post(
            "/api/v1/leaves/",
            headers=headers_emp,
            json={
                "type": "LOSS_OF_PAY",
                "start_date": str(lop_date),
                "end_date": str(lop_date),
                "reason": "Personal urgency",
                "request_code": lop_code
            }
        )
        print("Status:", resp_lop.status_code, resp_lop.json())
        assert resp_lop.status_code == 200
        assert resp_lop.json()["type"] == "LOSS_OF_PAY"

        # Clean up test leaves and restore real employee balances
        async with AsyncSessionLocal() as db:
            await db.execute(delete(LeaveLedger).where(LeaveLedger.reference_id.in_([custom_code, wfh_code, lop_code])))
            await db.execute(delete(LeaveRequest).where(LeaveRequest.request_code.in_([custom_code, wfh_code, lop_code])))
            await db.execute(text("UPDATE employees SET earn_leave_balance = :el, sick_leave_balance = :sl WHERE id = :id"), {"el": orig_el, "sl": orig_sl, "id": emp_id})
            await db.commit()

        print("\n>>> ALL LEAVE & WFH WORKFLOW TESTS PASSED PERFECTLY! <<<")


if __name__ == "__main__":
    asyncio.run(test_leave_and_wfh_full_workflow())
