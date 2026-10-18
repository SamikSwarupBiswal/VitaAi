"""Durable governed simulation, bounded HubSpot execution and advisory planning."""
import hashlib
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from time import perf_counter
from uuid import uuid4, uuid5

from sqlalchemy import func, select, text, update

from .contracts import Account, AccountView, ModelRun
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
from .hubspot import HubSpotFailure
from .hubspot_execution import HubSpotExecutionReadiness, provider_request
from .identity import Actor, sessions, token_digest, users
from .microsoft import (
    MicrosoftActionReadiness,
    MicrosoftExecutionReadiness,
    draft_request,
)
from .pipeline import action_role, governance_role
from .scoring import assess
from .storage import accounts, runs, selected_evidence
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
    SupersedeRequest,
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

SIMULATION_TEMPLATES = {
    "account-action-1": "hubspot_task_create",
    "account-note-1": "hubspot_note_create",
    "account-outlook-draft-1": "outlook_draft_create",
}


class Workflow:
    policy_version = "governance-1"

    def __init__(self, store, *, clock=None, simulation_profile="success", separation_of_duties=False,
                 session_token=None, session_required=False, provider=None, hubspot=None, microsoft=None):
        self.engine = store.engine
        self.clock = clock or (lambda: datetime.now(UTC))
        if simulation_profile not in {"success", "reject", "timeout_after", "timeout_before", "mismatch"}:
            raise ValueError("Unknown simulation profile")
        self.simulation_profile = simulation_profile
        self.separation_of_duties = separation_of_duties
        self.session_token = session_token
        self.session_required = session_required
        self.provider = provider
        self.hubspot = hubspot
        self.microsoft = microsoft

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

    def hubspot_readiness(self, actor_id, account_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            view = self._view(connection, actor, account_id)
            destination = None
            if self.hubspot:
                try:
                    destination = self.hubspot.destination(actor.organization_id, account_id, write=False)
                except PolicyDenied:
                    pass  # Unconfigured or unmapped: disclose no foreign connector identity.
            readback = destination is not None
            write = readback and self.hubspot.settings.hubspot_write_enabled
            return HubSpotExecutionReadiness(account_id=str(account_id), organization_id=actor.organization_id,
                account_revision=view.account.revision, write_configured=write, readback_configured=readback,
                can_prepare=write and actor.role != "viewer",
                can_reconcile=readback and actor.role in {"admin", "reviewer"}, destination=destination)

    def _base(self, actor, **changes):
        return {"id": uuid4(), "organization_id": actor.organization_id, "created_at": self.clock(),
                "revision": 1, "correlation_id": uuid4(), **changes}

    def microsoft_readiness(self, actor_id, mission_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            mission = self._get(connection, actor, missions, mission_id, Mission)
            view = self._view(connection, actor, mission.account_id)
            destination = None
            if self.microsoft:
                try:
                    destination = self.microsoft.destination(connection, actor, mission.account_id, write=False)
                except PolicyDenied:
                    pass  # No connection; never substitute the reviewer's mailbox for the maker's.
            writing = bool(self.microsoft and self.microsoft.settings.microsoft_write_enabled)
            readiness = []
            for action in self._actions(connection, actor, mission.id):
                if action.mode != "live" or action.destination.provider != "microsoft":
                    continue
                current = None
                if self.microsoft:
                    try:
                        maker = self._actor(connection, action.preparer_id)
                        if maker.organization_id == actor.organization_id:
                            current = self.microsoft.destination(connection, maker, mission.account_id, write=False)
                    except PolicyDenied:
                        pass
                same_mailbox = current is not None and current.model_copy(update={
                    "target_resource_id": action.destination.target_resource_id}) == action.destination
                readiness.append(MicrosoftActionReadiness(action_id=action.id, action_revision=action.revision,
                    binding_hash=action.binding_hash,
                    can_write=writing and actor.role != "viewer" and current == action.destination,
                    can_reconcile=same_mailbox and actor.role in {"admin", "reviewer"}))
            return MicrosoftExecutionReadiness(mission_id=mission.id, mission_revision=mission.revision,
                account_id=mission.account_id, account_revision=view.account.revision, organization_id=actor.organization_id,
                can_prepare=writing and destination is not None and actor.role != "viewer",
                destination=destination, actions=tuple(readiness))

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

    def _move(self, connection, actor, mission, status, step, event=None, *, aggregate=False, **changes):
        if aggregate and (mission.template != "account-follow-up-1" or mission.status in {"outcome_recorded", "completed"}
                or status not in {"prepared", "awaiting_review", "approved", "rejected", "revision_required",
                                  "executing", "executed", "execution_failed", "reconciliation_required"}):
            raise PolicyDenied("invalid_mission_transition", 409)
        updated = Mission.model_validate({**mission.model_dump(), "revision": mission.revision + 1,
                                         "status": status if aggregate else
                                         transition(mission.status, status), "current_step": step, **changes})
        audit = self._audit(connection, actor, updated, event or status, mission_id=mission.id, before=mission.status)
        updated = updated.model_copy(update={"transition_ids": (*updated.transition_ids, audit.id)})
        self._put(connection, missions, updated)
        return updated

    def _actions(self, connection, actor, mission_id):
        values = connection.execute(select(actions.c.payload).where(actions.c.organization_id == actor.organization_id,
            actions.c.mission_id == str(mission_id))).scalars()
        return [ActionPreview.model_validate(value) for value in values]

    def _claim_for(self, connection, actor, action):
        value = connection.execute(select(claims.c.payload).where(claims.c.organization_id == actor.organization_id,
            claims.c.action_id == str(action.id))).scalar()
        return Execution.model_validate(value) if value else None

    def _decision_for(self, connection, actor, action):
        value = connection.execute(select(decisions.c.payload).where(decisions.c.organization_id == actor.organization_id,
            decisions.c.action_id == str(action.id), decisions.c.action_revision == action.revision)).scalar()
        return ReviewDecision.model_validate(value) if value else None

    def _alternative(self, connection, actor, mission):
        plan = self._get(connection, actor, plans, mission.plan_id, Plan)
        return next(item for item in plan.alternatives if item.id == (mission.alternative_id or plan.selected_alternative_id))

    def _all_approved(self, connection, actor, mission):
        current = self._actions(connection, actor, mission.id)
        if len({item.mode for item in current}) > 1:
            raise PolicyDenied("mission_execution_mode_mismatch", 409)
        expected = {step.id for step in self._alternative(connection, actor, mission).steps}
        if {action.step_id for action in current} != expected:
            raise PolicyDenied("mission_not_approved", 409)
        for action in current:
            decision = self._decision_for(connection, actor, action)
            if (action.status != "submitted" or action.mission_revision != mission.content_revision
                    or decision is None or decision.decision != "approved" or decision.binding_hash != action.binding_hash):
                raise PolicyDenied("mission_not_approved", 409)
            execution = self._claim_for(connection, actor, action)
            if execution is None or execution.status != "succeeded":
                self._dispatch_check(connection, actor, action, decision, check_mission=False)

    def _dependencies(self, connection, actor, mission, action):
        step = next(item for item in self._alternative(connection, actor, mission).steps if item.id == action.step_id)
        by_step = {item.step_id: item for item in self._actions(connection, actor, mission.id)}
        for dependency in step.dependencies:
            prerequisite = by_step.get(dependency)
            execution = self._claim_for(connection, actor, prerequisite) if prerequisite else None
            if execution is None or execution.status != "succeeded" or execution.receipt_id is None:
                raise PolicyDenied("dependency_not_satisfied", 409)
            receipt = self._get(connection, actor, receipts, execution.receipt_id, Receipt)
            if (receipt.mode != action.mode or receipt.verification != "verified" or receipt.result != "succeeded"
                    or receipt.binding_hash != prerequisite.binding_hash or receipt.execution_id != execution.id):
                raise PolicyDenied("dependency_not_satisfied", 409)

    def _refresh(self, connection, actor, mission):
        # Multi-action state is a projection of durable per-action reviews/claims, never a UI assertion.
        current = self._actions(connection, actor, mission.id)
        executions = [self._claim_for(connection, actor, item) for item in current]
        statuses = {item.status for item in executions if item}
        complete = len(current) == len(self._alternative(connection, actor, mission).steps)
        if "result_unknown" in statuses:
            status = "reconciliation_required"
        elif statuses & {"claimed", "dispatching"}:
            status = "executing"
        elif "failed" in statuses:
            status = "execution_failed"
        elif complete and all(item and item.status == "succeeded" for item in executions):
            status = "executed"
        else:
            reviews = [self._decision_for(connection, actor, item) for item in current]
            verdicts = {item.decision for item in reviews if item}
            status = ("rejected" if "rejected" in verdicts else "revision_required" if "revision_required" in verdicts else
                      "prepared" if not complete or any(item.status == "draft" for item in current) else
                      "approved" if all(item and item.decision == "approved" for item in reviews) else "awaiting_review")
        step = "Execution" if status in {"executing", "reconciliation_required", "execution_failed"} else (
            "Outcome" if status == "executed" else "Approval")
        return self._move(connection, actor, mission, status, step, event="mission_aggregated", aggregate=True)

    def _view(self, connection, actor, account_id):
        row = connection.execute(select(accounts.c.payload).where(accounts.c.organization_id == actor.organization_id,
            accounts.c.id == str(account_id)).with_for_update()).scalar()
        if row is None:
            raise PolicyDenied("account_not_found", 404)
        account = Account.model_validate(row)
        facts = selected_evidence(connection, actor.organization_id, account_id)
        return AccountView(account=account, evidence=facts, assessment=assess(account, facts, self.clock().date()),
                           renewal_days=(account.renewal_date - self.clock().date()).days
                           if account.renewal_date is not None else None)

    def _plan_check(self, connection, actor, plan):
        run = None
        if plan.model_run_id:
            value = connection.execute(select(runs.c.payload).where(runs.c.organization_id == actor.organization_id,
                runs.c.id == str(plan.model_run_id))).scalar()
            run = ModelRun.model_validate(value) if value else None
        view = self._view(connection, actor, plan.account_id)
        check_plan(plan, view, run)
        return view

    def _planning_view(self, connection, actor, body):
        view = self._view(connection, actor, body.account_id)
        if (view.account.revision != body.expected_revision
                or view.assessment.snapshot_hash != body.expected_snapshot_hash):
            raise PolicyDenied("account_snapshot_changed", 409)
        proposal = action_role(view, governance_role(view.assessment), body.intent)
        if proposal.kind in {"monitor", "manual_review"} or body.intent in {"manual_review", "monitor"}:
            raise PolicyDenied("no_executable_action")
        if view.assessment.confidence < 100 or view.assessment.requires_review:
            raise PolicyDenied("evidence_requires_review")
        if body.strategy == "follow_up" and body.action_kind != "hubspot_task_create":
            raise PolicyDenied("strategy_kind_mismatch")
        return view, proposal

    def get_planning_run(self, actor_id, run_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            run = self._get(connection, actor, runs, run_id, ModelRun)
            if run.task != "planning":
                raise PolicyDenied("record_not_found", 404)
            return run

    def generate_plan(self, actor_id: str, body: PlanRequest) -> ModelRun:
        if body.model_run_id is not None:
            raise PolicyDenied("generation_requires_new_run")
        with self._transaction(actor_id) as (connection, actor):
            view, _ = self._planning_view(connection, actor, body)
        # Provider latency must not hold a database transaction or pass mutable authoritative state.
        started = perf_counter()
        run = ModelRun(id=str(uuid4()), organization_id=actor.organization_id, account_id=view.account.id,
            account_revision=view.account.revision, snapshot_hash=view.assessment.snapshot_hash, task="planning",
            model=None, status="unconfigured", validation="not_run", started_at=self.clock(), latency_ms=0)
        if self.provider is not None:
            try:
                result = self.provider.plan(view.model_copy(deep=True), body.intent, body.action_kind,
                                            body.strategy or "single_action")
            except (RuntimeError, OSError):
                # Provider exceptions can include headers or bodies; retain only a fixed safe failure code.
                run.status, run.error_code = "failed", "planning_provider_failed"
            else:
                try:
                    result = ModelRun.model_validate(result.model_dump(mode="json"))
                    for field in ("provider", "model", "request_id", "input_tokens", "output_tokens"):
                        setattr(run, field, getattr(result, field))
                    if (result.task != "planning" or result.organization_id != actor.organization_id
                            or result.account_id != view.account.id or result.account_revision != view.account.revision
                            or result.snapshot_hash != view.assessment.snapshot_hash
                            or result.analysis is not None or result.drafts is not None):
                        raise ValueError("Planning envelope mismatch")
                    if result.status == "succeeded":
                        if result.validation != "schema_and_references_valid" or result.planning is None:
                            raise ValueError("Planning validation required")
                        result.planning.check_request([factor.evidence_id for factor in view.assessment.factors
                            if factor.evidence_id], body.intent, body.action_kind, body.strategy or "single_action")
                    elif result.planning is not None or result.validation == "schema_and_references_valid":
                        raise ValueError("Failure cannot carry valid planning")
                    run = result.model_copy(update={"id": run.id, "started_at": run.started_at})
                except (ValueError, TypeError, AttributeError):
                    run.status, run.validation, run.error_code = "invalid_output", "rejected", "invalid_planning_output"
        run.latency_ms = round((perf_counter() - started) * 1000)
        with self._transaction(actor_id) as (connection, current):
            if current.organization_id != actor.organization_id:
                raise PolicyDenied("membership_changed", 409)
            try:
                self._planning_view(connection, current, body)
            except PolicyDenied:
                run.status, run.validation, run.error_code = "invalid_output", "rejected", "planning_context_changed"
                run.planning = None
            connection.execute(runs.insert().values(id=run.id, organization_id=run.organization_id,
                account_id=run.account_id, started_at=run.started_at.isoformat(), payload=run.model_dump(mode="json")))
        return run

    def create_plan(self, actor_id: str, body: PlanRequest) -> Plan:
        with self._transaction(actor_id) as (connection, actor):
            view, proposal = self._planning_view(connection, actor, body)
            if body.model_run_id:
                run = self._get(connection, actor, runs, body.model_run_id, ModelRun)
                if run.planning is None:
                    raise PolicyDenied("model_run_not_valid")
                try:
                    run.planning.check_request([factor.evidence_id for factor in view.assessment.factors
                        if factor.evidence_id], body.intent, body.action_kind, body.strategy or "single_action")
                except ValueError:
                    raise PolicyDenied("model_run_not_valid") from None
                plan = Plan(**self._base(actor), account_id=body.account_id, evidence=evidence_binding(view),
                    author_id=actor.id, source="model", model_run_id=body.model_run_id, status="valid",
                    alternatives=run.planning.alternatives, selected_alternative_id=run.planning.selected_alternative_id,
                    caveats=tuple(dict.fromkeys([*view.assessment.caveats, *run.planning.caveats])), validation="valid")
                check_plan(plan, view, run)
                self._put(connection, plans, plan, new=True, account_id=str(plan.account_id))
                self._audit(connection, actor, plan, "plan_created")
                return plan
            binding = evidence_binding(view)
            step = PlanStep(id=uuid4(), kind=body.action_kind, content=proposal.rationale,
                            evidence_ids=tuple(proposal.evidence_ids))
            alternative = Alternative(id=uuid4(), rationale=proposal.rationale, evidence_ids=step.evidence_ids,
                                      steps=(step,), risks=("Simulation only; no customer action occurs.",))
            alternatives = (alternative,)
            if body.strategy == "follow_up":
                if body.action_kind != "hubspot_task_create":
                    raise PolicyDenied("strategy_kind_mismatch")
                alternatives = []
                for kind, rationale in (("hubspot_task_create", "Create an internal follow-up task, then record a note."),
                                        ("outlook_draft_create", "Prepare an unsent follow-up draft, then record a note.")):
                    first = PlanStep(id=uuid4(), kind=kind, content=proposal.rationale, evidence_ids=step.evidence_ids)
                    note = PlanStep(id=uuid4(), kind="hubspot_note_create", content="Record the follow-up preparation.",
                                    evidence_ids=step.evidence_ids, dependencies=(first.id,))
                    alternatives.append(Alternative(id=uuid4(), rationale=rationale, evidence_ids=step.evidence_ids,
                        steps=(first, note), risks=("Simulation only; no customer action occurs.",)))
                alternatives = tuple(alternatives)
            plan = Plan(**self._base(actor), account_id=body.account_id, evidence=binding, author_id=actor.id,
                        source="deterministic", status="valid", alternatives=alternatives,
                        selected_alternative_id=alternatives[0].id, caveats=tuple(view.assessment.caveats), validation="valid")
            check_plan(plan, view)
            self._put(connection, plans, plan, new=True, account_id=str(plan.account_id))
            self._audit(connection, actor, plan, "plan_created")
            return plan

    def create_mission(self, actor_id: str, body: MissionRequest) -> Mission:
        with self._transaction(actor_id) as (connection, actor):
            return self._create_mission(connection, actor, body)

    def _create_mission(self, connection, actor, body, *, supersedes_id=None):
        plan = self._get(connection, actor, plans, body.plan_id, Plan)
        self._version(plan, body.expected_revision)
        self._plan_check(connection, actor, plan)
        selected = body.alternative_id or plan.selected_alternative_id
        alternative = next((item for item in plan.alternatives if item.id == selected), None)
        if alternative is None:
            raise PolicyDenied("alternative_not_in_plan")
        kinds = tuple(step.kind for step in alternative.steps)
        multi = body.template == "account-follow-up-1"
        matches = (kinds in (("hubspot_task_create", "hubspot_note_create"),
                             ("outlook_draft_create", "hubspot_note_create")) and
                   alternative.steps[1].dependencies == (alternative.steps[0].id,) and
                   not alternative.steps[0].dependencies) if multi else kinds == (SIMULATION_TEMPLATES[body.template],)
        if not matches:
            raise PolicyDenied("template_plan_mismatch")
        mission = Mission(**self._base(actor), account_id=plan.account_id, owner_id=actor.id,
                          template=body.template, plan_id=plan.id, plan_revision=plan.revision,
                          evidence=plan.evidence, status="draft", current_step="Review", supersedes_id=supersedes_id,
                          alternative_id=selected, allowed_kinds=tuple(dict.fromkeys(kinds)))
        self._put(connection, missions, mission, new=True, plan_id=str(plan.id))
        self._audit(connection, actor, mission, "mission_created", mission_id=mission.id)
        return mission

    def supersede_mission(self, actor_id: str, mission_id, body: SupersedeRequest) -> Mission:
        with self._transaction(actor_id) as (connection, actor):
            mission = self._get(connection, actor, missions, mission_id, Mission)
            self._version(mission, body.expected_revision)
            if mission.status not in {"draft", "prepared", "awaiting_review", "approved", "rejected", "revision_required"}:
                # Check claims first below for a specific, durable recovery boundary.
                available = False
            else:
                available = True
            if any(self._claim_for(connection, actor, item) for item in self._actions(connection, actor, mission.id)):
                raise PolicyDenied("mission_has_execution_claims", 409)
            if not available:
                raise PolicyDenied("mission_supersession_not_available", 409)
            view = self._view(connection, actor, mission.account_id)
            if view.evidence and mission.evidence == evidence_binding(view):
                raise PolicyDenied("mission_evidence_current", 409)
            plan = self._get(connection, actor, plans, body.plan_id, Plan)
            if plan.account_id != mission.account_id:
                raise PolicyDenied("mission_account_changed", 409)
            replacement = self._create_mission(connection, actor, MissionRequest(plan_id=plan.id,
                expected_revision=body.expected_plan_revision, template=mission.template,
                alternative_id=body.alternative_id), supersedes_id=mission.id)
            self._move(connection, actor, mission, "superseded", "Review", event="mission_superseded",
                       superseded_by_id=replacement.id)
            self._audit(connection, actor, replacement, "mission_replacement_created", mission_id=replacement.id)
            return replacement

    def _destination(self, actor, account_id, connector_id, kind, mode="simulation", connection=None):
        if mode == "live":
            if connector_id == "microsoft-live" and kind == "outlook_draft_create" and self.microsoft is not None:
                return self.microsoft.destination(connection, actor, account_id)
            if connector_id != "hubspot-live" or kind == "outlook_draft_create" or self.hubspot is None:
                raise PolicyDenied("connector_unavailable", 503)
            return self.hubspot.destination(actor.organization_id, account_id)
        expected = "simulation-microsoft" if kind == "outlook_draft_create" else "simulation-hubspot"
        if connector_id != expected:
            raise PolicyDenied("connector_unavailable", 503)
        mailbox = ({"delegated_user_id": actor.id, "mailbox_id": "simulation-mailbox:" + actor.id}
                   if kind == "outlook_draft_create" else {})
        return DestinationBinding(connector_id=connector_id,
                                  provider="microsoft" if kind == "outlook_draft_create" else "hubspot",
                                  configuration_revision=1,
                                  tenant_id="simulation:" + actor.organization_id, target_account_id=account_id,
                                  target_resource_id="simulation:" + str(account_id), **mailbox)

    def prepare(self, actor_id: str, mission_id, body: PrepareRequest) -> ActionPreview:
        with self._transaction(actor_id) as (connection, actor):
            mission = self._get(connection, actor, missions, mission_id, Mission)
            self._version(mission, body.expected_revision)
            if mission.status == "superseded":
                raise PolicyDenied("mission_superseded", 409)
            plan = self._get(connection, actor, plans, mission.plan_id, Plan)
            self._plan_check(connection, actor, plan)
            if mission.plan_revision != plan.revision or mission.evidence != plan.evidence:
                raise PolicyDenied("mission_plan_changed", 409)
            selected = mission.alternative_id or plan.selected_alternative_id
            alternative = next(item for item in plan.alternatives if item.id == selected)
            multi = mission.template == "account-follow-up-1"
            step = next((item for item in alternative.steps if item.id == body.step_id), None) if body.step_id else (
                alternative.steps[0] if len(alternative.steps) == 1 else None)
            if (body.alternative_id != selected or step is None or step.kind != body.payload.kind
                    or body.payload.kind not in mission.allowed_kinds):
                raise PolicyDenied("action_not_in_plan")
            existing = self._actions(connection, actor, mission.id)
            if multi and (mission.status == "completed" or any(self._claim_for(connection, actor, item) for item in existing)):
                raise PolicyDenied("mission_actions_frozen", 409)
            previous = next((item for item in existing if not multi or item.step_id == step.id), None)
            if previous and connection.execute(select(claims.c.id).where(claims.c.organization_id == actor.organization_id,
                    claims.c.action_id == str(previous.id))).first():
                raise PolicyDenied("action_already_claimed", 409)
            content_revision = mission.content_revision + 1
            # State-only transitions do not change the approved mission content revision.
            destination = self._destination(actor, mission.account_id, body.connector_id, body.payload.kind, body.mode, connection)
            action = ActionPreview(**self._base(actor, id=previous.id if previous else uuid4(),
                created_at=previous.created_at if previous else self.clock(),
                revision=previous.revision + 1 if previous else 1), mission_id=mission.id,
                mission_revision=content_revision, plan_id=plan.id, plan_revision=plan.revision, evidence=plan.evidence,
                slot_id=previous.slot_id if previous else uuid5(mission.id, str(step.id)),
                step_id=step.id if multi else None, destination=destination, payload=body.payload,
                payload_hash=payload_hash(body.payload), binding_hash="0" * 64, policy_version=self.policy_version,
                mode=body.mode, preparer_id=actor.id, status="draft")
            if action.mode == "live":
                action = action.model_copy(update={"provider_request": self._provider_request(action, destination)})
            action = action.model_copy(update={"binding_hash": binding_hash(action)})
            if previous:
                self._audit(connection, actor, previous, "approval_invalidated", mission_id=mission.id, after="superseded")
            self._put(connection, actions, action, new=previous is None, mission_id=str(mission.id), plan_id=str(plan.id),
                      slot_id=str(action.slot_id), step_id=str(action.step_id) if action.step_id else None,
                      canonical_payload=canonical_json(action.payload).decode("utf-8"))
            if multi:
                # Each preview binds the same final mission content; edits invalidate every review.
                for sibling in existing:
                    if sibling.id == action.id:
                        continue
                    updated = sibling.model_copy(update={"revision": sibling.revision + 1,
                        "mission_revision": content_revision, "status": "draft"})
                    updated = updated.model_copy(update={"binding_hash": binding_hash(updated)})
                    self._put(connection, actions, updated)
                    self._audit(connection, actor, updated, "approval_invalidated", mission_id=mission.id, after="draft")
            self._move(connection, actor, mission, "prepared", "Approval", content_revision=content_revision)
            self._audit(connection, actor, action, "action_prepared", mission_id=mission.id)
            return action

    def _context(self, connection, actor, action):
        mission = self._get(connection, actor, missions, action.mission_id, Mission)
        if mission.status == "superseded":
            raise PolicyDenied("mission_superseded", 409)
        plan = self._get(connection, actor, plans, action.plan_id, Plan)
        view = self._plan_check(connection, actor, plan)
        if (action.mission_revision != mission.content_revision or action.plan_revision != plan.revision
                or mission.plan_id != plan.id or mission.evidence != plan.evidence):
            raise PolicyDenied("mission_binding_changed", 409)
        if mission.template == "account-follow-up-1":
            alternative = next(item for item in plan.alternatives if item.id == mission.alternative_id)
            step = next((item for item in alternative.steps if item.id == action.step_id), None)
            if step is None or step.kind != action.payload.kind or action.slot_id != uuid5(mission.id, str(step.id)):
                raise PolicyDenied("action_not_in_plan")
        # Mailbox identity belongs to the reviewed preparation, not the reviewer or executor.
        preparer = self._actor(connection, action.preparer_id) if action.payload.kind == "outlook_draft_create" else actor
        if preparer.organization_id != actor.organization_id:
            raise PolicyDenied("mailbox_membership_changed", 409)
        destination = self._destination(preparer, mission.account_id, action.destination.connector_id, action.payload.kind, action.mode, connection)
        expected_request = self._provider_request(action, destination) if action.mode == "live" else None
        if (action.provider_request != expected_request or action.policy_version != self.policy_version
                or action.destination != destination or action.evidence != evidence_binding(view)
                or action.payload_hash != payload_hash(action.payload) or action.binding_hash != binding_hash(action)):
            raise PolicyDenied("action_binding_changed", 409)
        persisted = connection.execute(select(actions.c.canonical_payload).where(actions.c.organization_id == actor.organization_id,
            actions.c.id == str(action.id))).scalar_one()
        if persisted.encode("utf-8") != canonical_json(action.payload):
            raise PolicyDenied("canonical_payload_changed", 409)
        return mission, view, destination

    @staticmethod
    def _provider_request(action, destination):
        return (draft_request(action.payload) if destination.provider == "microsoft" else
                provider_request(action.payload, destination, action.created_at))

    def _adapter(self, action):
        return self.microsoft if action.destination.provider == "microsoft" else self.hubspot

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
            self._refresh(connection, actor, mission) if mission.template == "account-follow-up-1" else self._move(
                connection, actor, mission, "awaiting_review", "Approval")
            self._audit(connection, actor, submitted, "action_submitted", mission_id=mission.id)
            return submitted

    def renew_review(self, actor_id: str, action_id, body: SubmitRequest) -> ActionPreview:
        with self._transaction(actor_id) as (connection, actor):
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            self._version(action, body.expected_revision)
            mission, _, _ = self._context(connection, actor, action)
            if action.binding_hash != body.binding_hash:
                raise PolicyDenied("preview_changed", 409)
            decision = self._decision_for(connection, actor, action)
            executions = [self._claim_for(connection, actor, item)
                          for item in self._actions(connection, actor, mission.id)]
            if (mission.status in {"completed", "outcome_recorded"} or action.status != "submitted"
                    or decision is None or decision.decision != "approved"
                    or self._claim_for(connection, actor, action) is not None
                    or any(item and item.status != "succeeded" for item in executions)):
                raise PolicyDenied("review_renewal_not_available", 409)
            # Renew authority, never content. Claimed siblings retain their exact revisions and receipts.
            renewed = action.model_copy(update={"revision": action.revision + 1})
            renewed = renewed.model_copy(update={"binding_hash": binding_hash(renewed)})
            self._put(connection, actions, renewed)
            self._audit(connection, actor, action, "approval_invalidated", mission_id=mission.id, after="superseded")
            self._refresh(connection, actor, mission) if mission.template == "account-follow-up-1" else self._move(
                connection, actor, mission, "awaiting_review", "Approval")
            self._audit(connection, actor, renewed, "review_renewal_requested", mission_id=mission.id)
            return renewed

    def review(self, actor_id: str, action_id, body: ReviewRequest) -> ReviewDecision:
        with self._transaction(actor_id, review=True) as (connection, actor):
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            self._version(action, body.expected_revision)
            mission, _, _ = self._context(connection, actor, action)
            if (action.status != "submitted" or action.binding_hash != body.binding_hash
                    or (mission.template != "account-follow-up-1" and mission.status != "awaiting_review")
                    or self._decision_for(connection, actor, action) is not None):
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
            self._refresh(connection, actor, mission) if mission.template == "account-follow-up-1" else self._move(
                connection, actor, mission, body.decision, "Approval")
            self._audit(connection, actor, decision, "review_decided", mission_id=mission.id)
            return decision

    def _dispatch_check(self, connection, actor, action, decision, *, check_mission=True):
        mission, view, destination = self._context(connection, actor, action)
        if mission.status in {"outcome_recorded", "completed"}:
            raise PolicyDenied("mission_completed", 409)
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
        if check_mission and mission.template == "account-follow-up-1":
            self._all_approved(connection, actor, mission)
            self._dependencies(connection, actor, mission, action)
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
            if mission.template != "account-follow-up-1" and mission.status != "approved":
                raise PolicyDenied("mission_not_approved", 409)
            execution = Execution(**self._base(actor), action_id=action.id, action_revision=action.revision,
                                  decision_id=decision.id, binding_hash=action.binding_hash,
                                  logical_action_key=logical_action_key(action), idempotency_key=body.idempotency_key,
                                  requesting_actor_id=actor.id, attempt=1, status="claimed", claimed_at=self.clock())
            self._put(connection, claims, execution, new=True, action_id=str(action.id), decision_id=str(decision.id),
                      logical_action_key=execution.logical_action_key, idempotency_key=execution.idempotency_key)
            self._refresh(connection, actor, mission) if mission.template == "account-follow-up-1" else self._move(
                connection, actor, mission, "executing", "Execution")
            self._audit(connection, actor, execution, "execution_claimed", mission_id=mission.id)
            return execution, True

    def mark_dispatching(self, actor_id, execution_id, expected_attempt=None):
        with self._transaction(actor_id) as (connection, actor):
            execution = self._get(connection, actor, claims, execution_id, Execution)
            if expected_attempt is not None and execution.attempt != expected_attempt:
                raise PolicyDenied("dispatch_attempt_changed", 409)
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

    def _finish(self, connection, actor, execution, action, result, *, resource=None, error=None, live=None):
        mission = self._get(connection, actor, missions, action.mission_id, Mission)
        canonical = canonical_json(action.payload).decode("utf-8")
        matches = resource is not None and resource["canonical_payload"] == canonical
        receipt = Receipt(**self._base(actor), execution_id=execution.id, action_id=action.id,
                          decision_id=execution.decision_id, binding_hash=action.binding_hash,
                          destination=action.destination, result=result, mode=action.mode,
                          provider_resource_id=live["resource_id"] if live else resource["id"] if resource else None,
                          recorded_at=self.clock(),
                          verification=live["verification"] if live else "verified" if result == "succeeded" and matches else
                          "mismatch" if resource else "unavailable" if result == "result_unknown" else "not_run",
                          readback_hash=live["hash"] if live else hashlib.sha256(resource["canonical_payload"].encode("utf-8")).hexdigest()
                          if resource else None, readback_at=self.clock() if resource or (live and live["hash"]) else None, error_code=error)
        self._put(connection, receipts, receipt, new=True, execution_id=str(execution.id),
                  action_id=str(action.id), decision_id=str(execution.decision_id))
        updated = execution.model_copy(update={"revision": execution.revision + 1, "status": result,
                                               "finished_at": self.clock(), "receipt_id": receipt.id})
        self._put(connection, claims, updated)
        status = {"succeeded": "executed", "failed": "execution_failed", "result_unknown": "reconciliation_required"}[result]
        if mission.template == "account-follow-up-1":
            self._refresh(connection, actor, mission)
        elif mission.status != status:
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
            if (mission.status == "completed" or
                    (mission.template != "account-follow-up-1" and mission.status != "execution_failed")) or connection.execute(select(resources.c.id).where(
                    resources.c.organization_id == actor.organization_id,
                    resources.c.execution_id == str(execution.id))).first():
                raise PolicyDenied("retry_not_safe", 409)
            execution = execution.model_copy(update={"revision": execution.revision + 1, "status": "claimed",
                "attempt": execution.attempt + 1, "claimed_at": self.clock(), "dispatched_at": None,
                "finished_at": None, "receipt_id": None})
            self._put(connection, claims, execution)
            self._refresh(connection, actor, mission) if mission.template == "account-follow-up-1" else self._move(
                connection, actor, mission, "executing", "Execution")
            self._audit(connection, actor, execution, "retry_claimed", mission_id=mission.id)
        return self._run_claimed(actor_id, action.id, execution)

    def _run_claimed(self, actor_id, action_id, execution):
        execution = self.mark_dispatching(actor_id, execution.id, execution.attempt)
        # Simulate provider creation separately from the receipt transaction, preserving the same
        # crash window as a real remote write. Only the winner of the durable claim reaches this path.
        with self._transaction(actor_id) as (connection, actor):
            execution = self._get(connection, actor, claims, execution.id, Execution)
            if execution.status != "dispatching":
                return execution
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            decision = self._get(connection, actor, decisions, execution.decision_id, ReviewDecision)
            self._dispatch_check(connection, actor, action, decision)
            if action.mode == "simulation" and self.simulation_profile not in {"reject", "timeout_before"}:
                resource_id = "simulation:" + str(uuid4())
                canonical = canonical_json(action.payload).decode("utf-8")
                connection.execute(resources.insert().values(id=resource_id, organization_id=actor.organization_id,
                    execution_id=str(execution.id), canonical_payload=canonical if self.simulation_profile != "mismatch" else "{}"))
        if action.mode == "live":
            return self._run_live(actor_id, action, execution)
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

    @contextmanager
    def _result_transaction(self, actor):
        # An already authorized dispatch must durably record its result after session revocation
        # or user disablement. This private worker path cannot prepare, claim or dispatch work.
        with self.engine.connect() as connection:
            try:
                if self.engine.dialect.name == "sqlite":
                    connection.exec_driver_sql("BEGIN IMMEDIATE")
                else:
                    connection.begin()
                    key = int.from_bytes(hashlib.sha256(actor.organization_id.encode()).digest()[:8], "big", signed=True)
                    connection.execute(text("SELECT pg_advisory_xact_lock(:key)"), {"key": key})
                yield connection
                connection.commit()
            except BaseException:
                connection.rollback()
                raise

    def _record_live(self, actor, execution, action, result, resource_id, verification, readback_hash, error):
        with self._result_transaction(actor) as connection:
            current = self._get(connection, actor, claims, execution.id, Execution)
            if current.attempt != execution.attempt or current.status not in {"dispatching", "result_unknown"}:
                return current
            return self._finish(connection, actor, current, action, result, error=error,
                live={"resource_id": resource_id, "verification": verification, "hash": readback_hash})

    def _run_live(self, actor_id, action, execution):
        # Preflight GETs hold no database transaction. Recheck current authority after them.
        with self._transaction(actor_id) as (connection, actor):
            current = self._get(connection, actor, claims, execution.id, Execution)
            if current.status != "dispatching" or current.attempt != execution.attempt:
                return current
        adapter = self._adapter(action)
        try:
            adapter.preflight(action)
        except (HubSpotFailure, PolicyDenied):
            return self._record_live(actor, execution, action, "failed", None, "not_run", None,
                                     action.destination.provider + "_preflight_failed")
        with self._transaction(actor_id) as (connection, actor):
            current = self._get(connection, actor, claims, execution.id, Execution)
            if current.status != "dispatching" or current.attempt != execution.attempt:
                return current
            decision = self._get(connection, actor, decisions, current.decision_id, ReviewDecision)
            self._dispatch_check(connection, actor, action, decision)
        result, resource_id, error = adapter.create(action)
        # Persist a returned ID before a separate GET; failure here leaves dispatching, never retryable.
        current = self._record_live(actor, execution, action, result, resource_id, "unavailable", None, error)
        if resource_id is None or current.status != "result_unknown":
            return current
        verification, readback_hash, error = adapter.readback(action, resource_id)
        return self._record_live(actor, execution, action, "succeeded" if verification == "verified" else "result_unknown",
                                 resource_id, verification, readback_hash, error)

    def _reconcile_live(self, actor_id, execution_id, expected_revision):
        with self._transaction(actor_id, review=True) as (connection, actor):
            execution = self._get(connection, actor, claims, execution_id, Execution)
            self._version(execution, expected_revision)
            if execution.status not in {"claimed", "dispatching", "result_unknown"}:
                raise PolicyDenied("reconciliation_not_required", 409)
            action = self._get(connection, actor, actions, execution.action_id, ActionPreview)
            if execution.status == "claimed":
                return self._finish(connection, actor, execution, action, "failed", error="pre_dispatch_cancelled")
            prior = self._get(connection, actor, receipts, execution.receipt_id, Receipt) if execution.receipt_id else None
            resource_id = prior.provider_resource_id if prior else None
        adapter = self._adapter(action)
        verification, readback_hash, error = (adapter.readback(action, resource_id)
            if adapter is not None and resource_id else ("unavailable", None, "reconciliation_unavailable"))
        with self._transaction(actor_id, review=True) as (connection, actor):
            current = self._get(connection, actor, claims, execution.id, Execution)
            self._version(current, expected_revision)
            return self._finish(connection, actor, current, action,
                "succeeded" if verification == "verified" else "result_unknown", error=error,
                live={"resource_id": resource_id, "verification": verification, "hash": readback_hash})

    def reconcile(self, actor_id, execution_id, expected_revision) -> Execution:
        execution = self.get_execution(actor_id, execution_id)
        action = self.get_action(actor_id, execution.action_id)
        if action.mode == "live":
            return self._reconcile_live(actor_id, execution_id, expected_revision)
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
            history = self._outcomes(connection, actor, mission.id)
            previous = history[-1] if history else None
            correction = previous is not None
            if ((correction and (mission.status != "completed" or body.supersedes_id != previous.id))
                    or (not correction and body.supersedes_id is not None)):
                raise PolicyDenied("outcome_correction_changed", 409)
            manual = body.manual_action_reference is not None
            current = self._actions(connection, actor, mission.id)
            executions = [self._claim_for(connection, actor, item) for item in current]
            partial = (mission.template == "account-follow-up-1"
                       and any(item and item.status == "succeeded" for item in executions)
                       and any(item is None for item in executions))
            allowed = {"executed", "execution_failed", "completed"} if correction else {"executed", "execution_failed"}
            if manual and not correction:
                allowed |= {"draft", "prepared"}
                if partial:
                    allowed.add("approved")
            if mission.status not in allowed:
                raise PolicyDenied("outcome_not_available", 409)
            if any(item and item.status not in {"succeeded", "failed"} for item in executions):
                raise PolicyDenied("outcome_not_available", 409)
            if partial and body.kind != "follow_up_required":
                raise PolicyDenied("partial_execution_requires_follow_up")
            if (mission.template == "account-follow-up-1" and not manual
                    and (len(current) != len(self._alternative(connection, actor, mission).steps)
                         or any(item is None for item in executions))):
                raise PolicyDenied("outcome_not_available", 409)
            # Manually resolving a failed workflow is a follow-up disposition, not completion of skipped writes.
            if manual and any(item and item.status == "failed" for item in executions) and body.kind != "follow_up_required":
                raise PolicyDenied("failed_execution_requires_follow_up")
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
            outcome = Outcome(**self._base(actor, revision=previous.revision + 1 if previous else 1),
                              mission_id=mission.id, observer_id=actor.id, observed_at=self.clock(), report=body,
                              supersedes_id=previous.id if previous else None)
            self._put(connection, outcomes, outcome, new=True, mission_id=str(mission.id),
                      receipt_id=str(body.receipt_id) if body.receipt_id else None)
            audit = self._audit(connection, actor, outcome, "outcome_corrected" if correction else "outcome_reported",
                                mission_id=mission.id, after="manual_report")
            if correction:
                updated = mission.model_copy(update={"revision": mission.revision + 1,
                    "transition_ids": (*mission.transition_ids, audit.id)})
                self._put(connection, missions, updated)
            else:
                mission = self._move(connection, actor, mission, "outcome_recorded", "Outcome")
                self._move(connection, actor, mission, "completed", "Outcome")
            return outcome

    def _outcomes(self, connection, actor, mission_id):
        values = connection.execute(select(outcomes.c.payload).where(outcomes.c.organization_id == actor.organization_id,
            outcomes.c.mission_id == str(mission_id)).order_by(outcomes.c.revision)).scalars()
        return [Outcome.model_validate(value) for value in values]

    def list_outcomes(self, actor_id, mission_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, missions, mission_id, Mission)
            return self._outcomes(connection, actor, mission_id)

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

    def list_actions(self, actor_id, mission_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, missions, mission_id, Mission)
            return sorted(self._actions(connection, actor, mission_id), key=lambda item: (item.created_at, str(item.id)))

    def action_history(self, actor_id, action_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, actions, action_id, ActionPreview)
            rows = connection.execute(select(versions.c.payload).where(
                versions.c.organization_id == actor.organization_id, versions.c.entity_id == str(action_id),
                versions.c.entity_type == actions.name).order_by(versions.c.revision)).scalars()
            return [ActionPreview.model_validate(row) for row in rows]

    def list_decisions(self, actor_id, action_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            self._get(connection, actor, actions, action_id, ActionPreview)
            rows = connection.execute(select(decisions.c.payload).where(
                decisions.c.organization_id == actor.organization_id, decisions.c.action_id == str(action_id))
                .order_by(decisions.c.action_revision)).scalars()
            return [ReviewDecision.model_validate(row) for row in rows]

    def list_executions(self, actor_id, action_id):
        with self._transaction(actor_id, write=False) as (connection, actor):
            action = self._get(connection, actor, actions, action_id, ActionPreview)
            execution = self._claim_for(connection, actor, action)
            return [execution] if execution else []

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
