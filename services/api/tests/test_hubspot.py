"""Local HTTP/database checks; HubSpot network responses are explicitly mocked."""
import copy
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event, Lock
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.app import create_app
from vita_api.config import PROPERTY_SEMANTICS, Settings
from vita_api.hubspot import HubSpot, HubSpotFailure
from vita_api.hubspot_changes import SourceDetection, detections
from vita_api.hubspot_sync import observations, sync_runs
from vita_api.identity import Identity, users
from vita_api.provider_comparison import comparisons
from vita_api.provider_probe import probes
from vita_api.research_narrative import narratives
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.source_missions import source_missions
from vita_api.storage import source_versions
from vita_api.workflow_storage import (
    actions,
    audits,
    claims,
    decisions,
    missions,
    plans,
    versions,
)

NOW = datetime(2026, 10, 18, 12, tzinfo=UTC)
ACCOUNT_ID = sample_records(NOW)[0][0].id
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}
COMPANY = {"id": "123", "archived": False, "createdAt": "2026-09-01T00:00:00Z",
           "updatedAt": "2026-10-17T12:00:00Z",
           "properties": {"name": "Test company", "domain": "example.test", "industry": None}}
PROPERTY_MAP = {target: {"property": "vita_" + target, "type": kind, "unit": unit, "meaning": meaning,
    **({"observed_at_property": "vita_measured_at"} if target in {"usage_change", "support_cases", "expansion"} else {})}
    for target, (kind, unit, meaning) in PROPERTY_SEMANTICS.items()}


def configured(**changes):
    return Settings(_env_file=None, auth_mode="session", hubspot_enabled=True,
                    hubspot_access_token="test-only-token", hubspot_organization_id=SAMPLE_ORG,
                    hubspot_portal_id="456", hubspot_company_map={ACCOUNT_ID: "123"}, **changes)


class HubSpotTransportTests(unittest.TestCase):
    def test_fixed_gets_portal_binding_properties_and_safe_failures(self):
        for code, portal, expected in [(200, 456, None), (200, 999, "portal_mismatch"),
                                       (200, True, "invalid_response"), (401, 456, "hubspot_http_401"),
                                       (429, 456, "hubspot_http_429"), (302, 456, "hubspot_http_302")]:
            calls = []

            def respond(request, calls=calls, code=code, portal=portal):
                calls.append(request)
                self.assertEqual(request.method, "GET")
                self.assertEqual(request.url.host, "api.hubapi.com")
                self.assertEqual(request.headers["authorization"], "Bearer test-only-token")
                if request.url.path == "/account-info/v3/details":
                    return httpx.Response(code, json={"portalId": portal, "message": "test-only-token"},
                                          headers={"Location": "https://foreign.test"})
                self.assertEqual(request.url.path, "/crm/v3/objects/companies/123")
                self.assertEqual(request.url.params["properties"], "name,domain,industry")
                return httpx.Response(200, json={**COMPANY, "secret_extra": "never-store"})

            with self.subTest(code=code, portal=portal):
                connector = HubSpot(configured(), httpx.MockTransport(respond))
                if expected:
                    with self.assertRaises(HubSpotFailure) as failure:
                        connector.read_company("123", NOW)
                    self.assertEqual(str(failure.exception), expected)
                    self.assertEqual(len(calls), 1)
                else:
                    result = connector.read_company("123", NOW)
                    self.assertEqual(result.properties, COMPANY["properties"])
                    self.assertNotIn("never-store", result.model_dump_json())
                    self.assertEqual(len(calls), 2)

    def test_invalid_company_and_network_responses_cannot_be_observations(self):
        for payload in [{**COMPANY, "id": "999"}, {**COMPANY, "archived": True},
                        {**COMPANY, "updatedAt": "2030-01-01T00:00:00Z"},
                        {**COMPANY, "updatedAt": "2026-10-17T12:00:00"},
                        {**COMPANY, "properties": {"name": 42}}, {**COMPANY, "archived": "false"},
                        {**COMPANY, "createdAt": "2026-10-18T00:00:00Z"}]:
            def respond(request, payload=payload):
                return httpx.Response(200, json={"portalId": 456} if request.url.path.startswith("/account") else payload)
            with self.subTest(payload=payload), self.assertRaises(HubSpotFailure):
                HubSpot(configured(), httpx.MockTransport(respond)).read_company("123", NOW)
        for content in (b"{", b"x" * 65537):
            with self.assertRaises(HubSpotFailure):
                HubSpot(configured(), httpx.MockTransport(lambda _, content=content: httpx.Response(200, content=content))).read_company("123", NOW)
        for error, code in [(httpx.ReadTimeout("test-only-token"), "hubspot_timeout"),
                            (httpx.ConnectError("test-only-token"), "hubspot_network_error")]:
            def fail(_, error=error):
                raise error
            with self.assertRaises(HubSpotFailure) as failure:
                HubSpot(configured(), httpx.MockTransport(fail)).read_company("123", NOW)
            self.assertEqual(str(failure.exception), code)

    def test_configuration_and_disallowed_targets_fail_before_network(self):
        for mapping in ({ACCOUNT_ID: "*"}, {ACCOUNT_ID: "https://foreign.test"}, {"*": "123"},
                        {"-" * 36: "123"}, {ACCOUNT_ID: "123", str(uuid4()): "123"}):
            with self.subTest(mapping=mapping), self.assertRaises(ValidationError):
                Settings(_env_file=None, hubspot_company_map=mapping)
        def fail(_):
            self.fail("Unexpected network access")
        for settings, company in [(Settings(_env_file=None), "123"), (configured(), "124"),
                                  (configured(), "../123"), (configured(), "https://foreign.test")]:
            with self.assertRaises(HubSpotFailure):
                HubSpot(settings, httpx.MockTransport(fail)).read_company(company, NOW)


class HubSpotApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pg_admin = None
        database_url = f"sqlite:///{Path(self.temp.name) / 'hubspot.sqlite'}"
        if os.environ.get("VITAAI_POSTGRES_TEST_URL"):
            self.pg_admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"])
            self.schema = "vitaai_hubspot_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(self.schema))
            database_url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + self.schema}).render_as_string(hide_password=False)
        self.settings = configured(database_url=database_url)
        self.company = copy.deepcopy(COMPANY)
        self.company["createdAt"] = (datetime.now(UTC) - timedelta(days=3)).isoformat().replace("+00:00", "Z")
        self.company["updatedAt"] = (datetime.now(UTC) - timedelta(days=2)).isoformat().replace("+00:00", "Z")
        self.calls = []
        self.on_company = None
        self.status = 200
        self.types = {}
        self.app = create_app(self.settings, hubspot_transport=httpx.MockTransport(self.respond))
        self.client = TestClient(self.app).__enter__()
        self.identity = Identity(self.app.state.store.engine)
        self.admin = self.identity.create_user("admin", "test-password-long", SAMPLE_ORG, "admin")
        self.login()

    def tearDown(self):
        self.client.__exit__(None, None, None)
        if self.pg_admin is not None:
            with self.pg_admin.begin() as connection:
                connection.execute(DropSchema(self.schema, cascade=True))
            self.pg_admin.dispose()
        self.temp.cleanup()

    def respond(self, request):
        self.calls.append(request)
        self.assertEqual(request.method, "GET")
        if request.url.path == "/account-info/v3/details":
            return httpx.Response(200, json={"portalId": 456})
        if request.url.path.startswith("/crm/v3/properties/companies/"):
            name = request.url.path.rsplit("/", 1)[1]
            return httpx.Response(200, json={"name": name, "type": self.types.get(name), "archived": False})
        if self.on_company:
            self.on_company()
        return httpx.Response(self.status, json=self.company)

    def login(self, username="admin"):
        self.client.cookies.clear()
        response = self.client.post("/api/auth/login", headers=HEADERS,
                                    json={"username": username, "password": "test-password-long"})
        self.assertEqual(response.status_code, 200)

    def enable_mapping(self, mapping=None):
        self.client.__exit__(None, None, None)
        self.settings = configured(database_url=self.settings.database_url,
                                   hubspot_property_map=PROPERTY_MAP if mapping is None else mapping)
        self.types = HubSpot(self.settings).property_types()
        self.app = create_app(self.settings, hubspot_transport=httpx.MockTransport(self.respond))
        self.client = TestClient(self.app).__enter__()
        self.identity = Identity(self.app.state.store.engine)
        self.login()

    def promotion_body(self, revision):
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        preview = self.client.get(path + "/preview")
        self.assertEqual(preview.status_code, 200, preview.text)
        return {"expected_account_revision": revision, "observation_id": preview.json()["observation_id"],
                "preview_hash": preview.json()["preview_hash"]}, preview.json()

    def promote_source(self, **properties):
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        revision = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()["account"]["revision"]
        self.company["properties"].update(properties)
        self.assertEqual(self.sync(expected_account_revision=revision).json()["status"], "succeeded")
        body, _ = self.promotion_body(revision)
        result = self.client.post(path + "/promote", headers=HEADERS, json=body)
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def detect_sources(self, **changes):
        view = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        return self.client.post(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/detect-changes",
            headers=HEADERS, json={"expected_account_revision": view["account"]["revision"],
                "expected_source_id": view["source"]["id"], **changes})

    def source_mission_fixture(self):
        self.enable_mapping()
        self.company["properties"].update({"vita_annual_value": "45000", "vita_renewal_date": "2027-02-01",
            "vita_usage_change": "-25", "vita_support_cases": "3", "vita_expansion": "65",
            "vita_measured_at": self.company["updatedAt"]})
        self.promote_source()
        baseline = self.detect_sources().json()["processed"][0]
        selected = self.promote_source(vita_usage_change="-40")
        changed = self.detect_sources().json()["processed"][0]
        view = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        plan = self.client.post("/api/plans", headers=HEADERS, json={"account_id": ACCOUNT_ID,
            "expected_revision": view["account"]["revision"], "expected_snapshot_hash": view["assessment"]["snapshot_hash"],
            "intent": "risk"})
        self.assertEqual(plan.status_code, 200, plan.text)
        body = {"plan_id": plan.json()["id"], "expected_revision": 1, "event_id": changed["event"]["id"],
                "expected_account_revision": view["account"]["revision"], "expected_source_id": selected["id"]}
        path = f'/api/integrations/hubspot/detections/{changed["id"]}/mission'
        return baseline, changed, plan.json(), path, body

    def test_source_event_selection_creates_one_unprepared_mission_without_authority(self):
        _, changed, plan, path, body = self.source_mission_fixture()
        before = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        calls = len(self.calls)
        self.assertEqual(self.client.get(path).status_code, 404)
        created = self.client.post(path, headers=HEADERS, json=body)
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual(created.json()["status"], "mission_created")
        selection = created.json()["selection"]
        self.assertEqual(selection["detection"], changed)
        self.assertEqual(selection["request"]["plan_id"], plan["id"])
        mission_id = selection["mission_id"]
        mission = self.client.get(f"/api/missions/{mission_id}").json()
        self.assertEqual(mission["status"], "draft")
        self.assertEqual(mission["source_detection_id"], changed["id"])
        self.assertEqual(self.client.get(f"/api/missions/{mission_id}/actions").json(), [])
        self.assertEqual(self.client.get(f'/api/plans/{plan["id"]}').json(), plan)
        self.assertEqual(self.client.get(f"/api/accounts/{ACCOUNT_ID}").json(), before)
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).json(),
                         {"schema_version": "1", "status": "mission_exists", "selection": selection})
        self.assertEqual(self.client.get(path).json(), selection)
        self.assertEqual(len(self.calls), calls)

    def test_source_event_selection_migration_preserves_populated_detection_and_plan_history(self):
        from sqlalchemy import text

        from vita_api.migrate import upgrade
        _, changed, plan, path, body = self.source_mission_fixture()
        with self.app.state.store.engine.begin() as connection:
            before = {table.name: list(connection.execute(select(table)).mappings())
                      for table in (detections, source_versions, observations, plans, audits, versions)}
            self.assertEqual(connection.execute(select(comparisons)).all(), [])
            self.assertEqual(connection.execute(select(narratives)).all(), [])
            self.assertEqual(connection.execute(select(probes)).all(), [])
            probes.drop(connection)
            narratives.drop(connection)
            comparisons.drop(connection)
            source_missions.drop(connection)
            connection.execute(text("UPDATE alembic_version SET version_num='0009'"))
        upgrade(self.app.state.store.engine)
        with self.app.state.store.engine.connect() as connection:
            for table in (detections, source_versions, observations, plans, audits, versions):
                self.assertEqual(list(connection.execute(select(table)).mappings()), before[table.name])
            self.assertEqual(connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one(), "0013")
        selected = self.client.post(path, headers=HEADERS, json=body)
        self.assertEqual(selected.status_code, 200, selected.text)
        self.assertEqual(selected.json()["selection"]["detection"], changed)
        self.assertEqual(self.client.get(f'/api/plans/{plan["id"]}').json(), plan)

    def test_source_event_selection_reconstruction_concurrency_conflicts_and_plan_reservation(self):
        _, changed, _, path, body = self.source_mission_fixture()
        calls = len(self.calls)
        with TestClient(create_app(self.settings)) as other, ThreadPoolExecutor(max_workers=2) as pool:
            other.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            pending = [pool.submit(client.post, path, headers=HEADERS, json=body) for client in (self.client, other)]
            results = [item.result(timeout=15) for item in pending]
            self.assertTrue(all(item.status_code == 200 for item in results))
            self.assertEqual(sorted(item.json()["status"] for item in results), ["mission_created", "mission_exists"])
            selection = results[0].json()["selection"]
            self.assertEqual(other.get(path).json(), selection)
        self.assertEqual(self.rows(source_missions), 1)
        self.assertEqual(self.rows(missions), 1)
        self.assertEqual(self.client.post(path, headers=HEADERS, json={**body, "plan_id": str(uuid4())}).status_code, 409)
        ordinary = {key: body[key] for key in ("plan_id", "expected_revision")}
        self.assertEqual(self.client.post("/api/missions", headers=HEADERS, json=ordinary).status_code, 409)
        # A later source change makes the mission stale but cannot recreate it from the old event.
        self.promote_source(vita_usage_change="-50")
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).json()["selection"], selection)
        self.assertEqual(self.client.get(path).json()["detection"], changed)
        self.assertEqual(self.rows(missions), 1)
        fetched = len(self.calls)  # Only the explicit test sync above fetched.
        self.assertGreater(fetched, calls)
        self.client.get(path)
        self.client.post(path, headers=HEADERS, json=body)
        self.assertEqual(len(self.calls), fetched)
        for table in (actions, decisions, claims):
            self.assertEqual(self.rows(table), 0)

    def test_source_event_selection_atomic_failure_and_used_plan_denial(self):
        _, _, _, path, body = self.source_mission_fixture()
        from vita_api.workflow import Workflow
        original = Workflow._audit
        def fail_selection(service, connection, actor, record, event, **kwargs):
            if event == "source_event_selected":
                raise RuntimeError("isolated selection failure")
            return original(service, connection, actor, record, event, **kwargs)
        with patch.object(Workflow, "_audit", fail_selection), self.assertRaisesRegex(RuntimeError, "isolated selection failure"):
            self.client.post(path, headers=HEADERS, json=body)
        for table in (source_missions, missions, actions, decisions, claims):
            self.assertEqual(self.rows(table), 0)
        self.assertEqual(self.rows(audits), 1)  # Only the earlier plan creation.
        self.assertEqual(self.rows(versions), 1)
        ordinary = {key: body[key] for key in ("plan_id", "expected_revision")}
        existing = self.client.post("/api/missions", headers=HEADERS, json=ordinary)
        self.assertEqual(existing.status_code, 200)
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, 409)
        self.assertEqual(self.rows(source_missions), 0)
        self.assertEqual(self.rows(missions), 1)

    def test_source_event_selection_scope_session_revision_source_and_configuration_gates(self):
        baseline, changed, _, path, body = self.source_mission_fixture()
        calls = len(self.calls)
        for changes in ({"event_id": str(uuid4())}, {"expected_source_id": str(uuid4())},
                        {"expected_account_revision": 2}, {"expected_revision": 2}):
            self.assertEqual(self.client.post(path, headers=HEADERS, json={**body, **changes}).status_code, 409)
        self.assertEqual(self.client.post(path, headers=HEADERS, json={**body, "actor_id": "invented"}).status_code, 422)
        self.assertEqual(self.client.post(path, json=body).status_code, 403)
        baseline_path = path.replace(changed["id"], baseline["id"])
        self.assertEqual(self.client.post(baseline_path, headers=HEADERS, json=body).status_code, 409)
        for username, organization, role, expected in [("viewer", SAMPLE_ORG, "viewer", 403),
                ("foreign", "foreign", "admin", 404), ("seller", SAMPLE_ORG, "seller", 200)]:
            self.identity.create_user(username, "test-password-long", organization, role)
            self.login(username)
            if role != "seller":
                self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, expected)
                self.assertEqual(self.client.get(path).status_code, 404)
        self.login()
        for changes in ({"hubspot_portal_id": "999"}, {"hubspot_company_map": {ACCOUNT_ID: "999"}},
                        {"hubspot_property_map": {}}, {"hubspot_company_map": {}}):
            with TestClient(create_app(self.settings.model_copy(update=changes))) as other:
                other.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
                self.assertIn(other.post(path, headers=HEADERS, json=body).status_code, {404, 409})
        with TestClient(create_app(self.settings.model_copy(update={"hubspot_enabled": False}))) as offline:
            offline.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(offline.post(path, headers=HEADERS, json=body).status_code, 200)
        self.login("viewer")
        self.assertEqual(self.client.get(path).status_code, 200)
        self.client.post("/api/auth/logout", headers=HEADERS)
        self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, 401)
        self.assertEqual(len(self.calls), calls)

    def test_source_event_selection_rejects_stale_metadata_only_and_uncited_events(self):
        _, _, plan, path, body = self.source_mission_fixture()
        # A valid plan whose chosen action omits the changed usage evidence is incompatible.
        from vita_api.workflow_contracts import Plan
        original = Plan.model_validate(plan)
        usage = next(item for item in original.alternatives[0].steps[0].evidence_ids
                     if str(item) in {fact["id"] for fact in self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()["evidence"]
                                     if fact["metric"] == "usage_change"})
        altered = original.model_dump(mode="json")
        altered["alternatives"][0]["steps"][0]["evidence_ids"].remove(str(usage))
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(plans).where(plans.c.id == plan["id"]).values(payload=altered))
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, 409)
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(plans).where(plans.c.id == plan["id"]).values(payload=plan))
        self.promote_source(name="Metadata change only")
        self.assertEqual(self.client.post(path, headers=HEADERS, json=body).status_code, 409)
        changed = self.detect_sources().json()["processed"][0]
        view = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        new_plan = self.client.post("/api/plans", headers=HEADERS, json={"account_id": ACCOUNT_ID,
            "expected_revision": view["account"]["revision"], "expected_snapshot_hash": view["assessment"]["snapshot_hash"],
            "intent": "risk"}).json()
        body.update(plan_id=new_plan["id"], expected_account_revision=view["account"]["revision"],
                    expected_source_id=view["source"]["id"], event_id=changed["event"]["id"])
        self.assertEqual(self.client.post(path.replace(path.split("/")[-2], changed["id"]), headers=HEADERS, json=body).status_code, 409)
        self.assertEqual(self.rows(source_missions), 0)

    def test_promoted_source_detection_baseline_unchanged_event_and_restart(self):
        self.enable_mapping()
        self.company["properties"].update({"vita_annual_value": "45000", "vita_renewal_date": "2027-02-01",
            "vita_usage_change": "-25.5", "vita_support_cases": "3", "vita_expansion": "65",
            "vita_measured_at": self.company["updatedAt"]})
        first = self.promote_source()
        baseline = self.detect_sources()
        self.assertEqual(baseline.status_code, 200, baseline.text)
        record = baseline.json()["processed"][0]
        self.assertEqual(record["status"], "baseline")
        self.assertIsNone(record["event"])
        self.assertEqual(record["after"]["source_version_id"], first["id"])
        # Object/measurement time and observation/evidence IDs alone are not value changes.
        self.company["updatedAt"] = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        second = self.promote_source(vita_measured_at=self.company["updatedAt"], vita_usage_change="-25.50")
        unchanged = self.detect_sources().json()["processed"][0]
        self.assertEqual(unchanged["status"], "unchanged")
        self.assertIsNone(unchanged["event"])
        third = self.promote_source(vita_usage_change="-40", vita_renewal_date="2027-01-15")
        before = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        calls = len(self.calls)
        changed = self.detect_sources().json()["processed"][0]
        self.assertEqual(changed["status"], "changed")
        self.assertEqual(changed["before"]["source_version_id"], second["id"])
        self.assertEqual(changed["after"]["source_version_id"], third["id"])
        self.assertEqual({item["field"] for item in changed["event"]["changes"]}, {"usage_change", "renewal_date"})
        usage = next(item for item in changed["event"]["changes"] if item["field"] == "usage_change")
        self.assertEqual(usage["before"]["value"], -25.5)
        self.assertEqual(usage["after"]["value"], -40)
        self.assertEqual(usage["after"]["unit"], "percent")
        self.assertEqual(usage["after"]["observed_at"], self.company["updatedAt"].replace("+00:00", "Z"))
        self.assertEqual(self.detect_sources().json()["processed"], [])
        history_path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/detections"
        history = self.client.get(history_path).json()
        self.assertEqual([item["status"] for item in history], ["changed", "unchanged", "baseline"])
        detail_path = f'/api/integrations/hubspot/detections/{changed["id"]}'
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(restarted.get(detail_path).json(), changed)
            self.assertEqual(restarted.get(history_path).json(), history)
            replay = restarted.post(history_path.replace("/detections", "/detect-changes"), headers=HEADERS,
                json={"expected_account_revision": third["account_revision"], "expected_source_id": third["id"]})
            self.assertEqual(replay.json()["processed"], [])
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.client.get(f"/api/accounts/{ACCOUNT_ID}").json(), before)

    def test_source_detection_processes_saved_switches_and_mapping_boundaries(self):
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        self.promote_source(name="First provider name")
        self.assertEqual(self.client.post(path + "/restore-sample", headers=HEADERS,
            json={"expected_account_revision": 2}).status_code, 200)
        self.promote_source(name="Other provider name")
        # All three source selections predate the first detection request.
        result = self.detect_sources().json()["processed"]
        self.assertEqual([item["status"] for item in result], ["baseline", "source_reset", "baseline"])
        self.assertEqual(result[-1]["reason"], "source_switch")
        self.assertTrue(all(item["event"] is None for item in result))
        self.enable_mapping({"annual_value": PROPERTY_MAP["annual_value"]})
        self.promote_source(vita_annual_value="40000")
        changed_mapping = self.detect_sources().json()["processed"][0]
        self.assertEqual(changed_mapping["status"], "baseline")
        self.assertEqual(changed_mapping["reason"], "mapping_changed")
        self.assertIsNone(changed_mapping["event"])
        # Provider identity changes reset even if the target account is unchanged.
        self.company["id"] = "124"
        settings = self.settings.model_copy(update={"hubspot_company_map": {ACCOUNT_ID: "124"}})
        with TestClient(create_app(settings, hubspot_transport=httpx.MockTransport(self.respond))) as other:
            other.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(other.post(path + "/sync", headers=HEADERS,
                json={"expected_account_revision": 5}).json()["status"], "succeeded")
            preview = other.get(path + "/preview").json()
            source = other.post(path + "/promote", headers=HEADERS, json={"expected_account_revision": 5,
                "observation_id": preview["observation_id"], "preview_hash": preview["preview_hash"]}).json()
            response = other.post(path + "/detect-changes", headers=HEADERS, json={
                "expected_account_revision": 6, "expected_source_id": source["id"]})
            self.assertEqual(response.status_code, 200, response.text)
            record = response.json()["processed"][0]
            self.assertEqual(record["reason"], "source_identity_changed")
            self.assertEqual(record["before"]["company_id"], "123")
            self.assertEqual(record["after"]["company_id"], "124")
            self.assertIsNone(record["event"])

    def test_source_detection_missing_invalid_and_repeated_transition_occurrences(self):
        self.enable_mapping({"annual_value": PROPERTY_MAP["annual_value"]})
        for value in ("40000", None, "bad", "40000", None):
            self.promote_source(vita_annual_value=value)
        records = self.detect_sources().json()["processed"]
        self.assertEqual([item["status"] for item in records], ["baseline", "changed", "changed", "changed", "changed"])
        self.assertEqual([item["after"]["fields"]["annual_value"]["status"] for item in records],
                         ["valid", "missing", "invalid", "valid", "missing"])
        events = [item["event"] for item in records[1:]]
        self.assertTrue(all(item["changes"][0]["kind"] == "availability_changed" for item in events))
        self.assertNotEqual(events[0]["id"], events[-1]["id"])
        self.assertEqual(len({item["fingerprint"] for item in events}), 4)
        # Detection time and actor cannot change an occurrence's stable identity.
        from vita_api.hubspot_changes import detect
        event = SourceDetection.model_validate(records[-1])
        replay = detect(event.organization_id, str(event.account_id), "another-admin", event.before, event.after,
                        datetime.now(UTC) + timedelta(days=1))
        self.assertEqual(replay.id, event.id)
        self.assertEqual(replay.event, event.event)
        self.assertEqual(self.detect_sources().json()["processed"], [])

    def test_source_detection_bounded_catchup_history_and_no_authority_changes(self):
        for index in range(23):
            self.promote_source(name=f"Saved company {index}")
        before = self.client.get("/api/portfolio").json()
        calls = len(self.calls)
        with self.app.state.store.engine.connect() as connection:
            sources = list(connection.execute(select(source_versions)).mappings())
        first = self.detect_sources().json()
        self.assertEqual(len(first["processed"]), 20)
        self.assertTrue(first["has_more"])
        self.assertEqual(first["last_processed_revision"], 21)
        self.assertEqual(first["processed"][0]["status"], "baseline")
        second = self.detect_sources().json()
        self.assertEqual(len(second["processed"]), 3)
        self.assertFalse(second["has_more"])
        self.assertEqual(second["last_processed_revision"], 24)
        self.assertEqual(second["processed"][0]["before"], first["processed"][-1]["after"])
        history = self.client.get(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/detections").json()
        self.assertEqual(len(history), 20)
        self.assertEqual([item["after"]["account_revision"] for item in history], list(range(24, 4, -1)))
        self.assertEqual(self.detect_sources().json()["processed"], [])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        with self.app.state.store.engine.connect() as connection:
            self.assertEqual(list(connection.execute(select(source_versions)).mappings()), sources)
        self.assertEqual(len(self.calls), calls)

    def test_source_detection_rollback_then_two_engine_concurrency(self):
        self.promote_source(name="Before")
        selected = self.promote_source(name="After")
        original_dump = SourceDetection.model_dump
        count = 0
        def fail_second(record, **kwargs):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError("isolated detection failure")
            return original_dump(record, **kwargs)
        with patch.object(SourceDetection, "model_dump", fail_second), self.assertRaisesRegex(RuntimeError, "isolated detection failure"):
            self.detect_sources()
        self.assertEqual(self.rows(detections), 0)
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/detect-changes"
        body = {"expected_account_revision": 3, "expected_source_id": selected["id"]}
        with TestClient(create_app(self.settings)) as other, ThreadPoolExecutor(max_workers=2) as pool:
            other.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            pending = [pool.submit(client.post, path, headers=HEADERS, json=body) for client in (self.client, other)]
            results = [item.result(timeout=15) for item in pending]
        self.assertTrue(all(item.status_code == 200 for item in results))
        self.assertEqual(sorted(len(item.json()["processed"]) for item in results), [0, 2])
        self.assertEqual(self.rows(detections), 2)

    def test_source_detection_scope_revision_roles_and_no_provider_requirement(self):
        source = self.promote_source()
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        body = {"expected_account_revision": 2, "expected_source_id": source["id"]}
        calls = len(self.calls)
        self.assertEqual(self.detect_sources(expected_account_revision=1).status_code, 409)
        self.assertEqual(self.detect_sources(expected_source_id=str(uuid4())).status_code, 409)
        self.assertEqual(self.detect_sources(actor_id="invented").status_code, 422)
        self.assertEqual(self.client.post(path + "/detect-changes", json=body).status_code, 403)
        for username, organization, role in [("seller", SAMPLE_ORG, "seller"), ("viewer", SAMPLE_ORG, "viewer"),
                                              ("foreign", "other-org", "admin")]:
            self.identity.create_user(username, "test-password-long", organization, role)
            self.login(username)
            self.assertEqual(self.client.post(path + "/detect-changes", headers=HEADERS, json=body).status_code,
                             403 if organization == SAMPLE_ORG else 404)
        self.login()
        with TestClient(create_app(self.settings.model_copy(update={"hubspot_enabled": False}))) as offline:
            offline.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            saved = offline.post(path + "/detect-changes", headers=HEADERS, json=body)
            self.assertEqual(saved.status_code, 200, saved.text)
        record = saved.json()["processed"][0]
        detail = f'/api/integrations/hubspot/detections/{record["id"]}'
        for username, code in [("viewer", 200), ("foreign", 404)]:
            self.login(username)
            self.assertEqual(self.client.get(detail).status_code, code)
            self.assertEqual(self.client.get(path + "/detections").status_code, code)
        self.login()
        self.identity.logout(self.client.cookies.get("vitaai_session"))
        self.assertEqual(self.client.post(path + "/detect-changes", headers=HEADERS, json=body).status_code, 401)
        self.assertEqual(self.client.get(detail).status_code, 401)
        self.assertEqual(len(self.calls), calls)

    def test_source_detection_migration_preserves_populated_prior_history(self):
        from sqlalchemy import text
        self.promote_source(name="Historical before")
        source = self.promote_source(name="Historical after")
        before = self.client.get("/api/portfolio").json()
        with self.app.state.store.engine.begin() as connection:
            saved = list(connection.execute(select(source_versions)).mappings())
            # Reproduce populated 0008: remove later detection/selection/comparison/narrative/probe tables.
            self.assertEqual(connection.execute(select(comparisons)).all(), [])
            self.assertEqual(connection.execute(select(narratives)).all(), [])
            self.assertEqual(connection.execute(select(probes)).all(), [])
            probes.drop(connection)
            narratives.drop(connection)
            comparisons.drop(connection)
            source_missions.drop(connection)
            detections.drop(connection)
            connection.execute(text("UPDATE alembic_version SET version_num='0008'"))
        with TestClient(create_app(self.settings)) as upgraded:
            upgraded.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(upgraded.get("/api/portfolio").json(), before)
            with upgraded.app.state.store.engine.connect() as connection:
                self.assertEqual(list(connection.execute(select(source_versions)).mappings()), saved)
                self.assertEqual(connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one(), "0013")
            response = upgraded.post(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/detect-changes", headers=HEADERS,
                json={"expected_account_revision": 3, "expected_source_id": source["id"]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual([item["status"] for item in response.json()["processed"]], ["baseline", "changed"])

    def test_typed_properties_measurement_times_invalid_values_and_mapping_changes(self):
        self.enable_mapping()
        measured = self.company["updatedAt"]
        self.company["properties"].update({"vita_annual_value": "45000", "vita_renewal_date": "2027-02-01",
            "vita_usage_change": "-25.5", "vita_support_cases": "3", "vita_expansion": "65",
            "vita_measured_at": measured})
        self.assertEqual(self.sync().json()["status"], "succeeded")
        body, preview = self.promotion_body(1)
        self.assertEqual(preview["account"]["annual_value"], 45000)
        self.assertEqual(preview["account"]["renewal_date"], "2027-02-01")
        self.assertEqual(len(preview["evidence"]), 4)
        self.assertEqual({fact["observed_at"] for fact in preview["evidence"]}, {measured})
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        result = self.client.post(path + "/promote", headers=HEADERS, json=body)
        self.assertEqual(result.status_code, 200, result.text)
        account = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        self.assertEqual(account["assessment"]["confidence"], 100)
        self.assertFalse(account["assessment"]["requires_review"])
        original_history = self.client.get(f'/api/integrations/hubspot/sources/{result.json()["id"]}').json()
        observation = self.client.get(f'/api/integrations/hubspot/observations/{body["observation_id"]}').json()
        self.assertEqual(observation["property_mapping"], {key: value.model_dump() for key, value in self.settings.hubspot_property_map.items()})
        self.assertTrue(all(body["observation_id"] in fact["source_record"] for fact in account["evidence"]))
        self.company["properties"].update({"vita_annual_value": "1.25", "vita_renewal_date": "not a date",
            "vita_usage_change": "NaN", "vita_support_cases": "-1", "vita_expansion": "101"})
        self.sync(expected_account_revision=2)
        invalid, preview = self.promotion_body(2)
        self.assertTrue(all(preview["field_status"][key] == "invalid" for key in PROPERTY_MAP))
        self.assertEqual(preview["evidence"], [])
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=invalid).status_code, 200)
        current = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        self.assertIsNone(current["account"]["annual_value"])
        self.assertEqual(current["evidence"], [])
        self.assertEqual(self.client.get(f'/api/integrations/hubspot/sources/{result.json()["id"]}').json(), original_history)
        changed = copy.deepcopy(PROPERTY_MAP)
        changed["annual_value"]["property"] = "other_contract_value"
        self.enable_mapping(changed)
        self.assertEqual(self.client.get(path + "/preview").status_code, 409)
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=invalid).status_code, 409)

    def test_metric_timestamps_and_provider_type_mismatch_never_fabricate_facts(self):
        self.enable_mapping()
        self.company["properties"].update({"vita_usage_change": "-15", "vita_support_cases": "2", "vita_expansion": "50"})
        first = self.sync().json()
        _, preview = self.promotion_body(1)
        self.assertEqual(preview["evidence"], [])
        self.assertEqual(preview["field_status"]["usage_change"], "invalid")
        self.types["vita_usage_change"] = "string"
        failed = self.sync().json()
        self.assertEqual(failed["error_code"], "property_type_mismatch")
        self.assertEqual(self.rows(observations), 1)
        self.assertEqual(first["status"], "succeeded")
        self.assertEqual(self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()["account"]["revision"], 1)
        for target, changes in [("annual_value", {"property": "annualrevenue"}),
                                ("usage_change", {"observed_at_property": None}),
                                ("annual_value", {"unit": "EUR/year"}), ("support_cases", {"meaning": "all_tickets"})]:
            mapping = copy.deepcopy(PROPERTY_MAP)
            mapping[target].update(changes)
            with self.subTest(target=target, changes=changes), self.assertRaises(ValidationError):
                configured(hubspot_property_map=mapping)

    def test_concurrent_promotion_and_restored_observation_requires_new_bound_read(self):
        self.sync()
        body, _ = self.promotion_body(1)
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        token = self.client.cookies.get("vitaai_session")
        def promote(client):
            return client.post(path + "/promote", headers=HEADERS, json=body)
        with TestClient(create_app(self.settings)) as other, ThreadPoolExecutor(max_workers=2) as pool:
            other.cookies.set("vitaai_session", token)
            pending = [pool.submit(promote, client) for client in (self.client, other)]
            responses = [request.result(timeout=15) for request in pending]
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        self.assertEqual(self.rows(source_versions), 1)
        self.assertEqual(self.client.post(path + "/restore-sample", headers=HEADERS,
                                         json={"expected_account_revision": 2}).status_code, 200)
        body, _ = self.promotion_body(3)
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=body).status_code, 409)
        refreshed = self.sync(expected_account_revision=3).json()
        self.assertEqual(refreshed["disposition"], "unchanged")
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=body).status_code, 200)
        self.assertEqual(self.rows(observations), 1)
        self.assertEqual(self.rows(source_versions), 3)

    def test_source_round_trip_invalidates_approved_execution_without_rewriting_history(self):
        def post(path, body):
            response = self.client.post(path, headers=HEADERS, json=body)
            self.assertEqual(response.status_code, 200, response.text)
            return response.json()
        view = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        plan = post("/api/plans", {"account_id": ACCOUNT_ID, "expected_revision": 1,
            "expected_snapshot_hash": view["assessment"]["snapshot_hash"], "intent": "risk"})
        mission = post("/api/missions", {"plan_id": plan["id"], "expected_revision": plan["revision"]})
        action = post(f'/api/missions/{mission["id"]}/prepare', {"expected_revision": mission["revision"],
            "alternative_id": plan["selected_alternative_id"], "connector_id": "simulation-hubspot",
            "payload": {"kind": "hubspot_task_create", "title": "Review support", "body": "Exact approved body\n "}})
        action = post(f'/api/actions/{action["id"]}/submit', {"expected_revision": action["revision"],
            "binding_hash": action["binding_hash"]})
        decision = post(f'/api/actions/{action["id"]}/review', {"expected_revision": action["revision"],
            "binding_hash": action["binding_hash"], "decision": "approved"})
        history_path = f'/api/actions/{action["id"]}/history'
        history = self.client.get(history_path).json()
        self.sync()
        body, _ = self.promotion_body(1)
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        post(path + "/promote", body)
        execution = {"expected_revision": action["revision"], "decision_id": decision["id"], "idempotency_key": "old-source"}
        for restored in (False, True):
            if restored:
                post(path + "/restore-sample", {"expected_account_revision": 2})
            detection = self.detect_sources()
            self.assertEqual(detection.status_code, 200, detection.text)
            denied = self.client.post(f'/api/actions/{action["id"]}/execute', headers=HEADERS, json=execution)
            self.assertEqual(denied.status_code, 409, denied.text)
            self.assertEqual(denied.json()["detail"]["code"], "plan_evidence_changed")
            self.assertEqual(self.client.get(history_path).json(), history)
            self.assertEqual(self.client.get(f'/api/actions/{action["id"]}/decisions').json(), [decision])
            self.assertEqual(self.client.get(f'/api/actions/{action["id"]}/executions').json(), [])
        # A second unclaimed mission can remain draft while its source becomes empty.
        fresh = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        plan2 = post("/api/plans", {"account_id": ACCOUNT_ID, "expected_revision": 3,
            "expected_snapshot_hash": fresh["assessment"]["snapshot_hash"], "intent": "risk"})
        draft = post("/api/missions", {"plan_id": plan2["id"], "expected_revision": 1})
        self.sync(expected_account_revision=3)
        body, _ = self.promotion_body(3)
        post(path + "/promote", body)
        denied = self.client.post(f'/api/missions/{draft["id"]}/supersede', headers=HEADERS, json={
            "expected_revision": draft["revision"], "plan_id": plan2["id"], "expected_plan_revision": 1})
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertEqual(denied.json()["detail"]["code"], "plan_evidence_changed")
        self.assertEqual(self.client.get(f'/api/missions/{draft["id"]}').json(), draft)
        self.assertEqual(self.client.get("/api/portfolio").json()["mode"], "mixed")

    def test_failed_source_history_insert_rolls_back_account_and_facts(self):
        from vita_api.hubspot_normalize import AccountSourceVersion
        self.sync()
        body, _ = self.promotion_body(1)
        before = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        with (patch.object(AccountSourceVersion, "model_dump", side_effect=RuntimeError("injected persistence failure")),
              self.assertRaisesRegex(RuntimeError, "injected persistence failure")):
            self.client.post(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/promote", headers=HEADERS, json=body)
        self.assertEqual(self.client.get(f"/api/accounts/{ACCOUNT_ID}").json(), before)
        self.assertEqual(self.rows(source_versions), 0)

    def sync(self, **changes):
        return self.client.post(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/sync", headers=HEADERS,
                                json={"expected_account_revision": 1, **changes})

    def rows(self, table):
        with self.app.state.store.engine.connect() as connection:
            return connection.execute(select(func.count()).select_from(table)).scalar_one()

    def test_explicit_preview_promotion_restoration_and_immutable_staging(self):
        before = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        staged = self.sync().json()
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        preview = self.client.get(path + "/preview").json()
        self.assertEqual(preview["observation_id"], staged["observation_id"])
        self.assertIsNone(preview["account"]["annual_value"])
        self.assertIsNone(preview["account"]["renewal_date"])
        self.assertEqual(preview["evidence"], [])
        calls = len(self.calls)
        body = {"expected_account_revision": 1, "observation_id": staged["observation_id"],
                "preview_hash": preview["preview_hash"]}
        promoted = self.client.post(path + "/promote", headers=HEADERS, json=body)
        self.assertEqual(promoted.status_code, 200, promoted.text)
        after = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        self.assertEqual(after["account"]["revision"], 2)
        self.assertFalse(after["account"]["synthetic"])
        self.assertEqual(after["evidence"], [])
        self.assertTrue(after["assessment"]["requires_review"])
        self.assertEqual(after["source"]["observation_id"], staged["observation_id"])
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=body).status_code, 409)
        fresh = self.client.get(path + "/preview").json()
        unchanged = self.client.post(path + "/promote", headers=HEADERS, json={
            **body, "expected_account_revision": 2, "preview_hash": fresh["preview_hash"]})
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        self.assertEqual(unchanged.json()["account_revision"], 2)
        restored = self.client.post(path + "/restore-sample", headers=HEADERS,
                                    json={"expected_account_revision": 2})
        self.assertEqual(restored.status_code, 200, restored.text)
        current = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        self.assertEqual(current["account"], {**before["account"], "revision": 3})
        self.assertEqual(current["evidence"], before["evidence"])
        self.assertNotEqual(current["assessment"]["snapshot_hash"], before["assessment"]["snapshot_hash"])
        self.assertEqual(len(self.calls), calls)
        self.assertEqual(self.rows(observations), 1)
        self.assertEqual(self.client.get(f'/api/integrations/hubspot/observations/{staged["observation_id"]}').json()["account_revision"], 1)
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(restarted.get(f"/api/accounts/{ACCOUNT_ID}").json(), current)

    def test_promotion_schema_scope_latest_and_preview_binding(self):
        staged = self.sync().json()
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}"
        preview = self.client.get(path + "/preview").json()
        body = {"expected_account_revision": 1, "observation_id": staged["observation_id"],
                "preview_hash": preview["preview_hash"]}
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS,
                                         json={**body, "preview_hash": "0" * 64}).status_code, 409)
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS,
                                         json={**body, "company_id": "999"}).status_code, 422)
        self.identity.create_user("viewer", "test-password-long", SAMPLE_ORG, "viewer")
        self.login("viewer")
        self.assertEqual(self.client.get(path + "/preview").status_code, 200)
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=body).status_code, 403)
        self.login()
        self.company["properties"]["name"] = "Newer company"
        self.sync()
        self.assertEqual(self.client.post(path + "/promote", headers=HEADERS, json=body).status_code, 409)
        self.assertEqual(self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()["account"]["revision"], 1)

    def test_staged_read_dedup_change_restart_and_unmodified_authority(self):
        before = self.client.get(f"/api/accounts/{ACCOUNT_ID}").json()
        self.assertEqual(self.client.get("/api/integrations/hubspot").json()["status"], "configured_unverified")
        self.assertEqual(self.calls, [])
        first = self.sync().json()
        self.assertEqual(first["status"], "succeeded")
        self.assertEqual(first["disposition"], "baseline")
        original_updated = self.company["updatedAt"]
        second = self.sync().json()
        self.assertEqual(second["disposition"], "unchanged")
        self.assertEqual(second["observation_id"], first["observation_id"])
        self.company["properties"]["name"] = "Changed name"
        self.company["updatedAt"] = (datetime.now(UTC) - timedelta(hours=1)).isoformat().replace("+00:00", "Z")
        third = self.sync().json()
        self.assertEqual(third["disposition"], "changed")
        self.assertNotEqual(third["observation_id"], first["observation_id"])
        self.assertEqual(self.rows(observations), 2)
        self.assertEqual(self.rows(sync_runs), 3)
        self.assertEqual(self.client.get(f"/api/accounts/{ACCOUNT_ID}").json(), before)
        first_path = f'/api/integrations/hubspot/observations/{first["observation_id"]}'
        observation = self.client.get(first_path).json()
        self.assertEqual(observation["properties"], COMPANY["properties"])
        self.assertEqual(observation["provider_updated_at"], original_updated)
        self.assertEqual(observation["source"], "hubspot")
        self.assertNotIn("test-only-token", str(observation))
        calls_before = len(self.calls)
        with TestClient(create_app(self.settings, hubspot_transport=httpx.MockTransport(self.respond))) as restarted:
            restarted.cookies.set("vitaai_session", self.client.cookies.get("vitaai_session"))
            self.assertEqual(restarted.get(first_path).json(), observation)
            self.assertEqual(restarted.get(f'/api/integrations/hubspot/runs/{third["id"]}').json(), third)
        self.assertEqual(len(self.calls), calls_before)

    def test_failed_read_records_safe_failure_without_replacing_prior_success(self):
        first = self.sync().json()
        self.status = 429
        self.company = {"message": "test-only-token; provider-private-body"}
        failed = self.sync().json()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error_code"], "hubspot_http_429")
        self.assertIsNone(failed["observation_id"])
        self.assertIsNone(failed["disposition"])
        self.assertEqual(self.rows(observations), 1)
        self.assertEqual(self.rows(sync_runs), 2)
        self.assertNotIn("test-only-token", str(failed))
        self.assertNotIn("provider-private-body", str(failed))
        self.assertEqual(self.client.get(f'/api/integrations/hubspot/runs/{first["id"]}').json(), first)

    def test_role_scope_schema_revision_and_origin_deny_before_network(self):
        for username, organization, role in [("seller", SAMPLE_ORG, "seller"), ("viewer", SAMPLE_ORG, "viewer"),
                                              ("foreign", "other-org", "admin")]:
            self.identity.create_user(username, "test-password-long", organization, role)
            self.login(username)
            self.assertIn(self.sync().status_code, (403, 404))
        self.login()
        self.assertEqual(self.sync(expected_account_revision=2).status_code, 409)
        invalid = self.sync(company_id="999", token="should-not-echo")
        self.assertEqual(invalid.status_code, 422)
        self.assertNotIn("should-not-echo", invalid.text)
        path = f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/sync"
        self.assertEqual(self.client.post(path, json={"expected_account_revision": 1}).status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.sync().status_code, 401)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.rows(sync_runs), 0)

    def test_revocation_transfer_or_demotion_during_network_cannot_persist(self):
        for change in ("logout", "transfer", "demote"):
            with self.subTest(change=change):
                def revoke(change=change):
                    if change == "logout":
                        self.identity.logout(self.client.cookies.get("vitaai_session"))
                    else:
                        with self.app.state.store.engine.begin() as connection:
                            connection.execute(update(users).where(users.c.id == self.admin.id).values(
                                **({"organization_id": "other-org"} if change == "transfer" else {"role": "viewer"})))
                self.on_company = revoke
                self.assertIn(self.sync().status_code, (401, 403, 404, 409))
                self.assertEqual(self.rows(sync_runs), 0)
                self.assertEqual(self.rows(observations), 0)
                with self.app.state.store.engine.begin() as connection:
                    connection.execute(update(users).where(users.c.id == self.admin.id).values(
                        organization_id=SAMPLE_ORG, role="admin"))
                self.login()

    def test_history_scope_and_viewer_reads_do_not_grant_sync_authority(self):
        run = self.sync().json()
        paths = [f'/api/integrations/hubspot/runs/{run["id"]}',
                 f'/api/integrations/hubspot/observations/{run["observation_id"]}']
        self.identity.create_user("viewer", "test-password-long", SAMPLE_ORG, "viewer")
        self.identity.create_user("foreign", "test-password-long", "other-org", "admin")
        self.login("viewer")
        for path in paths:
            self.assertEqual(self.client.get(path).status_code, 200)
        self.assertEqual(self.sync().status_code, 403)
        self.login("foreign")
        for path in paths:
            self.assertEqual(self.client.get(path).status_code, 404)
        self.assertFalse(self.client.get("/api/integrations/hubspot").json()["configured"])
        self.assertEqual(len(self.calls), 2)

    def test_company_updated_during_request_is_not_future_but_real_future_is_rejected(self):
        def update_during_read():
            self.company["updatedAt"] = datetime.now(UTC).isoformat()
        self.on_company = update_during_read
        self.assertEqual(self.sync().json()["status"], "succeeded")
        self.on_company = None
        self.company["updatedAt"] = (datetime.now(UTC) + timedelta(days=1)).isoformat()
        failed = self.sync().json()
        self.assertEqual(failed["status"], "failed")
        self.assertEqual(failed["error_code"], "invalid_source_time")
        self.assertEqual(self.rows(observations), 1)

    def test_concurrent_same_snapshot_and_delayed_stale_read(self):
        token = self.client.cookies.get("vitaai_session")
        waiting, release = Event(), Event()
        lock = Lock()
        counter = 0
        newer = copy.deepcopy(self.company)
        newer["properties"]["name"] = "Newer name"
        newer["updatedAt"] = (datetime.now(UTC) - timedelta(hours=1)).isoformat()
        delayed_payload = copy.deepcopy(newer)

        def transport(request):
            nonlocal counter
            if request.url.path == "/account-info/v3/details":
                return httpx.Response(200, json={"portalId": 456})
            with lock:
                index = counter
                counter += 1
            if index == 0:
                waiting.set()
                if not release.wait(10):
                    raise AssertionError("Concurrent request did not finish")
                return httpx.Response(200, json=delayed_payload)
            return httpx.Response(200, json=newer)

        def request(client):
            return client.post(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/sync", headers=HEADERS,
                               json={"expected_account_revision": 1})

        for identical in (True, False):
            with self.subTest(identical=identical):
                waiting.clear()
                release.clear()
                counter = 0
                if not identical:
                    delayed_payload = copy.deepcopy(self.company)
                    newer["properties"]["name"] = "Newest name"
                with TestClient(create_app(self.settings, hubspot_transport=httpx.MockTransport(transport))) as one, \
                     TestClient(create_app(self.settings, hubspot_transport=httpx.MockTransport(transport))) as two, \
                     ThreadPoolExecutor(max_workers=2) as pool:
                    one.cookies.set("vitaai_session", token)
                    two.cookies.set("vitaai_session", token)
                    delayed = pool.submit(request, one)
                    try:
                        self.assertTrue(waiting.wait(10))
                        current = pool.submit(request, two).result(timeout=15)
                        self.assertEqual(current.status_code, 200)
                    finally:
                        release.set()
                    stale = delayed.result(timeout=15)
                self.assertEqual(stale.status_code, 200 if identical else 409)
                if identical:
                    self.assertEqual(stale.json()["observation_id"], current.json()["observation_id"])
                    self.assertEqual(self.rows(observations), 1)
                else:
                    self.assertEqual(stale.json()["detail"]["code"], "observation_changed_during_sync")
                    self.assertEqual(self.rows(observations), 2)
