"""Versioned schema upgrades, shared by startup and the explicit migration CLI."""
from pathlib import Path

from alembic import command
from alembic.config import Config
from sqlalchemy import text


def upgrade(engine):
    config = Config()
    config.set_main_option("script_location", str(Path(__file__).parent.parent / "migrations"))
    with engine.connect() as connection:
        sqlite = engine.dialect.name == "sqlite"
        try:
            if sqlite:
                # SQLite requires this outside the transaction when rebuilding referenced tables.
                connection.exec_driver_sql("PRAGMA foreign_keys=OFF")
                connection.commit()
                connection.exec_driver_sql("BEGIN IMMEDIATE")
            else:
                connection.begin()
                connection.execute(text("SELECT pg_advisory_xact_lock(71420863)"))
            config.attributes["connection"] = connection
            command.upgrade(config, "head")
            if sqlite and connection.exec_driver_sql("PRAGMA foreign_key_check").first():
                raise RuntimeError("Migration violates foreign key constraints")
            connection.commit()
        except BaseException:
            connection.rollback()
            raise
        finally:
            if sqlite:
                connection.exec_driver_sql("PRAGMA foreign_keys=ON")
                connection.commit()


if __name__ == "__main__":
    from .config import Settings
    from .storage import Store

    store = Store(Settings().database_url)
    try:
        upgrade(store.engine)
        print("Database upgraded to the current schema.")
    finally:
        store.engine.dispose()
