"""Isolated HTTPS session-origin contracts, without TLS or provider acceptance."""
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock

from fastapi.testclient import TestClient
from pydantic import ValidationError

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.identity import Identity
from vita_api.sample import SAMPLE_ORG

ORIGIN = "https://vitaai.example"
HEADERS = {"Origin": ORIGIN, "X-VitaAi-Request": "1"}
LOGIN = {"username": "viewer", "password": "test-password-long"}


class HostedOriginTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.options = dict(_env_file=None, auth_mode="session", session_cookie_secure=True,
                            web_origin=ORIGIN, database_url=f"sqlite:///{Path(self.temp.name) / 'http.sqlite'}")

    def app(self, **changes):
        provider = Mock()
        provider.discover.side_effect = AssertionError("Session checks must not call a provider")
        return create_app(Settings(**{**self.options, **changes}), provider=provider)

    def provision(self, app):
        return Identity(app.state.store.engine).create_user(
            LOGIN["username"], LOGIN["password"], SAMPLE_ORG, "viewer")

    def test_https_session_cookie_identity_restart_and_logout_without_integrations(self):
        app = self.app()
        with TestClient(app, base_url=ORIGIN) as client:
            actor = self.provision(app)
            self.assertEqual(client.get("/api/portfolio").status_code, 401)
            response = client.post("/api/auth/login", headers=HEADERS, json=LOGIN)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")
            for flag in ("HttpOnly", "Secure", "SameSite=strict", "Path=/"):
                self.assertIn(flag, response.headers["set-cookie"])
            token = client.cookies.get("vitaai_session")
            self.assertTrue(token)
            self.assertNotIn(token, response.text)
            self.assertEqual(response.json()["actor"]["id"], actor.id)
            self.assertEqual(response.json()["actor"]["role"], "viewer")
            before = client.get("/api/portfolio").json()
            self.assertEqual(before["organization_id"], SAMPLE_ORG)
            self.assertEqual(client.post("/api/providers/nebius/discover", headers=HEADERS).status_code, 403)
            self.assertEqual(client.post("/api/auth/login", headers=HEADERS,
                                         json={**LOGIN, "role": "admin"}).status_code, 422)
        with TestClient(self.app(), base_url=ORIGIN) as restarted:
            restarted.cookies.set("vitaai_session", token)
            self.assertEqual(restarted.get("/api/auth/session").json()["actor"]["id"], actor.id)
            self.assertEqual(restarted.get("/api/portfolio").json(), before)
            self.assertEqual(restarted.post("/api/auth/logout", headers=HEADERS).status_code, 200)
            self.assertIsNone(restarted.get("/api/auth/session").json()["actor"])
            restarted.cookies.set("vitaai_session", token)
            self.assertEqual(restarted.get("/api/portfolio").status_code, 401)

    def test_hosted_origin_does_not_bypass_header_origin_or_host_checks(self):
        app = self.app()
        with TestClient(app, base_url=ORIGIN) as client:
            self.provision(app)
            for headers in ({"Origin": ORIGIN}, {"Origin": ORIGIN, "X-VitaAi-Request": "0"}):
                self.assertEqual(client.post("/api/auth/login", headers=headers, json=LOGIN).status_code, 403)
            for origin in ("https://foreign.example", ORIGIN + ".evil.example", ORIGIN + "/", "null",
                           "http://vitaai.example", ORIGIN + ":443", "https://Vitaai.example"):
                with self.subTest(origin=origin):
                    response = client.post("/api/auth/login", headers={**HEADERS, "Origin": origin}, json=LOGIN)
                    self.assertEqual(response.status_code, 403, response.text)
            self.assertIsNone(client.get("/api/auth/session").json()["actor"])
            self.assertEqual(client.get("/api/auth/session", headers={"Host": "foreign.example"}).status_code, 400)
            self.assertEqual(client.post("/api/auth/login", headers=HEADERS, json=LOGIN).status_code, 200)

    def test_unconfigured_origin_preserves_local_session_boundary(self):
        app = self.app(web_origin="", session_cookie_secure=False)
        with TestClient(app, base_url="http://127.0.0.1:3000") as client:
            self.provision(app)
            self.assertEqual(client.post("/api/auth/login", headers=HEADERS, json=LOGIN).status_code, 403)
            self.assertEqual(client.get("/api/auth/session", headers={"Host": "vitaai.example"}).status_code, 400)
            # Local CLI clients may omit Origin, but still need the application header.
            self.assertEqual(client.post("/api/auth/login", headers={"X-VitaAi-Request": "1"}, json=LOGIN).status_code, 200)
            self.assertEqual(client.post("/api/auth/logout", headers={
                "Origin": "http://localhost:3000", "X-VitaAi-Request": "1"}).status_code, 200)

    def test_configuration_requires_exact_https_dns_origin_and_secure_sessions(self):
        for origin in ("http://vitaai.example", "https://localhost", "https://127.0.0.1", "https://[::1]",
                       ORIGIN + "/", ORIGIN + ":443", ORIGIN + ":3000", ORIGIN + "?", ORIGIN + "#",
                       ORIGIN + "/path", "https://user@vitaai.example", "https://Vitaai.example",
                       "https://vitaai.example.", " https://vitaai.example", ORIGIN + "\n",
                       "https://vitaai.exämple", "https://*.example", "https://-bad.example"):
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                Settings(**{**self.options, "web_origin": origin})
        for changes in ({"session_cookie_secure": False}, {"auth_mode": "sample"}):
            with self.subTest(changes=changes), self.assertRaises(ValidationError):
                Settings(**{**self.options, **changes})
        self.assertEqual(Settings(**self.options).web_origin, ORIGIN)
