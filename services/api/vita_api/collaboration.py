"""Durable human handoffs. Handoff completion never executes a customer action."""
from typing import Literal
from uuid import UUID, uuid4

from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    String,
    Table,
    UniqueConstraint,
    or_,
    select,
)

from .governance import PolicyDenied, digest
from .identity import Actor, users
from .memory import Memory
from .storage import metadata
from .workflow_contracts import (
    EvidenceIDs,
    Mission,
    Record,
    Reference,
    Revision,
    Text,
    WorkflowContract,
)
from .workflow_storage import missions

handoffs = Table("collaboration_handoffs", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("sender_id", String(80), nullable=False),
    Column("recipient_id", String(80), nullable=False), Column("request_id", String(80), nullable=False),
    Column("request_hash", String(64), nullable=False), Column("revision", Integer, nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "id"),
    UniqueConstraint("organization_id", "sender_id", "request_id"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
handoff_events = Table("collaboration_events", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("handoff_id", String(80), nullable=False), Column("revision", Integer, nullable=False),
    Column("request_id", String(80), nullable=False), Column("request_hash", String(64), nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "handoff_id", "revision"),
    UniqueConstraint("organization_id", "handoff_id", "request_id"),
    ForeignKeyConstraint(["organization_id", "handoff_id"], ["collaboration_handoffs.organization_id", "collaboration_handoffs.id"]))


class HandoffCreate(WorkflowContract):
    request_id: UUID
    mission_id: UUID
    expected_mission_revision: Revision
    recipient_id: UUID
    reason: Text
    evidence_ids: EvidenceIDs


class HandoffTransition(WorkflowContract):
    request_id: UUID
    expected_revision: Revision
    expected_mission_revision: Revision
    status: Literal["accepted", "returned", "completed", "pending"]
    note: Text


class Handoff(Record):
    account_id: UUID
    mission_id: UUID
    mission_revision: Revision
    sender_id: Reference
    recipient_id: Reference
    reason: Text
    evidence_ids: EvidenceIDs
    status: Literal["pending", "accepted", "returned", "completed"]


class HandoffEvent(Record):
    handoff_id: UUID
    actor_id: Reference
    status: Literal["pending", "accepted", "returned", "completed"]
    note: Text
    mission_revision: Revision


class HandoffHistory(WorkflowContract):
    handoff: Handoff
    events: tuple[HandoffEvent, ...]
    current_mission_revision: Revision
    refresh_required: bool


class HandoffList(WorkflowContract):
    items: tuple[Handoff, ...]
    has_more: bool
    limit: Literal[50] = 50


class Recipient(WorkflowContract):
    id: UUID
    username: Reference
    role: Literal["admin", "reviewer", "seller"]


class RecipientList(WorkflowContract):
    items: tuple[Recipient, ...]
    has_more: bool
    limit: Literal[100] = 100


class Collaboration:
    def __init__(self, store, token):
        self.memory = Memory(store, token)

    @staticmethod
    def member(connection, organization, user_id):
        row = connection.execute(select(users).where(users.c.id == str(user_id),
            users.c.organization_id == organization, users.c.enabled.is_(True)).with_for_update()).mappings().first()
        if row is None or row["role"] == "viewer":
            raise PolicyDenied("handoff_member_unavailable", 409)
        return Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")})

    def mission(self, connection, actor, mission_id, account_id):
        row = connection.execute(select(missions).where(missions.c.organization_id == actor.organization_id,
            missions.c.id == str(mission_id)).with_for_update()).mappings().first()
        if row is None:
            raise PolicyDenied("handoff_mission_not_found", 404)
        item = Mission.model_validate(row["payload"])
        if (item.organization_id != actor.organization_id or str(item.id) != row["id"]
                or item.revision != row["revision"] or str(item.account_id) != str(account_id)):
            raise PolicyDenied("handoff_mission_changed", 409)
        self.memory.account(connection, actor, account_id)
        return item

    def entry(self, connection, actor, handoff_id):
        row = connection.execute(select(handoffs).where(handoffs.c.organization_id == actor.organization_id,
            handoffs.c.id == str(handoff_id)).with_for_update()).mappings().first()
        if row is None:
            raise PolicyDenied("handoff_not_found", 404)
        item = Handoff.model_validate(row["payload"])
        if actor.id not in {item.sender_id, item.recipient_id}:
            raise PolicyDenied("handoff_not_found", 404)
        if (item.organization_id != actor.organization_id or str(item.id) != row["id"]
                or item.revision != row["revision"] or str(item.account_id) != row["account_id"]
                or item.sender_id != row["sender_id"] or item.recipient_id != row["recipient_id"]):
            raise PolicyDenied("handoff_unavailable", 409)
        self.memory.account(connection, actor, item.account_id)
        return item

    @staticmethod
    def append(connection, item, actor, request_id, request_hash, note, now):
        event = HandoffEvent(id=uuid4(), organization_id=item.organization_id, created_at=now,
            revision=item.revision, correlation_id=item.correlation_id, handoff_id=item.id,
            actor_id=actor.id, status=item.status, note=note, mission_revision=item.mission_revision)
        connection.execute(handoff_events.insert().values(id=str(event.id), organization_id=item.organization_id,
            handoff_id=str(item.id), revision=item.revision, request_id=str(request_id), request_hash=request_hash,
            payload=event.model_dump(mode="json")))

    def recipients(self):
        with self.memory.transaction() as (connection, actor):
            rows = connection.execute(select(users).where(users.c.organization_id == actor.organization_id,
                users.c.enabled.is_(True), users.c.role != "viewer", users.c.id != actor.id)
                .order_by(users.c.username, users.c.id).limit(101)).mappings().all()
            return RecipientList(items=tuple(Recipient(id=row["id"], username=row["username"], role=row["role"])
                for row in rows[:100]), has_more=len(rows) > 100)

    def create(self, account_id, body: HandoffCreate):
        with self.memory.transaction(write=True) as (connection, actor):
            mission = self.mission(connection, actor, body.mission_id, account_id)
            recipient = self.member(connection, actor.organization_id, body.recipient_id)
            if recipient.id == actor.id:
                raise PolicyDenied("handoff_requires_another_member", 422)
            request_hash = digest({"account_id": str(account_id), "body": body.model_dump(mode="json")})
            existing = connection.execute(select(handoffs).where(handoffs.c.organization_id == actor.organization_id,
                handoffs.c.sender_id == actor.id, handoffs.c.request_id == str(body.request_id))).mappings().first()
            if existing:
                if existing["request_hash"] != request_hash:
                    raise PolicyDenied("handoff_request_conflict", 409)
                return self.entry(connection, actor, existing["id"])
            if mission.revision != body.expected_mission_revision:
                raise PolicyDenied("handoff_mission_changed", 409)
            if not set(body.evidence_ids).issubset(mission.evidence.evidence_ids):
                raise PolicyDenied("handoff_evidence_changed", 409)
            item = Handoff(id=uuid4(), organization_id=actor.organization_id, created_at=self.memory.clock(),
                revision=1, correlation_id=uuid4(), account_id=account_id, mission_id=mission.id,
                mission_revision=mission.revision, sender_id=actor.id, recipient_id=recipient.id,
                reason=body.reason, evidence_ids=body.evidence_ids, status="pending")
            connection.execute(handoffs.insert().values(id=str(item.id), organization_id=actor.organization_id,
                account_id=str(account_id), sender_id=actor.id, recipient_id=recipient.id,
                request_id=str(body.request_id), request_hash=request_hash, revision=1, payload=item.model_dump(mode="json")))
            self.append(connection, item, actor, body.request_id, request_hash, body.reason, item.created_at)
            return item

    def list(self, account_id):
        with self.memory.transaction() as (connection, actor):
            self.memory.account(connection, actor, account_id)
            ids = connection.execute(select(handoffs.c.id).where(handoffs.c.organization_id == actor.organization_id,
                handoffs.c.account_id == str(account_id), or_(handoffs.c.sender_id == actor.id,
                handoffs.c.recipient_id == actor.id)).order_by(handoffs.c.id.desc()).limit(51)).scalars().all()
            return HandoffList(items=tuple(self.entry(connection, actor, item) for item in ids[:50]), has_more=len(ids) > 50)

    def history(self, handoff_id):
        with self.memory.transaction() as (connection, actor):
            item = self.entry(connection, actor, handoff_id)
            mission = self.mission(connection, actor, item.mission_id, item.account_id)
            rows = connection.execute(select(handoff_events).where(handoff_events.c.organization_id == actor.organization_id,
                handoff_events.c.handoff_id == str(item.id)).order_by(handoff_events.c.revision)).mappings().all()
            events = tuple(HandoffEvent.model_validate(row["payload"]) for row in rows)
            if len(events) != item.revision or any(event.revision != index or row["revision"] != index
                    or event.handoff_id != item.id or event.organization_id != actor.organization_id
                    for index, (event, row) in enumerate(zip(events, rows, strict=True), 1)):
                raise PolicyDenied("handoff_history_unavailable", 409)
            return HandoffHistory(handoff=item, events=events, current_mission_revision=mission.revision,
                refresh_required=mission.revision != item.mission_revision)

    def transition(self, handoff_id, body: HandoffTransition):
        with self.memory.transaction(write=True) as (connection, actor):
            item = self.entry(connection, actor, handoff_id)
            self.member(connection, actor.organization_id, item.sender_id)
            self.member(connection, actor.organization_id, item.recipient_id)
            mission = self.mission(connection, actor, item.mission_id, item.account_id)
            request_hash = digest(body.model_dump(mode="json"))
            prior = connection.execute(select(handoff_events.c.request_hash).where(
                handoff_events.c.organization_id == actor.organization_id, handoff_events.c.handoff_id == str(item.id),
                handoff_events.c.request_id == str(body.request_id))).scalar()
            if prior:
                if prior != request_hash:
                    raise PolicyDenied("handoff_request_conflict", 409)
                return item
            if item.revision != body.expected_revision or mission.revision != body.expected_mission_revision:
                raise PolicyDenied("handoff_revision_changed", 409)
            if item.revision >= 100:
                raise PolicyDenied("handoff_history_limit", 409)
            recipient_step = actor.id == item.recipient_id and ((item.status == "pending" and body.status in {"accepted", "returned"})
                or (item.status == "accepted" and body.status in {"completed", "returned"}))
            sender_step = actor.id == item.sender_id and item.status == "returned" and body.status == "pending"
            if not (recipient_step or sender_step):
                raise PolicyDenied("handoff_transition_denied", 403)
            # Explicit sender resend is the only operation that can bind changed mission content.
            if mission.revision != item.mission_revision and not sender_step and body.status != "returned":
                raise PolicyDenied("handoff_refresh_required", 409)
            if body.status != "returned" and not set(item.evidence_ids).issubset(mission.evidence.evidence_ids):
                raise PolicyDenied("handoff_evidence_changed", 409)
            revised = item.model_copy(update={"revision": item.revision + 1, "status": body.status,
                "mission_revision": mission.revision})
            changed = connection.execute(handoffs.update().where(handoffs.c.organization_id == actor.organization_id,
                handoffs.c.id == str(item.id), handoffs.c.revision == item.revision).values(
                revision=revised.revision, payload=revised.model_dump(mode="json")))
            if changed.rowcount != 1:
                raise PolicyDenied("handoff_revision_changed", 409)
            self.append(connection, revised, actor, body.request_id, request_hash, body.note, self.memory.clock())
            return revised
