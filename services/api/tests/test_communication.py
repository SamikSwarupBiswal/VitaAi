"""Original drafting acceptance; all provider transports here are explicit mocks."""
import json
import unittest
from datetime import UTC, datetime
from uuid import uuid4

import httpx

from vita_api.config import Settings
from vita_api.contracts import AccountView, CommunicationDrafts
from vita_api.nebius import Nebius
from vita_api.pipeline import Pipeline, PipelineRequest
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess

NOW = datetime(2026, 10, 14, 12, tzinfo=UTC)
MODEL = "nvidia/test-nemotron"


class CommunicationTests(unittest.TestCase):
    def setUp(self):
        account, facts = sample_records(NOW)[0]
        self.view = AccountView(account=account, evidence=facts, assessment=assess(account, facts, NOW.date()),
                                renewal_days=(account.renewal_date - NOW.date()).days)
        self.settings = Settings(_env_file=None, nebius_api_key="test-only-secret", nebius_model=MODEL)

    def transport(self, payload, status=200):
        def respond(request):
            if request.url.path.endswith("/models"):
                return httpx.Response(200, json={"data": [{"id": MODEL}]})
            body = json.loads(request.content)
            self.assertIn("draft", body["messages"][0]["content"].lower())
            self.assertEqual(body["model"], MODEL)
            return httpx.Response(status, json={"id": "fixture-call", "model": MODEL,
                                               "choices": [{"finish_reason": "stop", "message": {
                                                   "content": json.dumps(payload)}}]})
        return httpx.MockTransport(respond)

    def drafts(self, kind="support_escalation"):
        finding = {"text": "Proposed support review; no action has occurred.",
                   "evidence_ids": [self.view.evidence[0].id]}
        return {"action_kind": kind, "email": finding, "call_script": finding,
                "voice_summary": finding, "internal_note": finding, "caveats": []}

    def test_model_drafts_record_provenance_without_mutating_assessment(self):
        before = self.view.model_dump(mode="json")
        run = Nebius(self.settings, self.transport(self.drafts())).draft(self.view, "support_escalation")
        self.assertEqual(run.status, "succeeded")
        self.assertEqual(run.task, "drafts")
        self.assertEqual(run.request_id, "fixture-call")
        self.assertIsNone(run.analysis)
        self.assertEqual(run.drafts.action_kind, "support_escalation")
        self.assertEqual(self.view.model_dump(mode="json"), before)

    def planning(self):
        alternatives = []
        for kind in ("hubspot_task_create", "outlook_draft_create"):
            first, second = str(uuid4()), str(uuid4())
            evidence = [self.view.evidence[0].id]
            alternatives.append({"id": str(uuid4()), "rationale": "Review the sourced account evidence.",
                "evidence_ids": evidence, "risks": ["Preparation is not customer contact."], "steps": [
                    {"id": first, "kind": kind, "content": "Proposed follow-up preparation.",
                     "evidence_ids": evidence, "dependencies": []},
                    {"id": second, "kind": "hubspot_note_create", "content": "Record proposed follow-up.",
                     "evidence_ids": evidence, "dependencies": [first]}]})
        return {"intent": "risk", "action_kind": "hubspot_task_create", "strategy": "follow_up",
                "alternatives": alternatives, "selected_alternative_id": alternatives[0]["id"], "caveats": []}

    def planning_transport(self, output, status=200):
        def respond(request):
            if request.url.path.endswith("/models"):
                return httpx.Response(200, json={"data": [{"id": MODEL}]})
            self.assertIn("planning", json.loads(request.content)["messages"][0]["content"].lower())
            return httpx.Response(status, json={"id": "fixture-planning", "model": MODEL,
                "usage": {"prompt_tokens": 100, "completion_tokens": 200},
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output)}}]})
        return httpx.MockTransport(respond)

    def test_structured_planning_preserves_provenance_and_deterministic_inputs(self):
        output = self.planning()
        before = self.view.model_dump_json()
        run = Nebius(self.settings, self.planning_transport(output)).plan(
            self.view, "risk", "hubspot_task_create", "follow_up")
        self.assertEqual((run.status, run.task, run.request_id), ("succeeded", "planning", "fixture-planning"))
        self.assertEqual((run.input_tokens, run.output_tokens), (100, 200))
        self.assertEqual(len(run.planning.alternatives), 2)
        self.assertIsNone(run.analysis)
        self.assertIsNone(run.drafts)
        self.assertEqual(self.view.model_dump_json(), before)

    def test_planning_rejects_authority_unknown_evidence_dependencies_and_wrong_request(self):
        for change in ("authority", "evidence", "dependency", "strategy", "kind", "intent"):
            with self.subTest(change=change):
                output = self.planning()
                if change == "authority":
                    output["approved"] = True
                elif change == "evidence":
                    output["alternatives"][0]["evidence_ids"] = [str(uuid4())]
                elif change == "dependency":
                    output["alternatives"][0]["steps"][0]["dependencies"] = [output["alternatives"][0]["steps"][1]["id"]]
                elif change == "strategy":
                    output["strategy"] = "single_action"
                elif change == "kind":
                    output["alternatives"][0]["steps"][0]["kind"] = "email_send"
                else:
                    output["intent"] = "growth"
                run = Nebius(self.settings, self.planning_transport(output)).plan(
                    self.view, "risk", "hubspot_task_create", "follow_up")
                self.assertEqual(run.status, "invalid_output")
                self.assertIsNone(run.planning)
                self.assertEqual(run.request_id, "fixture-planning")

    def test_planning_unconfigured_and_failure_are_explicit(self):
        unconfigured = Nebius(Settings(_env_file=None)).plan(self.view, "risk", "hubspot_task_create", "follow_up")
        self.assertEqual(unconfigured.status, "unconfigured")
        failed = Nebius(self.settings, self.planning_transport({}, 401)).plan(
            self.view, "risk", "hubspot_task_create", "follow_up")
        self.assertEqual((failed.status, failed.error_code), ("failed", "provider_http_401"))
        self.assertNotIn("test-only-secret", failed.model_dump_json())

    def test_unknown_evidence_action_mismatch_and_authority_are_rejected(self):
        for change in ("evidence", "action", "authority", "missing_outreach"):
            with self.subTest(change=change):
                payload = self.drafts()
                if change == "evidence":
                    payload["email"] = {"text": "Bad reference", "evidence_ids": ["foreign"]}
                elif change == "action":
                    payload["action_kind"] = "renewal_prep"
                elif change == "authority":
                    payload["approved"] = True
                else:
                    payload["call_script"] = None
                run = Nebius(self.settings, self.transport(payload)).draft(self.view, "support_escalation")
                self.assertEqual(run.status, "invalid_output")
                self.assertIsNone(run.drafts)
                self.assertEqual(run.request_id, "fixture-call")
                if change == "missing_outreach":
                    self.assertEqual(run.error_code, "draft_outreach_missing")

    def test_outreach_is_absent_for_monitor_and_review(self):
        for kind in ("monitor", "manual_review"):
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                CommunicationDrafts.model_validate(self.drafts(kind))

    def test_draft_provider_failure_is_safe_and_has_no_success_content(self):
        run = Nebius(self.settings, self.transport({"secret": "test-only-secret"}, status=401)).draft(
            self.view, "support_escalation")
        self.assertEqual(run.status, "failed")
        self.assertEqual(run.error_code, "provider_http_401")
        self.assertIsNone(run.drafts)
        self.assertNotIn("test-only-secret", run.model_dump_json())

    def test_templates_cover_every_action_without_provider_calls(self):
        from vita_api.pipeline import ActionProposal, governance_role

        class NoNetwork:
            def draft(self, *_):
                raise AssertionError("Deterministic preparation cannot call a model")

        pipeline = Pipeline(NoNetwork())
        texts = set()
        for kind in ("support_escalation", "renewal_prep", "optimization_review", "reactivation", "follow_up", "monitor"):
            action = ActionProposal(kind=kind, rationale="Review current evidence.", evidence_ids=[self.view.evidence[0].id])
            result = pipeline.communicate(self.view, action, governance_role(self.view.assessment), False, "drafts")
            self.assertEqual(result.status, "deterministic_template")
            self.assertEqual(result.drafts.action_kind, kind)
            if kind == "monitor":
                self.assertIsNone(result.drafts.email)
                self.assertIsNone(result.drafts.call_script)
                self.assertIsNone(result.drafts.voice_summary)
            else:
                for draft in (result.drafts.email, result.drafts.call_script, result.drafts.voice_summary):
                    self.assertTrue(draft.text)
                    self.assertEqual(draft.evidence_ids, action.evidence_ids)
                texts.add(result.drafts.email.text)
        self.assertEqual(len(texts), 5)

    def test_pipeline_draft_mode_persists_and_never_models_monitor(self):
        from pathlib import Path
        from tempfile import TemporaryDirectory

        from vita_api.storage import Store

        records = sample_records(NOW)
        pipeline = Pipeline(Nebius(Settings(_env_file=None)))
        run = pipeline.run(SAMPLE_ORG, None, records, NOW.date(), PipelineRequest(communication_mode="drafts"))
        with TemporaryDirectory() as directory:
            database_url = f"sqlite:///{Path(directory) / 'drafts.db'}"
            store = Store(database_url)
            store.initialize()
            store.save_pipeline(run)
            store.engine.dispose()
            restarted = Store(database_url)
            self.assertEqual(restarted.get_pipeline(SAMPLE_ORG, run.id), run)
            self.assertIsNone(restarted.get_pipeline("foreign", run.id))
            restarted.engine.dispose()

        class NoNetwork:
            def draft(self, *_):
                raise AssertionError("Monitor cannot invoke a model")

        account, facts = records[-1]
        facts = [f.model_copy(update={"value": 0 if f.metric != "renewal" else 210}) for f in facts]
        monitor = Pipeline(NoNetwork()).run(SAMPLE_ORG, None, [(account, facts)], NOW.date(),
                                            PipelineRequest(intent="monitor", communicate=True, limit=1,
                                                            communication_mode="drafts"))
        self.assertEqual(monitor.recommendations[0].action.kind, "monitor")
        self.assertIsNone(monitor.recommendations[0].communication.model_run)

    def test_another_provider_can_draft_without_mutating_pipeline_authority(self):
        class FixtureProvider:
            def draft(inner, view, kind):
                run = Nebius(self.settings, self.transport(self.drafts(kind))).draft(view, kind)
                run.provider = "fixture"
                view.assessment.risk = 0
                view.account.organization_id = "foreign"
                return run

        result = Pipeline(FixtureProvider()).run(SAMPLE_ORG, None, sample_records(NOW), NOW.date(),
                                                 PipelineRequest(communicate=True, limit=1, communication_mode="drafts"))
        self.assertEqual(result.status, "model_validated")
        self.assertEqual(result.recommendations[0].communication.model_run.provider, "fixture")
        self.assertGreater(result.recommendations[0].assessment.risk, 50)
        self.assertEqual(result.recommendations[0].action.approval_status, "unapproved")

    def test_provider_neutral_boundary_rejects_cross_snapshot_drafts(self):
        class ForeignProvider:
            def draft(inner, view, kind):
                run = Nebius(self.settings, self.transport(self.drafts(kind))).draft(view, kind)
                run.organization_id = "foreign"
                return run

        run = Pipeline(ForeignProvider()).run(SAMPLE_ORG, None, sample_records(NOW), NOW.date(),
                                             PipelineRequest(communicate=True, limit=1, communication_mode="drafts"))
        result = run.recommendations[0].communication
        self.assertEqual(result.status, "invalid_output")
        self.assertIsNone(result.drafts)


if __name__ == "__main__":
    unittest.main()
