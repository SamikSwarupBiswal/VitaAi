"""Scoped staging of read-only company observations; never promotes facts or actions."""
import hashlib
import json
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    MetaData,
    String,
    Table,
    UniqueConstraint,
    select,
    text,
)

from .contracts import Account
from .governance import PolicyDenied
from .hubspot import (
    PREFIX,
    HubSpot,
    HubSpotFailure,
    HubSpotObservation,
    HubSpotStatus,
    HubSpotSyncRequest,
    HubSpotSyncRun,
)
from .identity import Actor, sessions, token_digest, users
from .storage import accounts

metadata = MetaData()
# Include the existing table only for composite FK resolution; this metadata never creates it.
accounts.to_metadata(metadata)
observations = Table("hubspot_observations", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("sequence", Integer, nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "id"),
    UniqueConstraint("organization_id", "account_id", "sequence"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
sync_runs = Table("hubspot_sync_runs", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("observation_id", String(80), nullable=True),
    Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
    ForeignKeyConstraint(["organization_id", "observation_id"], ["hubspot_observations.organization_id", "hubspot_observations.id"]))


class HubSpotSync:
    def __init__(self, store, connector, token):
        self.engine, self.connector, self.token = store.engine, connector, token

    @contextmanager
    def transaction(self, *, write=False):
        with self.engine.connect() as connection:
            try:
                if self.engine.dialect.name == "sqlite":
                    connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
                else:
                    connection.begin()
                    # One lock order: connector/organization, then current user/session/account.
                    key = int.from_bytes(hashlib.sha256(("hubspot:" + self.connector.settings.hubspot_organization_id)
                                                       .encode()).digest()[:8], "big", signed=True)
                    connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                row = connection.execute(select(users).join(sessions, sessions.c.user_id == users.c.id).where(
                    sessions.c.token_hash == token_digest(self.token or ""),
                    sessions.c.expires_at > int(datetime.now(UTC).timestamp()), users.c.enabled.is_(True))
                    .with_for_update()).mappings().first()
                if row is None:
                    raise PolicyDenied("authentication_required", 401)
                actor = Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")})
                if actor.organization_id != self.connector.settings.hubspot_organization_id:
                    raise PolicyDenied("record_not_found", 404)
                if write and actor.role != "admin":
                    raise PolicyDenied("hubspot_admin_required", 403)
                yield connection, actor
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def account(self, connection, actor, account_id, expected=None):
        payload = connection.execute(select(accounts.c.payload).where(
            accounts.c.organization_id == actor.organization_id, accounts.c.id == str(account_id))
            .with_for_update()).scalar()
        if payload is None or str(account_id) not in self.connector.settings.hubspot_company_map:
            raise PolicyDenied("record_not_found", 404)
        account = Account.model_validate(payload)
        if expected is not None and account.revision != expected:
            raise PolicyDenied("stale_account_revision", 409)
        return account

    def latest(self, connection, organization_id, account_id):
        payload = connection.execute(select(observations.c.payload).where(
            observations.c.organization_id == organization_id, observations.c.account_id == str(account_id))
            .order_by(observations.c.sequence.desc()).limit(1)).scalar()
        return HubSpotObservation.model_validate(payload) if payload else None

    def get(self, table, record_id, contract):
        with self.transaction() as (connection, actor):
            payload = connection.execute(select(table.c.payload).where(
                table.c.organization_id == actor.organization_id, table.c.id == str(record_id))).scalar()
            if payload is None:
                raise PolicyDenied("record_not_found", 404)
            record = contract.model_validate(payload)
            self.account(connection, actor, record.account_id)
            return record

    def sync(self, account_id, expected):
        if not self.connector.configured:
            raise PolicyDenied("hubspot_unconfigured", 503)
        with self.transaction(write=True) as (connection, actor):
            account = self.account(connection, actor, account_id, expected)
            previous = self.latest(connection, actor.organization_id, account_id)
        company_id = self.connector.settings.hubspot_company_map[str(account_id)]
        started = datetime.now(UTC)
        result, error_code = None, None
        try:
            # Both provider GETs run outside database transactions/locks. No automatic retry.
            result = self.connector.read_company(company_id)
        except HubSpotFailure as error:
            error_code = str(error)
        with self.transaction(write=True) as (connection, current):
            if current.id != actor.id or current.organization_id != actor.organization_id:
                raise PolicyDenied("membership_changed", 409)
            self.account(connection, current, account_id, account.revision)
            latest = self.latest(connection, current.organization_id, account_id)
            run = HubSpotSyncRun(id=uuid4(), organization_id=current.organization_id, account_id=account_id,
                actor_id=current.id, portal_id=self.connector.settings.hubspot_portal_id, company_id=company_id,
                started_at=started, finished_at=datetime.now(UTC), status="failed", error_code=error_code)
            if result is not None:
                fingerprint = hashlib.sha256(json.dumps({"portal_id": run.portal_id,
                    **result.model_dump(mode="json")}, sort_keys=True, separators=(",", ":"),
                    ensure_ascii=False).encode()).hexdigest()
                if latest and latest.portal_id == run.portal_id and latest.company_id == company_id and latest.fingerprint == fingerprint:
                    run.disposition, run.observation_id = "unchanged", latest.id
                else:
                    if (latest.id if latest else None) != (previous.id if previous else None):
                        raise PolicyDenied("observation_changed_during_sync", 409)
                    if (latest and latest.portal_id == run.portal_id and latest.company_id == company_id
                            and result.updated_at < latest.provider_updated_at):
                        raise PolicyDenied("source_time_regressed", 409)
                    observation = HubSpotObservation(id=uuid4(), organization_id=current.organization_id,
                        account_id=account_id, account_revision=account.revision, portal_id=run.portal_id,
                        company_id=company_id, source_record=f"https://api.hubapi.com/crm/v3/objects/companies/{company_id}",
                        provider_created_at=result.created_at, provider_updated_at=result.updated_at,
                        fetched_at=run.finished_at, fingerprint=fingerprint,
                        sequence=latest.sequence + 1 if latest else 1, properties=result.properties)
                    connection.execute(observations.insert().values(id=str(observation.id),
                        organization_id=current.organization_id, account_id=str(account_id), sequence=observation.sequence,
                        payload=observation.model_dump(mode="json")))
                    run.disposition, run.observation_id = "changed" if latest else "baseline", observation.id
                run.status = "succeeded"
            connection.execute(sync_runs.insert().values(id=str(run.id), organization_id=current.organization_id,
                account_id=str(account_id), observation_id=str(run.observation_id) if run.observation_id else None,
                payload=run.model_dump(mode="json")))
            return run


def install_hubspot_routes(app, store, identity, settings, transport=None):
    connector = HubSpot(settings, transport)
    router = APIRouter(prefix=PREFIX)

    def current(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    def service(request: Request):
        return HubSpotSync(store, connector, request.cookies.get("vitaai_session"))

    Current = Annotated[Actor, Depends(current)]
    Service = Annotated[HubSpotSync, Depends(service)]

    @router.get("", response_model=HubSpotStatus)
    def status(actor: Current):
        return connector.status(actor.organization_id)

    @router.post("/accounts/{account_id}/sync", response_model=HubSpotSyncRun)
    def sync(account_id: UUID, body: HubSpotSyncRequest, actor: Current, operation: Service):
        return operation.sync(account_id, body.expected_account_revision)

    @router.get("/runs/{run_id}", response_model=HubSpotSyncRun)
    def get_run(run_id: UUID, actor: Current, operation: Service):
        return operation.get(sync_runs, run_id, HubSpotSyncRun)

    @router.get("/observations/{observation_id}", response_model=HubSpotObservation)
    def get_observation(observation_id: UUID, actor: Current, operation: Service):
        return operation.get(observations, observation_id, HubSpotObservation)

    app.include_router(router)
