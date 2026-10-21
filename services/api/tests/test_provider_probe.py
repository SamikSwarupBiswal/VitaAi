"""Synthetic probe protocol over isolated authenticated storage and explicit mock transport."""
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from threading import Event
from unittest.mock import patch

import httpx
import test_provider_comparison as fixtures
from sqlalchemy import select, update

from vita_api.governance import PolicyDenied
from vita_api.identity import users
from vita_api.provider_catalog import ProviderCatalog
from vita_api.provider_probe import (
    WORKER_BUDGET,
    ProbeRequest,
    ProbeService,
    probe_once,
    probes,
)
from vita_api.storage import Store

KEY = "synthetic-private-probe-key-123"


class ProbeTests(unittest.TestCase):
    setUp = fixtures.CatalogApiTests.setUp
    tearDown = fixtures.CatalogApiTests.tearDown
    login = fixtures.CatalogApiTests.login

    def post(self, provider="openai", **changes):
        return self.client.post(fixtures.PREFIX + f"/providers/{provider}/test", headers=fixtures.HEADERS,
            json={"expected_configuration_revision": 1, **changes})

    def saved(self):
        with self.app.state.store.engine.connect() as connection:
            return list(connection.execute(select(probes.c.payload)).scalars())

    def service(self, store=None):
        return ProbeService(store or self.app.state.store, ProviderCatalog(self.settings, httpx.MockTransport(self.respond)),
            self.client.cookies.get("vitaai_session"), clock=lambda: self.now)

    def respond(self, request):
        self.calls.append(request)
        return self.response(request)

    def valid(self, request):
        body = json.loads(request.content)
        result = {"id": "synthetic-request-1", "model": body["model"]}
        if request.url.host == "api.anthropic.com":
            result.update(stop_reason="end_turn", content=[{"type": "text", "text": '{"status":"ok"}'}],
                usage={"input_tokens": 12, "output_tokens": 5})
        else:
            result.update(choices=[{"finish_reason": "stop", "message": {"content": '{"status":"ok"}'}}],
                usage={"prompt_tokens": 12, "completion_tokens": 5})
        return httpx.Response(200, json=result)

    def test_default_off_mock_role_and_read_only_history(self):
        path = fixtures.PREFIX + "/providers/openai/test-readiness"
        self.assertFalse(self.client.get(path).json()["can_start"])
        self.assertEqual(self.post(mode="live").status_code, 403)
        self.settings.comparison_test_enabled = True
        result = self.post()
        self.assertEqual(result.status_code, 200, result.text)
        saved = result.json()
        self.assertEqual((saved["mode"], saved["status"], saved["validation"]), ("mock", "unavailable", "not_run"))
        self.assertFalse(self.client.get(path).json()["can_start"])
        self.assertEqual(self.post().status_code, 409)
        self.assertEqual(self.client.get(fixtures.PREFIX + "/tests/" + saved["id"]).json(), saved)
        self.assertEqual(self.client.get(fixtures.PREFIX + "/providers/openai/tests").json(), [saved])
        self.assertEqual(self.client.head(fixtures.PREFIX + "/providers/openai/test").status_code, 405)
        for role in ["viewer", "seller", "reviewer"]:
            with self.app.state.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.admin.id).values(role=role))
            self.assertFalse(self.client.get(path).json()["can_start"])
            self.assertEqual(self.post(mode="live").status_code, 403)
        self.assertEqual(self.calls, [])

    def test_one_synthetic_call_per_provider_intent_before_network_and_safe_readback(self):
        self.settings.comparison_test_enabled = self.settings.comparison_byok_enabled = True
        self.settings.comparison_providers["foundry"] = fixtures.ComparisonProviderConfig(enabled=True,
            live_enabled=True, api_key="", model="deployment", resource_name="test-resource")
        before = self.client.get("/api/portfolio").json()
        def respond(request):
            body = json.loads(request.content)
            self.assertEqual(body["messages"][-1]["content"], 'Return only {"status":"ok"}.')
            self.assertNotIn("account", body)
            self.assertNotIn(KEY, request.content.decode())
            pending = [row for row in self.saved() if row["status"] == "pending"]
            self.assertEqual(len(pending), 1)
            self.assertNotIn(KEY, json.dumps(pending))
            self.assertEqual(request.method, "POST")
            return self.valid(request)
        self.inference = respond
        for provider in [*fixtures.ENDPOINTS, "foundry"]:
            result = self.post(provider, mode="live", api_key=KEY)
            self.assertEqual(result.status_code, 200, result.text)
            saved = result.json()
            self.assertEqual((saved["status"], saved["validation"], saved["credential_source"]),
                ("succeeded", "synthetic_compatibility_valid", "request"))
            self.assertEqual((saved["input_tokens"], saved["output_tokens"], saved["request_id"]), (12, 5, "synthetic-request-1"))
            request = self.calls[-1]
            endpoint = fixtures.ENDPOINTS.get(provider, "https://test-resource.services.ai.azure.com/openai/v1")
            self.assertEqual(str(request.url), endpoint + ("/messages" if provider == "anthropic" else "/chat/completions"))
            header = "x-api-key" if provider == "anthropic" else "api-key" if provider == "foundry" else "authorization"
            self.assertEqual(request.headers[header], KEY if header != "authorization" else "Bearer " + KEY)
            self.assertNotIn(KEY, result.text)
            self.assertEqual(self.client.get(fixtures.PREFIX + "/tests/" + saved["id"]).json(), saved)
        self.assertEqual(len(self.calls), 5)
        self.assertNotIn(KEY, json.dumps(self.saved()))
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.settings.comparison_providers["openai"].api_key.get_secret_value(), "synthetic-openai")

    def test_revision_configuration_byok_and_schema_never_dispatch_implicitly(self):
        self.settings.comparison_test_enabled = True
        self.assertEqual(self.post(mode="live", api_key=KEY).status_code, 403)
        self.settings.comparison_byok_enabled = True
        for changes in [{"api_key": KEY}, {"mode": "live", "api_key": KEY + "\r\n"},
                        {"mode": "live", "endpoint": "https://foreign.test"}, {"model": "client-model"}]:
            result = self.post(**changes)
            self.assertEqual(result.status_code, 422)
            self.assertNotIn(KEY, result.text)
        self.assertEqual(self.post(expected_configuration_revision=2).status_code, 409)
        for field, value in [("enabled", False), ("live_enabled", False), ("model", "")]:
            config = self.settings.comparison_providers["openai"]
            original = getattr(config, field)
            setattr(config, field, value)
            self.assertEqual(self.post(mode="live", api_key=KEY).status_code, 409)
            setattr(config, field, original)
        self.settings.comparison_organization_id = "foreign"
        self.assertEqual(self.post().status_code, 409)
        self.assertEqual((self.calls, self.saved()), ([], []))

    def test_strict_protocol_model_complete_output_and_echo_rejection(self):
        self.settings.comparison_test_enabled = self.settings.comparison_byok_enabled = True
        self.now = datetime.now(UTC)
        cases = ["not json", '{"status":"bad"}', '{"status":"ok","authority":true}',
            '{"status":"bad","status":"ok"}', "model", "incomplete", "echo"]
        for case in cases:
            def response(request, case=case):
                payload = self.valid(request).json()
                if case == "model": payload["model"] = "wrong-model"
                elif case == "incomplete": payload["choices"][0]["finish_reason"] = "length"
                elif case == "echo": payload["id"] = KEY
                else: payload["choices"][0]["message"]["content"] = case
                return httpx.Response(200, json=payload)
            self.response = response
            run = self.service().start(self.admin.id, "openai", ProbeRequest(mode="live", api_key=KEY, expected_configuration_revision=1))
            self.assertIn(run.status, {"failed", "invalid_output"})
            self.assertEqual(run.validation, "rejected")
            self.assertNotIn(KEY, run.model_dump_json() + json.dumps(self.saved()))
            self.now += timedelta(seconds=61)
        self.assertEqual(len(self.calls), len(cases))

    def test_failed_transport_never_retries_with_server_credential(self):
        self.settings.comparison_test_enabled = self.settings.comparison_byok_enabled = True
        self.now = datetime.now(UTC)
        for code in [401, 429, 503, "timeout"]:
            def response(request, code=code):
                self.assertEqual(request.headers["authorization"], "Bearer " + KEY)
                if code == "timeout": raise httpx.ReadTimeout("synthetic", request=request)
                return httpx.Response(code, json={"error": KEY})
            self.response = response
            run = self.service().start(self.admin.id, "openai", ProbeRequest(mode="live", api_key=KEY, expected_configuration_revision=1))
            self.assertEqual(run.status, "failed")
            self.assertNotIn(KEY, run.model_dump_json() + json.dumps(self.saved()))
            self.now += timedelta(seconds=61)
        self.assertEqual(len(self.calls), 4)

    def test_cooldown_retains_subsecond_start_precision(self):
        self.settings.comparison_test_enabled = True
        self.now = datetime.now(UTC).replace(microsecond=900000)
        self.response = self.valid
        body = ProbeRequest(mode="live", expected_configuration_revision=1)
        self.service().start(self.admin.id, "openai", body)
        self.now += timedelta(seconds=59.5)
        with self.assertRaisesRegex(PolicyDenied, "provider_test_cooldown"):
            self.service().start(self.admin.id, "openai", body)
        self.now += timedelta(seconds=0.5)
        self.assertTrue(self.service().readiness(self.admin.id, "openai").can_start)
        self.assertEqual(len(self.calls), 1)

    def test_expired_worker_cannot_publish_or_implicitly_unblock(self):
        self.settings.comparison_test_enabled = True
        self.now = datetime.now(UTC)
        def late(request):
            self.now += WORKER_BUDGET + timedelta(seconds=1)
            return self.valid(request)
        self.response = late
        with self.assertRaisesRegex(PolicyDenied, "probe_worker_expired"):
            self.service().start(self.admin.id, "openai", ProbeRequest(mode="live", expected_configuration_revision=1))
        saved = self.saved()[0]
        self.assertEqual((saved["status"], saved["revision"], saved["validation"]), ("pending", 1, "not_run"))
        self.assertIsNone(saved["request_id"])
        self.assertFalse(self.service().readiness(self.admin.id, "openai").can_start)
        self.assertEqual(len(self.calls), 1)

    def test_foreign_organization_cannot_read_retained_probe(self):
        self.settings.comparison_test_enabled = True
        saved = self.post().json()
        self.identity.create_user("foreign-probe-admin", "synthetic-password-123", "foreign", "admin")
        self.client.post("/api/auth/logout", headers=fixtures.HEADERS)
        result = self.client.post("/api/auth/login", headers=fixtures.HEADERS,
            json={"username": "foreign-probe-admin", "password": "synthetic-password-123"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(self.client.get(fixtures.PREFIX + "/tests/" + saved["id"]).status_code, 404)
        self.assertEqual(self.client.get(fixtures.PREFIX + "/providers/openai/tests").json(), [])
        self.assertEqual(self.post().status_code, 409)
        self.assertEqual(self.calls, [])

    def test_expired_worker_with_lost_session_cannot_private_discard(self):
        self.settings.comparison_test_enabled = True
        self.now = datetime.now(UTC)
        def late(request):
            self.now += WORKER_BUDGET + timedelta(seconds=1)
            self.identity.logout(self.client.cookies.get("vitaai_session"))
            return self.valid(request)
        self.response = late
        with self.assertRaises(PolicyDenied):
            self.service().start(self.admin.id, "openai", ProbeRequest(mode="live", expected_configuration_revision=1))
        saved = self.saved()[0]
        self.assertEqual((saved["status"], saved["revision"]), ("pending", 1))
        self.assertIsNone(saved["finished_at"])
        self.login()
        self.assertFalse(self.service().readiness(self.admin.id, "openai").can_start)
        self.assertEqual(len(self.calls), 1)

    def test_authority_configuration_and_gates_are_rechecked_after_call(self):
        self.settings.comparison_test_enabled = self.settings.comparison_byok_enabled = True
        for field in ["comparison_test_enabled", "comparison_byok_enabled", "configuration", "session"]:
            self.settings.comparison_test_enabled = self.settings.comparison_byok_enabled = True
            def change(field=field):
                if field == "configuration": self.settings.comparison_providers["openai"].revision += 1
                elif field == "session": self.identity.logout(self.client.cookies.get("vitaai_session"))
                else: setattr(self.settings, field, False)
            self.callback, self.inference = change, self.valid
            revision = self.settings.comparison_providers["openai"].revision
            result = self.post(mode="live", api_key=KEY, expected_configuration_revision=revision)
            self.assertIn(result.status_code, [401, 403, 409])
            self.assertEqual(self.saved()[-1]["status"], "discarded")
            self.assertNotIn(KEY, result.text + json.dumps(self.saved()))
            self.callback = None
            if field == "session": self.login()
            with self.app.state.store.engine.begin() as connection:
                connection.execute(update(probes).values(started_at=0))
        self.assertEqual(len(self.calls), 4)

    def test_worker_loss_stays_pending_after_deadline_and_reconstruction(self):
        self.settings.comparison_test_enabled = True
        self.now = datetime.now(UTC)
        class WorkerLost(BaseException): pass
        def lose(_): raise WorkerLost()
        self.response = lose
        with self.assertRaises(WorkerLost):
            self.service().start(self.admin.id, "openai", ProbeRequest(mode="live", expected_configuration_revision=1))
        original = self.saved()[0]
        self.now += WORKER_BUDGET + timedelta(seconds=1)
        reconstructed = Store(self.settings.database_url)
        try:
            service = self.service(reconstructed)
            self.assertEqual(str(service.readiness(self.admin.id, "openai").pending_run_id), original["id"])
            self.assertFalse(service.readiness(self.admin.id, "openai").can_start)
            with self.assertRaisesRegex(PolicyDenied, "provider_test_pending"):
                service.start(self.admin.id, "openai", ProbeRequest(mode="live", expected_configuration_revision=1))
        finally: reconstructed.engine.dispose()
        self.assertEqual(self.saved()[0], original)
        self.assertEqual(len(self.calls), 1)

    def test_concurrent_call_is_blocked_and_terminal_revision_cannot_overwrite(self):
        self.settings.comparison_test_enabled = True
        self.now = datetime.now(UTC)
        entered, release = Event(), Event()
        def response(request):
            entered.set()
            if not release.wait(10): raise AssertionError("fixture timed out")
            return self.valid(request)
        self.response = response
        body = ProbeRequest(mode="live", expected_configuration_revision=1)
        with ThreadPoolExecutor(max_workers=2) as pool:
            future = pool.submit(self.service().start, self.admin.id, "openai", body)
            try:
                self.assertTrue(entered.wait(5))
                with self.assertRaisesRegex(PolicyDenied, "provider_test_pending"):
                    self.service().start(self.admin.id, "openai", body)
            finally: release.set()
            run = future.result(10)
        original = self.saved()[0]
        with self.assertRaisesRegex(PolicyDenied, "probe_worker_fenced"), self.app.state.store.engine.begin() as connection:
            ProbeService.finish(connection, run, self.now)
        self.assertEqual(self.saved()[0], original)
        self.assertEqual(len(self.calls), 1)

    def test_request_boundary_denies_gate_loss_before_network(self):
        self.settings.comparison_test_enabled = True
        def changed(catalog, config, run, before_request):
            self.settings.comparison_test_enabled = False
            return probe_once(catalog, config, run, before_request)
        with patch("vita_api.provider_probe.probe_once", changed):
            result = self.post(mode="live")
        self.assertEqual(result.status_code, 403)
        self.assertEqual(self.saved()[0]["status"], "discarded")
        self.assertEqual(self.calls, [])
