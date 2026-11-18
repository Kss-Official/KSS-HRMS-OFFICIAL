import hmac
from datetime import datetime, timedelta, timezone
from typing import Any, Union
from jose import jwt
from passlib.context import CryptContext
from .config import settings

pwd_context = CryptContext(schemes=["argon2", "bcrypt"], deprecated="auto")

# Minimum acceptable password length for NEW passwords (change-password / create).
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128

# A real argon2 hash of a random string, used to burn equivalent CPU time when the
# account does not exist so response time doesn't reveal which logins are valid.
_DUMMY_HASH = pwd_context.hash("dummy-password-for-timing-equalisation")


def is_hashed(value: str | None) -> bool:
    """True if `value` looks like an argon2/bcrypt hash produced by passlib."""
    return bool(value) and (value.startswith("$argon2") or value.startswith("$2"))


def verify_password(plain_password: str, hashed_password: str | None) -> bool:
    """Never raises. Returns False for missing/unknown/corrupt hashes."""
    if not hashed_password or not is_hashed(hashed_password):
        return False
    try:
        return pwd_context.verify(plain_password, hashed_password)
    except Exception:
        return False


def verify_legacy_plaintext(plain_password: str, stored: str | None) -> bool:
    """Constant-time compare for rows migrated from the old system that still hold a
    plaintext password. Callers MUST re-hash on success (see auth.login)."""
    if not stored or is_hashed(stored):
        return False
    return hmac.compare_digest(plain_password.encode("utf-8"), stored.encode("utf-8"))


def burn_password_hash_time(plain_password: str) -> None:
    """Equalise timing for unknown accounts."""
    try:
        pwd_context.verify(plain_password, _DUMMY_HASH)
    except Exception:
        pass


def validate_new_password(password: str) -> str | None:
    """Returns an error message if the password is unacceptable, else None."""
    if password is None or len(password) < MIN_PASSWORD_LENGTH:
        return f"Password must be at least {MIN_PASSWORD_LENGTH} characters long"
    if len(password) > MAX_PASSWORD_LENGTH:
        return f"Password must be at most {MAX_PASSWORD_LENGTH} characters long"
    if password.strip() != password:
        return "Password must not start or end with whitespace"
    return None


def get_password_hash(password: str) -> str:
    return pwd_context.hash(password)


def create_access_token(subject: Union[str, Any], expires_delta: timedelta | None = None) -> str:
    if expires_delta:
        expire = datetime.now(timezone.utc) + expires_delta
    else:
        expire = datetime.now(timezone.utc) + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode = {"exp": expire, "sub": str(subject), "type": "access"}
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt


def create_refresh_token(subject: Union[str, Any]) -> str:
    expire = datetime.now(timezone.utc) + timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS)
    to_encode = {"exp": expire, "sub": str(subject), "type": "refresh"}
    return jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)


def decode_token(token: str) -> dict[str, Any]:
    return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
