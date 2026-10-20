"""Isolated durable refresh tests with explicit OAuth/Graph mocks."""
import json
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Event
from urllib.parse import parse_qs
from uuid import uuid4

import httpx
import test_microsoft as fixtures
from fastapi.testclient import TestClient
from sqlalchemy import select, update
from vita_api.app import create_app
from vita_api.governance import PolicyDenied
from vita_api.identity import users
from vita_api.microsoft import PREFIX, Microsoft, MicrosoftRefreshRequest, bindings
from vita_api.storage import Store


class MicrosoftRefreshTests(unittest.TestCase):
    setUp = fixtures.MicrosoftTests.setUp
    tearDown = fixtures.MicrosoftTests.tearDown
    prepare = fixtures.MicrosoftTests.prepare
    connect = fixtures.MicrosoftTests.connect
    live = fixtures.MicrosoftTests.live

    def configure(self, *, enabled=True):
        fixtures.MicrosoftTests.configure(self)
        self.settings = self.settings.model_copy(update={"microsoft_refresh_enabled": enabled})
        self.ms.settings = self.settings
        self.result["refresh_token"] = "synthetic-refresh"
        self.refresh_calls, self.on_refresh, self.refresh_response = 0, None, None

    def respond(self, request):
        if request.url.host != "login.microsoftonline.com":
            return fixtures.MicrosoftTests.respond(self, request)
        self.refresh_calls += 1
        self.assertEqual((request.method, request.url.path), ("POST", f"/{fixtures.TENANT}/oauth2/v2.0/token"))
        form = parse_qs(request.content.decode())
        self.assertEqual(form["grant_type"], ["refresh_token"])
        self.assertEqual(form["refresh_token"], ["synthetic-refresh"])
        self.assertNotIn("Mail.Send", form["scope"][0])
        with self.store.engine.connect() as connection:
            row = connection.execute(select(bindings).where(bindings.c.revoked.is_(False))).mappings().one()
            self.assertTrue(self.ms.unseal(row["encrypted_token"])["refresh_pending"])
        if self.on_refresh:
            self.on_refresh()
        return self.refresh_response if self.refresh_response is not None else httpx.Response(200, json={
            "access_token": "synthetic-renewed", "refresh_token": "synthetic-rotated", "token_type": "Bearer",
            "scope": "User.Read Mail.ReadWrite", "expires_in": 3600})

    def request(self):
        return MicrosoftRefreshRequest(binding_id=self.ms.status(self.seller.id, self.token).refresh_binding_id)

    def test_rotation_preserves_history_and_denies_old_write_binding(self):
        self.configure()
        self.connect()
        self.live()
        original = self.ms.status(self.seller.id, self.token)
        self.assertFalse(original.can_refresh)
        self.now += timedelta(minutes=58)
        self.assertTrue(self.ms.status(self.seller.id, self.token).can_refresh)
        request = self.request()
        result = self.ms.refresh(self.seller.id, self.token, request)
        self.assertTrue(result.connected)
        self.assertFalse(result.can_refresh)
        self.assertNotEqual(result.binding_id, original.binding_id)
        with self.store.engine.connect() as connection:
            old = connection.execute(select(bindings).where(bindings.c.id == original.binding_id)).mappings().one()
            new = connection.execute(select(bindings).where(bindings.c.id == result.binding_id)).mappings().one()
            self.assertEqual((old["revoked"], old["encrypted_token"]), (True, ""))
            self.assertNotIn("synthetic", new["encrypted_token"])
            self.assertEqual(self.ms.unseal(new["encrypted_token"])["refresh_token"], "synthetic-rotated")
        with self.assertRaises(PolicyDenied):
            self.ms.credential(self.action, write=True)
        self.saved = json.loads(self.action.provider_request)
        self.assertEqual(self.ms.readback(self.action, "message==")[0], "verified")
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, request)
        self.assertEqual(self.refresh_calls, 1)
        self.assertEqual(self.workflow.get_action(self.seller.id, self.action.id), self.action)

    def test_concurrent_reservation_survives_engine_reconstruction(self):
        self.configure()
        self.connect()
        self.now += timedelta(hours=1)
        request = self.request()
        entered, release = Event(), Event()

        def wait():
            entered.set()
            self.assertTrue(release.wait(10))

        self.on_refresh = wait
        recovered = Store(self.store.engine.url.render_as_string(hide_password=False))
        recovered.initialize()
        try:
            restarted = Microsoft(recovered, self.settings, httpx.MockTransport(self.respond), clock=lambda: self.now)
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(self.ms.refresh, self.seller.id, self.token, request)
                try:
                    self.assertTrue(entered.wait(10))
                    status = restarted.status(self.seller.id, self.token)
                    self.assertTrue(status.refresh_pending)
                    self.assertFalse(status.connected or status.can_refresh)
                    with self.assertRaises(PolicyDenied):
                        restarted.refresh(self.seller.id, self.token, request)
                finally:
                    release.set()
                self.assertTrue(pending.result().connected)
            self.assertEqual(self.refresh_calls, 1)
        finally:
            recovered.engine.dispose()

    def test_worker_loss_blocks_retry_until_explicit_reconnect(self):
        class WorkerExit(BaseException):
            pass

        self.configure()
        self.connect()
        self.now += timedelta(hours=1)
        request = self.request()

        def exit_worker():
            raise WorkerExit()

        self.on_refresh = exit_worker
        with self.assertRaises(WorkerExit):
            self.ms.refresh(self.seller.id, self.token, request)
        restarted = Microsoft(self.store, self.settings, httpx.MockTransport(self.respond), clock=lambda: self.now)
        self.assertTrue(restarted.status(self.seller.id, self.token).refresh_pending)
        with self.assertRaises(PolicyDenied):
            restarted.refresh(self.seller.id, self.token, request)
        self.assertEqual(self.refresh_calls, 1)
        self.connect()
        self.assertFalse(self.ms.status(self.seller.id, self.token).refresh_pending)

    def test_bad_responses_are_terminal_and_never_retried(self):
        self.configure()
        for response in [httpx.Response(400, json={"error_description": "synthetic-refresh"}),
                         httpx.Response(302, headers={"Location": "https://example.com/private"}),
                         httpx.Response(200, json={"access_token": "bad"}),
                         httpx.Response(200, content=b"["), httpx.Response(200, content=b"x" * 262145)]:
            with self.subTest(status=response.status_code, size=len(response.content)):
                self.connect()
                self.now += timedelta(hours=1)
                self.refresh_response = response
                request, before = self.request(), self.refresh_calls
                with self.assertRaises(PolicyDenied) as denied:
                    self.ms.refresh(self.seller.id, self.token, request)
                self.assertEqual(denied.exception.code, "microsoft_refresh_failed_reconnect_required")
                with self.assertRaises(PolicyDenied):
                    self.ms.refresh(self.seller.id, self.token, request)
                self.assertEqual(self.refresh_calls, before + 1)
                self.now -= timedelta(hours=1)

    def test_signout_reconnect_secret_change_or_logout_discards_response(self):
        self.configure()
        for change in [lambda: self.ms.signout(self.seller.id, self.token), self.connect,
                       lambda: setattr(self.ms, "settings", self.settings.model_copy(update={"microsoft_client_secret": "changed"})),
                       lambda: self.identity.logout(self.token)]:
            with self.subTest(change=change):
                self.ms.settings = self.settings
                _, self.token = self.identity.login("seller", "test-password-long", 8)
                self.connect()
                self.now += timedelta(hours=1)
                request = self.request()
                self.on_refresh = change
                with self.assertRaises(PolicyDenied):
                    self.ms.refresh(self.seller.id, self.token, request)
                with self.store.engine.connect() as connection:
                    row = connection.execute(select(bindings).where(bindings.c.id == str(request.binding_id))).mappings().one()
                    self.assertEqual((row["revoked"], row["encrypted_token"]), (True, ""))
                self.now -= timedelta(hours=1)
                self.on_refresh = None

    def test_default_off_early_wrong_binding_and_demoted_actor_deny_without_call(self):
        self.configure(enabled=False)
        self.connect()
        row = self.ms.status(self.seller.id, self.token)
        self.assertIsNone(row.refresh_binding_id)
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, MicrosoftRefreshRequest(binding_id=row.binding_id))
        self.configure()
        self.connect()
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, self.request())
        self.now += timedelta(hours=1)
        request = self.request()
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, MicrosoftRefreshRequest(binding_id=uuid4()))
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.seller.id).values(role="viewer"))
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, request)
        self.assertEqual(self.refresh_calls, 0)

    def test_timeout_or_mailbox_mismatch_revokes_without_repeating_request(self):
        self.configure()
        self.connect()
        self.now += timedelta(hours=1)

        def timeout():
            raise httpx.ReadTimeout("synthetic-refresh")

        self.on_refresh = timeout
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, self.request())
        self.assertEqual(self.refresh_calls, 1)
        self.on_refresh = None
        self.connect()
        self.now += timedelta(hours=1)
        original_get = self.ms.get
        self.ms.get = lambda *_args, **_kwargs: {"id": str(uuid4())}
        try:
            with self.assertRaises(PolicyDenied):
                self.ms.refresh(self.seller.id, self.token, self.request())
        finally:
            self.ms.get = original_get
        self.assertEqual(self.refresh_calls, 2)
        self.assertFalse(self.ms.status(self.seller.id, self.token).connected)

    def test_membership_loss_after_mailbox_read_cannot_publish_credentials(self):
        self.configure()
        self.connect()
        self.now += timedelta(hours=1)
        request = self.request()

        def demote():
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.seller.id).values(role="viewer"))

        self.on_get = demote
        with self.assertRaises(PolicyDenied):
            self.ms.refresh(self.seller.id, self.token, request)
        with self.store.engine.connect() as connection:
            row = connection.execute(select(bindings).where(bindings.c.id == str(request.binding_id))).mappings().one()
            self.assertEqual((row["revoked"], row["encrypted_token"]), (True, ""))

    def test_http_auth_csrf_body_and_status_no_token_call(self):
        self.configure()
        settings = self.settings.model_copy(update={"database_url": self.store.engine.url.render_as_string(hide_password=False)})
        app = create_app(settings, microsoft_transport=httpx.MockTransport(self.respond), microsoft_client_factory=self.factory)
        headers = {"X-VitaAi-Request": "1"}
        with TestClient(app) as client:
            self.assertEqual(client.post(PREFIX + "/refresh", headers=headers, json={"binding_id": str(uuid4())}).status_code, 401)
            client.post("/api/auth/login", headers=headers, json={"username": "seller", "password": "test-password-long"})
            client.post(PREFIX + "/connect", headers=headers)
            self.assertEqual(client.get(PREFIX + "/callback", params={"state": self.flow["state"], "code": "synthetic"}, follow_redirects=False).status_code, 303)
            with self.store.engine.begin() as connection:
                connection.execute(update(bindings).values(expires_at=0))
            status = client.get(PREFIX)
            self.assertTrue(status.json()["can_refresh"])
            self.assertNotIn("synthetic-refresh", status.text)
            body = {"binding_id": status.json()["refresh_binding_id"]}
            self.assertEqual(client.post(PREFIX + "/refresh", json=body).status_code, 403)
            self.assertEqual(client.post(PREFIX + "/refresh", headers=headers, json={**body, "actor_id": "other"}).status_code, 422)
            self.assertEqual(self.refresh_calls, 0)
            result = client.post(PREFIX + "/refresh", headers=headers, json=body)
            self.assertEqual(result.status_code, 200, result.text)
            self.assertTrue(result.json()["connected"])
            self.assertEqual(self.refresh_calls, 1)
