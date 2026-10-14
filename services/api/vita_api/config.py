from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / "services/api/.env", extra="ignore")

    database_url: str = f"sqlite:///{(ROOT / '.local/vitaai.db').as_posix()}"
    auth_mode: Literal["sample", "session"] = "sample"
    session_hours: int = Field(default=8, ge=1, le=24)
    session_cookie_secure: bool = False
    nebius_api_key: SecretStr = SecretStr("")
    nebius_model: str = ""
    nebius_base_url: str = "https://api.tokenfactory.nebius.com/v1"

    @field_validator("nebius_base_url")
    @classmethod
    def provider_endpoint(cls, value: str) -> str:
        url = urlsplit(value)
        allowed = {"api.tokenfactory.nebius.com", "api.tokenfactory.us-central1.nebius.com"}
        if (url.scheme != "https" or url.hostname not in allowed
                or url.username or url.password or url.port not in (None, 443)
                or url.query or url.fragment or url.path.rstrip("/") != "/v1"):
            raise ValueError("Use an official Nebius Token Factory HTTPS /v1 endpoint")
        return value.rstrip("/")
