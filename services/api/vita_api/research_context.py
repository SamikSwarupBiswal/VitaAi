"""Read-only pairing of selected CRM evidence and retained, untrusted research."""
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


class ResearchExclusion(ResearchContract):
    source_index: int = Field(ge=0, le=4)
    url: str
    reason: Literal["unsafe_url", "account_match", "duplicate", "unknown_publication", "stale_publication", "invalid_time"]


class ResearchReviewQuestion(ResearchContract):
    question: str
    evidence_ids: list[str]
    source_urls: list[str] = Field(max_length=5)


class ResearchBrief(ResearchContract):
    policy_version: Literal["research-brief-1"] = "research-brief-1"
    basis: Literal["internal_only", "supporting_context"]
    internal_summary: str
    internal_evidence_ids: list[str]
    verification_questions: list[ResearchReviewQuestion] = Field(default_factory=list, max_length=4)
    caveats: list[str]


class ResearchContext(ResearchContract):
    internal: AccountView
    retained_run: ResearchRun
    evaluated_at: AwareDatetime
    status: Literal["usable", "disabled", "mock", "fallback", "run_unavailable", "account_changed",
                    "target_changed", "invalid_window", "expired", "no_usable_sources"]
    usable_sources: list[ResearchSource] = Field(default_factory=list, max_length=5)
    exclusions: list[ResearchExclusion] = Field(default_factory=list, max_length=5)
    review_question: ResearchReviewQuestion | None = None
    brief: ResearchBrief | None = None
    factual_confidence: Literal["unverified"] = "unverified"
    caveat: str = ("Research remains untrusted supporting context. Domain membership is operator-declared, "
                   "not company identity or factual verification. No causal relationship, confidence uplift, "
                   "score, recommendation, plan, approval or execution change is established.")


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
    if context.status != "usable":
        brief.caveats.append(f"Public context is {context.status}. This brief uses internal observations only.")
        return brief
    urls = [source.url for source in context.usable_sources]
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


def build_context(view: AccountView, run: ResearchRun, target: ResearchTarget | None,
                  *, enabled: bool, now: datetime) -> ResearchContext:
    # Callers load the account and run in one authenticated scoped transaction.
    if str(run.account_id) != view.account.id or run.organization_id != view.account.organization_id:
        raise ValueError("research_context_scope_mismatch")
    context = ResearchContext(internal=view, retained_run=run, evaluated_at=now, status="run_unavailable")
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
            if not any(source_url(source.url, domain) for domain in [target.domain, *target.publisher_domains]):
                reason = "unsafe_url"
            elif source_match(source.url, source.title, source.text, target) != source.match:
                reason = "account_match"
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
