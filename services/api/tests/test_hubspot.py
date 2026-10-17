"""Local HTTP/database checks; HubSpot network responses are explicitly mocked."""
import copy
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Event, Lock
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, func, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.hubspot import HubSpot, HubSpotFailure
from vita_api.hubspot_sync import observations, sync_runs
from vita_api.identity import Identity, users
from vita_api.sample import SAMPLE_ORG, sample_records

NOW = datetime(2026, 10, 18, 12, tzinfo=UTC)
ACCOUNT_ID = sample_records(NOW)[0][0].id
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}
COMPANY = {"id": "123", "archived": False, "createdAt": "2026-09-01T00:00:00Z",
           "updatedAt": "2026-10-17T12:00:00Z",
           "properties": {"name": "Test company", "domain": "example.test", "industry": None}}


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
        if self.on_company:
            self.on_company()
        return httpx.Response(self.status, json=self.company)

    def login(self, username="admin"):
        self.client.cookies.clear()
        response = self.client.post("/api/auth/login", headers=HEADERS,
                                    json={"username": username, "password": "test-password-long"})
        self.assertEqual(response.status_code, 200)

    def sync(self, **changes):
        return self.client.post(f"/api/integrations/hubspot/accounts/{ACCOUNT_ID}/sync", headers=HEADERS,
                                json={"expected_account_revision": 1, **changes})

    def rows(self, table):
        with self.app.state.store.engine.connect() as connection:
            return connection.execute(select(func.count()).select_from(table)).scalar_one()

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
