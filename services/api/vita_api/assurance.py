"""Authenticated read-only view over one fixed packaged synthetic report."""
from typing import Annotated

from fastapi import APIRouter, Depends, Request

from .governance import PolicyDenied
from .guardrail_evaluation import GuardrailReport, load_report
from .identity import Actor, Identity
from .workflow_contracts import WorkflowContract

PREFIX = "/api/assurance"


class AssuranceView(WorkflowContract):
    organization_id: str
    actor_id: str
    report: GuardrailReport


def install_assurance_routes(app, store, settings):
    router = APIRouter(prefix=PREFIX)
    identity = Identity(store.engine)

    def current(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        actor = identity.resolve(request.cookies.get("vitaai_session"))
        if actor is None:
            raise PolicyDenied("authentication_required", 401)
        return actor

    Current = Annotated[Actor, Depends(current)]

    @router.get("/guardrails", response_model=AssuranceView)
    def guardrail_report(request: Request, actor: Current):
        try:
            report = load_report()
        except (OSError, ValueError, RecursionError):
            raise PolicyDenied("assurance_report_unavailable", 503) from None
        if current(request) != actor:
            raise PolicyDenied("assurance_identity_changed", 409)
        return AssuranceView(organization_id=actor.organization_id, actor_id=actor.id, report=report)

    app.include_router(router)
