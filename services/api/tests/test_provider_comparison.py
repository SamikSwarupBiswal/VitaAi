"""Isolated database/API components and explicit mocked provider transport."""
import tempfile
import unittest
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import update

from vita_api.app import create_app
from vita_api.config import ComparisonProviderConfig, Settings
from vita_api.identity import Identity, users
from vita_api.provider_catalog import (
    ENDPOINTS,
    PREFIX,
    DiscoveryRequest,
    ProviderCatalog,
)
from vita_api.sample import SAMPLE_ORG

HEADERS = {"X-VitaAi-Request": "1"}


def settings(**changes):
    providers = {name: {"enabled": True, "live_enabled": True, "api_key": "synthetic-" + name,
        "model": "nvidia/nemotron-test" if name == "nebius" else "test-model"} for name in ENDPOINTS}
    return Settings(_env_file=None, **{"auth_mode": "session", "comparison_organization_id": SAMPLE_ORG,
        "comparison_providers": providers, **changes})


class CatalogTests(unittest.TestCase):
    def test_no_implicit_network_or_shared_keys(self):
        calls = []
        catalog = ProviderCatalog(settings(), httpx.MockTransport(lambda request: calls.append(request)))
        self.assertTrue(all(item.status == "configured_unverified" for item in catalog.entries(SAMPLE_ORG)))
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
        self.settings = settings(database_url=f"sqlite:///{Path(self.temp.name) / 'comparison.sqlite'}")
        self.calls, self.callback = [], None
        def respond(request):
            self.calls.append(request)
            if self.callback:
                self.callback()
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
