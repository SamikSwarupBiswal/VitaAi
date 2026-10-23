"""Six bounded roles over the existing baseline; communication cannot change policy."""
from datetime import UTC, date, datetime
from typing import Literal
from uuid import uuid4

from pydantic import Field, model_validator

from .contracts import (
    Account,
    AccountView,
    Assessment,
    CommunicationDrafts,
    Contract,
    Evidence,
    Finding,
    ModelRun,
    ScoreFactor,
)
from .models import AdvisoryProvider
from .scoring import assess
from .specialists import (
    PortfolioSpecialists,
    SpecialistReport,
    account_specialists,
    portfolio_specialists,
)

Intent = Literal["attention", "risk", "growth", "renewal", "manual_review", "monitor"]
Role = Literal["ingestion", "health", "opportunity", "governance", "action", "communication"]


class PipelineRequest(Contract):
    intent: Intent = "attention"
    limit: int = Field(default=3, ge=1, le=6)
    communicate: bool = False
    communication_mode: Literal["internal_note", "drafts"] = "internal_note"

    @model_validator(mode="after")
    def bounded_inference(self):
        if self.communicate and self.limit != 1:
            raise ValueError("Model communication is limited to one account per request")
        return self


class SignalContext(Contract):
    account: Account
    evidence: list[Evidence]
    positive_count: int
    negative_count: int


class HealthResult(Contract):
    health: int
    risk: int
    factors: list[ScoreFactor]


class OpportunityResult(Contract):
    score: int
    factors: list[ScoreFactor]


class GovernanceResult(Contract):
    status: Literal["review_required", "ready_for_preparation"]
    confidence: int
    caveats: list[str]
    requires_human_approval: Literal[True] = True


class ActionProposal(Contract):
    kind: Literal["manual_review", "support_escalation", "renewal_prep", "optimization_review",
                  "reactivation", "follow_up", "monitor"]
    rationale: str
    evidence_ids: list[str]
    approval_status: Literal["unapproved"] = "unapproved"
    external_execution: Literal[False] = False


class CommunicationResult(Contract):
    status: Literal["deterministic_template", "model_validated", "blocked", "unconfigured", "failed", "invalid_output"]
    internal_note: str | None = None
    evidence_ids: list[str]
    model_run: ModelRun | None = None
    drafts: CommunicationDrafts | None = None


class Recommendation(Contract):
    account_id: str
    rank: int
    assessment: Assessment
    health: HealthResult
    opportunity: OpportunityResult
    governance: GovernanceResult
    action: ActionProposal
    communication: CommunicationResult
    specialists: SpecialistReport | None = None


class PipelineStep(Contract):
    role: Role
    processed: int
    status: Literal["completed", "partial"] = "completed"


class PipelineRun(Contract):
    id: str
    organization_id: str
    actor_id: str | None
    started_at: datetime
    as_of: date
    request: PipelineRequest
    status: Literal["deterministic", "model_validated", "partial"]
    contexts: list[SignalContext]
    recommendations: list[Recommendation]
    steps: list[PipelineStep]
    caveats: list[str]
    portfolio_specialists: PortfolioSpecialists | None = None


def ingest(organization_id: str, account: Account, facts: list[Evidence]) -> SignalContext:
    if account.organization_id != organization_id or any(
        f.organization_id != organization_id or f.account_id != account.id for f in facts
    ):
        raise ValueError("Cross-scope pipeline input")
    if len({f.id for f in facts}) != len(facts):
        raise ValueError("Duplicate evidence identities")
    return SignalContext(account=account, evidence=sorted(facts, key=lambda f: f.id),
                         positive_count=sum(f.polarity == "positive" for f in facts),
                         negative_count=sum(f.polarity == "negative" for f in facts))


def health_role(assessment: Assessment) -> HealthResult:
    return HealthResult(health=assessment.health, risk=assessment.risk,
                        factors=[f for f in assessment.factors if f.risk_contribution > 0])


def opportunity_role(assessment: Assessment) -> OpportunityResult:
    return OpportunityResult(score=assessment.opportunity,
                             factors=[f for f in assessment.factors if f.opportunity_contribution > 0])


def governance_role(assessment: Assessment) -> GovernanceResult:
    return GovernanceResult(status="ready_for_preparation" if assessment.confidence == 100
                            and not assessment.requires_review else "review_required",
                            confidence=assessment.confidence, caveats=assessment.caveats + [
                                "Human approval is required for every external action.",
                            ])


def action_role(view: AccountView, governance: GovernanceResult, intent: Intent = "attention") -> ActionProposal:
    factors = {f.metric: f for f in view.assessment.factors}
    if governance.status == "review_required":
        kind = "manual_review"
    elif intent == "monitor":
        kind = "monitor"
    elif factors["support_cases"].risk_contribution >= 16:
        kind = "support_escalation"
    elif view.renewal_days is not None and 0 <= view.renewal_days <= 30:
        kind = "renewal_prep"
    elif (factors["usage_change"].value or 0) <= -15:
        kind = "optimization_review" if view.assessment.opportunity >= 50 else "reactivation"
    elif view.assessment.growth_signal:
        kind = "follow_up"
    else:
        kind = "monitor"
    rationales = {
        "manual_review": "Review missing or contradictory evidence before planning outreach.",
        "support_escalation": "Review {cases:g} unresolved support cases before commercial outreach.",
        "renewal_prep": "Prepare an evidence review for renewal in {days} days.",
        "optimization_review": "Review declining usage alongside expansion interest before proposing optimization.",
        "reactivation": "Review declining usage and prepare a reactivation conversation.",
        "follow_up": "Review growth evidence before preparing an expansion follow-up.",
        "monitor": "Monitor the account; the current signals do not require outreach.",
    }
    return ActionProposal(kind=kind, rationale=rationales[kind].format(
        cases=factors["support_cases"].value, days=view.renewal_days),
                          evidence_ids=[f.evidence_id for f in view.assessment.factors if f.evidence_id])


class Pipeline:
    def __init__(self, provider: AdvisoryProvider):
        self.provider = provider

    def communicate(self, view: AccountView, action: ActionProposal, governance: GovernanceResult,
                    use_model: bool, mode: Literal["internal_note", "drafts"] = "internal_note") -> CommunicationResult:
        if governance.status == "review_required":
            return CommunicationResult(status="blocked", evidence_ids=[],
                                       internal_note="Review evidence gaps before preparing communications.")
        if mode == "drafts":
            return self.prepare_drafts(view, action, use_model)
        if not use_model:
            return CommunicationResult(status="deterministic_template", evidence_ids=action.evidence_ids,
                                       internal_note="Internal preparation only: " + action.rationale)
        # Give the advisory adapter a separate object; its result cannot mutate the baseline.
        run = self.provider.analyze(view.model_copy(deep=True))
        if (run.organization_id != view.account.organization_id or run.account_id != view.account.id
                or run.account_revision != view.account.revision or run.snapshot_hash != view.assessment.snapshot_hash):
            raise ValueError("Model result does not bind to the pipeline snapshot")
        if run.status != "succeeded":
            return CommunicationResult(status=run.status, evidence_ids=[], model_run=run)
        allowed = set(action.evidence_ids)
        if run.analysis is None or any(not set(f.evidence_ids).issubset(allowed)
                                      for f in run.analysis.findings + run.analysis.next_steps):
            raise ValueError("Model references do not bind to the pipeline evidence")
        return CommunicationResult(
            status="model_validated", evidence_ids=sorted({e for f in run.analysis.findings + run.analysis.next_steps for e in f.evidence_ids}),
            internal_note="\n".join(f.text for f in run.analysis.findings + run.analysis.next_steps), model_run=run,
        )

    def prepare_drafts(self, view: AccountView, action: ActionProposal, use_model: bool) -> CommunicationResult:
        if use_model and action.kind not in {"monitor", "manual_review"}:
            run = self.provider.draft(view.model_copy(deep=True), action.kind)
            if (run.organization_id != view.account.organization_id or run.account_id != view.account.id
                    or run.account_revision != view.account.revision or run.snapshot_hash != view.assessment.snapshot_hash):
                return CommunicationResult(status="invalid_output", evidence_ids=[])
            if run.status != "succeeded":
                return CommunicationResult(status=run.status, evidence_ids=[], model_run=run)
            drafts = run.drafts
            if (run.task != "drafts" or run.validation != "schema_and_references_valid" or drafts is None
                    or drafts.action_kind != action.kind
                    or any(not set(item.evidence_ids).issubset(action.evidence_ids) for item in drafts.findings())):
                return CommunicationResult(status="invalid_output", evidence_ids=[])
            return CommunicationResult(status="model_validated", internal_note=drafts.internal_note.text,
                                       evidence_ids=sorted({e for item in drafts.findings() for e in item.evidence_ids}),
                                       drafts=drafts, model_run=run)
        purposes = {
            "support_escalation": "review the unresolved support issues and agree on a support-led next step",
            "renewal_prep": "review the upcoming renewal and discuss the current evidence of value",
            "optimization_review": "review declining usage alongside growth interest and explore adoption improvements",
            "reactivation": "understand the decline in usage and explore a useful way to re-engage",
            "follow_up": "review growth interest and discuss whether an expansion conversation would be useful",
            "monitor": "continue monitoring; no outreach is recommended",
            "manual_review": "review the evidence gaps before any outreach",
        }
        purpose = purposes[action.kind]
        facts = " ".join(f.fact for f in view.evidence if f.id in action.evidence_ids)

        def linked(text: str) -> Finding:
            return Finding(text=text, evidence_ids=action.evidence_ids)

        outreach = action.kind not in {"monitor", "manual_review"}
        drafts = CommunicationDrafts(
            action_kind=action.kind,
            email=linked(f"Hello, could we {purpose}? Our current account evidence: {facts}") if outreach else None,
            call_script=linked(f"Discuss {view.account.name}: {purpose}. Confirm the context with the customer. Evidence: {facts}") if outreach else None,
            voice_summary=linked(f"{view.account.name}: proposed next step is to {purpose}. {facts}") if outreach else None,
            internal_note=linked(f"Preparation for {view.account.name}: {action.rationale} Evidence: {facts} No external action has occurred."),
            caveats=["Deterministic preparation template; review facts and wording before use."],
        )
        return CommunicationResult(status="deterministic_template", internal_note=drafts.internal_note.text,
                                   evidence_ids=action.evidence_ids, drafts=drafts)

    def run(self, organization_id: str, actor_id: str | None,
            records: list[tuple[Account, list[Evidence]]], as_of: date, request: PipelineRequest) -> PipelineRun:
        started_at = datetime.now(UTC)
        contexts = [ingest(organization_id, account, facts) for account, facts in records]
        if len({c.account.id for c in contexts}) != len(contexts):
            raise ValueError("Duplicate account identities")
        views = [AccountView(account=c.account, evidence=c.evidence,
                             assessment=assess(c.account, c.evidence, as_of),
                             renewal_days=(c.account.renewal_date - as_of).days
                             if c.account.renewal_date is not None else None) for c in contexts]
        health = {v.account.id: health_role(v.assessment) for v in views}
        opportunity = {v.account.id: opportunity_role(v.assessment) for v in views}
        governance = {v.account.id: governance_role(v.assessment) for v in views}
        intent = request.intent
        use_model = request.communicate and intent != "monitor"
        selected = [v for v in views if (
            intent in {"attention", "risk"}
            or intent == "growth" and v.assessment.growth_signal
            or intent == "renewal" and v.renewal_days is not None and 0 <= v.renewal_days <= 45
            or intent == "manual_review" and governance[v.account.id].status == "review_required"
            or intent == "monitor" and not v.assessment.needs_attention and not v.assessment.growth_signal
        )]
        selected.sort(key=lambda v: (
            v.renewal_days if intent == "renewal" else
            -v.assessment.opportunity if intent == "growth" else
            v.assessment.confidence if intent == "manual_review" else -v.assessment.risk,
            v.account.id,
        ))
        recommendations = []
        for rank, view in enumerate(selected[:request.limit], start=1):
            policy = governance[view.account.id]
            action = action_role(view, policy, intent)
            communication = self.communicate(view, action, policy, use_model, request.communication_mode)
            recommendations.append(Recommendation(
                account_id=view.account.id, rank=rank, assessment=view.assessment,
                health=health[view.account.id], opportunity=opportunity[view.account.id], governance=policy,
                action=action, communication=communication,
                specialists=account_specialists(view, action, communication),
            ))
        partial = use_model and any(r.communication.status != "model_validated" for r in recommendations)
        return PipelineRun(
            id=str(uuid4()), organization_id=organization_id, actor_id=actor_id, started_at=started_at,
            as_of=as_of, request=request, contexts=contexts, recommendations=recommendations,
            portfolio_specialists=portfolio_specialists(views, [r.account_id for r in recommendations]),
            status="partial" if partial else "model_validated" if use_model and recommendations else "deterministic",
            steps=[PipelineStep(role=role, processed=len(contexts) if index < 4 else len(recommendations),
                                status="partial" if role == "communication" and partial else "completed")
                   for index, role in enumerate(("ingestion", "health", "opportunity", "governance", "action", "communication"))],
            caveats=["Preparation only; no approval, external execution, or business outcome."]
                    + (["No accounts matched the requested intent."] if not selected else []),
        )
