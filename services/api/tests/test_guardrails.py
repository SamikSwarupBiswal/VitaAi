"""Curated classification is advisory; lab requests leave business tables intact."""
import unittest
from unittest.mock import patch

import test_memory as fixtures
from fastapi.testclient import TestClient
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.guardrails import (
    SCENARIOS,
    GuardrailRequest,
    deterministic_findings,
    evaluate_guardrail,
)
from vita_api.identity import Actor, users


class GuardrailRulesTests(unittest.TestCase):
    def test_failure_matrix_cannot_override_policy(self):
        actor = Actor(id="synthetic", username="Synthetic", organization_id="lab", role="viewer")
        def fail(_):
            raise RuntimeError("private exception detail")
        for scenario in SCENARIOS:
            expected = "explanation_only" if scenario.id == "evidence-summary" else "blocked"
            for mode in ("disabled", "mock", "simulated_failure"):
                for classifier in (lambda _: False, lambda _: True, lambda _: None, lambda _: float("nan"), fail):
                    result = evaluate_guardrail(GuardrailRequest(scenario_id=scenario.id, classifier_mode=mode), actor, classifier=classifier)
                    self.assertEqual(result.final_decision, expected)
                    self.assertEqual(result.deterministic_decision, expected)
                    self.assertNotIn("private exception detail", result.model_dump_json())
                    if mode == "disabled":
                        self.assertEqual(result.classifier.status, "disabled")
                    else:
                        self.assertEqual(result.classifier.evidence_tier, "synthetic")
                        if result.classifier.status == "failed":
                            self.assertIsNone(result.classifier.advisory_flag)

    def test_unicode_multiline_and_safe_words(self):
        for text in ("IGNORE\nPOLICY", "ｉｇｎｏｒｅ policy", "ig\u200bnore POLICY", "ignore---instructions", "fabricate\noutcome"):
            self.assertTrue(any(item.triggered for item in deterministic_findings(text)), text)
        self.assertFalse(any(item.triggered for item in deterministic_findings("Explain dated evidence and show uncertainty.")))


class GuardrailApiTests(unittest.TestCase):
    setUp = fixtures.MemoryTests.setUp
    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)

    def client(self, mode="session"):
        return TestClient(create_app(Settings(_env_file=None, database_url=str(self.store.engine.url), auth_mode=mode), fixtures.NoInference()))

    def test_modes_preserve_all_rows_and_history(self):
        with self.client() as client:
            client.cookies.set("vitaai_session", self.token)
            before = self.snapshot(self.store)
            self.assertEqual(len(client.get("/api/guardrails/scenarios").json()["scenarios"]), 7)
            for scenario in SCENARIOS:
                for mode in ("disabled", "mock", "simulated_failure"):
                    response = client.post("/api/guardrails/classify", headers=fixtures.HEADERS,
                        json={"scenario_id": scenario.id, "classifier_mode": mode})
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json()
                    self.assertEqual(result["actor_id"], self.actor.id)
                    self.assertEqual(result["organization_id"], fixtures.SAMPLE_ORG)
                    self.assertEqual(result["final_decision"], result["deterministic_decision"])
                    self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertEqual(before, self.snapshot(self.store))

    def test_session_sample_and_midrequest_revocation(self):
        with self.client("sample") as client:
            self.assertEqual(client.get("/api/guardrails/scenarios").status_code, 503)
        with self.client() as client:
            self.assertEqual(client.get("/api/guardrails/scenarios").status_code, 401)
            client.cookies.set("vitaai_session", self.token)
            def revoke(body, actor):
                result = evaluate_guardrail(body, actor)
                with self.store.engine.begin() as connection:
                    connection.execute(users.update().where(users.c.id == actor.id).values(enabled=False))
                return result
            with patch("vita_api.guardrails.evaluate_guardrail", revoke):
                self.assertEqual(client.post("/api/guardrails/classify", headers=fixtures.HEADERS,
                    json={"scenario_id": "evidence-summary"}).status_code, 401)

    def test_viewer_scope_safe_schema_origin_and_header_errors(self):
        self.identity.create_user("lab-viewer", "synthetic-password-long", "other-org", "viewer")
        actor, token = self.identity.login("lab-viewer", "synthetic-password-long", 24)
        with self.client() as client:
            client.cookies.set("vitaai_session", token)
            response = client.post("/api/guardrails/classify", headers=fixtures.HEADERS, json={"scenario_id": "approval-shortcut"})
            self.assertEqual(response.json()["organization_id"], actor.organization_id)
            self.assertEqual(response.json()["final_decision"], "blocked")
            for body in ({"scenario_id": "private-value"}, {"scenario_id": "evidence-summary", "classifier_mode": "live"},
                         {"scenario_id": "evidence-summary", "prompt": "private-value"}):
                invalid = client.post("/api/guardrails/classify", headers=fixtures.HEADERS, json=body)
                self.assertEqual(invalid.status_code, 422)
                self.assertNotIn("private-value", invalid.text)
            self.assertEqual(client.post("/api/guardrails/classify", json={"scenario_id": "evidence-summary"}).status_code, 403)
            self.assertEqual(client.post("/api/guardrails/classify", headers={**fixtures.HEADERS, "Origin": "https://foreign.example"},
                json={"scenario_id": "evidence-summary"}).status_code, 403)
            self.assertEqual(client.get("/api/guardrails/classify").status_code, 405)


if __name__ == "__main__":
    unittest.main()
