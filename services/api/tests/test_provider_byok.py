"""Request-only synthetic credentials over real isolated comparison storage/auth."""
import json
import unittest

import httpx
import test_provider_comparison as fixtures
from pydantic import SecretStr
from sqlalchemy import select, update

from vita_api.identity import users
from vita_api.provider_comparison import ComparisonRequest, comparisons

KEY = "synthetic-private-request-key-123"


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
