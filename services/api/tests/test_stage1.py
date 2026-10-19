import os
import tempfile
import unittest
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect, select, text, update
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.identity import Identity, sessions, users
from vita_api.pipeline import Pipeline, PipelineRequest
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess
from vita_api.storage import Store, accounts, evidence, runs

NOW = datetime(2026, 10, 14, 12, tzinfo=UTC)
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}


class Stage1Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pg_admin = None
        database_url = f"sqlite:///{Path(self.temp.name) / 'db.sqlite'}"
        if os.environ.get("VITAAI_POSTGRES_TEST_URL"):
            self.pg_admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"])
            self.schema = "vitaai_test_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(self.schema))
            database_url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + self.schema,
            }).render_as_string(hide_password=False)
        self.settings = Settings(_env_file=None,
                                 database_url=database_url,
                                 auth_mode="session")
        self.store = Store(self.settings.database_url)
        self.store.initialize()
        self.identity = Identity(self.store.engine)
        self.user = self.identity.create_user("seller", "test-password-long", SAMPLE_ORG, "seller")

    def tearDown(self):
        self.store.engine.dispose()
        if self.pg_admin is not None:
            with self.pg_admin.begin() as connection:
                connection.execute(DropSchema(self.schema, cascade=True))
            self.pg_admin.dispose()
        self.temp.cleanup()

    def login(self, client, username="seller", password="test-password-long"):
        return client.post("/api/auth/login", headers=HEADERS,
                           json={"username": username, "password": password})

    def test_missing_account_values_survive_api_restart_and_route_to_review(self):
        with TestClient(create_app(self.settings)) as client:
            self.login(client)
            before = client.get("/api/portfolio").json()
            target = before["accounts"][0]["account"]
            with self.store.engine.begin() as connection:
                connection.execute(accounts.update().where(accounts.c.id == target["id"]).values(
                    revision=2, payload={**target, "annual_value": None, "renewal_date": None, "revision": 2}))
            response = client.get("/api/portfolio")
            self.assertEqual(response.status_code, 200)
            partial = response.json()
            self.assertEqual(partial["annual_value"], before["annual_value"] - target["annual_value"])
            self.assertEqual(partial["annual_value_missing_count"], 1)
            view = client.get(f'/api/accounts/{target["id"]}').json()
            self.assertIsNone(view["account"]["annual_value"])
            self.assertIsNone(view["account"]["renewal_date"])
            self.assertIsNone(view["renewal_days"])
            self.assertTrue(view["assessment"]["requires_review"])
            for intent in ("attention", "risk", "growth", "renewal", "manual_review", "monitor"):
                run = client.post("/api/pipeline", headers=HEADERS, json={
                    "intent": intent, "limit": 6, "communication_mode": "drafts"})
                self.assertEqual(run.status_code, 200)
                matches = [r for r in run.json()["recommendations"] if r["account_id"] == target["id"]]
                if intent in {"growth", "renewal", "monitor"}:
                    self.assertEqual(matches, [])
                else:
                    self.assertEqual(len(matches), 1)
                    self.assertEqual(matches[0]["action"]["kind"], "manual_review")
                    self.assertEqual(matches[0]["communication"]["status"], "blocked")
            for account in self.store.list_accounts(SAMPLE_ORG):
                with self.store.engine.begin() as connection:
                    connection.execute(accounts.update().where(accounts.c.id == account.id).values(
                        payload={**account.model_dump(mode="json"), "annual_value": None}))
            unknown = client.get("/api/portfolio").json()
            self.assertIsNone(unknown["annual_value"])
            self.assertEqual(unknown["annual_value_missing_count"], len(before["accounts"]))
        with TestClient(create_app(self.settings)) as restarted:
            self.login(restarted)
            self.assertIsNone(restarted.get("/api/portfolio").json()["annual_value"])
            self.assertIsNone(restarted.get(f'/api/accounts/{target["id"]}').json()["renewal_days"])

    def test_identity_cookie_restart_logout_and_no_secret_storage(self):
        with TestClient(create_app(self.settings)) as client:
            self.assertEqual(client.get("/api/portfolio").status_code, 401)
            response = self.login(client)
            self.assertEqual(response.status_code, 200)
            self.assertIn("HttpOnly", response.headers["set-cookie"])
            self.assertIn("SameSite=strict", response.headers["set-cookie"])
            token = client.cookies.get("vitaai_session")
            self.assertNotIn(token, response.text)
            self.assertEqual(client.get("/api/portfolio").status_code, 200)
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.set("vitaai_session", token)
            self.assertEqual(restarted.get("/api/portfolio").status_code, 200)
            self.assertEqual(restarted.post("/api/auth/logout", headers=HEADERS).status_code, 200)
            self.assertEqual(restarted.get("/api/portfolio").status_code, 401)
        if self.pg_admin is None:
            contents = Path(self.temp.name, "db.sqlite").read_bytes()
        else:
            with self.store.engine.connect() as connection:
                contents = str(connection.execute(select(users)).mappings().all()).encode()
                contents += str(connection.execute(select(sessions)).mappings().all()).encode()
        self.assertNotIn(token.encode(), contents)
        self.assertNotIn(b"test-password-long", contents)

    def test_organization_and_role_are_server_authoritative(self):
        self.identity.create_user("viewer", "another-test-password", "other-org", "viewer")
        with TestClient(create_app(self.settings)) as client:
            self.assertEqual(self.login(client, "viewer", "another-test-password").status_code, 200)
            self.assertEqual(client.get("/api/portfolio").json()["accounts"], [])
            account = sample_records(NOW)[0][0]
            self.assertEqual(client.get(f"/api/accounts/{account.id}").status_code, 404)
            self.assertEqual(client.post("/api/pipeline", json={}, headers=HEADERS).status_code, 403)
            self.assertEqual(client.post("/api/providers/nebius/discover", headers=HEADERS).status_code, 403)
            self.assertEqual(client.post("/api/auth/login", headers=HEADERS, json={
                "username": "viewer", "password": "another-test-password", "role": "admin",
            }).status_code, 422)

    def test_revocation_expiry_csrf_and_login_lock(self):
        with TestClient(create_app(self.settings)) as client:
            self.assertEqual(client.post("/api/auth/login", json={
                "username": "seller", "password": "test-password-long",
            }).status_code, 403)
            self.assertEqual(self.login(client).status_code, 200)
            with self.store.engine.begin() as connection:
                connection.execute(update(sessions).values(expires_at=0))
            self.assertEqual(client.get("/api/portfolio").status_code, 401)
            self.assertEqual(self.login(client).status_code, 200)
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.user.id).values(enabled=False))
            self.assertEqual(client.get("/api/portfolio").status_code, 401)
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.user.id).values(enabled=True))
            for _ in range(5):
                self.assertEqual(self.login(client, password="wrong-password").status_code, 401)
            self.assertEqual(self.login(client).status_code, 429)

    def test_concurrent_login_failures_do_not_lose_lockout_counters(self):
        from concurrent.futures import ThreadPoolExecutor

        from vita_api.identity import LoginFailure

        def failed_login(_):
            try:
                self.identity.login("seller", "wrong", 8)
            except LoginFailure:
                return
            raise AssertionError("Wrong password authenticated")

        with ThreadPoolExecutor(max_workers=5) as pool:
            list(pool.map(failed_login, range(5)))
        with self.assertRaises(LoginFailure) as failure:
            self.identity.login("seller", "test-password-long", 8)
        self.assertTrue(failure.exception.locked)
        with self.store.engine.connect() as connection:
            count = connection.execute(select(users.c.failed_logins).where(users.c.id == self.user.id)).scalar()
        self.assertEqual(count, 5)

    def test_pipeline_preserves_baseline_scope_and_model_boundary(self):
        class NoModel:
            def analyze(self, view):
                raise AssertionError("Model must not run for deterministic pipeline")

        records = sample_records(NOW)
        run = Pipeline(NoModel()).run(SAMPLE_ORG, self.user.id, records, NOW.date(), PipelineRequest())
        self.assertEqual([s.role for s in run.steps], [
            "ingestion", "health", "opportunity", "governance", "action", "communication",
        ])
        self.assertEqual(run.status, "deterministic")
        self.assertEqual(len(run.recommendations), 3)
        self.assertEqual(len(run.contexts), 6)
        self.assertTrue(all(r.governance.requires_human_approval for r in run.recommendations))
        self.assertTrue(all(r.communication.status == "deterministic_template" for r in run.recommendations))
        for result in run.recommendations:
            account, facts = next(item for item in records if item[0].id == result.account_id)
            self.assertEqual(result.assessment, assess(account, facts, NOW.date()))
        foreign = records[0][1][0].model_copy(update={"organization_id": "other-org"})
        with self.assertRaises(ValueError):
            Pipeline(NoModel()).run(SAMPLE_ORG, self.user.id, [(records[0][0], [foreign])], NOW.date(), PipelineRequest())

    def test_pipeline_api_durable_and_cross_org_hidden(self):
        with TestClient(create_app(self.settings)) as client:
            self.login(client)
            response = client.post("/api/pipeline", json={"intent": "renewal", "limit": 2}, headers=HEADERS)
            self.assertEqual(response.status_code, 200)
            run = response.json()
            self.assertEqual(len(run["recommendations"]), 1)
            self.assertEqual(run["recommendations"][0]["account_id"], sample_records(NOW)[0][0].id)
        with TestClient(create_app(self.settings)) as restarted:
            self.login(restarted)
            self.assertEqual(restarted.get(f"/api/pipeline/{run['id']}").json(), run)
            self.identity.create_user("foreign", "another-test-password", "other-org", "seller")
            self.login(restarted, "foreign", "another-test-password")
            self.assertEqual(restarted.get(f"/api/pipeline/{run['id']}").status_code, 404)

    def test_monitor_intent_never_prepares_outreach_or_calls_provider(self):
        class NoModel:
            def analyze(self, *_):
                raise AssertionError("Monitor intent cannot invoke model analysis")

            def draft(self, *_):
                raise AssertionError("Monitor intent cannot invoke model drafting")

        records = sample_records(NOW)
        baseline = {account.id: assess(account, facts, NOW.date()) for account, facts in records}
        original = [(account.model_dump(), [fact.model_dump() for fact in facts]) for account, facts in records]
        cedar = next(item for item in records if item[0].name == "Cedar Financial")
        for mode in ("internal_note", "drafts"):
            for communicate in (False, True):
                for inputs in (records, [cedar]):
                    with self.subTest(mode=mode, communicate=communicate, accounts=len(inputs)):
                        limit = 1 if communicate else 2
                        run = Pipeline(NoModel()).run(
                            SAMPLE_ORG, self.user.id, inputs, NOW.date(),
                            PipelineRequest(intent="monitor", limit=limit, communicate=communicate,
                                            communication_mode=mode),
                        )
                        names = {account.id: account.name for account, _ in inputs}
                        expected = ["Meridian Retail"] if communicate else ["Meridian Retail", "Cedar Financial"]
                        self.assertEqual([names[item.account_id] for item in run.recommendations],
                                         expected if inputs is records else ["Cedar Financial"])
                        self.assertEqual(run.organization_id, SAMPLE_ORG)
                        self.assertEqual(run.actor_id, self.user.id)
                        self.assertEqual(run.status, "deterministic")
                        self.assertEqual([step.role for step in run.steps], [
                            "ingestion", "health", "opportunity", "governance", "action", "communication",
                        ])
                        self.assertEqual([step.processed for step in run.steps],
                                         [len(inputs)] * 4 + [len(run.recommendations)] * 2)
                        self.assertTrue(all(step.status == "completed" for step in run.steps))
                        for rank, result in enumerate(run.recommendations, start=1):
                            self.assertEqual(result.rank, rank)
                            self.assertEqual(result.assessment, baseline[result.account_id])
                            self.assertEqual(result.action.kind, "monitor")
                            self.assertFalse(result.action.external_execution)
                            self.assertEqual(result.action.approval_status, "unapproved")
                            self.assertEqual(result.communication.status, "deterministic_template")
                            self.assertIsNone(result.communication.model_run)
                            self.assertTrue(result.communication.internal_note)
                            if mode == "drafts":
                                drafts = result.communication.drafts
                                self.assertEqual(drafts.action_kind, "monitor")
                                self.assertIsNone(drafts.email)
                                self.assertIsNone(drafts.call_script)
                                self.assertIsNone(drafts.voice_summary)
                            else:
                                self.assertIsNone(result.communication.drafts)
        self.assertEqual([(account.model_dump(), [fact.model_dump() for fact in facts])
                          for account, facts in records], original)

    def test_migrations_are_versioned_and_restart_preserves_data(self):
        self.store.seed(sample_records(NOW))
        before = self.store.list_accounts(SAMPLE_ORG)
        self.store.initialize()
        self.assertEqual(before, self.store.list_accounts(SAMPLE_ORG))
        self.assertIn("alembic_version", inspect(self.store.engine).get_table_names())
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(text("select version_num from alembic_version")).scalar(), "0010")
            self.assertEqual(connection.execute(select(users.c.id)).scalar(), self.user.id)

    def test_closed_pooled_connection_recovers_before_first_query(self):
        self.store.seed(sample_records(NOW))
        with self.store.engine.connect() as connection:
            raw = connection.connection.driver_connection
        # A server restart closes idle connections without notifying the pool.
        raw.close()
        self.assertEqual(len(self.store.list_accounts(SAMPLE_ORG)), 6)

    def test_unversioned_bootstrap_adoption_preserves_evidence(self):
        legacy = Store(f"sqlite:///{Path(self.temp.name) / 'legacy.sqlite'}")
        try:
            for table in (accounts, evidence, runs):
                table.create(legacy.engine)
            legacy.seed(sample_records(NOW))
            # Read the pre-migration bootstrap directly; current Store readers require head schema.
            with legacy.engine.connect() as connection:
                before = connection.execute(select(evidence.c.payload).where(
                    evidence.c.account_id == sample_records(NOW)[0][0].id)).scalars().all()
            legacy.initialize()
            self.assertEqual(sorted(before, key=lambda item: item["id"]), sorted(
                [item.model_dump(mode="json") for item in legacy.account_evidence(SAMPLE_ORG, before[0]["account_id"])],
                key=lambda item: item["id"]))
            self.assertEqual(len(legacy.list_accounts(SAMPLE_ORG)), 6)
        finally:
            legacy.engine.dispose()

    def test_nonmatching_bootstrap_schema_fails_closed(self):
        legacy = Store(f"sqlite:///{Path(self.temp.name) / 'wrong.sqlite'}")
        try:
            with legacy.engine.begin() as connection:
                connection.execute(text("CREATE TABLE accounts (id VARCHAR(80) PRIMARY KEY)"))
            with self.assertRaisesRegex(RuntimeError, "schema differs"):
                legacy.initialize()
        finally:
            legacy.engine.dispose()

    def test_password_validation_never_echoes_input_and_login_rotates(self):
        secret = "do-not-echo-" * 30
        with TestClient(create_app(self.settings)) as client:
            response = self.login(client, password=secret)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn(secret, response.text)
            self.login(client)
            previous = client.cookies.get("vitaai_session")
            self.login(client)
            self.assertIsNone(self.identity.resolve(previous))
            self.assertIsNotNone(self.identity.resolve(client.cookies.get("vitaai_session")))
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.user.id).values(role="viewer"))
            self.assertEqual(client.post("/api/pipeline", json={}, headers=HEADERS).status_code, 403)

    def test_drafting_api_persists_across_restart(self):
        with TestClient(create_app(self.settings)) as client:
            self.assertEqual(self.login(client).status_code, 200)
            response = client.post("/api/pipeline", json={"communication_mode": "drafts"}, headers=HEADERS)
            self.assertEqual(response.status_code, 200)
            saved = response.json()
            self.assertTrue(all(r["communication"]["drafts"] for r in saved["recommendations"]))
        with TestClient(create_app(self.settings)) as restarted:
            self.assertEqual(self.login(restarted).status_code, 200)
            self.assertEqual(restarted.get(f"/api/pipeline/{saved['id']}").json(), saved)

    def test_pipeline_missing_evidence_and_unconfigured_model_stay_explicit(self):
        from vita_api.nebius import Nebius

        request = PipelineRequest(communicate=True, limit=1)
        pipeline = Pipeline(Nebius(Settings(_env_file=None)))
        records = sample_records(NOW)
        run = pipeline.run(SAMPLE_ORG, self.user.id, records, NOW.date(), request)
        self.assertEqual(run.status, "partial")
        self.assertEqual(run.recommendations[0].communication.status, "unconfigured")
        self.assertIsNone(run.recommendations[0].communication.internal_note)
        missing = [(records[0][0], [])]
        run = pipeline.run(SAMPLE_ORG, self.user.id, missing, NOW.date(), request)
        result = run.recommendations[0]
        self.assertEqual(result.action.kind, "manual_review")
        self.assertEqual(result.communication.status, "blocked")
        self.assertIsNone(result.communication.model_run)
        run = pipeline.run(SAMPLE_ORG, self.user.id, records, NOW.date(), PipelineRequest(intent="manual_review"))
        self.assertEqual(run.recommendations, [])
        self.assertIn("No accounts matched", run.caveats[1])

    def test_model_mutation_cannot_change_deterministic_output(self):
        from vita_api.contracts import Analysis, Finding, ModelRun

        class MutatingMock:
            def analyze(self, view):
                run = ModelRun(id="mock", account_id=view.account.id, organization_id=view.account.organization_id,
                               account_revision=view.account.revision, snapshot_hash=view.assessment.snapshot_hash,
                               model="nvidia/mock-nemotron", status="succeeded", validation="schema_and_references_valid",
                               started_at=NOW, latency_ms=1,
                               analysis=Analysis(findings=[Finding(text="Mock finding", evidence_ids=[view.evidence[0].id])],
                                                 next_steps=[Finding(text="Mock preparation", evidence_ids=[view.evidence[0].id])], caveats=[]))
                view.assessment.risk = 0
                view.account.organization_id = "foreign"
                return run

        records = sample_records(NOW)
        run = Pipeline(MutatingMock()).run(SAMPLE_ORG, self.user.id, records, NOW.date(), PipelineRequest(communicate=True, limit=1))
        self.assertEqual(run.status, "model_validated")
        self.assertGreater(run.recommendations[0].assessment.risk, 50)
        self.assertEqual(run.contexts[0].account.organization_id, SAMPLE_ORG)
        self.assertEqual(run.recommendations[0].action.approval_status, "unapproved")


if __name__ == "__main__":
    unittest.main()
