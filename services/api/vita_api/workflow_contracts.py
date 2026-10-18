"""Original governed-workflow contracts. These records never grant authority by themselves."""
import re
from datetime import date, timedelta
from typing import Annotated, Literal, Self
from uuid import UUID

from pydantic import (
    AfterValidator,
    AwareDatetime,
    BaseModel,
    ConfigDict,
    Field,
    StrictInt,
    model_validator,
)


def nonblank(value: str) -> str:
    if not value.strip() or "\0" in value:
        raise ValueError("Expected nonblank text without NUL")
    return value


def single_line(value: str) -> str:
    if "\r" in value or "\n" in value:
        raise ValueError("Expected a single line")
    return value


def utc(value):
    if value.utcoffset() != timedelta(0):
        raise ValueError("Expected UTC time")
    return value


Text = Annotated[str, Field(strict=True, min_length=1, max_length=2000), AfterValidator(nonblank)]
Reference = Annotated[str, Field(strict=True, min_length=1, max_length=200),
                      AfterValidator(nonblank), AfterValidator(single_line)]
Title = Annotated[str, Field(strict=True, min_length=1, max_length=255),
                  AfterValidator(nonblank), AfterValidator(single_line)]
Body = Annotated[str, Field(strict=True, min_length=1, max_length=20000), AfterValidator(nonblank)]
Hash = Annotated[str, Field(strict=True, pattern=r"^[a-f0-9]{64}$")]
Revision = Annotated[StrictInt, Field(ge=1)]
UTCTime = Annotated[AwareDatetime, AfterValidator(utc)]
Kind = Literal["hubspot_task_create", "hubspot_note_create", "outlook_draft_create"]
Template = Literal["account-action-1", "account-note-1", "account-outlook-draft-1", "account-follow-up-1"]
Mode = Literal["simulation", "live"]
Decision = Literal["approved", "rejected", "revision_required"]
MissionStatus = Literal["draft", "prepared", "awaiting_review", "approved", "rejected", "revision_required",
                        "executing", "executed", "execution_failed", "reconciliation_required",
                        "outcome_recorded", "completed", "superseded"]


def unique(values):
    if len(values) != len(set(values)):
        raise ValueError("Duplicate identifiers are not allowed")
    return values


EvidenceIDs = Annotated[tuple[UUID, ...], Field(min_length=1, max_length=100), AfterValidator(unique)]


class WorkflowContract(BaseModel):
    # Approved whitespace is significant. Tuples and frozen nested contracts prevent in-place edits.
    model_config = ConfigDict(extra="forbid", frozen=True, str_strip_whitespace=False,
                              allow_inf_nan=False, validate_default=True)
    schema_version: Literal["1"] = "1"


class Record(WorkflowContract):
    id: UUID
    organization_id: Reference
    created_at: UTCTime
    revision: Revision
    correlation_id: UUID


class EvidenceBinding(WorkflowContract):
    account_id: UUID
    account_revision: Revision
    snapshot_hash: Hash
    assessment_policy_version: Reference
    as_of: date
    evidence_ids: EvidenceIDs


class PlanStep(WorkflowContract):
    id: UUID
    kind: Kind
    content: Body
    evidence_ids: EvidenceIDs
    dependencies: Annotated[tuple[UUID, ...], Field(max_length=12), AfterValidator(unique)] = ()


class Alternative(WorkflowContract):
    id: UUID
    rationale: Text
    evidence_ids: EvidenceIDs
    steps: tuple[PlanStep, ...] = Field(min_length=1, max_length=12)
    risks: tuple[Text, ...] = Field(max_length=12)

    @model_validator(mode="after")
    def dependency_graph(self) -> Self:
        by_id = {step.id: step for step in self.steps}
        if len(by_id) != len(self.steps):
            raise ValueError("Step IDs must be unique")
        visiting, visited = set(), set()

        def visit(step_id):
            if step_id not in by_id:
                raise ValueError("Unknown dependency")
            if step_id in visiting:
                raise ValueError("Dependency cycle")
            if step_id in visited:
                return
            visiting.add(step_id)
            for dependency in by_id[step_id].dependencies:
                visit(dependency)
            visiting.remove(step_id)
            visited.add(step_id)

        for step in self.steps:
            if not set(step.evidence_ids) <= set(self.evidence_ids):
                raise ValueError("Step evidence must belong to its alternative")
            visit(step.id)
        return self


class PlanningOutput(WorkflowContract):
    intent: Literal["attention", "risk", "growth", "renewal", "manual_review", "monitor"]
    action_kind: Kind
    strategy: Literal["single_action", "follow_up"]
    alternatives: tuple[Alternative, ...] = Field(min_length=1, max_length=4)
    selected_alternative_id: UUID
    caveats: tuple[Text, ...] = Field(max_length=8)

    @model_validator(mode="after")
    def selection(self) -> Self:
        ids = unique(tuple(item.id for item in self.alternatives))
        if self.selected_alternative_id not in ids:
            raise ValueError("Unknown planning alternative")
        return self

    def check_request(self, evidence_ids, intent, action_kind, strategy):
        if (self.intent, self.action_kind, self.strategy) != (intent, action_kind, strategy):
            raise ValueError("Planning request mismatch")
        allowed = {UUID(str(item)) for item in evidence_ids}
        shapes = set()
        for alternative in self.alternatives:
            if not set(alternative.evidence_ids) <= allowed:
                raise ValueError("Unknown planning evidence")
            shape = tuple(step.kind for step in alternative.steps)
            shapes.add(shape)
            if strategy == "single_action":
                if shape != (action_kind,) or alternative.steps[0].dependencies:
                    raise ValueError("Unsupported single-action plan")
            elif (shape not in {("hubspot_task_create", "hubspot_note_create"),
                                ("outlook_draft_create", "hubspot_note_create")}
                  or alternative.steps[0].dependencies
                  or alternative.steps[1].dependencies != (alternative.steps[0].id,)):
                raise ValueError("Unsupported follow-up plan")
        if strategy == "follow_up" and (action_kind != "hubspot_task_create" or shapes != {
                ("hubspot_task_create", "hubspot_note_create"), ("outlook_draft_create", "hubspot_note_create")}):
            raise ValueError("Follow-up requires task and unsent-draft alternatives")


class Plan(Record):
    account_id: UUID
    pipeline_run_id: UUID | None = None
    evidence: EvidenceBinding
    author_id: Reference
    source: Literal["deterministic", "model"]
    model_run_id: UUID | None = None
    status: Literal["draft", "valid", "blocked", "superseded"]
    alternatives: tuple[Alternative, ...] = Field(min_length=1, max_length=4)
    selected_alternative_id: UUID
    caveats: tuple[Text, ...] = Field(max_length=12)
    validation: Literal["not_run", "valid", "blocked"]

    @model_validator(mode="after")
    def references(self) -> Self:
        ids = unique(tuple(item.id for item in self.alternatives))
        if self.selected_alternative_id not in ids or self.account_id != self.evidence.account_id:
            raise ValueError("Invalid plan selection or account binding")
        if (self.source == "model") != (self.model_run_id is not None):
            raise ValueError("Model source requires a model run; deterministic source cannot claim one")
        if self.status == "valid" and self.validation != "valid":
            raise ValueError("Valid plan requires validation")
        for alternative in self.alternatives:
            if not set(alternative.evidence_ids) <= set(self.evidence.evidence_ids):
                raise ValueError("Unknown plan evidence")
        return self


class Mission(Record):
    account_id: UUID
    owner_id: Reference
    template: Template
    plan_id: UUID
    plan_revision: Revision
    alternative_id: UUID | None = None
    content_revision: Revision = 1
    evidence: EvidenceBinding
    status: MissionStatus
    current_step: Literal["Review", "Evidence", "Outreach", "CRM Note", "Approval", "Execution", "Outcome"]
    allowed_kinds: Annotated[tuple[Kind, ...], Field(min_length=1, max_length=3), AfterValidator(unique)]
    transition_ids: tuple[UUID, ...] = ()
    supersedes_id: UUID | None = None
    superseded_by_id: UUID | None = None

    @model_validator(mode="after")
    def account_binding(self) -> Self:
        if self.account_id != self.evidence.account_id:
            raise ValueError("Mission account binding mismatch")
        return self


class DestinationBinding(WorkflowContract):
    connector_id: Reference
    provider: Literal["hubspot", "microsoft"]
    configuration_revision: Revision
    tenant_id: Reference
    target_account_id: UUID
    target_resource_id: Reference
    delegated_user_id: Reference | None = None
    mailbox_id: Reference | None = None

    @model_validator(mode="after")
    def mailbox_binding(self) -> Self:
        if self.provider == "microsoft":
            if not self.delegated_user_id or not self.mailbox_id:
                raise ValueError("Microsoft requires delegated user and mailbox binding")
        elif self.delegated_user_id is not None or self.mailbox_id is not None:
            raise ValueError("HubSpot cannot carry a mailbox binding")
        return self


class TaskPayload(WorkflowContract):
    kind: Literal["hubspot_task_create"] = "hubspot_task_create"
    title: Title
    body: Body
    due_at: UTCTime | None = None


class NotePayload(WorkflowContract):
    kind: Literal["hubspot_note_create"] = "hubspot_note_create"
    body: Body


class OutlookPayload(WorkflowContract):
    kind: Literal["outlook_draft_create"] = "outlook_draft_create"
    to: tuple[Reference, ...] = Field(min_length=1, max_length=10)
    subject: Title
    body_text: Body

    @model_validator(mode="after")
    def recipients(self) -> Self:
        # Deliberately bounded mailbox subset: plain ASCII addresses, no display names or headers.
        pattern = r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}"
        if any(not re.fullmatch(pattern, address) or len(address.split("@")[0]) > 64 for address in self.to):
            raise ValueError("Expected plain email addresses")
        unique(tuple(address.casefold() for address in self.to))
        return self


Payload = Annotated[TaskPayload | NotePayload | OutlookPayload, Field(discriminator="kind")]


class ActionPreview(Record):
    mission_id: UUID
    mission_revision: Revision
    plan_id: UUID
    plan_revision: Revision
    evidence: EvidenceBinding
    slot_id: UUID
    step_id: UUID | None = None
    destination: DestinationBinding
    payload: Payload
    payload_hash: Hash
    binding_hash: Hash
    policy_version: Reference
    mode: Mode
    preparer_id: Reference
    provider_request: Annotated[str, Field(strict=True, min_length=1, max_length=262144)] | None = None
    status: Literal["draft", "submitted", "superseded"]

    @model_validator(mode="after")
    def destination_kind(self) -> Self:
        expected = "microsoft" if self.payload.kind == "outlook_draft_create" else "hubspot"
        if self.destination.provider != expected or self.destination.target_account_id != self.evidence.account_id:
            raise ValueError("Destination kind/account mismatch")
        return self


class ReviewDecision(Record):
    action_id: UUID
    action_revision: Revision
    binding_hash: Hash
    decision: Decision
    reviewer_id: Reference
    authority_version: Reference
    decided_at: UTCTime
    expires_at: UTCTime
    reason: Text | None = None

    @model_validator(mode="after")
    def lifetime_and_reason(self) -> Self:
        if not self.decided_at < self.expires_at <= self.decided_at + timedelta(minutes=30):
            raise ValueError("Decision validity must be positive and at most 30 minutes")
        if self.decision != "approved" and self.reason is None:
            raise ValueError("Rejection/revision requires a reason")
        return self


class Execution(Record):
    action_id: UUID
    action_revision: Revision
    decision_id: UUID
    binding_hash: Hash
    logical_action_key: Hash
    idempotency_key: Reference
    requesting_actor_id: Reference
    attempt: Revision
    status: Literal["claimed", "dispatching", "succeeded", "failed", "result_unknown"]
    claimed_at: UTCTime
    dispatched_at: UTCTime | None = None
    finished_at: UTCTime | None = None
    receipt_id: UUID | None = None


class Receipt(Record):
    execution_id: UUID
    action_id: UUID
    decision_id: UUID
    binding_hash: Hash
    destination: DestinationBinding
    result: Literal["succeeded", "failed", "result_unknown"]
    mode: Mode
    provider_request_id: Reference | None = None
    provider_resource_id: Annotated[str, Field(strict=True, min_length=1, max_length=2048),
                                    AfterValidator(nonblank), AfterValidator(single_line)] | None = None
    recorded_at: UTCTime
    verification: Literal["not_run", "verified", "mismatch", "unavailable"]
    readback_hash: Hash | None = None
    readback_at: UTCTime | None = None
    error_code: Annotated[str, Field(pattern=r"^[a-z][a-z0-9_]{0,79}$")] | None = None

    @model_validator(mode="after")
    def independent_readback(self) -> Self:
        if self.result == "succeeded" and self.provider_resource_id is None:
            raise ValueError("Success requires a resource reference")
        if self.verification == "verified" and (self.result != "succeeded" or self.readback_hash is None
                                                 or self.readback_at is None):
            raise ValueError("Verification requires successful matching readback")
        return self


class RevisionRequest(WorkflowContract):
    expected_revision: Revision


class PlanRequest(RevisionRequest):
    account_id: UUID
    expected_snapshot_hash: Hash
    intent: Literal["attention", "risk", "growth", "renewal", "manual_review", "monitor"]
    model_run_id: UUID | None = None
    action_kind: Kind = "hubspot_task_create"
    strategy: Literal["single_action", "follow_up"] | None = None


class MissionRequest(RevisionRequest):
    plan_id: UUID
    template: Template = "account-action-1"
    alternative_id: UUID | None = None


class SupersedeRequest(RevisionRequest):
    plan_id: UUID
    expected_plan_revision: Revision
    alternative_id: UUID | None = None


class PrepareRequest(RevisionRequest):
    mode: Mode = "simulation"
    alternative_id: UUID
    step_id: UUID | None = None
    connector_id: Reference
    payload: Payload


class SubmitRequest(RevisionRequest):
    binding_hash: Hash


class ReviewRequest(SubmitRequest):
    decision: Decision
    reason: Text | None = None

    @model_validator(mode="after")
    def decision_reason(self) -> Self:
        if self.decision != "approved" and self.reason is None:
            raise ValueError("Rejection/revision requires a reason")
        return self


class ExecuteRequest(RevisionRequest):
    decision_id: UUID
    idempotency_key: Reference


class OutcomeRequest(RevisionRequest):
    supersedes_id: UUID | None = None
    receipt_id: UUID | None = None
    manual_action_reference: Reference | None = None
    kind: Literal["meeting_booked", "customer_contacted", "renewal_risk_reduced", "opportunity_created",
                  "no_response", "follow_up_required"]
    basis: Literal["manual_report", "provider_observation"]
    evidence_ids: EvidenceIDs
    note: Text

    @model_validator(mode="after")
    def action_reference(self) -> Self:
        if (self.receipt_id is None) == (self.manual_action_reference is None):
            raise ValueError("Identify exactly one receipt or manual action")
        if self.basis == "provider_observation" and self.receipt_id is None:
            raise ValueError("Provider observation requires a receipt")
        return self


class Outcome(Record):
    mission_id: UUID
    observer_id: Reference
    observed_at: UTCTime
    report: OutcomeRequest
    supersedes_id: UUID | None = None


class AuditEvent(Record):
    sequence: Revision
    entity_id: UUID
    entity_revision: Revision
    actor_id: Reference
    event_kind: Reference
    previous_state: Reference | None = None
    new_state: Reference
    action_id: UUID | None = None
    decision_id: UUID | None = None
    execution_id: UUID | None = None
    binding_hash: Hash | None = None
