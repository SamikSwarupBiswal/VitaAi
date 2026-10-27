"""Explicit transactional memory; no provider or workflow actions."""
import hashlib
from contextlib import contextmanager
from datetime import UTC, datetime
from uuid import NAMESPACE_URL, uuid4, uuid5

from pydantic import ValidationError
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    String,
    Table,
    UniqueConstraint,
    func,
    select,
    text,
)

from .contracts import Account
from .governance import PolicyDenied, authorize, digest
from .identity import Actor, sessions, token_digest, users
from .memory_contracts import (
    MemoryCapture,
    MemoryEntry,
    MemoryEvent,
    MemoryHistory,
    MemoryLifecycle,
    MemorySource,
)
from .pipeline import PipelineRun
from .storage import accounts, metadata, pipeline_runs

entries = Table("memory_entries", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("source_key", String(64), nullable=False),
    Column("revision", Integer, nullable=False), Column("state", String(20), nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "id"),
    UniqueConstraint("organization_id", "source_key"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
events = Table("memory_events", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("memory_id", String(80), nullable=False), Column("revision", Integer, nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "memory_id", "revision"),
    ForeignKeyConstraint(["organization_id", "memory_id"], ["memory_entries.organization_id", "memory_entries.id"]))


def source_key(organization_id, pipeline_id, account_id):
    return digest({"organization_id": organization_id, "kind": "pipeline_account",
                   "pipeline_id": str(pipeline_id), "account_id": str(account_id)})


def content_hash(context, recommendation):
    return digest({"context": context.model_dump(mode="json"), "recommendation": recommendation.model_dump(mode="json")})


def scoped_content(value, organization_id, account_id):
    if isinstance(value, dict):
        return all((key != "organization_id" or item == organization_id)
                   and (key != "account_id" or item == str(account_id))
                   and scoped_content(item, organization_id, account_id) for key, item in value.items())
    if isinstance(value, list):
        return all(scoped_content(item, organization_id, account_id) for item in value)
    return True


class Memory:
    def __init__(self, store, session_token, *, clock=None):
        self.engine = store.engine
        self.session_token = session_token
        self.clock = clock or (lambda: datetime.now(UTC))

    @contextmanager
    def transaction(self, *, write=False, review=False):
        # Share workflow's organization lock order, then revalidate membership and session.
        with self.engine.begin() as connection:
            if self.engine.dialect.name == "sqlite":
                connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
            scope = connection.execute(select(users.c.organization_id).join(sessions).where(
                sessions.c.token_hash == token_digest(self.session_token or ""),
                sessions.c.expires_at > int(self.clock().timestamp()), users.c.enabled.is_(True))).scalar()
            if scope is None:
                raise PolicyDenied("authentication_required", 401)
            if self.engine.dialect.name == "postgresql":
                key = int.from_bytes(hashlib.sha256(scope.encode()).digest()[:8], "big", signed=True)
                connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
            row = connection.execute(select(users).join(sessions).where(
                sessions.c.token_hash == token_digest(self.session_token or ""),
                sessions.c.expires_at > int(self.clock().timestamp()), users.c.enabled.is_(True))
                .with_for_update()).mappings().first()
            if row is None:
                raise PolicyDenied("authentication_required", 401)
            actor = Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")})
            if actor.organization_id != scope:
                raise PolicyDenied("membership_changed", 409)
            if write:
                authorize(actor, scope, review=review)
            yield connection, actor

    @staticmethod
    def account(connection, actor, account_id):
        row = connection.execute(select(accounts.c.payload).where(
            accounts.c.organization_id == actor.organization_id, accounts.c.id == str(account_id))
            .with_for_update()).scalar()
        if row is None:
            raise PolicyDenied("account_not_found", 404)
        account = Account.model_validate(row)
        if account.organization_id != actor.organization_id or account.id != str(account_id):
            raise PolicyDenied("memory_source_unavailable", 409)
        return account

    @staticmethod
    def entry(connection, actor, memory_id):
        row = connection.execute(select(entries).where(entries.c.organization_id == actor.organization_id,
            entries.c.id == str(memory_id))).mappings().first()
        if row is None:
            raise PolicyDenied("memory_not_found", 404)
        try:
            item = MemoryEntry.model_validate(row["payload"])
            valid_content = (content_hash(item.context, item.recommendation) == item.source.content_hash
                             and scoped_content(item.model_dump(mode="json"), actor.organization_id, item.account_id))
        except (ValidationError, ValueError):
            raise PolicyDenied("memory_source_unavailable", 409) from None
        if (str(item.id) != row["id"] or item.organization_id != actor.organization_id
                or str(item.account_id) != row["account_id"] or item.revision != row["revision"]
                or item.state != row["state"] or item.context.account.organization_id != actor.organization_id
                or item.context.account.id != str(item.account_id)
                or item.recommendation.account_id != str(item.account_id) or not valid_content
                or row["source_key"] != source_key(actor.organization_id, item.source.pipeline_id, item.account_id)
                or item.id != uuid5(NAMESPACE_URL, "vitaai:memory:" + row["source_key"])
                or len({f.id for f in item.context.evidence}) != len(item.context.evidence)
                or any(f.organization_id != actor.organization_id or f.account_id != str(item.account_id)
                       for f in item.context.evidence)):
            raise PolicyDenied("memory_source_unavailable", 409)
        Memory.account(connection, actor, item.account_id)
        return item

    @staticmethod
    def append_event(connection, item, actor, now, kind, reason=None):
        event = MemoryEvent(id=uuid4(), organization_id=actor.organization_id, created_at=now,
            revision=item.revision, correlation_id=uuid4(), memory_id=item.id, actor_id=actor.id,
            kind=kind, reason=reason)
        connection.execute(events.insert().values(id=str(event.id), organization_id=actor.organization_id,
            memory_id=str(item.id), revision=event.revision, payload=event.model_dump(mode="json")))

    def capture(self, account_id, body: MemoryCapture):
        with self.transaction(write=True) as (connection, actor):
            self.account(connection, actor, account_id)
            payload = connection.execute(select(pipeline_runs.c.payload).where(
                pipeline_runs.c.organization_id == actor.organization_id,
                pipeline_runs.c.id == str(body.pipeline_id))).scalar()
            if payload is None:
                raise PolicyDenied("pipeline_not_found", 404)
            try:
                run = PipelineRun.model_validate(payload)
                contexts = [c for c in run.contexts if c.account.id == str(account_id)]
                recommendations = [r for r in run.recommendations if r.account_id == str(account_id)]
                if (run.id != str(body.pipeline_id) or run.organization_id != actor.organization_id
                        or len(contexts) != 1 or len(recommendations) != 1):
                    raise ValueError("Unavailable original context")
                context, recommendation = contexts[0], recommendations[0]
                if (context.account.organization_id != actor.organization_id
                        or len({f.id for f in context.evidence}) != len(context.evidence)
                        or any(f.organization_id != actor.organization_id or f.account_id != str(account_id)
                               for f in context.evidence)
                        or recommendation.assessment.as_of != run.as_of
                        or not scoped_content(recommendation.model_dump(mode="json"), actor.organization_id, account_id)):
                    raise ValueError("Unavailable original evidence")
                source = MemorySource(pipeline_id=body.pipeline_id, actor_id=run.actor_id,
                    started_at=run.started_at, as_of=run.as_of,
                    content_hash=content_hash(context, recommendation))
            except (ValidationError, ValueError):
                raise PolicyDenied("memory_source_unavailable", 409) from None
            if recommendation.assessment.snapshot_hash != body.expected_snapshot_hash:
                raise PolicyDenied("memory_snapshot_changed", 409)
            key = source_key(actor.organization_id, body.pipeline_id, account_id)
            existing = connection.execute(select(entries.c.id).where(
                entries.c.organization_id == actor.organization_id, entries.c.source_key == key)).scalar()
            if existing:
                item = self.entry(connection, actor, existing)
                if item.source != source:
                    raise PolicyDenied("memory_source_changed", 409)
                return item
            now = self.clock()
            item = MemoryEntry(id=uuid5(NAMESPACE_URL, "vitaai:memory:" + key),
                organization_id=actor.organization_id, account_id=account_id, created_at=now,
                revision=1, correlation_id=uuid4(), captured_by=actor.id, state="active", source=source,
                context=context, recommendation=recommendation)
            connection.execute(entries.insert().values(id=str(item.id), organization_id=actor.organization_id,
                account_id=str(account_id), source_key=key, revision=1, state="active",
                payload=item.model_dump(mode="json")))
            self.append_event(connection, item, actor, now, "captured")
            return item

    def get(self, memory_id):
        with self.transaction() as (connection, actor):
            return self.entry(connection, actor, memory_id)

    def history(self, account_id):
        with self.transaction() as (connection, actor):
            self.account(connection, actor, account_id)
            scope = (entries.c.organization_id == actor.organization_id, entries.c.account_id == str(account_id))
            total = connection.execute(select(func.count()).select_from(entries).where(*scope)).scalar_one()
            ids = connection.execute(select(entries.c.id).where(*scope).order_by(entries.c.id).limit(20)).scalars().all()
            items = [self.entry(connection, actor, memory_id) for memory_id in ids]
            return MemoryHistory(organization_id=actor.organization_id, account_id=account_id,
                                 total_count=total, has_more=total > len(items), items=items)

    def lifecycle(self, memory_id, body: MemoryLifecycle):
        with self.transaction(write=True, review=True) as (connection, actor):
            item = self.entry(connection, actor, memory_id)
            if item.revision != body.expected_revision or item.state == "invalidated" or item.state == body.state:
                raise PolicyDenied("memory_revision_changed", 409)
            revised = item.model_copy(update={"revision": item.revision + 1, "state": body.state})
            connection.execute(entries.update().where(entries.c.organization_id == actor.organization_id,
                entries.c.id == str(item.id), entries.c.revision == item.revision).values(
                revision=revised.revision, state=revised.state, payload=revised.model_dump(mode="json")))
            self.append_event(connection, revised, actor, self.clock(), body.state, body.reason)
            return revised

    def audit(self, memory_id):
        with self.transaction() as (connection, actor):
            item = self.entry(connection, actor, memory_id)
            rows = connection.execute(select(events).where(
                events.c.organization_id == actor.organization_id, events.c.memory_id == str(item.id))
                .order_by(events.c.revision)).mappings().all()
            try:
                result = [MemoryEvent.model_validate(row["payload"]) for row in rows]
                if len(result) != item.revision or any(
                        str(event.id) != row["id"] or event.organization_id != actor.organization_id
                        or event.memory_id != item.id or event.revision != index or row["revision"] != index
                        for index, (event, row) in enumerate(zip(result, rows, strict=True), 1)):
                    raise ValueError("Unavailable lifecycle history")
            except (ValidationError, ValueError):
                raise PolicyDenied("memory_history_unavailable", 409) from None
            return result
