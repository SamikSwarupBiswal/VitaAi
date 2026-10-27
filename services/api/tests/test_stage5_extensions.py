"""Stage5 local persistence/authority checks; supports isolated PostgreSQL."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import test_memory as fixtures
from fastapi.testclient import TestClient
from sqlalchemy import select

from vita_api.app import create_app
from vita_api.collaboration import Collaboration, HandoffCreate, HandoffTransition
from vita_api.config import Settings
from vita_api.governance import PolicyDenied
from vita_api.identity import users
from vita_api.intelligence import Intelligence
from vita_api.intelligence_contracts import (
    ScenarioOverrides,
    ScenarioPromotion,
    ScenarioRequest,
    TrendRequest,
)
from vita_api.memory_sources import (
    SourceMemory,
    SourceMemoryCapture,
    SourceMemoryLifecycle,
    SourceRecallRequest,
)
from vita_api.platform_interfaces import (
    IdentityBinding,
    PlatformInterfaces,
    PlatformSettings,
    Principal,
    TeamsActivity,
)
from vita_api.scoring import assess
from vita_api.storage import Store
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import MissionRequest, OutcomeRequest, PlanRequest


class ExtensionTests(unittest.TestCase):
    setUp = fixtures.MemoryTests.setUp
    tearDown = fixtures.MemoryTests.tearDown
    database = fixtures.MemoryTests.database
    snapshot = staticmethod(fixtures.MemoryTests.snapshot)
    assert_denied = fixtures.MemoryTests.assert_denied

    def mission(self):
        self.workflow = Workflow(self.store, session_token=self.token, session_required=True)
        account, facts, _ = next(row for row in self.store.account_records(fixtures.SAMPLE_ORG) if row[0].id == str(self.account_id))
        self.hash = assess(account, facts, datetime.now(UTC).date()).snapshot_hash
        plan = self.workflow.create_plan(self.actor.id, PlanRequest(account_id=self.account_id,
            expected_revision=account.revision, expected_snapshot_hash=self.hash, intent="risk"))
        return self.workflow.create_mission(self.actor.id, MissionRequest(plan_id=plan.id, expected_revision=plan.revision))

    def member(self, name="recipient", role="seller", organization=fixtures.SAMPLE_ORG):
        actor = self.identity.create_user(name, "synthetic-password-long", organization, role)
        _, token = self.identity.login(name, "synthetic-password-long", 8)
        return actor, token

    def test_source_memory_original_dates_dedupe_lifecycle_recall_restart(self):
        mission = self.mission(); service = SourceMemory(self.store, self.token)
        preview = service.preview(self.account_id, "mission", mission.id)
        body = SourceMemoryCapture(kind="mission", source_id=mission.id, expected_content_hash=preview.content_hash)
        item = service.capture_source(self.account_id, body)
        self.assertEqual(item.source.original.mission, mission)
        archived = service.source_lifecycle(item.id, SourceMemoryLifecycle(expected_revision=1, state="archived", reason="History"))
        self.assertEqual(service.capture_source(self.account_id, body), archived)
        service.source_lifecycle(item.id, SourceMemoryLifecycle(expected_revision=2, state="active", reason="Restore"))
        report = self.workflow.outcome(self.actor.id, mission.id, OutcomeRequest(expected_revision=mission.revision,
            kind="follow_up_required", basis="manual_report", manual_action_reference="Review",
            evidence_ids=mission.evidence.evidence_ids, note="Original manual statement"))
        newer = service.preview(self.account_id, "mission", mission.id)
        self.assertEqual(newer.original.outcomes[0], report)
        replacement = service.capture_source(self.account_id, body.model_copy(update={"expected_content_hash": newer.content_hash}))
        revised = service.source_lifecycle(item.id, SourceMemoryLifecycle(expected_revision=3,
            state="superseded", reason="New revision", replacement_id=replacement.id))
        other = Store(self.store.engine.url); self.stores.append(other)
        self.assertEqual(SourceMemory(other, self.token).source_get(item.id), revised)
        self.assertEqual(len(service.source_audit(item.id)), 4)
        recalled = service.source_recall(self.account_id, SourceRecallRequest(expected_snapshot_hash=self.hash))
        self.assertEqual([row.memory.id for row in recalled.items], [replacement.id])
        _, token = self.member("foreign", organization="foreign")
        self.assert_denied("memory_not_found", SourceMemory(self.store, token).source_get, item.id)

    def handoff(self):
        mission = self.mission(); recipient, token = self.member()
        sender = Collaboration(self.store, self.token)
        body = HandoffCreate(request_id=uuid4(), mission_id=mission.id, expected_mission_revision=mission.revision,
            recipient_id=recipient.id, reason="Inspect evidence", evidence_ids=mission.evidence.evidence_ids)
        return mission, recipient, token, sender, body, sender.create(self.account_id, body)

    def test_handoff_participants_transitions_replay_no_workflow_change(self):
        mission, _, token, sender, body, item = self.handoff()
        self.assertEqual(sender.create(self.account_id, body), item)
        receiver = Collaboration(self.store, token)
        request = HandoffTransition(request_id=uuid4(), expected_revision=1, expected_mission_revision=mission.revision,
            status="accepted", note="Inspecting")
        self.assert_denied("handoff_transition_denied", sender.transition, item.id, request)
        accepted = receiver.transition(item.id, request)
        self.assertEqual(receiver.transition(item.id, request), accepted)
        final = receiver.transition(item.id, request.model_copy(update={"request_id": uuid4(), "expected_revision": 2,
            "status": "completed", "note": "Review complete"}))
        self.assertEqual(len(sender.history(item.id).events), 3)
        self.assertEqual(final.status, "completed")
        with self.store.engine.connect() as connection:
            from vita_api.workflow_storage import missions
            self.assertEqual(connection.execute(select(missions.c.revision).where(missions.c.id == str(mission.id))).scalar_one(), mission.revision)
        _, outsider = self.member("outsider")
        self.assert_denied("handoff_not_found", Collaboration(self.store, outsider).history, item.id)

    def test_handoff_concurrency_and_revocation(self):
        mission, recipient, token, _, _, item = self.handoff(); receiver = Collaboration(self.store, token)
        def accept(_):
            try:
                return receiver.transition(item.id, HandoffTransition(request_id=uuid4(), expected_revision=1,
                    expected_mission_revision=mission.revision, status="accepted", note="Review")).revision
            except PolicyDenied as error:
                return error.code
        with ThreadPoolExecutor(2) as pool:
            self.assertCountEqual(list(pool.map(accept, range(2))), [2, "handoff_revision_changed"])
        with self.store.engine.begin() as connection:
            connection.execute(users.update().where(users.c.id == recipient.id).values(enabled=False))
        with self.assertRaises(PolicyDenied):
            receiver.history(item.id)

    def scenario(self):
        service = Intelligence(self.store, self.token)
        body = ScenarioRequest(request_id=uuid4(), pipeline_id=self.run.id,
            expected_snapshot_hash=self.request.expected_snapshot_hash, title="Support review",
            assumptions=("Support cases hypothetically zero; unverified.",), overrides=ScenarioOverrides(support_cases=0))
        return service, body, service.create_scenario(self.account_id, body)

    def test_scenario_determinism_no_fact_mutation_and_unapproved_promotion(self):
        before = self.snapshot(self.store); service, body, item = self.scenario()
        self.assertEqual(service.create_scenario(self.account_id, body), item)
        second = service.create_scenario(self.account_id, body.model_copy(update={"request_id": uuid4()}))
        self.assertEqual(item.projected, second.projected)
        after = self.snapshot(self.store)
        for table in before:
            if not table.startswith("intelligence_"):
                self.assertEqual(before[table], after[table], table)
        self.mission()
        request = ScenarioPromotion(expected_revision=1, expected_current_snapshot_hash=self.hash,
            assumption_acknowledgement="Unverified assumptions require review")
        promoted = service.promote(item.id, request)
        self.assertEqual(promoted.approval_status, "unapproved")
        self.assertIn(str(item.id), promoted.plan.alternatives[0].steps[0].content)
        self.assertEqual(service.promote(item.id, request), promoted)

    def test_scenario_conflicting_request_and_scope(self):
        service, body, item = self.scenario()
        self.assert_denied("scenario_request_conflict", service.create_scenario, self.account_id, body.model_copy(update={"title": "Changed"}))
        _, token = self.member("foreign", organization="foreign")
        self.assert_denied("intelligence_record_not_found", Intelligence(self.store, token).get_scenario, item.id)

    def test_trend_identical_observations_are_unchanged_without_slope(self):
        later = self.run.model_copy(update={"id": str(uuid4()), "started_at": self.run.started_at + timedelta(hours=1)})
        self.store.save_pipeline(later)
        body = TrendRequest(pipeline_ids=(self.run.id, later.id), start=fixtures.NOW - timedelta(days=30), end=datetime.now(UTC))
        service = Intelligence(self.store, self.token); result = service.create_trend(self.account_id, body)
        self.assertTrue(all(metric.per_day is None and metric.status == "unchanged" and metric.duplicate_count > 0 for metric in result.metrics))
        self.assertEqual(service.get_trend(result.id), result)
        self.assert_denied("trend_future_range", service.create_trend, self.account_id,
            body.model_copy(update={"end": datetime.now(UTC) + timedelta(days=1)}))

    def test_platform_identity_activity_replay_and_disable(self):
        config = PlatformSettings(enabled=True, tenant_id=uuid4(), audience=uuid4(), client_ids=(uuid4(),), web_origin="https://vita.example")
        principal = Principal(tenant_id=config.tenant_id, object_id=uuid4()); service = PlatformInterfaces(self.store, config)
        self.assert_denied("platform_identity_unbound", service.context, principal, self.account_id)
        body = IdentityBinding(tenant_id=principal.tenant_id, object_id=principal.object_id, user_id=self.actor.id, expected_revision=0, enabled=True)
        service.link(self.token, body)
        self.assertFalse(service.context(principal, self.account_id).execution_available)
        activity = TeamsActivity(activity_id="original", timestamp=datetime.now(UTC), tenant_id=principal.tenant_id,
            object_id=principal.object_id, account_id=self.account_id, type="message", command="context", conversation_type="personal")
        first = service.teams(principal, activity); self.assertEqual(service.teams(principal, activity), first)
        self.assert_denied("platform_activity_conflict", service.teams, principal, activity.model_copy(update={"timestamp": datetime.now(UTC)}))
        service.link(self.token, body.model_copy(update={"expected_revision": 1, "enabled": False}))
        self.assert_denied("platform_identity_unbound", service.context, principal, self.account_id)

    def test_http_strict_auth_and_safe_errors(self):
        settings = Settings(_env_file=None, auth_mode="session", database_url=self.store.engine.url.render_as_string(hide_password=False))
        with TestClient(create_app(settings, fixtures.NoInference())) as client:
            path = f"/api/intelligence/accounts/{self.account_id}/scenarios"
            self.assertEqual(client.get(path).status_code, 401); client.cookies.set("vitaai_session", self.token)
            self.assertEqual(client.get(path).json(), [])
            response = client.post(path, headers=fixtures.HEADERS, json={"actor": "PRIVATE_SENTINEL"})
            self.assertEqual(response.status_code, 422); self.assertNotIn("PRIVATE_SENTINEL", response.text)
            self.assertEqual(client.get(f"/api/platform/context/{self.account_id}").status_code, 503)
