"""Original source/mission memory. Historical narration grants no authority."""
import re
from datetime import UTC
from typing import Literal
from uuid import UUID, uuid4

from pydantic import AwareDatetime, Field, ValidationError
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
)

from .governance import PolicyDenied, digest
from .hubspot import HubSpotObservation
from .hubspot_changes import SourceDetection, detect, detections, snapshot
from .hubspot_normalize import AccountSourceVersion
from .memory import Memory, scoped_content
from .scoring import assess
from .storage import metadata, selected_evidence, source_versions
from .workflow_contracts import (
    ActionPreview,
    CoachingReview,
    Execution,
    Hash,
    Mission,
    Outcome,
    Receipt,
    Record,
    ReviewDecision,
    Revision,
    Text,
    WorkflowContract,
)
from .workflow_storage import (
    actions,
    claims,
    coaching_reviews,
    decisions,
    missions,
    outcomes,
    receipts,
)

source_entries = Table("source_memory_entries", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("source_key", String(64), nullable=False),
    Column("revision", Integer, nullable=False), Column("state", String(20), nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "id"),
    UniqueConstraint("organization_id", "source_key"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]))
source_events = Table("source_memory_events", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("memory_id", String(80), nullable=False), Column("revision", Integer, nullable=False),
    Column("payload", JSON, nullable=False), UniqueConstraint("organization_id", "memory_id", "revision"),
    ForeignKeyConstraint(["organization_id", "memory_id"], ["source_memory_entries.organization_id", "source_memory_entries.id"]))

SourceKind = Literal["source_detection", "mission"]
SourceState = Literal["active", "archived", "invalidated", "superseded"]


class MissionMemoryBundle(WorkflowContract):
    mission: Mission
    actions: tuple[ActionPreview, ...] = Field(max_length=12)
    decisions: tuple[ReviewDecision, ...] = Field(max_length=120)
    executions: tuple[Execution, ...] = Field(max_length=12)
    receipts: tuple[Receipt, ...] = Field(max_length=12)
    outcomes: tuple[Outcome, ...] = Field(max_length=100)
    coaching: tuple[CoachingReview, ...] = Field(max_length=100)


class SourceMemoryPreview(WorkflowContract):
    organization_id: str
    account_id: UUID
    kind: SourceKind
    source_id: UUID
    source_revision: Revision
    source_time: AwareDatetime
    source_actor_id: str
    content_hash: Hash
    original: SourceDetection | MissionMemoryBundle
    summary: str
    caveats: tuple[str, ...]


class SourceMemoryCapture(WorkflowContract):
    kind: SourceKind
    source_id: UUID
    expected_content_hash: Hash


class SourceMemoryEntry(Record):
    account_id: UUID
    captured_by: str
    state: SourceState
    replaced_by_id: UUID | None = None
    source: SourceMemoryPreview
    source_hash: Hash


class SourceMemoryLifecycle(WorkflowContract):
    expected_revision: Revision
    state: SourceState
    reason: Text
    replacement_id: UUID | None = None


class SourceMemoryEvent(Record):
    memory_id: UUID
    actor_id: str
    state: SourceState
    reason: Text | None = None
    replacement_id: UUID | None = None


class SourceMemoryHistory(WorkflowContract):
    organization_id: str
    account_id: UUID
    limit: Literal[20] = 20
    total_count: int
    has_more: bool
    items: tuple[SourceMemoryEntry, ...]


class SourceRecallRequest(WorkflowContract):
    expected_snapshot_hash: Hash
    query: str = Field(default="", max_length=500)
    served_ids: tuple[UUID, ...] = Field(default=(), max_length=100)


class SourceRecallItem(WorkflowContract):
    memory: SourceMemoryEntry
    score: int
    relevance: int
    age_days: int
    decay_penalty: int
    reasons: tuple[str, ...]


class SourceRecallResult(WorkflowContract):
    organization_id: str
    account_id: UUID
    snapshot_hash: Hash
    total_count: int
    inspected_count: int
    has_more: bool
    items: tuple[SourceRecallItem, ...]
    excluded: dict[str, int]
    caveats: tuple[str, ...]


def source_identity(value):
    return digest({"kind": value.kind, "id": str(value.source_id), "revision": value.source_revision,
                   "organization_id": value.organization_id, "account_id": str(value.account_id),
                   "bundle_hash": value.content_hash if value.kind == "mission" else None})


def mission_summary(bundle):
    mission = bundle.mission
    reports = sorted(bundle.outcomes, key=lambda item: item.revision)
    summary = f"Mission {mission.id}: {mission.status}; {mission.current_step}; revision {mission.revision}; owner {mission.owner_id}."
    if reports:
        latest = reports[-1]
        summary += (f" Latest manual outcome revision {latest.revision}, observed {latest.observed_at.isoformat()}: "
                    f"{latest.report.kind}: {latest.report.note}")
        if len(reports) > 1:
            summary += f" {len(reports) - 1} earlier report(s) are superseded historical statements; inspect original records."
    return summary


def newer_source(replacement, original):
    if replacement.kind != original.kind:
        return False
    if original.kind == "mission":
        if replacement.source_id != original.source_id:
            return False
        # Coaching has its own revision and does not advance the mission revision.
        def order(source):
            return (source.source_revision, max((row.revision for row in source.original.coaching), default=0))
        return order(replacement) > order(original)
    return replacement.source_revision > original.source_revision


class SourceMemory(Memory):
    @staticmethod
    def source_snapshot(connection, actor, account_id, source_id):
        from .hubspot_sync import observations
        row = connection.execute(select(source_versions).where(source_versions.c.organization_id == actor.organization_id,
            source_versions.c.account_id == str(account_id), source_versions.c.id == str(source_id))).mappings().first()
        if row is None:
            raise PolicyDenied("memory_source_unavailable", 409)
        version = AccountSourceVersion.model_validate(row["payload"])
        if (version.account_id != account_id or version.account.organization_id != actor.organization_id
                or version.selection.id != row["id"] or version.selection.account_revision != row["account_revision"]):
            raise PolicyDenied("memory_source_unavailable", 409)
        observation = None
        if version.selection.observation_id:
            payload = connection.execute(select(observations.c.payload).where(observations.c.organization_id == actor.organization_id,
                observations.c.account_id == str(account_id), observations.c.id == version.selection.observation_id)).scalar()
            if payload is None:
                raise PolicyDenied("memory_source_unavailable", 409)
            observation = HubSpotObservation.model_validate(payload)
        return snapshot(version, observation)

    @staticmethod
    def load_rows(connection, actor, table, contract, *filters, limit=100):
        rows = connection.execute(select(table).where(table.c.organization_id == actor.organization_id, *filters)
            .order_by(table.c.id).limit(limit + 1).with_for_update()).mappings().all()
        if len(rows) > limit:
            raise PolicyDenied("memory_source_coverage_exceeded", 409)
        result = []
        for row in rows:
            item = contract.model_validate(row["payload"])
            if (item.organization_id != actor.organization_id or str(item.id) != row["id"]
                    or ("revision" in row and item.revision != row["revision"])
                    or any(key in row and getattr(item, key, None) is not None and str(getattr(item, key)) != row[key]
                           for key in ("mission_id", "action_id", "decision_id", "execution_id", "outcome_id", "plan_id"))):
                raise PolicyDenied("memory_source_unavailable", 409)
            result.append(item)
        return tuple(result)

    def preview_in(self, connection, actor, account_id, kind, source_id):
        self.account(connection, actor, account_id)
        try:
            if kind == "source_detection":
                row = connection.execute(select(detections).where(detections.c.organization_id == actor.organization_id,
                    detections.c.account_id == str(account_id), detections.c.id == str(source_id))).mappings().first()
                if row is None:
                    raise PolicyDenied("memory_source_not_found", 404)
                original = SourceDetection.model_validate(row["payload"])
                revision, source_time, source_actor = original.after.account_revision, original.detected_at, original.actor_id
                if (str(original.id) != row["id"] or original.organization_id != actor.organization_id
                        or original.account_id != account_id or revision != row["account_revision"]
                        or str(original.after.source_version_id) != row["source_version_id"]
                        or detect(original.organization_id, str(original.account_id), original.actor_id,
                                  original.before, original.after, original.detected_at) != original
                        or self.source_snapshot(connection, actor, account_id, original.after.source_version_id) != original.after
                        or (original.before is not None and self.source_snapshot(connection, actor, account_id,
                            original.before.source_version_id) != original.before)):
                    raise ValueError("Source binding changed")
                summary = f"Source detection {original.status}: {original.reason}; revision {revision}."
                if original.event:
                    summary += " " + "; ".join(f"{change.field}: {change.before.value} → {change.after.value} ({change.after.unit})" for change in original.event.changes)
            else:
                values = self.load_rows(connection, actor, missions, Mission, missions.c.id == str(source_id), limit=1)
                if not values:
                    raise PolicyDenied("memory_source_not_found", 404)
                mission = values[0]
                if mission.account_id != account_id:
                    raise PolicyDenied("memory_source_not_found", 404)
                prepared = self.load_rows(connection, actor, actions, ActionPreview, actions.c.mission_id == str(source_id), limit=12)
                ids = [str(item.id) for item in prepared]
                executions = self.load_rows(connection, actor, claims, Execution, claims.c.action_id.in_(ids), limit=12)
                reports = self.load_rows(connection, actor, outcomes, Outcome, outcomes.c.mission_id == str(source_id))
                original = MissionMemoryBundle(mission=mission, actions=prepared,
                    decisions=self.load_rows(connection, actor, decisions, ReviewDecision, decisions.c.action_id.in_(ids), limit=120),
                    executions=executions,
                    receipts=self.load_rows(connection, actor, receipts, Receipt, receipts.c.execution_id.in_([str(item.id) for item in executions]), limit=12),
                    outcomes=reports, coaching=self.load_rows(connection, actor, coaching_reviews, CoachingReview, coaching_reviews.c.mission_id == str(source_id)))
                if (any(item.mission_id != mission.id or item.evidence.account_id != account_id for item in original.actions)
                        or any(str(item.action_id) not in ids for item in (*original.decisions, *original.executions, *original.receipts))
                        or any(item.mission_id != mission.id for item in (*original.outcomes, *original.coaching))):
                    raise ValueError("Mission binding changed")
                report_ids = {item.id for item in reports}
                if any(item.outcome_id not in report_ids for item in original.coaching):
                    raise ValueError("Coaching report binding changed")
                decision_by_id = {item.id: item for item in original.decisions}
                execution_by_id = {item.id: item for item in original.executions}
                for execution in original.executions:
                    decision = decision_by_id.get(execution.decision_id)
                    if (decision is None or decision.action_id != execution.action_id or decision.decision != "approved"
                            or decision.action_revision != execution.action_revision or decision.binding_hash != execution.binding_hash):
                        raise ValueError("Execution approval binding changed")
                for receipt in original.receipts:
                    execution = execution_by_id.get(receipt.execution_id)
                    if (execution is None or execution.action_id != receipt.action_id or execution.decision_id != receipt.decision_id
                            or execution.binding_hash != receipt.binding_hash):
                        raise ValueError("Receipt binding changed")
                ordered_reports = sorted(reports, key=lambda item: item.revision)
                if any(item.revision != index or item.supersedes_id != (ordered_reports[index - 2].id if index > 1 else None)
                       for index, item in enumerate(ordered_reports, 1)):
                    raise ValueError("Report correction history changed")
                revision, source_time, source_actor = mission.revision, mission.created_at, mission.owner_id
                summary = mission_summary(original)
            if not scoped_content(original.model_dump(mode="json"), actor.organization_id, account_id):
                raise ValueError("Crossed original scope")
            return SourceMemoryPreview(organization_id=actor.organization_id, account_id=account_id,
                kind=kind, source_id=source_id, source_revision=revision, source_time=source_time,
                source_actor_id=source_actor, content_hash=digest(original), original=original, summary=summary,
                caveats=("Original records and dates are historical; capture does not refresh evidence.",
                         "Manual reports and saved receipts are distinct; no business impact or approval is inferred."))
        except (ValidationError, ValueError, KeyError, TypeError):
            raise PolicyDenied("memory_source_unavailable", 409) from None

    def preview(self, account_id, kind, source_id):
        with self.transaction() as (connection, actor):
            return self.preview_in(connection, actor, account_id, kind, source_id)

    @staticmethod
    def read_entry(connection, actor, memory_id):
        row = connection.execute(select(source_entries).where(source_entries.c.organization_id == actor.organization_id,
            source_entries.c.id == str(memory_id))).mappings().first()
        if row is None:
            raise PolicyDenied("memory_not_found", 404)
        try:
            item = SourceMemoryEntry.model_validate(row["payload"])
            if (str(item.id) != row["id"] or item.organization_id != actor.organization_id
                    or str(item.account_id) != row["account_id"] or item.revision != row["revision"]
                    or item.state != row["state"] or item.source.organization_id != actor.organization_id
                    or item.source.account_id != item.account_id or source_identity(item.source) != row["source_key"]
                    or digest(item.source) != item.source_hash
                    or digest(item.source.original) != item.source.content_hash
                    or not scoped_content(item.source.original.model_dump(mode="json"), actor.organization_id, item.account_id)):
                raise ValueError("Memory binding changed")
        except (ValidationError, ValueError):
            raise PolicyDenied("memory_source_unavailable", 409) from None
        Memory.account(connection, actor, item.account_id)
        return item

    def append(self, connection, actor, item, reason=None):
        event = SourceMemoryEvent(id=uuid4(), organization_id=actor.organization_id, memory_id=item.id,
            actor_id=actor.id, state=item.state, replacement_id=item.replaced_by_id, reason=reason,
            revision=item.revision, created_at=self.clock(), correlation_id=item.correlation_id)
        connection.execute(source_events.insert().values(id=str(event.id), organization_id=actor.organization_id,
            memory_id=str(item.id), revision=item.revision, payload=event.model_dump(mode="json")))

    def capture_source(self, account_id, body):
        with self.transaction(write=True) as (connection, actor):
            source = self.preview_in(connection, actor, account_id, body.kind, body.source_id)
            if source.content_hash != body.expected_content_hash:
                raise PolicyDenied("memory_source_changed", 409)
            key = source_identity(source)
            existing = connection.execute(select(source_entries.c.id).where(source_entries.c.organization_id == actor.organization_id,
                source_entries.c.source_key == key)).scalar()
            if existing:
                item = self.read_entry(connection, actor, existing)
                if item.source != source:
                    raise PolicyDenied("memory_source_changed", 409)
                return item
            item = SourceMemoryEntry(id=uuid4(), organization_id=actor.organization_id, account_id=account_id,
                revision=1, created_at=self.clock(), correlation_id=uuid4(), captured_by=actor.id, state="active",
                source=source, source_hash=digest(source))
            connection.execute(source_entries.insert().values(id=str(item.id), organization_id=actor.organization_id,
                account_id=str(account_id), source_key=key, revision=1, state="active", payload=item.model_dump(mode="json")))
            self.append(connection, actor, item)
            return item

    def source_history(self, account_id):
        with self.transaction() as (connection, actor):
            self.account(connection, actor, account_id)
            scope = (source_entries.c.organization_id == actor.organization_id, source_entries.c.account_id == str(account_id))
            total = connection.execute(select(func.count()).select_from(source_entries).where(*scope)).scalar_one()
            ids = connection.execute(select(source_entries.c.id).where(*scope).order_by(source_entries.c.id).limit(20)).scalars().all()
            return SourceMemoryHistory(organization_id=actor.organization_id, account_id=account_id,
                total_count=total, has_more=total > len(ids), items=tuple(self.read_entry(connection, actor, id) for id in ids))

    def source_get(self, memory_id):
        with self.transaction() as (connection, actor):
            return self.read_entry(connection, actor, memory_id)

    def source_lifecycle(self, memory_id, body):
        with self.transaction(write=True, review=True) as (connection, actor):
            item = self.read_entry(connection, actor, memory_id)
            if item.revision != body.expected_revision or item.state in {"invalidated", "superseded"} or item.state == body.state:
                raise PolicyDenied("memory_revision_changed", 409)
            if body.state == "active" and item.state != "archived":
                raise PolicyDenied("memory_transition_denied", 409)
            if body.state == "superseded":
                if body.replacement_id is None or body.replacement_id == item.id:
                    raise PolicyDenied("memory_replacement_required", 422)
                replacement = self.read_entry(connection, actor, body.replacement_id)
                if (replacement.account_id != item.account_id or replacement.state != "active"
                        or not newer_source(replacement.source, item.source)
                        or replacement.source.content_hash == item.source.content_hash):
                    raise PolicyDenied("memory_replacement_invalid", 409)
            elif body.replacement_id is not None:
                raise PolicyDenied("memory_replacement_invalid", 422)
            revised = item.model_copy(update={"revision": item.revision + 1, "state": body.state,
                                             "replaced_by_id": body.replacement_id})
            connection.execute(source_entries.update().where(source_entries.c.organization_id == actor.organization_id,
                source_entries.c.id == str(item.id), source_entries.c.revision == item.revision).values(
                    revision=revised.revision, state=revised.state, payload=revised.model_dump(mode="json")))
            self.append(connection, actor, revised, body.reason)
            return revised

    def source_audit(self, memory_id):
        with self.transaction() as (connection, actor):
            item = self.read_entry(connection, actor, memory_id)
            rows = connection.execute(select(source_events).where(source_events.c.organization_id == actor.organization_id,
                source_events.c.memory_id == str(memory_id)).order_by(source_events.c.revision)).mappings().all()
            try:
                result = tuple(SourceMemoryEvent.model_validate(row["payload"]) for row in rows)
                if len(result) != item.revision or any(str(value.id) != row["id"] or value.organization_id != actor.organization_id
                        or value.memory_id != item.id or value.revision != index or row["revision"] != index
                        for index, (value, row) in enumerate(zip(result, rows, strict=True), 1)):
                    raise ValueError("Invalid history")
                return result
            except (ValidationError, ValueError):
                raise PolicyDenied("memory_history_unavailable", 409) from None

    def source_recall(self, account_id, body, *, transaction=None):
        with transaction or self.transaction() as (connection, actor):
            account = self.account(connection, actor, account_id)
            assessment = assess(account, selected_evidence(connection, actor.organization_id, account_id), self.clock().astimezone(UTC).date())
            if assessment.snapshot_hash != body.expected_snapshot_hash:
                raise PolicyDenied("memory_snapshot_changed", 409)
            scope = (source_entries.c.organization_id == actor.organization_id, source_entries.c.account_id == str(account_id))
            total = connection.execute(select(func.count()).select_from(source_entries).where(*scope)).scalar_one()
            ids = connection.execute(select(source_entries.c.id).where(*scope).order_by(source_entries.c.id).limit(100)).scalars().all()
            excluded, chosen = {}, []
            query = set(re.findall(r"\w+", body.query.casefold()))
            for memory_id in ids:
                try:
                    item = self.read_entry(connection, actor, memory_id)
                    reason = item.state if item.state != "active" else "already_served" if item.id in body.served_ids else None
                    age = (self.clock() - item.source.source_time).total_seconds()
                    if reason is None and age < 0:
                        reason = "future_source"
                    tokens = set(re.findall(r"\w+", item.source.summary.casefold()))
                    relevance = len(query & tokens) * 20
                    if reason is None and query and not relevance:
                        reason = "query_mismatch"
                except PolicyDenied:
                    reason = "unavailable"
                if reason:
                    excluded[reason] = excluded.get(reason, 0) + 1
                    continue
                days = int(age // 86400)
                penalty = min(days * 2, 100)
                chosen.append(SourceRecallItem(memory=item, score=relevance - penalty, relevance=relevance,
                    age_days=days, decay_penalty=penalty, reasons=(f"{len(query & tokens)} matched query terms at20 points each.",
                    "Historical source; age penalty2/day capped100. No confidence or significance is invented for raw history.")))
            chosen.sort(key=lambda value: (-value.score, -value.memory.source.source_time.timestamp(), str(value.memory.id)))
            return SourceRecallResult(organization_id=actor.organization_id, account_id=account_id,
                snapshot_hash=assessment.snapshot_hash, total_count=total, inspected_count=len(ids), has_more=total > len(ids),
                items=tuple(chosen[:5]), excluded=excluded, caveats=("Bounded100-record stable-ID window; top5 original histories.",
                "Recall never makes historical source/mission state current or authorizes an action.", *assessment.caveats))
