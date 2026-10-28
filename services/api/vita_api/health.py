"""Inert process and schema-head probes; neither establishes provider/release health."""
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Literal

from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util.exc import CommandError
from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import NullPool


class HealthStatus(BaseModel):
    model_config = ConfigDict(extra="forbid")
    schema_version: Literal["1"] = "1"
    status: Literal["alive", "ready", "unavailable"]
    check: Literal["process", "database_schema"]
    code: Literal["process_alive", "database_ready", "database_unavailable", "schema_mismatch"]


def expected_heads() -> tuple[str, ...]:
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    return tuple(ScriptDirectory.from_config(config).get_heads())


@contextmanager
def probe_connection(engine):
    """Use isolated driver timeouts without changing the application's engine.

    Connect/statement/lock limits are driver bounds, not a hard whole-request
    deadline: DNS and PostgreSQL multihost resolution may take additional time.
    In-memory SQLite must reuse its existing engine rather than a different DB.
    """
    dialect = engine.dialect.name
    if dialect == "sqlite":
        database = engine.url.database
        if not database or database == ":memory:" or engine.url.query.get("mode") == "memory":
            with engine.connect() as connection:
                yield connection
            return
        # mode=ro is race-safe: neither a missing path nor a removal during the
        # probe can create an empty replacement database.
        uri = Path(database).resolve().as_uri() + "?mode=ro"
        probe = create_engine("sqlite://", poolclass=NullPool,
            creator=lambda: sqlite3.connect(uri, uri=True, timeout=1))
    elif dialect == "postgresql":
        options = engine.url.query.get("options", "")
        if not isinstance(options, str):
            raise ValueError("Unsupported connection options")
        options += " -cstatement_timeout=2000 -clock_timeout=1000 -cdefault_transaction_read_only=on"
        url = engine.url.update_query_dict({"options": options.strip()})
        probe = create_engine(url, poolclass=NullPool, connect_args={"connect_timeout": 2})
    else:
        raise ValueError("Unsupported database dialect")
    try:
        with probe.connect() as connection:
            yield connection
    finally:
        probe.dispose()


def database_readiness(engine) -> HealthStatus:
    unavailable = HealthStatus(status="unavailable", check="database_schema", code="database_unavailable")
    mismatch = HealthStatus(status="unavailable", check="database_schema", code="schema_mismatch")
    try:
        heads = expected_heads()
        if len(heads) != 1:
            return mismatch
        with probe_connection(engine) as connection:
            if connection.execute(text("SELECT 1")).scalar_one() != 1:
                return unavailable
            if not inspect(connection).has_table("alembic_version"):
                return mismatch
            current = tuple(connection.execute(text("SELECT version_num FROM alembic_version LIMIT 2")).scalars())
            if current != heads:
                return mismatch
    except CommandError:
        return mismatch
    except (OSError, ValueError, SQLAlchemyError):
        return unavailable
    return HealthStatus(status="ready", check="database_schema", code="database_ready")


def install_health_routes(app, store, settings):
    router = APIRouter(prefix="/health")

    @router.get("/live", response_model=HealthStatus)
    def live(response: Response):
        response.headers["Cache-Control"] = "no-store"
        return HealthStatus(status="alive", check="process", code="process_alive")

    @router.get("/ready", response_model=HealthStatus, responses={503: {"model": HealthStatus}})
    def ready(response: Response):
        response.headers["Cache-Control"] = "no-store"
        result = database_readiness(store.engine)
        if result.status != "ready":
            response.status_code = 503
        return result

    app.include_router(router)
