"""Isolated database/workflow checks with explicitly mocked HubSpot HTTP transport."""
import copy
import json
import os
import unittest
from datetime import timedelta
from unittest.mock import patch

import httpx
import test_stage2 as fixtures
from fastapi.testclient import TestClient
from sqlalchemy import select

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.governance import PolicyDenied
from vita_api.hubspot_execution import HubSpotWrites
from vita_api.sample import SAMPLE_ORG
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import (
    ExecuteRequest,
    NotePayload,
    PrepareRequest,
    ReviewRequest,
    SubmitRequest,
    TaskPayload,
)
from vita_api.workflow_storage import claims, receipts, resources


class HubSpotExecutionTests(unittest.TestCase):
    setUp = fixtures.Stage2Tests.setUp
    tearDown = fixtures.Stage2Tests.tearDown
    prepare = fixtures.Stage2Tests.prepare
    approve = fixtures.Stage2Tests.approve

    def configure(self):
        self.calls, self.saved = [], {}
        self.post_error = self.read_error = None
        self.on_post = None
        self.settings = Settings(_env_file=None, auth_mode="session", hubspot_enabled=True,
            hubspot_write_enabled=True, hubspot_access_token="test-only-token", hubspot_organization_id=SAMPLE_ORG,
            hubspot_portal_id="456", hubspot_company_map={self.account.id: "123"})
        self.adapter = HubSpotWrites(self.settings, httpx.MockTransport(self.respond))
        self.workflow = Workflow(self.store, clock=lambda: self.now, hubspot=self.adapter)

    def respond(self, request):
        self.calls.append(request)
        self.assertEqual(request.url.host, "api.hubapi.com")
        if request.url.path == "/account-info/v3/details":
            return httpx.Response(200, json={"portalId": 456})
        if request.url.path == "/crm/objects/2026-09/companies/123":
            return httpx.Response(200, json={"id": "123", "archived": False})
        if request.method == "POST":
            with self.store.engine.connect() as connection:
                self.assertEqual(connection.execute(select(claims.c.payload)).scalar_one()["status"], "dispatching")
            self.saved = json.loads(request.content)
            if self.on_post:
                self.on_post()
            if self.post_error:
                raise self.post_error
            return httpx.Response(201, json={"id": "789"})
        self.assertTrue(request.url.path.endswith("/789"))
        if self.read_error:
            return self.read_error
        association = "task_to_company" if "/tasks/" in request.url.path else "note_to_company"
        return httpx.Response(200, json={"id": "789", "archived": False, "properties": self.saved["properties"],
            "associations": {"companies": {"results": [{"id": "123", "type": association}]}}})

    def live(self, payload=None, template="account-action-1"):
        self.prepare(payload=payload or TaskPayload(title=" Exact Ω ", body="Line\n  body", due_at=self.now + timedelta(days=1)),
                     template=template)
        self.action = self.workflow.prepare(self.seller.id, self.mission.id, PrepareRequest(
            expected_revision=self.mission.revision, alternative_id=self.plan.selected_alternative_id,
            connector_id="hubspot-live", mode="live", payload=self.action.payload))
        self.action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash))
        self.decision = self.workflow.review(self.reviewer.id, self.action.id, ReviewRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash, decision="approved"))
        return ExecuteRequest(expected_revision=self.action.revision, decision_id=self.decision.id, idempotency_key="live-1")

    def test_task_verifies_independent_get_and_replay_without_post(self):
        self.configure()
        request = self.live()
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        receipt = self.workflow.get_receipt(self.seller.id, execution.receipt_id)
        self.assertEqual((execution.status, receipt.mode, receipt.verification), ("succeeded", "live", "verified"))
        self.assertEqual(self.saved, json.loads(self.action.provider_request))
        self.assertEqual(self.saved["associations"][0]["to"]["id"], "123")
        self.assertEqual(self.saved["properties"]["hs_task_body"], self.action.payload.body)
        self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, request), execution)
        self.assertEqual(len([call for call in self.calls if call.method == "POST"]), 1)
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(resources.c.id)).first())

    def test_note_exact_properties_and_independent_readback(self):
        self.configure()
        request = self.live(NotePayload(body="Exact note\n Ω "), "account-note-1")
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(execution.status, "succeeded")
        self.assertEqual(self.saved, json.loads(self.action.provider_request))
        self.assertEqual(self.saved["properties"]["hs_note_body"], self.action.payload.body)
        self.assertEqual(self.saved["associations"][0]["types"][0]["associationTypeId"], 190)

    def test_execution_readiness_is_scoped_role_aware_and_never_contacts_provider(self):
        self.configure()
        viewer = self.identity.create_user("viewer", "test-password-long", SAMPLE_ORG, "viewer")
        foreign = self.identity.create_user("foreign", "test-password-long", "other-org", "admin")
        for actor, prepare, reconcile in [(self.seller, True, False), (self.reviewer, True, True),
                                         (viewer, False, False)]:
            ready = self.workflow.hubspot_readiness(actor.id, self.account.id)
            self.assertEqual((ready.can_prepare, ready.can_reconcile), (prepare, reconcile))
            self.assertEqual((ready.account_revision, ready.destination.target_resource_id), (1, "123"))
            self.assertNotIn("test-only-token", ready.model_dump_json())
        with self.assertRaises(PolicyDenied) as error:
            self.workflow.hubspot_readiness(foreign.id, self.account.id)
        self.assertEqual(error.exception.status_code, 404)
        for update, expected in [({"hubspot_write_enabled": False}, (False, True)),
                                 ({"hubspot_enabled": False}, (False, False)),
                                 ({"hubspot_company_map": {}}, (False, False)),
                                 ({"hubspot_organization_id": "other-org"}, (False, False))]:
            workflow = Workflow(self.store, hubspot=HubSpotWrites(self.settings.model_copy(update=update)))
            ready = workflow.hubspot_readiness(self.reviewer.id, self.account.id)
            self.assertEqual((ready.can_prepare, ready.can_reconcile), expected)
            self.assertEqual(ready.destination is not None, expected[1])
        self.assertEqual(self.calls, [])

    def test_authenticated_execution_readiness_requires_current_session_without_dispatch(self):
        self.configure()
        settings = self.settings.model_copy(update={"database_url": self.store.engine.url.render_as_string(hide_password=False)})
        app = create_app(settings, hubspot_transport=httpx.MockTransport(self.respond))
        path = f"/api/integrations/hubspot/accounts/{self.account.id}/execution-readiness"
        headers = {"X-VitaAi-Request": "1"}
        with TestClient(app) as client:
            self.assertEqual(client.get(path).status_code, 401)
            self.assertEqual(client.post("/api/auth/login", headers=headers,
                json={"username": "reviewer", "password": "test-password-long"}).status_code, 200)
            response = client.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertTrue(response.json()["can_reconcile"])
            self.assertEqual(client.post(path, headers=headers, json={}).status_code, 405)
            client.post("/api/auth/logout", headers=headers)
            self.assertEqual(client.get(path).status_code, 401)
        self.assertEqual(self.calls, [])

    def test_readback_failure_retains_id_and_reconciles_without_new_write(self):
        self.configure()
        request = self.live()
        self.read_error = httpx.Response(503, json={"message": "test-only-token"})
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        old = self.workflow.get_receipt(self.seller.id, execution.receipt_id)
        self.assertEqual((execution.status, old.provider_resource_id), ("result_unknown", "789"))
        self.read_error = None
        restarted = Workflow(self.store, clock=lambda: self.now, hubspot=self.adapter)
        execution = restarted.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual(execution.status, "succeeded")
        self.assertEqual(restarted.get_receipt(self.seller.id, old.id), old)
        self.assertEqual(len([call for call in self.calls if call.method == "POST"]), 1)

    def test_simulation_approval_cannot_be_promoted_by_configuration(self):
        request = self.approve()
        self.configure()
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(self.workflow.get_receipt(self.seller.id, execution.receipt_id).mode, "simulation")
        self.assertEqual(self.calls, [])

    def test_disabled_or_changed_destination_denies_before_post(self):
        self.configure()
        request = self.live()
        for update in ({"hubspot_write_enabled": False}, {"hubspot_configuration_revision": 2},
                       {"hubspot_company_map": {self.account.id: "999"}}):
            workflow = Workflow(self.store, clock=lambda: self.now,
                hubspot=HubSpotWrites(self.settings.model_copy(update=update), httpx.MockTransport(self.respond)))
            with self.subTest(update=update), self.assertRaises(PolicyDenied):
                workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(self.calls, [])

    def test_result_persists_after_requesting_user_is_disabled(self):
        self.configure()
        request = self.live()

        def disable():
            with self.store.engine.begin() as connection:
                connection.execute(fixtures.users.update().where(fixtures.users.c.id == self.seller.id).values(enabled=False))

        self.on_post = disable
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(execution.status, "succeeded")
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(claims.c.payload)).scalar_one()["status"], "succeeded")
            self.assertTrue(connection.execute(select(receipts.c.id)).first())

    def test_timeout_after_possible_post_is_unknown_and_never_reposted(self):
        self.configure()
        request = self.live()
        self.post_error = httpx.ReadTimeout("test-only-token")
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(execution.status, "result_unknown")
        self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, request), execution)
        with self.assertRaises(PolicyDenied):
            self.workflow.retry(self.seller.id, execution.id, request.model_copy(update={"expected_revision": execution.revision}))
        recovered = self.workflow.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual(recovered.status, "result_unknown")
        self.assertEqual(len([call for call in self.calls if call.method == "POST"]), 1)
        self.assertNotIn("test-only-token", self.workflow.get_receipt(self.seller.id, recovered.receipt_id).model_dump_json())

    def test_readback_rejects_changed_content_foreign_association_and_partial_data(self):
        self.configure()
        request = self.live()
        self.saved = json.loads(self.action.provider_request)
        expected = {"id": "789", "archived": False, "properties": self.saved["properties"],
            "associations": {"companies": {"results": [{"id": "123", "type": "task_to_company"}]}}}
        variants = []
        for key, value in [("hs_task_body", "wrong"), ("hs_timestamp", "2020-01-01T00:00:00Z")]:
            changed = copy.deepcopy(expected)
            changed["properties"][key] = value
            variants.append(changed)
        variants += [{**expected, "id": "999"}, {**expected, "archived": True},
                     {**expected, "associations": {"companies": {"results": [{"id": "999", "type": "task_to_company"}]}}},
                     {**expected, "associations": {"companies": {"results": [], "paging": {"next": {"after": "1"}}}}}]
        for data in variants:
            self.read_error = httpx.Response(200, json=data)
            self.assertEqual(self.adapter.readback(self.action, "789")[0], "mismatch")
        self.read_error = httpx.Response(200, json=variants[0])
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(execution.status, "result_unknown")
        self.assertEqual(self.workflow.get_receipt(self.seller.id, execution.receipt_id).verification, "mismatch")

    def test_live_task_requires_explicit_representable_due_time(self):
        self.configure()
        self.prepare()
        for due in (None, self.now.replace(microsecond=123456)):
            with self.assertRaises(PolicyDenied) as error:
                self.workflow.prepare(self.seller.id, self.mission.id, PrepareRequest(
                    expected_revision=self.mission.revision, alternative_id=self.plan.selected_alternative_id,
                    connector_id="hubspot-live", mode="live", payload=TaskPayload(title="task", body="body", due_at=due)))
            self.assertEqual(error.exception.code, "live_task_requires_millisecond_due_time")
        self.assertEqual(self.calls, [])

    def test_authenticated_http_exact_approval_and_execution(self):
        self.configure()
        settings = self.settings.model_copy(update={"database_url": self.store.engine.url.render_as_string(hide_password=False)})
        app = create_app(settings, hubspot_transport=httpx.MockTransport(self.respond))
        headers = {"X-VitaAi-Request": "1", "Origin": "http://127.0.0.1:3000"}
        with TestClient(app) as seller, TestClient(app) as reviewer:
            for client, name in ((seller, "seller"), (reviewer, "reviewer")):
                self.assertEqual(client.post("/api/auth/login", headers=headers,
                    json={"username": name, "password": "test-password-long"}).status_code, 200)

            def post(client, path, body):
                response = client.post(path, headers=headers, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                return response.json()

            view = next(item for item in seller.get("/api/portfolio").json()["accounts"]
                        if item["account"]["id"] == self.account.id)
            plan = post(seller, "/api/plans", {"account_id": self.account.id, "expected_revision": 1,
                "expected_snapshot_hash": view["assessment"]["snapshot_hash"], "intent": "risk"})
            mission = post(seller, "/api/missions", {"plan_id": plan["id"], "expected_revision": 1})
            action = post(seller, f'/api/missions/{mission["id"]}/prepare', {"expected_revision": mission["revision"],
                "alternative_id": plan["selected_alternative_id"], "connector_id": "hubspot-live", "mode": "live",
                "payload": {"kind": "hubspot_task_create", "title": "HTTP Ω", "body": "Exact\n ",
                            "due_at": (self.now + timedelta(days=4)).isoformat()}})
            self.assertEqual((action["mode"], action["destination"]["tenant_id"]), ("live", "456"))
            action = post(seller, f'/api/actions/{action["id"]}/submit', {
                "expected_revision": action["revision"], "binding_hash": action["binding_hash"]})
            review = {"expected_revision": action["revision"], "binding_hash": action["binding_hash"], "decision": "approved"}
            self.assertEqual(seller.post(f'/api/actions/{action["id"]}/review', headers=headers, json=review).status_code, 403)
            decision = post(reviewer, f'/api/actions/{action["id"]}/review', review)
            execute = {"expected_revision": action["revision"], "decision_id": decision["id"], "idempotency_key": "http-live"}
            path = f'/api/actions/{action["id"]}/execute'
            self.assertEqual(seller.post(path, headers=headers, json={**execute, "payload": action["payload"]}).status_code, 422)
            execution = post(seller, path, execute)
            self.assertEqual(execution["status"], "succeeded")
            receipt = seller.get(f'/api/receipts/{execution["receipt_id"]}').json()
            self.assertEqual((receipt["mode"], receipt["verification"]), ("live", "verified"))

    def test_configuration_revision_reads_normal_environment_text(self):
        with patch.dict(os.environ, {"HUBSPOT_CONFIGURATION_REVISION": "2"}):
            self.assertEqual(Settings(_env_file=None).hubspot_configuration_revision, 2)

    def test_cancelled_old_worker_cannot_dispatch_a_new_attempt(self):
        self.configure()
        request = self.live()
        old, _ = self.workflow.claim(self.seller.id, self.action.id, request)
        cancelled = self.workflow.reconcile(self.reviewer.id, old.id, old.revision)
        with patch.object(self.workflow, "_run_claimed", side_effect=lambda actor, action, execution: execution):
            retried = self.workflow.retry(self.seller.id, old.id,
                request.model_copy(update={"expected_revision": cancelled.revision}))
        with self.assertRaises(PolicyDenied) as error:
            self.workflow._run_claimed(self.seller.id, self.action.id, old)
        self.assertEqual(error.exception.code, "dispatch_attempt_changed")
        self.assertEqual(self.calls, [])
        result = self.workflow._run_claimed(self.seller.id, self.action.id, retried)
        self.assertEqual((result.status, result.attempt), ("succeeded", 2))

    def test_worker_loss_after_returned_id_recovers_by_get_without_post(self):
        self.configure()
        request = self.live()
        with patch.object(self.adapter, "readback", side_effect=SystemExit("controlled worker loss")), self.assertRaises(SystemExit):
            self.workflow.execute(self.seller.id, self.action.id, request)
        execution = self.workflow.list_executions(self.seller.id, self.action.id)[0]
        self.assertEqual(execution.status, "result_unknown")
        self.assertEqual(self.workflow.get_receipt(self.seller.id, execution.receipt_id).provider_resource_id, "789")
        restarted = Workflow(self.store, clock=lambda: self.now, hubspot=self.adapter)
        result = restarted.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(len([call for call in self.calls if call.method == "POST"]), 1)

    def test_mixed_mode_dependencies_cannot_claim(self):
        self.configure()
        plan, mission, _ = fixtures.Stage2Tests.multi(self)
        mission = self.workflow.get_mission(self.seller.id, mission.id)
        note = plan.alternatives[0].steps[1]
        self.workflow.prepare(self.seller.id, mission.id, PrepareRequest(expected_revision=mission.revision,
            alternative_id=plan.alternatives[0].id, step_id=note.id, connector_id="hubspot-live", mode="live",
            payload=NotePayload(body="Live dependent")))
        current = []
        for action in self.workflow.list_actions(self.seller.id, mission.id):
            submitted = self.workflow.submit(self.seller.id, action.id, SubmitRequest(
                expected_revision=action.revision, binding_hash=action.binding_hash))
            decision = self.workflow.review(self.reviewer.id, action.id, ReviewRequest(
                expected_revision=submitted.revision, binding_hash=submitted.binding_hash, decision="approved"))
            current.append((submitted, decision))
        action, decision = current[0]
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.execute(self.seller.id, action.id, ExecuteRequest(expected_revision=action.revision,
                decision_id=decision.id, idempotency_key="mixed"))
        self.assertEqual(failure.exception.code, "mission_execution_mode_mismatch")
        self.assertEqual(self.calls, [])

    def test_ambiguous_create_responses_are_never_retried_or_verified(self):
        self.configure()
        self.live()
        for response, expected in [(httpx.Response(403, json={"message": "test-only-token"}), "failed"),
                                   (httpx.Response(500), "result_unknown"), (httpx.Response(302), "result_unknown"),
                                   (httpx.Response(201, json={}), "result_unknown"),
                                   (httpx.Response(201, content=b"invalid"), "result_unknown"),
                                   (httpx.Response(201, content=b"x" * 65537), "result_unknown")]:
            calls = []

            def respond(request, response=response, calls=calls):
                calls.append(request)
                return response

            adapter = HubSpotWrites(self.settings, httpx.MockTransport(respond))
            result, resource_id, _ = adapter.create(self.action)
            self.assertEqual(result, expected)
            self.assertIsNone(resource_id)
            self.assertEqual(len(calls), 1)
