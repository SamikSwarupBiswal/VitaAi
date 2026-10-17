import re
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

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
    hubspot_enabled: bool = False
    hubspot_access_token: SecretStr = SecretStr("")
    hubspot_organization_id: str = Field(default="", pattern=r"^(?:[A-Za-z0-9_-]{1,80})?$")
    hubspot_portal_id: str = Field(default="", pattern=r"^(?:[1-9][0-9]{0,19})?$")
    hubspot_company_map: dict[str, str] = Field(default_factory=dict, max_length=50)

    @field_validator("hubspot_company_map")
    @classmethod
    def company_mapping(cls, value: dict[str, str]) -> dict[str, str]:
        for account_id, company_id in value.items():
            if str(UUID(account_id)) != account_id or not re.fullmatch(r"[1-9][0-9]{0,19}", company_id):
                raise ValueError("Use canonical account UUIDs and numeric HubSpot company IDs")
        if len(set(value.values())) != len(value):
            raise ValueError("A HubSpot company can map to only one account")
        return value

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
