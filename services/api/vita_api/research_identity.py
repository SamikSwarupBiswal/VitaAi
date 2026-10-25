"""Append-only per-source identity decisions under current authenticated review authority."""
from uuid import uuid4

from sqlalchemy import (
    JSON,
    BigInteger,
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
from .research_identity_contracts import (
    IdentityDecision,
    IdentityInspection,
    IdentityRequest,
    identity_sources_hash,
)
from .research_service import research_runs
from .storage import accounts

metadata = MetaData()
accounts.to_metadata(metadata)
research_runs.to_metadata(metadata)
identity_decisions = Table("research_identity_decisions", metadata,
    Column("id", String(80), primary_key=True), Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False), Column("run_id", String(80), nullable=False),
    Column("source_index", Integer, nullable=False), Column("revision", Integer, nullable=False),
    Column("created_at", BigInteger, nullable=False), Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "run_id", "source_index", "revision"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
    ForeignKeyConstraint(["run_id"], ["research_runs.id"]))


class ResearchIdentity:
    def __init__(self, operation):
        self.operation = operation

    @staticmethod
    def latest(connection, run):
        # Authoritative per-source lookup is independent of the bounded displayed history.
        result = []
        for index in range(len(run.sources)):
            payload = connection.execute(select(identity_decisions.c.payload).where(
                identity_decisions.c.organization_id == run.organization_id,
                identity_decisions.c.run_id == str(run.id), identity_decisions.c.source_index == index)
                .order_by(identity_decisions.c.revision.desc()).limit(1)).scalar()
            if payload is not None:
                result.append(IdentityDecision.model_validate(payload))
        return result

    @staticmethod
    def eligible(context):
        return context.status in {"usable", "no_usable_sources"} and bool(context.retained_run.sources)

    def inspect(self, run_id):
        with self.operation.transaction() as (connection, actor):
            context = self.operation.context_in_transaction(connection, actor, run_id)
            run, view = context.retained_run, context.internal
            history = [IdentityDecision.model_validate(payload) for payload in connection.execute(
                select(identity_decisions.c.payload).where(identity_decisions.c.organization_id == actor.organization_id,
                    identity_decisions.c.run_id == str(run.id))
                .order_by(identity_decisions.c.created_at.desc(), identity_decisions.c.id.desc()).limit(20)).scalars()]
            return IdentityInspection(organization_id=actor.organization_id, account_id=run.account_id,
                account_revision=view.account.revision, snapshot_hash=view.assessment.snapshot_hash,
                run_id=run.id, run_revision=run.revision, sources_hash=identity_sources_hash(run),
                can_review=actor.role in {"admin", "reviewer"} and self.eligible(context),
                decisions=self.latest(connection, run), history=list(reversed(history)))

    def review(self, run_id, body: IdentityRequest):
        with self.operation.transaction() as (connection, actor):
            # Resolve scope before disclosing role-dependent source state.
            context = self.operation.context_in_transaction(connection, actor, run_id)
            if actor.role not in {"admin", "reviewer"}:
                raise PolicyDenied("research_identity_reviewer_required", 403)
            run, view = context.retained_run, context.internal
            previous = next((item for item in self.latest(connection, run) if item.source_index == body.source_index), None)
            if (body.expected_revision != (previous.revision if previous else 0)
                    or body.expected_run_revision != run.revision
                    or body.expected_account_revision != view.account.revision
                    or body.expected_snapshot_hash != view.assessment.snapshot_hash
                    or body.expected_sources_hash != identity_sources_hash(run)):
                raise PolicyDenied("research_identity_binding_changed", 409)
            if not self.eligible(context) or body.source_index >= len(run.sources):
                raise PolicyDenied("research_identity_source_unavailable", 409)
            source = run.sources[body.source_index]
            if (source.url != body.source_url or not any(body.source_subject in text for text in (source.title, source.text))):
                raise PolicyDenied("research_identity_subject_changed", 409)
            now = self.operation.clock()
            record = IdentityDecision(id=uuid4(), organization_id=actor.organization_id,
                account_id=run.account_id, account_revision=view.account.revision, snapshot_hash=view.assessment.snapshot_hash,
                run_id=run.id, run_revision=run.revision, target=run.target, sources_hash=body.expected_sources_hash,
                source_index=body.source_index, source=source, revision=body.expected_revision + 1,
                supersedes_id=previous.id if previous else None, actor_id=actor.id, created_at=now, report=body)
            connection.execute(identity_decisions.insert().values(id=str(record.id), organization_id=actor.organization_id,
                account_id=str(run.account_id), run_id=str(run.id), source_index=body.source_index,
                revision=record.revision, created_at=int(now.timestamp() * 1_000_000), payload=record.model_dump(mode="json")))
            return record
