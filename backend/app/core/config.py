from typing import List, Union
from pydantic import AnyHttpUrl, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
import json
import os

class Settings(BaseSettings):
    PROJECT_NAME: str = "Kalpanaaa HRMS API"
    VERSION: str = "1.0.0"
    API_V1_STR: str = "/api/v1"
    ENVIRONMENT: str = "development"

    # Database
    DATABASE_URL: str
    DATABASE_URL_UNPOOLED: str | None = None

    # Security & Auth
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 10080  # 7 days
    REFRESH_TOKEN_EXPIRE_DAYS: int = 60      # 60 days

    # CORS
    CORS_ORIGINS: List[str] = [
        "http://localhost:3000",
        "http://localhost:5173",
        "https://kalpanaaa.in",
        "https://kss-hrms-official.vercel.app",
        "https://kss-hrms-official-ojen.vercel.app",
        "https://kalpanaaa-employees-website.firebaseapp.com",
        "https://kalpanaaa-employees-website.web.app"
    ]

    @field_validator("CORS_ORIGINS", mode="before")
    @classmethod
    def assemble_cors_origins(cls, v: Union[str, List[str]]) -> List[str]:
        if isinstance(v, str):
            try:
                decoded = json.loads(v)
                if isinstance(decoded, list):
                    return decoded
            except json.JSONDecodeError:
                return [i.strip() for i in v.split(",") if i.strip()]
        elif isinstance(v, list):
            return v
        return []

    # Office Geofence & Location
    GEOFENCE_LAT: float = 12.9121
    GEOFENCE_LON: float = 77.6446
    GEOFENCE_RADIUS_METERS: float = 100.0
    COMPANY_TIMEZONE: str = "Asia/Kolkata"
    # Server-side geofence enforcement for on-site check-ins. OFF by default until the office
    # coordinates in company_settings are confirmed correct (wrong data would lock everyone out).
    SERVER_GEOFENCE_ENFORCEMENT: bool = False
    # Set false in production to hide /docs and /openapi.json
    EXPOSE_API_DOCS: bool = True

    # Firebase Bridge (Optional during migration)
    FIREBASE_WEB_API_KEY: str | None = None

    # Cloudinary Image Storage
    CLOUDINARY_CLOUD_NAME: str | None = None
    CLOUDINARY_API_KEY: str | None = None
    CLOUDINARY_API_SECRET: str | None = None
    CLOUDINARY_URL: str | None = None

    model_config = SettingsConfigDict(
        env_file=(
            os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), ".env"),
            os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), ".env"),
        ),
        env_file_encoding="utf-8",
        extra="ignore"
    )

settings = Settings()
