"""
Cloudinary Image Storage Service for Kalpanaaa HRMS
Handles uploading, face-centered cropping/transformation, URL parsing,
and deletion/invalidation of employee portraits and profile photos.
"""

import os
import re
import time
import logging
import base64
from typing import Optional, Dict, Any, Union
import cloudinary
import cloudinary.uploader
import cloudinary.api
from app.core.config import settings

logger = logging.getLogger(__name__)

# Track configuration state
_is_configured = False

def init_cloudinary() -> bool:
    """Initialize Cloudinary client with credentials from app settings."""
    global _is_configured
    cloud_name = settings.CLOUDINARY_CLOUD_NAME
    api_key = settings.CLOUDINARY_API_KEY
    api_secret = settings.CLOUDINARY_API_SECRET
    cloudinary_url = settings.CLOUDINARY_URL

    if cloudinary_url:
        os.environ["CLOUDINARY_URL"] = cloudinary_url

    if cloud_name and api_key and api_secret:
        cloudinary.config(
            cloud_name=cloud_name,
            api_key=api_key,
            api_secret=api_secret,
            secure=True
        )
        _is_configured = True
        return True
    elif cloudinary_url:
        # Let cloudinary read from os.environ["CLOUDINARY_URL"]
        cloudinary.reset_config()
        if cloudinary.config().api_key:
            _is_configured = True
            return True

    logger.warning("[Cloudinary] Credentials not fully configured. Falling back to local storage.")
    _is_configured = False
    return False

def is_cloudinary_configured() -> bool:
    """Check if Cloudinary is ready to accept API calls."""
    global _is_configured
    if not _is_configured:
        return init_cloudinary()
    return True

def extract_cloudinary_public_id(url: str) -> Optional[str]:
    """
    Extract public_id from any Cloudinary URL, handling transformation chains
    and versioning prefixes.
    Example:
    https://res.cloudinary.com/abbfb8mn/image/upload/v1794911460/hrms/employees/emp_kss2407013_123.jpg
    -> hrms/employees/emp_kss2407013_123
    """
    if not url or "res.cloudinary.com" not in url:
        return None

    clean = url.split("?")[0]
    idx = clean.find("/upload/")
    if idx == -1:
        return None

    sub = clean[idx + len("/upload/"):]
    parts = sub.split("/")
    content_parts = []
    past_version = False

    for p in parts:
        if not past_version:
            if re.match(r"^v\d+$", p):
                past_version = True
                continue
            # Skip image transformation parts (e.g., c_fill,w_400,h_400,q_auto)
            elif "," in p or any(p.startswith(prefix) for prefix in ["c_", "w_", "h_", "q_", "f_", "r_", "e_", "g_", "dpr_"]):
                continue
        content_parts.append(p)

    if not content_parts:
        return None

    public_id_with_ext = "/".join(content_parts)
    public_id, _ = os.path.splitext(public_id_with_ext)
    return public_id

def upload_employee_photo(
    photo_data: Union[str, bytes],
    employee_code: str,
    folder: str = "hrms/employees"
) -> Dict[str, Any]:
    """
    Upload employee photo to Cloudinary with face-centered smart cropping.
    If Cloudinary is unconfigured or unavailable, safely falls back to local disk storage.
    """
    clean_code = re.sub(r"[^a-zA-Z0-9_-]", "_", employee_code.strip())
    timestamp = int(time.time() * 1000)
    public_id = f"emp_{clean_code}_{timestamp}"

    # 1. Attempt Cloudinary upload if configured
    if is_cloudinary_configured():
        try:
            logger.info(f"[Cloudinary] Uploading photo for employee {employee_code} to {folder}/{public_id}...")
            upload_result = cloudinary.uploader.upload(
                photo_data,
                folder=folder,
                public_id=public_id,
                overwrite=True,
                resource_type="image",
                transformation=[
                    {"width": 500, "height": 500, "crop": "fill", "gravity": "face"},
                    {"quality": "auto", "fetch_format": "auto"}
                ]
            )
            secure_url = upload_result.get("secure_url") or upload_result.get("url")
            logger.info(f"[Cloudinary] Successfully uploaded: {secure_url}")
            return {
                "secure_url": secure_url,
                "public_id": upload_result.get("public_id"),
                "width": upload_result.get("width"),
                "height": upload_result.get("height"),
                "format": upload_result.get("format"),
                "storage": "cloudinary"
            }
        except Exception as e:
            logger.error(f"[Cloudinary] Upload failed for {employee_code}: {e}. Falling back to local storage.")

    # 2. Local disk fallback
    return _save_photo_locally(photo_data, clean_code, timestamp)

def delete_cloudinary_image(url_or_public_id: str) -> bool:
    """
    Delete an image from Cloudinary by URL or public_id and invalidate CDN cache.
    """
    if not is_cloudinary_configured() or not url_or_public_id:
        return False

    public_id = url_or_public_id
    if "res.cloudinary.com" in url_or_public_id:
        extracted = extract_cloudinary_public_id(url_or_public_id)
        if not extracted:
            logger.warning(f"[Cloudinary] Could not extract public_id from URL: {url_or_public_id}")
            return False
        public_id = extracted

    try:
        logger.info(f"[Cloudinary] Destroying old image asset: {public_id}...")
        result = cloudinary.uploader.destroy(public_id, invalidate=True)
        status = result.get("result")
        logger.info(f"[Cloudinary] Destroy result for {public_id}: {status}")
        return status in ["ok", "not found"]
    except Exception as e:
        logger.error(f"[Cloudinary] Failed to delete asset {public_id}: {e}")
        return False

def cleanup_old_employee_photo(old_url: Optional[str]):
    """
    Clean up an existing employee photo when a new one is uploaded.
    Deletes from Cloudinary if hosted there, or deletes from local uploads/avatars/ if on disk.
    """
    if not old_url:
        return

    # A. If hosted on Cloudinary
    if "res.cloudinary.com" in old_url:
        delete_cloudinary_image(old_url)
        return

    # B. If local file in uploads/avatars/
    if old_url.startswith("/uploads/avatars/") or "uploads/avatars/" in old_url:
        clean_path = old_url.split("?")[0].lstrip("/")
        if os.path.exists(clean_path):
            try:
                os.remove(clean_path)
                logger.info(f"[Storage] Removed orphaned local avatar file: {clean_path}")
            except Exception as e:
                logger.warning(f"[Storage] Could not remove local file {clean_path}: {e}")

def _save_photo_locally(photo_data: Union[str, bytes], clean_code: str, timestamp: int) -> Dict[str, Any]:
    """Helper to save photo to local uploads/avatars/ as a fallback."""
    avatar_dir = os.path.join("uploads", "avatars")
    os.makedirs(avatar_dir, exist_ok=True)

    ext = "jpg"
    file_bytes: bytes

    if isinstance(photo_data, str) and photo_data.startswith("data:image/"):
        header, encoded = photo_data.split(",", 1)
        if "png" in header:
            ext = "png"
        elif "webp" in header:
            ext = "webp"
        file_bytes = base64.b64decode(encoded)
    elif isinstance(photo_data, bytes):
        file_bytes = photo_data
    else:
        # String data or URL fallback
        return {
            "secure_url": str(photo_data),
            "public_id": None,
            "storage": "external"
        }

    filename = f"{clean_code}_{timestamp}.{ext}"
    filepath = os.path.join(avatar_dir, filename)
    with open(filepath, "wb") as f:
        f.write(file_bytes)

    local_url = f"/uploads/avatars/{filename}?t={timestamp}"
    return {
        "secure_url": local_url,
        "public_id": None,
        "storage": "local"
    }

# Auto-initialize on module load
init_cloudinary()
