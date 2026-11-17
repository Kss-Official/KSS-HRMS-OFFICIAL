import asyncio
from app.core.database import AsyncSessionLocal
from sqlalchemy import text

async def check():
    async with AsyncSessionLocal() as session:
        res = await session.execute(text("SELECT employee_code, is_face_enrolled, face_descriptor, CAST(face_embedding AS text) FROM employees WHERE employee_code = 'KSS2407013'"))
        row = res.fetchone()
        print('Employee:', row[0])
        print('is_face_enrolled:', row[1])
        print('face_descriptor type:', type(row[2]), 'len:', len(row[2]) if row[2] else 0)
        print('face_embedding preview:', row[3][:50] if row[3] else None)

if __name__ == '__main__':
    asyncio.run(check())
