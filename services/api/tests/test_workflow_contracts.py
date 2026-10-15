"""Stage 2 contract/policy tests; no database, provider, or external execution."""
import unittest
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from pydantic import ValidationError

from vita_api.contracts import AccountView
from vita_api.governance import (
    PolicyDenied,
    binding_hash,
    canonical_json,
    check_execution,
    check_plan,
    evidence_binding,
    logical_action_key,
    payload_hash,
    transition,
)
from vita_api.identity import Actor
from vita_api.sample import sample_records
from vita_api.scoring import assess
from vita_api.workflow_contracts import (
    ActionPreview,
    Alternative,
    DestinationBinding,
    ExecuteRequest,
    Mission,
    OutcomeRequest,
    Plan,
    PlanStep,
    Receipt,
    ReviewDecision,
    ReviewRequest,
    TaskPayload,
)

NOW = datetime(2026, 10, 15, 10, tzinfo=UTC)


class WorkflowContractTests(unittest.TestCase):
    def setUp(self):
        account, facts = sample_records(NOW)[0]
        self.view = AccountView(account=account, evidence=facts,
                                assessment=assess(account, facts, NOW.date()), renewal_days=24)
        self.binding = evidence_binding(self.view)
        self.actor = Actor(id=str(uuid4()), username="seller", organization_id=account.organization_id, role="seller")
        self.reviewer = Actor(id=str(uuid4()), username="reviewer", organization_id=account.organization_id,
                              role="reviewer")
        self.base = {"id": uuid4(), "organization_id": account.organization_id, "created_at": NOW,
                         "revision": 1, "correlation_id": uuid4()}
        self.step = PlanStep(id=uuid4(), kind="hubspot_task_create", content="Review support evidence",
                             evidence_ids=self.binding.evidence_ids, dependencies=())
        self.alternative = Alternative(id=uuid4(), rationale="Address current support risk",
                                       evidence_ids=self.binding.evidence_ids, steps=(self.step,), risks=())
        self.plan = Plan(**self.base, account_id=account.id, evidence=self.binding, author_id=self.actor.id,
                         source="deterministic", status="valid", alternatives=(self.alternative,),
                         selected_alternative_id=self.alternative.id, caveats=(), validation="valid")
        self.destination = DestinationBinding(connector_id="test-connector", provider="hubspot",
                                              configuration_revision=1, tenant_id="test-portal",
                                              target_account_id=account.id, target_resource_id="company-1")
        payload = TaskPayload(kind="hubspot_task_create", title=" Support review ", body="Exact body\n ")
        self.preview = ActionPreview(**{**self.base, "id": uuid4()}, mission_id=uuid4(), mission_revision=2,
                                     plan_id=self.plan.id, plan_revision=1, evidence=self.binding,
                                     slot_id=uuid4(), destination=self.destination, payload=payload,
                                     policy_version="governance-1", mode="simulation", preparer_id=self.actor.id,
                                     status="submitted", payload_hash=payload_hash(payload), binding_hash="0" * 64)
        self.preview = ActionPreview.model_validate({**self.preview.model_dump(),
                                                    "binding_hash": binding_hash(self.preview)})
        self.decision = ReviewDecision(**{**self.base, "id": uuid4()}, action_id=self.preview.id,
                                       action_revision=1, binding_hash=self.preview.binding_hash,
                                       decision="approved", reviewer_id=self.reviewer.id,
                                       authority_version="governance-1", decided_at=NOW,
                                       expires_at=NOW + timedelta(minutes=30))

    def execute(self, **changes):
        values = {"actor": self.actor, "reviewer": self.reviewer, "action": self.preview, "decision": self.decision,
                      "evidence": self.binding, "destination": self.destination, "policy_version": "governance-1", "now": NOW}
        check_execution(**{**values, **changes})

    def test_canonical_bytes_preserve_content_and_are_stable(self):
        self.assertEqual(self.preview.payload.title, " Support review ")
        self.assertEqual(self.preview.payload.body, "Exact body\n ")
        self.assertEqual(canonical_json({"z": "é", "a": None}), b'{"a":null,"z":"\xc3\xa9"}')
        self.assertEqual(payload_hash(self.preview.payload), payload_hash(
            TaskPayload.model_validate_json(self.preview.payload.model_dump_json())))
        with self.assertRaises(ValueError):
            canonical_json({"number": float("nan")})

    def test_payload_rejects_injection_unknown_authority_and_invalid_email(self):
        from vita_api.workflow_contracts import OutlookPayload
        invalid = [{"kind": "hubspot_task_create", "title": "x\r\ny", "body": "body"},
                   {"kind": "hubspot_task_create", "title": " ", "body": "body"},
                   {"kind": "hubspot_task_create", "title": "x", "body": "bad\0"},
                   {"kind": "hubspot_task_create", "title": "x", "body": "body", "approved": True}]
        for value in invalid:
            with self.subTest(value=value), self.assertRaises(ValidationError):
                TaskPayload.model_validate(value)
        for recipients in [("user@example.com", "USER@example.com"), ("bad",), ("a@b.com\r\nBcc:x@y.com",)]:
            with self.subTest(recipients=recipients), self.assertRaises(ValidationError):
                OutlookPayload(to=recipients, subject="subject", body_text="body")

    def test_requests_cannot_assert_actor_scope_payload_or_result(self):
        valid = {"expected_revision": 1, "decision_id": str(self.decision.id), "idempotency_key": "request-1"}
        ExecuteRequest.model_validate(valid)
        for field, value in {"actor_id": self.actor.id, "organization_id": "other", "approved": True,
                             "payload": {}, "destination": {}, "status": "succeeded"}.items():
            with self.subTest(field=field), self.assertRaises(ValidationError):
                ExecuteRequest.model_validate({**valid, field: value})
        for revision in (0, True, "1", 1.0):
            with self.subTest(revision=revision), self.assertRaises(ValidationError):
                ExecuteRequest.model_validate({**valid, "expected_revision": revision})

    def test_plan_dependency_and_reference_validation(self):
        check_plan(self.plan, self.view)
        with self.assertRaises(PolicyDenied):
            check_plan(self.plan, self.view.model_copy(update={
                "assessment": self.view.assessment.model_copy(update={"confidence": 50}),
            }))
        for steps in [(self.step, self.step),
                      (self.step.model_copy(update={"dependencies": (uuid4(),)}),),
                      (self.step.model_copy(update={"dependencies": (self.step.id,)}),)]:
            with self.subTest(steps=steps), self.assertRaises(ValidationError):
                Alternative.model_validate({**self.alternative.model_dump(), "steps": steps})
        other = self.step.model_copy(update={"id": uuid4(), "dependencies": (self.step.id,)})
        cyclic = self.step.model_copy(update={"dependencies": (other.id,)})
        with self.assertRaises(ValidationError):
            Alternative.model_validate({**self.alternative.model_dump(), "steps": (cyclic, other)})
        bad = self.plan.model_copy(update={"evidence": self.binding.model_copy(update={"snapshot_hash": "a" * 64})})
        with self.assertRaises(PolicyDenied):
            check_plan(bad, self.view)
        alternative = self.alternative.model_copy(update={"evidence_ids": (uuid4(),)})
        with self.assertRaises(ValidationError):
            Plan.model_validate({**self.plan.model_dump(), "alternatives": (alternative,)})

    def test_model_plan_requires_successful_matching_model_run(self):
        with self.assertRaises(ValidationError):
            Plan.model_validate({**self.plan.model_dump(), "source": "model"})
        model_plan = Plan.model_validate({**self.plan.model_dump(), "source": "model", "model_run_id": uuid4()})
        with self.assertRaises(PolicyDenied):
            check_plan(model_plan, self.view)

    def test_every_content_and_destination_binding_invalidates_approval(self):
        self.execute()
        updates = {"payload": self.preview.payload.model_copy(update={"body": "Exact body\n"}),
                   "mission_revision": 3, "plan_revision": 2, "policy_version": "governance-2",
                   "mode": "live", "slot_id": uuid4(), "revision": 2,
                   "destination": self.destination.model_copy(update={"configuration_revision": 2}),
                   "evidence": self.binding.model_copy(update={"snapshot_hash": "b" * 64})}
        for field, value in updates.items():
            changed = self.preview.model_copy(update={field: value})
            with self.subTest(field=field):
                self.assertNotEqual(binding_hash(changed), self.preview.binding_hash)
                with self.assertRaises(PolicyDenied):
                    self.execute(action=changed)
        self.assertEqual(logical_action_key(self.preview), logical_action_key(
            self.preview.model_copy(update={"payload": updates["payload"], "revision": 2})))
        self.assertNotEqual(logical_action_key(self.preview), logical_action_key(
            self.preview.model_copy(update={"slot_id": uuid4()})))

    def test_current_scope_role_expiry_policy_and_evidence_rechecked(self):
        cases = [{"actor": self.actor.model_copy(update={"role": "viewer"})},
                 {"actor": self.actor.model_copy(update={"organization_id": "other"})},
                 {"reviewer": None}, {"reviewer": self.reviewer.model_copy(update={"role": "seller"})},
                 {"reviewer": self.reviewer.model_copy(update={"organization_id": "other"})},
                 {"now": NOW + timedelta(minutes=30)}, {"now": NOW - timedelta(seconds=1)},
                 {"policy_version": "governance-2"},
                 {"evidence": self.binding.model_copy(update={"account_revision": 2})},
                 {"destination": self.destination.model_copy(update={"target_resource_id": "company-2"})},
                 {"decision": None}, {"action": self.preview.model_copy(update={"status": "superseded"})}]
        for case in cases:
            with self.subTest(case=case), self.assertRaises(PolicyDenied):
                self.execute(**case)

    def test_rejection_revision_and_lifetime(self):
        for decision in ("rejected", "revision_required"):
            body = {"expected_revision": 1, "binding_hash": self.preview.binding_hash, "decision": decision}
            with self.assertRaises(ValidationError):
                ReviewRequest.model_validate(body)
            ReviewRequest.model_validate({**body, "reason": "Revise content"})
            rejected = self.decision.model_copy(update={"decision": decision, "reason": "Revise content"})
            with self.assertRaises(PolicyDenied):
                self.execute(decision=rejected)
        for expires in (NOW, NOW + timedelta(minutes=31)):
            with self.assertRaises(ValidationError):
                ReviewDecision.model_validate({**self.decision.model_dump(), "expires_at": expires})

    def test_destination_mailbox_and_utc_constraints(self):
        values = self.destination.model_dump()
        with self.assertRaises(ValidationError):
            DestinationBinding.model_validate({**values, "provider": "microsoft"})
        with self.assertRaises(ValidationError):
            DestinationBinding.model_validate({**values, "mailbox_id": "mailbox", "delegated_user_id": "user"})
        with self.assertRaises(ValidationError):
            Plan.model_validate({**self.plan.model_dump(), "created_at": NOW.replace(tzinfo=None)})

    def test_receipt_success_and_verification_require_independent_evidence(self):
        values = dict(**self.base, execution_id=uuid4(), action_id=self.preview.id, decision_id=self.decision.id,
                      binding_hash=self.preview.binding_hash, destination=self.destination, mode="simulation",
                      result="succeeded", verification="not_run", recorded_at=NOW)
        with self.assertRaises(ValidationError):
            Receipt.model_validate(values)
        receipt = Receipt.model_validate({**values, "provider_resource_id": "simulated-resource"})
        with self.assertRaises(ValidationError):
            Receipt.model_validate({**receipt.model_dump(), "verification": "verified"})
        self.assertEqual(receipt.verification, "not_run")

    def test_outcome_is_explicit_and_unknown_cannot_complete(self):
        values = {"expected_revision": 1, "kind": "customer_contacted", "basis": "manual_report",
                      "evidence_ids": [str(uuid4())], "note": "Customer confirmed contact"}
        with self.assertRaises(ValidationError):
            OutcomeRequest.model_validate(values)
        OutcomeRequest.model_validate({**values, "manual_action_reference": "phone-call-123"})
        with self.assertRaises(ValidationError):
            OutcomeRequest.model_validate({**values, "receipt_id": uuid4(), "manual_action_reference": "call-1"})
        self.assertEqual(transition("awaiting_review", "approved"), "approved")
        self.assertEqual(transition("executing", "reconciliation_required"), "reconciliation_required")
        for before, after in [("draft", "executing"), ("rejected", "completed"),
                              ("reconciliation_required", "completed"), ("executed", "completed")]:
            with self.subTest(before=before, after=after), self.assertRaises(PolicyDenied):
                transition(before, after)

    def test_mission_cannot_enable_unregistered_tools(self):
        values = dict(**self.base, account_id=self.view.account.id, owner_id=self.actor.id,
                      template="account-action-1", plan_id=self.plan.id, plan_revision=1,
                      evidence=self.binding, status="draft", current_step="Review", allowed_kinds=["email_send"],
                      transition_ids=[])
        with self.assertRaises(ValidationError):
            Mission.model_validate(values)
