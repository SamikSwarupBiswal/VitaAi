"""Append-only human source-quality reports; never machine factual certification."""
import hashlib
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import AwareDatetime, Field, field_validator
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

from .governance import PolicyDenied, canonical_json
from .research import ResearchContract, ResearchSource
from .research_service import research_runs
from .storage import accounts

metadata = MetaData()
accounts.to_metadata(metadata)
research_runs.to_metadata(metadata)
quality_reviews = Table("research_quality_reviews", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("run_id", String(80), nullable=False),
    Column("revision", Integer, nullable=False), Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "id"), UniqueConstraint("organization_id", "run_id", "revision"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
    ForeignKeyConstraint(["run_id"], ["research_runs.id"]))


class QualityRequest(ResearchContract):
    expected_revision: int = Field(strict=True, ge=0)
    expected_run_revision: int = Field(strict=True, ge=1)
    expected_account_revision: int = Field(strict=True, ge=1)
    expected_snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_sources_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_index: int = Field(strict=True, ge=0, le=4)
    source_url: str = Field(min_length=1, max_length=2048)
    identity: Literal["consistent", "namesake_or_unrelated", "uncertain"]
    factual_support: Literal["supported", "contradicted", "uncertain"]
    citation_support: Literal["supports_excerpt", "does_not_support", "uncertain"]
    note: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    references: list[str] = Field(default_factory=list, max_length=5)

    @field_validator("references")
    @classmethod
    def safe_references(cls, values):
        if len(set(values)) != len(values):
            raise ValueError("Reference URLs must be unique")
        for value in values:
            url = urlsplit(value)
            if (len(value) > 2048 or any(char.isspace() or char == "\\" for char in value)
                    or url.scheme != "https" or not url.hostname or url.username or url.password
                    or url.port not in (None, 443) or url.query or url.fragment):
                raise ValueError("Use a bounded public HTTPS reference without credentials or query")
        return values


class QualityReview(ResearchContract):
    id: UUID
    policy: Literal["research-quality-1"] = "research-quality-1"
    basis: Literal["manual_report"] = "manual_report"
    factual_confidence: Literal["unverified"] = "unverified"
    external_execution: Literal[False] = False
    organization_id: str
    account_id: UUID
    run_id: UUID
    run_revision: int
    revision: int
    supersedes_id: UUID | None
    actor_id: str
    created_at: AwareDatetime
    account_revision: int
    snapshot_hash: str
    internal_evidence_ids: list[str]
    sources_hash: str
    source_index: int
    source: ResearchSource
    report: QualityRequest


class QualityInspection(ResearchContract):
    policy: Literal["research-quality-1"] = "research-quality-1"
    organization_id: str
    account_id: UUID
    account_revision: int
    snapshot_hash: str
    run_id: UUID
    run_revision: int
    sources_hash: str
    latest_revision: int
    can_review: bool
    reviews: list[QualityReview] = Field(default_factory=list, max_length=20)
    caveat: str = ("Human source-quality reports retain a reviewer's assessment and references, not independently "
        "verified facts. Matching, schema validity and reviewer labels never alter evidence confidence or workflow authority.")


def sources_hash(run):
    return hashlib.sha256(canonical_json([source.model_dump(mode="json") for source in run.sources])).hexdigest()


class ResearchQuality:
    def __init__(self, operation):
        self.operation = operation

    @staticmethod
    def history(connection, actor, run):
        return [QualityReview.model_validate(payload) for payload in connection.execute(select(quality_reviews.c.payload)
            .where(quality_reviews.c.organization_id == actor.organization_id, quality_reviews.c.run_id == str(run.id))
            .order_by(quality_reviews.c.revision.desc()).limit(20)).scalars()]

    def inspect(self, run_id):
        with self.operation.transaction() as (connection, actor):
            context = self.operation.context_in_transaction(connection, actor, run_id)
            run, view = context.retained_run, context.internal
            history = self.history(connection, actor, run)
            return QualityInspection(organization_id=actor.organization_id, account_id=run.account_id,
                account_revision=view.account.revision, snapshot_hash=view.assessment.snapshot_hash,
                run_id=run.id, run_revision=run.revision, sources_hash=sources_hash(run),
                latest_revision=history[0].revision if history else 0, reviews=list(reversed(history)),
                can_review=actor.role in {"admin", "reviewer"} and run.status == "succeeded"
                    and run.mode == "live" and bool(run.sources))

    def review(self, run_id, body):
        with self.operation.transaction() as (connection, actor):
            if actor.role not in {"admin", "reviewer"}:
                raise PolicyDenied("research_quality_reviewer_required", 403)
            context = self.operation.context_in_transaction(connection, actor, run_id)
            run, view = context.retained_run, context.internal
            history = self.history(connection, actor, run)
            previous = history[0] if history else None
            if (body.expected_revision != (previous.revision if previous else 0)
                    or body.expected_run_revision != run.revision
                    or body.expected_account_revision != view.account.revision
                    or body.expected_snapshot_hash != view.assessment.snapshot_hash
                    or body.expected_sources_hash != sources_hash(run)):
                raise PolicyDenied("research_quality_binding_changed", 409)
            if (run.status != "succeeded" or run.mode != "live" or body.source_index >= len(run.sources)
                    or run.sources[body.source_index].url != body.source_url):
                raise PolicyDenied("research_quality_source_unavailable", 409)
            record = QualityReview(id=uuid4(), organization_id=actor.organization_id,
                account_id=run.account_id, run_id=run.id, run_revision=run.revision,
                revision=body.expected_revision + 1, supersedes_id=previous.id if previous else None,
                actor_id=actor.id, created_at=self.operation.clock(), account_revision=view.account.revision,
                snapshot_hash=view.assessment.snapshot_hash, internal_evidence_ids=sorted(item.id for item in view.evidence),
                sources_hash=body.expected_sources_hash, source_index=body.source_index,
                source=run.sources[body.source_index], report=body)
            connection.execute(quality_reviews.insert().values(id=str(record.id), organization_id=actor.organization_id,
                account_id=str(run.account_id), run_id=str(run.id), revision=record.revision,
                payload=record.model_dump(mode="json")))
            return record
