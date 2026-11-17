import sys, os
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import asyncio
from app.core.database import AsyncSessionLocal
from sqlalchemy import text

async def check():
    async with AsyncSessionLocal() as db:
        res = await db.execute(text("SELECT employee_code, full_name, (face_embedding IS NOT NULL), face_descriptor FROM employees WHERE employee_code = 'KSS2407013'"))
        r = res.fetchone()
        desc = r[3]
        print(f"{r[0]}: {r[1]} | has_emb={r[2]} | desc_len={len(desc) if desc else 0}")
        if desc and len(desc) >= 5:
            print("First 5 values of Akash descriptor:", desc[:5])

if __name__ == "__main__":
    asyncio.run(check())
