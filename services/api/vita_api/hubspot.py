"""Bounded read-only HubSpot transport. Provider data has no execution authority."""
import hashlib
import json
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

import httpx
from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, ValidationError

from .config import HubSpotProperty, Settings

PREFIX = "/api/integrations/hubspot"


class HubSpotContract(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["1"] = "1"


class HubSpotStatus(HubSpotContract):
    configured: bool
    status: Literal["unconfigured", "configured_unverified"]


class CompanyRead(HubSpotContract):
    company_id: str
    created_at: AwareDatetime
    updated_at: AwareDatetime
    properties: dict[str, str | None]
    property_types: dict[str, str] = Field(default_factory=dict)
    mapping_hash: str | None = None
    property_mapping: dict[str, HubSpotProperty] = Field(default_factory=dict)


class HubSpotObservation(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    account_revision: int = Field(ge=1)
    portal_id: str
    company_id: str
    source: Literal["hubspot"] = "hubspot"
    source_record: str
    provider_created_at: AwareDatetime
    provider_updated_at: AwareDatetime
    fetched_at: AwareDatetime
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    sequence: int = Field(ge=1)
    properties: dict[str, str | None]
    property_types: dict[str, str] = Field(default_factory=dict)
    mapping_hash: str | None = None
    property_mapping: dict[str, HubSpotProperty] = Field(default_factory=dict)


class HubSpotSyncRequest(HubSpotContract):
    expected_account_revision: int = Field(ge=1)


class HubSpotSyncRun(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    actor_id: str
    account_revision: int | None = None
    portal_id: str
    company_id: str
    started_at: AwareDatetime
    finished_at: AwareDatetime
    status: Literal["succeeded", "failed"]
    disposition: Literal["baseline", "unchanged", "changed"] | None = None
    observation_id: UUID | None = None
    error_code: str | None = None


class HubSpotFailure(Exception):
    """Only fixed safe error codes cross the provider boundary."""


class HubSpot:
    def __init__(self, settings: Settings, transport: httpx.BaseTransport | None = None):
        # Configuration changes require an API restart, including mapping/credential changes.
        self.settings = settings.model_copy(deep=True)
        self.transport = transport

    @property
    def configured(self):
        s = self.settings
        return bool(s.hubspot_enabled and s.hubspot_access_token.get_secret_value()
                    and s.hubspot_organization_id and s.hubspot_portal_id and s.hubspot_company_map)

    def status(self, organization_id: str) -> HubSpotStatus:
        ready = self.configured and organization_id == self.settings.hubspot_organization_id
        return HubSpotStatus(configured=ready, status="configured_unverified" if ready else "unconfigured")

    @property
    def mapping_hash(self):
        mapping = {key: value.model_dump() for key, value in self.settings.hubspot_property_map.items()}
        return hashlib.sha256(json.dumps(mapping, sort_keys=True, separators=(",", ":")).encode()).hexdigest()

    def property_types(self):
        result = {}
        for mapping in self.settings.hubspot_property_map.values():
            result[mapping.property] = mapping.type
            if mapping.observed_at_property:
                result[mapping.observed_at_property] = "datetime"
        return result

    def _get(self, client, path, *, params=None):
        try:
            with client.stream("GET", path, params=params) as response:
                if response.status_code != 200:
                    raise HubSpotFailure(f"hubspot_http_{response.status_code}")
                body = bytearray()
                for chunk in response.iter_bytes():
                    body.extend(chunk)
                    if len(body) > 65536:
                        raise HubSpotFailure("response_too_large")
                data = json.loads(body)
                if not isinstance(data, dict):
                    raise HubSpotFailure("invalid_response")
                # Escaped lone surrogates decode in Python but cannot be saved or returned as UTF-8.
                json.dumps(data, ensure_ascii=False).encode("utf-8")
                return data
        except httpx.TimeoutException:
            raise HubSpotFailure("hubspot_timeout") from None
        except httpx.RequestError:
            raise HubSpotFailure("hubspot_network_error") from None
        except (ValueError, UnicodeError):
            raise HubSpotFailure("invalid_response") from None

    def read_company(self, company_id: str, now: datetime | None = None, *, before_request=None) -> CompanyRead:
        if not self.configured:
            raise HubSpotFailure("hubspot_unconfigured")
        if company_id not in self.settings.hubspot_company_map.values():
            raise HubSpotFailure("company_not_allowed")
        with httpx.Client(base_url="https://api.hubapi.com", timeout=15, follow_redirects=False,
                          transport=self.transport, headers={"Authorization": "Bearer " +
                          self.settings.hubspot_access_token.get_secret_value()}) as client:
            if before_request:
                before_request()
            portal = self._get(client, "/account-info/v3/details").get("portalId")
            if type(portal) is not int or portal < 1:
                raise HubSpotFailure("invalid_response")
            if str(portal) != self.settings.hubspot_portal_id:
                raise HubSpotFailure("portal_mismatch")
            types = self.property_types()
            for name, expected_type in types.items():
                if before_request:
                    before_request()
                definition = self._get(client, f"/crm/v3/properties/companies/{name}")
                if (definition.get("name") != name or definition.get("type") != expected_type
                        or definition.get("archived") is not False):
                    raise HubSpotFailure("property_type_mismatch")
            fields = ["name", "domain", "industry", *sorted(types)]
            if before_request:
                before_request()
            data = self._get(client, f"/crm/v3/objects/companies/{company_id}",
                             params={"properties": ",".join(fields), "archived": "false"})
        try:
            if data["id"] != company_id or data["archived"] is not False:
                raise HubSpotFailure("company_identity_or_archive_mismatch")
            properties = data["properties"]
            if not isinstance(properties, dict):
                raise HubSpotFailure("invalid_response")
            selected = {key: properties[key] for key in fields if key in properties}
            if any(value is not None and (not isinstance(value, str) or len(value) > 2000)
                   for value in selected.values()):
                raise HubSpotFailure("invalid_response")
            result = CompanyRead(company_id=company_id, created_at=data["createdAt"],
                                 updated_at=data["updatedAt"], properties=selected,
                                 property_types=types, mapping_hash=self.mapping_hash,
                                 property_mapping=self.settings.hubspot_property_map)
            if result.created_at > result.updated_at or result.updated_at > (now or datetime.now(UTC)):
                raise HubSpotFailure("invalid_source_time")
            return result.model_copy(update={"created_at": result.created_at.astimezone(UTC),
                                              "updated_at": result.updated_at.astimezone(UTC)})
        except (KeyError, TypeError, ValidationError):
            raise HubSpotFailure("invalid_response") from None
