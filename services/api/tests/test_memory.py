"""Durable memory boundary on isolated SQLite and opt-in disposable PostgreSQL schemas."""
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from sqlalchemy import MetaData, create_engine, select
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.governance import PolicyDenied
from vita_api.identity import Identity, sessions, token_digest, users
from vita_api.memory import Memory, entries, events
from vita_api.memory_contracts import MemoryCapture, MemoryLifecycle
from vita_api.pipeline import Pipeline, PipelineRequest
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.storage import Store, accounts, pipeline_runs

NOW = datetime(2026, 10, 26, 1, tzinfo=UTC)
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}


class NoInference:
    def analyze(self, *_):
        raise AssertionError("Memory cannot call a provider")

    draft = analyze


class MemoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.stores, self.schemas = [], []
        self.pg = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"]) if os.environ.get("VITAAI_POSTGRES_TEST_URL") else None
        self.store = self.database()
        self.store.seed(sample_records(NOW))
        self.identity = Identity(self.store.engine)
        self.actor = self.identity.create_user("memory-admin", "synthetic-password-long", SAMPLE_ORG, "admin")
        _, self.token = self.identity.login("memory-admin", "synthetic-password-long", 24)
        self.memory = Memory(self.store, self.token)
        records = sample_records(NOW)
        account, facts = records[0]
        records[0] = account.model_copy(update={"annual_value": None}), facts
        self.run = Pipeline(NoInference()).run(SAMPLE_ORG, "original-author", records, NOW.date(), PipelineRequest(limit=6))
        self.run = self.run.model_copy(update={"started_at": NOW})
        self.store.save_pipeline(self.run)
        self.account_id = UUID(self.run.recommendations[0].account_id)
        self.request = MemoryCapture(pipeline_id=self.run.id,
            expected_snapshot_hash=self.run.recommendations[0].assessment.snapshot_hash)

    def database(self, revision=None):
        url = f"sqlite:///{Path(self.temp.name) / (uuid4().hex + '.sqlite')}"
        if self.pg is not None:
            schema = "vitaai_memory_" + uuid4().hex
            with self.pg.begin() as connection:
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
        if self.pg is not None:
            with self.pg.begin() as connection:
                for schema in self.schemas:
                    connection.execute(DropSchema(schema, cascade=True))
            self.pg.dispose()
        self.temp.cleanup()

    @staticmethod
    def snapshot(store):
        metadata = MetaData()
        metadata.reflect(store.engine)
        with store.engine.connect() as connection:
            return {table.name: [dict(row) for row in connection.execute(select(table).order_by(*table.primary_key.columns)).mappings()]
                    for table in metadata.sorted_tables}

    def assert_denied(self, code, call, *args):
        with self.assertRaises(PolicyDenied) as failure:
            call(*args)
        self.assertEqual(failure.exception.code, code)

    def test_capture_original_unknowns_attribution_restart_dedup_and_read_only_history(self):
        before = self.snapshot(self.store)
        captured = self.memory.capture(self.account_id, self.request)
        context = next(c for c in self.run.contexts if c.account.id == str(self.account_id))
        self.assertEqual(captured.context, context)
        self.assertEqual(captured.recommendation, self.run.recommendations[0])
        self.assertEqual(captured.source.started_at, NOW)
        self.assertEqual(captured.source.actor_id, "original-author")
        self.assertEqual(captured.captured_by, self.actor.id)
        self.assertGreater(captured.created_at, NOW)
        self.assertEqual(self.memory.capture(self.account_id, self.request), captured)
        after = self.snapshot(self.store)
        for table, rows in before.items():
            if table not in {"memory_entries", "memory_events"}:
                self.assertEqual(rows, after[table], table)
        restarted = Store(self.store.engine.url)
        self.stores.append(restarted)
        memory = Memory(restarted, self.token)
        self.assertEqual(memory.get(captured.id), captured)
        self.assertEqual(memory.history(self.account_id).items, [captured])
        audit = memory.audit(captured.id)
        self.assertEqual([(e.kind, e.revision, e.actor_id) for e in audit], [("captured", 1, self.actor.id)])
        self.assertEqual(self.snapshot(self.store), after)
        unknown = next(c for c in self.run.contexts if c.account.annual_value is None)
        recommendation = next(r for r in self.run.recommendations if r.account_id == unknown.account.id)
        item = memory.capture(UUID(unknown.account.id), MemoryCapture(pipeline_id=self.run.id,
            expected_snapshot_hash=recommendation.assessment.snapshot_hash))
        self.assertIsNone(item.context.account.annual_value)

    def test_lifecycle_keeps_original_and_append_only_reason_and_never_reactivates(self):
        item = self.memory.capture(self.account_id, self.request)
        archived = self.memory.lifecycle(item.id, MemoryLifecycle(expected_revision=1, state="archived", reason="  Original reason  "))
        self.assertEqual(archived.context, item.context)
        self.assertEqual(archived.source, item.source)
        self.assertEqual(self.memory.capture(self.account_id, self.request), archived)
        self.assert_denied("memory_revision_changed", self.memory.lifecycle, item.id,
            MemoryLifecycle(expected_revision=1, state="invalidated", reason="stale"))
        invalidated = self.memory.lifecycle(item.id, MemoryLifecycle(expected_revision=2, state="invalidated", reason="source correction"))
        self.assertEqual(invalidated.revision, 3)
        self.assertEqual(self.memory.capture(self.account_id, self.request).state, "invalidated")
        self.assertEqual([e.kind for e in self.memory.audit(item.id)], ["captured", "archived", "invalidated"])
        self.assertEqual(self.memory.audit(item.id)[1].reason, "  Original reason  ")

    def test_concurrent_independent_engines_capture_once_and_one_lifecycle_winner(self):
        other = Store(self.store.engine.url)
        self.stores.append(other)
        services = [self.memory, Memory(other, self.token)]
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(lambda service: service.capture(self.account_id, self.request), services))
        self.assertEqual(results[0], results[1])
        item = results[0]
        def invalidate(service):
            try:
                return service.lifecycle(item.id, MemoryLifecycle(expected_revision=1, state="invalidated", reason="corrected")).revision
            except PolicyDenied as error:
                return error.code
        with ThreadPoolExecutor(2) as pool:
            results = list(pool.map(invalidate, services))
        self.assertCountEqual(results, [2, "memory_revision_changed"])
        self.assertEqual(len(self.memory.audit(item.id)), 2)

    def test_current_roles_scope_revocation_and_expiry_are_checked_in_transaction(self):
        item = self.memory.capture(self.account_id, self.request)
        for username, org, role in [("viewer", SAMPLE_ORG, "viewer"), ("foreign", "foreign", "admin"),
                                     ("seller", SAMPLE_ORG, "seller")]:
            self.identity.create_user(username, "synthetic-password-long", org, role)
            _, token = self.identity.login(username, "synthetic-password-long", 24)
            service = Memory(self.store, token)
            if org != SAMPLE_ORG:
                self.assert_denied("memory_not_found", service.get, item.id)
                self.assert_denied("account_not_found", service.capture, self.account_id, self.request)
            else:
                self.assertEqual(service.get(item.id), item)
                self.assert_denied("operation_denied", service.lifecycle, item.id,
                    MemoryLifecycle(expected_revision=1, state="invalidated", reason="not authorized"))
                if role == "viewer":
                    self.assert_denied("operation_denied", service.capture, self.account_id, self.request)
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == self.actor.id).values(enabled=False))
        self.assert_denied("authentication_required", self.memory.get, item.id)
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == self.actor.id).values(enabled=True, organization_id="foreign"))
        self.assert_denied("memory_not_found", self.memory.get, item.id)
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == self.actor.id).values(organization_id=SAMPLE_ORG))
            connection.execute(sessions.update().where(sessions.c.token_hash == token_digest(self.token)).values(expires_at=0))
        self.assert_denied("authentication_required", self.memory.get, item.id)

    def test_wrong_snapshot_missing_duplicate_foreign_and_naive_sources_leave_no_memory(self):
        self.assert_denied("memory_snapshot_changed", self.memory.capture, self.account_id,
            MemoryCapture(pipeline_id=self.run.id, expected_snapshot_hash="0" * 64))
        self.assert_denied("pipeline_not_found", self.memory.capture, self.account_id,
            MemoryCapture(pipeline_id=uuid4(), expected_snapshot_hash=self.request.expected_snapshot_hash))
        original = self.run.model_dump(mode="json")
        context = next(c for c in original["contexts"] if c["account"]["id"] == str(self.account_id))
        variants = [{**original, "started_at": "2026-10-26T01:00:00"},
                    {**original, "contexts": [*original["contexts"], context]},
                    {**original, "recommendations": []},
                    {**original, "organization_id": "foreign"}]
        for payload in variants:
            with self.store.engine.begin() as connection:
                connection.execute(pipeline_runs.update().where(pipeline_runs.c.id == self.run.id).values(payload=payload))
            self.assert_denied("memory_source_unavailable", self.memory.capture, self.account_id, self.request)
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(entries)).all(), [])
            self.assertEqual(connection.execute(select(events)).all(), [])

    def test_original_memory_survives_source_change_and_changed_recapture_is_denied(self):
        item = self.memory.capture(self.account_id, self.request)
        payload = self.run.model_dump(mode="json")
        payload["actor_id"] = "changed-author"
        with self.store.engine.begin() as connection:
            connection.execute(pipeline_runs.update().where(pipeline_runs.c.id == self.run.id).values(payload=payload))
            current = connection.execute(select(accounts.c.payload).where(accounts.c.id == str(self.account_id))).scalar_one()
            connection.execute(accounts.update().where(accounts.c.id == str(self.account_id)).values(
                revision=current["revision"] + 1, payload={**current, "revision": current["revision"] + 1}))
        self.assertEqual(self.memory.get(item.id), item)
        self.assert_denied("memory_source_changed", self.memory.capture, self.account_id, self.request)

    def test_0021_populated_upgrade_does_not_rewrite_or_automatically_capture(self):
        legacy = self.database("0021")
        legacy.seed(sample_records(NOW))
        legacy.save_pipeline(self.run)
        before = self.snapshot(legacy)
        legacy.initialize()
        legacy.initialize()
        after = self.snapshot(legacy)
        for table, rows in before.items():
            if table != "alembic_version":
                self.assertEqual(rows, after[table], table)
        self.assertEqual(after["memory_entries"], [])
        self.assertEqual(after["memory_events"], [])

    def test_corrupt_retained_content_or_crossed_event_is_never_published(self):
        item = self.memory.capture(self.account_id, self.request)
        changed = item.model_dump(mode="json")
        changed["context"]["account"]["name"] = "changed after capture"
        with self.store.engine.begin() as connection:
            connection.execute(entries.update().where(entries.c.id == str(item.id)).values(payload=changed))
        self.assert_denied("memory_source_unavailable", self.memory.get, item.id)
        with self.store.engine.begin() as connection:
            connection.execute(entries.update().where(entries.c.id == str(item.id)).values(payload=item.model_dump(mode="json")))
            event = connection.execute(select(events.c.payload)).scalar_one()
            connection.execute(events.update().values(payload={**event, "organization_id": "foreign"}))
        self.assert_denied("memory_history_unavailable", self.memory.audit, item.id)

    def test_api_requires_session_and_safe_schema_exact_scoped_reads(self):
        settings = Settings(_env_file=None, database_url=self.store.engine.url.render_as_string(hide_password=False), auth_mode="session")
        with TestClient(create_app(settings, NoInference())) as client:
            path = f"/api/memory/accounts/{self.account_id}"
            self.assertEqual(client.get(path).status_code, 401)
            client.post("/api/auth/login", headers=HEADERS, json={"username": "memory-admin", "password": "synthetic-password-long"})
            self.assertEqual(client.post(path, json=self.request.model_dump(mode="json")).status_code, 403)
            response = client.post(path, headers=HEADERS, json=self.request.model_dump(mode="json"))
            self.assertEqual(response.status_code, 200, response.text)
            item = response.json()
            self.assertEqual(client.get(path).json()["items"][0], item)
            self.assertEqual(client.get(f'/api/memory/{item["id"]}/events').json()[0]["kind"], "captured")
            bad = client.post(path, headers=HEADERS, json={**self.request.model_dump(mode="json"), "actor_id": "PRIVATE_SENTINEL"})
            self.assertEqual(bad.status_code, 422)
            self.assertNotIn("PRIVATE_SENTINEL", bad.text)
            self.assertEqual(response.headers["cache-control"], "no-store")
        with TestClient(create_app(settings.model_copy(update={"auth_mode": "sample"}), NoInference())) as client:
            self.assertEqual(client.get(path).status_code, 503)


if __name__ == "__main__":
    unittest.main()
