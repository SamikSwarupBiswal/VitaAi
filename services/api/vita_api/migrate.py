"""Versioned schema upgrades, shared by startup and the explicit migration CLI."""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text


def upgrade(engine):
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    with engine.begin() as connection:
        if engine.dialect.name == "postgresql":
            # Serialize schema changes across API processes, released by transaction end.
            connection.execute(text("SELECT pg_advisory_xact_lock(71420863)"))
        config.attributes["connection"] = connection
        command.upgrade(config, "head")


if __name__ == "__main__":
    from .config import Settings
    from .storage import Store

    store = Store(Settings().database_url)
    try:
        upgrade(store.engine)
        print("Database upgraded to the current schema.")
    finally:
        store.engine.dispose()
