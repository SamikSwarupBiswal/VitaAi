"""Independent server-configured comparison providers; catalog reads never call them."""
import json
import re
from datetime import UTC, datetime
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, Request
from pydantic import Field

from .config import ComparisonProviderConfig
from .contracts import Contract
from .governance import PolicyDenied
from .identity import Actor
from .workflow import Workflow

PREFIX = "/api/provider-comparison"
ProviderId = Literal["nebius", "openai", "anthropic", "nvidia", "foundry"]
ENDPOINTS = {
    "nebius": "https://api.tokenfactory.nebius.com/v1",
    "openai": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com/v1",
    "nvidia": "https://integrate.api.nvidia.com/v1",
}
PROVIDERS = (*ENDPOINTS, "foundry")
MODEL_ID = re.compile(r"[A-Za-z0-9_./:-]{1,200}")


class CatalogEntry(Contract):
    provider: ProviderId
    enabled: bool
    live_configured: bool
    configuration_revision: int
    model: str | None
    expected_response_model: str | None
    status: Literal["disabled", "unconfigured", "configured_unverified"]
    capabilities: list[Literal["model_discovery", "account_analysis"]]
    byok_allowed: bool = False


class DiscoveryRequest(Contract):
    mode: Literal["mock", "live"] = "mock"


class DiscoveryResult(Contract):
    provider: ProviderId
    requested_mode: Literal["mock", "live"]
    mode: Literal["disabled", "mock", "live", "fallback"]
    source: Literal["configuration", "provider", "none"]
    configuration_revision: int
    observed_at: datetime
    models: list[str] = Field(default_factory=list, max_length=100)
    has_more: bool = False
    error_code: str | None = None


class CatalogFailure(Exception):
    pass


class ProviderCatalog:
    def __init__(self, settings, transport=None):
        self.settings, self.transport = settings, transport

    def config(self, organization_id, provider):
        if provider not in PROVIDERS:
            raise PolicyDenied("provider_not_supported", 404)
        if organization_id != self.settings.comparison_organization_id:
            return ComparisonProviderConfig()
        return self.settings.comparison_providers.get(provider, ComparisonProviderConfig()).model_copy(deep=True)

    def entries(self, organization_id):
        result = []
        for provider in PROVIDERS:
            config = self.config(organization_id, provider)
            configured = bool(config.enabled and config.live_enabled and config.api_key.get_secret_value()
                and config.model and (provider != "foundry" or config.resource_name))
            result.append(CatalogEntry(provider=provider, enabled=config.enabled, live_configured=configured,
                configuration_revision=config.revision, model=config.model or None,
                expected_response_model=config.response_model or config.model or None,
                status="disabled" if not config.enabled else "configured_unverified" if configured else "unconfigured",
                capabilities=["model_discovery", "account_analysis"],
                byok_allowed=bool(self.settings.comparison_byok_enabled and config.enabled and config.live_enabled
                    and config.model and (provider != "foundry" or config.resource_name))))
        return result

    def request(self, provider, config, method, path, body=None):
        headers = {"Accept": "application/json"}
        if provider == "foundry":
            try:
                config = ComparisonProviderConfig.model_validate(config.model_dump())
            except ValueError:
                raise CatalogFailure("invalid_provider_configuration") from None
            if not config.resource_name:
                raise CatalogFailure("provider_unconfigured")
            endpoint = f"https://{config.resource_name}.{config.endpoint_domain}/openai/v1"
            headers["api-key"] = config.api_key.get_secret_value()
        elif provider == "anthropic":
            headers.update({"x-api-key": config.api_key.get_secret_value(), "anthropic-version": "2023-06-01"})
        else:
            headers["Authorization"] = "Bearer " + config.api_key.get_secret_value()
        if provider != "foundry":
            endpoint = ENDPOINTS[provider]
        try:
            with (httpx.Client(timeout=20, follow_redirects=False, transport=self.transport, trust_env=False) as client,
                  client.stream(method, endpoint + path, headers=headers, json=body) as response):
                if response.status_code != 200:
                    raise CatalogFailure(f"provider_http_{response.status_code}")
                raw = bytearray()
                for chunk in response.iter_bytes():
                    raw.extend(chunk)
                    if len(raw) > 131072:
                        raise CatalogFailure("provider_response_too_large")
                payload = json.loads(raw)
                if not isinstance(payload, dict):
                    raise CatalogFailure("invalid_provider_response")
                return payload
        except httpx.TimeoutException:
            raise CatalogFailure("provider_timeout") from None
        except httpx.RequestError:
            raise CatalogFailure("provider_network_error") from None
        except (ValueError, RecursionError):
            raise CatalogFailure("invalid_provider_response") from None

    def discover(self, organization_id, provider, body):
        config = self.config(organization_id, provider)
        result = DiscoveryResult(provider=provider, requested_mode=body.mode,
            mode="disabled" if not config.enabled else body.mode, source="none",
            configuration_revision=config.revision, observed_at=datetime.now(UTC))
        if not config.enabled:
            result.error_code = "provider_disabled"
        elif body.mode == "mock":
            result.source, result.models = "configuration", [config.model] if config.model else []
        elif not (config.live_enabled and config.api_key.get_secret_value()):
            result.mode, result.error_code = "fallback", "provider_unconfigured"
        else:
            try:
                payload = self.request(provider, config, "GET", "/models?limit=100" if provider == "anthropic" else "/models")
                data = payload.get("data")
                if not isinstance(data, list) or len(data) > 2000:
                    raise CatalogFailure("invalid_provider_response")
                ids = set()
                for item in data:
                    model = item.get("id") if isinstance(item, dict) else None
                    if not isinstance(model, str) or not MODEL_ID.fullmatch(model):
                        raise CatalogFailure("invalid_provider_response")
                    if provider != "nebius" or (model.startswith("nvidia/") and "nemotron" in model.lower()):
                        ids.add(model)
                if not ids:
                    raise CatalogFailure("provider_models_empty")
                result.models, result.source = sorted(ids)[:100], "provider"
                result.has_more = len(ids) > 100 or payload.get("has_more") is True
            except CatalogFailure as error:
                result.mode, result.error_code = "fallback", str(error)
        result.observed_at = datetime.now(UTC)
        return result


def install_catalog_routes(app, store, identity, settings, transport=None):
    catalog = ProviderCatalog(settings, transport)
    router = APIRouter(prefix=PREFIX)

    def current(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    @router.get("/catalog", response_model=list[CatalogEntry])
    def entries(actor: Annotated[Actor, Depends(current)]):
        return catalog.entries(actor.organization_id)

    @router.post("/providers/{provider}/discover", response_model=DiscoveryResult)
    def discover(provider: ProviderId, body: DiscoveryRequest, request: Request,
                 actor: Annotated[Actor, Depends(current)]):
        workflow = Workflow(store, session_token=request.cookies.get("vitaai_session"), session_required=True)
        with workflow._transaction(actor.id, write=False) as (_, fresh):
            if fresh.role != "admin":
                raise PolicyDenied("provider_admin_required", 403)
            organization = fresh.organization_id
            config = catalog.config(organization, provider)
        result = catalog.discover(organization, provider, body)
        with workflow._transaction(actor.id, write=False) as (_, fresh):
            if fresh.organization_id != organization or fresh.role != "admin":
                raise PolicyDenied("provider_authority_changed", 403)
            if catalog.config(organization, provider) != config:
                raise PolicyDenied("comparison_configuration_changed", 409)
        return result

    app.include_router(router)
