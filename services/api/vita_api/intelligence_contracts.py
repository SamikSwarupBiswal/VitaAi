"""What-if simulations and observed trends never replace source facts."""
from datetime import timedelta
from typing import Literal
from uuid import UUID

from pydantic import AwareDatetime, Field, model_validator

from .contracts import AccountView, Assessment
from .workflow_contracts import Hash, Plan, Record, Revision, Text, WorkflowContract

Metric = Literal["usage_change", "support_cases", "expansion", "renewal"]


class ScenarioOverrides(WorkflowContract):
    usage_change: float | None = Field(default=None, ge=-100, le=1000)
    support_cases: int | None = Field(default=None, strict=True, ge=0, le=100000)
    expansion: float | None = Field(default=None, ge=0, le=100)
    renewal_days: int | None = Field(default=None, strict=True, ge=0, le=3650)

    @model_validator(mode="after")
    def nonempty(self):
        if not self.model_dump(exclude={"schema_version"}, exclude_none=True):
            raise ValueError("An explicit override is required")
        return self


class ScenarioRequest(WorkflowContract):
    request_id: UUID
    pipeline_id: UUID
    expected_snapshot_hash: Hash
    title: Text
    assumptions: tuple[Text, ...] = Field(min_length=1, max_length=8)
    overrides: ScenarioOverrides


class ScenarioOption(WorkflowContract):
    id: Literal["verify_assumptions", "prepare_review"]
    description: Text
    depends_on: tuple[Literal["verify_assumptions"], ...] = ()


class Scenario(Record):
    account_id: UUID
    author_id: str
    request: ScenarioRequest
    source_started_at: AwareDatetime
    source_author_id: str | None
    baseline: AccountView
    projected: Assessment
    projection_hash: Hash
    policy_version: Literal["what-if-1"] = "what-if-1"
    model_version: Literal["none-deterministic"] = "none-deterministic"
    mode: Literal["simulation"] = "simulation"
    alternatives: tuple[ScenarioOption, ...]
    caveats: tuple[Text, ...]


class ScenarioPromotion(WorkflowContract):
    expected_revision: Revision
    expected_current_snapshot_hash: Hash
    assumption_acknowledgement: Text


class PromotedScenario(Record):
    scenario_id: UUID
    account_id: UUID
    actor_id: str
    scenario_projection_hash: Hash
    assumption_acknowledgement: Text
    approval_status: Literal["unapproved"] = "unapproved"
    plan: Plan


class TrendRequest(WorkflowContract):
    pipeline_ids: tuple[UUID, ...] = Field(min_length=2, max_length=50)
    start: AwareDatetime
    end: AwareDatetime

    @model_validator(mode="after")
    def range_and_identity(self):
        if len(set(self.pipeline_ids)) != len(self.pipeline_ids):
            raise ValueError("Choose distinct saved observations")
        if self.end < self.start or self.end - self.start > timedelta(days=3660):
            raise ValueError("Invalid trend range")
        return self


class TrendPoint(WorkflowContract):
    pipeline_id: UUID
    snapshot_hash: Hash
    evidence_id: str
    source_record: str
    source: str
    observed_at: AwareDatetime
    saved_at: AwareDatetime
    value: float
    lineage_key: Hash | None = None
    source_version_at: AwareDatetime | None = None
    source_version_sequence: int | None = Field(default=None, ge=1)
    source_unit: str | None = None


class MetricTrend(WorkflowContract):
    metric: Metric
    unit: Literal["percent", "count", "score/100", "days"]
    status: Literal["observed", "unchanged", "insufficient", "gapped", "incompatible_sources", "conflicting"]
    points: tuple[TrendPoint, ...]
    delta: float | None
    per_day: float | None
    duplicate_count: int = Field(ge=0)
    corrected_count: int = Field(ge=0)
    excluded_count: int = Field(ge=0)
    superseded_points: tuple[TrendPoint, ...] = ()


class TrendReport(Record):
    account_id: UUID
    author_id: str
    request: TrendRequest
    mode: Literal["observed_history", "synthetic_history"]
    policy_version: Literal["trend-1"] = "trend-1"
    input_count: int
    available_count: int
    metrics: tuple[MetricTrend, ...]
    caveats: tuple[Text, ...]
