from datetime import UTC, datetime
from pathlib import Path

from pydantic import ValidationError
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
    create_engine,
    event,
    func,
    select,
)
from sqlalchemy.engine import make_url

from .contracts import Account, AccountSource, Evidence, ModelRun
from .migrate import upgrade
from .pipeline import PipelineHistory, PipelineRun, PipelineRunSummary

metadata = MetaData()
accounts = Table(
    "accounts", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("external_id", String(100), nullable=False),
    Column("revision", Integer, nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "external_id"),
    UniqueConstraint("organization_id", "id"),
)
evidence = Table(
    "evidence", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("source_record", String(150), nullable=False),
    Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "account_id"],
                         ["accounts.organization_id", "accounts.id"]),
    UniqueConstraint("organization_id", "source_record"),
)
runs = Table(
    "model_runs", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("started_at", String(40), nullable=False),
    Column("payload", JSON, nullable=False),
    ForeignKeyConstraint(["organization_id", "account_id"],
                         ["accounts.organization_id", "accounts.id"]),
)

pipeline_runs = Table(
    "pipeline_runs", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("actor_id", String(80), nullable=True),
    Column("started_at_us", BigInteger, nullable=True),
    Column("payload", JSON, nullable=False),
)


source_versions = Table(
    "account_source_versions", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("account_revision", Integer, nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "account_id", "account_revision"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
)


def selected_source(connection, organization_id, account_id):
    return connection.execute(select(source_versions.c.payload).where(
        source_versions.c.organization_id == organization_id, source_versions.c.account_id == str(account_id))
        .order_by(source_versions.c.account_revision.desc()).limit(1)).scalar()


def selected_evidence(connection, organization_id, account_id):
    source = selected_source(connection, organization_id, account_id)
    if source:
        return [Evidence.model_validate(item) for item in source["evidence"]]
    rows = connection.execute(select(evidence.c.payload).where(
        evidence.c.organization_id == organization_id, evidence.c.account_id == str(account_id))).scalars()
    return [Evidence.model_validate(item) for item in rows]


def pipeline_time(value: datetime) -> int:
    if value.utcoffset() is None:
        raise ValueError("Pipeline history requires an aware original timestamp")
    delta = value.astimezone(UTC) - datetime(1970, 1, 1, tzinfo=UTC)
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


class Store:
    def __init__(self, url: str):
        parsed = make_url(url)
        if parsed.drivername.startswith("sqlite") and parsed.database:
            Path(parsed.database).resolve().parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(url, pool_pre_ping=True)
        if parsed.drivername.startswith("sqlite"):
            @event.listens_for(self.engine, "connect")
            def foreign_keys(connection, _):
                connection.execute("PRAGMA foreign_keys=ON")

    def initialize(self):
        upgrade(self.engine)

    def save_pipeline(self, run: PipelineRun):
        with self.engine.begin() as connection:
            connection.execute(pipeline_runs.insert().values(
                id=run.id, organization_id=run.organization_id, actor_id=run.actor_id,
                started_at_us=pipeline_time(run.started_at),
                payload=run.model_dump(mode="json"),
            ))

    def get_pipeline(self, organization_id: str, run_id: str) -> PipelineRun | None:
        with self.engine.connect() as connection:
            row = connection.execute(select(pipeline_runs.c.payload).where(
                pipeline_runs.c.organization_id == organization_id, pipeline_runs.c.id == run_id,
            )).scalar()
        return PipelineRun.model_validate(row) if row else None

    def list_pipeline_history(self, organization_id: str) -> PipelineHistory:
        # One snapshot for counts and the bounded window, independent of current account facts.
        with self.engine.connect() as connection:
            if self.engine.dialect.name == "sqlite":
                connection.exec_driver_sql("BEGIN")
            else:
                connection = connection.execution_options(isolation_level="REPEATABLE READ")
            scoped = pipeline_runs.c.organization_id == organization_id
            total = connection.execute(select(func.count()).select_from(pipeline_runs).where(scoped)).scalar_one()
            undated = connection.execute(select(func.count()).select_from(pipeline_runs).where(
                scoped, pipeline_runs.c.started_at_us.is_(None))).scalar_one()
            rows = connection.execute(select(pipeline_runs).where(scoped, pipeline_runs.c.started_at_us.is_not(None))
                .order_by(pipeline_runs.c.started_at_us.desc(), pipeline_runs.c.id.desc()).limit(20)).mappings().all()
        items = []
        for row in rows:
            try:
                run = PipelineRun.model_validate(row["payload"])
                inputs = [context.account.id for context in run.contexts]
                selected = [item.account_id for item in run.recommendations]
                if (run.id != row["id"] or run.organization_id != organization_id or run.actor_id != row["actor_id"]
                        or pipeline_time(run.started_at) != row["started_at_us"]
                        or len(set(inputs)) != len(inputs) or len(set(selected)) != len(selected)
                        or not set(selected).issubset(inputs)
                        or any(context.account.organization_id != organization_id
                               or len({fact.id for fact in context.evidence}) != len(context.evidence)
                               or any(fact.organization_id != organization_id or fact.account_id != context.account.id
                                      for fact in context.evidence) for context in run.contexts)):
                    continue
                items.append(PipelineRunSummary(id=run.id, actor_id=run.actor_id, started_at=run.started_at,
                    as_of=run.as_of, request=run.request, status=run.status,
                    input_account_ids=inputs, selected_account_ids=selected))
            except (ValidationError, ValueError):
                # Retain unreadable legacy payloads; disclose omissions without leaking their content.
                continue
        return PipelineHistory(organization_id=organization_id, total_count=total, window_count=len(rows),
                               undated_count=undated, unavailable_count=len(rows) - len(items),
                               has_more=total - undated > len(rows), items=items)

    def seed(self, items: list[tuple[Account, list[Evidence]]]):
        # Seed only missing external identities; restarting never refreshes old facts.
        with self.engine.begin() as connection:
            for account, facts in items:
                existing = connection.execute(select(accounts.c.id).where(
                    accounts.c.organization_id == account.organization_id,
                    accounts.c.external_id == account.external_id,
                )).first()
                if existing:
                    continue
                connection.execute(accounts.insert().values(
                    id=account.id, organization_id=account.organization_id,
                    external_id=account.external_id, revision=account.revision,
                    payload=account.model_dump(mode="json"),
                ))
                for fact in facts:
                    connection.execute(evidence.insert().values(
                        id=fact.id, organization_id=fact.organization_id,
                        account_id=fact.account_id, source_record=fact.source_record,
                        payload=fact.model_dump(mode="json"),
                    ))

    def list_accounts(self, organization_id: str) -> list[Account]:
        with self.engine.connect() as connection:
            rows = connection.execute(select(accounts.c.payload).where(
                accounts.c.organization_id == organization_id,
            )).scalars().all()
        return [Account.model_validate(row) for row in rows]

    def account_records(self, organization_id: str):
        with self.engine.connect() as connection:
            if self.engine.dialect.name == "sqlite":
                connection.exec_driver_sql("BEGIN")
            else:
                connection.begin()
            rows = connection.execute(select(accounts.c.payload).where(
                accounts.c.organization_id == organization_id).order_by(accounts.c.id).with_for_update()).scalars().all()
            result = []
            for row in rows:
                account = Account.model_validate(row)
                source = selected_source(connection, organization_id, account.id)
                result.append((account, selected_evidence(connection, organization_id, account.id),
                               AccountSource.model_validate(source["selection"]) if source else None))
            connection.commit()
            return result

    def account_evidence(self, organization_id: str, account_id: str) -> list[Evidence]:
        with self.engine.connect() as connection:
            return selected_evidence(connection, organization_id, account_id)

    def save_run(self, run: ModelRun):
        with self.engine.begin() as connection:
            connection.execute(runs.insert().values(
                id=run.id, organization_id=run.organization_id, account_id=run.account_id,
                started_at=run.started_at.isoformat(), payload=run.model_dump(mode="json"),
            ))

    def latest_run(self, organization_id: str, account_id: str) -> ModelRun | None:
        with self.engine.connect() as connection:
            row = connection.execute(select(runs.c.payload).where(
                runs.c.organization_id == organization_id,
                runs.c.account_id == account_id,
                func.coalesce(runs.c.payload["task"].as_string(), "analysis") == "analysis",
            ).order_by(runs.c.started_at.desc(), runs.c.id.desc()).limit(1)).scalar()
        return ModelRun.model_validate(row) if row else None
