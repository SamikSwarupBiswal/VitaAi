"""Signed delegated JWTs, scoped platform reads and explicit mapping revocation."""
import json
import unittest
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import httpx
import jwt
import test_memory as fixtures
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.governance import PolicyDenied
from vita_api.identity import users
from vita_api.platform_interfaces import (
    EntraVerifier,
    IdentityBinding,
    PlatformInterfaces,
    PlatformPreparation,
    PlatformSettings,
    Principal,
    TeamsActivity,
)
from vita_api.sample import sample_records
from vita_api.storage import accounts, evidence


class PlatformTests(unittest.TestCase):
    setUp = fixtures.MemoryTests.setUp
    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)
    assert_denied = fixtures.MemoryTests.assert_denied

    def config(self):
        return PlatformSettings(enabled=True, tenant_id=uuid4(), audience=uuid4(), client_ids=(uuid4(),),
            web_origin="https://vita.example")

    def signed(self):
        config = self.config()
        key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        jwk = {**json.loads(jwt.algorithms.RSAAlgorithm.to_jwk(key.public_key())), "kid": "local-test", "alg": "RS256", "use": "sig"}
        requests = []
        def serve(request):
            requests.append(request)
            self.assertEqual(str(request.url), f"https://login.microsoftonline.com/{config.tenant_id}/discovery/v2.0/keys")
            return httpx.Response(200, json={"keys": [jwk]})
        now = int(datetime.now(UTC).timestamp())
        claims = {"exp": now+300, "nbf": now-5, "iat": now-5, "aud": str(config.audience),
            "iss": f"https://login.microsoftonline.com/{config.tenant_id}/v2.0", "tid": str(config.tenant_id),
            "oid": str(uuid4()), "scp": "access_as_user", "ver": "2.0", "azp": str(config.client_ids[0])}
        return config, key, claims, httpx.MockTransport(serve), requests

    def test_signed_tokens_reject_tenant_audience_scope_expiry_client_signature(self):
        config, key, claims, transport, requests = self.signed()
        verifier = EntraVerifier(config, transport)
        token = lambda data, signing=key: "Bearer " + jwt.encode(data, signing, algorithm="RS256", headers={"kid": "local-test"})
        result = verifier.verify(token(claims))
        self.assertEqual(str(result.object_id), claims["oid"])
        for changes in ({"tid": str(uuid4())}, {"aud": str(uuid4())}, {"scp": "User.Read"},
                        {"exp": claims["iat"]-1}, {"azp": str(uuid4())}, {"ver": "1.0"}):
            self.assert_denied("platform_token_invalid", verifier.verify, token({**claims, **changes}))
        other = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.assert_denied("platform_token_invalid", verifier.verify, token(claims, other))
        self.assert_denied("platform_authentication_required", verifier.verify, None)
        self.assertEqual(len(requests), 1)

    def test_link_revoke_disabled_demoted_and_moved_member_readback(self):
        config = self.config(); service = PlatformInterfaces(self.store, config)
        member = self.identity.create_user("platform-seller", "synthetic-password-long", fixtures.SAMPLE_ORG, "seller")
        body = IdentityBinding(tenant_id=config.tenant_id, object_id=uuid4(), user_id=member.id, expected_revision=0, enabled=True)
        service.link(self.token, body)
        self.assertEqual(service.links(self.token)[0].revision, 1)
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == member.id).values(enabled=False, role="viewer", organization_id="moved"))
        service.config = config.model_copy(update={"enabled": False})
        result = service.link(self.token, body.model_copy(update={"expected_revision": 1, "enabled": False}))
        self.assertFalse(result.enabled)
        self.assertEqual(service.links(self.token), [result])
        service.config = config
        self.assert_denied("handoff_member_unavailable", service.link, self.token,
            body.model_copy(update={"expected_revision": 2}))

    def test_preparation_success_stale_manual_monitor_viewer_and_no_mutation(self):
        config = self.config(); service = PlatformInterfaces(self.store, config)
        principal = Principal(tenant_id=config.tenant_id, object_id=uuid4())
        service.link(self.token, IdentityBinding(tenant_id=config.tenant_id, object_id=principal.object_id,
            user_id=self.actor.id, expected_revision=0, enabled=True))
        # Refresh only this isolated synthetic fixture's original generation time.
        with self.store.engine.begin() as connection:
            for account, facts in sample_records(datetime.now(UTC)):
                connection.execute(accounts.update().where(accounts.c.id == account.id).values(payload=account.model_dump(mode="json")))
                for fact in facts:
                    connection.execute(evidence.update().where(evidence.c.id == fact.id).values(payload=fact.model_dump(mode="json")))
        contexts = [service.context(principal, account.id) for account, _ in sample_records(datetime.now(UTC))]
        before = self.snapshot(self.store)
        kinds = []
        for context in contexts:
            body = PlatformPreparation(account_id=context.account.account.id, expected_account_revision=context.account.account.revision,
                expected_snapshot_hash=context.account.assessment.snapshot_hash)
            result = service.preparation(principal, body)
            kinds.append(result.action_kind)
            self.assertEqual(result.status, "proposal_only")
            self.assertFalse(result.context.approval_available)
            if result.action_kind == "monitor":
                self.assertFalse(result.allowed)
            self.assert_denied("platform_snapshot_changed", service.preparation, principal,
                body.model_copy(update={"expected_snapshot_hash": "0"*64}))
        self.assertEqual(self.snapshot(self.store), before)
        self.assertIn("monitor", kinds)
        with self.store.engine.begin() as connection:
            row = connection.execute(accounts.select().where(accounts.c.id == str(self.account_id))).mappings().one()
            connection.execute(accounts.update().where(accounts.c.id == str(self.account_id)).values(
                payload={**row["payload"], "annual_value": None}))
        context = service.context(principal, self.account_id)
        manual_body = PlatformPreparation(account_id=self.account_id, expected_account_revision=context.account.account.revision,
            expected_snapshot_hash=context.account.assessment.snapshot_hash)
        manual = service.preparation(principal, manual_body)
        self.assertEqual(manual.action_kind, "manual_review")
        self.assertFalse(manual.allowed)
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == self.actor.id).values(role="viewer"))
        with self.assertRaises(PolicyDenied):
            service.preparation(principal, body)

    def test_http_bearer_real_verifier_strict_body_and_cookie_cannot_authenticate(self):
        config, key, claims, transport, _ = self.signed()
        service = PlatformInterfaces(self.store, config)
        service.link(self.token, IdentityBinding(tenant_id=config.tenant_id, object_id=claims["oid"], user_id=self.actor.id,
            expected_revision=0, enabled=True))
        token = jwt.encode(claims, key, algorithm="RS256", headers={"kid": "local-test"})
        settings = Settings(_env_file=None, auth_mode="session", database_url=self.store.engine.url.render_as_string(hide_password=False))
        with TestClient(create_app(settings, fixtures.NoInference(), platform_settings=config, platform_transport=transport)) as client:
            path = f"/api/platform/context/{self.account_id}"
            client.cookies.set("vitaai_session", self.token)
            self.assertEqual(client.get(path).status_code, 401)
            headers = {"Authorization": "Bearer " + token}
            self.assertEqual(client.get(path, headers=headers).status_code, 200)
            self.assertEqual(client.get("/api/platform/identities").status_code, 200)
            response = client.post("/api/platform/preparation", headers=headers, json={"actor_id": "PRIVATE_SENTINEL"})
            self.assertEqual(response.status_code, 422)
            self.assertNotIn("PRIVATE_SENTINEL", response.text)
            self.assertEqual(response.headers["cache-control"], "no-store")

    def test_teams_expired_cross_identity_and_edited_command_deny(self):
        config = self.config(); service = PlatformInterfaces(self.store, config)
        principal = Principal(tenant_id=config.tenant_id, object_id=uuid4())
        service.link(self.token, IdentityBinding(tenant_id=config.tenant_id, object_id=principal.object_id,
            user_id=self.actor.id, expected_revision=0, enabled=True))
        body = TeamsActivity(activity_id="tab-local-id", timestamp=datetime.now(UTC), tenant_id=principal.tenant_id,
            object_id=principal.object_id, account_id=self.account_id, type="message", command="context", conversation_type="personal")
        self.assert_denied("platform_activity_expired", service.teams, principal,
            body.model_copy(update={"timestamp": datetime.now(UTC)-timedelta(minutes=6)}))
        self.assert_denied("platform_activity_identity_changed", service.teams, principal,
            body.model_copy(update={"object_id": uuid4()}))
        card = service.teams(principal, body)
        self.assertEqual(service.teams(principal, body), card)
        self.assert_denied("platform_activity_conflict", service.teams, principal,
            body.model_copy(update={"account_id": uuid4()}))
