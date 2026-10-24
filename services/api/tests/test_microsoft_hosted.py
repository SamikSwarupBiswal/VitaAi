"""Synthetic HTTPS form-post callback contracts; no live consent, Graph or TLS."""
import unittest

import httpx
import test_microsoft as fixtures
from fastapi.testclient import TestClient
from pydantic import ValidationError
from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.microsoft import COOKIE, PREFIX, decode_callback


class HostedTests(unittest.TestCase):
    setUp = fixtures.MicrosoftTests.setUp
    configure = fixtures.MicrosoftTests.configure
    respond = fixtures.MicrosoftTests.respond

    def tearDown(self):
        self.doCleanups()
        fixtures.MicrosoftTests.tearDown(self)

    def client(self):
        self.configure()
        options = self.settings.model_dump()
        options.update(database_url=self.store.engine.url.render_as_string(hide_password=False),
            microsoft_redirect_uri="https://vitaai.example/api/integrations/microsoft/callback",
            microsoft_web_origin="https://vitaai.example", session_cookie_secure=True)
        factory = self.factory
        self.flow_options = []

        def capture(*args, **kwargs):
            client = factory(*args, **kwargs)
            begin = client.initiate_auth_code_flow

            def initiate(scopes, **options):
                self.flow_options.append(options)
                return begin(scopes, **options)

            client.initiate_auth_code_flow = initiate
            return client

        app = create_app(Settings.model_validate(options), microsoft_transport=httpx.MockTransport(self.respond),
            microsoft_client_factory=capture)
        client = TestClient(app, base_url="https://vitaai.example").__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        response = client.post("/api/auth/login", headers={"X-VitaAi-Request": "1"},
            json={"username": "seller", "password": "test-password-long"})
        self.assertEqual(response.status_code, 200, response.text)
        return client

    def test_encrypted_cookie_form_post_original_session_and_single_use_callback(self):
        client = self.client()
        start = client.post(PREFIX + "/connect", headers={"X-VitaAi-Request": "1", "Origin": "https://vitaai.example"})
        self.assertEqual(start.status_code, 200, start.text)
        self.assertEqual(self.flow_options[0]["response_mode"], "form_post")
        for flag in ("Secure", "HttpOnly", "SameSite=none", "Path=" + PREFIX + "/callback"):
            self.assertIn(flag, start.headers["set-cookie"])
        self.assertNotIn(self.flow["state"], start.headers["set-cookie"])
        self.assertNotIn("private-verifier", start.headers["set-cookie"])
        client.cookies.delete("vitaai_session")
        response = client.post(PREFIX + "/callback", data={"state": self.flow["state"], "code": "synthetic-code"},
            headers={"Origin": "https://login.microsoftonline.com"}, follow_redirects=False)
        self.assertEqual(response.status_code, 303, response.text)
        self.assertEqual(response.headers["location"], "https://vitaai.example/missions")
        self.assertEqual((response.headers["cache-control"], response.headers["referrer-policy"]), ("no-store", "no-referrer"))
        self.assertEqual(self.auth_calls, 1)
        self.assertEqual(client.post(PREFIX + "/callback", data={"state": self.flow["state"], "code": "synthetic-code"}).status_code, 409)
        self.assertEqual(self.auth_calls, 1)

    def test_revoked_original_session_denies_retained_flow(self):
        client = self.client()
        self.assertEqual(client.post(PREFIX + "/connect", headers={"X-VitaAi-Request": "1", "Origin": "https://vitaai.example"}).status_code, 200)
        self.assertIsNotNone(client.cookies.get(COOKIE))
        self.identity.logout(client.cookies.get("vitaai_session"))
        response = client.post(PREFIX + "/callback", data={"state": self.flow["state"], "code": "synthetic-code"})
        self.assertNotIn(response.status_code, (200, 303))
        self.assertEqual((self.auth_calls, self.calls), (0, []))

    def test_ambiguous_malformed_oversized_callbacks_have_privacy_headers(self):
        client = self.client()
        fields = "state=" + "a" * 32
        for body in (fields + "&state=" + "a" * 32 + "&code=private-code", fields + "&code=x&error=denied",
                     fields + "&code=%GG", fields + "&code=%FF", fields + "&code=%00", fields + "&code=" + "x" * 16384):
            response = client.post(PREFIX + "/callback", content=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"})
            self.assertEqual(response.status_code, 400)
            self.assertEqual((response.headers["cache-control"], response.headers["referrer-policy"]), ("no-store", "no-referrer"))
            self.assertNotIn("private-code", response.text)
        self.assertEqual(client.get(PREFIX + "/callback?" + fields + "&code=private-code").status_code, 400)
        self.assertEqual((self.auth_calls, self.calls), (0, []))
        for raw in (b"", b"state=short&code=x", b"state=" + b"a" * 32 + b"&code=x&co%64e=y"):
            with self.assertRaises(ValueError):
                decode_callback(raw)

    def test_exact_same_https_host_and_secure_session_configuration(self):
        base = {"microsoft_redirect_uri": "https://vitaai.example/api/integrations/microsoft/callback",
            "microsoft_web_origin": "https://vitaai.example", "session_cookie_secure": True}
        for changes in ({"session_cookie_secure": False}, {"microsoft_web_origin": "https://other.example"},
                        {"microsoft_redirect_uri": "http://vitaai.example/api/integrations/microsoft/callback"},
                        {"microsoft_redirect_uri": "https://vitaai.example/api/integrations/microsoft/callback?code=x"}):
            with self.assertRaises(ValidationError):
                Settings(_env_file=None, **{**base, **changes})
