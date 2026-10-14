from datetime import UTC, datetime, timedelta
from uuid import NAMESPACE_URL, uuid5

from .contracts import Account, Evidence

SAMPLE_ORG = "vitaai-sample"
SAMPLE_DATA = [
    ("Northstar Labs", "Enterprise software", 280000, 24, -32, 3, 12),
    ("Harbor Health", "Healthcare", 240000, 48, -18, 2, 16),
    ("Meridian Retail", "Retail", 180000, 72, -10, 2, 24),
    ("Atlas Logistics", "Logistics", 320000, 120, 18, 1, 70),
    ("Juniper Cloud", "Cloud infrastructure", 260000, 180, 28, 0, 80),
    ("Cedar Financial", "Financial services", 140000, 210, 4, 1, 38),
]


def sample_records(now: datetime):
    now = now.astimezone(UTC)
    result = []
    for name, industry, value, renewal, usage, cases, expansion in SAMPLE_DATA:
        external_id = name.lower().replace(" ", "-")
        account_id = str(uuid5(NAMESPACE_URL, f"vitaai/sample/{external_id}"))
        account = Account(
            id=account_id, organization_id=SAMPLE_ORG, external_id=external_id,
            name=name, industry=industry, annual_value=value,
            renewal_date=(now + timedelta(days=renewal)).date(),
            revision=1, created_at=now, synthetic=True,
        )
        observations = [
            ("usage_change", usage, f"Product usage {'up' if usage >= 0 else 'down'} {abs(usage)}%",
             "positive" if usage >= 0 else "negative"),
            ("support_cases", cases, f"{cases} unresolved support cases",
             "negative" if cases else "neutral"),
            ("expansion", expansion, f"Expansion interest: {expansion}/100", "positive"),
            ("renewal", renewal, f"Renewal date: {account.renewal_date.isoformat()}", "neutral"),
        ]
        facts = [Evidence(
            id=str(uuid5(NAMESPACE_URL, f"vitaai/sample/{external_id}/{metric}")),
            account_id=account_id, organization_id=SAMPLE_ORG,
            metric=metric, value=metric_value, fact=fact, source="Sample CRM",
            source_record=f"sample:{external_id}:{metric}",
            observed_at=now - timedelta(days=2), ingested_at=now,
            polarity=polarity, synthetic=True,
        ) for metric, metric_value, fact, polarity in observations]
        result.append((account, facts))
    return result
