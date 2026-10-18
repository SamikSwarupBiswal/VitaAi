from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pydantic_core import PydanticCustomError

from .workflow_contracts import PlanningOutput


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    schema_version: Literal["1"] = "1"


class Evidence(Contract):
    id: str
    account_id: str
    organization_id: str
    metric: Literal["usage_change", "support_cases", "expansion", "renewal"]
    value: float
    fact: str
    source: str
    source_record: str
    observed_at: datetime
    ingested_at: datetime
    polarity: Literal["positive", "negative", "neutral"]
    synthetic: bool


class Account(Contract):
    id: str
    organization_id: str
    external_id: str
    name: str
    industry: str
    annual_value: int | None = Field(ge=0)
    renewal_date: date | None
    revision: int = Field(ge=1)
    created_at: datetime
    synthetic: bool


class ScoreFactor(Contract):
    metric: str
    value: float | None
    evidence_id: str | None
    risk_contribution: float
    opportunity_contribution: float


class Assessment(Contract):
    policy_version: Literal["baseline-1"] = "baseline-1"
    snapshot_hash: str
    as_of: date
    health: int = Field(ge=0, le=100)
    risk: int = Field(ge=0, le=100)
    opportunity: int = Field(ge=0, le=100)
    confidence: int = Field(ge=0, le=100)
    requires_review: bool = False
    needs_attention: bool
    growth_signal: bool
    recommendation: str
    factors: list[ScoreFactor]
    caveats: list[str]


class Finding(Contract):
    text: str = Field(min_length=1, max_length=1000)
    evidence_ids: list[str] = Field(min_length=1, max_length=12)


class Analysis(Contract):
    findings: list[Finding] = Field(min_length=1, max_length=6)
    next_steps: list[Finding] = Field(min_length=1, max_length=6)
    caveats: list[str] = Field(max_length=8)


ActionKind = Literal["manual_review", "support_escalation", "renewal_prep", "optimization_review",
                     "reactivation", "follow_up", "monitor"]


class CommunicationDrafts(Contract):
    action_kind: ActionKind
    email: Finding | None
    call_script: Finding | None
    voice_summary: Finding | None
    internal_note: Finding
    caveats: list[str] = Field(max_length=8)

    @model_validator(mode="after")
    def outreach_boundary(self):
        outreach = (self.email, self.call_script, self.voice_summary)
        if self.action_kind in {"monitor", "manual_review"}:
            if any(item is not None for item in outreach):
                raise PydanticCustomError("draft_outreach_forbidden", "Monitor and manual review cannot produce outreach")
        elif any(item is None for item in outreach):
            raise PydanticCustomError("draft_outreach_missing", "Outreach preparation requires email, call and voice drafts")
        return self

    def findings(self) -> list[Finding]:
        return [item for item in (self.email, self.call_script, self.voice_summary, self.internal_note)
                if item is not None]


class ModelRun(Contract):
    id: str
    account_id: str
    organization_id: str
    account_revision: int
    snapshot_hash: str
    provider: str = Field(default="nebius", pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    task: Literal["analysis", "drafts", "planning"] = "analysis"
    model: str | None
    status: Literal["unconfigured", "failed", "invalid_output", "succeeded"]
    validation: Literal["not_run", "rejected", "schema_and_references_valid"]
    started_at: datetime
    latency_ms: int
    request_id: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    error_code: str | None = None
    analysis: Analysis | None = None
    drafts: CommunicationDrafts | None = None
    planning: PlanningOutput | None = None


class AccountSource(Contract):
    id: str
    kind: Literal["hubspot", "local_sample"]
    account_revision: int = Field(ge=1)
    actor_id: str
    selected_at: datetime
    observation_id: str | None = None
    provider_updated_at: datetime | None = None
    mapping_hash: str | None = None
    field_status: dict[str, Literal["valid", "unconfigured", "missing", "invalid"]] = Field(default_factory=dict)


class AccountView(Contract):
    account: Account
    assessment: Assessment
    evidence: list[Evidence]
    renewal_days: int | None
    latest_run: ModelRun | None = None
    source: AccountSource | None = None


class Portfolio(Contract):
    organization_id: str
    mode: Literal["local_sample", "hubspot", "mixed"] = "local_sample"
    as_of: date
    annual_value: int | None
    annual_value_missing_count: int = Field(default=0, ge=0)
    attention_count: int
    growth_count: int
    accounts: list[AccountView]


class ProviderStatus(Contract):
    provider: str = Field(default="nebius", pattern=r"^[a-z][a-z0-9_-]{0,63}$")
    configured: bool
    model: str | None
    status: Literal["unconfigured", "configured_unverified", "discovered", "failed"]
    models: list[str] = Field(default_factory=list)
    error_code: str | None = None


class AnalyzeRequest(Contract):
    expected_revision: int = Field(ge=1)
    expected_snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
