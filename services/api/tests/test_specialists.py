"""Specialist snapshot acceptance; synthetic input and denied/mocked network only."""
import unittest
from datetime import timedelta
from uuid import uuid4

import httpx
import test_stage1 as fixtures
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy import select, update

from vita_api.app import create_app
from vita_api.config import Settings
from vita_api.nebius import Nebius
from vita_api.pipeline import Pipeline, PipelineRequest, PipelineRun
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess
from vita_api.specialists import SpecialistReport
from vita_api.storage import Store, pipeline_runs

NOW = fixtures.NOW


class NoModel:
    def analyze(self, *_):
        raise AssertionError("Unexpected inference")

    draft = analyze


class SpecialistTests(unittest.TestCase):
    def run_pipeline(self, records=None, **request):
        return Pipeline(NoModel()).run(SAMPLE_ORG, "fixture-actor", records if records is not None else sample_records(NOW),
                                       NOW.date(), PipelineRequest(**request))

    def test_shared_snapshot_citations_and_unchanged_authority_for_every_intent(self):
        records = sample_records(NOW)
        before = [(a.model_dump(), [f.model_dump() for f in facts]) for a, facts in records]
        for intent in ("attention", "risk", "growth", "renewal", "manual_review", "monitor"):
            run = self.run_pipeline(records, intent=intent, limit=6, communication_mode="drafts")
            self.assertEqual(run.portfolio_specialists.recommendation_order, [r.account_id for r in run.recommendations])
            for result in run.recommendations:
                account, facts = next(r for r in records if r[0].id == result.account_id)
                self.assertEqual(result.assessment, assess(account, facts, NOW.date()))
                self.assertEqual(result.action.approval_status, "unapproved")
                self.assertFalse(result.action.external_execution)
                self.assertTrue(result.governance.requires_human_approval)
                report = result.specialists
                self.assertEqual((report.organization_id, report.account_id, report.account_revision,
                                  report.snapshot_hash, report.as_of),
                                 (SAMPLE_ORG, account.id, account.revision, result.assessment.snapshot_hash, NOW.date()))
                self.assertEqual([p.role for p in report.perspectives], ["risk", "growth", "research", "engagement", "governance"])
                self.assertTrue(all(set(f.evidence_ids) <= {e.id for e in facts}
                                    for p in report.perspectives for f in p.findings))
                self.assertEqual(report.perspectives[2].status, "missing_source")
                self.assertEqual(report.perspectives[2].missing_sources, ["selected_external_context"])
                self.assertIn("contact_history", report.perspectives[3].missing_sources)
                self.assertFalse(report.external_execution)
        self.assertEqual(before, [(a.model_dump(), [f.model_dump() for f in facts]) for a, facts in records])

    def test_missing_unknown_stale_and_future_evidence_never_fabricate_findings(self):
        account, facts = sample_records(NOW)[0]
        account = account.model_copy(update={"annual_value": None, "renewal_date": None})
        facts = [facts[0].model_copy(update={"observed_at": NOW - timedelta(days=31)}),
                 facts[1].model_copy(update={"observed_at": NOW + timedelta(days=1)})]
        result = self.run_pipeline([(account, facts)]).recommendations[0]
        self.assertTrue(all(f.value is None for f in result.assessment.factors))
        for perspective in result.specialists.perspectives[:2]:
            self.assertEqual(perspective.status, "missing_source")
            self.assertEqual(len(perspective.missing_sources), 4)
            self.assertTrue(all(not f.evidence_ids for f in perspective.findings))
        self.assertEqual(result.specialists.disagreements, [])
        self.assertEqual(result.specialists.perspectives[3].status, "blocked")
        self.assertEqual(result.specialists.perspectives[4].missing_sources, ["annual_value", "renewal_date"])

    def test_conflicts_keep_both_sources_and_competing_signals_are_separate(self):
        account, facts = sample_records(NOW)[0]
        facts = [f.model_copy(update={"value": 100}) if f.metric == "expansion" else f for f in facts]
        conflict = facts[0].model_copy(update={"id": str(uuid4()), "value": facts[0].value - 1})
        result = self.run_pipeline([(account, facts + [conflict])]).recommendations[0]
        self.assertEqual(result.assessment.confidence, 50)
        issues = {f.kind: f for f in result.specialists.disagreements}
        self.assertEqual(set(issues), {"conflicting_observations", "competing_signals"})
        self.assertEqual(set(issues["conflicting_observations"].evidence_ids), {facts[0].id, conflict.id})
        self.assertIn("not proof", issues["competing_signals"].text)
        self.assertEqual(result.action.kind, "manual_review")

    def test_portfolio_uses_full_pool_with_independent_maxima_and_stable_ties(self):
        records = sample_records(NOW)
        summary = self.run_pipeline(records, limit=1).portfolio_specialists
        baselines = [(a, assess(a, facts, NOW.date())) for a, facts in records]
        self.assertEqual(summary.account_count, len(records))
        for metric, chosen in (("risk", summary.highest_risk), ("opportunity", summary.highest_opportunity)):
            account, baseline = min(baselines, key=lambda r: (-getattr(r[1], metric), r[0].id))
            self.assertEqual((chosen.account_id, chosen.score, chosen.snapshot_hash),
                             (account.id, getattr(baseline, metric), baseline.snapshot_hash))
        self.assertNotEqual(summary.highest_risk.account_id, summary.highest_opportunity.account_id)
        self.assertEqual(summary, self.run_pipeline(list(reversed(records)), limit=1).portfolio_specialists)
        tied = self.run_pipeline([(a, []) for a, _ in records]).portfolio_specialists
        self.assertEqual(tied.highest_opportunity.account_id, min(a.id for a, _ in records))
        self.assertEqual(tied.highest_opportunity.evidence_ids, [])

    def test_empty_input_and_historical_run_do_not_invent_analysis(self):
        run = self.run_pipeline([])
        self.assertEqual(run.recommendations, [])
        self.assertIsNone(run.portfolio_specialists.highest_risk)
        old = self.run_pipeline().model_dump(mode="json")
        old.pop("portfolio_specialists")
        for result in old["recommendations"]:
            result.pop("specialists")
        restored = PipelineRun.model_validate(old)
        self.assertIsNone(restored.portfolio_specialists)
        self.assertTrue(all(r.specialists is None for r in restored.recommendations))
        report = self.run_pipeline().recommendations[0].specialists.model_dump()
        for changes in ({"external_execution": True}, {"approved": True}):
            with self.assertRaises(ValidationError):
                SpecialistReport.model_validate({**report, **changes})

    def test_provider_timeout_keeps_failure_without_an_additional_call(self):
        calls = []

        def transport(request):
            calls.append(request.url.path)
            if request.url.path.endswith("/models"):
                return httpx.Response(200, json={"data": [{"id": "nvidia/test-nemotron"}]})
            raise httpx.ReadTimeout("synthetic timeout")

        provider = Nebius(Settings(_env_file=None, nebius_api_key="synthetic-key", nebius_model="nvidia/test-nemotron"),
                          transport=httpx.MockTransport(transport))
        run = Pipeline(provider).run(SAMPLE_ORG, "actor", sample_records(NOW), NOW.date(),
            PipelineRequest(limit=1, communicate=True, communication_mode="drafts"))
        result = run.recommendations[0]
        self.assertEqual(run.status, "partial")
        self.assertEqual(result.specialists.perspectives[3].status, "failed")
        self.assertEqual(result.specialists.perspectives[3].model_run_id, result.communication.model_run.id)
        self.assertEqual(sum(p.endswith("/chat/completions") for p in calls), 1)
        self.assertEqual(len(calls), 2)


class SpecialistPersistenceTests(unittest.TestCase):
    setUp = fixtures.Stage1Tests.setUp
    tearDown = fixtures.Stage1Tests.tearDown
    login = fixtures.Stage1Tests.login

    def test_scoped_api_saved_findings_survive_reconstruction_without_side_effects(self):
        with TestClient(create_app(self.settings, NoModel())) as client:
            self.login(client)
            before = client.get("/api/portfolio").json()
            response = client.post("/api/pipeline", headers=fixtures.HEADERS, json={"limit": 1})
            self.assertEqual(response.status_code, 200)
            saved = response.json()
            self.assertEqual(client.get("/api/portfolio").json(), before)
            self.assertEqual(saved["portfolio_specialists"]["account_count"], len(before["accounts"]))
        with TestClient(create_app(self.settings, NoModel())) as client:
            self.login(client)
            self.assertEqual(client.get(f"/api/pipeline/{saved['id']}").json(), saved)
            self.identity.create_user("foreign-specialist", "another-test-password", "foreign", "seller")
            self.login(client, "foreign-specialist", "another-test-password")
            self.assertEqual(client.get(f"/api/pipeline/{saved['id']}").status_code, 404)
            self.identity.create_user("viewer-specialist", "another-test-password", SAMPLE_ORG, "viewer")
            self.login(client, "viewer-specialist", "another-test-password")
            self.assertEqual(client.get(f"/api/pipeline/{saved['id']}").json(), saved)
            self.assertEqual(client.post("/api/pipeline", headers=fixtures.HEADERS, json={}).status_code, 403)

    def test_legacy_json_remains_readable_without_backfill(self):
        run = SpecialistTests().run_pipeline()
        self.store.save_pipeline(run)
        payload = run.model_dump(mode="json")
        payload.pop("portfolio_specialists")
        for result in payload["recommendations"]:
            result.pop("specialists")
        with self.store.engine.begin() as connection:
            connection.execute(update(pipeline_runs).where(pipeline_runs.c.id == run.id).values(payload=payload))
        reconstructed = Store(self.settings.database_url)
        try:
            restored = reconstructed.get_pipeline(SAMPLE_ORG, run.id)
            self.assertIsNone(restored.portfolio_specialists)
            self.assertTrue(all(r.specialists is None for r in restored.recommendations))
            with reconstructed.engine.connect() as connection:
                retained = connection.execute(select(pipeline_runs.c.payload).where(pipeline_runs.c.id == run.id)).scalar_one()
            self.assertEqual(retained, payload)
        finally:
            reconstructed.engine.dispose()
