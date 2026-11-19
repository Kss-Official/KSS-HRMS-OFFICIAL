"""Security-hardening regression tests (NON-DESTRUCTIVE).

Safe to run against the live Neon DB: every HTTP call here is either anonymous (rejected before any DB
access), uses a forged/refresh token (rejected), or uses bogus credentials (SELECT only, no write path).
Run:  cd backend && python -m pytest tests/test_security_hardening.py -q
"""
import asyncio
import math
import os
import sys
import uuid

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import httpx
import pytest
from fastapi import HTTPException

from app.main import app
from app.core.security import (
    create_access_token, create_refresh_token, is_hashed, validate_new_password,
    verify_legacy_plaintext, verify_password, get_password_hash,
)
from app.api.v1.endpoints.employees import validate_descriptor, view_for, validate_photo_url
from app.schemas.employee import EmployeeOut
from app.models.enums import UserRole, EmploymentType, ExecutiveTier
from datetime import date, datetime, timezone

API = "/api/v1"
FAKE_ID = str(uuid.uuid4())

# Every protected data endpoint must reject anonymous callers.
ANON_ENDPOINTS = [
    ("GET", "/employees/"), ("GET", f"/employees/{FAKE_ID}"), ("PATCH", f"/employees/{FAKE_ID}"),
    ("POST", f"/employees/{FAKE_ID}/photo"), ("DELETE", f"/employees/{FAKE_ID}"), ("POST", "/employees/"),
    ("POST", "/employees/reset-all-faces"), ("POST", f"/employees/{FAKE_ID}/enroll-face"),
    ("GET", "/attendance/records"), ("POST", "/attendance/check-in"),
    ("POST", "/attendance/check-out"), ("GET", "/leaves/"), ("POST", "/leaves/"),
    ("PATCH", f"/leaves/{FAKE_ID}/review"), ("PATCH", f"/leaves/{FAKE_ID}/cancel"),
    ("GET", "/settings/"), ("PUT", "/settings/"), ("GET", "/audit/"), ("POST", "/audit/"),
    ("GET", "/realtime/attendance-radar"), ("GET", "/auth/me"), ("POST", "/auth/change-password"),
]


def test_http_security_contract():
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
            # 1) anonymous => 401 everywhere
            for method, path in ANON_ENDPOINTS:
                r = await c.request(method, API + path, json={})
                assert r.status_code == 401, f"{method} {path} must reject anonymous callers, got {r.status_code}"

            # 2) a REFRESH token must not authenticate API calls
            refresh = create_refresh_token(FAKE_ID)
            r = await c.get(API + "/employees/", headers={"Authorization": f"Bearer {refresh}"})
            assert r.status_code == 401, "refresh token accepted as access token"

            # 3) garbage / tampered tokens
            for tok in ("garbage", create_access_token(FAKE_ID)[:-3] + "abc"):
                r = await c.get(API + "/auth/me", headers={"Authorization": f"Bearer {tok}"})
                assert r.status_code == 401

            # 4) access token for a user that doesn't exist => 401 (not 500)
            r = await c.get(API + "/auth/me", headers={"Authorization": f"Bearer {create_access_token(FAKE_ID)}"})
            assert r.status_code == 401

            # 5) login wildcard / junk identifiers => clean 401, never a 500 (was MultipleResultsFound)
            for ident in ("%", "_", "%%", "a%", "' OR 1=1 --"):
                r = await c.post(API + "/auth/login", json={"email": ident, "password": "wrong-password"})
                assert r.status_code in (401, 429), f"login({ident!r}) -> {r.status_code}"

            # 6) refresh endpoint rejects an access token and junk
            r = await c.post(API + "/auth/refresh", json={"refresh_token": create_access_token(FAKE_ID)})
            assert r.status_code == 401
            r = await c.post(API + "/auth/refresh", json={"refresh_token": "junk"})
            assert r.status_code == 401
    asyncio.run(run())


def test_password_helpers():
    h = get_password_hash("CorrectHorse1")
    assert is_hashed(h) and verify_password("CorrectHorse1", h) and not verify_password("nope", h)
    # never raises on unknown / plaintext / empty hashes
    assert verify_password("x", "plaintext") is False
    assert verify_password("x", None) is False and verify_password("x", "") is False
    assert verify_legacy_plaintext("secret", "secret") and not verify_legacy_plaintext("secret", "other")
    assert not verify_legacy_plaintext("secret", h)  # real hashes are never compared as plaintext
    assert validate_new_password("short") is not None
    assert validate_new_password("  padded-pass ") is not None
    assert validate_new_password("a-good-password") is None


def test_descriptor_validation():
    ok = [0.1] * 128
    assert len(validate_descriptor(ok)) == 128
    for bad in ([0.1] * 127, [0.0] * 128, [float("nan")] * 128, [float("inf")] + [0.1] * 127, ["a"] * 128, None):
        with pytest.raises(HTTPException):
            validate_descriptor(bad)


def test_photo_url_validation():
    validate_photo_url(None)
    validate_photo_url("https://res.cloudinary.com/x/y.jpg")
    for bad in ("javascript:alert(1)", "file:///etc/passwd", "ftp://x/y"):
        with pytest.raises(HTTPException):
            validate_photo_url(bad)


class _Viewer:
    def __init__(self, id, role):
        self.id, self.role = id, role


def _emp_out(emp_id):
    now = datetime.now(timezone.utc)
    return EmployeeOut(
        id=emp_id, employee_code="X1", email="x@y.z", full_name="X", department="D", designation="E",
        joining_date=date(2024, 1, 1), earn_leave_balance=5, sick_leave_balance=3, casual_leave_balance=2,
        is_face_enrolled=True, face_descriptor=[0.1] * 128, address="secret street",
        emergency_contact="999", created_at=now, updated_at=now,
    )


def test_biometric_template_only_visible_to_owner_and_peer_pii_redacted():
    owner_id, other_id = uuid.uuid4(), uuid.uuid4()
    out = _emp_out(owner_id)
    own = view_for(out, _Viewer(owner_id, UserRole.EMPLOYEE))
    assert own.face_descriptor and own.address == "secret street"
    # a peer employee: no template, no address/emergency/balances, but enrolment flag survives
    peer = view_for(out, _Viewer(other_id, UserRole.EMPLOYEE))
    assert peer.face_descriptor is None and peer.address is None and peer.emergency_contact is None
    assert peer.earn_leave_balance == 0.0 and peer.is_face_enrolled is True
    # even HR / admins never receive another person's raw template
    hr = view_for(out, _Viewer(other_id, UserRole.HR_ADMIN))
    assert hr.face_descriptor is None and hr.address == "secret street"
    # the cached original object must not be mutated by redaction
    assert out.face_descriptor is not None and out.address == "secret street"
