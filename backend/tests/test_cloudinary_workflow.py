"""
Test Suite: Cloudinary Photo Upload, Update, and Automatic Deletion Lifecycle
Verifies:
1. Cloudinary credentials & connectivity.
2. Initial employee photo upload to Cloudinary.
3. Photo update lifecycle: new photo uploads to Cloudinary, previous photo is automatically destroyed.
4. Clean teardown and verification.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
import httpx
from app.main import app
from app.core.cloudinary_service import (
    is_cloudinary_configured,
    upload_employee_photo,
    delete_cloudinary_image,
    extract_cloudinary_public_id
)
import cloudinary.api

import pytest

# 1x1 test image 1 (blue pixel)
BLUE_PIXEL_BASE64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkWPjfDwAE4QHs7c8l8AAAAABJRU5ErkJggg=="
# 1x1 test image 2 (red pixel)
RED_PIXEL_BASE64 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="

@pytest.mark.asyncio
async def test_cloudinary_lifecycle():
    print("======================================================================")
    print("STARTING CLOUDINARY PHOTO UPLOAD, UPDATE & PURGE LIFECYCLE AUDIT")
    print("======================================================================\n")

    # 1. Config & Ping Test
    assert is_cloudinary_configured(), "Cloudinary is not configured!"
    ping_res = cloudinary.api.ping()
    print(f"1. Cloudinary Ping: {ping_res} [PASS]")
    assert ping_res.get("status") == "ok"

    from app.core.security import create_access_token
    from app.core.database import AsyncSessionLocal
    from app.models.employee import Employee
    from sqlalchemy import select

    async with AsyncSessionLocal() as db:
        akash = (await db.execute(select(Employee).where(Employee.employee_code == "KSS2407013"))).scalar_one()
        token = create_access_token(str(akash.id))
        headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        # 2. Upload initial photo (Blue Pixel) for Akash SB
        print("\n2. Uploading Photo 1 (Initial Profile Photo)...")
        res1 = await client.post("/api/v1/employees/KSS2407013/photo", json={"photo_data": BLUE_PIXEL_BASE64}, headers=headers)
        print(f"   Upload 1 Status: [{res1.status_code}]")
        assert res1.status_code == 200
        photo1_url = res1.json().get("profile_photo_url")
        print(f"   Photo 1 URL: {photo1_url}")
        assert "res.cloudinary.com" in photo1_url
        public_id_1 = extract_cloudinary_public_id(photo1_url)
        print(f"   Photo 1 Public ID: {public_id_1}")
        assert public_id_1 is not None

        # Verify Photo 1 exists on Cloudinary
        resource_1 = cloudinary.api.resource(public_id_1)
        print(f"   Cloudinary Verified Resource 1: {resource_1.get('public_id')} exists [PASS]")
        assert resource_1.get("public_id") == public_id_1

        # 3. Upload replacement photo (Red Pixel) - should trigger auto-deletion of Photo 1
        print("\n3. Uploading Photo 2 (Updated Profile Photo) - Must Delete Photo 1...")
        res2 = await client.post("/api/v1/employees/KSS2407013/photo", json={"photo_data": RED_PIXEL_BASE64}, headers=headers)
        print(f"   Upload 2 Status: [{res2.status_code}]")
        assert res2.status_code == 200
        photo2_url = res2.json().get("profile_photo_url")
        print(f"   Photo 2 URL: {photo2_url}")
        assert "res.cloudinary.com" in photo2_url
        assert photo2_url != photo1_url, "Photo URL should have changed!"
        public_id_2 = extract_cloudinary_public_id(photo2_url)
        print(f"   Photo 2 Public ID: {public_id_2}")
        assert public_id_2 != public_id_1

        # Verify Photo 2 exists on Cloudinary
        resource_2 = cloudinary.api.resource(public_id_2)
        print(f"   Cloudinary Verified Resource 2: {resource_2.get('public_id')} exists [PASS]")
        assert resource_2.get("public_id") == public_id_2

        # Verify Photo 1 was deleted from Cloudinary
        print(f"\n4. Verifying Photo 1 was deleted from Cloudinary...")
        photo_1_deleted = False
        try:
            cloudinary.api.resource(public_id_1)
        except cloudinary.exceptions.NotFound:
            photo_1_deleted = True
            print(f"   Confirmed: Photo 1 ({public_id_1}) NOT FOUND in Cloudinary! Old photo successfully deleted [PASS]")

        assert photo_1_deleted, f"Old photo {public_id_1} should have been deleted from Cloudinary!"

        # 5. Clean up Photo 2 and restore Akash's real portrait
        print("\n5. Restoring Akash's real portrait to Cloudinary...")
        delete_cloudinary_image(photo2_url)

        # Upload Akash's real portrait from frontend/public/avatars/akash.jpg
        workspace_root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
        akash_img_path = os.path.join(workspace_root, "frontend", "public", "avatars", "akash.jpg")
        with open(akash_img_path, "rb") as f:
            akash_bytes = f.read()
        restore_res = upload_employee_photo(akash_bytes, "KSS2407013")
        restored_url = restore_res.get("secure_url")
        await client.post("/api/v1/employees/KSS2407013/photo", json={"photo_data": restored_url}, headers=headers)
        print(f"   Akash's Portrait Restored: {restored_url} [PASS]")

    print("\n======================================================================")
    print("ALL CLOUDINARY LIFECYCLE TESTS PASSED 100%!")
    print("Photo upload, update, and automatic old-asset deletion verified!")
    print("======================================================================")

if __name__ == "__main__":
    asyncio.run(test_cloudinary_lifecycle())
