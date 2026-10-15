"""Deterministic checks over server-resolved state; callers supply current identity, never browser assertions."""
import hashlib
import json
from datetime import datetime
from uuid import UUID

from pydantic import BaseModel

from .contracts import AccountView, ModelRun
from .identity import Actor
from .workflow_contracts import (
    ActionPreview,
    DestinationBinding,
    EvidenceBinding,
    Plan,
    ReviewDecision,
)


class PolicyDenied(Exception):
    def __init__(self, code: str, status_code: int = 422):
        self.code = code
        self.status_code = status_code
        super().__init__(code)


def canonical_json(value) -> bytes:
    if isinstance(value, BaseModel):
        value = value.model_dump(mode="json")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def digest(value) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def payload_hash(payload) -> str:
    return digest(payload)


def evidence_binding(view: AccountView) -> EvidenceBinding:
    return EvidenceBinding(account_id=view.account.id, account_revision=view.account.revision,
                           snapshot_hash=view.assessment.snapshot_hash,
                           assessment_policy_version=view.assessment.policy_version, as_of=view.assessment.as_of,
                           evidence_ids=tuple(sorted(item.id for item in view.evidence)))


def check_plan(plan: Plan, view: AccountView, model_run: ModelRun | None = None):
    if (plan.organization_id != view.account.organization_id or plan.evidence != evidence_binding(view)
            or plan.account_id != UUID(view.account.id)):
        raise PolicyDenied("plan_evidence_changed", 409)
    if view.assessment.confidence < 100:
        raise PolicyDenied("evidence_requires_review")
    if plan.status != "valid" or plan.validation != "valid":
        raise PolicyDenied("plan_not_valid")
    if plan.source == "model" and (
            model_run is None or str(plan.model_run_id) != model_run.id or model_run.status != "succeeded"
                or model_run.validation != "schema_and_references_valid"
                or model_run.organization_id != plan.organization_id or model_run.account_id != str(plan.account_id)
                or model_run.account_revision != plan.evidence.account_revision
                or model_run.task != "planning" or model_run.planning is None
                or model_run.analysis is not None or model_run.drafts is not None
                or model_run.planning.alternatives != plan.alternatives
                or model_run.planning.selected_alternative_id != plan.selected_alternative_id
                or tuple(dict.fromkeys([*view.assessment.caveats, *model_run.planning.caveats])) != plan.caveats
            or model_run.snapshot_hash != plan.evidence.snapshot_hash):
        raise PolicyDenied("model_run_not_valid")
    if plan.source == "model":
        output = model_run.planning
        try:
            output.check_request([factor.evidence_id for factor in view.assessment.factors if factor.evidence_id],
                                 output.intent, output.action_kind, output.strategy)
        except ValueError:
            raise PolicyDenied("model_run_not_valid") from None


def binding_hash(action: ActionPreview) -> str:
    binding = {"schema_version": action.schema_version, "action_id": str(action.id), "action_revision": action.revision,
                       "organization_id": action.organization_id, "mission_id": str(action.mission_id),
                       "mission_revision": action.mission_revision, "plan_id": str(action.plan_id),
                       "plan_revision": action.plan_revision, "slot_id": str(action.slot_id),
                       "evidence": action.evidence.model_dump(mode="json"),
                       "destination": action.destination.model_dump(mode="json"), "policy_version": action.policy_version,
                       "mode": action.mode, "kind": action.payload.kind, "payload_hash": payload_hash(action.payload)}
    # Preserve hashes issued before step bindings existed.
    if action.step_id is not None:
        binding["step_id"] = str(action.step_id)
    return digest(binding)


def logical_action_key(action: ActionPreview) -> str:
    return digest({"organization_id": action.organization_id, "mission_id": str(action.mission_id),
                       "slot_id": str(action.slot_id), "mode": action.mode})


def authorize(actor: Actor | None, organization_id: str, review: bool = False):
    if actor is None:
        raise PolicyDenied("authentication_required", 401)
    roles = {"admin", "reviewer"} if review else {"admin", "reviewer", "seller"}
    if actor.organization_id != organization_id or actor.role not in roles:
        raise PolicyDenied("operation_denied", 403)


def check_execution(*, actor: Actor, reviewer: Actor | None, action: ActionPreview,
                    decision: ReviewDecision | None, evidence: EvidenceBinding, destination: DestinationBinding,
                    policy_version: str, now: datetime, separation_of_duties: bool = False):
    authorize(actor, action.organization_id)
    authorize(reviewer, action.organization_id, review=True)
    if decision is None or decision.decision != "approved":
        raise PolicyDenied("approval_required", 409)
    if (action.status != "submitted" or decision.organization_id != action.organization_id
            or decision.action_id != action.id or decision.action_revision != action.revision
            or decision.binding_hash != action.binding_hash or binding_hash(action) != action.binding_hash
            or payload_hash(action.payload) != action.payload_hash):
        raise PolicyDenied("approval_binding_changed", 409)
    if (decision.reviewer_id != reviewer.id or decision.authority_version != policy_version
            or action.policy_version != policy_version):
        raise PolicyDenied("reviewer_authority_changed", 409)
    if not decision.decided_at <= now < decision.expires_at:
        raise PolicyDenied("approval_expired", 409)
    if action.evidence != evidence or action.destination != destination:
        raise PolicyDenied("execution_context_changed", 409)
    if separation_of_duties and action.preparer_id == reviewer.id:
        raise PolicyDenied("separation_of_duties", 403)


TRANSITIONS = {
    "draft": {"prepared", "outcome_recorded"}, "prepared": {"prepared", "awaiting_review", "outcome_recorded"},
    "awaiting_review": {"approved", "rejected", "revision_required", "prepared"},
    "approved": {"executing", "prepared"}, "rejected": {"prepared"}, "revision_required": {"prepared"},
    "executing": {"executed", "execution_failed", "reconciliation_required"},
    "reconciliation_required": {"executed", "execution_failed"},
    "execution_failed": {"prepared", "outcome_recorded", "executing"}, "executed": {"outcome_recorded"},
    "outcome_recorded": {"completed"}, "completed": set(),
}


def transition(before: str, after: str) -> str:
    if after not in TRANSITIONS.get(before, set()):
        raise PolicyDenied("invalid_mission_transition", 409)
    return after
