"""Five-provider drafts and exact server-allowed per-run model selection."""
import json
import unittest

import httpx
import test_provider_comparison as fixtures
from pydantic import ValidationError
from sqlalchemy import select
from vita_api.config import ComparisonProviderConfig
from vita_api.provider_catalog import ProviderCatalog
from vita_api.provider_comparison import ComparisonResult, analyze, comparisons


class SelectionTests(unittest.TestCase):
    setUp = fixtures.ComparisonApiTests.setUp
    tearDown = fixtures.ComparisonApiTests.tearDown
    login = fixtures.ComparisonApiTests.login
    body = fixtures.ComparisonApiTests.body
    compare = fixtures.ComparisonApiTests.compare
    valid_response = fixtures.ComparisonApiTests.valid_response

    def test_selected_model_and_exact_response_identity_survive_history(self):
        config = self.settings.comparison_providers["openai"]
        config.allowed_models = {"second-model": "canonical-second"}
        entry = next(item for item in self.client.get(fixtures.PREFIX + "/catalog").json() if item["provider"] == "openai")
        self.assertEqual(entry["allowed_models"], {"test-model": "test-model", "second-model": "canonical-second"})
        self.assertEqual(self.calls, [])
        original = self.valid_response

        def respond(request):
            self.assertEqual(json.loads(request.content)["model"], "second-model")
            payload = original(request).json()
            payload["model"] = "canonical-second"
            return httpx.Response(200, json=payload)

        self.inference = respond
        before = self.client.get("/api/portfolio").json()
        response = self.compare(providers=[{"provider": "openai", "mode": "live", "model": "second-model",
            "expected_configuration_revision": 1}])
        self.assertEqual(response.status_code, 200, response.text)
        run = response.json()
        result = run["results"][0]
        self.assertEqual((result["model"], result["expected_response_model"], result["response_model"], result["status"]),
            ("second-model", "canonical-second", "canonical-second", "succeeded"))
        self.assertEqual(config.model, "test-model")
        self.assertEqual(self.client.get(fixtures.PREFIX + f'/runs/{run["id"]}').json(), run)
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(len(self.calls), 1)

    def test_unknown_model_and_client_response_override_deny_before_intent(self):
        for changes, status in (({"model": "unlisted"}, 409), ({"model": "bad?model"}, 422),
                                ({"model": "test-model", "response_model": "invented"}, 422)):
            response = self.compare(providers=[{"provider": "openai", "expected_configuration_revision": 1, **changes}])
            self.assertEqual(response.status_code, status, response.text)
        with self.app.state.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(comparisons)).all(), [])
        self.assertEqual(self.calls, [])
        with self.assertRaises(ValidationError):
            ComparisonProviderConfig(model="test", response_model="canonical", allowed_models={"test": "different"})

    def test_allowlist_change_during_request_discards_output_without_retry(self):
        self.settings.comparison_providers["openai"].allowed_models = {"second-model": "second-model"}
        self.callback = lambda: self.settings.comparison_providers["openai"].allowed_models.clear()
        response = self.compare(providers=[{"provider": "openai", "mode": "live", "model": "second-model",
            "expected_configuration_revision": 1}])
        self.assertEqual(response.status_code, 409)
        history = self.client.get(self.path + "/runs").json()
        self.assertEqual(history[0]["status"], "discarded")
        self.assertIsNone(history[0]["results"][0]["analysis"])
        self.assertEqual(len(self.calls), 1)


class DraftAdapterTests(unittest.TestCase):
    def test_five_providers_all_purposes_and_monitor_outreach_denial(self):
        from vita_api.contracts import AccountView
        from vita_api.sample import sample_records
        from vita_api.scoring import assess

        account, evidence = sample_records(fixtures.datetime.now(fixtures.UTC))[0]
        view = AccountView(account=account, evidence=evidence,
            assessment=assess(account, evidence, fixtures.datetime.now(fixtures.UTC).date()), renewal_days=10)
        before = view.model_dump_json()
        for provider in ("nebius", "openai", "anthropic", "nvidia", "foundry"):
            for kind in ("support_escalation", "renewal_prep", "optimization_review", "reactivation", "follow_up", "monitor", "manual_review"):
                for wrong in (False, True):
                    with self.subTest(provider=provider, kind=kind, invalid=wrong):
                        calls = []
                        model = "nvidia/test-nemotron" if provider == "nebius" else "test-model"
                        config = ComparisonProviderConfig(enabled=True, live_enabled=True, api_key="synthetic-key",
                            model=model, resource_name="test-resource" if provider == "foundry" else "")
                        finding = {"text": "Review the retained evidence; this is a proposal.", "evidence_ids": [evidence[0].id]}
                        output = {"action_kind": kind, "internal_note": finding, "caveats": [],
                            **{key: None if kind in {"monitor", "manual_review"} else finding
                                for key in ("email", "call_script", "voice_summary")}}
                        if wrong:
                            output["email"] = finding if kind in {"monitor", "manual_review"} else {
                                **finding, "evidence_ids": ["unknown-evidence"]}

                        def respond(request, calls=calls, kind=kind, model=model, provider=provider, output=output):
                            calls.append(request)
                            body = json.loads(request.content)
                            self.assertEqual(json.loads(body["messages"][-1]["content"])["action_kind"], kind)
                            payload = {"id": "synthetic-request", "model": model}
                            if provider == "anthropic":
                                payload.update(stop_reason="end_turn", content=[{"type": "text", "text": json.dumps(output)}])
                            else:
                                payload["choices"] = [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}]
                            return httpx.Response(200, json=payload)

                        catalog = ProviderCatalog(fixtures.settings(), httpx.MockTransport(respond))
                        result = ComparisonResult(provider=provider, requested_mode="live", mode="live",
                            configuration_revision=1, model=model, expected_response_model=model)
                        result = analyze(catalog, provider, config, view, result, before_request=lambda: None, action_kind=kind)
                        self.assertEqual(result.status, "invalid_output" if wrong else "succeeded")
                        self.assertIsNone(result.analysis)
                        self.assertEqual(result.drafts is None, wrong)
                        self.assertEqual(len(calls), 1)
                        self.assertEqual(view.model_dump_json(), before)
