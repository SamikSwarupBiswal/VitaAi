"""Saved recommendation/research acceptance using synthetic, injected search only."""
import copy
import unittest
from datetime import timedelta
from uuid import uuid4

import test_research as fixtures
from test_research import ACCOUNT, HEADERS, PREFIX
from vita_api.governance import PolicyDenied
from vita_api.pipeline import PipelineRun
from vita_api.research import ResearchRun
from vita_api.research_context import build_brief, build_decision_brief
from vita_api.research_fusion import pair_research


class SavedResearchTests(unittest.TestCase):
    setUp = fixtures.ResearchApiTests.setUp
    tearDown = fixtures.ResearchApiTests.tearDown
    login = fixtures.ResearchApiTests.login
    search = fixtures.ResearchApiTests.search
    respond = fixtures.ResearchContextTests.respond
    evaluate = fixtures.ResearchContextTests.evaluate

    def saved_pair(self):
        response = self.client.post("/api/pipeline", headers=HEADERS, json={"limit": 6})
        self.assertEqual(response.status_code, 200, response.text)
        pipeline = PipelineRun.model_validate(response.json())
        run = ResearchRun.model_validate(self.search().json())
        return pipeline, run, self.evaluate(run)

    def test_decision_focus_citations_proposals_and_injection_boundaries(self):
        _, run, original = self.saved_pair()
        before = original.model_dump(mode="json")
        for risk, opportunity, confidence, review, expected in [
            (80, 90, 100, False, "competing_signals"),
            (80, 0, 100, False, "risk_review"),
            (0, 90, 100, False, "growth_review"),
            (0, 0, 100, False, "monitor"),
            (80, 90, 75, False, "evidence_review"),
            (80, 90, 100, True, "evidence_review"),
        ]:
            context = original.model_copy(deep=True)
            context.internal.assessment = context.internal.assessment.model_copy(update={
                "risk": risk, "opportunity": opportunity, "confidence": confidence, "requires_review": review})
            with self.subTest(focus=expected, confidence=confidence):
                brief = build_decision_brief(context)
                self.assertEqual(brief.focus, expected)
                self.assertEqual(brief.approval_status, "unapproved")
                self.assertFalse(brief.external_execution)
                self.assertEqual(brief.factual_confidence, "unverified")
                eligible = expected in {"competing_signals", "risk_review", "growth_review"}
                self.assertEqual(brief.proposed_crm_note is not None, eligible)
                self.assertEqual(brief.suggested_opening is not None, eligible)
                self.assertNotIn("approve a write", brief.model_dump_json())
                ids = {item.id for item in context.internal.evidence}
                for step in brief.conversation_strategy:
                    self.assertLessEqual(set(step.evidence_ids), ids)
                    self.assertLessEqual(set(step.source_urls), {item.url for item in context.usable_sources})
                context.internal.evidence.reverse()
                self.assertEqual(build_decision_brief(context), brief)
        self.assertEqual(original.model_dump(mode="json"), before)
        self.assertEqual(original.retained_run, run)
        self.assertEqual(len(self.calls), 1)

    def test_unusable_context_has_no_public_strategy_or_proposals_and_preserves_unknowns(self):
        _, run, original = self.saved_pair()
        for status in ("expired", "disabled", "target_changed", "account_changed", "no_usable_sources"):
            context = original.model_copy(deep=True, update={"status": status, "usable_sources": []})
            context.internal.account.annual_value = None
            context.internal.account.renewal_date = None
            context.internal.assessment.requires_review = True
            context.internal.assessment.caveats = ["Original unresolved CRM contradiction"]
            brief = build_brief(context)
            with self.subTest(status=status):
                self.assertIn("Unknown", brief.decision.executive_summary)
                self.assertEqual(brief.decision.focus, "evidence_review")
                self.assertIsNone(brief.decision.proposed_crm_note)
                self.assertIsNone(brief.decision.suggested_opening)
                self.assertTrue(all(not item.source_urls for item in brief.decision.conversation_strategy))
                self.assertIn("Original unresolved CRM contradiction", brief.caveats)
                self.assertEqual(brief.topics, [])
                self.assertEqual(context.retained_run, run)

    def test_pair_is_exact_order_independent_and_preserves_saved_records(self):
        pipeline, run, context = self.saved_pair()
        before = pipeline.model_dump(mode="json"), run.model_dump(mode="json")
        fused = pair_research(pipeline, context)
        original = next(item for item in pipeline.recommendations if item.account_id == ACCOUNT)
        self.assertEqual(fused.recommendation, original)
        self.assertEqual(fused.research_specialist.findings, context.brief.verification_questions)
        context.internal.evidence.reverse()
        self.assertEqual(pair_research(pipeline, context).recommendation, original)
        for changed in ("scope", "date", "account", "assessment", "evidence", "duplicate", "missing"):
            candidate = pipeline.model_copy(deep=True)
            selected = next(item for item in candidate.recommendations if item.account_id == ACCOUNT)
            inputs = next(item for item in candidate.contexts if item.account.id == ACCOUNT)
            if changed == "scope":
                candidate.organization_id = "foreign"
            elif changed == "date":
                candidate.as_of += timedelta(days=1)
            elif changed == "account":
                inputs.account.revision += 1
            elif changed == "assessment":
                selected.assessment.snapshot_hash = "0" * 64
            elif changed == "evidence":
                inputs.evidence[0].source_record = "different-source"
            elif changed == "duplicate":
                candidate.recommendations.append(copy.deepcopy(selected))
            else:
                candidate.contexts = [item for item in candidate.contexts if item.account.id != ACCOUNT]
            with self.subTest(changed=changed), self.assertRaises(PolicyDenied):
                pair_research(candidate, context)
        self.assertEqual((pipeline.model_dump(mode="json"), run.model_dump(mode="json")), before)

    def test_http_pair_scope_expiry_revision_and_read_only_history(self):
        pipeline, run, _ = self.saved_pair()
        path = f"/api/pipeline/{pipeline.id}/research/{run.id}"
        before = self.client.get("/api/portfolio").json()
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["research_context"]["status"], "usable")
        self.assertEqual(response.json()["research_context"]["retained_run"], run.model_dump(mode="json"))
        self.identity.create_user("viewer", "test-password-long", run.organization_id, "viewer")
        self.login("viewer")
        self.assertEqual(self.client.get(path).status_code, 200)
        self.identity.create_user("foreign", "test-password-long", "foreign", "admin")
        self.login("foreign")
        self.assertEqual(self.client.get(path).status_code, 404)
        self.login()
        self.assertEqual(self.client.get(f"/api/pipeline/{uuid4()}/research/{run.id}").status_code, 404)
        expired = self.evaluate(run, now=run.expires_at)
        fused = pair_research(pipeline, expired)
        self.assertEqual(fused.research_specialist.status, "missing_source")
        self.assertEqual(fused.research_specialist.findings, [])
        self.assertEqual(self.client.get("/api/portfolio").json(), before)
        self.assertEqual(self.client.get(f"{PREFIX}/runs/{run.id}").json(), run.model_dump(mode="json"))
        self.assertEqual(self.client.get(f"/api/pipeline/{pipeline.id}").json(), pipeline.model_dump(mode="json"))
        self.assertEqual(len(self.calls), 1)
        self.client.post("/api/auth/logout", headers=HEADERS)
        self.assertEqual(self.client.get(path).status_code, 401)
