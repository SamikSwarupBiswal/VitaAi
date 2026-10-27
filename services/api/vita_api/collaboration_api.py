"""Session-only collaboration; notifications are not sent."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from .collaboration import (
    Collaboration,
    Handoff,
    HandoffCreate,
    HandoffHistory,
    HandoffList,
    HandoffTransition,
    RecipientList,
)
from .governance import PolicyDenied

PREFIX = "/api/collaboration"


def install_collaboration_routes(app, store, settings):
    router = APIRouter(prefix=PREFIX)

    def service(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return Collaboration(store, request.cookies.get("vitaai_session"))

    Service = Annotated[Collaboration, Depends(service)]

    @router.get("/recipients", response_model=RecipientList)
    def recipients(collaboration: Service):
        return collaboration.recipients()

    @router.get("/accounts/{account_id}/handoffs", response_model=HandoffList)
    def list_handoffs(account_id: UUID, collaboration: Service):
        return collaboration.list(account_id)

    @router.post("/accounts/{account_id}/handoffs", response_model=Handoff)
    def create(account_id: UUID, body: HandoffCreate, collaboration: Service):
        return collaboration.create(account_id, body)

    @router.get("/handoffs/{handoff_id}", response_model=HandoffHistory)
    def history(handoff_id: UUID, collaboration: Service):
        return collaboration.history(handoff_id)

    @router.post("/handoffs/{handoff_id}/transition", response_model=Handoff)
    def transition(handoff_id: UUID, body: HandoffTransition, collaboration: Service):
        return collaboration.transition(handoff_id, body)

    app.include_router(router)
