"""Real isolated auth/database/workflow with explicit OAuth and Graph mocks."""
import copy
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from uuid import uuid4

import httpx
import test_stage2 as fixtures
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from sqlalchemy import select, update

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.governance import PolicyDenied
from vita_api.identity import users
from vita_api.microsoft import COOKIE, PREFIX, Microsoft, bindings, flows
from vita_api.sample import SAMPLE_ORG
from vita_api.storage import Store
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import (
    ExecuteRequest,
    OutlookPayload,
    PrepareRequest,
    ReviewRequest,
    SubmitRequest,
)
from vita_api.workflow_storage import claims, resources

TENANT = "11111111-1111-4111-8111-111111111111"
MAILBOX = "22222222-2222-4222-8222-222222222222"


class MicrosoftTests(unittest.TestCase):
    setUp = fixtures.Stage2Tests.setUp
    tearDown = fixtures.Stage2Tests.tearDown
    prepare = fixtures.Stage2Tests.prepare

    def configure(self):
        self.calls, self.saved = [], None
        self.post_error = self.read_error = self.on_get = self.on_post = self.on_start = None
        self.auth_calls = 0
        _, self.token = self.identity.login("seller", "test-password-long", 8)
        _, self.review_token = self.identity.login("reviewer", "test-password-long", 8)
        self.settings = Settings(_env_file=None, auth_mode="session", microsoft_enabled=True,
            microsoft_write_enabled=True, microsoft_organization_id=SAMPLE_ORG, microsoft_tenant_id=TENANT,
            microsoft_client_id="33333333-3333-4333-8333-333333333333", microsoft_client_secret="test-only-secret",
            microsoft_token_key=Fernet.generate_key().decode())
        self.flow = {"state": uuid4().hex, "auth_uri": "https://login.microsoftonline.com/authorize", "code_verifier": "private-verifier"}
        self.result = {"access_token": "test-only-access", "token_type": "Bearer", "expires_in": 3600,
            "scope": "User.Read Mail.ReadWrite", "id_token_claims": {"tid": TENANT, "oid": MAILBOX}}
        owner = self

        class OAuth:
            def initiate_auth_code_flow(self, scopes, **kwargs):
                owner.assertNotIn("Mail.Send", " ".join(scopes))
                if owner.on_start:
                    owner.on_start()
                return copy.deepcopy(owner.flow)

            def acquire_token_by_auth_code_flow(self, flow, response, **kwargs):
                owner.auth_calls += 1
                owner.assertEqual(flow["state"], response["state"])
                return copy.deepcopy(owner.result)

        self.factory = lambda *args, **kwargs: OAuth()
        self.ms = Microsoft(self.store, self.settings, httpx.MockTransport(self.respond),
                            clock=lambda: self.now, client_factory=self.factory)
        self.workflow = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                                 session_token=self.token, session_required=True)

    def connect(self):
        _, cookie = self.ms.begin(self.seller.id, self.token)
        self.ms.complete(cookie, {"state": self.flow["state"], "code": "test-code"})
        return cookie

    def respond(self, request):
        self.calls.append(request)
        self.assertEqual(request.url.host, "graph.microsoft.com")
        self.assertNotIn("send", request.url.path.lower())
        if request.url.path == "/v1.0/me":
            if self.on_get:
                callback, self.on_get = self.on_get, None
                callback()
            return httpx.Response(200, json={"id": MAILBOX})
        self.assertIn('IdType="ImmutableId"', request.headers["prefer"])
        if request.method == "POST":
            self.assertEqual(request.url.path, "/v1.0/me/messages")
            with self.store.engine.connect() as connection:
                self.assertEqual(connection.execute(select(claims.c.payload)).scalar_one()["status"], "dispatching")
            self.saved = json.loads(request.content)
            if self.on_post:
                self.on_post()
            if self.post_error:
                raise self.post_error
            return httpx.Response(201, json={"id": "message=="})
        self.assertEqual(request.method, "GET")
        self.assertEqual(request.url.path, "/v1.0/me/messages/message==")
        if self.read_error:
            return self.read_error
        return httpx.Response(200, json={**self.saved, "id": "message==", "isDraft": True,
                                        "ccRecipients": [], "bccRecipients": []})

    def live(self):
        self.prepare(OutlookPayload(to=("one@example.com", "two@example.com"), subject=" Exact Ω ", body_text="Body\n Ω "),
                     "account-outlook-draft-1", "simulation-microsoft")
        self.action = self.workflow.prepare(self.seller.id, self.mission.id, PrepareRequest(
            expected_revision=self.mission.revision, alternative_id=self.plan.selected_alternative_id,
            connector_id="microsoft-live", mode="live", payload=self.action.payload))
        self.action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash))
        reviewer = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                            session_token=self.review_token, session_required=True)
        decision = reviewer.review(self.reviewer.id, self.action.id, ReviewRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash, decision="approved"))
        return ExecuteRequest(expected_revision=self.action.revision, decision_id=decision.id, idempotency_key="draft-key")

    def test_durable_encrypted_binding_state_replay_and_logout(self):
        self.configure()
        cookie = self.connect()
        with self.store.engine.connect() as connection:
            row = connection.execute(select(bindings)).mappings().one()
            self.assertNotIn("test-only-access", row["encrypted_token"])
            self.assertEqual(connection.execute(select(flows.c.id)).all(), [])
        recovered_store = Store(self.store.engine.url.render_as_string(hide_password=False))
        try:
            recovered_store.initialize()
            restarted = Microsoft(recovered_store, self.settings, clock=lambda: self.now)
            self.assertTrue(restarted.status(self.seller.id, self.token).connected)
        finally:
            recovered_store.engine.dispose()
        with self.assertRaises(PolicyDenied):
            self.ms.complete(cookie, {"state": self.flow["state"], "code": "test-code"})
        self.assertEqual(self.auth_calls, 1)
        self.identity.logout(self.token)
        with self.assertRaises(PolicyDenied):
            self.ms.status(self.seller.id, self.token)

    def test_mission_readiness_uses_original_maker_and_reconnect_only_allows_readback(self):
        self.configure()
        self.connect()
        self.live()
        reviewer = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                            session_token=self.review_token, session_required=True)
        before = len(self.calls)
        ready = reviewer.microsoft_readiness(self.reviewer.id, self.mission.id)
        self.assertFalse(ready.can_prepare)  # Reviewer has no mailbox connection of their own.
        self.assertIsNone(ready.destination)
        self.assertTrue(ready.actions[0].can_write)
        self.assertTrue(ready.actions[0].can_reconcile)
        self.assertEqual(ready.actions[0].binding_hash, self.action.binding_hash)
        self.assertEqual(len(self.calls), before)
        self.connect()  # Same mailbox, new binding ID: never revive the old exact write.
        ready = reviewer.microsoft_readiness(self.reviewer.id, self.mission.id)
        self.assertFalse(ready.actions[0].can_write)
        self.assertTrue(ready.actions[0].can_reconcile)
        self.ms.settings = self.settings.model_copy(update={"microsoft_write_enabled": False})
        self.assertTrue(reviewer.microsoft_readiness(self.reviewer.id, self.mission.id).actions[0].can_reconcile)
        self.ms.signout(self.seller.id, self.token)
        self.assertFalse(reviewer.microsoft_readiness(self.reviewer.id, self.mission.id).actions[0].can_reconcile)

    def test_mission_readiness_denies_foreign_scope_expired_session_and_demoted_maker(self):
        self.configure()
        self.connect()
        self.live()
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.seller.id).values(role="viewer"))
        self.assertFalse(self.ms.status(self.seller.id, self.token).connected)
        ready = self.workflow.microsoft_readiness(self.seller.id, self.mission.id)
        self.assertFalse(ready.can_prepare)
        self.assertFalse(ready.actions[0].can_write)
        self.assertFalse(ready.actions[0].can_reconcile)
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.reviewer.id).values(organization_id="foreign"))
        foreign = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                           session_token=self.review_token, session_required=True)
        with self.assertRaises(PolicyDenied) as denied:
            foreign.microsoft_readiness(self.reviewer.id, self.mission.id)
        self.assertEqual(denied.exception.status_code, 404)
        self.identity.logout(self.token)
        with self.assertRaises(PolicyDenied) as denied:
            self.workflow.microsoft_readiness(self.seller.id, self.mission.id)
        self.assertEqual(denied.exception.status_code, 401)

    def test_concurrent_execution_has_one_durable_claim_and_one_post(self):
        self.configure()
        self.connect()
        request = self.live()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.workflow.execute(self.seller.id, self.action.id, request), range(2)))
        self.assertEqual(len({r.id for r in results}), 1)
        self.assertIn("succeeded", [r.status for r in results])
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 1)
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(claims.c.id)).all()), 1)

    def test_callback_wrong_state_expiry_scope_tenant_and_loss_of_authority(self):
        self.configure()
        _, cookie = self.ms.begin(self.seller.id, self.token)
        with self.assertRaises(PolicyDenied):
            self.ms.complete(cookie, {"state": "wrong", "code": "test-code"})
        self.assertEqual(self.auth_calls, 0)
        for changes in [{"scope": "User.Read"}, {"id_token_claims": {"tid": str(uuid4()), "oid": MAILBOX}},
                        {"expires_in": 0}]:
            with self.subTest(changes=changes):
                original = self.result
                self.result = {**original, **changes}
                _, cookie = self.ms.begin(self.seller.id, self.token)
                with self.assertRaises(PolicyDenied):
                    self.ms.complete(cookie, {"state": self.flow["state"], "code": "test-code"})
                self.result = original
        _, cookie = self.ms.begin(self.seller.id, self.token)
        self.now += timedelta(minutes=11)
        with self.assertRaises(PolicyDenied):
            self.ms.complete(cookie, {"state": self.flow["state"], "code": "test-code"})
        self.now -= timedelta(minutes=11)
        _, cookie = self.ms.begin(self.seller.id, self.token)
        self.on_get = lambda: self.identity.logout(self.token)
        with self.assertRaises(PolicyDenied):
            self.ms.complete(cookie, {"state": self.flow["state"], "code": "test-code"})
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(bindings.c.id)).all(), [])

    def test_exact_approved_draft_claim_readback_replay_and_other_executor(self):
        self.configure()
        self.connect()
        request = self.live()
        reviewer = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                            session_token=self.review_token, session_required=True)
        execution = reviewer.execute(self.reviewer.id, self.action.id, request)
        receipt = reviewer.get_receipt(self.reviewer.id, execution.receipt_id)
        self.assertEqual((execution.status, receipt.verification, receipt.mode), ("succeeded", "verified", "live"))
        self.assertEqual(self.saved, json.loads(self.action.provider_request))
        self.assertEqual(self.saved["subject"], " Exact Ω ")
        self.assertEqual(reviewer.execute(self.reviewer.id, self.action.id, request), execution)
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 1)
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(resources.c.id)).all(), [])

    def test_reconnect_and_logout_invalidate_review_without_replacing_history(self):
        self.configure()
        self.connect()
        request = self.live()
        old = self.action
        self.connect()
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, old.id, request)
        self.assertEqual(self.workflow.get_action(self.seller.id, old.id), old)
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 0)

    def test_unknown_retains_id_and_read_only_reconciliation_with_writes_disabled(self):
        self.configure()
        self.connect()
        request = self.live()
        self.read_error = httpx.Response(503, json={"error": "test-only-access"})
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        receipt = self.workflow.get_receipt(self.seller.id, execution.receipt_id)
        self.assertEqual((execution.status, receipt.provider_resource_id), ("result_unknown", "message=="))
        self.assertNotIn("test-only-access", receipt.model_dump_json())
        self.read_error = None
        self.ms.settings = self.settings.model_copy(update={"microsoft_write_enabled": False})
        reviewer = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                            session_token=self.review_token, session_required=True)
        recovered = reviewer.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual(recovered.status, "succeeded")
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 1)
        self.assertEqual(reviewer.get_receipt(self.reviewer.id, receipt.id), receipt)

    def test_ambiguous_post_never_retries_or_guesses_id(self):
        self.configure()
        self.connect()
        request = self.live()
        self.post_error = httpx.ReadTimeout("test-only-access")
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(execution.status, "result_unknown")
        self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, request), execution)
        with self.assertRaises(PolicyDenied):
            self.workflow.retry(self.seller.id, execution.id, request.model_copy(update={"expected_revision": execution.revision}))
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 1)

    def test_readback_requires_unsent_exact_body_subject_and_recipient_order(self):
        self.configure()
        self.connect()
        self.live()
        self.saved = json.loads(self.action.provider_request)
        expected = {**self.saved, "id": "message==", "isDraft": True, "ccRecipients": [], "bccRecipients": []}
        for changed in [{"isDraft": False}, {"subject": "changed"}, {"body": {"contentType": "HTML", "content": "changed"}},
                        {"toRecipients": list(reversed(self.saved["toRecipients"]))}, {"ccRecipients": [{}]}, {"id": "wrong"}]:
            self.read_error = httpx.Response(200, json={**expected, **changed})
            self.assertEqual(self.ms.readback(self.action, "message==")[0], "mismatch")

    def test_signout_during_preflight_denies_post(self):
        self.configure()
        self.connect()
        request = self.live()
        self.on_get = lambda: self.ms.signout(self.seller.id, self.token)
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 0)

    def test_user_disable_after_post_persists_retained_unknown_result(self):
        self.configure()
        self.connect()
        request = self.live()

        def disable():
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.seller.id).values(enabled=False))

        self.on_post = disable
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        with self.store.engine.connect() as connection:
            saved = connection.execute(select(claims.c.payload)).scalar_one()
        self.assertEqual((execution.status, saved["status"]), ("result_unknown", "result_unknown"))
        receipt = Workflow(self.store).get_receipt(self.reviewer.id, execution.receipt_id)
        self.assertEqual(receipt.provider_resource_id, "message==")

    def test_signout_cancels_an_inflight_connection_start(self):
        self.configure()
        self.on_start = lambda: self.ms.signout(self.seller.id, self.token)
        with self.assertRaises(PolicyDenied):
            self.ms.begin(self.seller.id, self.token)
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(flows.c.id)).all(), [])

    def test_same_mailbox_reauthorization_only_allows_retained_id_readback(self):
        self.configure()
        self.connect()
        request = self.live()
        self.read_error = httpx.Response(503, json={})
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        self.ms.signout(self.seller.id, self.token)
        self.connect()
        self.read_error = None
        self.assertEqual(self.ms.readback(self.action, "message==")[0], "verified")
        reviewer = Workflow(self.store, clock=lambda: self.now, microsoft=self.ms,
                            session_token=self.review_token, session_required=True)
        self.assertEqual(reviewer.reconcile(self.reviewer.id, execution.id, execution.revision).status, "succeeded")
        self.assertEqual(sum(r.method == "POST" for r in self.calls), 1)

    def test_real_msal_generates_pkce_nonce_and_only_bounded_scopes(self):
        import msal

        class Discovery:
            def get(self, url, **kwargs):
                self.url = url
                return httpx.Response(200, json={
                    "authorization_endpoint": f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/authorize",
                    "token_endpoint": f"https://login.microsoftonline.com/{TENANT}/oauth2/v2.0/token",
                    "issuer": f"https://login.microsoftonline.com/{TENANT}/v2.0",
                    "jwks_uri": "https://login.microsoftonline.com/common/discovery/v2.0/keys",
                })

        discovery = Discovery()
        client = msal.ConfidentialClientApplication("33333333-3333-4333-8333-333333333333",
            client_credential="test-secret", authority=f"https://login.microsoftonline.com/{TENANT}",
            instance_discovery=False, http_client=discovery, exclude_scopes=["offline_access"])
        flow = client.initiate_auth_code_flow(["User.Read", "Mail.ReadWrite"], redirect_uri="http://localhost/callback")
        from urllib.parse import parse_qs, urlsplit
        query = parse_qs(urlsplit(flow["auth_uri"]).query)
        self.assertEqual(query["code_challenge_method"], ["S256"])
        self.assertTrue(flow["code_verifier"])
        self.assertTrue(flow["nonce"])
        self.assertNotIn("offline_access", query["scope"][0])
        self.assertNotIn("Mail.Send", query["scope"][0])

    def test_http_auth_csrf_cookie_callback_and_status_no_provider_reads(self):
        self.configure()
        settings = self.settings.model_copy(update={"database_url": self.store.engine.url.render_as_string(hide_password=False)})
        app = create_app(settings, microsoft_transport=httpx.MockTransport(self.respond), microsoft_client_factory=self.factory)
        headers = {"X-VitaAi-Request": "1"}
        with TestClient(app) as client:
            self.assertEqual(client.get(PREFIX).status_code, 401)
            client.post("/api/auth/login", headers=headers, json={"username": "seller", "password": "test-password-long"})
            self.assertEqual(client.post(PREFIX + "/connect").status_code, 403)
            wrong_host = client.post(PREFIX + "/connect", headers={**headers, "Origin": "http://localhost:3000"})
            self.assertEqual(wrong_host.status_code, 409)
            start = client.post(PREFIX + "/connect", headers=headers)
            self.assertEqual(start.status_code, 200)
            self.assertIn("HttpOnly", start.headers["set-cookie"])
            self.assertIn("SameSite=lax", start.headers["set-cookie"])
            callback = client.get(PREFIX + "/callback", params={"state": self.flow["state"], "code": "test-code"}, follow_redirects=False)
            self.assertEqual(callback.status_code, 303)
            self.assertEqual(callback.headers["location"], "http://127.0.0.1:3000/missions")
            self.assertEqual(callback.headers["referrer-policy"], "no-referrer")
            self.assertEqual(callback.headers["cache-control"], "no-store")
            before = len(self.calls)
            response = client.get(PREFIX)
            self.assertTrue(response.json()["connected"])
            self.assertEqual(response.headers["cache-control"], "no-store")
            self.assertNotIn("test-only-access", response.text)
            self.assertEqual(len(self.calls), before)
            self.assertEqual(client.post(PREFIX + "/signout", headers=headers).status_code, 200)
            self.assertFalse(client.get(PREFIX).json()["connected"])
            self.assertEqual(client.cookies.get(COOKIE), None)

    def test_http_fresh_review_is_required_for_exact_live_unsent_draft(self):
        self.http_reviewed_draft()

    def test_http_unknown_draft_reconciliation_outcome_survives_reconstruction(self):
        self.http_reviewed_draft(recover_unknown=True)

    def http_reviewed_draft(self, *, recover_unknown=False):
        self.configure()
        settings = self.settings.model_copy(update={"database_url": self.store.engine.url.render_as_string(hide_password=False)})
        app = create_app(settings, microsoft_transport=httpx.MockTransport(self.respond), microsoft_client_factory=self.factory)
        headers = {"X-VitaAi-Request": "1"}
        with TestClient(app) as client:
            client.post("/api/auth/login", headers=headers, json={"username": "seller", "password": "test-password-long"})
            client.post(PREFIX + "/connect", headers=headers)
            self.assertEqual(client.get(PREFIX + "/callback", params={"state": self.flow["state"], "code": "test-code"}, follow_redirects=False).status_code, 303)
            view = next(v for v in client.get("/api/portfolio").json()["accounts"] if v["account"]["id"] == self.account.id)
            before_account = client.get(f'/api/accounts/{self.account.id}').json()

            def post(path, body):
                response = client.post(path, headers=headers, json=body)
                self.assertEqual(response.status_code, 200, response.text)
                return response.json()

            plan = post("/api/plans", {"account_id": self.account.id, "expected_revision": 1,
                "expected_snapshot_hash": view["assessment"]["snapshot_hash"], "intent": "risk", "action_kind": "outlook_draft_create"})
            mission = post("/api/missions", {"plan_id": plan["id"], "expected_revision": 1, "template": "account-outlook-draft-1"})
            action = post(f'/api/missions/{mission["id"]}/prepare', {"expected_revision": mission["revision"],
                "alternative_id": plan["selected_alternative_id"], "connector_id": "microsoft-live", "mode": "live",
                "payload": {"kind": "outlook_draft_create", "to": ["buyer@example.com"], "subject": " Exact Ω ", "body_text": "Body\n Ω "}})
            self.assertEqual(action["destination"]["mailbox_id"], MAILBOX)
            action = post(f'/api/actions/{action["id"]}/submit', {"expected_revision": action["revision"], "binding_hash": action["binding_hash"]})
            before = len(self.calls)
            readiness = client.get(f'{PREFIX}/missions/{mission["id"]}/execution-readiness')
            self.assertEqual(readiness.status_code, 200)
            self.assertTrue(readiness.json()["can_prepare"])
            self.assertEqual(len(self.calls), before)
            denied = client.post(f'/api/actions/{action["id"]}/execute', headers=headers,
                json={"expected_revision": action["revision"], "decision_id": str(uuid4()), "idempotency_key": "before-review"})
            self.assertNotEqual(denied.status_code, 200)
            self.assertEqual(sum(r.method == "POST" for r in self.calls), 0)
            client.cookies.set("vitaai_session", self.review_token, domain="testserver.local", path="/")
            ready = client.get(f'{PREFIX}/missions/{mission["id"]}/execution-readiness').json()
            self.assertFalse(ready["can_prepare"])
            self.assertTrue(ready["actions"][0]["can_write"])
            decision = post(f'/api/actions/{action["id"]}/review', {"expected_revision": action["revision"],
                "binding_hash": action["binding_hash"], "decision": "approved"})
            execute = {"expected_revision": action["revision"],
                "decision_id": decision["id"], "idempotency_key": "http-draft"}
            if recover_unknown:
                self.read_error = httpx.Response(503, json={"error": "synthetic-readback-unavailable"})
            execution = post(f'/api/actions/{action["id"]}/execute', execute)
            if recover_unknown:
                self.assertEqual(execution["status"], "result_unknown")
                unknown = client.get(f'/api/receipts/{execution["receipt_id"]}').json()
                self.assertEqual((unknown["result"], unknown["verification"], unknown["provider_resource_id"]),
                                 ("result_unknown", "unavailable", "message=="))
                mission = client.get(f'/api/missions/{mission["id"]}').json()
                outcome = {"expected_revision": mission["revision"], "receipt_id": unknown["id"],
                    "kind": "follow_up_required", "basis": "manual_report",
                    "evidence_ids": [item["id"] for item in before_account["evidence"]],
                    "note": "Synthetic local report; no customer contact or business effect claimed"}
                denied = client.post(f'/api/missions/{mission["id"]}/outcomes', headers=headers, json=outcome)
                self.assertEqual(denied.status_code, 409, denied.text)
                self.assertEqual(denied.json()["detail"]["code"], "outcome_not_available")
                self.assertEqual(client.get(f'/api/missions/{mission["id"]}/outcomes').json(), [])
                self.assertEqual(post(f'/api/actions/{action["id"]}/execute', execute), execution)
                self.read_error = None
                call_count = len(self.calls)
                execution = post(f'/api/executions/{execution["id"]}/reconcile',
                                 {"expected_revision": execution["revision"]})
                self.assertTrue(self.calls[call_count:])
                self.assertTrue(all(request.method == "GET" for request in self.calls[call_count:]))
                self.assertEqual(client.get(f'/api/receipts/{unknown["id"]}').json(), unknown)
                self.assertNotEqual(execution["receipt_id"], unknown["id"])
            self.assertEqual(execution["status"], "succeeded")
            receipt = client.get(f'/api/receipts/{execution["receipt_id"]}').json()
            self.assertEqual((receipt["verification"], receipt["mode"]), ("verified", "live"))
            self.assertEqual(self.saved, json.loads(action["provider_request"]))
            if not recover_unknown:
                return
            self.assertEqual(post(f'/api/actions/{action["id"]}/execute', execute), execution)
            self.assertEqual(sum(request.method == "POST" for request in self.calls), 1)
            mission = client.get(f'/api/missions/{mission["id"]}').json()
            report = post(f'/api/missions/{mission["id"]}/outcomes',
                          {**outcome, "expected_revision": mission["revision"], "receipt_id": receipt["id"]})
            self.assertEqual((report["report"]["basis"], report["report"]["kind"]),
                             ("manual_report", "follow_up_required"))
            self.assertEqual(client.get(f'/api/accounts/{self.account.id}').json(), before_account)

        def deny_network(*args, **kwargs):
            self.fail("Reconstructed saved-record reads must not contact Microsoft")

        restarted_app = create_app(settings, microsoft_transport=httpx.MockTransport(deny_network),
                                   microsoft_client_factory=deny_network)
        with TestClient(restarted_app) as restarted:
            restarted.cookies.set("vitaai_session", self.review_token)
            for retained in (unknown, receipt):
                response = restarted.get(f'/api/receipts/{retained["id"]}')
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json(), retained)
            self.assertEqual(restarted.get(f'/api/executions/{execution["id"]}').json(), execution)
            self.assertEqual(restarted.get(f'/api/actions/{action["id"]}').json(), action)
            self.assertEqual(restarted.get(f'/api/missions/{mission["id"]}/outcomes').json(), [report])
            self.assertEqual(restarted.get(f'/api/missions/{mission["id"]}').json()["status"], "completed")
            self.assertEqual(restarted.get(f'/api/accounts/{self.account.id}').json(), before_account)

    def test_disabled_configuration_scope_role_and_session_expiry(self):
        self.configure()
        self.ms.settings = self.settings.model_copy(update={"microsoft_enabled": False})
        with self.assertRaises(PolicyDenied):
            self.ms.begin(self.seller.id, self.token)
        self.assertEqual(self.calls, [])
        self.ms.settings = self.settings
        self.connect()
        self.now += timedelta(hours=1)
        self.assertFalse(self.ms.status(self.seller.id, self.token).connected)
        self.now -= timedelta(hours=1)
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.seller.id).values(role="viewer"))
        with self.assertRaises(PolicyDenied):
            self.ms.begin(self.seller.id, self.token)
        self.ms.signout(self.seller.id, self.token)
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.seller.id).values(role="seller"))
        self.connect()
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.seller.id).values(organization_id="foreign"))
        self.assertFalse(self.ms.status(self.seller.id, self.token).connected)
