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
from .memory_sources import (
    SourceKind,
    SourceMemory,
    SourceMemoryCapture,
    SourceMemoryEntry,
    SourceMemoryEvent,
    SourceMemoryHistory,
    SourceMemoryLifecycle,
    SourceMemoryPreview,
    SourceRecallRequest,
    SourceRecallResult,
)

PREFIX = "/api/memory"


def install_memory_routes(app, store, settings):
    router = APIRouter(prefix=PREFIX)

    def service(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return Memory(store, request.cookies.get("vitaai_session"))

    Service = Annotated[Memory, Depends(service)]

    def source_service(request: Request):
        if settings.auth_mode != "session":
            raise PolicyDenied("session_identity_required", 503)
        return SourceMemory(store, request.cookies.get("vitaai_session"))

    Sources = Annotated[SourceMemory, Depends(source_service)]

    @router.get("/sources/accounts/{account_id}/preview/{kind}/{source_id}", response_model=SourceMemoryPreview)
    def preview_source(account_id: UUID, kind: SourceKind, source_id: UUID, memory: Sources):
        return memory.preview(account_id, kind, source_id)

    @router.get("/sources/accounts/{account_id}", response_model=SourceMemoryHistory)
    def source_history(account_id: UUID, memory: Sources):
        return memory.source_history(account_id)

    @router.post("/sources/accounts/{account_id}", response_model=SourceMemoryEntry)
    def capture_source(account_id: UUID, body: SourceMemoryCapture, memory: Sources):
        return memory.capture_source(account_id, body)

    @router.post("/sources/accounts/{account_id}/recall", response_model=SourceRecallResult)
    def recall_source(account_id: UUID, body: SourceRecallRequest, memory: Sources):
        return memory.source_recall(account_id, body)

    @router.get("/sources/{memory_id}", response_model=SourceMemoryEntry)
    def get_source(memory_id: UUID, memory: Sources):
        return memory.source_get(memory_id)

    @router.get("/sources/{memory_id}/events", response_model=list[SourceMemoryEvent])
    def source_events(memory_id: UUID, memory: Sources):
        return memory.source_audit(memory_id)

    @router.post("/sources/{memory_id}/lifecycle", response_model=SourceMemoryEntry)
    def lifecycle_source(memory_id: UUID, body: SourceMemoryLifecycle, memory: Sources):
        return memory.source_lifecycle(memory_id, body)

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
