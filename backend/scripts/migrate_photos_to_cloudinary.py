"""
Migration Script: Upload All Employee Photos to Cloudinary
Reads all employee records in Neon PostgreSQL, finds their local avatar images,
uploads them to Cloudinary (hrms/employees/emp_<employee_code>), and saves the
live Cloudinary secure URL back into the PostgreSQL database.
"""

import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import asyncio
from sqlalchemy import select
from app.core.database import AsyncSessionLocal
from app.models.employee import Employee
from app.core.cloudinary_service import upload_employee_photo, is_cloudinary_configured

# Path to frontend public directory where static avatars reside
WORKSPACE_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
FRONTEND_PUBLIC = os.path.join(WORKSPACE_ROOT, "frontend", "public")
BACKEND_UPLOADS = os.path.join(WORKSPACE_ROOT, "backend", "uploads")

async def migrate_all_photos():
    print("======================================================================")
    print("STARTING BULK EMPLOYEE PHOTO MIGRATION TO CLOUDINARY")
    print("======================================================================\n")

    if not is_cloudinary_configured():
        print("ERROR: Cloudinary is not configured. Please check your credentials in .env")
        return

    async with AsyncSessionLocal() as session:
        result = await session.execute(select(Employee).order_by(Employee.employee_code))
        employees = result.scalars().all()
        print(f"Found {len(employees)} employees in PostgreSQL database.\n")

        migrated_count = 0
        already_migrated_count = 0
        skipped_count = 0

        for emp in employees:
            curr_url = emp.profile_photo_url
            emp_code = emp.employee_code
            full_name = emp.full_name

            # Skip if already hosted on Cloudinary
            if curr_url and "res.cloudinary.com" in curr_url:
                print(f"[ALREADY CLOUDINARY] {emp_code} ({full_name}) -> {curr_url[:60]}...")
                already_migrated_count += 1
                continue

            image_source = None

            # 1. Check if local path like /avatars/akash.jpg
            if curr_url and curr_url.startswith("/avatars/"):
                rel_path = curr_url.lstrip("/")
                candidate = os.path.join(FRONTEND_PUBLIC, rel_path)
                if os.path.exists(candidate):
                    with open(candidate, "rb") as f:
                        image_source = f.read()

            # 2. Check if in backend/uploads/avatars
            elif curr_url and ("/uploads/avatars/" in curr_url or curr_url.startswith("uploads/avatars/")):
                clean_rel = curr_url.split("?")[0].lstrip("/")
                candidate = os.path.join(WORKSPACE_ROOT, "backend", clean_rel)
                if os.path.exists(candidate):
                    with open(candidate, "rb") as f:
                        image_source = f.read()

            # 3. Check if remote URL (e.g., Unsplash)
            elif curr_url and curr_url.startswith("http"):
                image_source = curr_url

            # 4. Fallback check by standard naming in frontend/public/avatars/
            if not image_source:
                first_name = full_name.split()[0].lower()
                for ext in [".jpg", ".jpeg", ".png"]:
                    candidate = os.path.join(FRONTEND_PUBLIC, "avatars", f"{first_name}{ext}")
                    if os.path.exists(candidate):
                        with open(candidate, "rb") as f:
                            image_source = f.read()
                        break

            if image_source:
                try:
                    upload_res = upload_employee_photo(image_source, emp_code)
                    secure_url = upload_res.get("secure_url")
                    if secure_url and "res.cloudinary.com" in secure_url:
                        emp.profile_photo_url = secure_url
                        print(f"[MIGRATED] {emp_code} ({full_name}):")
                        print(f"   Old: {curr_url}")
                        print(f"   New: {secure_url}\n")
                        migrated_count += 1
                    else:
                        print(f"[FAILED] Could not get secure_url for {emp_code} ({full_name})\n")
                        skipped_count += 1
                except Exception as ex:
                    print(f"[ERROR] Exception uploading photo for {emp_code}: {ex}\n")
                    skipped_count += 1
            else:
                print(f"[NO PHOTO] {emp_code} ({full_name}) has no local photo file. Skipped.\n")
                skipped_count += 1

        await session.commit()

        print("======================================================================")
        print(f"MIGRATION COMPLETE:")
        print(f"  - Newly Migrated:    {migrated_count}")
        print(f"  - Already Stored:    {already_migrated_count}")
        print(f"  - Skipped/No Source: {skipped_count}")
        print(f"  - Total Processed:   {len(employees)}")
        print("======================================================================")

if __name__ == "__main__":
    asyncio.run(migrate_all_photos())
