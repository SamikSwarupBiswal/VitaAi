"""Durable staging-refresh grants; registration never contacts HubSpot."""
import hashlib
import json
from datetime import UTC, datetime, timedelta
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
)

from .governance import PolicyDenied
from .hubspot import HubSpotContract
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
    worker_available: Literal[False] = False


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
            return RefreshScheduleView(organization_id=actor.organization_id, account_id=account_id,
                account_revision=account.revision, configuration_hash=digest,
                authorization=RefreshAuthorization.model_validate(row["payload"]) if row else None,
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

    @staticmethod
    def append(connection, record, session_hash):
        connection.execute(authorizations.insert().values(id=str(record.id),
            organization_id=record.organization_id, account_id=str(record.account_id),
            revision=record.revision, session_hash=session_hash, payload=record.model_dump(mode="json")))
