"""Session-only memory routes with server-owned scope."""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request

from .governance import PolicyDenied
from .memory import Memory
from .memory_contracts import (
    MemoryCapture,
    MemoryEntry,
    MemoryEvent,
    MemoryHistory,
    MemoryLifecycle,
)
from .memory_retrieval import RecallRequest, RecallResult, recall

PREFIX = "/api/memory"


def install_memory_routes(app, store, settings):
    router = APIRouter(prefix=PREFIX)

    def service(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return Memory(store, request.cookies.get("vitaai_session"))

    Service = Annotated[Memory, Depends(service)]

    @router.post("/accounts/{account_id}", response_model=MemoryEntry)
    def capture(account_id: UUID, body: MemoryCapture, memory: Service):
        return memory.capture(account_id, body)

    @router.get("/accounts/{account_id}", response_model=MemoryHistory)
    def history(account_id: UUID, memory: Service):
        return memory.history(account_id)

    @router.post("/accounts/{account_id}/recall", response_model=RecallResult)
    def retrieve(account_id: UUID, body: RecallRequest, memory: Service):
        return recall(memory, account_id, body)

    @router.get("/{memory_id}", response_model=MemoryEntry)
    def get(memory_id: UUID, memory: Service):
        return memory.get(memory_id)

    @router.get("/{memory_id}/events", response_model=list[MemoryEvent])
    def audit(memory_id: UUID, memory: Service):
        return memory.audit(memory_id)

    @router.post("/{memory_id}/lifecycle", response_model=MemoryEntry)
    def lifecycle(memory_id: UUID, body: MemoryLifecycle, memory: Service):
        return memory.lifecycle(memory_id, body)

    app.include_router(router)
