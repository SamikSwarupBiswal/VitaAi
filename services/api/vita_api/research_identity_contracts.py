"""Source-bound reviewer adjudication; supplied references are not machine-verified."""
import hashlib
import ipaddress
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID

from pydantic import AwareDatetime, Field, field_validator, model_validator

from .config import ResearchTarget
from .governance import canonical_json
from .research import ResearchContract, ResearchSource


class IdentityReference(ResearchContract):
    url: str = Field(min_length=1, max_length=2048)
    subject: str = Field(min_length=1, max_length=160, pattern=r"\S")
    excerpt: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    relation: str = Field(min_length=1, max_length=1000, pattern=r"\S")

    @field_validator("url")
    @classmethod
    def public_reference(cls, value):
        url = urlsplit(value)
        host = url.hostname or ""
        if (url.scheme != "https" or not host or "." not in host or url.username or url.password
                or url.port not in (None, 443) or url.query or url.fragment
                or any(char.isspace() or char == "\\" for char in value)):
            raise ValueError("Use a public HTTPS reference without credentials or query")
        try:
            ipaddress.ip_address(host)
        except ValueError:
            return value
        raise ValueError("IP address references are not supported")


class IdentityRequest(ResearchContract):
    expected_revision: int = Field(strict=True, ge=0)
    expected_run_revision: int = Field(strict=True, ge=1)
    expected_account_revision: int = Field(strict=True, ge=1)
    expected_snapshot_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    expected_sources_hash: str = Field(pattern=r"^[a-f0-9]{64}$")
    source_index: int = Field(strict=True, ge=0, le=4)
    source_url: str = Field(min_length=1, max_length=2048)
    decision: Literal["corroborated", "namesake_or_unrelated", "uncertain", "conflicting"]
    source_subject: str = Field(min_length=1, max_length=500, pattern=r"\S")
    note: str = Field(min_length=1, max_length=2000, pattern=r"\S")
    references: list[IdentityReference] = Field(default_factory=list, max_length=3)

    @model_validator(mode="after")
    def corroboration_evidence(self):
        if self.decision == "corroborated" and not self.references:
            raise ValueError("Corroboration requires subject-bound reference evidence")
        if len({item.url for item in self.references}) != len(self.references):
            raise ValueError("Reference URLs must be distinct")
        return self


class IdentityDecision(ResearchContract):
    id: UUID
    policy: Literal["research-identity-1"] = "research-identity-1"
    basis: Literal["reviewer_adjudication"] = "reviewer_adjudication"
    factual_confidence: Literal["unverified"] = "unverified"
    external_execution: Literal[False] = False
    organization_id: str
    account_id: UUID
    account_revision: int
    snapshot_hash: str
    run_id: UUID
    run_revision: int
    target: ResearchTarget
    sources_hash: str
    source_index: int
    source: ResearchSource
    revision: int
    supersedes_id: UUID | None
    actor_id: str
    created_at: AwareDatetime
    report: IdentityRequest


class IdentityInspection(ResearchContract):
    organization_id: str
    account_id: UUID
    account_revision: int
    snapshot_hash: str
    run_id: UUID
    run_revision: int
    sources_hash: str
    can_review: bool
    decisions: list[IdentityDecision] = Field(default_factory=list, max_length=5)
    history: list[IdentityDecision] = Field(default_factory=list, max_length=20)
    caveat: str = ("Identity decisions retain the reviewer's subject-bound conclusion and supplied evidence. "
        "References are not independently fetched or machine-verified. Corroboration can admit a candidate; "
        "uncertain, conflicting or unrelated decisions exclude it. Facts, confidence and action approvals remain unchanged.")


def identity_sources_hash(run):
    return hashlib.sha256(canonical_json([item.model_dump(mode="json") for item in run.sources])).hexdigest()


def identity_bound(decision, run, view):
    return (decision.organization_id == run.organization_id and decision.account_id == run.account_id
        and decision.run_id == run.id and decision.run_revision == run.revision and decision.target == run.target
        and decision.account_revision == view.account.revision and decision.snapshot_hash == view.assessment.snapshot_hash
        and decision.sources_hash == identity_sources_hash(run) and decision.source_index < len(run.sources)
        and decision.source == run.sources[decision.source_index])
