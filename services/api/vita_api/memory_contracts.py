"""Sourced historical memory. A retained proposal is never current authority."""
from datetime import date
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field

from .pipeline import Recommendation, SignalContext
from .workflow_contracts import Hash, Record, Revision, Text, WorkflowContract


class MemoryCapture(WorkflowContract):
    pipeline_id: UUID
    expected_snapshot_hash: Hash


class MemoryLifecycle(WorkflowContract):
    expected_revision: Revision
    state: Literal["archived", "invalidated"]
    reason: Text


class MemorySource(WorkflowContract):
    kind: Literal["pipeline_account"] = "pipeline_account"
    pipeline_id: UUID
    actor_id: str | None
    started_at: AwareDatetime
    as_of: date
    content_hash: Hash


class MemoryEntry(Record):
    account_id: UUID
    captured_by: str
    visibility: Literal["organization"] = "organization"
    state: Literal["active", "archived", "invalidated"]
    source: MemorySource
    context: SignalContext
    recommendation: Recommendation


class MemoryEvent(Record):
    memory_id: UUID
    actor_id: str
    kind: Literal["captured", "archived", "invalidated"]
    reason: Text | None = None


class MemoryHistory(WorkflowContract):
    organization_id: str
    account_id: UUID
    limit: Literal[20] = 20
    total_count: int = Field(ge=0)
    has_more: bool
    items: list[MemoryEntry]
