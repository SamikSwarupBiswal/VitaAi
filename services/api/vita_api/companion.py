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

from .contracts import Account
from .governance import PolicyDenied, digest
from .memory import Memory
from .memory_retrieval import RecallRequest, recall
from .scoring import assess
from .storage import accounts, metadata, selected_evidence
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
    kind: Literal["evidence", "account", "memory", "mission", "outcome", "execution"]
    id: str
    label: str
    source_time: str | None
    text: str


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
    def __init__(self, store, token):
        self.store = store
        self.memory = Memory(store, token)

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
            answer = "Historical memory: " + " ".join(c.text for c in citations) if citations else "No additional eligible memory in this bounded window. Previously served advice is not repeated."
            return "answered" if citations else "unknown", answer, citations, result.caveats, tuple(row.memory.id for row in result.items), None
        if item.persona == "executive_advisor" and re.search(r"\b(portfolio|brief|priority|priorities)\b", message):
            rows = connection.execute(select(accounts.c.payload).where(accounts.c.organization_id == actor.organization_id)
                .order_by(accounts.c.id).limit(50)).scalars().all()
            ranked = []
            for payload in rows:
                current = Account.model_validate(payload)
                if current.organization_id != actor.organization_id:
                    raise PolicyDenied("companion_snapshot_changed", 409)
                result = assess(current, selected_evidence(connection, actor.organization_id, current.id), self.memory.clock().astimezone(UTC).date())
                ranked.append((result.risk, current, result))
            for _, current, result in sorted(ranked, key=lambda row: (-row[0], row[1].id))[:5]:
                citations.append(Citation(kind="account", id=current.id, label=current.name, source_time=current.created_at.isoformat(),
                    text=f"{current.name}: risk {result.risk}, opportunity {result.opportunity}, confidence {result.confidence}%. {result.recommendation} Revision {current.revision}, assessment {result.as_of}, snapshot {result.snapshot_hash}."))
                caveats.extend(result.caveats)
            return "answered" if citations else "unknown", " ".join(c.text for c in citations) or "No accessible accounts.", tuple(citations), tuple(dict.fromkeys([*caveats, "Bounded50-account read; top5 baseline priorities, no inferred customer impact."])), (), None
        if re.search(r"\b(mission|missions|coaching|outcome|receipt|execution)\b", message):
            from .workflow_contracts import Execution, Mission, Outcome
            from .workflow_storage import actions, claims, missions, outcomes
            payloads = connection.execute(select(missions.c.payload).where(missions.c.organization_id == actor.organization_id)
                .order_by(missions.c.id).limit(100)).scalars().all()
            matches = [Mission.model_validate(payload) for payload in payloads]
            matches = [mission for mission in matches if mission.organization_id == actor.organization_id and mission.account_id == item.account_id]
            matches.sort(key=lambda mission: (mission.created_at, str(mission.id)), reverse=True)
            if not matches:
                return "unknown", "No saved mission for this account in the bounded100-record window. Missing history does not establish no past work.", (), (), (), None
            mission = next((mission for mission in matches if mission.status not in {"completed", "superseded"}), matches[0])
            answer = f"Saved mission {mission.id}: {mission.status}; current step {mission.current_step}; revision {mission.revision}. Review blockers in the exact workflow."
            citations.append(Citation(kind="mission", id=str(mission.id), label="Saved mission", source_time=mission.created_at.isoformat(), text=answer))
            if item.persona == "sales_director":
                rows = connection.execute(select(outcomes.c.payload).where(outcomes.c.organization_id == actor.organization_id,
                    outcomes.c.mission_id == str(mission.id)).order_by(outcomes.c.revision.desc()).limit(1)).scalars().all()
                for payload in rows:
                    report = Outcome.model_validate(payload)
                    if report.organization_id != actor.organization_id or report.mission_id != mission.id:
                        raise PolicyDenied("conversation_unavailable", 409)
                    citations.append(Citation(kind="outcome", id=str(report.id), label="Manual report; not verified impact", source_time=report.observed_at.isoformat(), text=f"{report.report.kind}: {report.report.note}"))
                caveats.append("Recorded owner IDs are not a verified seller directory. Review coaching in Outcome; chat grants no approval.")
            if item.persona == "operations_advisor":
                ids = connection.execute(select(actions.c.id).where(actions.c.organization_id == actor.organization_id,
                    actions.c.mission_id == str(mission.id))).scalars().all()
                rows = connection.execute(select(claims.c.payload).where(claims.c.organization_id == actor.organization_id,
                    claims.c.action_id.in_(ids))).scalars().all()
                for payload in rows:
                    claim = Execution.model_validate(payload)
                    if claim.organization_id != actor.organization_id or str(claim.action_id) not in ids:
                        raise PolicyDenied("conversation_unavailable", 409)
                    citations.append(Citation(kind="execution", id=str(claim.id), label="Saved execution; not live health", source_time=claim.created_at.isoformat(), text=f"{claim.status}; attempt {claim.attempt}."))
                caveats.append("Saved execution is not current integration health. Open Execution for authorized diagnostics; no retry follows chat.")
            navigation = Navigation(target="mission", account_id=item.account_id, mission_id=mission.id, step=mission.current_step)
            return "answered", answer + " " + " ".join(c.text for c in citations[1:]), tuple(citations), tuple(caveats), (), navigation
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
