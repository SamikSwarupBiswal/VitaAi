"""Read-only pairing of selected CRM evidence and retained, untrusted research."""
from datetime import datetime, timedelta
from typing import Literal

from pydantic import AwareDatetime, Field

from .config import ResearchTarget
from .contracts import AccountView
from .research import ResearchContract, ResearchRun, ResearchSource, source_url


class ResearchExclusion(ResearchContract):
    source_index: int = Field(ge=0, le=4)
    url: str
    reason: Literal["unsafe_url", "duplicate", "unknown_publication", "stale_publication", "invalid_time"]


class ResearchReviewQuestion(ResearchContract):
    question: str
    evidence_ids: list[str]
    source_urls: list[str] = Field(max_length=5)


class ResearchContext(ResearchContract):
    internal: AccountView
    retained_run: ResearchRun
    evaluated_at: AwareDatetime
    status: Literal["usable", "disabled", "mock", "fallback", "run_unavailable", "account_changed",
                    "target_changed", "invalid_window", "expired", "no_usable_sources"]
    usable_sources: list[ResearchSource] = Field(default_factory=list, max_length=5)
    exclusions: list[ResearchExclusion] = Field(default_factory=list, max_length=5)
    review_question: ResearchReviewQuestion | None = None
    factual_confidence: Literal["unverified"] = "unverified"
    caveat: str = ("Research remains untrusted supporting context. Domain membership is operator-declared, "
                   "not company identity or factual verification. No causal relationship, confidence uplift, "
                   "score, recommendation, plan, approval or execution change is established.")


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
            if not source_url(source.url, target.domain):
                reason = "unsafe_url"
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
    return context
