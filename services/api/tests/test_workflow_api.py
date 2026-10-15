"""Authenticated HTTP simulation journey; no paid provider or external adapter."""
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.identity import Identity
from vita_api.sample import SAMPLE_ORG

HEADERS = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}


class WorkflowApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = Settings(_env_file=None, auth_mode="session",
                                 database_url=f"sqlite:///{Path(self.temp.name) / 'http.sqlite'}")
        self.app = create_app(self.settings)
        self.client = TestClient(self.app).__enter__()
        identity = Identity(self.app.state.store.engine)
        identity.create_user("seller", "test-password-long", SAMPLE_ORG, "seller")
        identity.create_user("reviewer", "test-password-long", SAMPLE_ORG, "reviewer")

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def login(self, name):
        self.assertEqual(self.client.post("/api/auth/login", headers=HEADERS,
            json={"username": name, "password": "test-password-long"}).status_code, 200)

    def post(self, path, body):
        response = self.client.post(path, headers=HEADERS, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def create(self, payload=None, template="account-action-1", connector="simulation-hubspot"):
        payload = payload or {"kind": "hubspot_task_create", "title": "Review support", "body": "Exact task body\n "}
        self.login("seller")
        account = self.client.get("/api/portfolio").json()["accounts"][0]
        plan = self.post("/api/plans", {"account_id": account["account"]["id"], "expected_revision": 1,
            "expected_snapshot_hash": account["assessment"]["snapshot_hash"], "intent": "risk",
            "action_kind": payload["kind"]})
        mission = self.post("/api/missions", {"plan_id": plan["id"], "expected_revision": plan["revision"],
                                               "template": template})
        action = self.post(f'/api/missions/{mission["id"]}/prepare', {"expected_revision": mission["revision"],
            "alternative_id": plan["selected_alternative_id"], "connector_id": connector, "payload": payload})
        return plan, mission, action

    def test_note_and_outlook_http_review_execution_and_replay(self):
        for index, (payload, template, connector) in enumerate([
                ({"kind": "hubspot_note_create", "body": "Exact note\n "}, "account-note-1", "simulation-hubspot"),
                ({"kind": "outlook_draft_create", "to": ["buyer@example.com"], "subject": " Review ",
                  "body_text": "Exact draft\n "}, "account-outlook-draft-1", "simulation-microsoft")]):
            with self.subTest(kind=payload["kind"]):
                self.client.cookies.clear()
                _, _, action = self.create(payload, template, connector)
                seller_session = self.client.cookies.get("vitaai_session")
                seller_id = self.client.get("/api/auth/session").json()["actor"]["id"]
                submitted = self.post(f'/api/actions/{action["id"]}/submit', {
                    "expected_revision": action["revision"], "binding_hash": action["binding_hash"]})
                self.client.cookies.clear()
                self.login("reviewer")
                decision = self.post(f'/api/actions/{action["id"]}/review', {
                    "expected_revision": submitted["revision"], "binding_hash": submitted["binding_hash"],
                    "decision": "approved"})
                self.client.cookies.clear()
                self.client.cookies.set("vitaai_session", seller_session)
                request = {"expected_revision": submitted["revision"], "decision_id": decision["id"],
                           "idempotency_key": f"http-kind-{index}"}
                execution = self.post(f'/api/actions/{action["id"]}/execute', request)
                self.assertEqual(execution["status"], "succeeded")
                self.assertEqual(self.post(f'/api/actions/{action["id"]}/execute', request), execution)
                receipt = self.client.get(f'/api/receipts/{execution["receipt_id"]}').json()
                self.assertEqual((receipt["mode"], receipt["verification"]), ("simulation", "verified"))
                if payload["kind"] == "outlook_draft_create":
                    self.assertEqual(receipt["destination"]["mailbox_id"], "simulation-mailbox:" + seller_id)
                self.assertEqual(self.client.get(f'/api/actions/{action["id"]}').json()["payload"],
                                 {"schema_version": "1", **payload})

    def test_outlook_input_validation_and_server_owned_destination(self):
        payload = {"kind": "outlook_draft_create", "to": ["buyer@example.com"], "subject": "Review", "body_text": "Draft"}
        plan, mission, _ = self.create(payload, "account-outlook-draft-1", "simulation-microsoft")
        current = self.client.get(f'/api/missions/{mission["id"]}').json()
        body = {"expected_revision": current["revision"], "alternative_id": plan["selected_alternative_id"],
                "connector_id": "simulation-microsoft", "payload": payload}
        for changes in ({"to": ["buyer@example.com", "BUYER@example.com"]}, {"to": ["invalid"]},
                        {"subject": "Review\r\nBcc:other@example.com"}, {"body_text": "bad\u0000"},
                        {"send": True}):
            with self.subTest(changes=changes):
                response = self.client.post(f'/api/missions/{mission["id"]}/prepare', headers=HEADERS,
                                            json={**body, "payload": {**payload, **changes}})
                self.assertEqual(response.status_code, 422)
        for field in ("destination", "mailbox_id", "delegated_user_id"):
            response = self.client.post(f'/api/missions/{mission["id"]}/prepare', headers=HEADERS,
                                        json={**body, field: "sentinel-forged-mailbox"})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("sentinel-forged-mailbox", response.text)
        self.assertEqual(self.client.get(f'/api/missions/{mission["id"]}').json(), current)

    def test_multiple_action_http_alternative_and_dependency_journey(self):
        self.login("seller")
        seller_session = self.client.cookies.get("vitaai_session")
        account = self.client.get("/api/portfolio").json()["accounts"][0]
        plan = self.post("/api/plans", {"account_id": account["account"]["id"], "expected_revision": 1,
            "expected_snapshot_hash": account["assessment"]["snapshot_hash"], "intent": "risk", "strategy": "follow_up"})
        choice = plan["alternatives"][1]
        mission = self.post("/api/missions", {"plan_id": plan["id"], "expected_revision": plan["revision"],
            "template": "account-follow-up-1", "alternative_id": choice["id"]})
        self.assertEqual(mission["alternative_id"], choice["id"])
        for step in choice["steps"]:
            payload = ({"kind": "outlook_draft_create", "to": ["buyer@example.com"], "subject": "Review",
                        "body_text": "Exact draft\n "} if step["kind"] == "outlook_draft_create" else
                       {"kind": "hubspot_note_create", "body": "Exact note\n "})
            current = self.client.get(f'/api/missions/{mission["id"]}').json()
            self.post(f'/api/missions/{mission["id"]}/prepare', {"expected_revision": current["revision"],
                "alternative_id": choice["id"], "step_id": step["id"], "payload": payload,
                "connector_id": "simulation-microsoft" if step["kind"] == "outlook_draft_create" else "simulation-hubspot"})
        response = self.client.get(f'/api/missions/{mission["id"]}/actions')
        self.assertEqual(response.status_code, 200, response.text)
        by_step = {item["step_id"]: item for item in response.json()}
        submitted = [self.post(f'/api/actions/{by_step[step["id"]]["id"]}/submit', {
            "expected_revision": by_step[step["id"]]["revision"], "binding_hash": by_step[step["id"]]["binding_hash"]})
            for step in choice["steps"]]
        self.client.cookies.clear()
        self.login("reviewer")
        decisions = [self.post(f'/api/actions/{item["id"]}/review', {
            "expected_revision": item["revision"], "binding_hash": item["binding_hash"], "decision": "approved"})
            for item in submitted]
        self.client.cookies.clear()
        self.client.cookies.set("vitaai_session", seller_session)
        requests = [{"expected_revision": item["revision"], "decision_id": decision["id"],
                     "idempotency_key": item["id"]} for item, decision in zip(submitted, decisions, strict=True)]
        denied = self.client.post(f'/api/actions/{submitted[1]["id"]}/execute', headers=HEADERS, json=requests[1])
        self.assertEqual((denied.status_code, denied.json()["detail"]["code"]), (409, "dependency_not_satisfied"))
        for item, request in zip(submitted, requests, strict=True):
            execution = self.post(f'/api/actions/{item["id"]}/execute', request)
            self.assertEqual(execution["status"], "succeeded")
        current = self.client.get(f'/api/missions/{mission["id"]}').json()
        self.assertEqual(current["status"], "executed")
        self.post(f'/api/missions/{mission["id"]}/outcomes', {"expected_revision": current["revision"],
            "receipt_id": execution["receipt_id"], "kind": "follow_up_required", "basis": "manual_report",
            "evidence_ids": plan["evidence"]["evidence_ids"], "note": "Follow up on simulated preparation."})
        self.assertEqual(self.client.get(f'/api/missions/{mission["id"]}').json()["status"], "completed")

    def test_authenticated_http_journey_and_restart(self):
        plan, mission, action = self.create()
        seller_session = self.client.cookies.get("vitaai_session")
        action = self.post(f'/api/actions/{action["id"]}/submit', {"expected_revision": action["revision"],
            "binding_hash": action["binding_hash"]})
        # Distinct sessions: logging in on the same cookie would revoke the reviewing session.
        self.client.cookies.clear()
        self.login("reviewer")
        decision = self.post(f'/api/actions/{action["id"]}/review', {"expected_revision": action["revision"],
            "binding_hash": action["binding_hash"], "decision": "approved"})
        self.client.cookies.clear()
        self.client.cookies.set("vitaai_session", seller_session)
        execution = self.post(f'/api/actions/{action["id"]}/execute', {"expected_revision": action["revision"],
            "decision_id": decision["id"], "idempotency_key": "http-1"})
        self.assertEqual(execution["status"], "succeeded")
        receipt = self.client.get(f'/api/receipts/{execution["receipt_id"]}').json()
        self.assertEqual((receipt["mode"], receipt["verification"]), ("simulation", "verified"))
        current = self.client.get(f'/api/missions/{mission["id"]}').json()
        self.assertEqual(current["status"], "executed")
        self.post(f'/api/missions/{mission["id"]}/outcomes', {"expected_revision": current["revision"],
            "receipt_id": receipt["id"], "kind": "follow_up_required", "basis": "manual_report",
            "evidence_ids": plan["evidence"]["evidence_ids"], "note": "Simulation reviewed; follow up on test evidence."})
        cookie = self.client.cookies.get("vitaai_session")
        with TestClient(create_app(self.settings)) as restarted:
            restarted.cookies.set("vitaai_session", cookie)
            self.assertEqual(restarted.get(f'/api/missions/{mission["id"]}').json()["status"], "completed")
            self.assertEqual(restarted.get(f'/api/executions/{execution["id"]}').json(), execution)

    def test_absent_session_and_authority_tampering_have_safe_errors(self):
        self.assertEqual(self.client.get("/api/missions").status_code, 401)
        _, mission, action = self.create()
        denied = self.client.post(f'/api/actions/{action["id"]}/review', headers=HEADERS,
            json={"expected_revision": action["revision"], "binding_hash": action["binding_hash"], "decision": "approved"})
        self.assertEqual(denied.status_code, 403)
        tampered = self.client.post(f'/api/actions/{action["id"]}/execute', headers=HEADERS,
            json={"expected_revision": 1, "decision_id": action["id"], "idempotency_key": "x",
                  "actor_id": "pretend-reviewer", "api_key": "sentinel-private-input"})
        self.assertEqual(tampered.status_code, 422)
        self.assertNotIn("sentinel-private-input", tampered.text)
        self.assertIn("correlation_id", tampered.text)
        self.assertEqual(self.client.get(f'/api/missions/{mission["id"]}').json()["status"], "prepared")

    def test_sample_mode_cannot_review_or_simulate_authenticated_authority(self):
        sample = self.settings.model_copy(update={"auth_mode": "sample"})
        with TestClient(create_app(sample)) as client:
            response = client.get("/api/missions")
            self.assertEqual(response.status_code, 503)

    def test_revoked_reviewer_session_invalidates_approval(self):
        _, _, action = self.create()
        action = self.post(f'/api/actions/{action["id"]}/submit', {"expected_revision": action["revision"],
            "binding_hash": action["binding_hash"]})
        self.login("reviewer")
        decision = self.post(f'/api/actions/{action["id"]}/review', {"expected_revision": action["revision"],
            "binding_hash": action["binding_hash"], "decision": "approved"})
        self.login("seller")  # Existing login rotates/revokes the previous reviewing session.
        result = self.client.post(f'/api/actions/{action["id"]}/execute', headers=HEADERS,
            json={"expected_revision": action["revision"], "decision_id": decision["id"], "idempotency_key": "revoked-review"})
        self.assertEqual(result.status_code, 409)
        self.assertEqual(result.json()["detail"]["code"], "reviewer_session_invalidated")
