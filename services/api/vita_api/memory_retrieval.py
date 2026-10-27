"""Explainable deterministic recall; no writes or inference."""
import re
from datetime import UTC, datetime
from typing import Literal
from uuid import UUID

from pydantic import Field
from sqlalchemy import func, select

from .governance import PolicyDenied
from .memory import entries
from .memory_contracts import MemoryEntry
from .scoring import assess
from .storage import selected_evidence
from .workflow_contracts import Hash, WorkflowContract


class RecallRequest(WorkflowContract):
    query: str = Field(default="", max_length=500)
    purpose: Literal["recall", "current_advice"] = "recall"
    expected_snapshot_hash: Hash
    served_ids: tuple[UUID, ...] = Field(default=(), max_length=100)


class RecallItem(WorkflowContract):
    memory: MemoryEntry
    score: int
    relevance: int
    significance: int
    confidence: int
    age_days: int
    decay_penalty: int
    current_snapshot: bool
    reasons: tuple[str, ...]


class RecallResult(WorkflowContract):
    organization_id: str
    account_id: UUID
    snapshot_hash: Hash
    policy: Literal["memory-recall-1"] = "memory-recall-1"
    evaluated_at: datetime
    purpose: Literal["recall", "current_advice"]
    candidate_limit: Literal[100] = 100
    result_limit: Literal[5] = 5
    total_count: int
    inspected_count: int
    has_more: bool
    excluded: dict[str, int]
    caveats: tuple[str, ...]
    items: tuple[RecallItem, ...]


def recall(memory, account_id, body: RecallRequest, *, transaction=None):
    with transaction or memory.transaction() as (connection, actor):
        account = memory.account(connection, actor, account_id)
        facts = selected_evidence(connection, actor.organization_id, account_id)
        now = memory.clock()
        assessment = assess(account, facts, now.astimezone(UTC).date())
        if assessment.snapshot_hash != body.expected_snapshot_hash:
            raise PolicyDenied("memory_snapshot_changed", 409)
        scope = (entries.c.organization_id == actor.organization_id, entries.c.account_id == str(account_id))
        total = connection.execute(select(func.count()).select_from(entries).where(*scope)).scalar_one()
        ids = connection.execute(select(entries.c.id).where(*scope).order_by(entries.c.id).limit(100)).scalars().all()
        excluded, candidates, caveats = {}, [], list(assessment.caveats)

        def exclude(reason):
            excluded[reason] = excluded.get(reason, 0) + 1

        query = set(re.findall(r"\w+", body.query.casefold()))
        for memory_id in ids:
            try:
                item = memory.entry(connection, actor, memory_id)
            except PolicyDenied:
                exclude("unavailable")
                continue
            if item.state != "active":
                exclude(item.state)
                continue
            caveats.extend(item.recommendation.assessment.caveats)
            if item.id in body.served_ids:
                exclude("already_served")
                continue
            age = (now - item.source.started_at).total_seconds()
            if age < 0:
                exclude("future_source")
                continue
            current = (item.context.account.revision == account.revision
                       and item.recommendation.assessment.snapshot_hash == assessment.snapshot_hash)
            if body.purpose == "current_advice" and not current:
                exclude("historical_snapshot")
                continue
            text = " ".join([item.context.account.name, item.recommendation.action.kind,
                             item.recommendation.action.rationale, *[fact.fact for fact in item.context.evidence]])
            tokens = set(re.findall(r"\w+", text.casefold()))
            relevance = len(query & tokens) * 20 if query else 0
            if query and not relevance:
                exclude("query_mismatch")
                continue
            confidence = item.recommendation.assessment.confidence
            significance = max(item.recommendation.assessment.risk, item.recommendation.assessment.opportunity)
            days = int(age // 86400)
            penalty = min(100, days * 2)
            reasons = ("Historical proposal; original sources and dates retained.",
                       "Matches current snapshot." if current else "Historical snapshot; do not use as current advice.",
                       f"Matched {len(query & tokens)} query terms; significance=max(risk,opportunity).",
                       "Confidence is original assessment completeness, not factual certainty.",
                       "Age penalty is 2 points/day capped at100; no source dates refreshed.")
            candidates.append(RecallItem(memory=item, relevance=relevance, significance=significance,
                confidence=confidence, age_days=days, decay_penalty=penalty, current_snapshot=current,
                score=relevance + significance + confidence - penalty, reasons=reasons))
        candidates.sort(key=lambda item: (-item.score, -item.memory.source.started_at.timestamp(), str(item.memory.id)))
        return RecallResult(organization_id=actor.organization_id, account_id=account_id,
            snapshot_hash=assessment.snapshot_hash, evaluated_at=now, purpose=body.purpose, total_count=total,
            inspected_count=len(ids), has_more=total > len(ids), excluded=excluded,
            caveats=tuple(dict.fromkeys([*caveats, "Recall is a bounded stable-ID candidate window, not complete history.",
                "Relevance and decay do not change source confidence, account rank, approval or outcomes."])),
            items=tuple(candidates[:5]))
