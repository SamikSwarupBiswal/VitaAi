"""Isolated database/API components and explicit mocked provider transport."""
import json
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from pathlib import Path
from threading import Event
from uuid import uuid4

import httpx
from alembic import command
from alembic.config import Config
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import create_engine, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.app import create_app
from vita_api.config import ComparisonProviderConfig, Settings
from vita_api.identity import Identity, users
from vita_api.provider_catalog import (
    ENDPOINTS,
    PREFIX,
    DiscoveryRequest,
    ProviderCatalog,
)
from vita_api.provider_comparison import (
    ComparisonRequest,
    ComparisonService,
    comparisons,
)
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.storage import Store, accounts

HEADERS = {"X-VitaAi-Request": "1"}


def settings(**changes):
    providers = {name: {"enabled": True, "live_enabled": True, "api_key": "synthetic-" + name,
        "model": "nvidia/nemotron-test" if name == "nebius" else "test-model"} for name in ENDPOINTS}
    return Settings(_env_file=None, **{"auth_mode": "session", "comparison_organization_id": SAMPLE_ORG,
        "comparison_providers": providers, **changes})


class CatalogTests(unittest.TestCase):
    def test_foundry_configuration_and_discovery_use_only_bound_azure_resource(self):
        config = {"enabled": True, "live_enabled": True, "api_key": "synthetic-foundry",
                  "model": "deployment-test", "response_model": "canonical-test", "resource_name": "test-resource"}
        calls = []
        def respond(request):
            calls.append(request)
            self.assertEqual(request.method, "GET")
            self.assertEqual(request.headers["api-key"], "synthetic-foundry")
            self.assertNotIn("authorization", request.headers)
            return httpx.Response(200, json={"data": [{"id": "canonical-test"}]})
        for domain in ["services.ai.azure.com", "openai.azure.com"]:
            bound = settings(comparison_providers={"foundry": {**config, "endpoint_domain": domain}})
            catalog = ProviderCatalog(bound, httpx.MockTransport(respond))
            entry = next(item for item in catalog.entries(SAMPLE_ORG) if item.provider == "foundry")
            self.assertEqual((entry.status, entry.model, entry.expected_response_model),
                             ("configured_unverified", "deployment-test", "canonical-test"))
            before = len(calls)
            mock = catalog.discover(SAMPLE_ORG, "foundry", DiscoveryRequest())
            self.assertEqual((mock.mode, mock.models, len(calls)), ("mock", ["deployment-test"], before))
            live = catalog.discover(SAMPLE_ORG, "foundry", DiscoveryRequest(mode="live"))
            self.assertEqual((live.mode, live.models), ("live", ["canonical-test"]))
            self.assertEqual(str(calls[-1].url), f"https://test-resource.{domain}/openai/v1/models")
            self.assertNotIn("synthetic-foundry", entry.model_dump_json() + live.model_dump_json())
        for changes in [{"resource_name": "https://foreign.test"}, {"resource_name": "test.resource"},
                        {"resource_name": "test@foreign"}, {"resource_name": "test/../../foreign"},
                        {"resource_name": "-test"}, {"resource_name": "test-"},
                        {"endpoint_domain": "services.ai.azure.com.foreign.test"}, {"endpoint": "https://foreign.test"}]:
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                settings(comparison_providers={"foundry": {**config, **changes}})
        calls.clear()
        for changes in [{"resource_name": ""}, {"live_enabled": False}, {"api_key": ""}, {"enabled": False}]:
            catalog = ProviderCatalog(settings(comparison_providers={"foundry": {**config, **changes}}),
                                      httpx.MockTransport(respond))
            self.assertFalse(next(item for item in catalog.entries(SAMPLE_ORG)
                                  if item.provider == "foundry").live_configured)
            self.assertIn(catalog.discover(SAMPLE_ORG, "foundry", DiscoveryRequest(mode="live")).mode,
                          ["disabled", "fallback"])
        self.assertEqual(calls, [])

    def test_foundry_revalidates_mutated_destination_before_dispatch(self):
        calls = []
        def respond(request):
            calls.append(request)
            return httpx.Response(200, json={"data": [{"id": "canonical-test"}]})
        for field, value in [("endpoint_domain", "foreign.test"), ("resource_name", "test@foreign.test"),
                             ("resource_name", "test/../../foreign")]:
            bound = settings(comparison_providers={"foundry": {"enabled": True, "live_enabled": True,
                "api_key": "synthetic-foundry", "model": "deployment-test", "resource_name": "test-resource"}})
            setattr(bound.comparison_providers["foundry"], field, value)
            catalog = ProviderCatalog(bound, httpx.MockTransport(respond))
            result = catalog.discover(SAMPLE_ORG, "foundry", DiscoveryRequest(mode="live"))
            self.assertEqual((result.mode, result.error_code), ("fallback", "invalid_provider_configuration"))
        self.assertEqual(calls, [])

    def test_populated_0010_upgrade_preserves_original_records(self):
        with tempfile.TemporaryDirectory() as directory:
            url = f"sqlite:///{Path(directory) / 'legacy.sqlite'}"
            store = Store(url)
            config = Config()
            config.set_main_option("script_location", str(Path(__file__).resolve().parents[1] / "migrations"))
            with store.engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "0010")
            store.seed(sample_records(datetime.now(UTC)))
            identity = Identity(store.engine)
            user = identity.create_user("migration-user", "synthetic-password-123", SAMPLE_ORG, "admin")
            before = store.account_records(SAMPLE_ORG)
            store.initialize()
            self.assertEqual(store.account_records(SAMPLE_ORG), before)
            with store.engine.connect() as connection:
                self.assertEqual(connection.execute(select(users.c.id)).scalar_one(), user.id)
                self.assertEqual(connection.execute(select(comparisons)).all(), [])
            store.engine.dispose()

    def test_no_implicit_network_or_shared_keys(self):
        calls = []
        catalog = ProviderCatalog(settings(), httpx.MockTransport(lambda request: calls.append(request)))
        self.assertEqual({item.provider: item.status for item in catalog.entries(SAMPLE_ORG)},
                         {**{name: "configured_unverified" for name in ENDPOINTS}, "foundry": "disabled"})
        for provider in ENDPOINTS:
            result = catalog.discover(SAMPLE_ORG, provider, DiscoveryRequest())
            self.assertEqual((result.mode, result.source), ("mock", "configuration"))
            self.assertNotIn("api_key", result.model_dump())
        self.assertEqual(calls, [])
        self.assertTrue(all(item.status == "disabled" and item.model is None for item in catalog.entries("foreign")))
        self.assertEqual(ProviderCatalog(settings(comparison_providers={})).discover(
            SAMPLE_ORG, "openai", DiscoveryRequest(mode="live")).mode, "disabled")
        with self.assertRaises(ValidationError):
            ComparisonProviderConfig(endpoint="https://arbitrary.test")
        with self.assertRaises(ValidationError):
            settings(comparison_providers={"unknown": {}})

    def test_fixed_host_headers_and_partial_list(self):
        calls = []
        def respond(request):
            calls.append(request)
            provider = next(name for name, base in ENDPOINTS.items() if str(request.url).startswith(base))
            if provider == "anthropic":
                self.assertEqual(request.headers["x-api-key"], "synthetic-anthropic")
                self.assertEqual(request.headers["anthropic-version"], "2023-06-01")
                self.assertNotIn("authorization", request.headers)
            else:
                self.assertEqual(request.headers["authorization"], "Bearer synthetic-" + provider)
            self.assertEqual(request.method, "GET")
            return httpx.Response(200, json={"data": [{"id": "nvidia/nemotron-test"}] +
                [{"id": "test-" + str(index)} for index in range(101)], "has_more": True})
        catalog = ProviderCatalog(settings(), httpx.MockTransport(respond))
        for provider, base in ENDPOINTS.items():
            result = catalog.discover(SAMPLE_ORG, provider, DiscoveryRequest(mode="live"))
            self.assertEqual((result.mode, result.source), ("live", "provider"))
            self.assertTrue(result.has_more)
            self.assertLessEqual(len(result.models), 100)
            self.assertEqual(str(calls[-1].url), base + ("/models?limit=100" if provider == "anthropic" else "/models"))
            if provider == "nebius":
                self.assertEqual(result.models, ["nvidia/nemotron-test"])
        self.assertEqual(len(calls), 4)

    def test_errors_are_safe_and_never_retried(self):
        payloads = [b"{", b"[]", b"x" * 131073, b'{"data":[null]}', b'{"data":[]}',
                    b'{"data":[{"id":"https://invalid.test?secret=1"}]}', b"[" * 2000 + b"]" * 2000]
        for content in payloads:
            calls = []
            def respond(request, calls=calls, content=content):
                calls.append(request)
                return httpx.Response(200, content=content)
            result = ProviderCatalog(settings(), httpx.MockTransport(respond)).discover(
                SAMPLE_ORG, "openai", DiscoveryRequest(mode="live"))
            self.assertEqual((result.mode, result.models, len(calls)), ("fallback", [], 1))
        for code in [302, 401, 403, 429, 500]:
            result = ProviderCatalog(settings(), httpx.MockTransport(lambda _, code=code: httpx.Response(
                code, json={"error": "synthetic-openai"}, headers={"Location": "https://foreign.test"}))).discover(
                SAMPLE_ORG, "openai", DiscoveryRequest(mode="live"))
            self.assertEqual(result.error_code, f"provider_http_{code}")
            self.assertNotIn("synthetic-openai", result.model_dump_json())
        def timeout(_):
            raise httpx.ReadTimeout("synthetic-openai")
        self.assertEqual(ProviderCatalog(settings(), httpx.MockTransport(timeout)).discover(
            SAMPLE_ORG, "openai", DiscoveryRequest(mode="live")).error_code, "provider_timeout")


class CatalogApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pg_admin = None
        database_url = f"sqlite:///{Path(self.temp.name) / 'comparison.sqlite'}"
        if os.environ.get("VITAAI_POSTGRES_TEST_URL"):
            self.pg_admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"])
            self.schema = "vitaai_comparison_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(self.schema))
            database_url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + self.schema}).render_as_string(hide_password=False)
        self.settings = settings(database_url=database_url)
        self.calls, self.callback = [], None
        self.inference = None
        def respond(request):
            self.calls.append(request)
            if self.callback:
                self.callback()
            if self.inference:
                return self.inference(request)
            return httpx.Response(200, json={"data": [{"id": "test-model"}]})
        self.app = create_app(self.settings, comparison_transport=httpx.MockTransport(respond))
        self.client = TestClient(self.app).__enter__()
        self.identity = Identity(self.app.state.store.engine)
        self.admin = self.identity.create_user("catalog-admin", "synthetic-password-123", SAMPLE_ORG, "admin")
        self.login()

    def login(self):
        self.assertEqual(self.client.post("/api/auth/login", headers=HEADERS,
            json={"username": "catalog-admin", "password": "synthetic-password-123"}).status_code, 200)

    def tearDown(self):
        self.client.__exit__(None, None, None)
        if self.pg_admin is not None:
            with self.pg_admin.begin() as connection:
                connection.execute(DropSchema(self.schema, cascade=True))
            self.pg_admin.dispose()
        self.temp.cleanup()

    def test_scope_modes_schema_and_authority_recheck(self):
        self.assertEqual(self.client.get(PREFIX + "/catalog").status_code, 200)
        path = PREFIX + "/providers/openai/discover"
        result = self.client.post(path, headers=HEADERS, json={})
        self.assertEqual((result.status_code, result.json()["mode"]), (200, "mock"))
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.head(path).status_code, 405)
        for body in [{"api_key": "never-echo-this"}, {"mode": "live", "endpoint": "https://foreign.test"}]:
            result = self.client.post(path, headers=HEADERS, json=body)
            self.assertEqual(result.status_code, 422)
            self.assertNotIn("never-echo-this", result.text)
        result = self.client.post(path, headers=HEADERS, json={"mode": "live"})
        self.assertEqual((result.status_code, result.json()["source"], len(self.calls)), (200, "provider", 1))
        self.callback = lambda: self.identity.logout(self.client.cookies.get("vitaai_session"))
        self.assertEqual(self.client.post(path, headers=HEADERS, json={"mode": "live"}).status_code, 401)
        self.assertEqual(self.client.get(PREFIX + "/catalog").status_code, 401)
        self.callback = None
        self.login()
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.admin.id).values(role="seller"))
        self.assertEqual(self.client.post(path, headers=HEADERS, json={}).status_code, 403)

    def test_foundry_discovery_rechecks_configuration_after_network(self):
        self.settings.comparison_providers["foundry"] = ComparisonProviderConfig(enabled=True,
            live_enabled=True, api_key="synthetic-foundry", model="deployment-test", resource_name="test-resource")
        path = PREFIX + "/providers/foundry/discover"
        self.assertEqual(self.client.post(path, headers=HEADERS, json={}).status_code, 200)
        self.assertEqual(self.calls, [])
        self.callback = lambda: setattr(self.settings.comparison_providers["foundry"], "resource_name", "new-resource")
        response = self.client.post(path, headers=HEADERS, json={"mode": "live"})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn("test-model", response.text)


class ComparisonApiTests(unittest.TestCase):
    login = CatalogApiTests.login
    tearDown = CatalogApiTests.tearDown

    def setUp(self):
        CatalogApiTests.setUp(self)
        self.inference = self.valid_response
        self.views = self.client.get("/api/portfolio").json()["accounts"]
        self.view = self.views[0]
        self.account_id = self.view["account"]["id"]
        self.path = PREFIX + "/accounts/" + self.account_id
        self.contexts = []

    def body(self, providers=None, **changes):
        return {"expected_revision": self.view["account"]["revision"],
            "expected_snapshot_hash": self.view["assessment"]["snapshot_hash"],
            "providers": providers or [{"provider": name, "mode": "live", "expected_configuration_revision": 1}
                for name in ENDPOINTS], **changes}

    def valid_response(self, request):
        body = json.loads(request.content)
        self.assertEqual(request.method, "POST")
        context = body["messages"][-1]["content"]
        self.contexts.append(context)
        evidence = json.loads(context)["evidence"][0]["id"]
        output = json.dumps({"findings": [{"text": "Advisory finding", "evidence_ids": [evidence]}],
            "next_steps": [{"text": "Review the supplied facts", "evidence_ids": [evidence]}], "caveats": ["Unverified"]})
        if request.url.host == "api.anthropic.com":
            self.assertEqual(request.url.path, "/v1/messages")
            self.assertEqual(body["max_tokens"], 1600)
            return httpx.Response(200, json={"id": "msg-test", "model": body["model"], "stop_reason": "end_turn",
                "content": [{"type": "text", "text": output}], "usage": {"input_tokens": 20, "output_tokens": 12}})
        self.assertEqual(request.url.path, "/v1/chat/completions")
        self.assertEqual(body["response_format"], {"type": "json_object"})
        self.assertEqual(body["max_completion_tokens" if request.url.host == "api.openai.com" else "max_tokens"], 1600)
        return httpx.Response(200, json={"id": "chat-test", "model": body["model"],
            "choices": [{"finish_reason": "stop", "message": {"content": output}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 12}})

    def compare(self, **changes):
        return self.client.post(self.path + "/compare", headers=HEADERS, json=self.body(**changes))

    def test_readiness_is_scoped_network_free_and_retains_old_pending(self):
        before = self.client.get("/api/portfolio").json()
        ready = self.client.get(self.path + "/readiness")
        self.assertEqual(ready.status_code, 200)
        value = ready.json()
        self.assertEqual((value["account_revision"], value["snapshot_hash"]),
            (self.view["account"]["revision"], self.view["assessment"]["snapshot_hash"]))
        self.assertTrue(value["can_start"])
        self.assertIsNone(value["pending_run_id"])
        run = self.compare(providers=[{"provider": "openai", "expected_configuration_revision": 1}]).json()
        self.assertFalse(self.client.get(self.path + "/readiness").json()["can_start"])
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(comparisons).values(status="pending", started_at=1))
            for index in range(21):
                connection.execute(comparisons.insert().values(id=str(uuid4()), organization_id=SAMPLE_ORG,
                    account_id=self.account_id, started_at=index + 2, status="completed", payload=run))
        value = self.client.get(self.path + "/readiness").json()
        self.assertEqual(value["pending_run_id"], run["id"])
        self.assertFalse(value["can_start"])
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.client.get(PREFIX + f"/accounts/{uuid4()}/readiness").status_code, 404)
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(comparisons).values(status="completed"))
        self.assertTrue(self.client.get(self.path + "/readiness").json()["can_start"])
        self.settings.comparison_organization_id = "unconfigured-organization"
        value = self.client.get(self.path + "/readiness").json()
        self.assertFalse(value["configured"])
        self.assertFalse(value["can_start"])
        self.settings.comparison_organization_id = SAMPLE_ORG
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.admin.id).values(role="viewer"))
        self.assertFalse(self.client.get(self.path + "/readiness").json()["can_start"])
        self.identity.logout(self.client.cookies.get("vitaai_session"))
        self.assertEqual(self.client.get(self.path + "/readiness").status_code, 401)

    def test_identical_snapshots_independent_provenance_and_unchanged_authority(self):
        before = self.client.get("/api/portfolio").json()
        response = self.compare()
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()
        self.assertEqual(run["status"], "completed")
        self.assertEqual(len(self.contexts), 4)
        self.assertEqual(len(set(self.contexts)), 1)
        self.assertEqual(len({result["id"] for result in run["results"]}), 4)
        self.assertTrue(all(result["mode"] == "live" and result["status"] == "succeeded" and
            result["validation"] == "schema_and_references_valid" and result["input_tokens"] == 20 and
            result["output_tokens"] == 12 and result["factual_confidence"] == "unverified" for result in run["results"]))
        self.assertEqual(run["snapshot"]["assessment"], self.view["assessment"])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.client.get("/api/missions").json(), [])
        self.assertNotIn("synthetic-openai", response.text)
        self.assertEqual(self.client.get(PREFIX + "/runs/" + run["id"]).json(), run)
        self.assertEqual(self.client.get(self.path + "/runs").json(), [run])
        self.assertEqual(len(self.calls), 4)
        self.assertEqual(self.compare().status_code, 429)
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.update(self.client.cookies)
            self.assertEqual(restarted.get(PREFIX + "/runs/" + run["id"]).json(), run)

    def test_modes_and_partial_failure_remain_independent(self):
        self.settings.comparison_providers["nebius"].enabled = False
        self.settings.comparison_providers["nvidia"].api_key = ComparisonProviderConfig().api_key
        choices = self.body()["providers"]
        choices[1]["mode"] = "mock"
        self.inference = lambda _: httpx.Response(429, json={"error": "synthetic-anthropic"})
        result = self.compare(providers=choices)
        self.assertEqual(result.status_code, 200)
        rows = {item["provider"]: item for item in result.json()["results"]}
        self.assertEqual([rows[name]["mode"] for name in ENDPOINTS], ["disabled", "mock", "fallback", "fallback"])
        self.assertEqual(rows["anthropic"]["error_code"], "provider_http_429")
        self.assertTrue(all(item["analysis"] is None for item in rows.values()))
        self.assertEqual(len(self.calls), 1)

    def test_invalid_output_does_not_hide_another_success(self):
        def response(request):
            if request.url.host == "api.openai.com":
                return httpx.Response(200, json={"model": "test-model", "id": "rejected-test",
                    "usage": {"prompt_tokens": 3, "completion_tokens": 4}, "choices": [{"finish_reason": "stop",
                    "message": {"content": json.dumps({"findings": [{"text": "Crossed", "evidence_ids": [str(uuid4())]}],
                    "next_steps": [{"text": "Review", "evidence_ids": [str(uuid4())]}], "caveats": []})}}]})
            return self.valid_response(request)
        self.inference = response
        result = self.compare(providers=[{"provider": name, "mode": "live", "expected_configuration_revision": 1}
            for name in ["openai", "anthropic"]]).json()
        self.assertEqual(result["results"][0]["status"], "invalid_output")
        self.assertEqual(result["results"][0]["validation"], "rejected")
        self.assertEqual(result["results"][0]["request_id"], "rejected-test")
        self.assertEqual(result["results"][1]["status"], "succeeded")
        self.assertEqual(len(self.calls), 2)

    def test_truncated_output_retains_safe_usage_and_request_provenance(self):
        def response(request):
            if request.url.host == "api.anthropic.com":
                return httpx.Response(200, json={"id": "msg-truncated", "model": "test-model", "stop_reason": "max_tokens",
                    "content": [], "usage": {"input_tokens": 20, "output_tokens": 1600}})
            return httpx.Response(200, json={"id": "chat-truncated", "model": "test-model",
                "choices": [{"finish_reason": "length", "message": {"content": "{"}}],
                "usage": {"prompt_tokens": 20, "completion_tokens": 1600}})
        self.inference = response
        result = self.compare(providers=[{"provider": name, "mode": "live", "expected_configuration_revision": 1}
            for name in ["openai", "anthropic"]]).json()
        for row, request_id in zip(result["results"], ["chat-truncated", "msg-truncated"], strict=True):
            self.assertEqual((row["status"], row["error_code"], row["analysis"]), ("failed", "incomplete_generation", None))
            self.assertEqual((row["request_id"], row["input_tokens"], row["output_tokens"]), (request_id, 20, 1600))

    def test_explicit_alias_response_binding_retains_requested_and_returned_model(self):
        self.settings.comparison_providers["openai"] = ComparisonProviderConfig(
            enabled=True, live_enabled=True, api_key="synthetic-openai", model="test-alias", response_model="test-model")
        def response(request):
            body = self.valid_response(request).json()
            body["model"] = "test-model"
            return httpx.Response(200, json=body)
        self.inference = response
        response = self.compare(providers=[{"provider": "openai", "mode": "live", "expected_configuration_revision": 1}])
        self.assertEqual(response.status_code, 200)
        row = response.json()["results"][0]
        self.assertEqual(row["status"], "succeeded")
        self.assertEqual((row["model"], row["response_model"], row["expected_response_model"]),
                         ("test-alias", "test-model", "test-model"))

    def test_schema_scope_and_stale_bindings_deny_without_call(self):
        for changes in [{"expected_revision": 999}, {"expected_snapshot_hash": "0" * 64},
                        {"providers": [{"provider": "openai", "expected_configuration_revision": 999}]}]:
            self.assertEqual(self.compare(**changes).status_code, 409)
        choices = [{"provider": "openai", "expected_configuration_revision": 1}] * 2
        self.assertEqual(self.compare(providers=choices).status_code, 422)
        response = self.client.post(self.path + "/compare", headers=HEADERS, json={**self.body(), "api_key": "never-echo"})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn("never-echo", response.text)
        self.assertEqual(self.client.head(self.path + "/compare").status_code, 405)
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.admin.id).values(role="viewer"))
        self.assertEqual(self.compare().status_code, 403)
        self.assertEqual(self.calls, [])

    def test_session_loss_discards_unpublished_output_and_stops_later_calls(self):
        self.callback = lambda: self.identity.logout(self.client.cookies.get("vitaai_session"))
        result = self.compare()
        self.assertEqual(result.status_code, 401)
        self.callback = None
        self.login()
        saved = self.client.get(self.path + "/runs").json()[0]
        self.assertEqual(saved["status"], "discarded")
        self.assertTrue(all(item["status"] == "discarded" and item["analysis"] is None for item in saved["results"]))
        self.assertEqual(len(self.calls), 1)

    def test_source_revision_change_discards_without_refreshing_original_snapshot(self):
        def change():
            with self.app.state.store.engine.begin() as connection:
                payload = connection.execute(select(accounts.c.payload).where(accounts.c.id == self.account_id)).scalar_one()
                payload["revision"] += 1
                connection.execute(update(accounts).where(accounts.c.id == self.account_id).values(payload=payload))
        self.callback = change
        self.assertEqual(self.compare().status_code, 409)
        saved = self.client.get(self.path + "/runs").json()[0]
        self.assertEqual(saved["status"], "discarded")
        self.assertEqual(saved["account_revision"], self.view["account"]["revision"])
        self.assertEqual(saved["snapshot"]["assessment"], self.view["assessment"])
        self.assertEqual(len(self.calls), 1)

    def test_two_engines_block_duplicate_comparison_during_network(self):
        entered, release = Event(), Event()
        def wait():
            entered.set()
            self.assertTrue(release.wait(20))
        self.callback = wait
        with TestClient(create_app(self.settings)) as other, ThreadPoolExecutor(max_workers=1) as pool:
            other.cookies.update(self.client.cookies)
            pending = pool.submit(self.compare)
            try:
                self.assertTrue(entered.wait(20))
                response = other.post(self.path + "/compare", headers=HEADERS, json=self.body())
                self.assertEqual(response.status_code, 409)
                saved = other.get(self.path + "/runs").json()[0]
                self.assertEqual(saved["status"], "pending")
                self.assertTrue(all(item["analysis"] is None for item in saved["results"]))
            finally:
                release.set()
            self.assertEqual(pending.result(30).status_code, 200)
        self.assertEqual(len(self.calls), 4)

    def test_worker_loss_retains_completed_result_and_pending_blocks_without_retry(self):
        def response(request):
            if len(self.calls) == 2:
                raise SystemExit("controlled-worker-loss")
            return self.valid_response(request)
        self.inference = response
        catalog = ProviderCatalog(self.settings, httpx.MockTransport(lambda request: self.transport_call(request)))
        operation = ComparisonService(self.app.state.store, catalog, self.client.cookies.get("vitaai_session"))
        with self.assertRaises(SystemExit):
            operation.start(self.admin.id, self.account_id, ComparisonRequest(**self.body()))
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.update(self.client.cookies)
            saved = restarted.get(self.path + "/runs").json()[0]
            self.assertEqual(saved["status"], "pending")
            self.assertEqual(saved["results"][0]["status"], "succeeded")
            self.assertEqual(saved["results"][1]["status"], "pending")
            self.assertEqual(restarted.post(self.path + "/compare", headers=HEADERS, json=self.body()).status_code, 409)
        self.assertEqual(len(self.calls), 2)

    def transport_call(self, request):
        self.calls.append(request)
        return self.inference(request)

    def test_bounded_history_preserves_terminal_records_and_never_calls_provider(self):
        choice = [{"provider": "openai", "expected_configuration_revision": 1}]
        for index in range(22):
            result = self.compare(providers=choice)
            self.assertEqual(result.status_code, 200)
            with self.app.state.store.engine.begin() as connection:
                connection.execute(update(comparisons).values(started_at=int(datetime.now(UTC).timestamp()) - 120 - index))
        latest = self.client.get(self.path + "/runs").json()
        self.assertEqual(len(latest), 20)
        self.assertEqual(len({item["id"] for item in latest}), 20)
        original = self.client.get(PREFIX + "/runs/" + result.json()["id"]).json()
        self.assertEqual(original, result.json())
        self.assertEqual(self.calls, [])


class FoundryComparisonTests(unittest.TestCase):
    login = CatalogApiTests.login
    tearDown = CatalogApiTests.tearDown
    body = ComparisonApiTests.body
    compare = ComparisonApiTests.compare
    valid_response = ComparisonApiTests.valid_response

    def setUp(self):
        ComparisonApiTests.setUp(self)
        self.settings.comparison_providers["foundry"] = ComparisonProviderConfig(enabled=True,
            live_enabled=True, api_key="synthetic-foundry", model="deployment-test",
            response_model="canonical-test", resource_name="test-resource")
        self.inference = self.response

    def response(self, request):
        if request.url.host == "api.openai.com":
            return ComparisonApiTests.valid_response(self, request)
        self.assertEqual(str(request.url), "https://test-resource.services.ai.azure.com/openai/v1/chat/completions")
        self.assertEqual(request.method, "POST")
        self.assertEqual(request.headers["api-key"], "synthetic-foundry")
        self.assertNotIn("authorization", request.headers)
        body = json.loads(request.content)
        self.assertEqual(body["model"], "deployment-test")
        self.assertEqual(body["max_completion_tokens"], 1600)
        self.assertNotIn("max_tokens", body)
        self.assertEqual(body["response_format"], {"type": "json_object"})
        context = body["messages"][-1]["content"]
        self.contexts.append(context)
        evidence = json.loads(context)["evidence"][0]["id"]
        output = json.dumps({"findings": [{"text": "Advisory finding", "evidence_ids": [evidence]}],
            "next_steps": [{"text": "Review only", "evidence_ids": [evidence]}], "caveats": ["Unverified"]})
        return httpx.Response(200, json={"id": "foundry-request", "model": "canonical-test",
            "choices": [{"finish_reason": "stop", "message": {"content": output}}],
            "usage": {"prompt_tokens": 20, "completion_tokens": 12}})

    @staticmethod
    def choices(*names, mode="live"):
        return [{"provider": name, "mode": mode, "expected_configuration_revision": 1} for name in names]

    def expire_cooldown(self):
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(comparisons).values(started_at=1))

    def test_same_snapshot_bound_deployment_and_retained_provenance(self):
        before = self.client.get("/api/portfolio").json()
        response = self.compare(providers=self.choices("foundry", "openai"))
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()
        row = run["results"][0]
        self.assertEqual((row["mode"], row["status"], row["model"], row["expected_response_model"], row["response_model"]),
                         ("live", "succeeded", "deployment-test", "canonical-test", "canonical-test"))
        self.assertEqual((row["input_tokens"], row["output_tokens"], row["request_id"]), (20, 12, "foundry-request"))
        self.assertEqual(row["factual_confidence"], "unverified")
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(self.contexts), 2)
        self.assertEqual(self.contexts[0], self.contexts[1])
        self.assertEqual(run["snapshot"]["assessment"], self.view["assessment"])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.client.get("/api/missions").json(), [])
        self.assertNotIn("synthetic-foundry", response.text)
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.update(self.client.cookies)
            self.assertEqual(restarted.get(PREFIX + "/runs/" + run["id"]).json(), run)

    def test_failures_remain_independent_safe_and_never_retry(self):
        for fault in ["model", "length", "evidence", "refusal", "status", "oversized", "timeout"]:
            with self.subTest(fault=fault):
                def fail(request, fault=fault):
                    if request.url.host == "api.openai.com":
                        return self.response(request)
                    if fault == "timeout":
                        raise httpx.ReadTimeout("synthetic-foundry")
                    if fault == "status":
                        return httpx.Response(400, json={"error": "synthetic-foundry"})
                    if fault == "oversized":
                        return httpx.Response(200, content=b"x" * 131073)
                    payload = self.response(request).json()
                    if fault == "model":
                        payload["model"] = "unrelated-model"
                    elif fault == "length":
                        payload["choices"][0]["finish_reason"] = "length"
                    elif fault == "evidence":
                        output = json.loads(payload["choices"][0]["message"]["content"])
                        output["findings"][0]["evidence_ids"] = [str(uuid4())]
                        payload["choices"][0]["message"]["content"] = json.dumps(output)
                    elif fault == "refusal":
                        payload["choices"][0]["message"] = {"content": None, "refusal": "Untrusted refusal"}
                    return httpx.Response(200, json=payload)
                self.inference = fail
                before = len(self.calls)
                response = self.compare(providers=self.choices("foundry", "openai"))
                self.assertEqual(response.status_code, 200, response.text)
                rows = response.json()["results"]
                self.assertEqual((rows[0]["mode"], rows[0]["analysis"], rows[1]["status"]),
                                 ("fallback", None, "succeeded"))
                self.assertIn(rows[0]["status"], ["failed", "invalid_output"])
                if fault in ["model", "length", "evidence", "refusal"]:
                    self.assertEqual((rows[0]["request_id"], rows[0]["input_tokens"]), ("foundry-request", 20))
                self.assertEqual(len(self.calls) - before, 2)
                self.assertNotIn("synthetic-foundry", response.text)
                self.expire_cooldown()

    def test_mock_disabled_and_incomplete_config_never_call(self):
        config = self.settings.comparison_providers["foundry"]
        for mode, field, value, expected in [("mock", "enabled", True, "mock"),
                ("live", "enabled", False, "disabled"), ("live", "resource_name", "", "fallback"),
                ("live", "live_enabled", False, "fallback")]:
            original = getattr(config, field)
            setattr(config, field, value)
            response = self.compare(providers=self.choices("foundry", mode=mode))
            self.assertEqual(response.status_code, 200)
            row = response.json()["results"][0]
            self.assertEqual((row["mode"], row["analysis"]), (expected, None))
            setattr(config, field, original)
            self.expire_cooldown()
        self.assertEqual(self.calls, [])

    def test_resource_rebinding_discards_unpublished_output_and_stops_next_call(self):
        self.callback = lambda: setattr(self.settings.comparison_providers["foundry"], "resource_name", "new-resource")
        self.assertEqual(self.compare(providers=self.choices("foundry", "openai")).status_code, 409)
        saved = self.client.get(self.path + "/runs").json()[0]
        self.assertEqual(saved["status"], "discarded")
        self.assertTrue(all(row["analysis"] is None and row["status"] == "discarded" for row in saved["results"]))
        self.assertEqual(len(self.calls), 1)

    def test_session_loss_discards_unpublished_foundry_output(self):
        self.callback = lambda: self.identity.logout(self.client.cookies.get("vitaai_session"))
        self.assertEqual(self.compare(providers=self.choices("foundry", "openai")).status_code, 401)
        self.callback = None
        self.login()
        saved = self.client.get(self.path + "/runs").json()[0]
        self.assertEqual(saved["status"], "discarded")
        self.assertTrue(all(row["analysis"] is None for row in saved["results"]))
        self.assertEqual(len(self.calls), 1)
