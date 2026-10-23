"""Read-only views of a retained pipeline snapshot; no tools or inference."""
from datetime import date
from typing import TYPE_CHECKING, Literal

from pydantic import Field

from .contracts import AccountView, Contract

if TYPE_CHECKING:
    from .pipeline import ActionProposal, CommunicationResult

SpecialistRole = Literal["risk", "growth", "research", "engagement", "governance"]


class SpecialistFinding(Contract):
    text: str
    evidence_ids: list[str]


class SpecialistPerspective(Contract):
    role: SpecialistRole
    status: Literal["deterministic", "missing_source", "deterministic_template", "model_validated",
                    "blocked", "unconfigured", "failed", "invalid_output"]
    findings: list[SpecialistFinding]
    missing_sources: list[str] = Field(default_factory=list)
    model_run_id: str | None = None


class SpecialistDisagreement(Contract):
    kind: Literal["conflicting_observations", "competing_signals"]
    roles: list[SpecialistRole]
    text: str
    evidence_ids: list[str]


class SpecialistReport(Contract):
    policy_version: Literal["specialists-1"] = "specialists-1"
    organization_id: str
    account_id: str
    account_revision: int
    snapshot_hash: str
    as_of: date
    perspectives: list[SpecialistPerspective]
    disagreements: list[SpecialistDisagreement]
    caveats: list[str]
    external_execution: Literal[False] = False


class PortfolioHighlight(Contract):
    account_id: str
    account_revision: int
    snapshot_hash: str
    score: int
    evidence_ids: list[str]


class PortfolioSpecialists(Contract):
    policy_version: Literal["specialists-1"] = "specialists-1"
    account_count: int
    recommendation_order: list[str]
    input_snapshots: dict[str, str]
    highest_risk: PortfolioHighlight | None
    highest_opportunity: PortfolioHighlight | None
    caveats: list[str]


def account_specialists(view: AccountView, action: "ActionProposal",
                        communication: "CommunicationResult") -> SpecialistReport:
    assessment = view.assessment
    perspectives = []
    for role, contribution in (("risk", "risk_contribution"), ("growth", "opportunity_contribution")):
        findings = [SpecialistFinding(
            text=f"{factor.metric}: {getattr(factor, contribution):g} baseline {role} contribution.",
            evidence_ids=[factor.evidence_id],
        ) for factor in assessment.factors if getattr(factor, contribution) > 0 and factor.evidence_id]
        missing = [factor.metric for factor in assessment.factors if factor.value is None]
        perspectives.append(SpecialistPerspective(
            role=role, status="missing_source" if missing else "deterministic", findings=findings or [
                SpecialistFinding(text=f"No positive {role} contribution in supplied baseline factors; gaps do not establish safety or absence of opportunity.",
                                  evidence_ids=[]),
            ], missing_sources=missing,
        ))

    disagreements = []
    # Match the baseline freshness horizon; retain every conflicting source ID.
    groups = {}
    for item in view.evidence:
        if 0 <= (assessment.as_of - item.observed_at.date()).days <= 30:
            groups.setdefault((item.metric, item.observed_at), []).append(item)
    for (metric, _), items in sorted(groups.items()):
        if len({item.value for item in items}) > 1:
            disagreements.append(SpecialistDisagreement(
                kind="conflicting_observations", roles=["risk", "growth", "governance"],
                text=f"Conflicting {metric} values at the same observation time; inspect the retained sources.",
                evidence_ids=sorted(item.id for item in items),
            ))
    if assessment.risk >= 45 and assessment.opportunity >= 65:
        disagreements.append(SpecialistDisagreement(
            kind="competing_signals", roles=["risk", "growth", "governance"],
            text="Baseline attention-level risk and growth-level opportunity coexist. These are competing considerations, not proof that either observation is false.",
            evidence_ids=sorted({f.evidence_id for f in assessment.factors
                                 if f.evidence_id and (f.risk_contribution > 0 or f.opportunity_contribution > 0)}),
        ))

    perspectives.extend([
        SpecialistPerspective(role="research", status="missing_source", missing_sources=["selected_external_context"],
            findings=[SpecialistFinding(text="No eligible external research context was selected for this pipeline run. No search or fusion was performed.", evidence_ids=[])]),
        SpecialistPerspective(role="engagement", status=communication.status, missing_sources=["contact_history"],
            model_run_id=communication.model_run.id if communication.model_run else None,
            findings=[SpecialistFinding(text="Preparation only: " + action.rationale, evidence_ids=action.evidence_ids),
                      SpecialistFinding(text="Contact history and customer response are unavailable; prepared communication does not establish engagement or a business outcome.", evidence_ids=[])]),
        SpecialistPerspective(role="governance", status="blocked" if assessment.requires_review or assessment.confidence < 100 else "deterministic",
            missing_sources=[name for name in ("annual_value", "renewal_date") if getattr(view.account, name) is None],
            findings=[SpecialistFinding(text=text, evidence_ids=[]) for text in assessment.caveats] + [
                SpecialistFinding(text="Specialist output grants no approval or external execution authority. Communication validation is not factual certification.", evidence_ids=[]),
            ]),
    ])
    return SpecialistReport(
        organization_id=view.account.organization_id, account_id=view.account.id,
        account_revision=view.account.revision, snapshot_hash=assessment.snapshot_hash, as_of=assessment.as_of,
        perspectives=perspectives, disagreements=disagreements,
        caveats=["Read-only deterministic specialist views; no additional model or provider call.",
                 "No consensus or factual-confidence score is inferred. Missing values remain Unknown."],
    )


def portfolio_specialists(views: list[AccountView], recommendation_order: list[str]) -> PortfolioSpecialists:
    def highlight(metric: str) -> PortfolioHighlight | None:
        if not views:
            return None
        selected = min(views, key=lambda v: (-getattr(v.assessment, metric), v.account.id))
        return PortfolioHighlight(
            account_id=selected.account.id, account_revision=selected.account.revision,
            snapshot_hash=selected.assessment.snapshot_hash, score=getattr(selected.assessment, metric),
            evidence_ids=[f.evidence_id for f in selected.assessment.factors
                          if f.evidence_id and getattr(f, metric + "_contribution") > 0],
        )

    return PortfolioSpecialists(
        account_count=len(views), recommendation_order=recommendation_order,
        input_snapshots={v.account.id: v.assessment.snapshot_hash for v in views},
        highest_risk=highlight("risk"), highest_opportunity=highlight("opportunity"),
        caveats=["Independent maxima of unchanged baseline risk and opportunity across all retained input accounts; ties use account ID.",
                 "Highlights do not reorder recommendations. Zero contributions or missing evidence do not establish safety, opportunity, or business effect."],
    )
