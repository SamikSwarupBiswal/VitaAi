import json
import tempfile
import unittest
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.contracts import Account, AccountView
from vita_api.nebius import Nebius
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess
from vita_api.storage import Store

NOW = datetime(2026, 10, 14, 12, tzinfo=UTC)


class ScoringTests(unittest.TestCase):
    def setUp(self):
        self.account, self.evidence = sample_records(NOW)[0]

    def test_input_order_does_not_change_assessment(self):
        first = assess(self.account, self.evidence, NOW.date())
        self.assertEqual(first, assess(self.account, list(reversed(self.evidence)), NOW.date()))
        self.assertGreater(first.risk, 50)
        self.assertEqual(first.confidence, 100)

    def test_changed_signal_changes_score_and_snapshot(self):
        original = assess(self.account, self.evidence, NOW.date())
        changed = [item.model_copy(update={"value": 20}) if item.metric == "usage_change" else item
                   for item in self.evidence]
        revised = assess(self.account, changed, NOW.date())
        self.assertLess(revised.risk, original.risk)
        self.assertNotEqual(revised.snapshot_hash, original.snapshot_hash)

    def test_missing_stale_and_cross_org_evidence_require_review(self):
        foreign = self.evidence[0].model_copy(update={"organization_id": "another-org"})
        stale = self.evidence[1].model_copy(update={"observed_at": NOW - timedelta(days=31)})
        result = assess(self.account, [foreign, stale], NOW.date())
        self.assertEqual(result.confidence, 0)
        self.assertTrue(result.needs_attention)
        self.assertIn("Review", result.recommendation)
        self.assertTrue(any("stale" in caveat for caveat in result.caveats))

    def test_conflicting_same_time_signals_require_review(self):
        conflict = self.evidence[0].model_copy(update={"id": "another-id", "value": 40})
        result = assess(self.account, self.evidence + [conflict], NOW.date())
        self.assertLessEqual(result.confidence, 50)
        self.assertTrue(result.needs_attention)

    def test_missing_account_values_remain_explicit_and_require_review(self):
        original = assess(self.account, self.evidence, NOW.date())
        for fields in ({"annual_value": None}, {"renewal_date": None},
                       {"annual_value": None, "renewal_date": None}):
            with self.subTest(fields=fields):
                account = Account.model_validate({**self.account.model_dump(), **fields})
                result = assess(account, self.evidence, NOW.date())
                self.assertTrue(result.requires_review)
                self.assertTrue(result.needs_attention)
                self.assertFalse(result.growth_signal)
                self.assertIn("Review", result.recommendation)
                self.assertNotEqual(result.snapshot_hash, original.snapshot_hash)
                if "renewal_date" in fields:
                    factor = next(f for f in result.factors if f.metric == "renewal")
                    self.assertIsNone(factor.value)
                    self.assertIsNone(factor.evidence_id)
                    self.assertEqual(factor.risk_contribution, 0)
                    self.assertEqual(result.confidence, 75)
                else:
                    self.assertEqual(result.confidence, 100)
                    self.assertEqual(result.risk, original.risk)
                for field in fields:
                    self.assertIsNone(account.model_dump(mode="json")[field])
        zero = Account.model_validate({**self.account.model_dump(), "annual_value": 0})
        self.assertFalse(assess(zero, self.evidence, NOW.date()).requires_review)
        for field in ("annual_value", "renewal_date"):
            body = self.account.model_dump()
            del body[field]
            with self.assertRaises(ValidationError):
                Account.model_validate(body)


class PersistenceApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = Settings(_env_file=None, database_url=f"sqlite:///{Path(self.temp.name) / 'db.sqlite'}")

    def tearDown(self):
        self.temp.cleanup()

    def test_seed_restart_and_scope(self):
        store = Store(self.settings.database_url)
        store.initialize()
        store.seed(sample_records(NOW))
        before = store.list_accounts(SAMPLE_ORG)
        store.engine.dispose()
        reopened = Store(self.settings.database_url)
        reopened.seed(sample_records(NOW + timedelta(days=10)))
        self.assertEqual(before, reopened.list_accounts(SAMPLE_ORG))
        self.assertEqual(reopened.list_accounts("another-org"), [])
        self.assertEqual(reopened.account_evidence("another-org", before[0].id), [])
        reopened.engine.dispose()

    def test_api_snapshot_binding_and_persistent_unconfigured_run(self):
        with TestClient(create_app(self.settings)) as client:
            portfolio = client.get("/api/portfolio").json()
            view = portfolio["accounts"][0]
            account_id = view["account"]["id"]
            body = {"expected_revision": 1, "expected_snapshot_hash": view["assessment"]["snapshot_hash"]}
            bad = {**body, "expected_revision": 2}
            self.assertEqual(client.post(f"/api/accounts/{account_id}/analyze", json=bad).status_code, 409)
            extra = {**body, "organization_id": "another-org"}
            self.assertEqual(client.post(f"/api/accounts/{account_id}/analyze", json=extra).status_code, 422)
            response = client.post(f"/api/accounts/{account_id}/analyze", json=body)
            self.assertEqual(response.status_code, 200)
            run = response.json()
            self.assertEqual(run["status"], "unconfigured")
            self.assertIsNone(run["analysis"])
            self.assertEqual(client.get("/api/accounts/not-present").status_code, 404)
            self.assertEqual(client.post("/api/providers/nebius/discover",
                                        headers={"Origin": "https://untrusted.example"}).status_code, 403)
            self.assertEqual(client.get("/health", headers={"Host": "untrusted.example"}).status_code, 400)
        with TestClient(create_app(self.settings)) as restarted:
            saved = restarted.get(f"/api/accounts/{account_id}").json()["latest_run"]
            self.assertEqual(saved["id"], run["id"])


class NebiusTests(unittest.TestCase):
    def setUp(self):
        account, evidence = sample_records(NOW)[0]
        self.view = AccountView(account=account, evidence=evidence,
                                assessment=assess(account, evidence, NOW.date()), renewal_days=24)
        self.settings = Settings(_env_file=None, nebius_api_key=SecretStr("mock-test-key"),
                                 nebius_model="nvidia/mock-nemotron")

    def transport(self, *, evidence_id=None, status=200, extra=None):
        def respond(request):
            if request.url.path.endswith("/models"):
                return httpx.Response(200, json={"data": [{"id": self.settings.nebius_model}]})
            self.assertEqual(request.url.path, "/v1/chat/completions")
            self.assertNotIn("mock-test-key", request.content.decode())
            fact_id = evidence_id or self.view.evidence[0].id
            analysis = {"findings": [{"text": "Usage declined", "evidence_ids": [fact_id]}],
                        "next_steps": [{"text": "Review blockers", "evidence_ids": [fact_id]}], "caveats": []}
            analysis.update(extra or {})
            return httpx.Response(status, json={
                "id": "mock-request", "model": self.settings.nebius_model,
                "usage": {"prompt_tokens": 100, "completion_tokens": 40},
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(analysis)}}],
                "error": "secret-upstream-body",
            })
        return httpx.MockTransport(respond)

    def test_mock_success_provenance_does_not_change_scores(self):
        before = self.view.assessment.model_copy(deep=True)
        run = Nebius(self.settings, self.transport()).analyze(self.view)
        self.assertEqual(run.status, "succeeded")
        self.assertEqual(run.validation, "schema_and_references_valid")
        self.assertEqual(run.request_id, "mock-request")
        self.assertEqual(run.input_tokens, 100)
        self.assertEqual(before, self.view.assessment)

    def test_unknown_evidence_and_authority_fields_rejected(self):
        for transport in (self.transport(evidence_id="foreign-evidence"), self.transport(extra={"approved": True})):
            run = Nebius(self.settings, transport).analyze(self.view)
            self.assertEqual(run.status, "invalid_output")
            self.assertIsNone(run.analysis)

    def test_provider_failure_has_no_upstream_body_or_secret(self):
        run = Nebius(self.settings, self.transport(status=401)).analyze(self.view)
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error_code, "provider_http_401")
        self.assertNotIn("secret-upstream-body", run.model_dump_json())
        self.assertNotIn("mock-test-key", run.model_dump_json())

    def test_model_absent_from_discovery_cannot_be_used(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(200, json={"data": []}))
        run = Nebius(self.settings, transport).analyze(self.view)
        self.assertEqual(run.error_code, "configured_nvidia_model_unavailable")

    def test_untrusted_endpoint_rejected(self):
        with self.assertRaises(ValidationError):
            Settings(_env_file=None, nebius_base_url="https://untrusted.example/v1")


if __name__ == "__main__":
    unittest.main()
