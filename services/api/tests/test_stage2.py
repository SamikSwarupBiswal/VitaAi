"""Real isolated database governance tests; every execution here is explicitly simulated."""
import os
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import patch
from uuid import uuid4

from sqlalchemy import create_engine, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.governance import PolicyDenied
from vita_api.identity import Identity, users
from vita_api.sample import SAMPLE_ORG, sample_records
from vita_api.scoring import assess
from vita_api.storage import Store, accounts
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import (
    ExecuteRequest,
    MissionRequest,
    NotePayload,
    OutcomeRequest,
    OutlookPayload,
    PlanRequest,
    PrepareRequest,
    ReviewRequest,
    SubmitRequest,
    TaskPayload,
)
from vita_api.workflow_storage import actions, audits, claims, decisions, resources

NOW = datetime(2026, 10, 15, 10, tzinfo=UTC)


class Stage2Tests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.pg_admin = None
        url = f"sqlite:///{Path(self.temp.name) / 'workflow.sqlite'}"
        if os.environ.get("VITAAI_POSTGRES_TEST_URL"):
            self.pg_admin = create_engine(os.environ["VITAAI_POSTGRES_TEST_URL"])
            self.schema = "vitaai_workflow_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(self.schema))
            url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + self.schema,
            }).render_as_string(hide_password=False)
        self.store = Store(url)
        self.store.initialize()
        self.store.seed(sample_records(NOW))
        self.identity = Identity(self.store.engine)
        self.seller = self.identity.create_user("seller", "test-password-long", SAMPLE_ORG, "seller")
        self.reviewer = self.identity.create_user("reviewer", "test-password-long", SAMPLE_ORG, "reviewer")
        self.now = NOW
        self.workflow = Workflow(self.store, clock=lambda: self.now)
        self.account = self.store.list_accounts(SAMPLE_ORG)[0]
        evidence = self.store.account_evidence(SAMPLE_ORG, self.account.id)
        self.snapshot = assess(self.account, evidence, NOW.date()).snapshot_hash

    def tearDown(self):
        self.store.engine.dispose()
        if self.pg_admin is not None:
            with self.pg_admin.begin() as connection:
                connection.execute(DropSchema(self.schema, cascade=True))
            self.pg_admin.dispose()
        self.temp.cleanup()

    def prepare(self, payload=None, template="account-action-1", connector="simulation-hubspot"):
        payload = payload or TaskPayload(title="Review account", body="Exact reviewed body\n ")
        self.plan = self.workflow.create_plan(self.seller.id, PlanRequest(
            account_id=self.account.id, expected_revision=1, expected_snapshot_hash=self.snapshot, intent="risk",
            action_kind=payload.kind))
        self.mission = self.workflow.create_mission(self.seller.id, MissionRequest(
            plan_id=self.plan.id, expected_revision=1, template=template))
        self.action = self.workflow.prepare(self.seller.id, self.mission.id, PrepareRequest(
            expected_revision=self.mission.revision, alternative_id=self.plan.selected_alternative_id,
            connector_id=connector, payload=payload))
        self.mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        return self.action

    def approve(self, **preparation):
        self.prepare(**preparation)
        self.action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash))
        self.decision = self.workflow.review(self.reviewer.id, self.action.id, ReviewRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash, decision="approved"))
        return ExecuteRequest(expected_revision=self.action.revision, decision_id=self.decision.id,
                              idempotency_key="request-1")

    def test_note_and_outlook_exact_readback_replay_and_restart(self):
        cases = [(NotePayload(body="Résumé: evidence\n "), "account-note-1", "simulation-hubspot"),
                 (OutlookPayload(to=("buyer@example.com", "owner@example.org"), subject=" Review ",
                                 body_text="Exact draft\n "), "account-outlook-draft-1", "simulation-microsoft")]
        for index, (payload, template, connector) in enumerate(cases):
            with self.subTest(kind=payload.kind):
                request = self.approve(payload=payload, template=template, connector=connector)
                request = request.model_copy(update={"idempotency_key": f"kind-{index}"})
                destination = self.action.destination
                if payload.kind == "outlook_draft_create":
                    self.assertEqual(destination.delegated_user_id, self.seller.id)
                    self.assertEqual(destination.mailbox_id, "simulation-mailbox:" + self.seller.id)
                else:
                    self.assertIsNone(destination.mailbox_id)
                # Reviewer/executor identity must never replace the preparer's mailbox.
                result = self.workflow.execute(self.reviewer.id, self.action.id, request)
                receipt = self.workflow.get_receipt(self.seller.id, result.receipt_id)
                self.assertEqual((result.status, receipt.mode, receipt.verification),
                                 ("succeeded", "simulation", "verified"))
                self.assertEqual(receipt.destination, destination)
                restarted = Workflow(self.store, clock=lambda: self.now)
                self.assertEqual(restarted.get_action(self.seller.id, self.action.id).payload, payload)
                self.assertEqual(restarted.execute(self.seller.id, self.action.id, request), result)
                with self.assertRaises(PolicyDenied):
                    restarted.execute(self.seller.id, self.action.id,
                                      request.model_copy(update={"idempotency_key": f"another-{index}"}))
                with self.store.engine.connect() as connection:
                    canonical = connection.execute(select(resources.c.canonical_payload).where(
                        resources.c.execution_id == str(result.id))).scalar_one()
                    self.assertEqual(canonical, restarted.canonical_payload(self.seller.id, self.action.id))

    def test_template_kind_and_connector_must_match_plan(self):
        self.prepare()
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.create_mission(self.seller.id, MissionRequest(
                plan_id=self.plan.id, expected_revision=1, template="account-note-1"))
        self.assertEqual(failure.exception.code, "template_plan_mismatch")
        for payload, connector in [(NotePayload(body="unplanned"), "simulation-hubspot"),
                                   (TaskPayload(title="x", body="x"), "simulation-microsoft"),
                                   (TaskPayload(title="x", body="x"), "live-hubspot")]:
            with self.subTest(kind=payload.kind, connector=connector), self.assertRaises(PolicyDenied):
                self.workflow.prepare(self.seller.id, self.mission.id, PrepareRequest(
                    expected_revision=self.mission.revision, alternative_id=self.plan.selected_alternative_id,
                    connector_id=connector, payload=payload))

    def test_outlook_edits_invalidate_approval_and_preserve_slot_history(self):
        original = OutlookPayload(to=("first@example.com", "second@example.com"), subject="Review", body_text="Draft")
        request = self.approve(payload=original, template="account-outlook-draft-1", connector="simulation-microsoft")
        for changes in ({"to": tuple(reversed(original.to))}, {"subject": "Changed"}, {"body_text": "Draft\n "}):
            mission = self.workflow.get_mission(self.seller.id, self.mission.id)
            previous = self.action
            self.action = self.workflow.prepare(self.seller.id, mission.id, PrepareRequest(
                expected_revision=mission.revision, alternative_id=self.plan.selected_alternative_id,
                connector_id="simulation-microsoft", payload=original.model_copy(update=changes)))
            self.assertEqual(self.action.slot_id, previous.slot_id)
            self.assertNotEqual(self.action.binding_hash, previous.binding_hash)
            with self.assertRaises(PolicyDenied):
                self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(self.workflow.action_history(self.seller.id, self.action.id)[1].payload, original)
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(resources.c.id)).first())

    def test_outlook_mailbox_configuration_change_blocks_creation(self):
        request = self.approve(payload=OutlookPayload(to=("buyer@example.com",), subject="Review", body_text="Draft"),
                               template="account-outlook-draft-1", connector="simulation-microsoft")
        resolve = self.workflow._destination

        def changed(*args, **kwargs):
            return resolve(*args, **kwargs).model_copy(update={"mailbox_id": "another-mailbox",
                                                              "configuration_revision": 2})

        with patch.object(self.workflow, "_destination", side_effect=changed), self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(claims.c.id)).first())

    def test_note_and_outlook_retain_authorization_and_uncertainty(self):
        viewer = self.identity.create_user("viewer-kinds", "test-password-long", SAMPLE_ORG, "viewer")
        for index, (payload, template, connector) in enumerate([
                (NotePayload(body="Evidence"), "account-note-1", "simulation-hubspot"),
                (OutlookPayload(to=("buyer@example.com",), subject="Review", body_text="Draft"),
                 "account-outlook-draft-1", "simulation-microsoft")]):
            request = self.approve(payload=payload, template=template, connector=connector)
            request = request.model_copy(update={"idempotency_key": f"timeout-{index}"})
            with self.assertRaises(PolicyDenied):
                self.workflow.execute(viewer.id, self.action.id, request)
            self.workflow.simulation_profile = "timeout_after"
            execution = self.workflow.execute(self.seller.id, self.action.id, request)
            self.assertEqual(execution.status, "result_unknown")
            self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, request), execution)
            reconciled = self.workflow.reconcile(self.reviewer.id, execution.id, execution.revision)
            self.assertEqual(reconciled.status, "succeeded")

    def test_outlook_preparer_change_requires_new_mailbox_review(self):
        payload = OutlookPayload(to=("buyer@example.com",), subject="Review", body_text="Draft")
        request = self.approve(payload=payload, template="account-outlook-draft-1", connector="simulation-microsoft")
        another = self.identity.create_user("another-seller", "test-password-long", SAMPLE_ORG, "seller")
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        edited = self.workflow.prepare(another.id, mission.id, PrepareRequest(
            expected_revision=mission.revision, alternative_id=self.plan.selected_alternative_id,
            connector_id="simulation-microsoft", payload=payload))
        self.assertEqual(edited.slot_id, self.action.slot_id)
        self.assertEqual(edited.destination.delegated_user_id, another.id)
        self.assertNotEqual(edited.binding_hash, self.action.binding_hash)
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(another.id, edited.id, request.model_copy(update={"expected_revision": edited.revision}))
        submitted = self.workflow.submit(another.id, edited.id, SubmitRequest(
            expected_revision=edited.revision, binding_hash=edited.binding_hash))
        decision = self.workflow.review(self.reviewer.id, edited.id, ReviewRequest(
            expected_revision=submitted.revision, binding_hash=submitted.binding_hash, decision="approved"))
        # A subsequent organization transfer invalidates the reviewed mailbox even for another executor.
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == another.id).values(organization_id="other-org"))
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.execute(self.seller.id, edited.id, ExecuteRequest(
                expected_revision=submitted.revision, decision_id=decision.id, idempotency_key="mailbox-transfer"))
        self.assertEqual(failure.exception.code, "mailbox_membership_changed")
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(resources.c.id)).first())

    def test_simulation_receipt_independent_outcome_and_restart(self):
        body = self.approve()
        execution = self.workflow.execute(self.seller.id, self.action.id, body)
        self.assertEqual(execution.status, "succeeded")
        receipt = self.workflow.get_receipt(self.seller.id, execution.receipt_id)
        self.assertEqual((receipt.mode, receipt.verification), ("simulation", "verified"))
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        self.assertEqual(mission.status, "executed")
        outcome = self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(
            expected_revision=mission.revision, receipt_id=receipt.id, kind="follow_up_required", basis="manual_report",
            evidence_ids=self.plan.evidence.evidence_ids, note="Simulation reviewed; no customer contact occurred."))
        self.assertEqual(outcome.report.kind, "follow_up_required")
        self.store.initialize()
        restarted = Workflow(self.store, clock=lambda: self.now)
        self.assertEqual(restarted.get_execution(self.seller.id, execution.id), execution)
        self.assertEqual(restarted.get_mission(self.seller.id, mission.id).status, "completed")
        events = restarted.audit(self.seller.id, mission.id)
        self.assertTrue(any(event.event_kind == "outcome_recorded" for event in events))
        self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, body).id, execution.id)
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(resources.c.canonical_payload)).scalar(),
                             self.workflow.canonical_payload(self.seller.id, self.action.id))

    def test_missing_rejected_revision_and_expired_approval_cannot_claim(self):
        self.prepare()
        request = ExecuteRequest(expected_revision=1, decision_id=uuid4(), idempotency_key="not-approved")
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)
        self.action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=1, binding_hash=self.action.binding_hash))
        decision = self.workflow.review(self.reviewer.id, self.action.id, ReviewRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash,
            decision="rejected", reason="Content needs correction"))
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request.model_copy(update={
                "expected_revision": self.action.revision, "decision_id": decision.id}))
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(claims.c.id)).first())

    def test_expiry_and_reviewer_revocation_rechecked_from_database(self):
        request = self.approve()
        self.now = NOW + timedelta(minutes=30)
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)
        self.now = NOW
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == self.reviewer.id).values(enabled=False))
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)

    def test_session_revoked_after_claim_cannot_begin_dispatch(self):
        request = self.approve()
        _, token = self.identity.login("seller", "test-password-long", 8)
        self.workflow.session_token = token
        self.workflow.session_required = True
        claimed, _ = self.workflow.claim(self.seller.id, self.action.id, request)
        self.identity.logout(token)
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.mark_dispatching(self.seller.id, claimed.id)
        self.assertEqual(failure.exception.status_code, 401)
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(resources.c.id)).first())

    def test_actor_and_cross_organization_reads_and_reviews(self):
        self.prepare()
        outsider = self.identity.create_user("outsider", "test-password-long", "other-org", "admin")
        viewer = self.identity.create_user("viewer", "test-password-long", SAMPLE_ORG, "viewer")
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.get_mission(outsider.id, self.mission.id)
        self.assertEqual(failure.exception.status_code, 404)
        for actor in (viewer, self.seller):
            with self.subTest(role=actor.role), self.assertRaises(PolicyDenied):
                self.workflow.review(actor.id, self.action.id, ReviewRequest(expected_revision=1,
                    binding_hash=self.action.binding_hash, decision="approved"))
        with self.assertRaises(PolicyDenied):
            self.workflow.prepare(viewer.id, self.mission.id, PrepareRequest(expected_revision=self.mission.revision,
                alternative_id=self.plan.selected_alternative_id, connector_id="simulation-hubspot",
                payload=TaskPayload(title="x", body="body")))
        self.assertEqual(self.workflow.get_mission(viewer.id, self.mission.id).id, self.mission.id)

    def test_edit_supersedes_submission_and_binds_new_content(self):
        request = self.approve()
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        edited = self.workflow.prepare(self.seller.id, mission.id, PrepareRequest(
            expected_revision=mission.revision, alternative_id=self.plan.selected_alternative_id,
            connector_id="simulation-hubspot", payload=TaskPayload(title="Review account", body="Edited body")))
        self.assertEqual(edited.slot_id, self.action.slot_id)
        self.assertNotEqual(edited.binding_hash, self.action.binding_hash)
        self.assertGreater(edited.revision, self.action.revision)
        history = self.workflow.action_history(self.seller.id, edited.id)
        self.assertEqual([item.revision for item in history], [1, 2, 3])
        self.assertEqual(history[1].payload.body, "Exact reviewed body\n ")
        self.assertEqual(history[-1].payload.body, "Edited body")
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, edited.id, request)
        events = self.workflow.audit(self.seller.id, mission.id)
        self.assertTrue(any(event.event_kind == "approval_invalidated" for event in events))
        self.assertEqual([event.sequence for event in events], sorted(event.sequence for event in events))

    def test_changed_account_snapshot_or_destination_blocks_execution(self):
        request = self.approve()
        with self.store.engine.begin() as connection:
            payload = self.account.model_copy(update={"revision": 2}).model_dump(mode="json")
            connection.execute(update(accounts).where(accounts.c.id == self.account.id).values(revision=2, payload=payload))
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)

    def test_concurrent_review_and_execution_arbitrated_by_database(self):
        self.prepare()
        self.action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=1, binding_hash=self.action.binding_hash))
        barrier = Barrier(2)

        def review():
            barrier.wait()
            try:
                return self.workflow.review(self.reviewer.id, self.action.id, ReviewRequest(
                    expected_revision=self.action.revision, binding_hash=self.action.binding_hash, decision="approved"))
            except PolicyDenied:
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: review(), range(2)))
        accepted = [item for item in results if item]
        self.assertEqual(len(accepted), 1)
        barrier = Barrier(2)

        def execute():
            barrier.wait()
            return self.workflow.execute(self.seller.id, self.action.id, ExecuteRequest(
                expected_revision=self.action.revision, decision_id=accepted[0].id, idempotency_key="concurrent"))

        with ThreadPoolExecutor(max_workers=2) as pool:
            executions = list(pool.map(lambda _: execute(), range(2)))
        self.assertEqual(executions[0].id, executions[1].id)
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(claims)).all()), 1)
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)
            self.assertEqual(len(connection.execute(select(decisions)).all()), 1)

    def test_new_key_cannot_repeat_logical_action_and_old_key_cannot_change_binding(self):
        request = self.approve()
        result = self.workflow.execute(self.seller.id, self.action.id, request)
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request.model_copy(update={"idempotency_key": "new-key"}))
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request.model_copy(update={"expected_revision": 999}))
        self.assertEqual(self.workflow.get_execution(self.seller.id, result.id).status, "succeeded")

    def test_post_dispatch_timeout_restart_and_read_only_reconciliation(self):
        self.workflow.simulation_profile = "timeout_after"
        request = self.approve()
        result = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(result.status, "result_unknown")
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        self.assertEqual(mission.status, "reconciliation_required")
        with self.assertRaises(PolicyDenied):
            self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(expected_revision=mission.revision,
                receipt_id=result.receipt_id, kind="customer_contacted", basis="manual_report",
                evidence_ids=self.plan.evidence.evidence_ids, note="Cannot assert unknown completion"))
        restarted = Workflow(self.store, clock=lambda: self.now)
        reconciled = restarted.reconcile(self.reviewer.id, result.id, result.revision)
        self.assertEqual(reconciled.status, "succeeded")
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)
        with self.assertRaises(PolicyDenied):
            restarted.execute(self.seller.id, self.action.id, request.model_copy(update={"idempotency_key": "new"}))

    def test_restart_dispatching_retains_unknown_without_blind_retry(self):
        request = self.approve()
        claimed, owner = self.workflow.claim(self.seller.id, self.action.id, request)
        self.assertTrue(owner)
        self.workflow.mark_dispatching(self.seller.id, claimed.id)
        restarted = Workflow(self.store, clock=lambda: self.now)
        result = restarted.reconcile(self.reviewer.id, claimed.id, 2)
        self.assertEqual(result.status, "result_unknown")
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), 0)
            self.assertEqual(len(connection.execute(select(claims)).all()), 1)

    def test_definite_rejection_is_not_success(self):
        self.workflow.simulation_profile = "reject"
        request = self.approve()
        result = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(result.status, "failed")
        self.assertEqual(self.workflow.get_mission(self.seller.id, self.mission.id).status, "execution_failed")

    def test_claimed_recovery_and_explicit_retry_preserve_claim(self):
        request = self.approve()
        claimed, _ = self.workflow.claim(self.seller.id, self.action.id, request)
        restarted = Workflow(self.store, clock=lambda: self.now)
        failed = restarted.reconcile(self.reviewer.id, claimed.id, claimed.revision)
        self.assertEqual(failed.status, "failed")
        retried = restarted.retry(self.seller.id, failed.id, request.model_copy(update={"expected_revision": failed.revision}))
        self.assertEqual((retried.id, retried.attempt, retried.status), (claimed.id, 2, "succeeded"))
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(claims)).all()), 1)
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)

    def test_expired_pre_dispatch_retry_is_denied(self):
        request = self.approve()
        claimed, _ = self.workflow.claim(self.seller.id, self.action.id, request)
        failed = self.workflow.reconcile(self.reviewer.id, claimed.id, claimed.revision)
        self.now = NOW + timedelta(minutes=30)
        with self.assertRaises(PolicyDenied):
            self.workflow.retry(self.seller.id, failed.id, request.model_copy(update={"expected_revision": failed.revision}))

    def test_active_reconciliation_prevents_later_dispatch(self):
        request = self.approve()
        original = self.workflow.mark_dispatching

        def reconcile_after_dispatch_mark(actor_id, execution_id):
            dispatched = original(actor_id, execution_id)
            self.workflow.reconcile(self.reviewer.id, execution_id, dispatched.revision)
            return dispatched

        with patch.object(self.workflow, "mark_dispatching", side_effect=reconcile_after_dispatch_mark):
            result = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(result.status, "result_unknown")
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), 0)

    def test_reconciled_completion_wins_over_original_timeout(self):
        request = self.approve()
        self.workflow.simulation_profile = "timeout_after"
        original = self.workflow._transaction
        count = 0

        @contextmanager
        def transaction_boundary(*args, **kwargs):
            nonlocal count
            count += 1
            current = count
            with original(*args, **kwargs) as values:
                yield values
            if current == 3:  # Resource committed; original execution has not recorded timeout yet.
                reconciler = Workflow(self.store, clock=lambda: self.now)
                with self.store.engine.connect() as connection:
                    execution_id = connection.execute(select(claims.c.id)).scalar_one()
                result = reconciler.get_execution(self.reviewer.id, execution_id)
                result = reconciler.reconcile(self.reviewer.id, execution_id, result.revision)
                mission = reconciler.get_mission(self.seller.id, self.mission.id)
                reconciler.outcome(self.seller.id, mission.id, OutcomeRequest(expected_revision=mission.revision,
                    receipt_id=result.receipt_id, kind="follow_up_required", basis="manual_report",
                    evidence_ids=self.plan.evidence.evidence_ids, note="Reviewed simulated completion"))

        with patch.object(self.workflow, "_transaction", side_effect=transaction_boundary):
            result = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(result.status, "succeeded")
        self.assertEqual(self.workflow.get_mission(self.seller.id, self.mission.id).status, "completed")

    def test_review_uses_one_timestamp_for_validity_interval(self):
        self.prepare()
        action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash))
        ticks = iter(range(100))
        self.workflow.clock = lambda: NOW + timedelta(microseconds=next(ticks))
        decision = self.workflow.review(self.reviewer.id, action.id, ReviewRequest(expected_revision=action.revision,
            binding_hash=action.binding_hash, decision="approved"))
        self.assertEqual(decision.expires_at - decision.decided_at, timedelta(minutes=30))

    def test_readback_mismatch_never_verifies_or_repeats_write(self):
        self.workflow.simulation_profile = "mismatch"
        request = self.approve()
        result = self.workflow.execute(self.seller.id, self.action.id, request)
        self.assertEqual(result.status, "result_unknown")
        receipt = self.workflow.get_receipt(self.seller.id, result.receipt_id)
        self.assertEqual(receipt.verification, "mismatch")
        result = self.workflow.reconcile(self.reviewer.id, result.id, result.revision)
        self.assertEqual(result.status, "result_unknown")
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)

    def test_audit_failure_rolls_back_claim_and_mission(self):
        request = self.approve()
        before = self.workflow.get_mission(self.seller.id, self.mission.id)
        with (patch.object(self.workflow, "_audit", side_effect=RuntimeError("injected storage failure")),
              self.assertRaises(RuntimeError)):
            self.workflow.claim(self.seller.id, self.action.id, request)
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(claims.c.id)).first())
        self.assertEqual(self.workflow.get_mission(self.seller.id, self.mission.id), before)

    def test_cross_organization_foreign_key_is_enforced(self):
        self.prepare()
        with self.assertRaises(IntegrityError), self.store.engine.begin() as connection:
            connection.execute(actions.insert().values(id=str(uuid4()), organization_id="other-org", revision=1,
                payload=self.action.model_dump(mode="json"), mission_id=str(self.mission.id),
                plan_id=str(self.plan.id), slot_id=str(uuid4()), canonical_payload="{}"))

    def test_concurrent_different_keys_cannot_claim_same_action(self):
        request = self.approve()
        barrier = Barrier(2)

        def execute(key):
            barrier.wait()
            try:
                return self.workflow.execute(self.seller.id, self.action.id,
                                             request.model_copy(update={"idempotency_key": key}))
            except PolicyDenied as failure:
                self.assertEqual(failure.code, "logical_action_claimed")
                return None

        with ThreadPoolExecutor(max_workers=2) as pool:
            result = list(pool.map(execute, ("key-a", "key-b")))
        self.assertEqual(sum(item is not None for item in result), 1)
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(claims)).all()), 1)
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)

    def test_direct_payload_tampering_and_audit_rollback(self):
        request = self.approve()
        with self.store.engine.begin() as connection:
            payload = connection.execute(select(actions.c.payload).where(actions.c.id == str(self.action.id))).scalar_one()
            payload["payload"]["body"] = "tampered"
            connection.execute(update(actions).where(actions.c.id == str(self.action.id)).values(payload=payload))
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, self.action.id, request)
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(claims.c.id)).first())
            self.assertFalse(any(row[0]["event_kind"] == "execution_claimed"
                                 for row in connection.execute(select(audits.c.payload))))
