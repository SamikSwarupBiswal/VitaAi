import hashlib
import json
from datetime import date

from .contracts import Account, Assessment, Evidence, ScoreFactor


def assess(account: Account, evidence: list[Evidence], as_of: date) -> Assessment:
    scoped = [item for item in evidence if item.account_id == account.id
              and item.organization_id == account.organization_id]
    current: dict[str, Evidence] = {}
    caveats = ["Synthetic data. No external actions."] if account.synthetic else []
    for item in sorted(scoped, key=lambda item: (item.observed_at, item.id)):
        age = (as_of - item.observed_at.date()).days
        if age < 0 or age > 30:
            caveats.append(f"Excluded {'future-dated' if age < 0 else 'stale'} evidence: {item.id}")
            continue
        previous = current.get(item.metric)
        if previous and previous.observed_at == item.observed_at and previous.value != item.value:
            caveats.append(f"Conflicting {item.metric} observations; manual review required.")
        current[item.metric] = item

    factors = []
    risk = opportunity = 0.0
    for metric in ("usage_change", "support_cases", "expansion", "renewal"):
        item = current.get(metric)
        value = item.value if item else None
        r = o = 0.0
        if value is None:
            caveats.append(f"Missing fresh {metric} evidence; manual review required.")
        elif metric == "usage_change":
            r = min(45.0, max(0.0, -value * 1.1))
            o = min(30.0, max(0.0, value))
        elif metric == "support_cases":
            r = min(30.0, max(0.0, value * 8))
        elif metric == "expansion":
            o = min(70.0, max(0.0, value * 0.7))
        else:
            days = (account.renewal_date - as_of).days
            r = min(25.0, max(0.0, (90 - days) / 90 * 25))
        factors.append(ScoreFactor(
            metric=metric, value=value, evidence_id=item.id if item else None,
            risk_contribution=round(r, 2), opportunity_contribution=round(o, 2),
        ))
        risk += r
        opportunity += o

    risk_score = min(100, round(risk))
    opportunity_score = min(100, round(opportunity))
    confidence = round(len(current) / 4 * 100)
    conflict = any("Conflicting" in caveat for caveat in caveats)
    if conflict:
        confidence = min(confidence, 50)
    needs_review = confidence < 100
    if needs_review:
        recommendation = "Review missing or conflicting evidence before planning outreach."
    elif risk_score >= 45:
        recommendation = "Resolve support and usage blockers before the renewal conversation."
    elif opportunity_score >= 65:
        recommendation = "Review expansion interest and prepare a discovery conversation."
    else:
        recommendation = "Monitor current signals and maintain the account relationship."

    snapshot = {"account": account.model_dump(mode="json"), "as_of": as_of.isoformat(),
                "evidence": [item.model_dump(mode="json") for item in sorted(scoped, key=lambda e: e.id)],
                "policy_version": "baseline-1"}
    snapshot_hash = hashlib.sha256(json.dumps(
        snapshot, sort_keys=True, separators=(",", ":"),
    ).encode()).hexdigest()
    return Assessment(
        snapshot_hash=snapshot_hash, as_of=as_of, health=100 - risk_score,
        risk=risk_score, opportunity=opportunity_score, confidence=confidence,
        needs_attention=risk_score >= 45 or needs_review,
        growth_signal=opportunity_score >= 65 and not needs_review,
        recommendation=recommendation, factors=factors, caveats=list(dict.fromkeys(caveats)),
    )
