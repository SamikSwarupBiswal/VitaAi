"""Source-memory correction, role, restart and concurrency boundaries."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from uuid import uuid4

import test_memory as fixtures
from fastapi.testclient import TestClient

from vita_api.app import create_app
from vita_api.companion import Companion, ConversationStart, TurnRequest
from vita_api.config import Settings
from vita_api.contracts import AccountSource
from vita_api.governance import PolicyDenied
from vita_api.hubspot_changes import detect, detections, snapshot
from vita_api.hubspot_normalize import AccountSourceVersion
from vita_api.identity import users
from vita_api.memory_sources import (
    SourceMemory,
    SourceMemoryCapture,
    SourceMemoryLifecycle,
    SourceRecallRequest,
    source_entries,
)
from vita_api.scoring import assess
from vita_api.storage import Store, source_versions
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import MissionRequest, OutcomeRequest, PlanRequest


class SourceMemoryTests(unittest.TestCase):
    setUp = fixtures.MemoryTests.setUp
    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)
    assert_denied = fixtures.MemoryTests.assert_denied

    def mission(self):
        self.workflow = Workflow(self.store, session_token=self.token, session_required=True)
        account, facts, _ = next(row for row in self.store.account_records(fixtures.SAMPLE_ORG) if row[0].id == str(self.account_id))
        self.hash = assess(account, facts, datetime.now(UTC).date()).snapshot_hash
        plan = self.workflow.create_plan(self.actor.id, PlanRequest(account_id=self.account_id, expected_revision=account.revision,
            expected_snapshot_hash=self.hash, intent="risk"))
        return self.workflow.create_mission(self.actor.id, MissionRequest(plan_id=plan.id, expected_revision=plan.revision))

    def source(self, revision=1):
        account, facts, _ = next(row for row in self.store.account_records(fixtures.SAMPLE_ORG) if row[0].id == str(self.account_id))
        account = account.model_copy(update={"revision": revision})
        selection = AccountSource(id=str(uuid4()), kind="local_sample", account_revision=revision, actor_id=self.actor.id, selected_at=fixtures.NOW)
        version = AccountSourceVersion(account_id=self.account_id, selection=selection, account=account,
            evidence=facts, previous_account=account, previous_evidence=facts)
        original = detect(fixtures.SAMPLE_ORG, str(self.account_id), self.actor.id, None, snapshot(version, None), fixtures.NOW)
        with self.store.engine.begin() as connection:
            connection.execute(source_versions.insert().values(id=selection.id, organization_id=fixtures.SAMPLE_ORG,
                account_id=str(self.account_id), account_revision=revision, payload=version.model_dump(mode="json")))
            connection.execute(detections.insert().values(id=str(original.id), organization_id=fixtures.SAMPLE_ORG,
                account_id=str(self.account_id), source_version_id=selection.id, account_revision=revision, payload=original.model_dump(mode="json")))
        return original

    def capture(self, source_id, kind="mission"):
        service = SourceMemory(self.store, self.token)
        preview = service.preview(self.account_id, kind, source_id)
        body = SourceMemoryCapture(kind=kind, source_id=source_id, expected_content_hash=preview.content_hash)
        return service, body, service.capture_source(self.account_id, body)

    def report(self, mission, note, supersedes=None):
        return self.workflow.outcome(self.actor.id, mission.id, OutcomeRequest(expected_revision=mission.revision,
            kind="follow_up_required", basis="manual_report", manual_action_reference="Synthetic human review",
            evidence_ids=mission.evidence.evidence_ids, note=note, supersedes_id=supersedes))

    def test_detection_original_fields_time_identity_and_capture_replay(self):
        original = self.source()
        before = self.snapshot(self.store)
        service, body, item = self.capture(original.id, "source_detection")
        self.assertEqual(item.source.original, original)
        self.assertEqual(item.source.source_time, fixtures.NOW)
        self.assertEqual(item.source.source_actor_id, self.actor.id)
        self.assertEqual(service.capture_source(self.account_id, body), item)
        after = self.snapshot(self.store)
        for table, values in before.items():
            if not table.startswith("source_memory_"):
                self.assertEqual(values, after[table], table)
        invalid = service.source_lifecycle(item.id, SourceMemoryLifecycle(expected_revision=1, state="invalidated", reason="Wrong source"))
        self.assertEqual(service.capture_source(self.account_id, body), invalid)
        self.assert_denied("memory_revision_changed", service.source_lifecycle, item.id,
            SourceMemoryLifecycle(expected_revision=2, state="active", reason="Cannot restore invalidated source"))
        corrupt = original.model_dump(mode="json"); corrupt["reason"] = "first_source"
        with self.store.engine.begin() as connection:
            connection.execute(detections.update().where(detections.c.id == str(original.id)).values(payload=corrupt))
        self.assert_denied("memory_source_unavailable", service.preview, self.account_id, "source_detection", original.id)

    def test_correction_summary_and_replacement_lineage_keep_old_claim_historical(self):
        mission = self.mission()
        first = self.report(mission, "OLDER_SUPERSEDED_NOTE")
        service, body, old = self.capture(mission.id)
        current = self.workflow.get_mission(self.actor.id, mission.id)
        latest = self.report(current, "CORRECTED_LATEST_NOTE", first.id)
        preview = service.preview(self.account_id, "mission", mission.id)
        self.assertIn("CORRECTED_LATEST_NOTE", preview.summary)
        self.assertNotIn("OLDER_SUPERSEDED_NOTE", preview.summary)
        self.assertIn("superseded historical", preview.summary)
        self.assertEqual(len(preview.original.outcomes), 2)
        self.assertEqual(preview.original.outcomes[-1].id in {first.id, latest.id}, True)
        new = service.capture_source(self.account_id, body.model_copy(update={"expected_content_hash": preview.content_hash}))
        unrelated = self.mission(); _, _, other = self.capture(unrelated.id)
        self.assert_denied("memory_replacement_invalid", service.source_lifecycle, old.id,
            SourceMemoryLifecycle(expected_revision=1, state="superseded", reason="Unrelated mission", replacement_id=other.id))
        revised = service.source_lifecycle(old.id, SourceMemoryLifecycle(expected_revision=1, state="superseded", reason="Corrected report", replacement_id=new.id))
        self.assertEqual(revised.replaced_by_id, new.id)
        self.assert_denied("memory_replacement_invalid", service.source_lifecycle, new.id,
            SourceMemoryLifecycle(expected_revision=1, state="superseded", reason="Older revision", replacement_id=other.id))

    def test_concurrent_capture_lifecycle_stale_revision_roles_and_restart(self):
        mission = self.mission(); service, body, item = self.capture(mission.id)
        other = Store(self.store.engine.url); self.stores.append(other)
        independent = SourceMemory(other, self.token)
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(list(pool.map(lambda m: m.capture_source(self.account_id, body), [service, independent])), [item, item])
        def archive(memory):
            try:
                return memory.source_lifecycle(item.id, SourceMemoryLifecycle(expected_revision=1, state="archived", reason="Historical")).revision
            except PolicyDenied as error:
                return error.code
        with ThreadPoolExecutor(2) as pool:
            self.assertCountEqual(list(pool.map(archive, [service, independent])), [2, "memory_revision_changed"])
        self.assertEqual(independent.source_get(item.id).source, item.source)
        self.assertEqual([event.state for event in independent.source_audit(item.id)], ["active", "archived"])
        for name, role, organization in [("source-viewer", "viewer", fixtures.SAMPLE_ORG), ("source-seller", "seller", fixtures.SAMPLE_ORG), ("source-foreign", "admin", "foreign")]:
            self.identity.create_user(name, "synthetic-password-long", organization, role)
            _, token = self.identity.login(name, "synthetic-password-long", 8)
            reader = SourceMemory(self.store, token)
            if organization == "foreign":
                self.assert_denied("memory_not_found", reader.source_get, item.id)
            else:
                self.assertEqual(reader.source_get(item.id).source, item.source)
                self.assert_denied("operation_denied", reader.source_lifecycle, item.id,
                    SourceMemoryLifecycle(expected_revision=2, state="active", reason="Unauthorized"))
                if role == "viewer":
                    self.assert_denied("operation_denied", reader.capture_source, self.account_id, body)
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == self.actor.id).values(enabled=False))
        self.assert_denied("authentication_required", independent.source_get, item.id)

    def test_durable_companion_source_repeat_suppression_and_http_preview(self):
        mission = self.mission(); service, _, item = self.capture(mission.id)
        companion = Companion(self.store, self.token)
        session = companion.start(self.account_id, ConversationStart(expected_snapshot_hash=self.hash))
        first = companion.turn(session.id, TurnRequest(expected_revision=1, expected_snapshot_hash=self.hash, request_id=uuid4(), message="Recall memory"))
        self.assertEqual(first.recalled_ids, (item.id,))
        restored = Companion(self.store, self.token)
        second = restored.turn(session.id, TurnRequest(expected_revision=2, expected_snapshot_hash=self.hash, request_id=uuid4(), message="Recall memory"))
        self.assertEqual(second.status, "unknown")
        self.assertEqual(second.recalled_ids, ())
        recall = service.source_recall(self.account_id, SourceRecallRequest(expected_snapshot_hash=self.hash, served_ids=(item.id,)))
        self.assertEqual(recall.excluded, {"already_served": 1})
        settings = Settings(_env_file=None, database_url=self.store.engine.url.render_as_string(hide_password=False), auth_mode="session")
        with TestClient(create_app(settings, fixtures.NoInference())) as client:
            path = f"/api/memory/sources/accounts/{self.account_id}/preview/mission/{mission.id}"
            self.assertEqual(client.get(path).status_code, 401)
            client.cookies.set("vitaai_session", self.token)
            self.assertEqual(client.get(path).status_code, 200)
            self.assertEqual(client.get(path).json()["source_id"], str(mission.id))
            self.assertEqual(client.get(path).headers["cache-control"], "no-store")
        with self.store.engine.begin() as connection:
            row = item.model_dump(mode="json"); row["source"]["summary"] = "Invented outcome"
            connection.execute(source_entries.update().where(source_entries.c.id == str(item.id)).values(payload=row))
        self.assert_denied("memory_source_unavailable", service.source_get, item.id)


if __name__ == "__main__":
    unittest.main()
