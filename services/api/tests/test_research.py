"""Real isolated HTTP/database components; all search transport is explicitly mocked."""
import copy
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.app import create_app
from vita_api.config import ResearchTarget, Settings
from vita_api.identity import Identity, users
from vita_api.research import PREFIX, Research, ResearchFailure, ResearchRequest
from vita_api.research_service import ResearchService, research_runs
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.storage import Store, accounts

ACCOUNT = sample_records(datetime.now(UTC))[0][0].id
TARGET = {"company_name": "Example Company", "domain": "example.test"}
HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}
ITEM = {"title": "Company update", "url": "https://example.test/news", "content": "Untrusted external text",
        "score": 0.8, "published_date": "2026-01-01T12:00:00Z"}


def settings(**changes):
    return Settings(_env_file=None, **{"auth_mode": "session", "research_enabled": True,
        "research_live_enabled": True, "research_api_key": "synthetic-search-token",
        "research_organization_id": SAMPLE_ORG, "research_account_map": {ACCOUNT: TARGET}, **changes})


class ResearchTransportTests(unittest.TestCase):
    def test_fixed_bounded_contract_and_provenance(self):
        calls = []
        def respond(request):
            calls.append(request)
            self.assertEqual(str(request.url), "https://api.tavily.com/search")
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.headers["authorization"], "Bearer synthetic-search-token")
            body = json.loads(request.content)
            self.assertEqual(body["include_domains"], ["example.test"])
            self.assertEqual(body["search_depth"], "basic")
            self.assertFalse(body["auto_parameters"])
            self.assertFalse(body["include_answer"])
            self.assertFalse(body["include_raw_content"])
            return httpx.Response(200, json={"results": [ITEM, ITEM, {**ITEM, "url": "https://unrelated.test/"},
                {**ITEM, "url": "https://news.example.test/older", "published_date": None}]})
        result = Research(settings(), httpx.MockTransport(respond)).search(ResearchTarget(**TARGET))
        self.assertEqual(len(calls), 1)
        self.assertEqual(len(result), 2)
        self.assertEqual(result[0].freshness_at_fetch, "stale")
        self.assertEqual(result[1].freshness_at_fetch, "unknown")
        self.assertIsNone(result[1].published_at)
        self.assertEqual(result[0].factual_confidence, "unverified")
        self.assertEqual(result[0].text, ITEM["content"])
        self.assertGreater(result[0].fetched_at, result[0].published_at)

    def test_invalid_bounds_time_text_and_safe_transport_errors(self):
        payloads = [b"{", b"x" * 65537, b"[]", json.dumps({"results": [ITEM] * 6}).encode()]
        for field, value in [("score", float("nan")), ("score", True), ("score", 2), ("title", ""),
                             ("content", 123), ("content", "x" * 4001),
                             ("published_date", "tomorrow"), ("published_date", "2099-01-01T00:00:00Z"),
                             ("published_date", "2026-01-01")]:
            payloads.append(json.dumps({"results": [{**ITEM, field: value}]}).encode())
        for payload in payloads:
            with self.subTest(payload_size=len(payload)), self.assertRaises(ResearchFailure):
                Research(settings(), httpx.MockTransport(lambda _, payload=payload:
                    httpx.Response(200, content=payload))).search(ResearchTarget(**TARGET))
        for code in [302, 401, 429, 500]:
            with self.subTest(code=code), self.assertRaises(ResearchFailure) as caught:
                connector = Research(settings(), httpx.MockTransport(lambda _, code=code: httpx.Response(code,
                    json={"detail": "synthetic-search-token"}, headers={"Location": "https://foreign.test"})))
                connector.search(ResearchTarget(**TARGET))
            self.assertEqual(str(caught.exception), f"research_http_{code}")
        for error, code in [(httpx.ReadTimeout("synthetic-search-token"), "research_timeout"),
                            (httpx.ConnectError("synthetic-search-token"), "research_network_error")]:
            def fail(_, error=error):
                raise error
            with self.assertRaises(ResearchFailure) as caught:
                Research(settings(), httpx.MockTransport(fail)).search(ResearchTarget(**TARGET))
            self.assertEqual(str(caught.exception), code)

    def test_unsafe_sources_config_and_unknown_request_fields(self):
        urls = ["javascript:alert(1)", "http://example.test/", "https://example.test.evil.test/",
                "https://user:pass@example.test/", "https://example.test:8443/", "https://example.test/?token=x",
                "https://example.test/#fragment", "https://example.test/\nnews"]
        for url in urls:
            with self.subTest(url=url):
                result = Research(settings(), httpx.MockTransport(lambda _, url=url:
                    httpx.Response(200, json={"results": [{**ITEM, "url": url}]}))).search(ResearchTarget(**TARGET))
                self.assertEqual(result, [])
        for mapping in [{"*": TARGET}, {ACCOUNT: {**TARGET, "domain": "*"}},
                        {ACCOUNT: {**TARGET, "domain": "https://example.test"}}]:
            with self.assertRaises(ValidationError):
                settings(research_account_map=mapping)
        with self.assertRaises(ValidationError):
            ResearchRequest(expected_account_revision=1, query="client-selected")


class ResearchApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pg_admin = None
        database_url = f"sqlite:///{Path(self.temp.name) / 'research.sqlite'}"
        if os.environ.get("VITAAI_POSTGRES_TEST_URL"):
            self.pg_admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"])
            self.schema = "vitaai_research_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(self.schema))
            database_url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + self.schema}).render_as_string(hide_password=False)
        self.settings = settings(database_url=database_url)
        self.calls, self.on_search, self.code = [], None, 200
        self.app = create_app(self.settings, research_transport=httpx.MockTransport(self.respond))
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

    def login(self, username="admin"):
        self.client.cookies.clear()
        response = self.client.post("/api/auth/login", headers=HEADERS,
            json={"username": username, "password": "test-password-long"})
        self.assertEqual(response.status_code, 200)

    def respond(self, request):
        self.calls.append(request)
        with self.app.state.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(research_runs.c.status)).scalar_one(), "pending")
        if self.on_search:
            self.on_search()
        return httpx.Response(self.code, json={"results": [ITEM], "secret_extra": "synthetic-search-token"})

    def search(self, **changes):
        return self.client.post(f"{PREFIX}/accounts/{ACCOUNT}/search", headers=HEADERS,
            json={"expected_account_revision": 1, "mode": "live", **changes})

    def test_saved_sources_history_reconstruction_and_unchanged_authority(self):
        before = self.client.get("/api/portfolio").json()
        response = self.search()
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()
        self.assertEqual((run["mode"], run["status"]), ("live", "succeeded"))
        self.assertNotIn("synthetic-search-token", response.text)
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.client.get(f'{PREFIX}/runs/{run["id"]}').json(), run)
        token = self.client.cookies.get("vitaai_session")
        separate = Store(self.settings.database_url)
        try:
            saved = ResearchService(separate, Research(self.settings), token).get(run["id"])
            self.assertEqual(saved.model_dump(mode="json"), run)
        finally:
            separate.engine.dispose()
        self.assertEqual(self.client.get(f"{PREFIX}/accounts/{ACCOUNT}/runs").json(), [run])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.search().status_code, 429)
        self.assertEqual(len(self.calls), 1)

    def test_disabled_mock_unconfigured_and_failed_fallback_are_distinct(self):
        for config, body, mode, status in [({"research_enabled": False}, {}, "disabled", "unavailable"),
                ({}, {"mode": "mock"}, "mock", "succeeded"),
                ({"research_live_enabled": False}, {}, "fallback", "unavailable"),
                ({"research_api_key": ""}, {}, "fallback", "unavailable")]:
            isolated = settings(database_url=f"sqlite:///{Path(self.temp.name) / (mode + str(uuid4()) + '.sqlite')}", **config)
            def fail(_):
                self.fail("Unexpected live request")
            with TestClient(create_app(isolated, research_transport=httpx.MockTransport(fail))) as client:
                Identity(client.app.state.store.engine).create_user("admin", "test-password-long", SAMPLE_ORG, "admin")
                client.post("/api/auth/login", headers=HEADERS, json={"username": "admin", "password": "test-password-long"})
                result = client.post(f"{PREFIX}/accounts/{ACCOUNT}/search", headers=HEADERS,
                    json={"expected_account_revision": 1, "mode": "live", **body}).json()
                self.assertEqual((result["mode"], result["status"], result["sources"]), (mode, status, []))
        self.code = 500
        failed = self.search().json()
        self.assertEqual((failed["mode"], failed["error_code"], failed["sources"]),
                         ("fallback", "research_http_500", []))

    def test_authorization_schema_scope_and_revision_deny_without_network(self):
        self.assertEqual(self.search(expected_account_revision=2).status_code, 409)
        self.assertEqual(self.search(query="synthetic-search-token").status_code, 422)
        self.assertNotIn("synthetic-search-token", self.search(query="synthetic-search-token").text)
        for name, org, role, expected in [("viewer", SAMPLE_ORG, "viewer", 403), ("foreign", "other", "admin", 404)]:
            self.identity.create_user(name, "test-password-long", org, role)
            self.login(name)
            self.assertEqual(self.search().status_code, expected)
        self.client.post("/api/auth/logout", headers=HEADERS)
        self.assertEqual(self.search().status_code, 401)
        self.assertEqual(self.calls, [])

    def test_session_revocation_during_network_discards_sources_and_retains_safe_history(self):
        token = self.client.cookies.get("vitaai_session")
        self.on_search = lambda: self.identity.logout(token)
        self.assertEqual(self.search().status_code, 401)
        self.login()
        history = self.client.get(f"{PREFIX}/accounts/{ACCOUNT}/runs").json()
        self.assertEqual((history[0]["status"], history[0]["sources"]), ("discarded", []))

    def test_revision_change_during_network_discards_sources(self):
        def change():
            with self.app.state.store.engine.begin() as connection:
                payload = copy.deepcopy(connection.execute(select(accounts.c.payload).where(accounts.c.id == ACCOUNT)).scalar_one())
                payload["revision"] += 1
                connection.execute(update(accounts).where(accounts.c.id == ACCOUNT).values(revision=2, payload=payload))
        self.on_search = change
        self.assertEqual(self.search().status_code, 409)
        run = self.client.get(f"{PREFIX}/accounts/{ACCOUNT}/runs").json()[0]
        self.assertEqual((run["status"], run["sources"], run["account_revision"]), ("discarded", [], 1))

    def test_demotion_during_network_discards_sources(self):
        def change():
            with self.app.state.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.admin.id).values(role="viewer"))
        self.on_search = change
        self.assertEqual(self.search().status_code, 403)
        self.assertEqual(self.client.get(f"{PREFIX}/accounts/{ACCOUNT}/runs").json()[0]["sources"], [])

    def test_concurrent_other_engine_cannot_dispatch_twice(self):
        entered, release = Event(), Event()
        def wait():
            entered.set()
            self.assertTrue(release.wait(10))
        self.on_search = wait
        with TestClient(create_app(self.settings, research_transport=httpx.MockTransport(self.respond))) as other:
            other.cookies.update(self.client.cookies)
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.search)
                self.assertTrue(entered.wait(10))
                try:
                    duplicate = other.post(f"{PREFIX}/accounts/{ACCOUNT}/search", headers=HEADERS,
                        json={"expected_account_revision": 1, "mode": "live"})
                    self.assertEqual(duplicate.status_code, 409)
                finally:
                    release.set()
                self.assertEqual(future.result().status_code, 200)
        self.assertEqual(len(self.calls), 1)

    def test_worker_loss_retains_pending_and_reads_never_retry(self):
        service = ResearchService(self.app.state.store, Research(self.settings), self.client.cookies.get("vitaai_session"))
        with patch.object(Research, "search", side_effect=SystemExit), self.assertRaises(SystemExit):
            service.start(ACCOUNT, ResearchRequest(expected_account_revision=1, mode="live"))
        run = self.client.get(f"{PREFIX}/accounts/{ACCOUNT}/runs").json()[0]
        self.assertEqual(run["status"], "pending")
        self.assertEqual(self.search().status_code, 409)
        self.assertEqual(self.calls, [])

    def test_deeply_nested_provider_json_finishes_as_safe_fallback(self):
        payload = b'{"results":[],"unused":' + b'[' * 10000 + b'0' + b']' * 10000 + b'}'
        connector = Research(self.settings, httpx.MockTransport(lambda _: httpx.Response(200, content=payload)))
        service = ResearchService(self.app.state.store, connector, self.client.cookies.get("vitaai_session"))
        run = service.start(ACCOUNT, ResearchRequest(expected_account_revision=1, mode="live"))
        self.assertEqual((run.mode, run.status, run.error_code, run.sources),
                         ("fallback", "unavailable", "invalid_response", []))
        self.assertEqual(service.get(run.id), run)
        self.assertEqual(self.search().status_code, 429)
