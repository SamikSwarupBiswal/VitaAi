"""Real read-only probes in opt-in, uniquely owned PostgreSQL test schemas."""
import os
import unittest
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, create_engine, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.health import expected_heads, install_health_routes, probe_connection
from vita_api.identity import Identity
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.storage import Store


@unittest.skipUnless(os.environ.get("VITAAI_POSTGRES_TEST_URL"), "Requires an explicit isolated PostgreSQL test URL")
class PostgreSQLHealthTests(unittest.TestCase):
    def setUp(self):
        self.admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"])
        self.addCleanup(self.admin.dispose)
        self.schema = "vitaai_health_" + uuid4().hex
        with self.admin.begin() as connection:
            connection.execute(CreateSchema(self.schema))
        self.addCleanup(self.drop_schema)
        base = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"])
        options = base.query.get("options", "")
        if not isinstance(options, str):
            raise TypeError("PostgreSQL test options must be a single string")
        url = base.update_query_dict({"options": options + " -csearch_path=" + self.schema})
        self.store = Store(url.render_as_string(hide_password=False))
        self.addCleanup(self.store.engine.dispose)
        self.store.initialize()
        self.store.seed(sample_records(datetime(2026, 10, 28, tzinfo=UTC)))
        identity = Identity(self.store.engine)
        identity.create_user("health-viewer", "synthetic-health-password", SAMPLE_ORG, "viewer")
        identity.login("health-viewer", "synthetic-health-password", 8)
        app = FastAPI()
        install_health_routes(app, self.store, None)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def drop_schema(self):
        with self.admin.begin() as connection:
            connection.execute(DropSchema(self.schema, cascade=True))

    def snapshot(self):
        metadata = MetaData()
        metadata.reflect(self.store.engine)
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(text("SELECT current_schema()")).scalar_one(), self.schema)
            return {table.name: [dict(row) for row in connection.execute(
                select(table).order_by(*table.primary_key.columns)).mappings()]
                for table in metadata.sorted_tables}

    def assert_probe_preserves_rows(self, status, code):
        before = self.snapshot()
        response = self.client.get("/health/ready")
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(response.json(), {"schema_version": "1", "status": "ready" if status == 200 else "unavailable",
                                          "check": "database_schema", "code": code})
        self.assertEqual(self.snapshot(), before)

    def test_current_schema_is_ready_and_every_table_remains_unchanged(self):
        before = self.snapshot()
        self.assertEqual(len(before["accounts"]), 6)
        self.assertEqual(len(before["evidence"]), 24)
        self.assertEqual(len(before["users"]), 1)
        self.assertEqual(len(before["sessions"]), 1)
        self.assertEqual(before["alembic_version"], [{"version_num": expected_heads()[0]}])
        for _ in range(2):
            self.assert_probe_preserves_rows(200, "database_ready")
        self.assertEqual(self.snapshot(), before)

    def test_missing_migration_table_is_unavailable_without_repair(self):
        with self.store.engine.begin() as connection:
            connection.execute(text("DROP TABLE alembic_version"))
        self.assert_probe_preserves_rows(503, "schema_mismatch")
        self.assertFalse(inspect(self.store.engine).has_table("alembic_version"))

    def test_empty_outdated_and_multiple_heads_remain_unchanged(self):
        for heads in ((), ("old-head",), (expected_heads()[0], "foreign-head")):
            with self.subTest(heads=heads):
                with self.store.engine.begin() as connection:
                    connection.execute(text("DELETE FROM alembic_version"))
                    for head in heads:
                        connection.execute(text("INSERT INTO alembic_version(version_num) VALUES (:head)"), {"head": head})
                self.assert_probe_preserves_rows(503, "schema_mismatch")

    def test_real_probe_retains_search_path_and_enforces_isolated_read_only_limits(self):
        before = self.snapshot()
        original_url = self.store.engine.url
        names = ("statement_timeout", "lock_timeout", "default_transaction_read_only")

        def settings(connection):
            return {name: connection.execute(text("SELECT setting FROM pg_settings WHERE name=:name"),
                                             {"name": name}).scalar_one() for name in names}

        with self.store.engine.connect() as connection:
            original_settings = settings(connection)
        with probe_connection(self.store.engine) as connection:
            self.assertEqual(connection.execute(text("SELECT current_schema()")).scalar_one(), self.schema)
            self.assertEqual(settings(connection), {
                "statement_timeout": "2000", "lock_timeout": "1000", "default_transaction_read_only": "on"})
            self.assertEqual(connection.connection.driver_connection.info.get_parameters()["connect_timeout"], "2")
            with self.assertRaises(SQLAlchemyError) as denied:
                connection.execute(text("DELETE FROM alembic_version"))
            self.assertEqual(denied.exception.orig.sqlstate, "25006")
        self.assertEqual(self.store.engine.url, original_url)
        with self.store.engine.connect() as connection:
            self.assertEqual(settings(connection), original_settings)
            self.assertEqual(connection.execute(text("SELECT current_schema()")).scalar_one(), self.schema)
        self.assertEqual(self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
