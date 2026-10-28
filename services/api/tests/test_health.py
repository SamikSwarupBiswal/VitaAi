"""Safe probes over isolated stores; no provider or existing runtime is accessed."""
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.pool import StaticPool
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.health import (
    database_readiness,
    expected_heads,
    install_health_routes,
    probe_connection,
)
from vita_api.migrate import upgrade
from vita_api.sample import sample_records
from vita_api.storage import Store


class HealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.path = Path(self.temp.name) / "health #state.sqlite"
        self.store = Store(f"sqlite:///{self.path.as_posix()}")
        self.app = FastAPI()
        install_health_routes(self.app, self.store, None)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.store.engine.dispose()
        self.temp.cleanup()

    def initialize(self):
        self.store.initialize()
        self.store.seed(sample_records(datetime(2026, 10, 28, tzinfo=UTC)))

    def snapshot(self):
        metadata = MetaData()
        metadata.reflect(self.store.engine)
        with self.store.engine.connect() as connection:
            return {table.name: list(connection.execute(select(table).order_by(*table.primary_key.columns)).mappings())
                    for table in metadata.sorted_tables}

    def test_liveness_is_storage_independent_and_probes_are_get_only(self):
        with patch("vita_api.health.database_readiness", side_effect=AssertionError("Liveness must not inspect storage")):
            response = self.client.get("/health/live")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"schema_version": "1", "status": "alive", "check": "process", "code": "process_alive"})
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertFalse(self.path.exists())
        for path in ("/health/live", "/health/ready"):
            self.assertEqual(self.client.post(path).status_code, 405)
            self.assertEqual(self.client.head(path).status_code, 405)

    def test_readiness_does_not_create_a_missing_database(self):
        response = self.client.get("/health/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "database_unavailable")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertFalse(self.path.exists())

    def test_application_installs_probes_and_preserves_legacy_health(self):
        app = create_app(Settings(_env_file=None, database_url=str(self.store.engine.url)))
        with TestClient(app) as client:
            self.assertEqual(client.get("/health/live").json()["code"], "process_alive")
            self.assertEqual(client.get("/health/ready").json()["code"], "database_ready")
            legacy = client.get("/health")
            self.assertEqual(legacy.status_code, 200)
            self.assertEqual(legacy.json()["status"], "ok")
            with self.store.engine.begin() as connection:
                connection.execute(text("DELETE FROM alembic_version"))
            unavailable = client.get("/health/ready")
            self.assertEqual(unavailable.status_code, 503)
            self.assertEqual(unavailable.json()["code"], "schema_mismatch")

    def test_current_schema_is_ready_and_all_business_rows_remain_unchanged(self):
        self.initialize()
        before = self.snapshot()
        for _ in range(2):
            response = self.client.get("/health/ready")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json(), {"schema_version": "1", "status": "ready", "check": "database_schema", "code": "database_ready"})
        self.assertEqual(self.snapshot(), before)
        with probe_connection(self.store.engine) as connection, self.assertRaises(SQLAlchemyError):
            connection.execute(text("DELETE FROM alembic_version"))
        self.assertEqual(self.snapshot(), before)

    def test_missing_schema_stays_missing_without_migration_or_repair(self):
        with self.store.engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        self.assertFalse(inspect(self.store.engine).has_table("alembic_version"))
        response = self.client.get("/health/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "schema_mismatch")
        self.assertFalse(inspect(self.store.engine).has_table("alembic_version"))

    def test_empty_outdated_and_multiple_schema_heads_are_not_ready(self):
        self.initialize()
        for versions in ((), ("old-head",), (expected_heads()[0], "foreign-head")):
            with self.store.engine.begin() as connection:
                connection.execute(text("DELETE FROM alembic_version"))
                for version in versions:
                    connection.execute(text("INSERT INTO alembic_version(version_num) VALUES(:version)"), {"version": version})
            before = self.snapshot()
            response = self.client.get("/health/ready")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["code"], "schema_mismatch")
            self.assertEqual(self.snapshot(), before)

    def test_connection_errors_are_safe_and_source_head_conflict_is_not_repaired(self):
        private = "synthetic-private-credential-and-database-url"
        with patch("vita_api.health.probe_connection", side_effect=SQLAlchemyError(private)):
            response = self.client.get("/health/ready")
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json()["code"], "database_unavailable")
        self.assertNotIn(private, response.text)
        with patch("vita_api.health.expected_heads", return_value=("one", "two")):
            response = self.client.get("/health/ready")
        self.assertEqual(response.json()["code"], "schema_mismatch")
        self.assertFalse(self.path.exists())

    def test_in_memory_probe_reads_the_existing_database(self):
        engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
        try:
            self.assertEqual(database_readiness(engine).code, "schema_mismatch")
            upgrade(engine)
            self.assertEqual(database_readiness(engine).code, "database_ready")
        finally:
            engine.dispose()

    def test_postgresql_probe_preserves_search_path_and_isolates_driver_limits(self):
        url = make_url("postgresql+psycopg://synthetic:synthetic-password@127.0.0.1/fake").update_query_dict({"options": "-csearch_path=isolated_probe"})
        original = SimpleNamespace(dialect=SimpleNamespace(name="postgresql"), url=url)
        with patch("vita_api.health.create_engine") as factory, probe_connection(original):
            pass
        args, kwargs = factory.call_args
        options = args[0].query["options"]
        self.assertIn("-csearch_path=isolated_probe", options)
        self.assertIn("-cstatement_timeout=2000", options)
        self.assertIn("-clock_timeout=1000", options)
        self.assertIn("-cdefault_transaction_read_only=on", options)
        self.assertEqual(kwargs["connect_args"], {"connect_timeout": 2})
        self.assertEqual(original.url, url)
        factory.return_value.dispose.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
