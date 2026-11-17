import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import asyncio
from app.core.database import AsyncSessionLocal
from sqlalchemy import text

async def reset_other_employees():
    async with AsyncSessionLocal() as db:
        # Check current status
        res = await db.execute(text("SELECT id, employee_code, full_name, is_face_enrolled FROM employees WHERE is_active = true ORDER BY employee_code"))
        rows = res.fetchall()
        print(f"Total employees: {len(rows)}")

        # Clear synthetic biometrics for all employees EXCEPT Akash SB (KSS2407013)
        result = await db.execute(
            text("""
                UPDATE employees 
                SET face_descriptor = NULL,
                    face_embedding = NULL,
                    is_face_enrolled = false
                WHERE employee_code != 'KSS2407013'
            """)
        )
        await db.commit()
        print(f"Reset face enrollment for other employees. Rows affected: {result.rowcount}")

        # Verify
        verify_res = await db.execute(text("SELECT employee_code, full_name, is_face_enrolled, (face_embedding IS NOT NULL) FROM employees WHERE is_active = true ORDER BY employee_code"))
        print("\n--- Current Enrollment Status ---")
        for r in verify_res.fetchall():
            print(f"{r[0]}: {r[1]} | is_face_enrolled={r[2]} | has_embedding={r[3]}")

if __name__ == "__main__":
    asyncio.run(reset_other_employees())
