"""Durable synthetic compatibility checks, separate from account/model/workflow authority."""
import json
from datetime import UTC, datetime, timedelta
from time import perf_counter
from typing import Annotated, Literal
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from pydantic import AwareDatetime, Field
from sqlalchemy import JSON, BigInteger, Column, MetaData, String, Table, select, update

from .contracts import Contract
from .governance import PolicyDenied
from .identity import Actor
from .provider_catalog import (
    PREFIX,
    CatalogFailure,
    DiscoveryRequest,
    ProviderCatalog,
    ProviderId,
)
from .provider_comparison import metadata_from_response
from .workflow import Workflow

metadata = MetaData()
probes = Table("provider_probe_runs", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("provider", String(20), nullable=False), Column("started_at", BigInteger, nullable=False),
    Column("status", String(20), nullable=False), Column("payload", JSON, nullable=False))
WORKER_BUDGET = timedelta(minutes=2)


class ProbeRequest(DiscoveryRequest):
    expected_configuration_revision: int = Field(ge=1)


class ProbeRun(Contract):
    id: UUID
    organization_id: str
    actor_id: str
    provider: ProviderId
    policy_version: Literal["synthetic-probe-1"] = "synthetic-probe-1"
    revision: int = Field(default=1, ge=1)
    configuration_revision: int
    model: str | None
    expected_response_model: str | None
    response_model: str | None = None
    credential_source: Literal["server", "request"]
    requested_mode: Literal["mock", "live"]
    mode: Literal["disabled", "mock", "live", "fallback"]
    status: Literal["pending", "succeeded", "unavailable", "failed", "invalid_output", "discarded"] = "pending"
    validation: Literal["not_run", "rejected", "synthetic_compatibility_valid"] = "not_run"
    started_at: AwareDatetime
    worker_deadline_at: AwareDatetime
    finished_at: AwareDatetime | None = None
    latency_ms: int | None = None
    request_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    error_code: str | None = None


class ProbeReadiness(Contract):
    organization_id: str
    provider: ProviderId
    configuration_revision: int
    model: str | None
    expected_response_model: str | None
    can_start: bool
    live_configured: bool
    byok_allowed: bool
    pending_run_id: UUID | None
    next_start_at: AwareDatetime | None


def _unique_object(pairs):
    value = dict(pairs)
    if len(value) != len(pairs):
        raise ValueError("Duplicate JSON field")
    return value


def probe_once(catalog, config, run, before_request):
    start = perf_counter()
    try:
        body = {"model": config.model, "messages": [{"role": "user", "content": 'Return only {"status":"ok"}.'}]}
        system = "This is a synthetic protocol check. No business data or action authority is supplied."
        if run.provider == "anthropic":
            body.update(system=system, max_tokens=64)
            path = "/messages"
        else:
            body["messages"].insert(0, {"role": "system", "content": system})
            body["max_completion_tokens" if run.provider in {"openai", "foundry"} else "max_tokens"] = 64
            body["response_format"] = {"type": "json_object"}
            path = "/chat/completions"
        before_request()
        payload = catalog.request(run.provider, config, "POST", path, body)
        if config.api_key.get_secret_value() in json.dumps(payload):
            raise CatalogFailure("credential_echo_rejected")
        metadata_from_response(payload, run, run.provider)
        if run.response_model != run.expected_response_model:
            raise CatalogFailure("response_model_mismatch")
        if run.provider == "anthropic":
            if payload.get("stop_reason") != "end_turn":
                raise CatalogFailure("incomplete_generation")
            blocks = payload["content"]
            if not isinstance(blocks, list) or len(blocks) != 1 or blocks[0].get("type") != "text":
                raise ValueError("Invalid content")
            content = blocks[0]["text"]
        else:
            choices = payload["choices"]
            if not isinstance(choices, list) or len(choices) != 1 or choices[0].get("finish_reason") != "stop":
                raise CatalogFailure("incomplete_generation")
            content = choices[0]["message"]["content"]
        if not isinstance(content, str) or json.loads(content, object_pairs_hook=_unique_object) != {"status": "ok"}:
            raise ValueError("Invalid synthetic response")
        run.status, run.validation = "succeeded", "synthetic_compatibility_valid"
    except CatalogFailure as error:
        run.mode, run.status, run.error_code = "fallback", "failed", str(error)
        if str(error) in {"credential_echo_rejected", "response_model_mismatch", "incomplete_generation"}:
            run.validation = "rejected"
    except (ValueError, KeyError, TypeError, IndexError, AttributeError, RecursionError):
        run.mode, run.status, run.validation, run.error_code = "fallback", "invalid_output", "rejected", "invalid_probe_response"
    run.latency_ms = round((perf_counter() - start) * 1000)


class ProbeService:
    def __init__(self, store, catalog, token, *, clock=None):
        self.store, self.catalog = store, catalog
        self.workflow = Workflow(store, session_token=token, session_required=True)
        self.clock = clock or (lambda: datetime.now(UTC))

    @staticmethod
    def load(connection, organization, run_id):
        payload = connection.execute(select(probes.c.payload).where(
            probes.c.organization_id == organization, probes.c.id == str(run_id))).scalar()
        if payload is None:
            raise PolicyDenied("record_not_found", 404)
        return ProbeRun.model_validate(payload)

    @staticmethod
    def blockers(connection, organization, provider):
        scope = (probes.c.organization_id == organization, probes.c.provider == provider)
        pending = connection.execute(select(probes.c.id).where(*scope, probes.c.status == "pending").limit(1)).scalar()
        latest = connection.execute(select(probes.c.started_at).where(*scope)
            .order_by(probes.c.started_at.desc()).limit(1)).scalar()
        return pending, datetime.fromtimestamp(latest / 1_000_000, UTC) + timedelta(seconds=60) if latest is not None else None

    def readiness(self, actor_id, provider):
        with self.workflow._transaction(actor_id, write=False) as (connection, actor):
            entry = next(item for item in self.catalog.entries(actor.organization_id) if item.provider == provider)
            pending, next_start = self.blockers(connection, actor.organization_id, provider)
            return ProbeReadiness(organization_id=actor.organization_id, provider=provider,
                configuration_revision=entry.configuration_revision, model=entry.model,
                expected_response_model=entry.expected_response_model,
                can_start=bool(actor.role == "admin" and self.catalog.settings.comparison_test_enabled
                    and actor.organization_id == self.catalog.settings.comparison_organization_id
                    and not pending and (next_start is None or self.clock() >= next_start)),
                live_configured=entry.live_configured, byok_allowed=entry.byok_allowed,
                pending_run_id=pending, next_start_at=next_start)

    def check(self, connection, actor, run, config, request_key):
        saved = self.load(connection, run.organization_id, run.id)
        if saved.status != "pending" or saved.revision != run.revision:
            raise PolicyDenied("probe_worker_fenced", 409)
        if self.clock() >= run.worker_deadline_at:
            raise PolicyDenied("probe_worker_expired", 409)
        if actor.role != "admin" or actor.organization_id != run.organization_id:
            raise PolicyDenied("provider_admin_required", 403)
        if not self.catalog.settings.comparison_test_enabled:
            raise PolicyDenied("provider_test_disabled", 403)
        if request_key and not self.catalog.settings.comparison_byok_enabled:
            raise PolicyDenied("comparison_byok_disabled", 403)
        if self.catalog.config(actor.organization_id, run.provider) != config:
            raise PolicyDenied("comparison_configuration_changed", 409)

    @staticmethod
    def finish(connection, run, now):
        if now >= run.worker_deadline_at:
            raise PolicyDenied("probe_worker_expired", 409)
        result = connection.execute(update(probes).where(probes.c.id == str(run.id),
            probes.c.organization_id == run.organization_id, probes.c.status == "pending",
            probes.c.payload["revision"].as_integer() == run.revision)
            .values(status=run.status, payload=run.model_copy(update={"revision": run.revision + 1}).model_dump(mode="json")))
        if result.rowcount != 1:
            raise PolicyDenied("probe_worker_fenced", 409)
        run.revision += 1

    def start(self, actor_id, provider, body):
        request_key = body.api_key is not None
        with self.workflow._transaction(actor_id) as (connection, actor):
            settings = self.catalog.settings
            if actor.role != "admin":
                raise PolicyDenied("provider_admin_required", 403)
            if not settings.comparison_test_enabled:
                raise PolicyDenied("provider_test_disabled", 403)
            if actor.organization_id != settings.comparison_organization_id:
                raise PolicyDenied("provider_unconfigured", 409)
            config = self.catalog.config(actor.organization_id, provider)
            if config.revision != body.expected_configuration_revision:
                raise PolicyDenied("comparison_configuration_changed", 409)
            if request_key and not settings.comparison_byok_enabled:
                raise PolicyDenied("comparison_byok_disabled", 403)
            effective = config.model_copy(deep=True)
            if request_key:
                effective.api_key = body.api_key
            if body.mode == "live" and not (config.enabled and config.live_enabled and config.model
                    and effective.api_key.get_secret_value() and (provider != "foundry" or config.resource_name)):
                raise PolicyDenied("provider_unconfigured", 409)
            if body.mode == "live" and provider == "nebius" and not (
                    config.model.startswith("nvidia/") and "nemotron" in config.model.lower()):
                raise PolicyDenied("configured_nvidia_model_required", 409)
            pending, next_start = self.blockers(connection, actor.organization_id, provider)
            if pending or (next_start is not None and self.clock() < next_start):
                raise PolicyDenied("provider_test_pending" if pending else "provider_test_cooldown", 409)
            now = self.clock()
            run = ProbeRun(id=uuid4(), organization_id=actor.organization_id, actor_id=actor.id, provider=provider,
                configuration_revision=config.revision, model=config.model or None,
                expected_response_model=config.response_model or config.model or None,
                credential_source="request" if request_key else "server", requested_mode=body.mode,
                mode="disabled" if not config.enabled else body.mode, started_at=now, worker_deadline_at=now + WORKER_BUDGET)
            connection.execute(probes.insert().values(id=str(run.id), organization_id=run.organization_id,
                provider=provider, started_at=int(now.timestamp() * 1_000_000), status="pending", payload=run.model_dump(mode="json")))
        try:
            def before_request():
                with self.workflow._transaction(actor_id, write=False) as (connection, actor):
                    self.check(connection, actor, run, config, request_key)
            if body.mode == "live":
                probe_once(self.catalog, effective, run, before_request)
            else:
                run.status, run.error_code = "unavailable", "mock_probe_not_run" if config.enabled else "provider_disabled"
            with self.workflow._transaction(actor_id) as (connection, actor):
                self.check(connection, actor, run, config, request_key)
                run.finished_at = self.clock()
                self.finish(connection, run, self.clock())
            return run
        except PolicyDenied as error:
            if error.code not in {"probe_worker_expired", "probe_worker_fenced"} and self.clock() < run.worker_deadline_at:
                run.status, run.mode, run.validation, run.error_code = "discarded", "fallback", "not_run", "probe_context_changed"
                run.response_model = run.request_id = run.input_tokens = run.output_tokens = None
                run.finished_at = self.clock()
                with self.store.engine.begin() as connection:
                    self.finish(connection, run, self.clock())
            raise


def install_probe_routes(app, store, identity, settings, transport=None):
    catalog = ProviderCatalog(settings, transport)
    router = APIRouter(prefix=PREFIX)

    def current(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    def service(request):
        return ProbeService(store, catalog, request.cookies.get("vitaai_session"))

    @router.get("/providers/{provider}/test-readiness", response_model=ProbeReadiness)
    def readiness(provider: ProviderId, request: Request, actor: Annotated[Actor, Depends(current)]):
        return service(request).readiness(actor.id, provider)

    @router.post("/providers/{provider}/test", response_model=ProbeRun)
    def start(provider: ProviderId, body: ProbeRequest, request: Request, actor: Annotated[Actor, Depends(current)]):
        return service(request).start(actor.id, provider, body)

    @router.get("/tests/{run_id}", response_model=ProbeRun)
    def get(run_id: UUID, request: Request, actor: Annotated[Actor, Depends(current)]):
        with service(request).workflow._transaction(actor.id, write=False) as (connection, fresh):
            return ProbeService.load(connection, fresh.organization_id, run_id)

    @router.get("/providers/{provider}/tests", response_model=list[ProbeRun])
    def history(provider: ProviderId, request: Request, actor: Annotated[Actor, Depends(current)]):
        with service(request).workflow._transaction(actor.id, write=False) as (connection, fresh):
            return [ProbeRun.model_validate(payload) for payload in connection.execute(select(probes.c.payload).where(
                probes.c.organization_id == fresh.organization_id, probes.c.provider == provider)
                .order_by(probes.c.started_at.desc()).limit(20)).scalars()]

    app.include_router(router)
