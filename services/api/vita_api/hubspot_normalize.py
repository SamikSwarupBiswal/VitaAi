"""Original, explicit normalization. Missing source values never borrow synthetic facts."""
import hashlib
import json
import re
from datetime import UTC, date, datetime, time, timedelta
from decimal import Decimal
from uuid import NAMESPACE_URL, UUID, uuid5

from pydantic import Field

from .config import PROPERTY_SEMANTICS
from .contracts import Account, AccountSource, Evidence
from .hubspot import HubSpotContract


class HubSpotPreview(HubSpotContract):
    observation_id: UUID
    expected_account_revision: int
    mapping_hash: str
    preview_hash: str
    account: Account
    evidence: list[Evidence]
    field_status: dict[str, str]


class HubSpotPromoteRequest(HubSpotContract):
    expected_account_revision: int = Field(ge=1)
    observation_id: UUID
    preview_hash: str = Field(pattern=r"^[a-f0-9]{64}$")


class AccountSourceVersion(HubSpotContract):
    account_id: UUID
    selection: AccountSource
    account: Account
    evidence: list[Evidence]
    previous_account: Account
    previous_evidence: list[Evidence]


def source_datetime(raw):
    if re.fullmatch(r"[0-9]{1,16}", raw):
        return datetime(1970, 1, 1, tzinfo=UTC) + timedelta(milliseconds=int(raw))
    result = datetime.fromisoformat(raw)
    if result.tzinfo is None:
        raise ValueError("Measurement time must include timezone")
    return result.astimezone(UTC)


def source_date(raw):
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        return date.fromisoformat(raw)
    timestamp = source_datetime(raw)
    if timestamp.timetz().replace(tzinfo=None) != time():
        raise ValueError("Date must be midnight UTC")
    return timestamp.date()


def normalize(account, observation, connector):
    values = {"name": "Unknown", "industry": "Unknown", "annual_value": None, "renewal_date": None}
    status, facts = {}, []
    for field in ("name", "industry"):
        raw = observation.properties.get(field)
        status[field] = "missing" if raw is None or not raw.strip() else "valid"
        if status[field] == "valid":
            values[field] = raw.strip()
    for target in PROPERTY_SEMANTICS:
        mapping = connector.settings.hubspot_property_map.get(target)
        if mapping is None:
            status[target] = "unconfigured"
            continue
        raw = observation.properties.get(mapping.property)
        if raw is None or not raw.strip():
            status[target] = "missing"
            continue
        try:
            observed = observation.provider_updated_at
            if mapping.observed_at_property:
                observed = source_datetime(observation.properties.get(mapping.observed_at_property) or "")
                if observed > observation.provider_updated_at or observed < observation.provider_created_at:
                    raise ValueError("Measurement time outside source bounds")
            if target == "renewal_date":
                value = source_date(raw)
                values[target] = value
                metric, number, fact = "renewal", (value - observed.date()).days, f"Renewal date: {value.isoformat()}"
            else:
                if not re.fullmatch(r"[+-]?[0-9]+(?:\.[0-9]+)?", raw):
                    raise ValueError("Invalid number")
                number = Decimal(raw)
                lower, upper = {"annual_value": (0, 9007199254740991), "usage_change": (-100, 10000),
                                "support_cases": (0, 1000000), "expansion": (0, 100)}[target]
                if not lower <= number <= upper or (target in {"annual_value", "support_cases"} and number != int(number)):
                    raise ValueError("Invalid range or integer")
                if target == "annual_value":
                    values[target], status[target] = int(number), "valid"
                    continue
                metric, fact = target, f"{mapping.meaning}: {number} {mapping.unit}"
            status[target] = "valid"
            polarity = ("negative" if number < 0 else "positive" if number > 0 else "neutral") if target == "usage_change" else (
                "negative" if number > 0 else "neutral") if target == "support_cases" else (
                "positive" if number > 0 else "neutral") if target == "expansion" else "neutral"
            facts.append(Evidence(id=str(uuid5(NAMESPACE_URL, f"vitaai/hubspot/{observation.id}/{target}")),
                account_id=account.id, organization_id=account.organization_id, metric=metric, value=float(number),
                fact=fact, source="HubSpot", source_record=f"hubspot:{observation.portal_id}:{observation.company_id}:{observation.id}:{mapping.property}",
                observed_at=observed, ingested_at=observation.fetched_at, polarity=polarity, synthetic=False))
        except (ValueError, OverflowError):
            status[target] = "invalid"
    result = HubSpotPreview(observation_id=observation.id, expected_account_revision=account.revision,
        mapping_hash=connector.mapping_hash, preview_hash="", field_status=status, evidence=facts,
        account=Account.model_validate({**account.model_dump(), **values, "synthetic": False, "revision": account.revision + 1}))
    result.preview_hash = hashlib.sha256(json.dumps(result.model_dump(mode="json", exclude={"preview_hash"}),
        sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    return result
