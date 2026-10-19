"""Explicit saved-event selection contracts and durable uniqueness; no network or inference."""
from typing import Literal
from uuid import UUID

from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    String,
    Table,
    UniqueConstraint,
)

from .hubspot_changes import SourceDetection, detections
from .storage import metadata
from .workflow_contracts import MissionRequest, Record, Revision, WorkflowContract
from .workflow_storage import reference

detections.to_metadata(metadata)
source_missions = Table("source_event_missions", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("detection_id", String(80), nullable=False),
    Column("event_id", String(80), nullable=False),
    Column("plan_id", String(80), nullable=False),
    Column("mission_id", String(80), nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "detection_id"),
    UniqueConstraint("organization_id", "event_id"),
    UniqueConstraint("organization_id", "plan_id"),
    UniqueConstraint("organization_id", "mission_id"),
    ForeignKeyConstraint(["detection_id"], ["hubspot_source_detections.id"]),
    reference("plan_id", "workflow_plans"), reference("mission_id", "workflow_missions"))


class SourceMissionRequest(MissionRequest):
    event_id: UUID
    expected_account_revision: Revision
    expected_source_id: UUID


class SourceMissionSelection(Record):
    policy_version: Literal["source-mission-1"] = "source-mission-1"
    actor_id: str
    detection: SourceDetection
    request: SourceMissionRequest
    mission_id: UUID


class SourceMissionResult(WorkflowContract):
    status: Literal["mission_created", "mission_exists"]
    selection: SourceMissionSelection
