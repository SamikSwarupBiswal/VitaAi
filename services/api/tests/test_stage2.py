"""Real isolated database governance tests; every execution here is explicitly simulated."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Barrier
from unittest.mock import Mock, patch
from uuid import uuid4

from alembic import command
from alembic.config import Config
from sqlalchemy import MetaData, create_engine, inspect, select, update
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.schema import CreateSchema, DropSchema

from vita_api.contracts import ModelRun
from vita_api.governance import PolicyDenied, check_plan
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
    PlanningOutput,
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

    def multi(self, choice_index=0):
        plan = self.workflow.create_plan(self.seller.id, PlanRequest(
            account_id=self.account.id, expected_revision=1, expected_snapshot_hash=self.snapshot,
            intent="risk", strategy="follow_up"))
        self.assertEqual(len(plan.alternatives), 2)
        choice = plan.alternatives[choice_index]
        mission = self.workflow.create_mission(self.seller.id, MissionRequest(
            plan_id=plan.id, expected_revision=1, template="account-follow-up-1", alternative_id=choice.id))
        for step in choice.steps:
            payload = (TaskPayload(title="Exact task", body="Task\n ") if step.kind == "hubspot_task_create" else
                       OutlookPayload(to=("buyer@example.com",), subject="Exact draft", body_text="Draft\n ")
                       if step.kind == "outlook_draft_create" else NotePayload(body="Exact note\n "))
            self.workflow.prepare(self.seller.id, mission.id, PrepareRequest(
                expected_revision=mission.revision, alternative_id=choice.id, step_id=step.id,
                connector_id="simulation-microsoft" if step.kind == "outlook_draft_create" else "simulation-hubspot",
                payload=payload))
            mission = self.workflow.get_mission(self.seller.id, mission.id)
        by_step = {action.step_id: action for action in self.workflow.list_actions(self.seller.id, mission.id)}
        requests = []
        for step in choice.steps:
            action = by_step[step.id]
            action = self.workflow.submit(self.seller.id, action.id, SubmitRequest(
                expected_revision=action.revision, binding_hash=action.binding_hash))
            decision = self.workflow.review(self.reviewer.id, action.id, ReviewRequest(
                expected_revision=action.revision, binding_hash=action.binding_hash, decision="approved"))
            requests.append((action, ExecuteRequest(expected_revision=action.revision,
                decision_id=decision.id, idempotency_key=str(action.id))))
        return plan, mission, requests

    def planning_run(self, view, intent, action_kind, strategy):
        step, choice = uuid4(), uuid4()
        output = PlanningOutput.model_validate({"intent": intent, "action_kind": action_kind, "strategy": strategy,
            "alternatives": [{"id": choice, "rationale": "Evidence-linked proposal", "risks": ["Simulation only"],
                "evidence_ids": [view.evidence[0].id], "steps": [{"id": step, "kind": action_kind,
                    "content": "Model recommendation\n ", "evidence_ids": [view.evidence[0].id]}]}],
            "selected_alternative_id": choice, "caveats": ["Requires human review"]})
        return ModelRun(id=str(uuid4()), organization_id=view.account.organization_id, account_id=view.account.id,
            account_revision=view.account.revision, snapshot_hash=view.assessment.snapshot_hash, model="fixture-only",
            task="planning", status="succeeded", validation="schema_and_references_valid", started_at=NOW,
            latency_ms=1, planning=output, request_id="fixture-planning", input_tokens=10, output_tokens=20)

    def test_action_recovery_reads_are_scoped_durable_and_do_not_mutate(self):
        request = self.approve()
        self.assertEqual(self.workflow.list_executions(self.seller.id, self.action.id), [])
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        before = self.workflow.audit(self.seller.id, self.mission.id)
        restarted = Workflow(self.store, clock=lambda: self.now)
        self.assertEqual(restarted.list_decisions(self.seller.id, self.action.id), [self.decision])
        self.assertEqual(restarted.list_executions(self.reviewer.id, self.action.id), [execution])
        self.assertEqual(restarted.audit(self.seller.id, self.mission.id), before)
        foreign = self.identity.create_user("foreign", "test-password-long", "other-org", "viewer")
        for operation in (restarted.list_decisions, restarted.list_executions):
            for action_id in (self.action.id, uuid4()):
                with self.assertRaises(PolicyDenied) as error:
                    operation(foreign.id, action_id)
                self.assertEqual(error.exception.status_code, 404)

    def planning_request(self, **changes):
        return PlanRequest(account_id=self.account.id, expected_revision=1, expected_snapshot_hash=self.snapshot,
                           intent="risk", **changes)

    def test_model_planning_persists_exact_output_without_approval(self):
        provider = Mock()
        provider.plan.side_effect = self.planning_run
        workflow = Workflow(self.store, clock=lambda: self.now, provider=provider)
        run = workflow.generate_plan(self.seller.id, self.planning_request())
        self.assertEqual(run.status, "succeeded")
        restarted = Workflow(self.store, clock=lambda: self.now)
        self.assertEqual(restarted.get_planning_run(self.seller.id, run.id), run)
        plan = restarted.create_plan(self.seller.id, self.planning_request(model_run_id=run.id))
        self.assertEqual((plan.source, str(plan.model_run_id)), ("model", run.id))
        self.assertEqual(plan.alternatives, run.planning.alternatives)
        self.assertIn("Requires human review", plan.caveats)
        mission = restarted.create_mission(self.seller.id, MissionRequest(
            plan_id=plan.id, expected_revision=1, template="account-action-1"))
        self.assertEqual(mission.status, "draft")
        action = restarted.prepare(self.seller.id, mission.id, PrepareRequest(expected_revision=mission.revision,
            alternative_id=plan.selected_alternative_id, connector_id="simulation-hubspot",
            payload=TaskPayload(title="Reviewed title", body="Human edits model recommendation")))
        with self.assertRaises(PolicyDenied):
            restarted.execute(self.seller.id, action.id, ExecuteRequest(expected_revision=action.revision,
                decision_id=uuid4(), idempotency_key="no-model-approval"))
        view = provider.plan.call_args.args[0]
        changed = plan.model_copy(update={"selected_alternative_id": uuid4()})
        with self.assertRaises(PolicyDenied):
            check_plan(changed, view, run)

    def test_model_planning_denies_wrong_task_request_and_scope(self):
        provider = Mock()
        provider.plan.side_effect = self.planning_run
        workflow = Workflow(self.store, clock=lambda: self.now, provider=provider)
        run = workflow.generate_plan(self.seller.id, self.planning_request())
        with self.assertRaises(PolicyDenied):
            workflow.create_plan(self.seller.id, self.planning_request(model_run_id=run.id, action_kind="hubspot_note_create"))
        foreign = self.identity.create_user("foreign-plan", "test-password-long", "other-org", "seller")
        with self.assertRaises(PolicyDenied):
            workflow.get_planning_run(foreign.id, run.id)
        with self.store.engine.begin() as connection:
            from vita_api.storage import runs
            connection.execute(update(runs).where(runs.c.id == run.id).values(
                payload={**run.model_dump(mode="json"), "task": "analysis", "planning": None}))
        with self.assertRaises(PolicyDenied):
            workflow.create_plan(self.seller.id, self.planning_request(model_run_id=run.id))

    def test_model_planning_failure_untrusted_output_and_no_call_denials(self):
        provider = Mock()
        workflow = Workflow(self.store, clock=lambda: self.now, provider=provider)
        viewer = self.identity.create_user("plan-viewer", "test-password-long", SAMPLE_ORG, "viewer")
        for actor, body in ((viewer.id, self.planning_request()),
                            (self.seller.id, self.planning_request().model_copy(update={"expected_revision": 99})),
                            (self.seller.id, self.planning_request().model_copy(update={"intent": "monitor"}))):
            with self.assertRaises(PolicyDenied):
                workflow.generate_plan(actor, body)
        provider.plan.assert_not_called()
        for change in ({"task": "analysis"}, {"snapshot_hash": "0" * 64}, {"organization_id": "foreign"},
                       {"planning": None}, {"validation": "not_run"}):
            provider.plan.side_effect = lambda *args, changes=change: self.planning_run(*args).model_copy(update=changes)
            run = workflow.generate_plan(self.seller.id, self.planning_request())
            self.assertEqual((run.status, run.validation, run.planning), ("invalid_output", "rejected", None))
            self.assertEqual(workflow.get_planning_run(self.seller.id, run.id), run)
            with self.assertRaises(PolicyDenied):
                workflow.create_plan(self.seller.id, self.planning_request(model_run_id=run.id))
        provider.plan.side_effect = RuntimeError("sentinel-provider-secret")
        failed = workflow.generate_plan(self.seller.id, self.planning_request())
        self.assertEqual(failed.status, "failed")
        self.assertNotIn("sentinel-provider-secret", failed.model_dump_json())
        unconfigured = self.workflow.generate_plan(self.seller.id, self.planning_request())
        self.assertEqual(unconfigured.status, "unconfigured")

    def test_model_planning_rechecks_snapshot_after_network_and_isolates_input(self):
        provider = Mock()
        workflow = Workflow(self.store, clock=lambda: self.now, provider=provider)

        def mutate_input(view, *args):
            run = self.planning_run(view, *args)
            view.account.revision = 999
            return run

        provider.plan.side_effect = mutate_input
        run = workflow.generate_plan(self.seller.id, self.planning_request())
        self.assertEqual(run.account_revision, 1)
        self.assertEqual(run.status, "succeeded")

        def change_account(view, *args):
            run = self.planning_run(view, *args)
            with self.store.engine.begin() as connection:
                changed = self.account.model_copy(update={"revision": 2})
                connection.execute(update(accounts).where(accounts.c.id == self.account.id).values(
                    revision=2, payload=changed.model_dump(mode="json")))
            return run

        provider.plan.side_effect = change_account
        stale = workflow.generate_plan(self.seller.id, self.planning_request())
        self.assertEqual((stale.status, stale.error_code), ("invalid_output", "planning_context_changed"))
        self.assertEqual(stale.account_revision, 1)
        self.assertIsNone(stale.planning)

    def test_planning_history_does_not_replace_latest_account_analysis(self):
        from vita_api.storage import runs
        with self.store.engine.connect() as connection:
            view = self.workflow._view(connection, self.seller, self.account.id)
        historical = self.planning_run(view, "risk", "hubspot_task_create", "single_action").model_copy(
            update={"task": "analysis", "planning": None, "started_at": NOW - timedelta(minutes=1)})
        self.store.save_run(historical)
        # Pre-task-discriminator rows must retain the historical default analysis semantics.
        with self.store.engine.begin() as connection:
            payload = historical.model_dump(mode="json")
            payload.pop("task")
            connection.execute(update(runs).where(runs.c.id == historical.id).values(payload=payload))
        generated = self.workflow.generate_plan(self.seller.id, self.planning_request())
        self.assertEqual(generated.status, "unconfigured")
        self.assertEqual(self.store.latest_run(SAMPLE_ORG, self.account.id), historical)

    def test_multi_dependencies_replay_and_outcome_aggregation(self):
        for index in (0, 1):
            plan, mission, ((first, request), (second, dependent)) = self.multi(index)
            with self.assertRaises(PolicyDenied) as failure:
                self.workflow.execute(self.seller.id, second.id, dependent)
            self.assertEqual(failure.exception.code, "dependency_not_satisfied")
            result = self.workflow.execute(self.seller.id, first.id, request)
            self.assertEqual(result.status, "succeeded")
            self.assertNotEqual(self.workflow.get_mission(self.seller.id, mission.id).status, "executed")
            with self.assertRaises(PolicyDenied):
                self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(
                    expected_revision=self.workflow.get_mission(self.seller.id, mission.id).revision,
                    receipt_id=result.receipt_id, kind="follow_up_required", basis="manual_report",
                    evidence_ids=plan.evidence.evidence_ids, note="Not finished"))
            restarted = Workflow(self.store, clock=lambda: self.now)
            self.assertEqual(restarted.execute(self.seller.id, first.id, request), result)
            result2 = restarted.execute(self.seller.id, second.id, dependent)
            self.assertEqual(result2.status, "succeeded")
            self.assertEqual(restarted.get_mission(self.seller.id, mission.id).status, "executed")
            self.assertNotEqual(first.slot_id, second.slot_id)
            with self.assertRaises(PolicyDenied):
                restarted.execute(self.seller.id, second.id, dependent.model_copy(update={"idempotency_key": "new"}))

    def test_upgrade_0003_preserves_unknown_claim_and_history(self):
        request = self.approve()
        self.workflow.simulation_profile = "timeout_after"
        execution = self.workflow.execute(self.seller.id, self.action.id, request)
        snapshot = {}
        source = MetaData()
        source.reflect(self.store.engine)
        with self.store.engine.connect() as connection:
            for table in source.sorted_tables:
                if table.name != "alembic_version":
                    snapshot[table.name] = [dict(row) for row in connection.execute(select(table)).mappings()]
        for table_name in ("workflow_actions", "workflow_missions", "workflow_versions"):
            for row in snapshot[table_name]:
                row["payload"].pop("step_id", None)
                row["payload"].pop("alternative_id", None)
        # Construct a populated historical schema without depending on a downgrade implementation.
        legacy_schema = None
        legacy_url = f"sqlite:///{Path(self.temp.name) / 'legacy.sqlite'}"
        if self.pg_admin is not None:
            legacy_schema = "vitaai_legacy_" + uuid4().hex
            with self.pg_admin.begin() as connection:
                connection.execute(CreateSchema(legacy_schema))
            legacy_url = make_url(os.environ["VITAAI_POSTGRES_TEST_URL"]).update_query_dict({
                "options": "-csearch_path=" + legacy_schema,
            }).render_as_string(hide_password=False)
        legacy = Store(legacy_url)
        config = Config()
        config.set_main_option("script_location", str(Path(__file__).parents[1] / "migrations"))
        try:
            with legacy.engine.begin() as connection:
                config.attributes["connection"] = connection
                command.upgrade(config, "0003")
            old = MetaData()
            old.reflect(legacy.engine)
            with legacy.engine.begin() as connection:
                for table in old.sorted_tables:
                    if snapshot.get(table.name):
                        connection.execute(table.insert(), [
                            {key: value for key, value in row.items() if key in table.c}
                            for row in snapshot[table.name]])
            legacy.initialize()
            self.assertIn("step_id", {column["name"] for column in inspect(legacy.engine).get_columns("workflow_actions")})
            preserved = MetaData()
            preserved.reflect(legacy.engine)
            with legacy.engine.connect() as connection:
                for name, rows in snapshot.items():
                    columns = [column for column in preserved.tables[name].c if column.name in source.tables[name].c]
                    actual = [dict(row) for row in connection.execute(select(*columns)).mappings()]
                    if name == "workflow_actions":
                        # Historical 0003 rows did not have this column; it remains nullable for their exact hashes.
                        for row in actual:
                            row["step_id"] = None
                    self.assertEqual(sorted(actual, key=lambda row: str(row.get("id", row))),
                                     sorted(rows, key=lambda row: str(row.get("id", row))))
            restarted = Workflow(legacy, clock=lambda: self.now)
            self.assertEqual(restarted.get_action(self.seller.id, self.action.id), self.action)
            self.assertEqual(restarted.action_history(self.seller.id, self.action.id),
                             self.workflow.action_history(self.seller.id, self.action.id))
            self.assertEqual(restarted.execute(self.seller.id, self.action.id, request), execution)
            self.assertEqual(restarted.reconcile(self.reviewer.id, execution.id, execution.revision).status, "succeeded")
            with self.assertRaises(PolicyDenied):
                restarted.execute(self.seller.id, self.action.id, request.model_copy(update={"idempotency_key": "new"}))
            if legacy.engine.dialect.name == "sqlite":
                with legacy.engine.connect() as connection:
                    self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar(), 1)
                    self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_key_check").all(), [])
        finally:
            legacy.engine.dispose()
            if legacy_schema:
                with self.pg_admin.begin() as connection:
                    connection.execute(DropSchema(legacy_schema, cascade=True))

    def test_multi_unknown_dependency_and_frozen_edits(self):
        plan, mission, ((first, request), (second, dependent)) = self.multi()
        self.workflow.simulation_profile = "timeout_before"
        result = self.workflow.execute(self.seller.id, first.id, request)
        result = self.workflow.reconcile(self.reviewer.id, result.id, result.revision)
        self.assertEqual(result.status, "result_unknown")
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, second.id, dependent)
        with self.assertRaises(PolicyDenied):
            self.workflow.prepare(self.seller.id, mission.id, PrepareRequest(
                expected_revision=self.workflow.get_mission(self.seller.id, mission.id).revision,
                alternative_id=plan.selected_alternative_id, step_id=second.step_id,
                connector_id="simulation-hubspot", payload=NotePayload(body="replacement")))
        self.assertEqual(self.workflow.get_mission(self.seller.id, mission.id).status, "reconciliation_required")

    def test_multi_edit_invalidates_sibling_and_denies_role_scope_and_step(self):
        plan, mission, ((first, old), (second, _)) = self.multi()
        viewer = self.identity.create_user("multi-viewer", "test-password-long", SAMPLE_ORG, "viewer")
        outsider = self.identity.create_user("multi-other", "test-password-long", "other", "admin")
        body = PrepareRequest(expected_revision=self.workflow.get_mission(self.seller.id, mission.id).revision,
            alternative_id=plan.selected_alternative_id, step_id=second.step_id,
            connector_id="simulation-hubspot", payload=NotePayload(body="Changed"))
        for actor in (viewer, outsider):
            with self.assertRaises(PolicyDenied):
                self.workflow.prepare(actor.id, mission.id, body)
        with self.assertRaises(PolicyDenied):
            self.workflow.prepare(self.seller.id, mission.id, body.model_copy(update={"step_id": uuid4()}))
        self.workflow.prepare(self.seller.id, mission.id, body)
        sibling = self.workflow.get_action(self.seller.id, first.id)
        self.assertEqual(sibling.status, "draft")
        self.assertGreater(sibling.revision, first.revision)
        self.assertEqual(sibling.slot_id, first.slot_id)
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, first.id, old)

    def test_multi_rejection_blocks_all_claims_and_safe_retry_unlocks_dependency(self):
        _, mission, ((first, request), (second, dependent)) = self.multi()
        self.workflow.simulation_profile = "reject"
        failed = self.workflow.execute(self.seller.id, first.id, request)
        self.assertEqual(self.workflow.get_mission(self.seller.id, mission.id).status, "execution_failed")
        with self.assertRaises(PolicyDenied):
            self.workflow.execute(self.seller.id, second.id, dependent)
        self.workflow.simulation_profile = "success"
        retried = self.workflow.retry(self.seller.id, failed.id, ExecuteRequest(
            expected_revision=failed.revision, decision_id=request.decision_id, idempotency_key=request.idempotency_key))
        self.assertEqual((retried.id, retried.attempt, retried.status), (failed.id, 2, "succeeded"))
        self.assertEqual(self.workflow.execute(self.seller.id, second.id, dependent).status, "succeeded")

    def test_multi_rejected_sibling_cannot_authorize_first_action(self):
        plan, mission, ((first, _), (second, _)) = self.multi()
        self.workflow.prepare(self.seller.id, mission.id, PrepareRequest(
            expected_revision=self.workflow.get_mission(self.seller.id, mission.id).revision,
            alternative_id=plan.selected_alternative_id, step_id=first.step_id,
            connector_id="simulation-hubspot", payload=TaskPayload(title="Changed", body="New")))
        current = {item.step_id: item for item in self.workflow.list_actions(self.seller.id, mission.id)}
        requests = []
        for step in plan.alternatives[0].steps:
            item = current[step.id]
            item = self.workflow.submit(self.seller.id, item.id, SubmitRequest(
                expected_revision=item.revision, binding_hash=item.binding_hash))
            decision = self.workflow.review(self.reviewer.id, item.id, ReviewRequest(
                expected_revision=item.revision, binding_hash=item.binding_hash,
                decision="rejected" if item.id == second.id else "approved",
                reason="Revise this note" if item.id == second.id else None))
            requests.append((item, ExecuteRequest(expected_revision=item.revision,
                decision_id=decision.id, idempotency_key="rejected-multi")))
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.claim(self.seller.id, requests[0][0].id, requests[0][1])
        self.assertEqual(failure.exception.code, "mission_not_approved")
        self.assertEqual(self.workflow.get_mission(self.seller.id, mission.id).status, "rejected")

    def test_multi_concurrent_claim_is_unique(self):
        _, _, ((first, request), _) = self.multi()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.workflow.execute(self.seller.id, first.id, request), range(2)))
        self.assertEqual(results[0].id, results[1].id)
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources.c.id).where(
                resources.c.execution_id == str(results[0].id))).all()), 1)

    def test_multi_revoked_sibling_review_blocks_first_dispatch(self):
        _, _, ((first, request), (second, _)) = self.multi()
        other = self.identity.create_user("multi-reviewer", "test-password-long", SAMPLE_ORG, "reviewer")
        with self.store.engine.begin() as connection:
            row = connection.execute(select(decisions.c.payload).where(decisions.c.action_id == str(second.id))).scalar_one()
            row["reviewer_id"] = other.id
            connection.execute(update(decisions).where(decisions.c.action_id == str(second.id)).values(payload=row))
        execution, _ = self.workflow.claim(self.seller.id, first.id, request)
        with self.store.engine.begin() as connection:
            connection.execute(update(users).where(users.c.id == other.id).values(enabled=False))
        with self.assertRaises(PolicyDenied):
            self.workflow.mark_dispatching(self.seller.id, execution.id)

    def test_sqlite_migration_failure_rolls_back_and_restores_foreign_keys(self):
        from vita_api.migrate import upgrade

        if self.store.engine.dialect.name != "sqlite":
            self.skipTest("SQLite transaction/pragma behavior")

        def fail(config, target):
            config.attributes["connection"].exec_driver_sql("CREATE TABLE migration_rollback_probe(id INTEGER)")
            raise RuntimeError("injected migration failure")

        with patch("vita_api.migrate.command.upgrade", side_effect=fail), self.assertRaisesRegex(RuntimeError, "injected"):
            upgrade(self.store.engine)
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.exec_driver_sql("PRAGMA foreign_keys").scalar(), 1)
        self.assertNotIn("migration_rollback_probe", inspect(self.store.engine).get_table_names())

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

    def test_manual_only_outcome_and_append_only_correction(self):
        self.prepare()
        body = OutcomeRequest(expected_revision=self.mission.revision, manual_action_reference="manual:reviewed-evidence",
            kind="follow_up_required", basis="manual_report", evidence_ids=self.plan.evidence.evidence_ids,
            note="Human reviewed the evidence; no adapter execution.")
        original = self.workflow.outcome(self.seller.id, self.mission.id, body)
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        self.assertEqual(mission.status, "completed")
        corrected = self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(
            **{**body.model_dump(), "expected_revision": mission.revision, "supersedes_id": original.id,
               "note": "Corrected follow-up context."}))
        self.assertEqual(corrected.supersedes_id, original.id)
        self.assertEqual(self.workflow.list_outcomes(self.seller.id, mission.id), [original, corrected])
        with self.assertRaises(PolicyDenied):
            self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(
                **{**body.model_dump(), "expected_revision": self.workflow.get_mission(self.seller.id, mission.id).revision,
                   "supersedes_id": original.id, "note": "Stale correction"}))
        with self.store.engine.connect() as connection:
            self.assertEqual(connection.execute(select(claims.c.id)).all(), [])
            self.assertEqual(connection.execute(select(resources.c.id)).all(), [])
        with self.assertRaises(PolicyDenied):
            self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
                expected_revision=self.action.revision, binding_hash=self.action.binding_hash))

    def test_manual_failure_resolution_preserves_failed_and_unexecuted_actions(self):
        plan, mission, ((first, request), (second, _)) = self.multi()
        self.workflow.simulation_profile = "reject"
        failed = self.workflow.execute(self.seller.id, first.id, request)
        self.now += timedelta(hours=1)
        report = self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(
            expected_revision=self.workflow.get_mission(self.seller.id, mission.id).revision,
            manual_action_reference="manual:operator-follow-up", kind="follow_up_required", basis="manual_report",
            evidence_ids=plan.evidence.evidence_ids, note="Operator will address failed prerequisite outside this mission."))
        self.assertIsNone(report.report.receipt_id)
        self.assertEqual(self.workflow.get_execution(self.seller.id, failed.id).status, "failed")
        with self.store.engine.connect() as connection:
            self.assertIsNone(connection.execute(select(claims.c.id).where(claims.c.action_id == str(second.id))).first())
        with self.assertRaises(PolicyDenied):
            self.workflow.retry(self.seller.id, failed.id, ExecuteRequest(expected_revision=failed.revision,
                decision_id=request.decision_id, idempotency_key=request.idempotency_key))

    def test_manual_unknown_mission_cannot_complete(self):
        plan, mission, ((first, request), _) = self.multi()
        self.workflow.simulation_profile = "timeout_before"
        unknown = self.workflow.execute(self.seller.id, first.id, request)
        with self.assertRaises(PolicyDenied):
            self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(
                expected_revision=self.workflow.get_mission(self.seller.id, mission.id).revision,
                manual_action_reference="manual:cannot-conceal-unknown", kind="follow_up_required", basis="manual_report",
                evidence_ids=plan.evidence.evidence_ids, note="Unknown must remain open."))
        self.assertEqual(self.workflow.get_execution(self.seller.id, unknown.id).status, "result_unknown")

    def test_outcome_correction_concurrency_scope_and_rejected_manual_denial(self):
        self.prepare()
        body = OutcomeRequest(expected_revision=self.mission.revision, manual_action_reference="manual:review",
            kind="follow_up_required", basis="manual_report", evidence_ids=self.plan.evidence.evidence_ids, note="Manual")
        original = self.workflow.outcome(self.seller.id, self.mission.id, body)
        current = self.workflow.get_mission(self.seller.id, self.mission.id)
        correction = OutcomeRequest(**{**body.model_dump(), "expected_revision": current.revision,
                                       "supersedes_id": original.id, "note": "Correction"})
        outsider = self.identity.create_user("outcome-other", "test-password-long", "other", "admin")
        with self.assertRaises(PolicyDenied):
            self.workflow.list_outcomes(outsider.id, current.id)
        with self.assertRaises(PolicyDenied):
            self.workflow.outcome(outsider.id, current.id, correction)

        def correct(_):
            try:
                return self.workflow.outcome(self.seller.id, current.id, correction)
            except PolicyDenied as error:
                return error.code

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(correct, range(2)))
        self.assertEqual(sum(not isinstance(result, str) for result in results), 1)
        self.assertEqual(len(self.workflow.list_outcomes(self.seller.id, current.id)), 2)
        self.prepare()
        self.action = self.workflow.submit(self.seller.id, self.action.id, SubmitRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash))
        self.workflow.review(self.reviewer.id, self.action.id, ReviewRequest(
            expected_revision=self.action.revision, binding_hash=self.action.binding_hash, decision="rejected", reason="Revise"))
        with self.assertRaises(PolicyDenied):
            self.workflow.outcome(self.seller.id, self.mission.id, OutcomeRequest(
                **{**body.model_dump(), "expected_revision": self.workflow.get_mission(self.seller.id, self.mission.id).revision}))

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

    def test_concurrent_submission_keeps_one_exact_review_revision(self):
        action = self.prepare()
        body = SubmitRequest(expected_revision=action.revision, binding_hash=action.binding_hash)
        barrier = Barrier(2)

        def submit():
            store = Store(self.store.engine.url.render_as_string(hide_password=False))
            try:
                workflow = Workflow(store, clock=lambda: NOW)
                barrier.wait(timeout=10)
                try:
                    return workflow.submit(self.seller.id, action.id, body)
                except PolicyDenied as failure:
                    self.assertEqual((failure.code, failure.status_code), ("stale_revision", 409))
                    return None
            finally:
                store.engine.dispose()

        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: submit(), range(2)))
        accepted = [item for item in results if item is not None]
        self.assertEqual(len(accepted), 1)
        submitted = self.workflow.get_action(self.seller.id, action.id)
        self.assertEqual(submitted, accepted[0])
        self.assertEqual((submitted.revision, submitted.status, submitted.payload),
                         (action.revision + 1, "submitted", action.payload))
        self.assertNotEqual(submitted.binding_hash, action.binding_hash)
        events = self.workflow.audit(self.seller.id, self.mission.id)
        self.assertEqual(sum(item.event_kind == "action_submitted" for item in events), 1)
        self.assertEqual(self.workflow.list_decisions(self.seller.id, action.id), [])
        self.assertEqual(self.workflow.list_executions(self.seller.id, action.id), [])
        with self.assertRaises(PolicyDenied):
            self.workflow.review(self.reviewer.id, action.id, ReviewRequest(
                expected_revision=action.revision, binding_hash=action.binding_hash, decision="approved"))
        decision = self.workflow.review(self.reviewer.id, action.id, ReviewRequest(
            expected_revision=submitted.revision, binding_hash=submitted.binding_hash, decision="approved"))
        self.assertEqual((decision.action_revision, decision.binding_hash),
                         (submitted.revision, submitted.binding_hash))

    def crash_worker(self, boundary):
        request = self.approve()
        database_url = self.store.engine.url.render_as_string(hide_password=False)
        # Abruptly exit after a real committed transaction, without service/engine cleanup.
        # Configuration travels over stdin so PostgreSQL credentials never enter argv/output.
        worker = """
import json
import os
import sys
from contextlib import contextmanager
from datetime import datetime
from vita_api.storage import Store
from vita_api.workflow import Workflow
from vita_api.workflow_contracts import ExecuteRequest

config = json.load(sys.stdin)
store = Store(config["database_url"])
workflow = Workflow(store, clock=lambda: datetime.fromisoformat(config["now"]))
original = workflow._transaction
commits = 0

@contextmanager
def transaction(*args, **kwargs):
    global commits
    with original(*args, **kwargs) as values:
        yield values
    commits += 1
    if commits == config["boundary"]:
        os._exit(73)

workflow._transaction = transaction
workflow.execute(config["actor_id"], config["action_id"], ExecuteRequest.model_validate(config["request"]))
"""
        result = subprocess.run([sys.executable, "-c", worker], check=False, input=json.dumps({
            "database_url": database_url, "now": NOW.isoformat(), "boundary": boundary,
            "actor_id": self.seller.id, "action_id": str(self.action.id),
            "request": request.model_dump(mode="json"),
        }), text=True, capture_output=True, timeout=30, cwd=Path(__file__).resolve().parents[1])
        self.assertEqual(result.returncode, 73, "Worker did not reach the requested crash boundary")
        self.assertFalse(result.stdout or result.stderr, "Worker unexpectedly emitted output")
        self.store.engine.dispose()
        self.store = Store(database_url)
        self.workflow = Workflow(self.store, clock=lambda: NOW)
        executions = self.workflow.list_executions(self.seller.id, self.action.id)
        self.assertEqual(len(executions), 1)
        execution = executions[0]
        self.assertEqual((execution.status, execution.attempt, execution.receipt_id),
                         ("claimed" if boundary == 1 else "dispatching", 1, None))
        events = self.workflow.audit(self.seller.id, self.mission.id)
        self.assertEqual(sum(item.event_kind == "execution_claimed" for item in events), 1)
        self.assertEqual(sum(item.event_kind == "dispatch_started" for item in events), int(boundary > 1))
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), int(boundary == 3))
        self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, request), execution)
        with self.assertRaises(PolicyDenied) as failure:
            self.workflow.execute(self.seller.id, self.action.id,
                                  request.model_copy(update={"idempotency_key": "replacement-key"}))
        self.assertEqual(failure.exception.code, "logical_action_claimed")
        return request, execution

    def test_process_exit_after_claim_recovers_under_same_key(self):
        request, execution = self.crash_worker(1)
        failed = self.workflow.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual(failed.status, "failed")
        receipt = self.workflow.get_receipt(self.seller.id, failed.receipt_id)
        self.assertEqual(receipt.error_code, "pre_dispatch_cancelled")
        retried = self.workflow.retry(self.seller.id, failed.id,
                                     request.model_copy(update={"expected_revision": failed.revision}))
        self.assertEqual((retried.id, retried.idempotency_key, retried.attempt, retried.status),
                         (execution.id, request.idempotency_key, 2, "succeeded"))
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(claims)).all()), 1)
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)

    def test_process_exit_after_dispatch_keeps_unknown_and_blocks_retry_outcome(self):
        request, execution = self.crash_worker(2)
        unknown = self.workflow.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual((unknown.id, unknown.status, unknown.attempt), (execution.id, "result_unknown", 1))
        with self.assertRaises(PolicyDenied):
            self.workflow.retry(self.seller.id, unknown.id,
                                request.model_copy(update={"expected_revision": unknown.revision}))
        mission = self.workflow.get_mission(self.seller.id, self.mission.id)
        self.assertEqual(mission.status, "reconciliation_required")
        with self.assertRaises(PolicyDenied):
            self.workflow.outcome(self.seller.id, mission.id, OutcomeRequest(expected_revision=mission.revision,
                manual_action_reference="operator-follow-up", kind="follow_up_required", basis="manual_report",
                evidence_ids=self.plan.evidence.evidence_ids, note="Unknown dispatch cannot be closed"))
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), 0)

    def test_process_exit_after_resource_commit_reconciles_without_redispatch(self):
        request, execution = self.crash_worker(3)
        reconciled = self.workflow.reconcile(self.reviewer.id, execution.id, execution.revision)
        self.assertEqual((reconciled.id, reconciled.attempt, reconciled.status), (execution.id, 1, "succeeded"))
        receipt = self.workflow.get_receipt(self.seller.id, reconciled.receipt_id)
        self.assertEqual((receipt.mode, receipt.verification, receipt.readback_hash),
                         ("simulation", "verified", self.action.payload_hash))
        self.assertEqual(self.workflow.execute(self.seller.id, self.action.id, request), reconciled)
        with self.store.engine.connect() as connection:
            self.assertEqual(len(connection.execute(select(resources)).all()), 1)
        self.assertEqual(self.workflow.list_outcomes(self.seller.id, self.mission.id), [])

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
