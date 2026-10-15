"""Durable governed simulation. No live adapter, credentials, or network dispatch exists here."""
import hashlib
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import func, select, text, update

from .contracts import Account, AccountView, Evidence, ModelRun
from .governance import (
    PolicyDenied,
    authorize,
    binding_hash,
    canonical_json,
    check_execution,
    check_plan,
    evidence_binding,
    logical_action_key,
    payload_hash,
    transition,
)
from .identity import Actor, sessions, token_digest, users
from .pipeline import action_role, governance_role
from .scoring import assess
from .storage import accounts, evidence, runs
from .workflow_contracts import (
    ActionPreview,
    Alternative,
    AuditEvent,
    DestinationBinding,
    ExecuteRequest,
    Execution,
    Mission,
    MissionRequest,
    Outcome,
    OutcomeRequest,
    Plan,
    PlanRequest,
    PlanStep,
    PrepareRequest,
    Receipt,
    ReviewDecision,
    ReviewRequest,
    SubmitRequest,
)
from .workflow_storage import (
    actions,
    audits,
    claims,
    decisions,
    missions,
    outcomes,
    plans,
    receipts,
    resources,
    versions,
)


class Workflow:
    policy_version = "governance-1"

    def __init__(self, store, *, clock=None, simulation_profile="success", separation_of_duties=False,
                 session_token=None, session_required=False):
        self.engine = store.engine
        self.clock = clock or (lambda: datetime.now(UTC))
        if simulation_profile not in {"success", "reject", "timeout_after", "timeout_before", "mismatch"}:
            raise ValueError("Unknown simulation profile")
        self.simulation_profile = simulation_profile
        self.separation_of_duties = separation_of_duties
        self.session_token = session_token
        self.session_required = session_required

    def _actor(self, connection, actor_id):
        row = connection.execute(select(users).where(users.c.id == actor_id, users.c.enabled.is_(True))
                                 .with_for_update()).mappings().first()
        if row is None:
            raise PolicyDenied("authentication_required", 401)
        return Actor(**{key: row[key] for key in ("id", "username", "organization_id", "role")})

    @contextmanager
    def _transaction(self, actor_id, *, write=True, review=False):
        with self.engine.connect() as connection:
            try:
                if self.engine.dialect.name == "sqlite":
                    connection.exec_driver_sql("BEGIN IMMEDIATE" if write else "BEGIN")
                else:
                    connection.begin()
                    # Serialize workflow mutations within one organization across processes. Lock identity
                    # after this lock so concurrent reviewer/seller operations have one consistent lock order.
                    organization = connection.execute(select(users.c.organization_id).where(
                        users.c.id == actor_id, users.c.enabled.is_(True))).scalar()
                    if organization is None:
                        raise PolicyDenied("authentication_required", 401)
                    key = int.from_bytes(hashlib.sha256(organization.encode()).digest()[:8], "big", signed=True)
                    connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                actor = self._actor(connection, actor_id)
                if self.session_required:
                    valid = connection.execute(select(sessions.c.user_id).where(
                        sessions.c.token_hash == token_digest(self.session_token or ""),
                        sessions.c.user_id == actor.id, sessions.c.expires_at > int(self.clock().timestamp()))
                        .with_for_update()).scalar()
                    if valid is None:
                        raise PolicyDenied("authentication_required", 401)
                if self.engine.dialect.name == "postgresql" and actor.organization_id != organization:
                    raise PolicyDenied("membership_changed", 409)
                if write:
                    authorize(actor, actor.organization_id, review=review)
                yield connection, actor
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def _base(self, actor, **changes):
        return {"id": uuid4(), "organization_id": actor.organization_id, "created_at": self.clock(),
                "revision": 1, "correlation_id": uuid4(), **changes}

    def _get(self, connection, actor, table, entity_id, contract):
        row = connection.execute(select(table.c.payload).where(
            table.c.organization_id == actor.organization_id, table.c.id == str(entity_id))).scalar()
        if row is None:
            raise PolicyDenied("record_not_found", 404)
        return contract.model_validate(row)

    def _put(self, connection, table, record, *, new=False, **columns):
        values = {"revision": record.revision, "payload": record.model_dump(mode="json"), **columns}
        if new:
            connection.execute(table.insert().values(id=str(record.id), organization_id=record.organization_id, **values))
        else:
            result = connection.execute(update(table).where(table.c.id == str(record.id),
                table.c.organization_id == record.organization_id, table.c.revision == record.revision - 1).values(**values))
            if result.rowcount != 1:
                raise PolicyDenied("stale_revision", 409)
        if table.name in {plans.name, missions.name, actions.name, claims.name}:
            connection.execute(versions.insert().values(organization_id=record.organization_id,
                entity_id=str(record.id), revision=record.revision, entity_type=table.name,
                payload=record.model_dump(mode="json")))

    def _version(self, record, expected):
        if record.revision != expected:
            raise PolicyDenied("stale_revision", 409)

    def _audit(self, connection, actor, record, event, *, mission_id=None, before=None, after=None):
        audit = AuditEvent(**self._base(actor, correlation_id=record.correlation_id), entity_id=record.id,
                           sequence=connection.execute(select(func.count()).select_from(audits).where(
                               audits.c.organization_id == actor.organization_id)).scalar_one() + 1,
                           entity_revision=record.revision, actor_id=actor.id, event_kind=event,
                           previous_state=before, new_state=after or getattr(record, "status", event),
                           action_id=record.id if isinstance(record, ActionPreview) else getattr(record, "action_id", None),
                           decision_id=record.id if isinstance(record, ReviewDecision) else getattr(record, "decision_id", None),
                           execution_id=record.id if isinstance(record, Execution) else getattr(record, "execution_id", None),
                           binding_hash=getattr(record, "binding_hash", None))
        self._put(connection, audits, audit, new=True, mission_id=str(mission_id) if mission_id else None,
                  sequence=audit.sequence)
        return audit

    def _move(self, connection, actor, mission, status, step, event=None, **changes):
        updated = Mission.model_validate({**mission.model_dump(), "revision": mission.revision + 1,
                                         "status": transition(mission.status, status), "current_step": step, **changes})
        audit = self._audit(connection, actor, updated, event or status, mission_id=mission.id, before=mission.status)
        updated = updated.model_copy(update={"transition_ids": (*updated.transition_ids, audit.id)})
        self._put(connection, missions, updated)
        return updated

    def _view(self, connection, actor, account_id):
        row = connection.execute(select(accounts.c.payload).where(accounts.c.organization_id == actor.organization_id,
            accounts.c.id == str(account_id)).with_for_update()).scalar()
        if row is None:
            raise PolicyDenied("account_not_found", 404)
        account = Account.model_validate(row)
        facts = [Evidence.model_validate(item) for item in connection.execute(select(evidence.c.payload).where(
            evidence.c.organization_id == actor.organization_id, evidence.c.account_id == str(account_id))
            .with_for_update()).scalars()]
        return AccountView(account=account, evidence=facts, assessment=assess(account, facts, self.clock().date()),
                           renewal_days=(account.renewal_date - self.clock().date()).days)

    def _plan_check(self, connection, actor, plan):
        run = None
        if plan.model_run_id:
            value = connection.execute(select(runs.c.payload).where(runs.c.organization_id == actor.organization_id,
                runs.c.id == str(plan.model_run_id))).scalar()
            run = ModelRun.model_validate(value) if value else None
        view = self._view(connection, actor, plan.account_id)
        check_plan(plan, view, run)
        return view

    def create_plan(self, actor_id: str, body: PlanRequest) -> Plan:
        with self._transaction(actor_id) as (connection, actor):
            view = self._view(connection, actor, body.account_id)
            if (view.account.revision != body.expected_revision
                    or view.assessment.snapshot_hash != body.expected_snapshot_hash):
                raise PolicyDenied("account_snapshot_changed", 409)
            proposal = action_role(view, governance_role(view.assessment), body.intent)
            if proposal.kind in {"monitor", "manual_review"} or body.intent == "manual_review":
                raise PolicyDenied("no_executable_action")
            if body.model_run_id:
                # Foundation model output is analysis/drafts, not a validated executable plan. Do not relabel it.
                raise PolicyDenied("structured_model_planning_pending")
            binding = evidence_binding(view)
            step = PlanStep(id=uuid4(), kind="hubspot_task_create", content=proposal.rationale,
                            evidence_ids=tuple(proposal.evidence_ids))
            alternative = Alternative(id=uuid4(), rationale=proposal.rationale, evidence_ids=step.evidence_ids,
                                      steps=(step,), risks=("Simulation only; no customer action occurs.",))
            plan = Plan(**self._base(actor), account_id=body.account_id, evidence=binding, author_id=actor.id,
                        source="deterministic", status="valid", alternatives=(alternative,),
                        selected_alternative_id=alternative.id, caveats=tuple(view.assessment.caveats), validation="valid")
            check_plan(plan, view)
            self._put(connection, plans, plan, new=True, account_id=str(plan.account_id))
            self._audit(connection, actor, plan, "plan_created")
            return plan

    def create_mission(self, actor_id: str, body: MissionRequest) -> Mission:
        with self._transaction(actor_id) as (connection, actor):
            plan = self._get(connection, actor, plans, body.plan_id, Plan)
            self._version(plan, body.expected_revision)
            self._plan_check(connection, actor, plan)
            mission = Mission(**self._base(actor), account_id=plan.account_id, owner_id=actor.id,
                              template=body.template, plan_id=plan.id, plan_revision=plan.revision,
                              evidence=plan.evidence, status="draft", current_step="Review",
                              allowed_kinds=tuple(dict.fromkeys(step.kind for item in plan.alternatives for step in item.steps)))
            self._put(connection, missions, mission, new=True, plan_id=str(plan.id))
            self._audit(connection, actor, mission, "mission_created", mission_id=mission.id)
            return mission

    def _destination(self, actor, account_id, connector_id):
        if connector_id != "simulation-hubspot":
            raise PolicyDenied("connector_unavailable", 503)
        return DestinationBinding(connector_id=connector_id, provider="hubspot", configuration_revision=1,
                                  tenant_id="simulation:" + actor.organization_id, target_account_id=account_id,
                                  target_resource_id="simulation:" + str(account_id))

    def prepare(self, actor_id: str, mission_id, body: PrepareRequest) -> ActionPreview:
        with self._transaction(actor_id) as (connection, actor):
            mission = self._get(connection, actor, missions, mission_id, Mission)
            self._version(mission, body.expected_revision)
            plan = self._get(connection, actor, plans, mission.plan_id, Plan)
            self._plan_check(connection, actor, plan)
            if mission.plan_revision != plan.revision or mission.evidence != plan.evidence:
                raise PolicyDenied("mission_plan_changed", 409)
            if body.alternative_id != plan.selected_alternative_id or body.payload.kind not in mission.allowed_kinds:
                raise PolicyDenied("action_not_in_plan")
            existing = connection.execute(select(actions.c.payload).where(actions.c.organization_id == actor.organization_id,
                actions.c.mission_id == str(mission.id))).scalar()
            previous = ActionPreview.model_validate(existing) if existing else None
            if previous and connection.execute(select(claims.c.id).where(claims.c.organization_id == actor.organization_id,
                    claims.c.action_id == str(previous.id))).first():
                raise PolicyDenied("action_already_claimed", 409)
            content_revision = mission.content_revision + 1
            # State-only transitions do not change the approved mission content revision.
            destination = self._destination(actor, mission.account_id, body.connector_id)
            action = ActionPreview(**self._base(actor, id=previous.id if previous else uuid4(),
                created_at=previous.created_at if previous else self.clock(),
                revision=previous.revision + 1 if previous else 1), mission_id=mission.id,
                mission_revision=content_revision, plan_id=plan.id, plan_revision=plan.revision, evidence=plan.evidence,
                slot_id=previous.slot_id if previous else uuid4(), destination=destination, payload=body.payload,
                payload_hash=payload_hash(body.payload), binding_hash="0" * 64, policy_version=self.policy_version,
                mode="simulation", preparer_id=actor.id, status="draft")
            action = action.model_copy(update={"binding_hash": binding_hash(action)})
            if previous:
                self._audit(connection, actor, previous, "approval_invalidated", mission_id=mission.id, after="superseded")
            self._put(connection, actions, action, new=previous is None, mission_id=str(mission.id), plan_id=str(plan.id),
                      slot_id=str(action.slot_id), canonical_payload=canonical_json(action.payload).decode("utf-8"))
            self._move(connection, actor, mission, "prepared", "Approval", content_revision=content_revision)
            self._audit(connection, actor, action, "action_prepared", mission_id=mission.id)
            return action

    def _context(self, connection, actor, action):
        mission = self._get(connection, actor, missions, action.mission_id, Mission)
        plan = self._get(connection, actor, plans, action.plan_id, Plan)
        view = self._plan_check(connection, actor, plan)
        if (action.mission_revision != mission.content_revision or action.plan_revision != plan.revision
                or mission.plan_id != plan.id or mission.evidence != plan.evidence):
            raise PolicyDenied("mission_binding_changed", 409)
        destination = self._destination(actor, mission.account_id, action.destination.connector_id)
        if (action.mode != "simulation" or action.policy_version != self.policy_version
                or action.destination != destination or action.evidence != evidence_binding(view)
                or action.payload_hash != payload_hash(action.payload) or action.binding_hash != binding_hash(action)):
            raise PolicyDenied("action_binding_changed", 409)
        persisted = connection.execute(select(actions.c.canonical_payload).where(actions.c.organization_id == actor.organization_id,
            actions.c.id == str(action.id))).scalar_one()
        if persisted.encode("utf-8") != canonical_json(action.payload):
            raise PolicyDenied("canonical_payload_changed", 409)
        return mission, view, destination

    def submit(self, actor_id: str, action_id, body: SubmitRequest) -> ActionPreview:
        with self._transaction(actor_id) as (connection, actor):
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            self._version(action, body.expected_revision)
            mission, _, _ = self._context(connection, actor, action)
            if action.status != "draft" or action.binding_hash != body.binding_hash:
                raise PolicyDenied("preview_changed", 409)
            submitted = action.model_copy(update={"revision": action.revision + 1, "status": "submitted"})
            submitted = submitted.model_copy(update={"binding_hash": binding_hash(submitted)})
            self._put(connection, actions, submitted)
            self._move(connection, actor, mission, "awaiting_review", "Approval")
            self._audit(connection, actor, submitted, "action_submitted", mission_id=mission.id)
            return submitted

    def review(self, actor_id: str, action_id, body: ReviewRequest) -> ReviewDecision:
        with self._transaction(actor_id, review=True) as (connection, actor):
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            self._version(action, body.expected_revision)
            mission, _, _ = self._context(connection, actor, action)
            if (action.status != "submitted" or action.binding_hash != body.binding_hash
                    or mission.status != "awaiting_review"):
                raise PolicyDenied("review_not_available", 409)
            if self.separation_of_duties and actor.id == action.preparer_id:
                raise PolicyDenied("separation_of_duties", 403)
            decided_at = self.clock()
            decision = ReviewDecision(**self._base(actor), action_id=action.id, action_revision=action.revision,
                                      binding_hash=action.binding_hash, decision=body.decision, reviewer_id=actor.id,
                                      authority_version=self.policy_version, decided_at=decided_at,
                                      expires_at=decided_at + timedelta(minutes=30), reason=body.reason)
            self._put(connection, decisions, decision, new=True, action_id=str(action.id), action_revision=action.revision,
                      reviewer_session_hash=token_digest(self.session_token) if self.session_required else None)
            self._move(connection, actor, mission, body.decision, "Approval")
            self._audit(connection, actor, decision, "review_decided", mission_id=mission.id)
            return decision

    def _dispatch_check(self, connection, actor, action, decision):
        mission, view, destination = self._context(connection, actor, action)
        reviewer = self._actor(connection, decision.reviewer_id)
        session_hash = connection.execute(select(decisions.c.reviewer_session_hash).where(
            decisions.c.organization_id == actor.organization_id, decisions.c.id == str(decision.id))).scalar_one()
        if session_hash is not None:
            valid = connection.execute(select(sessions.c.user_id).where(sessions.c.token_hash == session_hash,
                sessions.c.user_id == reviewer.id, sessions.c.expires_at > int(self.clock().timestamp()))
                .with_for_update()).scalar()
            if valid is None:
                raise PolicyDenied("reviewer_session_invalidated", 409)
        check_execution(actor=actor, reviewer=reviewer, action=action, decision=decision,
                        evidence=evidence_binding(view), destination=destination, policy_version=self.policy_version,
                        now=self.clock(), separation_of_duties=self.separation_of_duties)
        return mission

    def claim(self, actor_id: str, action_id, body: ExecuteRequest) -> tuple[Execution, bool]:
        with self._transaction(actor_id) as (connection, actor):
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            self._version(action, body.expected_revision)
            prior = connection.execute(select(claims.c.payload).where(claims.c.organization_id == actor.organization_id,
                claims.c.idempotency_key == body.idempotency_key)).scalar()
            if prior:
                execution = Execution.model_validate(prior)
                if (execution.action_id != action.id or execution.binding_hash != action.binding_hash
                        or execution.decision_id != body.decision_id or execution.action_revision != body.expected_revision):
                    raise PolicyDenied("idempotency_conflict", 409)
                return execution, False
            if connection.execute(select(claims.c.id).where(claims.c.organization_id == actor.organization_id,
                    claims.c.logical_action_key == logical_action_key(action))).first():
                raise PolicyDenied("logical_action_claimed", 409)
            decision = self._get(connection, actor, decisions, body.decision_id, ReviewDecision)
            mission = self._dispatch_check(connection, actor, action, decision)
            if mission.status != "approved":
                raise PolicyDenied("mission_not_approved", 409)
            execution = Execution(**self._base(actor), action_id=action.id, action_revision=action.revision,
                                  decision_id=decision.id, binding_hash=action.binding_hash,
                                  logical_action_key=logical_action_key(action), idempotency_key=body.idempotency_key,
                                  requesting_actor_id=actor.id, attempt=1, status="claimed", claimed_at=self.clock())
            self._put(connection, claims, execution, new=True, action_id=str(action.id), decision_id=str(decision.id),
                      logical_action_key=execution.logical_action_key, idempotency_key=execution.idempotency_key)
            self._move(connection, actor, mission, "executing", "Execution")
            self._audit(connection, actor, execution, "execution_claimed", mission_id=mission.id)
            return execution, True

    def mark_dispatching(self, actor_id, execution_id):
        with self._transaction(actor_id) as (connection, actor):
            execution = self._get(connection, actor, claims, execution_id, Execution)
            if execution.status != "claimed":
                raise PolicyDenied("dispatch_already_started", 409)
            action = self._get(connection, actor, actions, execution.action_id, ActionPreview)
            decision = self._get(connection, actor, decisions, execution.decision_id, ReviewDecision)
            self._dispatch_check(connection, actor, action, decision)
            execution = execution.model_copy(update={"revision": execution.revision + 1,
                "status": "dispatching", "dispatched_at": self.clock()})
            self._put(connection, claims, execution)
            self._audit(connection, actor, execution, "dispatch_started", mission_id=action.mission_id)
            return execution

    def _finish(self, connection, actor, execution, action, result, *, resource=None, error=None):
        mission = self._get(connection, actor, missions, action.mission_id, Mission)
        canonical = canonical_json(action.payload).decode("utf-8")
        matches = resource is not None and resource["canonical_payload"] == canonical
        receipt = Receipt(**self._base(actor), execution_id=execution.id, action_id=action.id,
                          decision_id=execution.decision_id, binding_hash=action.binding_hash,
                          destination=action.destination, result=result, mode="simulation",
                          provider_resource_id=resource["id"] if resource else None, recorded_at=self.clock(),
                          verification="verified" if result == "succeeded" and matches else
                          "mismatch" if resource else "unavailable" if result == "result_unknown" else "not_run",
                          readback_hash=hashlib.sha256(resource["canonical_payload"].encode("utf-8")).hexdigest()
                          if resource else None, readback_at=self.clock() if resource else None, error_code=error)
        self._put(connection, receipts, receipt, new=True, execution_id=str(execution.id),
                  action_id=str(action.id), decision_id=str(execution.decision_id))
        updated = execution.model_copy(update={"revision": execution.revision + 1, "status": result,
                                               "finished_at": self.clock(), "receipt_id": receipt.id})
        self._put(connection, claims, updated)
        status = {"succeeded": "executed", "failed": "execution_failed", "result_unknown": "reconciliation_required"}[result]
        if mission.status != status:
            self._move(connection, actor, mission, status, "Outcome" if result != "result_unknown" else "Execution")
        self._audit(connection, actor, updated, "execution_" + result, mission_id=mission.id)
        return updated

    def execute(self, actor_id: str, action_id, body: ExecuteRequest) -> Execution:
        execution, owned = self.claim(actor_id, action_id, body)
        if not owned:
            return execution
        return self._run_claimed(actor_id, action_id, execution)

    def retry(self, actor_id: str, execution_id, body: ExecuteRequest) -> Execution:
        with self._transaction(actor_id) as (connection, actor):
            execution = self._get(connection, actor, claims, execution_id, Execution)
            self._version(execution, body.expected_revision)
            if (execution.status != "failed" or execution.decision_id != body.decision_id
                    or execution.idempotency_key != body.idempotency_key or execution.receipt_id is None):
                raise PolicyDenied("retry_not_safe", 409)
            receipt = self._get(connection, actor, receipts, execution.receipt_id, Receipt)
            if receipt.error_code not in {"pre_dispatch_cancelled", "simulated_rejection"}:
                raise PolicyDenied("retry_not_safe", 409)
            action = self._get(connection, actor, actions, execution.action_id, ActionPreview)
            decision = self._get(connection, actor, decisions, execution.decision_id, ReviewDecision)
            mission = self._dispatch_check(connection, actor, action, decision)
            if mission.status != "execution_failed" or connection.execute(select(resources.c.id).where(
                    resources.c.organization_id == actor.organization_id,
                    resources.c.execution_id == str(execution.id))).first():
                raise PolicyDenied("retry_not_safe", 409)
            execution = execution.model_copy(update={"revision": execution.revision + 1, "status": "claimed",
                "attempt": execution.attempt + 1, "claimed_at": self.clock(), "dispatched_at": None,
                "finished_at": None, "receipt_id": None})
            self._put(connection, claims, execution)
            self._move(connection, actor, mission, "executing", "Execution")
            self._audit(connection, actor, execution, "retry_claimed", mission_id=mission.id)
        return self._run_claimed(actor_id, action.id, execution)

    def _run_claimed(self, actor_id, action_id, execution):
        self.mark_dispatching(actor_id, execution.id)
        # Simulate provider creation separately from the receipt transaction, preserving the same
        # crash window as a real remote write. Only the winner of the durable claim reaches this path.
        with self._transaction(actor_id) as (connection, actor):
            execution = self._get(connection, actor, claims, execution.id, Execution)
            if execution.status != "dispatching":
                return execution
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            decision = self._get(connection, actor, decisions, execution.decision_id, ReviewDecision)
            self._dispatch_check(connection, actor, action, decision)
            if self.simulation_profile not in {"reject", "timeout_before"}:
                resource_id = "simulation:" + str(uuid4())
                canonical = canonical_json(action.payload).decode("utf-8")
                connection.execute(resources.insert().values(id=resource_id, organization_id=actor.organization_id,
                    execution_id=str(execution.id), canonical_payload=canonical if self.simulation_profile != "mismatch" else "{}"))
        with self._transaction(actor_id) as (connection, actor):
            execution = self._get(connection, actor, claims, execution.id, Execution)
            if execution.status != "dispatching":
                return execution
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            resource = connection.execute(select(resources).where(resources.c.organization_id == actor.organization_id,
                resources.c.execution_id == str(execution.id))).mappings().first()
            if self.simulation_profile.startswith("timeout"):
                return self._finish(connection, actor, execution, action, "result_unknown", error="simulated_timeout")
            if self.simulation_profile == "reject":
                return self._finish(connection, actor, execution, action, "failed", error="simulated_rejection")
            if resource["canonical_payload"] != canonical_json(action.payload).decode("utf-8"):
                return self._finish(connection, actor, execution, action, "result_unknown", resource=resource,
                                    error="readback_mismatch")
            return self._finish(connection, actor, execution, action, "succeeded", resource=resource)

    def reconcile(self, actor_id, execution_id, expected_revision) -> Execution:
        with self._transaction(actor_id, review=True) as (connection, actor):
            execution = self._get(connection, actor, claims, execution_id, Execution)
            self._version(execution, expected_revision)
            if execution.status not in {"claimed", "dispatching", "result_unknown"}:
                raise PolicyDenied("reconciliation_not_required", 409)
            action = self._get(connection, actor, actions, execution.action_id, ActionPreview)
            if execution.status == "claimed":
                return self._finish(connection, actor, execution, action, "failed", error="pre_dispatch_cancelled")
            resource = connection.execute(select(resources).where(resources.c.organization_id == actor.organization_id,
                resources.c.execution_id == str(execution.id))).mappings().first()
            # Absence has no safe dispatch proof after a crash; retain the claim and uncertainty.
            if resource and resource["canonical_payload"] == canonical_json(action.payload).decode("utf-8"):
                return self._finish(connection, actor, execution, action, "succeeded", resource=resource)
            return self._finish(connection, actor, execution, action, "result_unknown", resource=resource,
                                error="readback_mismatch" if resource else "reconciliation_unavailable")

    def outcome(self, actor_id, mission_id, body: OutcomeRequest) -> Outcome:
        with self._transaction(actor_id) as (connection, actor):
            mission = self._get(connection, actor, missions, mission_id, Mission)
            self._version(mission, body.expected_revision)
            if mission.status not in {"executed", "execution_failed"}:
                raise PolicyDenied("outcome_not_available", 409)
            if body.basis != "manual_report":
                raise PolicyDenied("provider_business_observation_pending")
            if not set(body.evidence_ids) <= set(mission.evidence.evidence_ids):
                raise PolicyDenied("unknown_outcome_evidence")
            if body.receipt_id:
                receipt = self._get(connection, actor, receipts, body.receipt_id, Receipt)
                action = self._get(connection, actor, actions, receipt.action_id, ActionPreview)
                if action.mission_id != mission.id or receipt.result == "result_unknown":
                    raise PolicyDenied("outcome_receipt_mismatch", 409)
                # Simulation cannot establish actual customer contact/revenue change.
                if receipt.mode == "simulation" and body.kind != "follow_up_required":
                    raise PolicyDenied("simulation_has_no_business_outcome")
            outcome = Outcome(**self._base(actor), mission_id=mission.id, observer_id=actor.id,
                              observed_at=self.clock(), report=body)
            self._put(connection, outcomes, outcome, new=True, mission_id=str(mission.id),
                      receipt_id=str(body.receipt_id) if body.receipt_id else None)
            mission = self._move(connection, actor, mission, "outcome_recorded", "Outcome")
            self._move(connection, actor, mission, "completed", "Outcome")
            return outcome

    def _read(self, actor_id, table, entity_id, contract):
        with self._transaction(actor_id, write=False) as (connection, actor):
            return self._get(connection, actor, table, entity_id, contract)

    def get_mission(self, actor_id, mission_id):
        return self._read(actor_id, missions, mission_id, Mission)

    def get_plan(self, actor_id, plan_id):
        return self._read(actor_id, plans, plan_id, Plan)

    def list_missions(self, actor_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            values = connection.execute(select(missions.c.payload).where(
                missions.c.organization_id == actor.organization_id)).scalars()
            return sorted((Mission.model_validate(value) for value in values),
                          key=lambda mission: (mission.created_at, str(mission.id)), reverse=True)

    def get_action(self, actor_id, action_id):
        return self._read(actor_id, actions, action_id, ActionPreview)

    def action_history(self, actor_id, action_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, actions, action_id, ActionPreview)
            rows = connection.execute(select(versions.c.payload).where(
                versions.c.organization_id == actor.organization_id, versions.c.entity_id == str(action_id),
                versions.c.entity_type == actions.name).order_by(versions.c.revision)).scalars()
            return [ActionPreview.model_validate(row) for row in rows]

    def get_execution(self, actor_id, execution_id):
        return self._read(actor_id, claims, execution_id, Execution)

    def get_receipt(self, actor_id, receipt_id):
        return self._read(actor_id, receipts, receipt_id, Receipt)

    def canonical_payload(self, actor_id, action_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, actions, action_id, ActionPreview)
            return connection.execute(select(actions.c.canonical_payload).where(actions.c.organization_id == actor.organization_id,
                actions.c.id == str(action_id))).scalar_one()

    def audit(self, actor_id, mission_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, missions, mission_id, Mission)
            values = connection.execute(select(audits.c.payload).where(audits.c.organization_id == actor.organization_id,
                audits.c.mission_id == str(mission_id))).scalars()
            return sorted((AuditEvent.model_validate(value) for value in values), key=lambda event: event.sequence)
