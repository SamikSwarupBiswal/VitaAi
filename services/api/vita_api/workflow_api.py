"""Session-only governed simulation routes. GET never dispatches an action."""
from typing import Annotated
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse

from .contracts import ModelRun
from .governance import PolicyDenied
from .hubspot_execution import HubSpotExecutionReadiness, HubSpotWrites
from .identity import Actor
from .workflow import Workflow
from .workflow_contracts import (
    ActionPreview,
    AuditEvent,
    ExecuteRequest,
    Execution,
    Mission,
    MissionRequest,
    Outcome,
    OutcomeRequest,
    Plan,
    PlanRequest,
    PrepareRequest,
    Receipt,
    ReviewDecision,
    ReviewRequest,
    RevisionRequest,
    SubmitRequest,
    SupersedeRequest,
)

WORKFLOW_PREFIXES = ("/api/plans", "/api/missions", "/api/actions", "/api/executions", "/api/receipts")


def safe_error(code: str, status_code: int):
    return JSONResponse({"detail": {"code": code, "correlation_id": str(uuid4()),
                                    "remedy": "Read current state and check session, role, revision and evidence."}},
                        status_code=status_code)


def install_workflow_routes(app, store, identity, settings, provider=None, hubspot_transport=None):
    router = APIRouter()
    hubspot = HubSpotWrites(settings, hubspot_transport)

    @app.exception_handler(PolicyDenied)
    async def policy_error(request: Request, error: PolicyDenied):
        return safe_error(error.code, error.status_code)

    def current(request: Request) -> Actor:
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    def service(request: Request) -> Workflow:
        return Workflow(store, session_token=request.cookies.get("vitaai_session"), session_required=True,
                        provider=provider, hubspot=hubspot)

    Current = Annotated[Actor, Depends(current)]
    Service = Annotated[Workflow, Depends(service)]

    @router.get("/api/integrations/hubspot/accounts/{account_id}/execution-readiness",
                response_model=HubSpotExecutionReadiness)
    def hubspot_readiness(account_id: UUID, actor: Current, workflow: Service):
        return workflow.hubspot_readiness(actor.id, account_id)

    @router.post("/api/plans", response_model=Plan)
    def create_plan(body: PlanRequest, actor: Current, workflow: Service):
        return workflow.create_plan(actor.id, body)

    @router.post("/api/plans/generate", response_model=ModelRun)
    def generate_plan(body: PlanRequest, actor: Current, workflow: Service):
        return workflow.generate_plan(actor.id, body)

    @router.get("/api/plans/runs/{run_id}", response_model=ModelRun)
    def get_planning_run(run_id: UUID, actor: Current, workflow: Service):
        return workflow.get_planning_run(actor.id, run_id)

    @router.get("/api/plans/{plan_id}", response_model=Plan)
    def get_plan(plan_id: UUID, actor: Current, workflow: Service):
        return workflow.get_plan(actor.id, plan_id)

    @router.post("/api/missions", response_model=Mission)
    def create_mission(body: MissionRequest, actor: Current, workflow: Service):
        return workflow.create_mission(actor.id, body)

    @router.get("/api/missions", response_model=list[Mission])
    def list_missions(actor: Current, workflow: Service):
        return workflow.list_missions(actor.id)

    @router.get("/api/missions/{mission_id}", response_model=Mission)
    def get_mission(mission_id: UUID, actor: Current, workflow: Service):
        return workflow.get_mission(actor.id, mission_id)

    @router.get("/api/missions/{mission_id}/audit", response_model=list[AuditEvent])
    def get_audit(mission_id: UUID, actor: Current, workflow: Service):
        return workflow.audit(actor.id, mission_id)

    @router.get("/api/missions/{mission_id}/actions", response_model=list[ActionPreview])
    def list_actions(mission_id: UUID, actor: Current, workflow: Service):
        return workflow.list_actions(actor.id, mission_id)

    @router.post("/api/missions/{mission_id}/prepare", response_model=ActionPreview)
    def prepare(mission_id: UUID, body: PrepareRequest, actor: Current, workflow: Service):
        return workflow.prepare(actor.id, mission_id, body)

    @router.post("/api/missions/{mission_id}/supersede", response_model=Mission)
    def supersede_mission(mission_id: UUID, body: SupersedeRequest, actor: Current, workflow: Service):
        return workflow.supersede_mission(actor.id, mission_id, body)

    @router.get("/api/actions/{action_id}", response_model=ActionPreview)
    def get_action(action_id: UUID, actor: Current, workflow: Service):
        return workflow.get_action(actor.id, action_id)

    @router.post("/api/actions/{action_id}/submit", response_model=ActionPreview)
    def submit(action_id: UUID, body: SubmitRequest, actor: Current, workflow: Service):
        return workflow.submit(actor.id, action_id, body)

    @router.get("/api/actions/{action_id}/history", response_model=list[ActionPreview])
    def action_history(action_id: UUID, actor: Current, workflow: Service):
        return workflow.action_history(actor.id, action_id)

    @router.post("/api/actions/{action_id}/renew-review", response_model=ActionPreview)
    def renew_review(action_id: UUID, body: SubmitRequest, actor: Current, workflow: Service):
        return workflow.renew_review(actor.id, action_id, body)

    @router.post("/api/actions/{action_id}/review", response_model=ReviewDecision)
    def review(action_id: UUID, body: ReviewRequest, actor: Current, workflow: Service):
        return workflow.review(actor.id, action_id, body)

    @router.get("/api/actions/{action_id}/decisions", response_model=list[ReviewDecision])
    def list_decisions(action_id: UUID, actor: Current, workflow: Service):
        return workflow.list_decisions(actor.id, action_id)

    @router.get("/api/actions/{action_id}/executions", response_model=list[Execution])
    def list_executions(action_id: UUID, actor: Current, workflow: Service):
        return workflow.list_executions(actor.id, action_id)

    @router.post("/api/actions/{action_id}/execute", response_model=Execution)
    def execute(action_id: UUID, body: ExecuteRequest, actor: Current, workflow: Service):
        return workflow.execute(actor.id, action_id, body)

    @router.get("/api/executions/{execution_id}", response_model=Execution)
    def get_execution(execution_id: UUID, actor: Current, workflow: Service):
        return workflow.get_execution(actor.id, execution_id)

    @router.get("/api/receipts/{receipt_id}", response_model=Receipt)
    def get_receipt(receipt_id: UUID, actor: Current, workflow: Service):
        return workflow.get_receipt(actor.id, receipt_id)

    @router.post("/api/executions/{execution_id}/reconcile", response_model=Execution)
    def reconcile(execution_id: UUID, body: RevisionRequest, actor: Current, workflow: Service):
        return workflow.reconcile(actor.id, execution_id, body.expected_revision)

    @router.post("/api/missions/{mission_id}/outcomes", response_model=Outcome)
    def outcome(mission_id: UUID, body: OutcomeRequest, actor: Current, workflow: Service):
        return workflow.outcome(actor.id, mission_id, body)

    @router.get("/api/missions/{mission_id}/outcomes", response_model=list[Outcome])
    def list_outcomes(mission_id: UUID, actor: Current, workflow: Service):
        return workflow.list_outcomes(actor.id, mission_id)

    @router.post("/api/executions/{execution_id}/retry", response_model=Execution)
    def retry(execution_id: UUID, body: ExecuteRequest, actor: Current, workflow: Service):
        return workflow.retry(actor.id, execution_id, body)

    app.include_router(router)
