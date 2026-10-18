"""Offline, source-version-bound change records. No facts or workflow are mutated."""
import hashlib
import json
from datetime import datetime
from typing import Literal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import AwareDatetime, Field
from sqlalchemy import (
    JSON,
    Column,
    ForeignKeyConstraint,
    Integer,
    MetaData,
    String,
    Table,
    UniqueConstraint,
)

from .config import PROPERTY_SEMANTICS
from .governance import PolicyDenied
from .hubspot import HubSpotContract
from .hubspot_normalize import source_datetime
from .storage import accounts, source_versions

metadata = MetaData()
accounts.to_metadata(metadata)
source_versions.to_metadata(metadata)
detections = Table("hubspot_source_detections", metadata,
    Column("id", String(80), primary_key=True),
    Column("organization_id", String(80), nullable=False),
    Column("account_id", String(80), nullable=False),
    Column("source_version_id", String(80), nullable=False),
    Column("account_revision", Integer, nullable=False),
    Column("payload", JSON, nullable=False),
    UniqueConstraint("organization_id", "account_id", "account_revision"),
    UniqueConstraint("organization_id", "source_version_id"),
    ForeignKeyConstraint(["organization_id", "account_id"], ["accounts.organization_id", "accounts.id"]),
    ForeignKeyConstraint(["source_version_id"], ["account_source_versions.id"]))


class SourceField(HubSpotContract):
    value: str | int | float | None
    status: Literal["valid", "missing", "invalid", "unconfigured"]
    unit: str
    observed_at: AwareDatetime | None = None
    evidence_id: str | None = None


class SourceSnapshot(HubSpotContract):
    source_version_id: UUID
    account_revision: int = Field(ge=1)
    kind: Literal["hubspot", "local_sample"]
    selected_at: AwareDatetime
    observation_id: UUID | None = None
    portal_id: str | None = None
    company_id: str | None = None
    mapping_hash: str | None = None
    provider_created_at: AwareDatetime | None = None
    provider_updated_at: AwareDatetime | None = None
    fetched_at: AwareDatetime | None = None
    fields: dict[str, SourceField] = Field(default_factory=dict)


class SourceFieldChange(HubSpotContract):
    field: Literal["name", "industry", "annual_value", "renewal_date", "usage_change", "support_cases", "expansion"]
    kind: Literal["value_changed", "availability_changed"]
    before: SourceField
    after: SourceField


class SourceChangeEvent(HubSpotContract):
    id: UUID
    fingerprint: str = Field(pattern=r"^[a-f0-9]{64}$")
    changes: list[SourceFieldChange] = Field(min_length=1, max_length=7)


class SourceDetection(HubSpotContract):
    id: UUID
    organization_id: str
    account_id: UUID
    actor_id: str
    detected_at: AwareDatetime
    policy_version: Literal["source-change-1"] = "source-change-1"
    status: Literal["baseline", "unchanged", "changed", "source_reset"]
    reason: Literal["first_source", "local_sample", "source_switch", "source_identity_changed",
                    "mapping_changed", "values_unchanged", "values_changed"]
    before: SourceSnapshot | None
    after: SourceSnapshot
    event: SourceChangeEvent | None = None


class SourceDetectionRequest(HubSpotContract):
    expected_account_revision: int = Field(ge=1)
    expected_source_id: UUID


class SourceDetectionBatch(HubSpotContract):
    organization_id: str
    account_id: UUID
    account_revision: int
    selected_source_id: UUID
    processed: list[SourceDetection] = Field(max_length=20)
    last_processed_revision: int | None
    has_more: bool


def snapshot(version, observation):
    selection, account = version.selection, version.account
    if str(version.account_id) != account.id or selection.account_revision != account.revision:
        raise PolicyDenied("source_history_invalid", 409)
    result = SourceSnapshot(source_version_id=selection.id, account_revision=account.revision,
                            kind=selection.kind, selected_at=selection.selected_at)
    if selection.kind == "local_sample":
        return result
    if (observation is None or str(observation.id) != selection.observation_id
            or str(observation.account_id) != account.id or observation.organization_id != account.organization_id
            or observation.mapping_hash != selection.mapping_hash):
        raise PolicyDenied("source_history_invalid", 409)
    result.observation_id, result.portal_id, result.company_id = observation.id, observation.portal_id, observation.company_id
    result.mapping_hash = observation.mapping_hash
    result.provider_created_at, result.provider_updated_at = observation.provider_created_at, observation.provider_updated_at
    result.fetched_at = observation.fetched_at
    for field in ("name", "industry", *PROPERTY_SEMANTICS):
        status = selection.field_status.get(field, "unconfigured")
        unit = PROPERTY_SEMANTICS[field][1] if field in PROPERTY_SEMANTICS else "text"
        value, measured, evidence_id = None, None, None
        if status == "valid":
            if field in {"name", "industry", "annual_value", "renewal_date"}:
                value = getattr(account, field)
                if field == "renewal_date" and value is not None:
                    value = value.isoformat()
                measured = observation.provider_updated_at
                mapping = observation.property_mapping.get(field)
                if mapping and mapping.observed_at_property:
                    measured = source_datetime(observation.properties[mapping.observed_at_property])
            if field in {"renewal_date", "usage_change", "support_cases", "expansion"}:
                metric = "renewal" if field == "renewal_date" else field
                facts = [fact for fact in version.evidence if fact.metric == metric]
                if len(facts) != 1:
                    raise PolicyDenied("source_history_invalid", 409)
                fact = facts[0]
                measured, evidence_id = fact.observed_at, fact.id
                if field != "renewal_date":
                    value = fact.value
        result.fields[field] = SourceField(value=value, status=status, unit=unit,
                                          observed_at=measured, evidence_id=evidence_id)
    return result


def detect(organization_id: str, account_id: str, actor_id: str, before: SourceSnapshot | None,
           after: SourceSnapshot, detected_at: datetime) -> SourceDetection:
    """Compare values/status, excluding clock, revision, identity and evidence-ID churn."""
    changes = []
    if after.kind == "local_sample":
        status, reason = "source_reset", "local_sample"
    elif before is None:
        status, reason = "baseline", "first_source"
    elif before.kind != "hubspot":
        status, reason = "baseline", "source_switch"
    elif (before.portal_id, before.company_id) != (after.portal_id, after.company_id):
        status, reason = "baseline", "source_identity_changed"
    elif before.mapping_hash != after.mapping_hash:
        status, reason = "baseline", "mapping_changed"
    else:
        for field, current in after.fields.items():
            prior = before.fields[field]
            if (prior.status, prior.value) != (current.status, current.value):
                changes.append(SourceFieldChange(field=field, before=prior, after=current,
                    kind="availability_changed" if prior.status != current.status else "value_changed"))
        status, reason = ("changed", "values_changed") if changes else ("unchanged", "values_unchanged")
    event = None
    if changes:
        # Occurrence identities retain later genuine A->B transitions while retries deduplicate.
        canonical = {"policy": "source-change-1", "organization": organization_id, "account": account_id,
                     "before": str(before.source_version_id), "after": str(after.source_version_id),
                     "changes": [item.model_dump(mode="json") for item in changes]}
        fingerprint = hashlib.sha256(json.dumps(canonical, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        event = SourceChangeEvent(id=uuid5(NAMESPACE_URL, "vitaai/source-event/" + fingerprint),
                                  fingerprint=fingerprint, changes=changes)
    return SourceDetection(id=uuid5(NAMESPACE_URL, f"vitaai/source-detection/{organization_id}/{after.source_version_id}"),
        organization_id=organization_id, account_id=account_id, actor_id=actor_id, detected_at=detected_at,
        status=status, reason=reason, before=before, after=after, event=event)
