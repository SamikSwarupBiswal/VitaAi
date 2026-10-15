from pathlib import Path

from sqlalchemy import (
    JSON,
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

from .contracts import Account, Evidence, ModelRun
from .migrate import upgrade
from .pipeline import PipelineRun

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
    Column("payload", JSON, nullable=False),
)


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
                payload=run.model_dump(mode="json"),
            ))

    def get_pipeline(self, organization_id: str, run_id: str) -> PipelineRun | None:
        with self.engine.connect() as connection:
            row = connection.execute(select(pipeline_runs.c.payload).where(
                pipeline_runs.c.organization_id == organization_id, pipeline_runs.c.id == run_id,
            )).scalar()
        return PipelineRun.model_validate(row) if row else None

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

    def account_evidence(self, organization_id: str, account_id: str) -> list[Evidence]:
        with self.engine.connect() as connection:
            rows = connection.execute(select(evidence.c.payload).where(
                evidence.c.organization_id == organization_id,
                evidence.c.account_id == account_id,
            )).scalars().all()
        return [Evidence.model_validate(row) for row in rows]

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
