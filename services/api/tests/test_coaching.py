"""Durable human coaching; isolated fixtures, no external calls."""
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from uuid import uuid4

import test_stage2 as stage2
import test_workflow_api as http
from pydantic import ValidationError
from sqlalchemy import select, update

from vita_api.governance import PolicyDenied
from vita_api.identity import users
from vita_api.storage import Store
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import CoachingRequest, OutcomeRequest
from vita_api.workflow_storage import (
    actions,
    claims,
    decisions,
    missions,
    outcomes,
    plans,
    receipts,
)


class CoachingTests(unittest.TestCase):
    setUp = stage2.Stage2Tests.setUp
    tearDown = stage2.Stage2Tests.tearDown
    prepare = stage2.Stage2Tests.prepare

    def complete(self):
        self.prepare()
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        self.report = OutcomeRequest(expected_revision=mission.revision, manual_action_reference="human:follow-up",
            kind="follow_up_required", basis="manual_report", evidence_ids=mission.evidence.evidence_ids,
            note="Human reported internal follow-up, no customer result verified.")
        self.outcome = self.workflow.outcome(self.seller.id, mission.id, self.report)
        self.mission = self.workflow.get_mission(self.seller.id, mission.id)
        return CoachingRequest(expected_revision=0, expected_mission_revision=self.mission.revision,
            outcome_id=self.outcome.id, expected_outcome_revision=self.outcome.revision,
            status="revision_required", note="  Clarify the evidence before the next conversation.\n ")

    def workflow_records(self):
        with self.store.engine.connect() as connection:
            return {table.name: list(connection.execute(select(table.c.payload)).scalars())
                    for table in (missions, outcomes, plans, actions, decisions, claims, receipts)}

    def test_history_reconstruction_and_no_action_authority(self):
        body = self.complete()
        before = self.workflow_records()
        first = self.workflow.review_coaching(self.reviewer.id, self.mission.id, body)
        second = self.workflow.review_coaching(self.reviewer.id, self.mission.id,
            body.model_copy(update={"expected_revision": 1, "status": "reviewed", "note": "Clarification reviewed."}))
        self.assertEqual(first.note, body.note)
        self.assertEqual(first.reviewer_id, self.reviewer.id)
        self.assertEqual((first.mission_revision, first.outcome_id, first.outcome_revision),
                         (self.mission.revision, self.outcome.id, self.outcome.revision))
        self.assertEqual(second.supersedes_id, first.id)
        self.assertEqual(second.revision, 2)
        self.assertEqual(self.workflow_records(), before)
        rebuilt = Store(self.store.engine.url.render_as_string(hide_password=False))
        try:
            rebuilt.initialize()
            service = Workflow(rebuilt, clock=lambda: self.now)
            self.assertEqual(service.list_coaching_reviews(self.seller.id, self.mission.id), [first, second])
            events = service.audit(self.reviewer.id, self.mission.id)
            self.assertEqual([item.actor_id for item in events if item.event_kind == "coaching_review_recorded"],
                             [self.reviewer.id, self.reviewer.id])
        finally:
            rebuilt.engine.dispose()

    def test_outcome_correction_requires_fresh_bindings_and_keeps_old_review(self):
        body = self.complete()
        first = self.workflow.review_coaching(self.reviewer.id, self.mission.id, body)
        corrected = self.workflow.outcome(self.seller.id, self.mission.id, self.report.model_copy(update={
            "expected_revision": self.mission.revision, "supersedes_id": self.outcome.id, "note": "Corrected report."}))
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        for changed in ({"expected_revision": 1}, {"expected_revision": 1, "expected_mission_revision": mission.revision},
                        {"expected_revision": 1, "expected_mission_revision": mission.revision,
                         "outcome_id": corrected.id}):
            with self.assertRaises(PolicyDenied):
                self.workflow.review_coaching(self.reviewer.id, mission.id, body.model_copy(update=changed))
        next_body = body.model_copy(update={"expected_revision": 1, "expected_mission_revision": mission.revision,
            "outcome_id": corrected.id, "expected_outcome_revision": corrected.revision})
        second = self.workflow.review_coaching(self.reviewer.id, mission.id, next_body)
        self.assertEqual(self.workflow.list_coaching_reviews(self.seller.id, mission.id), [first, second])
        self.assertEqual(first.outcome_id, self.outcome.id)
        self.assertEqual(second.outcome_id, corrected.id)

    def test_concurrent_review_and_replay_have_one_winner(self):
        body = self.complete()
        barrier = Barrier(2)
        def review(_):
            barrier.wait()
            try:
                return self.workflow.review_coaching(self.reviewer.id, self.mission.id, body)
            except PolicyDenied as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(review, range(2)))
        self.assertEqual(results.count("coaching_review_changed"), 1)
        self.assertEqual(len(self.workflow.list_coaching_reviews(self.seller.id, self.mission.id)), 1)
        with self.assertRaises(PolicyDenied):
            self.workflow.review_coaching(self.reviewer.id, self.mission.id, body)

    def test_roles_scope_and_revocation_rechecked(self):
        body = self.complete()
        viewer = self.identity.create_user("viewer", "test-password-long", self.seller.organization_id, "viewer")
        foreign = self.identity.create_user("foreign", "test-password-long", "foreign-org", "reviewer")
        for actor, expected in ((self.seller, 403), (viewer, 403), (foreign, 404)):
            with self.assertRaises(PolicyDenied) as denied:
                self.workflow.review_coaching(actor.id, self.mission.id, body)
            self.assertEqual(denied.exception.status_code, expected)
        self.assertEqual(self.workflow.list_coaching_reviews(viewer.id, self.mission.id), [])
        with self.assertRaises(PolicyDenied):
            self.workflow.list_coaching_reviews(foreign.id, self.mission.id)
        for field, value in (("role", "seller"), ("enabled", False), ("organization_id", "foreign-org")):
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.reviewer.id).values(**{field: value}))
            with self.assertRaises(PolicyDenied):
                self.workflow.review_coaching(self.reviewer.id, self.mission.id, body)
            with self.store.engine.begin() as connection:
                connection.execute(update(users).where(users.c.id == self.reviewer.id).values(
                    role="reviewer", enabled=True, organization_id=self.seller.organization_id))

    def test_noncompleted_missions_and_invalid_contracts_deny(self):
        body = self.complete()
        completed = self.mission
        self.prepare()
        body = body.model_copy(update={"expected_mission_revision": self.mission.revision})
        with self.assertRaises(PolicyDenied) as denied:
            self.workflow.review_coaching(self.reviewer.id, self.mission.id, body)
        self.assertEqual(denied.exception.code, "coaching_outcome_required")
        for changes in ({"expected_revision": -1}, {"expected_revision": True}, {"status": "approved"},
                        {"note": " "}, {"note": "x" * 2001}, {"note": "a\0b"},
                        {"reviewer_id": "asserted"}, {"mission_revision": 8}):
            with self.assertRaises(ValidationError):
                CoachingRequest.model_validate({**body.model_dump(), **changes})
        with self.assertRaises(PolicyDenied):
            self.workflow.review_coaching(self.reviewer.id, completed.id,
                body.model_copy(update={"expected_mission_revision": completed.revision, "outcome_id": uuid4()}))


class CoachingHttpTests(unittest.TestCase):
    setUp = http.WorkflowApiTests.setUp
    tearDown = http.WorkflowApiTests.tearDown
    login = http.WorkflowApiTests.login
    post = http.WorkflowApiTests.post
    create = http.WorkflowApiTests.create

    def test_session_routes_strict_body_and_saved_history(self):
        _, mission, _ = self.create()
        path = f'/api/missions/{mission["id"]}'
        current = self.client.get(path).json()
        outcome = self.post(path + "/outcomes", {"expected_revision": current["revision"],
            "manual_action_reference": "human:follow-up", "kind": "follow_up_required", "basis": "manual_report",
            "evidence_ids": current["evidence"]["evidence_ids"], "note": "Identified human follow-up."})
        current = self.client.get(path).json()
        body = {"expected_revision": 0, "expected_mission_revision": current["revision"],
            "outcome_id": outcome["id"], "expected_outcome_revision": outcome["revision"],
            "status": "reviewed", "note": "Human reviewed the report."}
        self.assertEqual(self.client.post(path + "/coaching-reviews", headers=http.HEADERS, json=body).status_code, 403)
        self.login("reviewer")
        for extra in ({"reviewer_id": "asserted"}, {"status": "approved"}, {"note": " "}):
            self.assertEqual(self.client.post(path + "/coaching-reviews", headers=http.HEADERS,
                json={**body, **extra}).status_code, 422)
        saved = self.post(path + "/coaching-reviews", body)
        self.assertEqual(self.client.get(path + "/coaching-reviews").json(), [saved])
        self.assertEqual(self.client.get(path).json(), current)
        self.assertEqual(self.client.post(path + "/coaching-reviews", headers=http.HEADERS, json=body).status_code, 409)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(path + "/coaching-reviews").status_code, 401)
        self.assertEqual(self.client.post(path + "/coaching-reviews", headers=http.HEADERS, json=body).status_code, 401)
        self.provider.assert_not_called()
