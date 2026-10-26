"""Retained pipeline discovery: isolated SQLite/PostgreSQL, no model or provider calls."""
import os
import tempfile
import unittest
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from uuid import uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, create_engine, inspect, select
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.identity import Identity, users
from vita_api.pipeline import Pipeline, PipelineRequest
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.storage import Store

NOW = datetime(2026, 10, 26, 1, tzinfo=UTC)
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}


class NoInference:
    def analyze(self, *_):
        raise AssertionError("History must not call a model")

    draft = analyze


class PipelineHistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.stores, self.schemas = [], []
        self.pg_admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"]) if os.environ.get("VITAAI_POSTGRES_TEST_URL") else None
        self.store = self.database()
        self.store.seed(sample_records(NOW))

    def database(self, revision=None):
        url = f"sqlite:///{Path(self.temp.name) / (uuid4().hex + '.sqlite')}"
        if self.pg_admin is not None:
            schema = "vitaai_history_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(schema))
            self.schemas.append(schema)
            url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + schema}).render_as_string(hide_password=False)
        store = Store(url)
        self.stores.append(store)
        if revision:
            config = Config()
            config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
            with store.engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, revision)
        else:
            store.initialize()
        return store

    def tearDown(self):
        for store in self.stores:
            store.engine.dispose()
        if self.pg_admin is not None:
            with self.pg_admin.begin() as connection:
                for schema in self.schemas:
                    connection.execute(DropSchema(schema, cascade=True))
            self.pg_admin.dispose()
        self.temp.cleanup()

    def run_record(self, at=NOW, intent="attention", records=None):
        result = Pipeline(NoInference()).run(SAMPLE_ORG, "retained-actor", records or sample_records(NOW),
                                             NOW.date(), PipelineRequest(intent=intent, limit=1))
        return result.model_copy(update={"started_at": at})

    @staticmethod
    def snapshot(store):
        metadata = MetaData()
        metadata.reflect(store.engine)
        with store.engine.connect() as connection:
            return {table.name: connection.execute(select(table).order_by(*table.primary_key.columns)).mappings().all()
                    for table in metadata.sorted_tables}

    def test_newest_twenty_ties_microseconds_and_original_coverage_survive_restart_without_writes(self):
        retained = [self.run_record(NOW + timedelta(microseconds=i), "growth" if i % 2 else "attention") for i in range(23)]
        retained += [self.run_record(NOW + timedelta(microseconds=22)) for _ in range(2)]
        retained[0] = retained[0].model_copy(update={"started_at": NOW.astimezone(timezone(timedelta(hours=5, minutes=30)))})
        for record in reversed(retained):
            self.store.save_pipeline(record)
        before = self.snapshot(self.store)
        restarted = Store(self.store.engine.url)
        self.stores.append(restarted)
        result = restarted.list_pipeline_history(SAMPLE_ORG)
        expected = sorted(retained, key=lambda run: (run.started_at, run.id), reverse=True)[:20]
        self.assertEqual([item.id for item in result.items], [run.id for run in expected])
        self.assertEqual((result.total_count, result.window_count, result.undated_count, result.unavailable_count), (25, 20, 0, 0))
        self.assertTrue(result.has_more)
        self.assertEqual(result.limit, 20)
        for item, run in zip(result.items, expected, strict=True):
            self.assertEqual(item.started_at, run.started_at)
            self.assertEqual(item.request, run.request)
            self.assertEqual(item.actor_id, run.actor_id)
            self.assertEqual(item.input_account_ids, [context.account.id for context in run.contexts])
            self.assertEqual(item.selected_account_ids, [recommendation.account_id for recommendation in run.recommendations])
            self.assertEqual(restarted.get_pipeline(SAMPLE_ORG, item.id), run)
        self.assertEqual(self.snapshot(self.store), before)
        self.assertEqual(restarted.list_pipeline_history("foreign").total_count, 0)

    def test_authenticated_viewers_can_read_only_their_organization_and_revoked_sessions_deny(self):
        saved = self.run_record()
        self.store.save_pipeline(saved)
        identity = Identity(self.store.engine)
        viewer = identity.create_user("history-viewer", "synthetic-password-long", SAMPLE_ORG, "viewer")
        identity.create_user("history-foreign", "synthetic-password-long", "foreign", "viewer")
        settings = Settings(_env_file=None, database_url=self.store.engine.url.render_as_string(hide_password=False), auth_mode="session")
        with TestClient(create_app(settings, NoInference())) as client:
            self.assertEqual(client.get("/api/pipeline/history").status_code, 401)
            client.post("/api/auth/login", headers=HEADERS, json={"username": "history-viewer", "password": "synthetic-password-long"})
            before = self.snapshot(self.store)
            response = client.get("/api/pipeline/history")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(response.json()["items"][0]["id"], saved.id)
            self.assertEqual(client.get(f"/api/pipeline/{saved.id}").json()["id"], saved.id)
            self.assertEqual(self.snapshot(self.store), before)
            with self.store.engine.begin() as connection:
                connection.execute(users.update().where(users.c.id == viewer.id).values(enabled=False))
            self.assertEqual(client.get("/api/pipeline/history").status_code, 401)
            client.cookies.clear()
            client.post("/api/auth/login", headers=HEADERS, json={"username": "history-foreign", "password": "synthetic-password-long"})
            self.assertEqual(client.get("/api/pipeline/history").json()["items"], [])
            self.assertEqual(client.get(f"/api/pipeline/{saved.id}").status_code, 404)

    def test_0020_populated_upgrade_preserves_payloads_and_discloses_unorderable_and_unreadable_history(self):
        legacy = self.database("0020")
        metadata = MetaData()
        metadata.reflect(legacy.engine)
        table = metadata.tables["pipeline_runs"]
        record = self.run_record()
        valid = record.model_dump(mode="json")
        valid.pop("portfolio_specialists")
        for recommendation in valid["recommendations"]:
            recommendation.pop("specialists")
        payloads = [valid, {**valid, "id": str(uuid4()), "started_at": "2026-10-26T01:00:00"},
                    {**valid, "id": str(uuid4()), "started_at": "not-a-date"},
                    {**valid, "id": str(uuid4()), "contexts": []}]
        with legacy.engine.begin() as connection:
            connection.execute(table.insert(), [{"id": item["id"], "organization_id": SAMPLE_ORG,
                                                "actor_id": record.actor_id, "payload": item} for item in payloads])
        before = self.snapshot(legacy)
        legacy.initialize()
        legacy.initialize()
        after = self.snapshot(legacy)
        for name, rows in before.items():
            if name == "alembic_version":
                continue
            actual = after[name]
            if name == "pipeline_runs":
                actual = [{key: value for key, value in row.items() if key != "started_at_us"} for row in actual]
            self.assertEqual(actual, rows, name)
        history = legacy.list_pipeline_history(SAMPLE_ORG)
        self.assertEqual((history.total_count, history.window_count, history.undated_count, history.unavailable_count), (4, 2, 2, 1))
        self.assertFalse(history.has_more)
        self.assertEqual([item.id for item in history.items], [record.id])
        self.assertIsNone(legacy.get_pipeline(SAMPLE_ORG, record.id).portfolio_specialists)
        self.assertTrue(any(index["column_names"] == ["organization_id", "started_at_us", "id"]
                            for index in inspect(legacy.engine).get_indexes("pipeline_runs")))
        self.assertEqual(self.snapshot(legacy), after)

    def test_empty_and_outside_selection_are_distinct_and_naive_new_dates_are_rejected(self):
        self.assertEqual(self.store.list_pipeline_history(SAMPLE_ORG).items, [])
        record = self.run_record(records=[sample_records(NOW)[0]])
        empty = record.model_copy(update={"id": str(uuid4()), "recommendations": []})
        self.store.save_pipeline(empty)
        result = self.store.list_pipeline_history(SAMPLE_ORG).items[0]
        self.assertEqual(result.input_account_ids, [record.contexts[0].account.id])
        self.assertEqual(result.selected_account_ids, [])
        with self.assertRaises(ValueError):
            self.store.save_pipeline(record.model_copy(update={"started_at": NOW.replace(tzinfo=None)}))


if __name__ == "__main__":
    unittest.main()
