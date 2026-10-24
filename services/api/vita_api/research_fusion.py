"""Explicit saved-research pairing with an unchanged saved recommendation."""
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Request
from pydantic import AwareDatetime, Field

from .governance import PolicyDenied
from .pipeline import PipelineRun, Recommendation
from .research import Research, ResearchContract
from .research_context import ResearchContext, ResearchReviewQuestion
from .research_service import ResearchService


class ResearchSpecialist(ResearchContract):
    role: Literal["research"] = "research"
    status: Literal["supporting_context", "missing_source"]
    research_run_id: UUID
    context_expires_at: AwareDatetime | None
    findings: list[ResearchReviewQuestion] = Field(default_factory=list, max_length=4)
    missing_sources: list[str] = Field(default_factory=list)
    factual_confidence: Literal["unverified"] = "unverified"


class ResearchFusion(ResearchContract):
    policy_version: Literal["saved-research-fusion-1"] = "saved-research-fusion-1"
    pipeline_run_id: UUID
    pipeline_started_at: AwareDatetime
    organization_id: str
    account_id: UUID
    recommendation: Recommendation
    research_context: ResearchContext
    research_specialist: ResearchSpecialist
    external_execution: Literal[False] = False


def pair_research(run: PipelineRun, context: ResearchContext) -> ResearchFusion:
    view = context.internal
    matches = [item for item in run.recommendations if item.account_id == view.account.id]
    inputs = [item for item in run.contexts if item.account.id == view.account.id]
    if (run.organization_id != view.account.organization_id or len(matches) != 1 or len(inputs) != 1
            or run.as_of != view.assessment.as_of):
        raise PolicyDenied("research_pipeline_binding_changed", 409)
    selected, original = matches[0], inputs[0]
    if (original.account != view.account or selected.assessment != view.assessment
            or sorted(original.evidence, key=lambda item: item.id) != sorted(view.evidence, key=lambda item: item.id)):
        raise PolicyDenied("research_pipeline_binding_changed", 409)
    usable = context.status == "usable"
    return ResearchFusion(pipeline_run_id=run.id, pipeline_started_at=run.started_at,
        organization_id=run.organization_id, account_id=view.account.id, recommendation=selected,
        research_context=context, research_specialist=ResearchSpecialist(
            status="supporting_context" if usable else "missing_source", research_run_id=context.retained_run.id,
            context_expires_at=context.retained_run.expires_at,
            findings=context.brief.verification_questions if usable and context.brief else [],
            missing_sources=[] if usable else ["eligible_selected_external_context"]))


def install_research_fusion_routes(app, store, settings):
    router = APIRouter(prefix="/api/pipeline")

    @router.get("/{pipeline_id}/research/{research_id}", response_model=ResearchFusion)
    def inspect(pipeline_id: UUID, research_id: UUID, request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        service = ResearchService(store, Research(settings), request.cookies.get("vitaai_session"))
        with service.transaction() as (connection, actor):
            run = store.get_pipeline(actor.organization_id, str(pipeline_id))
            if run is None:
                raise PolicyDenied("record_not_found", 404)
            context = service.context_in_transaction(connection, actor, research_id)
            return pair_research(run, context)

    app.include_router(router)
