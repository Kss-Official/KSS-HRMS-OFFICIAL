"""
Backward-compatibility forwarder.
The database DDL initialization script has moved to scripts/init_db.py.
"""
import asyncio
from scripts.init_db import init_neon_database

if __name__ == "__main__":
    asyncio.run(init_neon_database())
