"""Evidence-bound companion without action authority."""
import re
from contextlib import nullcontext
from datetime import UTC
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
    select,
)

from .governance import PolicyDenied, digest
from .memory import Memory
from .memory_retrieval import RecallRequest, recall
from .memory_sources import SourceMemory, SourceRecallRequest
from .scoring import assess
from .storage import metadata, selected_evidence
from .workflow_contracts import Hash, Record, Revision, Text, WorkflowContract

sessions = Table("companion_sessions", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("actor_id", String(80), nullable=False),
    Column("revision", Integer, nullable=False), Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "id"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
turns = Table("companion_turns", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("session_id", String(80), nullable=False), Column("request_id", String(80), nullable=False),
    Column("number", Integer, nullable=False), Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "session_id", "request_id"), UniqueConstraint("organization_id", "session_id", "number"),
    ForeignKeyConstraint(["organization_id", "session_id"], ["companion_sessions.organization_id", "companion_sessions.id"]))

Persona = Literal["companion", "executive_advisor", "mission_guide", "sales_director", "operations_advisor"]


class ConversationStart(WorkflowContract):
    expected_snapshot_hash: Hash
    persona: Persona = "companion"


class Conversation(Record):
    actor_id: str
    account_id: UUID
    snapshot_hash: Hash
    persona: Persona


class TurnRequest(WorkflowContract):
    expected_revision: Revision
    expected_snapshot_hash: Hash
    request_id: UUID
    message: Text


class Citation(WorkflowContract):
    kind: Literal["evidence", "account", "memory", "mission", "outcome", "execution", "source_change", "coaching"]
    id: str
    label: str
    source_time: str | None
    text: str
    account_snapshot_hash: Hash | None = None


class Navigation(WorkflowContract):
    target: Literal["account", "evidence", "mission"]
    account_id: UUID
    mission_id: UUID | None = None
    step: Literal["Review", "Evidence", "Outreach", "CRM Note", "Approval", "Execution", "Outcome"] | None = None


class Turn(Record):
    session_id: UUID
    request_id: UUID
    request_hash: Hash
    number: int
    message: str
    status: Literal["answered", "unknown", "authority_denied"]
    mode: Literal["deterministic_sourced"] = "deterministic_sourced"
    answer: str
    citations: tuple[Citation, ...]
    caveats: tuple[str, ...]
    recalled_ids: tuple[UUID, ...] = ()
    navigation: Navigation | None = None


class ConversationHistory(WorkflowContract):
    conversation: Conversation
    turns: tuple[Turn, ...]
    limit: Literal[30] = 30


class Companion:
    def __init__(self, store, token, settings=None):
        self.store = store
        self.memory = Memory(store, token)
        self.settings = settings

    def current(self, connection, actor, account_id, expected):
        account = self.memory.account(connection, actor, account_id)
        facts = selected_evidence(connection, actor.organization_id, account_id)
        if len({fact.id for fact in facts}) != len(facts) or any(
                fact.organization_id != actor.organization_id or fact.account_id != str(account_id) for fact in facts):
            raise PolicyDenied("companion_evidence_unavailable", 409)
        assessment = assess(account, facts, self.memory.clock().astimezone(UTC).date())
        if assessment.snapshot_hash != expected:
            raise PolicyDenied("companion_snapshot_changed", 409)
        return account, facts, assessment

    def start(self, account_id, body: ConversationStart):
        with self.memory.transaction(write=True) as (connection, actor):
            self.current(connection, actor, account_id, body.expected_snapshot_hash)
            item = Conversation(id=uuid4(), organization_id=actor.organization_id, actor_id=actor.id,
                account_id=account_id, snapshot_hash=body.expected_snapshot_hash, persona=body.persona,
                revision=1, created_at=self.memory.clock(), correlation_id=uuid4())
            connection.execute(sessions.insert().values(id=str(item.id), organization_id=actor.organization_id,
                actor_id=actor.id, account_id=str(account_id), revision=1, payload=item.model_dump(mode="json")))
            return item

    def get(self, connection, actor, session_id):
        row = connection.execute(select(sessions).where(sessions.c.organization_id == actor.organization_id,
            sessions.c.actor_id == actor.id, sessions.c.id == str(session_id))).mappings().first()
        if row is None:
            raise PolicyDenied("conversation_not_found", 404)
        item = Conversation.model_validate(row["payload"])
        if (str(item.id) != row["id"] or item.organization_id != actor.organization_id or item.actor_id != actor.id
                or str(item.account_id) != row["account_id"] or item.revision != row["revision"]):
            raise PolicyDenied("conversation_unavailable", 409)
        self.memory.account(connection, actor, item.account_id)
        return item

    @staticmethod
    def read_turns(connection, actor, item):
        rows = connection.execute(select(turns).where(turns.c.organization_id == actor.organization_id,
            turns.c.session_id == str(item.id)).order_by(turns.c.number)).mappings().all()
        values = tuple(Turn.model_validate(row["payload"]) for row in rows)
        if len(values) != item.revision - 1 or len(values) > 30 or any(
                value.organization_id != actor.organization_id or value.session_id != item.id or str(value.id) != row["id"]
                or value.number != n or row["number"] != n or str(value.request_id) != row["request_id"]
                for n, (value, row) in enumerate(zip(values, rows, strict=True), 1)):
            raise PolicyDenied("conversation_unavailable", 409)
        return values

    def history(self, session_id):
        with self.memory.transaction() as (connection, actor):
            item = self.get(connection, actor, session_id)
            return ConversationHistory(conversation=item, turns=self.read_turns(connection, actor, item))

    def list(self, account_id):
        with self.memory.transaction() as (connection, actor):
            self.memory.account(connection, actor, account_id)
            ids = connection.execute(select(sessions.c.id).where(sessions.c.organization_id == actor.organization_id,
                sessions.c.actor_id == actor.id, sessions.c.account_id == str(account_id)).order_by(sessions.c.id).limit(20)).scalars().all()
            return [self.get(connection, actor, session_id) for session_id in ids]

    def answer(self, connection, actor, item, body, prior):
        account, facts, assessment = self.current(connection, actor, item.account_id, item.snapshot_hash)
        message = body.message.casefold()
        citations, caveats = [], list(assessment.caveats)
        if re.search(r"\b(approve|execute|send|delete|ignore|override)\b", message):
            return "authority_denied", "Chat cannot authorize or execute actions. Use the exact reviewed web workflow.", (), (), (), None
        if re.search(r"\b(memory|remember|recall|history)\b", message):
            served = tuple(dict.fromkeys(memory_id for turn in prior for memory_id in turn.recalled_ids))[-100:]
            result = recall(self.memory, item.account_id, RecallRequest(expected_snapshot_hash=item.snapshot_hash,
                served_ids=served), transaction=nullcontext((connection, actor)))
            citations = tuple(Citation(kind="memory", id=str(row.memory.id), label="Historical proposal",
                source_time=row.memory.source.started_at.isoformat(), text=row.memory.recommendation.action.rationale) for row in result.items)
            histories = SourceMemory(self.store, self.memory.session_token, clock=self.memory.clock).source_recall(
                item.account_id, SourceRecallRequest(expected_snapshot_hash=item.snapshot_hash, served_ids=served),
                transaction=nullcontext((connection, actor)))
            citations += tuple(Citation(kind="memory", id=str(row.memory.id), label="Historical source/mission record",
                source_time=row.memory.source.source_time.isoformat(), text=row.memory.source.summary) for row in histories.items)
            answer = "Historical memory: " + " ".join(c.text for c in citations) if citations else "No additional eligible memory in this bounded window. Previously served advice is not repeated."
            return ("answered" if citations else "unknown", answer, citations,
                tuple(dict.fromkeys((*result.caveats, *histories.caveats))),
                tuple(row.memory.id for row in (*result.items, *histories.items)), None)
        from .workforce import present
        specialized = present(self, connection, actor, item, message)
        if specialized is not None:
            return specialized
        if re.search(r"\b(mission|missions|coaching|outcome|receipt|execution)\b", message):
            from .workforce import mission_advice
            return mission_advice(self, connection, actor, item, message)
        if re.search(r"\b(risk|health|opportunity|renewal|evidence|source|sources|brief|summary|why|help)\b", message):
            citations = tuple(Citation(kind="evidence", id=fact.id, label=fact.source, source_time=fact.observed_at.isoformat(), text=fact.fact) for fact in facts)
            answer = (f"{account.name}: health {assessment.health}, risk {assessment.risk}, opportunity {assessment.opportunity}. "
                f"Completeness confidence {assessment.confidence}%, not factual certainty. {assessment.recommendation} "
                f"Annual value {account.annual_value if account.annual_value is not None else 'Unknown'}; renewal {account.renewal_date or 'Unknown'}. "
                + " ".join(fact.fact for fact in facts))
            return "answered" if facts else "unknown", answer, citations, tuple(caveats), (), Navigation(target="evidence", account_id=item.account_id)
        return "unknown", "I cannot support that question from this workspace. Ask about risk, evidence, memory or saved missions. No unrelated account is substituted.", (), tuple(caveats), (), None

    def turn(self, session_id, body: TurnRequest):
        with self.memory.transaction(write=True) as (connection, actor):
            item = self.get(connection, actor, session_id)
            prior = self.read_turns(connection, actor, item)
            request_hash = digest(body)
            previous = next((turn for turn in prior if turn.request_id == body.request_id), None)
            if previous:
                if previous.request_hash != request_hash:
                    raise PolicyDenied("conversation_request_conflict", 409)
                return previous
            if item.revision != body.expected_revision or item.snapshot_hash != body.expected_snapshot_hash:
                raise PolicyDenied("conversation_revision_changed", 409)
            if len(prior) >= 30:
                raise PolicyDenied("conversation_limit_reached", 409)
            status, answer, citations, caveats, recalled_ids, navigation = self.answer(connection, actor, item, body, prior)
            value = Turn(id=uuid4(), organization_id=actor.organization_id, session_id=item.id, request_id=body.request_id,
                request_hash=request_hash, number=len(prior) + 1, revision=1, message=body.message, status=status,
                answer=answer, citations=citations, caveats=caveats, recalled_ids=recalled_ids, navigation=navigation,
                created_at=self.memory.clock(), correlation_id=uuid4())
            connection.execute(turns.insert().values(id=str(value.id), organization_id=actor.organization_id,
                session_id=str(item.id), request_id=str(body.request_id), number=value.number, payload=value.model_dump(mode="json")))
            revised = item.model_copy(update={"revision": item.revision + 1})
            connection.execute(sessions.update().where(sessions.c.organization_id == actor.organization_id,
                sessions.c.id == str(item.id), sessions.c.revision == item.revision).values(revision=revised.revision,
                payload=revised.model_dump(mode="json")))
            return value
