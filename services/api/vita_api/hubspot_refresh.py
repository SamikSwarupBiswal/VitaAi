"""Durable staging-refresh grants; registration never contacts HubSpot."""
import hashlib
import json
import logging
from datetime import UTC, datetime, timedelta
from threading import Event, Lock, Thread
from typing import Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, Field
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
    update,
)

from .governance import PolicyDenied
from .hubspot import HubSpot, HubSpotContract
from .identity import sessions, token_digest
from .storage import accounts

metadata = MetaData()
accounts.to_metadata(metadata)
authorizations = Table("hubspot_refresh_authorizations", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("revision", Integer, nullable=False),
    Column("session_hash", String(64), nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "account_id", "revision"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
occurrences = Table("hubspot_refresh_occurrences", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("authorization_id", String(80), nullable=False),
    Column("slot", Integer, nullable=False),
    Column("status", String(20), nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("authorization_id", "slot"),
    ForeignKeyConstraint(["authorization_id"], ["hubspot_refresh_authorizations.id"]),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))


class RefreshGrantRequest(HubSpotContract):
    expected_revision: int = Field(ge=0, strict=True)
    expected_account_revision: int = Field(ge=1, strict=True)
    expected_configuration_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    interval_seconds: int = Field(ge=900, le=86400, strict=True)
    duration_seconds: int = Field(ge=900, le=86400, strict=True)


class RefreshRevokeRequest(HubSpotContract):
    expected_revision: int = Field(ge=1, strict=True)


class RefreshAuthorization(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    revision: int
    status: Literal["authorized", "revoked"]
    actor_id: str
    recorded_at: AwareDatetime
    account_revision: int
    configuration_hash: str
    portal_id: str
    company_id: str
    configuration_revision: int
    mapping_hash: str
    interval_seconds: int
    authorized_at: AwareDatetime
    expires_at: AwareDatetime
    first_due_at: AwareDatetime
    previous_id: UUID | None = None
    policy: Literal["hubspot-staging-refresh-1"] = "hubspot-staging-refresh-1"


class RefreshScheduleView(HubSpotContract):
    organization_id: str
    account_id: UUID
    account_revision: int
    configuration_hash: str
    authorization: RefreshAuthorization | None
    can_authorize: bool
    worker_available: bool = False
    pending_occurrence_id: UUID | None = None


class RefreshAuthorizations:
    def __init__(self, operation):
        self.operation = operation

    def binding(self, account_id):
        connector = self.operation.connector
        settings = connector.settings
        binding = {"portal_id": settings.hubspot_portal_id,
            "company_id": settings.hubspot_company_map.get(str(account_id), ""),
            "configuration_revision": settings.hubspot_configuration_revision,
            "mapping_hash": connector.mapping_hash}
        digest = hashlib.sha256(json.dumps({"organization_id": settings.hubspot_organization_id,
            **binding}, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        return binding, digest

    def latest(self, connection, organization_id, account_id):
        return connection.execute(select(authorizations).where(
            authorizations.c.organization_id == organization_id,
            authorizations.c.account_id == str(account_id))
            .order_by(authorizations.c.revision.desc()).limit(1)).mappings().first()

    def view(self, account_id):
        with self.operation.transaction() as (connection, actor):
            account = self.operation.account(connection, actor, account_id, require_mapping=False)
            row = self.latest(connection, actor.organization_id, account_id)
            _, digest = self.binding(account_id)
            pending = connection.execute(select(occurrences.c.id).where(
                occurrences.c.organization_id == actor.organization_id,
                occurrences.c.account_id == str(account_id), occurrences.c.status == "pending").limit(1)).scalar()
            return RefreshScheduleView(organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, configuration_hash=digest,
                authorization=RefreshAuthorization.model_validate(row["payload"]) if row else None,
                pending_occurrence_id=pending,
                worker_available=bool(self.operation.connector.settings.auth_mode == "session"
                    and self.operation.connector.settings.hubspot_refresh_worker_enabled
                    and self.operation.connector.settings.hubspot_refresh_enabled
                    and self.operation.connector.configured),
                can_authorize=actor.role == "admin" and str(account_id) in self.operation.connector.settings.hubspot_company_map
                    and self.operation.connector.configured
                    and self.operation.connector.settings.hubspot_refresh_enabled)

    def grant(self, account_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            account = self.operation.account(connection, actor, account_id, body.expected_account_revision)
            if not (self.operation.connector.configured
                    and self.operation.connector.settings.hubspot_refresh_enabled):
                raise PolicyDenied("hubspot_refresh_disabled", 503)
            binding, digest = self.binding(account_id)
            if digest != body.expected_configuration_hash:
                raise PolicyDenied("refresh_configuration_changed", 409)
            row = self.latest(connection, actor.organization_id, account_id)
            if (row["revision"] if row else 0) != body.expected_revision:
                raise PolicyDenied("stale_refresh_revision", 409)
            now = datetime.now(UTC)
            session_hash = token_digest(self.operation.token or "")
            expiry = connection.execute(select(sessions.c.expires_at).where(
                sessions.c.token_hash == session_hash, sessions.c.user_id == actor.id)).scalar_one()
            expires_at = min(now + timedelta(seconds=body.duration_seconds), datetime.fromtimestamp(expiry, UTC))
            first_due_at = now + timedelta(seconds=body.interval_seconds)
            if first_due_at >= expires_at:
                raise PolicyDenied("refresh_window_too_short", 409)
            record = RefreshAuthorization(id=uuid4(), organization_id=actor.organization_id,
                account_id=account_id, revision=body.expected_revision + 1, status="authorized",
                actor_id=actor.id, recorded_at=now, account_revision=account.revision,
                configuration_hash=digest, **binding, interval_seconds=body.interval_seconds,
                authorized_at=now, expires_at=expires_at, first_due_at=first_due_at,
                previous_id=row["id"] if row else None)
            self.append(connection, record, session_hash)
            return record

    def revoke(self, account_id, body):
        # Revocation remains available with provider/refresh gates disabled.
        with self.operation.transaction(write=True) as (connection, actor):
            self.operation.account(connection, actor, account_id, require_mapping=False)
            row = self.latest(connection, actor.organization_id, account_id)
            if row is None or row["revision"] != body.expected_revision:
                raise PolicyDenied("stale_refresh_revision", 409)
            previous = RefreshAuthorization.model_validate(row["payload"])
            if previous.status != "authorized":
                raise PolicyDenied("refresh_already_revoked", 409)
            record = previous.model_copy(update={"id": uuid4(), "revision": previous.revision + 1,
                "status": "revoked", "actor_id": actor.id, "recorded_at": datetime.now(UTC),
                "previous_id": previous.id})
            self.append(connection, record, row["session_hash"])
            return record

    def occurrence(self, connection, actor, record_id):
        payload = connection.execute(select(occurrences.c.payload).where(
            occurrences.c.organization_id == actor.organization_id, occurrences.c.id == str(record_id))).scalar()
        if payload is None:
            raise PolicyDenied("record_not_found", 404)
        record = RefreshOccurrence.model_validate(payload)
        account = self.operation.account(connection, actor, record.account_id, require_mapping=False)
        return record, account

    def history(self, account_id):
        with self.operation.transaction() as (connection, actor):
            self.operation.account(connection, actor, account_id, require_mapping=False)
            rows = connection.execute(select(occurrences.c.payload).join(authorizations,
                authorizations.c.id == occurrences.c.authorization_id).where(
                occurrences.c.organization_id == actor.organization_id, occurrences.c.account_id == str(account_id))
                .order_by(authorizations.c.revision.desc(), occurrences.c.slot.desc()).limit(20)).scalars()
            return [RefreshOccurrence.model_validate(payload) for payload in rows]

    def inspect(self, record_id):
        with self.operation.transaction() as (connection, actor):
            record, _ = self.occurrence(connection, actor, record_id)
            return record

    def recovery_readiness(self, record_id):
        with self.operation.transaction() as (connection, actor):
            record, account = self.occurrence(connection, actor, record_id)
            return RefreshRecoveryReadiness(occurrence=record, account_revision=account.revision,
                eligible=actor.role == "admin" and record.status == "pending"
                    and datetime.now(UTC) >= record.worker_deadline_at)

    def recover(self, record_id, body):
        with self.operation.transaction(write=True) as (connection, actor):
            record, account = self.occurrence(connection, actor, record_id)
            now = datetime.now(UTC)
            if (record.status != "pending" or record.revision != body.expected_revision
                    or account.revision != body.expected_account_revision
                    or record.worker_deadline_at != body.expected_worker_deadline_at
                    or now < record.worker_deadline_at):
                raise PolicyDenied("refresh_recovery_unavailable", 409)
            final = record.model_copy(update={"revision": record.revision + 1, "status": "interrupted",
                "finished_at": now, "error_code": "refresh_interrupted", "recovered_by": actor.id,
                "recovered_at": now})
            changed = connection.execute(update(occurrences).where(occurrences.c.id == str(record.id),
                occurrences.c.organization_id == actor.organization_id, occurrences.c.status == "pending")
                .values(status=final.status, payload=final.model_dump(mode="json")))
            if changed.rowcount != 1:
                raise PolicyDenied("refresh_recovery_unavailable", 409)
            return final

    @staticmethod
    def append(connection, record, session_hash):
        connection.execute(authorizations.insert().values(id=str(record.id),
            organization_id=record.organization_id, account_id=str(record.account_id),
            revision=record.revision, session_hash=session_hash, payload=record.model_dump(mode="json")))


class RefreshOccurrence(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    authorization_id: UUID
    authorization_revision: int
    slot: int
    due_at: AwareDatetime
    started_at: AwareDatetime
    worker_deadline_at: AwareDatetime
    sync_run_id: UUID
    revision: int = 1
    status: Literal["pending", "succeeded", "failed", "interrupted"] = "pending"
    finished_at: AwareDatetime | None = None
    error_code: str | None = None
    recovered_by: str | None = None
    recovered_at: AwareDatetime | None = None


class RefreshRecoveryRequest(HubSpotContract):
    expected_revision: int = Field(ge=1, strict=True)
    expected_account_revision: int = Field(ge=1, strict=True)
    expected_worker_deadline_at: AwareDatetime


class RefreshRecoveryReadiness(HubSpotContract):
    occurrence: RefreshOccurrence
    account_revision: int
    eligible: bool


class RefreshWorker:
    """Callable worker protocol; no process/thread or implicit startup scheduling."""
    def __init__(self, store, settings, transport=None, *, clock=None, cancelled=None):
        self.store, self.settings, self.transport = store, settings, transport
        self.clock = clock or (lambda: datetime.now(UTC))
        self.cancelled = cancelled or (lambda: False)

    def execute_due(self, account_id):
        from .hubspot_sync import HubSpotSync

        if self.cancelled():
            raise PolicyDenied("refresh_worker_stopped", 409)
        connector = HubSpot(self.settings, self.transport)
        # This bounded lookup identifies intent only; it grants no authority.
        with self.store.engine.connect() as connection:
            row = connection.execute(select(authorizations).where(
                authorizations.c.organization_id == connector.settings.hubspot_organization_id,
                authorizations.c.account_id == str(account_id))
                .order_by(authorizations.c.revision.desc()).limit(1)).mappings().first()
        if row is None:
            return None
        grant = RefreshAuthorization.model_validate(row["payload"])
        operation = HubSpotSync(self.store, connector, None, session_hash=row["session_hash"])
        service = RefreshAuthorizations(operation)

        def authority(connection, actor):
            if self.cancelled():
                raise PolicyDenied("refresh_worker_stopped", 409)
            now = self.clock()
            latest = service.latest(connection, grant.organization_id, account_id)
            _, digest = service.binding(account_id)
            session_expiry = connection.execute(select(sessions.c.expires_at).where(
                sessions.c.token_hash == row["session_hash"], sessions.c.user_id == actor.id)).scalar()
            if (not connector.configured or not connector.settings.hubspot_refresh_enabled
                    or latest is None or latest["id"] != str(grant.id)
                    or grant.status != "authorized" or actor.id != grant.actor_id
                    or actor.role != "admin" or now < grant.authorized_at or now >= grant.expires_at
                    or session_expiry is None or now.timestamp() >= session_expiry
                    or digest != grant.configuration_hash):
                raise PolicyDenied("refresh_authority_changed", 409)
            operation.account(connection, actor, account_id, grant.account_revision)

        with operation.transaction(write=True) as (connection, actor):
            authority(connection, actor)
            now = self.clock()
            if now < grant.first_due_at:
                return None
            # One current slot, never replay a backlog after downtime.
            slot = int((now - grant.first_due_at).total_seconds() // grant.interval_seconds)
            blocked = connection.execute(select(occurrences.c.id).where(
                occurrences.c.organization_id == grant.organization_id,
                occurrences.c.account_id == str(account_id),
                ((occurrences.c.status == "pending") |
                 ((occurrences.c.authorization_id == str(grant.id)) &
                  ((occurrences.c.slot >= slot) | (occurrences.c.status.in_(["failed", "interrupted"]))))))
                .limit(1)).first()
            if blocked:
                return None
            occurrence = RefreshOccurrence(id=uuid4(), organization_id=grant.organization_id,
                account_id=account_id, authorization_id=grant.id, authorization_revision=grant.revision,
                slot=slot, due_at=grant.first_due_at + timedelta(seconds=slot * grant.interval_seconds),
                started_at=now, worker_deadline_at=min(now + timedelta(seconds=120), grant.expires_at),
                sync_run_id=uuid4())
            connection.execute(occurrences.insert().values(id=str(occurrence.id),
                organization_id=grant.organization_id, account_id=str(account_id),
                authorization_id=str(grant.id), slot=slot, status="pending",
                payload=occurrence.model_dump(mode="json")))

        def guard(connection, actor):
            authority(connection, actor)
            status = connection.execute(select(occurrences.c.status).where(
                occurrences.c.id == str(occurrence.id),
                occurrences.c.organization_id == grant.organization_id)).scalar_one()
            if status != "pending" or self.clock() >= occurrence.worker_deadline_at:
                raise PolicyDenied("refresh_worker_fenced", 409)

        # Any interruption/authority loss leaves the durable claim pending. Never retry.
        run = operation.sync(account_id, grant.account_revision, guard=guard, run_id=occurrence.sync_run_id)
        with operation.transaction(write=True) as (connection, actor):
            guard(connection, actor)
            final = occurrence.model_copy(update={"status": run.status, "finished_at": self.clock(),
                                                   "error_code": run.error_code})
            changed = connection.execute(update(occurrences).where(
                occurrences.c.id == str(occurrence.id), occurrences.c.status == "pending")
                .values(status=final.status, payload=final.model_dump(mode="json")))
            if changed.rowcount != 1:
                raise PolicyDenied("refresh_worker_fenced", 409)
            return final


class RefreshScheduler:
    """Opt-in loop; database occurrence claims remain the cross-process authority."""
    def __init__(self, worker, *, interval_seconds=30):
        self.worker = worker
        self.interval_seconds = interval_seconds
        self.stop_event = Event()
        self.worker.cancelled = self.stop_event.is_set
        self.lock = Lock()
        self.thread = None

    def start(self):
        settings = self.worker.settings
        if (settings.auth_mode != "session" or not settings.hubspot_refresh_enabled
                or not settings.hubspot_refresh_worker_enabled or not HubSpot(settings).configured):
            return False
        with self.lock:
            if self.thread is not None and self.thread.is_alive():
                return False
            self.stop_event.clear()
            self.thread = Thread(target=self.run, name="vitaai-hubspot-refresh", daemon=True)
            self.thread.start()
            return True

    def stop(self):
        self.stop_event.set()
        thread = self.thread
        if thread is not None and thread.ident is not None:
            thread.join(timeout=5)
        return thread is None or not thread.is_alive()

    def run(self):
        while not self.stop_event.wait(self.interval_seconds):
            self.tick()

    def tick(self):
        for account_id in tuple(self.worker.settings.hubspot_company_map):
            if self.stop_event.is_set():
                break
            try:
                self.worker.execute_due(account_id)
            except PolicyDenied:
                continue
            except Exception:  # noqa: BLE001 -- keep the loop alive, log safely, retain pending without retry
                # Never log provider bodies, credentials or arbitrary exception messages.
                logging.getLogger(__name__).warning(
                    "Scheduled HubSpot staging failed; inspect retained occurrence history")
