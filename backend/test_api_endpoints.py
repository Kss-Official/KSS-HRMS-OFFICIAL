import asyncio
import httpx
from app.main import app

async def test_fastapi():
    print("Testing FastAPI endpoints using httpx AsyncClient...")
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        # 1. Health check
        res = await client.get("/health")
        print(f"1. Health Check [{res.status_code}]: {res.json()}")
        assert res.status_code == 200

        # 2. OpenAPI schema
        res = await client.get("/api/v1/openapi.json")
        openapi = res.json()
        print(f"2. OpenAPI Schema [{res.status_code}]: Found {len(openapi.get('paths', {}))} endpoints")
        assert res.status_code == 200

        # Print all registered endpoints
        print("\nRegistered Endpoints:")
        for path, methods in openapi.get("paths", {}).items():
            for m in methods.keys():
                print(f" - {m.upper()} {path}")

        # 3. Biometric face verification endpoint
        test_descriptor = [0.0] * 128
        res = await client.post("/api/v1/attendance/verify-face", json={"face_descriptor": test_descriptor})
        print(f"\n3. Biometric Verification Test [{res.status_code}]: {res.json()}")
        assert res.status_code == 200

    print("\nALL FASTAPI INTEGRATION TESTS PASSED SUCCESSFULLY!")

if __name__ == "__main__":
    asyncio.run(test_fastapi())
