"""Read-only pairing of selected CRM evidence and retained, untrusted research."""
import re
from datetime import datetime, timedelta
from typing import Literal

from pydantic import AwareDatetime, Field

from .config import ResearchTarget
from .contracts import AccountView
from .research import (
    ResearchContract,
    ResearchRun,
    ResearchSource,
    source_match,
    source_url,
)
from .research_identity_contracts import IdentityDecision, identity_bound


class ResearchExclusion(ResearchContract):
    source_index: int = Field(ge=0, le=4)
    url: str
    reason: Literal["unsafe_url", "account_match", "duplicate", "unknown_publication", "stale_publication", "invalid_time",
                    "identity_unresolved", "identity_binding_changed"]


class ResearchReviewQuestion(ResearchContract):
    question: str
    evidence_ids: list[str]
    source_urls: list[str] = Field(max_length=5)


class ResearchTopic(ResearchContract):
    policy_version: Literal["research-topics-1"] = "research-topics-1"
    topic: Literal["Financing", "Leadership", "Workforce", "Regulation", "Markets", "Other public updates"]
    basis: Literal["keyword_mentions"] = "keyword_mentions"
    source_urls: list[str] = Field(min_length=1, max_length=5)
    factual_confidence: Literal["unverified"] = "unverified"


class ResearchBrief(ResearchContract):
    policy_version: Literal["research-brief-1"] = "research-brief-1"
    basis: Literal["internal_only", "supporting_context"]
    internal_summary: str
    internal_evidence_ids: list[str]
    verification_questions: list[ResearchReviewQuestion] = Field(default_factory=list, max_length=4)
    topics: list[ResearchTopic] = Field(default_factory=list, max_length=6)
    caveats: list[str]
    decision: "ResearchDecisionBrief | None" = None


class ResearchDecisionBrief(ResearchContract):
    policy_version: Literal["research-decision-1"] = "research-decision-1"
    focus: Literal["evidence_review", "risk_review", "growth_review", "competing_signals", "monitor"]
    executive_summary: str
    conversation_strategy: list[ResearchReviewQuestion] = Field(default_factory=list, max_length=6)
    suggested_opening: str | None = None
    proposed_crm_note: str | None = Field(default=None, max_length=20000)
    cautions: list[str]
    factual_confidence: Literal["unverified"] = "unverified"
    approval_status: Literal["unapproved"] = "unapproved"
    external_execution: Literal[False] = False


class ResearchContext(ResearchContract):
    internal: AccountView
    retained_run: ResearchRun
    evaluated_at: AwareDatetime
    status: Literal["usable", "disabled", "mock", "fallback", "run_unavailable", "account_changed",
                    "target_changed", "invalid_window", "expired", "no_usable_sources"]
    usable_sources: list[ResearchSource] = Field(default_factory=list, max_length=5)
    exclusions: list[ResearchExclusion] = Field(default_factory=list, max_length=5)
    identity_decisions: list[IdentityDecision] = Field(default_factory=list, max_length=5)
    review_question: ResearchReviewQuestion | None = None
    brief: ResearchBrief | None = None
    factual_confidence: Literal["unverified"] = "unverified"
    caveat: str = ("Research remains untrusted supporting context. Domain membership is operator-declared, "
                   "not company identity or factual verification. No causal relationship, confidence uplift, "
                   "score, recommendation, plan, approval or execution change is established.")


def group_topics(sources: list[ResearchSource]) -> list[ResearchTopic]:
    # Organize mentions, including negated/contradictory ones; never infer an event or its impact.
    patterns = [
        ("Financing", r"\b(?:funding|financing|investment|investments|ipo)\b"),
        ("Leadership", r"\b(?:ceo|cfo|leadership|executive|executives)\b"),
        ("Workforce", r"\b(?:layoff|layoffs|hiring|workforce|employees)\b"),
        ("Regulation", r"\b(?:regulation|regulations|regulatory|compliance|lawsuit|lawsuits)\b"),
        ("Markets", r"\b(?:market|markets|expansion|competition|competitor|competitors)\b"),
    ]
    groups = {label: set() for label, _ in patterns}
    groups["Other public updates"] = set()
    for source in sources:
        text = f"{source.title}\n{source.text}"
        matched = False
        for label, pattern in patterns:
            if re.search(pattern, text, flags=re.IGNORECASE):
                groups[label].add(source.url)
                matched = True
        if not matched:
            groups["Other public updates"].add(source.url)
    return [ResearchTopic(topic=label, source_urls=sorted(urls)) for label, urls in groups.items() if urls]


def build_brief(context: ResearchContext) -> ResearchBrief:
    view, assessment = context.internal, context.internal.assessment
    summary = (f"Saved internal assessment for {view.account.name} on {assessment.as_of}: "
               f"health {assessment.health}/100, risk {assessment.risk}/100 and opportunity {assessment.opportunity}/100. "
               f"Baseline evidence confidence is {assessment.confidence}%; research does not change it.")
    caveats = [*assessment.caveats, context.caveat]
    if view.account.annual_value is None or view.account.renewal_date is None:
        caveats.append("Commercial account data is missing. Public research cannot supply contract value or renewal facts.")
    if assessment.requires_review:
        caveats.append("The internal assessment requires review; public context cannot remove that requirement.")
    brief = ResearchBrief(basis="supporting_context" if context.status == "usable" else "internal_only",
        internal_summary=summary, internal_evidence_ids=sorted({item.id for item in view.evidence}), caveats=caveats)
    brief.decision = build_decision_brief(context)
    if context.status != "usable":
        brief.caveats.append(f"Public context is {context.status}. This brief uses internal observations only.")
        return brief
    urls = [source.url for source in context.usable_sources]
    brief.topics = group_topics(context.usable_sources)
    for metric, label in [("usage_change", "product usage"), ("support_cases", "unresolved support"),
                          ("expansion", "expansion interest"), ("renewal", "renewal timing")]:
        ids = sorted({item.id for item in view.evidence if item.metric == metric})
        if ids:
            brief.verification_questions.append(ResearchReviewQuestion(
                question=f"Check whether the cited public sources actually concern this account and are relevant to "
                         f"the saved {label} observations. Confirm dates and contradictory evidence before changing a plan.",
                evidence_ids=ids, source_urls=urls))
    if not brief.verification_questions:
        brief.verification_questions.append(ResearchReviewQuestion(
            question="Verify the cited public sources and resolve missing CRM evidence before planning. "
                     "Public context cannot fill those gaps.", evidence_ids=[], source_urls=urls))
    return brief


def build_decision_brief(context: ResearchContext) -> ResearchDecisionBrief:
    view, assessment = context.internal, context.internal.assessment
    ids = sorted({item.id for item in view.evidence})
    usable = context.status == "usable"
    urls = [source.url for source in context.usable_sources] if usable else []
    blocked = assessment.requires_review or assessment.confidence < 100
    if blocked:
        focus = "evidence_review"
    elif assessment.risk >= 45 and assessment.opportunity >= 65:
        focus = "competing_signals"
    elif assessment.risk >= 45:
        focus = "risk_review"
    elif assessment.opportunity >= 65:
        focus = "growth_review"
    else:
        focus = "monitor"
    summary = (f"Review focus: {focus.replace('_', ' ')} from the retained internal assessment on "
               f"{assessment.as_of}. Health {assessment.health}/100, risk {assessment.risk}/100, "
               f"opportunity {assessment.opportunity}/100; baseline evidence confidence {assessment.confidence}%. "
               f"Annual contract value {view.account.annual_value if view.account.annual_value is not None else 'Unknown'}; "
               f"renewal {view.account.renewal_date or 'Unknown'}. ")
    summary += ("Public sources are available for verification alongside these observations; no relationship or business effect is established."
                if usable else f"Public context is {context.status}; this review uses internal observations only.")
    strategy = [ResearchReviewQuestion(
        question="Check the original dates, source identities, missing values and contradictory internal evidence before preparing outreach.",
        evidence_ids=ids, source_urls=[])]
    if usable:
        strategy.append(ResearchReviewQuestion(
            question="Verify that the cited reports concern this account rather than a namesake, and confirm publication dates and contradictory reports.",
            evidence_ids=[], source_urls=urls))
        for metric, label in (("usage_change", "product usage"), ("support_cases", "unresolved support"),
                              ("expansion", "expansion interest")):
            evidence_ids = sorted({item.id for item in view.evidence if item.metric == metric})
            if evidence_ids:
                strategy.append(ResearchReviewQuestion(
                    question=f"Ask whether the public context, once verified, is relevant to the saved {label} observations; do not assume an explanation or causal relationship.",
                    evidence_ids=evidence_ids, source_urls=urls))
    strategy.append(ResearchReviewQuestion(
        question="Record a human conclusion with its evidence. Any task, note or outreach still requires separate preparation and fresh exact review in Missions.",
        evidence_ids=ids, source_urls=urls))
    can_propose = usable and not blocked and focus != "monitor"
    return ResearchDecisionBrief(focus=focus, executive_summary=summary, conversation_strategy=strategy,
        suggested_opening=("Could we review the dated account observations and confirm whether these public reports concern your organisation and priorities?"
                           if can_propose else None),
        proposed_crm_note=(f"Proposed internal evidence-review note, not a completed conversation or business outcome. "
                           f"Account {view.account.id}, revision {view.account.revision}, assessment {assessment.as_of}. "
                           f"Baseline risk {assessment.risk}/100 and opportunity {assessment.opportunity}/100 remain unchanged. "
                           f"Internal evidence: {', '.join(ids)}. Unverified public sources for human review: {', '.join(urls)}. "
                           "Confirm identity, dates and relevance; record the actual conclusion separately. This proposal is unapproved."
                           if can_propose else None),
        cautions=["Public source relevance and keyword groups are not verified identity, sentiment, causality or business impact.",
                  "Do not infer contract value, currency, renewal dates or product/support metrics from public reports.",
                  "Missing or contradictory internal evidence must be resolved; public context cannot increase baseline confidence or remove review gates.",
                  "A suggested opening or CRM note records no contact, task, approval, execution or outcome."])


def build_context(view: AccountView, run: ResearchRun, target: ResearchTarget | None,
                  *, enabled: bool, now: datetime, identity_decisions: list[IdentityDecision] | None = None) -> ResearchContext:
    # Callers load the account and run in one authenticated scoped transaction.
    if str(run.account_id) != view.account.id or run.organization_id != view.account.organization_id:
        raise ValueError("research_context_scope_mismatch")
    context = ResearchContext(internal=view, retained_run=run, evaluated_at=now, status="run_unavailable")
    context.identity_decisions = identity_decisions or []
    decisions = {item.source_index: item for item in context.identity_decisions}
    if not enabled:
        context.status = "disabled"
    elif run.account_revision != view.account.revision:
        context.status = "account_changed"
    elif target is None or target != run.target:
        context.status = "target_changed"
    elif run.mode in {"disabled", "mock", "fallback"}:
        context.status = run.mode
    elif run.status != "succeeded":
        context.status = "run_unavailable"
    elif (run.finished_at is None or run.expires_at is None or run.finished_at < run.started_at
            or run.finished_at > now or run.expires_at <= run.finished_at
            or run.expires_at > run.finished_at + timedelta(minutes=15)):
        context.status = "invalid_window"
    elif now >= run.expires_at:
        context.status = "expired"
    else:
        context.status = "no_usable_sources"
        seen = set()
        for index, source in enumerate(run.sources):
            reason = None
            decision = decisions.get(index)
            if not any(source_url(source.url, domain) for domain in [target.domain, *target.company_domains, *target.publisher_domains]):
                reason = "unsafe_url"
            elif source_match(source.url, source.title, source.text, target) != source.match:
                reason = "account_match"
            elif decision and (not identity_bound(decision, run, view) or decision.created_at > now):
                reason = "identity_binding_changed"
            elif ((decision and decision.report.decision != "corroborated")
                    or (source.match == "configured_publisher_identity_candidate" and decision is None)):
                reason = "identity_unresolved"
            elif source.url in seen:
                reason = "duplicate"
            elif source.published_at is None:
                reason = "unknown_publication"
            elif (source.fetched_at < run.started_at or source.fetched_at > run.finished_at
                    or source.published_at > source.fetched_at):
                reason = "invalid_time"
            elif source.freshness_at_fetch != "fresh" or source.published_at < now - timedelta(days=30):
                reason = "stale_publication"
            seen.add(source.url)
            if reason:
                context.exclusions.append(ResearchExclusion(source_index=index, url=source.url, reason=reason))
            else:
                context.usable_sources.append(source)
        if context.usable_sources:
            context.status = "usable"
            context.review_question = ResearchReviewQuestion(
                question="Does the cited public context affect how you interpret these internal observations? "
                         "Verify the sources and account identity before changing a plan.",
                evidence_ids=[item.id for item in view.evidence],
                source_urls=[item.url for item in context.usable_sources])
    context.brief = build_brief(context)
    return context
