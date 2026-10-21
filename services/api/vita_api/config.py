import re
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    field_validator,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT = Path(__file__).resolve().parents[3]

PROPERTY_SEMANTICS = {
    "annual_value": ("number", "USD/year", "customer_annual_contract_value"),
    "renewal_date": ("date", "date", "customer_contract_renewal_date"),
    "usage_change": ("number", "percent", "product_usage_change"),
    "support_cases": ("number", "count", "unresolved_support_cases"),
    "expansion": ("number", "score/100", "expansion_interest"),
}


class HubSpotProperty(BaseModel):
    model_config = ConfigDict(extra="forbid")
    property: str = Field(pattern=r"^[a-z][a-z0-9_]{0,99}$")
    type: Literal["number", "date"]
    unit: str
    meaning: str
    observed_at_property: str | None = Field(default=None, pattern=r"^[a-z][a-z0-9_]{0,99}$")


ResearchDomain = Annotated[str, Field(max_length=253, pattern=r"^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")]


class ResearchTarget(BaseModel):
    model_config = ConfigDict(extra="forbid")
    company_name: str = Field(min_length=1, max_length=160, pattern=r"^[\w .,&'()-]+$")
    domain: ResearchDomain
    publisher_domains: list[ResearchDomain] = Field(default_factory=list, max_length=5)

    @field_validator("publisher_domains")
    @classmethod
    def canonical_publishers(cls, value):
        return sorted(set(value))


class ComparisonProviderConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")
    enabled: bool = False
    live_enabled: bool = False
    api_key: SecretStr = SecretStr("")
    model: str = Field(default="", max_length=200, pattern=r"^[A-Za-z0-9_./:-]*$")
    response_model: str = Field(default="", max_length=200, pattern=r"^[A-Za-z0-9_./:-]*$")
    revision: int = Field(default=1, ge=1)
    resource_name: str = Field(default="", pattern=r"^(?:[a-z0-9][a-z0-9-]{0,61}[a-z0-9])?$")
    endpoint_domain: Literal["services.ai.azure.com", "openai.azure.com"] = "services.ai.azure.com"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=ROOT / "services/api/.env", extra="ignore")

    database_url: str = f"sqlite:///{(ROOT / '.local/vitaai.db').as_posix()}"
    auth_mode: Literal["sample", "session"] = "sample"
    session_hours: int = Field(default=8, ge=1, le=24)
    session_cookie_secure: bool = False
    nebius_api_key: SecretStr = SecretStr("")
    nebius_model: str = ""
    nebius_base_url: str = "https://api.tokenfactory.nebius.com/v1"
    comparison_organization_id: str = Field(default="", pattern=r"^(?:[A-Za-z0-9_-]{1,80})?$")
    comparison_byok_enabled: bool = False
    comparison_providers: dict[Literal["nebius", "openai", "anthropic", "nvidia", "foundry"], ComparisonProviderConfig] = Field(
        default_factory=dict, max_length=5)
    research_enabled: bool = False
    research_live_enabled: bool = False
    research_api_key: SecretStr = SecretStr("")
    research_organization_id: str = Field(default="", pattern=r"^(?:[A-Za-z0-9_-]{1,80})?$")
    research_account_map: dict[str, ResearchTarget] = Field(default_factory=dict, max_length=50)
    research_narrative_provider: ComparisonProviderConfig = Field(default_factory=ComparisonProviderConfig)
    hubspot_enabled: bool = False
    hubspot_write_enabled: bool = False
    hubspot_configuration_revision: int = Field(default=1, ge=1)
    hubspot_access_token: SecretStr = SecretStr("")
    hubspot_organization_id: str = Field(default="", pattern=r"^(?:[A-Za-z0-9_-]{1,80})?$")
    hubspot_portal_id: str = Field(default="", pattern=r"^(?:[1-9][0-9]{0,19})?$")
    hubspot_company_map: dict[str, str] = Field(default_factory=dict, max_length=50)
    hubspot_property_map: dict[str, HubSpotProperty] = Field(default_factory=dict, max_length=5)
    microsoft_enabled: bool = False
    microsoft_write_enabled: bool = False
    microsoft_refresh_enabled: bool = False
    microsoft_configuration_revision: int = Field(default=1, ge=1)
    microsoft_organization_id: str = Field(default="", pattern=r"^(?:[A-Za-z0-9_-]{1,80})?$")
    microsoft_tenant_id: UUID | None = None
    microsoft_client_id: UUID | None = None
    microsoft_client_secret: SecretStr = SecretStr("")
    microsoft_token_key: SecretStr = SecretStr("")
    microsoft_redirect_uri: Literal[
        "http://127.0.0.1:8000/api/integrations/microsoft/callback",
        "http://localhost:8000/api/integrations/microsoft/callback",
    ] = "http://127.0.0.1:8000/api/integrations/microsoft/callback"

    @field_validator("microsoft_tenant_id", "microsoft_client_id", mode="before")
    @classmethod
    def empty_microsoft_id(cls, value):
        return None if value == "" else value

    @field_validator("research_account_map")
    @classmethod
    def research_mapping(cls, value):
        for account_id in value:
            if str(UUID(account_id)) != account_id:
                raise ValueError("Use canonical account UUIDs")
        return value

    @model_validator(mode="after")
    def property_mapping(self):
        names = []
        for target, mapping in self.hubspot_property_map.items():
            if (target not in PROPERTY_SEMANTICS or
                    (mapping.type, mapping.unit, mapping.meaning) != PROPERTY_SEMANTICS[target]):
                raise ValueError("Property type, unit and meaning must match the target account fact")
            if mapping.property in {"annualrevenue", "name", "domain", "industry"}:
                raise ValueError("Company metadata cannot supply commercial or product metrics")
            if target in {"usage_change", "support_cases", "expansion"} and not mapping.observed_at_property:
                raise ValueError("Metrics require an explicit measurement timestamp property")
            names.append(mapping.property)
        if len(set(names)) != len(names) or set(names) & {
                item.observed_at_property for item in self.hubspot_property_map.values()}:
            raise ValueError("A value property cannot represent multiple facts or measurement timestamps")
        return self

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
