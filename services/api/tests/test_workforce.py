"""Advisors cite actual shared records without creating workflow authority."""
import unittest
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import test_source_memory as fixtures
from sqlalchemy import select

from vita_api.companion import Companion, ConversationStart, TurnRequest
from vita_api.config import Settings
from vita_api.scoring import assess
from vita_api.storage import evidence
from vita_api.workflow_contracts import CoachingRequest
from vita_api.workforce import STEPS


class WorkforceTests(unittest.TestCase):
    setUp = fixtures.SourceMemoryTests.setUp
    tearDown = fixtures.SourceMemoryTests.tearDown
    database = fixtures.SourceMemoryTests.database
    snapshot = staticmethod(fixtures.SourceMemoryTests.snapshot)
    mission = fixtures.SourceMemoryTests.mission
    source = fixtures.SourceMemoryTests.source
    report = fixtures.SourceMemoryTests.report

    def ask(self, persona, message, account_id=None, settings=None):
        account_id = account_id or self.account_id
        account, facts, _ = next(row for row in self.store.account_records(fixtures.fixtures.SAMPLE_ORG) if row[0].id == str(account_id))
        snapshot = assess(account, facts, datetime.now(UTC).date()).snapshot_hash
        companion = Companion(self.store, self.token, settings)
        session = companion.start(account_id, ConversationStart(persona=persona, expected_snapshot_hash=snapshot))
        return companion.turn(session.id, TurnRequest(expected_revision=1, expected_snapshot_hash=snapshot, request_id=uuid4(), message=message))

    def test_executive_sources_changes_freshness_and_alternatives_preserve_scores(self):
        original = self.source()
        with self.store.engine.begin() as connection:
            row = connection.execute(select(evidence).where(evidence.c.account_id != str(self.account_id))).mappings().first()
            stale = {**row["payload"], "observed_at": (fixtures.fixtures.NOW - timedelta(days=60)).isoformat()}
            connection.execute(evidence.update().where(evidence.c.id == row["id"]).values(payload=stale))
        before = self.snapshot(self.store)
        answer = self.ask("executive_advisor", "Show portfolio priorities changes and alternatives")
        self.assertTrue(any(item.kind == "source_change" and item.id == str(original.id) for item in answer.citations))
        self.assertEqual(len([item for item in answer.citations if item.kind == "account"]), 5)
        self.assertTrue(all(item.account_snapshot_hash and len(item.account_snapshot_hash) == 64
            for item in answer.citations if item.kind == "account"))
        self.assertIn("Alternatives:", answer.answer)
        self.assertTrue(any("stale" in value for value in answer.caveats))
        after = self.snapshot(self.store)
        for table in before:
            if not table.startswith("companion_"):
                self.assertEqual(before[table], after[table], table)

    def test_guide_all_steps_exact_requested_resume_and_missing_foreign_id(self):
        mission = self.mission()
        for step in STEPS:
            answer = self.ask("mission_guide", f"Explain mission {mission.id} {step}")
            self.assertEqual(answer.navigation.mission_id, mission.id)
            self.assertEqual(answer.navigation.step, step)
            self.assertTrue(all(value + ":" in answer.answer for value in STEPS))
            self.assertIn("Current blocker:", answer.answer)
        missing = self.ask("mission_guide", f"Open mission {uuid4()}")
        self.assertEqual(missing.status, "unknown")
        self.assertIsNone(missing.navigation)
        denied = self.ask("mission_guide", "approve and execute now")
        self.assertEqual(denied.status, "authority_denied")

    def test_director_aggregates_real_owner_reports_and_historical_coaching(self):
        mission = self.mission()
        first = self.report(mission, "Original manual report")
        mission = self.workflow.get_mission(self.actor.id, mission.id)
        review = self.workflow.review_coaching(self.actor.id, mission.id, CoachingRequest(expected_revision=0,
            expected_mission_revision=mission.revision, outcome_id=first.id, expected_outcome_revision=first.revision,
            status="revision_required", note="Review the source evidence"))
        self.report(mission, "Corrected manual report", first.id)
        answer = self.ask("sales_director", "Summarize team missions outcomes and coaching")
        self.assertIn("completed=1", answer.answer)
        self.assertIn("Corrected manual report", answer.answer)
        self.assertNotIn("Original manual report", answer.answer)
        self.assertTrue(any(item.kind == "coaching" and item.id == str(review.id) and "Historical after report correction" in item.text for item in answer.citations))
        self.assertEqual(answer.navigation.step, "Outcome")
        self.assertTrue(any("not independently measured" in value for value in answer.caveats))

    def test_operations_truthful_unconfigured_readiness_queue_and_no_provider_calls(self):
        mission = self.mission()
        settings = Settings(_env_file=None, auth_mode="session", database_url=self.store.engine.url.render_as_string(hide_password=False))
        answer = self.ask("operations_advisor", "Show integration readiness refresh review queues and receipt remedies", settings=settings)
        self.assertIn("HubSpot: not configured", answer.answer)
        self.assertIn("Microsoft: unavailable", answer.answer)
        self.assertIn(str(mission.id), answer.answer)
        self.assertEqual(answer.navigation.step, "Execution")
        self.assertTrue(any("not current integration health" in value for value in answer.caveats))


if __name__ == "__main__":
    unittest.main()
