import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
from sqlalchemy import text
from app.core.database import engine

async def test_neon_connection():
    print("Testing connection to Neon PostgreSQL...")
    try:
        async with engine.connect() as conn:
            result = await conn.execute(text("SELECT version();"))
            row = result.fetchone()
            print(f"SUCCESS! Connected to Neon DB.")
            print(f"PostgreSQL version: {row[0]}")
            
            # Check vector extension
            ext_result = await conn.execute(text("SELECT extname FROM pg_extension WHERE extname = 'vector';"))
            ext = ext_result.fetchone()
            if ext:
                print("pgvector extension is INSTALLED and ACTIVE in Neon DB.")
            else:
                print("pgvector extension is not installed yet. You can enable it with: CREATE EXTENSION vector;")
    except Exception as e:
        print(f"Connection failed: {e}")
    finally:
        await engine.dispose()

if __name__ == "__main__":
    asyncio.run(test_neon_connection())
