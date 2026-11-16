import asyncio
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine
from app.core.config import settings
from app.models import Base

async def init_neon_database():
    print("Connecting to Neon direct endpoint for DDL initialization...")
    unpooled_url = settings.DATABASE_URL_UNPOOLED or settings.DATABASE_URL
    admin_engine = create_async_engine(unpooled_url, echo=True)
    
    try:
        async with admin_engine.connect() as conn:
            # 1. Enable vector extension
            print("Enabling vector extension...")
            await conn.execute(text("CREATE EXTENSION IF NOT EXISTS vector;"))
            await conn.commit()
            print("pgvector extension confirmed.")

            # 2. Create all tables
            print("Creating relational tables...")
            await conn.run_sync(Base.metadata.create_all)
            await conn.commit()
            print("Tables created successfully.")

            # 3. Create HNSW index for sub-2ms biometric vector matching
            print("Creating HNSW index for biometric search...")
            await conn.execute(text("""
                CREATE INDEX IF NOT EXISTS idx_face_hnsw 
                ON employees 
                USING hnsw (face_embedding vector_l2_ops);
            """))
            await conn.commit()
            print("HNSW index created successfully!")

            # 4. List all created tables
            res = await conn.execute(text("""
                SELECT table_name 
                FROM information_schema.tables 
                WHERE table_schema = 'public';
            """))
            tables = [row[0] for row in res.fetchall()]
            print(f"Active tables in Neon DB: {tables}")

    except Exception as e:
        print(f"Error during DDL initialization: {e}")
        raise e
    finally:
        await admin_engine.dispose()

if __name__ == "__main__":
    asyncio.run(init_neon_database())
