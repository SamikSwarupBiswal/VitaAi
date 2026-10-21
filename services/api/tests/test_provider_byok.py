"""Request-only synthetic credentials over real isolated comparison storage/auth."""
import json
import unittest

import httpx
import test_provider_comparison as fixtures
from pydantic import SecretStr
from sqlalchemy import select, update

from vita_api.identity import users
from vita_api.provider_catalog import DiscoveryRequest
from vita_api.provider_comparison import ComparisonRequest, comparisons

KEY = "synthetic-private-request-key-123"


class DiscoveryByokTests(unittest.TestCase):
    setUp = fixtures.CatalogApiTests.setUp
    tearDown = fixtures.CatalogApiTests.tearDown
    login = fixtures.CatalogApiTests.login

    def discover(self, provider="openai", **changes):
        return self.client.post(fixtures.PREFIX + f"/providers/{provider}/discover", headers=fixtures.HEADERS,
            json={"mode": "live", "expected_configuration_revision": 1, "api_key": KEY, **changes})

    def test_fixed_hosts_request_key_and_no_persistence(self):
        self.settings.comparison_byok_enabled = True
        self.settings.comparison_providers["foundry"] = fixtures.ComparisonProviderConfig(enabled=True,
            live_enabled=True, api_key="synthetic-foundry", model="deployment", resource_name="test-resource")
        before = self.client.get("/api/portfolio").json()
        self.inference = lambda _: httpx.Response(200, json={"data": [{"id": "nvidia/nemotron-test"}]})
        for provider in [*fixtures.ENDPOINTS, "foundry"]:
            result = self.discover(provider)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual((result.json()["mode"], result.json()["credential_source"]), ("live", "request"))
            request = self.calls[-1]
            endpoint = fixtures.ENDPOINTS.get(provider, "https://test-resource.services.ai.azure.com/openai/v1")
            self.assertEqual(str(request.url), endpoint + ("/models?limit=100" if provider == "anthropic" else "/models"))
            header = "x-api-key" if provider == "anthropic" else "api-key" if provider == "foundry" else "authorization"
            self.assertEqual(request.headers[header], KEY if header != "authorization" else "Bearer " + KEY)
            self.assertEqual((request.method, request.content), ("GET", b""))
            self.assertNotIn(KEY, result.text)
        self.assertEqual(len(self.calls), 5)
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.settings.comparison_providers["openai"].api_key.get_secret_value(), "synthetic-openai")
        with self.app.state.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(comparisons)).all(), [])
        body = DiscoveryRequest(mode="live", expected_configuration_revision=1, api_key=KEY)
        self.assertNotIn(KEY, repr(body) + body.model_dump_json())

    def test_gates_revision_schema_and_non_admin_deny_without_network(self):
        self.assertEqual(self.discover().status_code, 403)
        self.settings.comparison_byok_enabled = True
        for changes in [{"mode": "mock"}, {"expected_configuration_revision": None}, {"api_key": "short"},
                        {"api_key": KEY + "\r\n"}, {"api_key": "x" * 513}, {"api_key": KEY + "Ω"},
                        {"endpoint": "https://foreign.test"}, {"model": "client-model"}]:
            response = self.discover(**changes)
            self.assertEqual(response.status_code, 422)
            self.assertNotIn(KEY, response.text)
        self.assertEqual(self.discover(expected_configuration_revision=2).status_code, 409)
        for field, value in [("enabled", False), ("live_enabled", False), ("model", "")]:
            config = self.settings.comparison_providers["openai"]
            original = getattr(config, field)
            setattr(config, field, value)
            self.assertEqual(self.discover().status_code, 409)
            setattr(config, field, original)
        for role in ["viewer", "seller", "reviewer"]:
            with self.app.state.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.admin.id).values(role=role))
            self.assertEqual(self.discover().status_code, 403)
        self.assertEqual(self.calls, [])

    def test_missing_server_key_and_no_server_retry_on_failure(self):
        self.settings.comparison_byok_enabled = True
        self.settings.comparison_providers["openai"].api_key = SecretStr("")
        self.assertEqual(self.discover().json()["mode"], "live")
        self.settings.comparison_providers["openai"].api_key = SecretStr("synthetic-server-key")
        self.inference = lambda _: httpx.Response(401, json={"error": KEY})
        result = self.discover()
        self.assertEqual((result.json()["mode"], result.json()["error_code"]), ("fallback", "provider_http_401"))
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(all(request.headers["authorization"] == "Bearer " + KEY for request in self.calls))
        self.assertNotIn(KEY, result.text)

    def test_literal_echo_in_model_or_metadata_rejects_entire_response(self):
        self.settings.comparison_byok_enabled = True
        for payload in [{"data": [{"id": KEY}]}, {"data": [{"id": "model"}], "extra": KEY}]:
            self.inference = lambda _, payload=payload: httpx.Response(200, json=payload)
            result = self.discover()
            self.assertEqual((result.json()["models"], result.json()["error_code"]), ([], "credential_echo_rejected"))
            self.assertNotIn(KEY, result.text)

    def test_midflight_gate_configuration_or_session_loss_denies_publication(self):
        for change in ["gate", "configuration", "session"]:
            self.settings.comparison_byok_enabled = True
            config = self.settings.comparison_providers["openai"]
            config.revision = 1
            if change == "gate":
                self.callback = lambda: setattr(self.settings, "comparison_byok_enabled", False)
            elif change == "configuration":
                self.callback = lambda config=config: setattr(config, "revision", 2)
            else:
                self.callback = lambda: self.identity.logout(self.client.cookies.get("vitaai_session"))
            result = self.discover()
            self.assertEqual(result.status_code, 409 if change == "configuration" else 401 if change == "session" else 403)
            self.assertNotIn("test-model", result.text)
            self.assertNotIn(KEY, result.text)
        self.assertEqual(len(self.calls), 3)


class ByokTests(unittest.TestCase):
    setUp = fixtures.ComparisonApiTests.setUp
    tearDown = fixtures.ComparisonApiTests.tearDown
    login = fixtures.ComparisonApiTests.login
    valid_response = fixtures.ComparisonApiTests.valid_response
    body = fixtures.ComparisonApiTests.body
    compare = fixtures.ComparisonApiTests.compare

    def choice(self, provider="openai", **changes):
        return {"provider": provider, "mode": "live", "expected_configuration_revision": 1, "api_key": KEY, **changes}

    def stored(self):
        with self.app.state.store.engine.connect() as connection:
            return list(connection.execute(select(comparisons.c.payload)).scalars())

    def test_request_key_replaces_only_selected_credential_without_persistence(self):
        self.settings.comparison_byok_enabled = True
        before = self.client.get("/api/portfolio").json()
        response = self.compare(providers=[self.choice(), {"provider": "anthropic", "mode": "live", "expected_configuration_revision": 1}])
        self.assertEqual(response.status_code, 200, response.text)
        results = response.json()["results"]
        self.assertEqual([r["credential_source"] for r in results], ["request", "server"])
        self.assertEqual([r["status"] for r in results], ["succeeded", "succeeded"])
        self.assertEqual(self.calls[0].headers["authorization"], "Bearer " + KEY)
        self.assertEqual(self.calls[1].headers["x-api-key"], "synthetic-anthropic")
        self.assertEqual(len(self.calls), 2)
        self.assertNotIn(KEY, response.text + json.dumps(self.stored()))
        self.assertNotIn(KEY, "".join(self.contexts))
        self.assertEqual(self.settings.comparison_providers["openai"].api_key.get_secret_value(), "synthetic-openai")
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        body = ComparisonRequest.model_validate(self.body(providers=[self.choice()]))
        self.assertNotIn(KEY, repr(body) + body.model_dump_json())

    def test_missing_server_key_can_use_request_key_with_separate_gate(self):
        self.settings.comparison_byok_enabled = True
        self.settings.comparison_providers["openai"].api_key = SecretStr("")
        catalog = self.client.get(fixtures.PREFIX + "/catalog").json()
        entry = next(item for item in catalog if item["provider"] == "openai")
        self.assertFalse(entry["live_configured"])
        self.assertTrue(entry["byok_allowed"])
        response = self.compare(providers=[self.choice()])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["results"][0]["status"], "succeeded")

    def test_default_off_invalid_or_mock_key_never_dispatches_or_echoes(self):
        response = self.compare(providers=[self.choice()])
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.stored(), [])
        self.settings.comparison_byok_enabled = True
        for changes in [{"mode": "mock"}, {"api_key": "short"}, {"api_key": "x" * 513},
                        {"api_key": KEY + "\r\n"}, {"api_key": KEY + "Ω"}, {"endpoint": "https://foreign.test"}]:
            with self.subTest(fields=list(changes)):
                response = self.compare(providers=[self.choice(**changes)])
                self.assertEqual(response.status_code, 422)
                self.assertNotIn(KEY, response.text)
        for change in ["enabled", "live_enabled"]:
            config = self.settings.comparison_providers["openai"]
            setattr(config, change, False)
            self.assertEqual(self.compare(providers=[self.choice()]).status_code, 409)
            setattr(config, change, True)
        self.assertEqual(self.calls, [])

    def test_midflight_byok_disable_discards_private_output(self):
        self.settings.comparison_byok_enabled = True
        self.callback = lambda: setattr(self.settings, "comparison_byok_enabled", False)
        response = self.compare(providers=[self.choice()])
        self.assertEqual(response.status_code, 409)
        saved = self.stored()[0]
        self.assertEqual(saved["status"], "discarded")
        self.assertIsNone(saved["results"][0]["analysis"])
        self.assertNotIn(KEY, json.dumps(saved) + response.text)
        self.assertEqual(len(self.calls), 1)

    def test_provider_echo_is_rejected_before_history_or_response(self):
        self.settings.comparison_byok_enabled = True
        def echo(request):
            valid = self.valid_response(request).json()
            content = json.loads(valid["choices"][0]["message"]["content"])
            content["caveats"] = [KEY]
            valid["choices"][0]["message"]["content"] = json.dumps(content)
            valid["id"] = KEY
            return httpx.Response(200, json=valid)
        self.inference = echo
        response = self.compare(providers=[self.choice()])
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()["results"][0]
        self.assertEqual(result["error_code"], "credential_in_provider_output")
        self.assertIsNone(result["analysis"])
        self.assertIsNone(result["request_id"])
        self.assertNotIn(KEY, response.text + json.dumps(self.stored()))

    def test_unauthorized_key_and_failed_provider_cannot_fall_back_to_server_key(self):
        self.settings.comparison_byok_enabled = True
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.admin.id).values(role="viewer"))
        denied = self.compare(providers=[self.choice()])
        self.assertEqual(denied.status_code, 403)
        self.assertNotIn(KEY, denied.text)
        self.assertEqual(self.calls, [])
        with self.app.state.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.admin.id).values(role="admin"))
        self.inference = lambda _: httpx.Response(401, json={"error": KEY})
        result = self.compare(providers=[self.choice()])
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["results"][0]["error_code"], "provider_http_401")
        self.assertEqual(len(self.calls), 1)
        self.assertNotIn(KEY, result.text + json.dumps(self.stored()))
