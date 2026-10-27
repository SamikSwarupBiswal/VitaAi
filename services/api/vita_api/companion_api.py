"""Session-only companion API."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from .companion import (
    Companion,
    Conversation,
    ConversationHistory,
    ConversationStart,
    Turn,
    TurnRequest,
)
from .governance import PolicyDenied

PREFIX = "/api/companion"


def install_companion_routes(app, store, settings):
    router = APIRouter(prefix=PREFIX)

    def service(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return Companion(store, request.cookies.get("vitaai_session"))

    Service = Annotated[Companion, Depends(service)]

    @router.get("/accounts/{account_id}/sessions", response_model=list[Conversation])
    def list_sessions(account_id: UUID, companion: Service):
        return companion.list(account_id)

    @router.post("/accounts/{account_id}/sessions", response_model=Conversation)
    def start(account_id: UUID, body: ConversationStart, companion: Service):
        return companion.start(account_id, body)

    @router.get("/sessions/{session_id}", response_model=ConversationHistory)
    def history(session_id: UUID, companion: Service):
        return companion.history(session_id)

    @router.post("/sessions/{session_id}/turns", response_model=Turn)
    def turn(session_id: UUID, body: TurnRequest, companion: Service):
        return companion.turn(session_id, body)

    app.include_router(router)
