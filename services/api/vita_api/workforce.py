"""Sourced workforce explanations over shared records; no action dispatch."""
import re
from collections import Counter
from datetime import UTC

from pydantic import ValidationError
from sqlalchemy import select

from .contracts import Account
from .governance import PolicyDenied
from .hubspot_changes import SourceDetection, detections
from .identity import token_digest
from .memory_sources import SourceMemory
from .microsoft import Microsoft, bindings
from .scoring import assess
from .storage import accounts, selected_evidence
from .workflow_contracts import Mission
from .workflow_storage import missions

STEPS = {
    "Review": "Inspect the retained plan, account snapshot and proposed purpose; missing or stale evidence blocks preparation.",
    "Evidence": "Inspect original evidence dates, Unknowns and contradictions against the mission snapshot; refreshed facts need a fresh compatible plan.",
    "Outreach": "Prepare or edit exact outreach content in the web workflow. Editing invalidates prior review; chat never sends it.",
    "CRM Note": "Inspect or prepare the exact CRM payload, destination and dependencies; a note proposal is not a provider write.",
    "Approval": "An authenticated authorized reviewer must review the exact current action revision and binding hash. Rejection or revision requests require correction.",
    "Execution": "Only a current exact approval can dispatch once. Unknown results require readback/reconciliation; never retry an uncertain result.",
    "Outcome": "Record a separate human report only when the workflow permits it. Receipts do not prove business impact; corrections preserve earlier reports.",
}


def source_changes(connection, actor, account_id):
    rows = connection.execute(select(detections).where(detections.c.organization_id == actor.organization_id,
        detections.c.account_id == str(account_id)).order_by(detections.c.account_revision.desc()).limit(2)).mappings().all()
    result = []
    for row in rows:
        value = SourceDetection.model_validate(row["payload"])
        if (str(value.id) != row["id"] or value.organization_id != actor.organization_id
                or str(value.account_id) != str(account_id) or value.after.account_revision != row["account_revision"]):
            raise PolicyDenied("companion_source_unavailable", 409)
        result.append(value)
    return result


def mission_window(connection, actor, account_id=None):
    # Mission JSON has no account index. Disclose this fixed organization window.
    rows = connection.execute(select(missions).where(missions.c.organization_id == actor.organization_id)
        .order_by(missions.c.id).limit(101)).mappings().all()
    values = []
    for row in rows[:100]:
        item = Mission.model_validate(row["payload"])
        if str(item.id) != row["id"] or item.organization_id != actor.organization_id or item.revision != row["revision"]:
            raise PolicyDenied("companion_mission_unavailable", 409)
        if account_id is None or item.account_id == account_id:
            values.append(item)
    values.sort(key=lambda item: (item.created_at, str(item.id)), reverse=True)
    return values, len(rows) > 100


def portfolio(companion, connection, actor, session):
    from .companion import Citation
    rows = connection.execute(select(accounts).where(accounts.c.organization_id == actor.organization_id)
        .order_by(accounts.c.id).limit(51)).mappings().all()
    ranked, caveats, changes = [], [], []
    for row in rows[:50]:
        account = Account.model_validate(row["payload"])
        if account.organization_id != actor.organization_id or account.id != row["id"] or account.revision != row["revision"]:
            raise PolicyDenied("companion_snapshot_changed", 409)
        facts = selected_evidence(connection, actor.organization_id, account.id)
        if len({item.id for item in facts}) != len(facts) or any(item.account_id != account.id
                or item.organization_id != actor.organization_id for item in facts):
            raise PolicyDenied("companion_evidence_unavailable", 409)
        result = assess(account, facts, companion.memory.clock().astimezone(UTC).date())
        ranked.append((result.risk, account, result, facts))
        caveats.extend(result.caveats)
        for change in source_changes(connection, actor, account.id)[:1]:
            detail = ("; ".join(f"{field.field}: {field.before.value} → {field.after.value} {field.after.unit}"
                for field in change.event.changes) if change.event else "No factual value delta in this retained detection.")
            changes.append(Citation(kind="source_change", id=str(change.id), label=f"{account.name}: saved source {change.status}",
                source_time=change.detected_at.isoformat(), text=f"Account {account.id}; selection {change.after.selected_at.isoformat()}; {detail}"))
    citations = []
    for _, account, result, facts in sorted(ranked, key=lambda row: (-row[0], row[1].id))[:5]:
        dates = ", ".join(sorted({fact.observed_at.isoformat() for fact in facts})) or "Unknown"
        citations.append(Citation(kind="account", id=account.id, label=account.name, source_time=account.created_at.isoformat(),
            account_snapshot_hash=result.snapshot_hash,
            text=f"{account.name}: risk {result.risk}, opportunity {result.opportunity}, confidence {result.confidence}%. "
            f"{result.recommendation} Revision {account.revision}, assessment {result.as_of}, snapshot {result.snapshot_hash}; source dates {dates}."))
    citations.extend(changes)
    answer = " ".join(item.text for item in citations) or "No accessible accounts."
    answer += (" Alternatives: review missing/stale evidence before preparation; inspect support/usage risk before renewal work; "
        "review sourced expansion interest where present; otherwise monitor. These are conditional review options, not reranking or measured benefits.")
    caveats.extend([f"Inspected {len(ranked)} accounts in a stable-ID window of50; top5 baseline risk priorities. "
                   + ("More accounts omitted." if len(rows) > 50 else "No additional accounts in this organization."),
                   "Saved source changes are historical; absence of a saved detection does not establish no change.",
                   "Rank and original confidence stay deterministic. No business impact or approval follows advisor text."])
    return "answered" if ranked else "unknown", answer, tuple(citations), tuple(dict.fromkeys(caveats)), (), None


def mission_advice(companion, connection, actor, session, message):
    from .companion import Citation, Navigation
    values, more = mission_window(connection, actor, session.account_id)
    ids = re.findall(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", message)
    if ids:
        selected = next((item for item in values if str(item.id) == ids[0]), None)
    else:
        selected = next((item for item in values if item.status not in {"completed", "superseded"}), values[0] if values else None)
    if selected is None:
        return "unknown", "No matching saved mission for this account in the organization100-record window; no other account is substituted.", (), (), (), None
    source = SourceMemory(companion.store, companion.memory.session_token, clock=companion.memory.clock)
    bundle = source.preview_in(connection, actor, session.account_id, "mission", selected.id).original
    _, _, assessment = companion.current(connection, actor, session.account_id, session.snapshot_hash)
    current = selected.evidence.snapshot_hash == assessment.snapshot_hash
    requested = next((step for step in STEPS if step.casefold() in message), selected.current_step)
    citations = [Citation(kind="mission", id=str(selected.id), label="Saved mission; exact resume context",
        source_time=selected.created_at.isoformat(), text=f"Mission {selected.id}: {selected.status}; current step {selected.current_step}; revision {selected.revision}; owner {selected.owner_id}.")]
    details = [f"{step}: {text}" for step, text in STEPS.items()]
    details.append("Current blocker: " + ("mission snapshot is historical; inspect recovery in the exact web workflow." if not current else {
        "rejected": "reviewer rejected this submission; correct the preparation and request fresh review.",
        "revision_required": "reviewer requested a revision; changed content needs a new exact review.",
        "reconciliation_required": "execution result is unknown; inspect receipts and reconcile without replay.",
        "awaiting_review": "exact human approval is still required.",
        "completed": "mission is complete; inspect reports/coaching, then choose separate unfinished work.",
        "superseded": "mission was replaced; inspect its saved replacement, preserving historical records.",
    }.get(selected.status, "follow the saved current step and displayed policy checks; chat does not advance it.")))
    for action in bundle.actions:
        text = f"Action {action.id}; revision {action.revision}; {action.status}; kind {action.kind}; binding {action.binding_hash}."
        citations.append(Citation(kind="mission", id=str(selected.id), label="Exact prepared action", source_time=action.created_at.isoformat(), text=text))
    caveats = ("All seven steps explain existing shared workflow controls; opening a step cannot complete or approve it.",
        "Missing, rejected, revision-required and unknown work cannot skip approval or outcome rules.",
        "Inspected organization100-record stable-ID mission window; " + ("more records omitted." if more else "no additional organization rows omitted."))
    return "answered", " ".join([citations[0].text, *details]), tuple(citations), caveats, (), Navigation(
        target="mission", account_id=session.account_id, mission_id=selected.id, step=requested)


def director(companion, connection, actor, session):
    from .companion import Citation, Navigation
    values, more = mission_window(connection, actor)
    source = SourceMemory(companion.store, companion.memory.session_token, clock=companion.memory.clock)
    citations, summaries, owners, chosen = [], [], {}, None
    for mission in values:
        # A corrupt or missing account never becomes another seller's result.
        source.account(connection, actor, mission.account_id)
        counts = owners.setdefault(mission.owner_id, Counter())
        counts[mission.status] += 1
        if mission.account_id == session.account_id and chosen is None:
            chosen = mission
        if mission.status != "completed":
            continue
        bundle = source.preview_in(connection, actor, mission.account_id, "mission", mission.id).original
        reports = sorted(bundle.outcomes, key=lambda item: item.revision)
        if not reports:
            summaries.append(f"Mission {mission.id}: completed with no readable manual report.")
            continue
        report = reports[-1]
        citations.append(Citation(kind="outcome", id=str(report.id), label="Latest manual report; not verified impact",
            source_time=report.observed_at.isoformat(), text=f"Mission {mission.id}; owner {mission.owner_id}; report revision {report.revision}: {report.report.kind}: {report.report.note}"))
        reviews = sorted(bundle.coaching, key=lambda item: item.revision)
        review = reviews[-1] if reviews else None
        if review:
            historical = review.outcome_id != report.id or review.outcome_revision != report.revision
            text = f"Mission {mission.id}; {review.status}; review revision {review.revision}; reviewer {review.reviewer_id}; "
            text += "Historical after report correction. " if historical else "Bound to latest report. "
            text += review.note
            if review.intervention:
                text += (f" Internal coaching owner {review.intervention_owner_id}: focus {review.intervention.focus}; "
                    f"discussion {review.intervention.discussion}; practice {review.intervention.practice}; follow-up {review.intervention.follow_up}.")
            citations.append(Citation(kind="coaching", id=str(review.id), label="Saved coaching; separate from customer approval",
                source_time=review.created_at.isoformat(), text=text))
        else:
            summaries.append(f"Mission {mission.id}: latest manual report has no coaching review; inspect Outcome for authorized coaching.")
    for owner, counts in sorted(owners.items()):
        summaries.insert(0, f"Recorded owner {owner}: " + ", ".join(f"{state}={count}" for state, count in sorted(counts.items())) + ".")
    answer = " ".join([*summaries, *(item.text for item in citations)]) or "No saved missions in this accessible organization window."
    caveats = ("Saved owner IDs are not a verified seller directory or performance ranking.",
        "Manual reports are not independently measured business results; completed, rejected and unknown work remain distinct.",
        "Record or revise coaching only in the exact Outcome workflow under its existing reviewer/report/revision checks; chat cannot assign, notify or approve.",
        f"Inspected organization100-record mission window ({len(values)} readable rows); " + ("additional missions omitted." if more else "no additional rows omitted."))
    navigation = Navigation(target="mission", account_id=session.account_id, mission_id=chosen.id,
        step="Outcome" if chosen.status == "completed" else chosen.current_step) if chosen else None
    return "answered" if values else "unknown", answer, tuple(citations), caveats, (), navigation


def operations(companion, connection, actor, session):
    from .companion import Citation, Navigation
    from .hubspot_refresh import (
        RefreshAuthorization,
        RefreshOccurrence,
        authorizations,
        occurrences,
    )
    values, more = mission_window(connection, actor, session.account_id)
    source = SourceMemory(companion.store, companion.memory.session_token, clock=companion.memory.clock)
    citations, summaries = [], []
    config = companion.settings
    if config is None:
        summaries.append("Integration configuration was not supplied to this advisor; current readiness is unavailable.")
    else:
        hubspot = (config.hubspot_enabled and bool(config.hubspot_access_token.get_secret_value())
            and config.hubspot_organization_id == actor.organization_id and str(session.account_id) in config.hubspot_company_map)
        summaries.append("HubSpot: " + ("configured for mapped reads; connectivity unverified." if hubspot else "not configured for this account; inspect Integration readiness."))
        microsoft = Microsoft(companion.store, config)
        if microsoft.configured and config.microsoft_organization_id == actor.organization_id:
            rows = connection.execute(select(bindings).where(bindings.c.organization_id == actor.organization_id,
                bindings.c.actor_id == actor.id, bindings.c.session_hash == token_digest(companion.memory.session_token or ""),
                bindings.c.configuration == microsoft.fingerprint(), bindings.c.revoked.is_(False))).mappings().all()
            connected = any(row["expires_at"] > int(companion.memory.clock().timestamp()) for row in rows)
            summaries.append("Microsoft: " + ("current actor has an unexpired local mailbox binding; provider reachability unverified." if connected else
                "mailbox binding missing or expired; reconnect in Microsoft controls. Chat cannot refresh or reconnect."))
        else:
            summaries.append("Microsoft: unavailable for this account/organization; configure and connect through the authorized controls.")
        summaries.append("Research: " + ("configured; inspect original research freshness and errors." if config.research_enabled
            and config.research_organization_id == actor.organization_id else "not enabled for this organization."))
    refresh_rows = connection.execute(select(authorizations).where(authorizations.c.organization_id == actor.organization_id,
        authorizations.c.account_id == str(session.account_id)).order_by(authorizations.c.revision.desc()).limit(1)).mappings().all()
    for row in refresh_rows:
        grant = RefreshAuthorization.model_validate(row["payload"])
        if str(grant.id) != row["id"] or grant.organization_id != actor.organization_id or grant.account_id != session.account_id:
            raise PolicyDenied("companion_source_unavailable", 409)
        summaries.append(f"Saved staging grant {grant.id}: {grant.status}; original expiry {grant.expires_at.isoformat()}; "
            + ("expired; a new explicit authorization is required." if grant.expires_at <= companion.memory.clock() else "not proof of a running worker or fresh data."))
    occurrence_rows = connection.execute(select(occurrences).where(occurrences.c.organization_id == actor.organization_id,
        occurrences.c.account_id == str(session.account_id)).order_by(occurrences.c.id).limit(5)).mappings().all()
    for row in occurrence_rows:
        occurrence = RefreshOccurrence.model_validate(row["payload"])
        if occurrence.organization_id != actor.organization_id or occurrence.account_id != session.account_id or str(occurrence.id) != row["id"]:
            raise PolicyDenied("companion_source_unavailable", 409)
        summaries.append(f"Saved refresh occurrence {occurrence.id}: {occurrence.status}; inspect refresh history for original freshness/failure; no retry follows advice.")
    for mission in values[:5]:
        bundle = source.preview_in(connection, actor, session.account_id, "mission", mission.id).original
        summaries.append(f"Mission {mission.id}: {mission.status}; " + {
            "awaiting_review": "exact human review pending.", "rejected": "rejected; inspect and revise preparation.",
            "revision_required": "revision requested; inspect original reason and request fresh review.",
            "reconciliation_required": "uncertain result; inspect receipt and reconcile without replay.",
        }.get(mission.status, "inspect exact saved workflow state."))
        citations.append(Citation(kind="mission", id=str(mission.id), label="Saved operational queue",
            source_time=mission.created_at.isoformat(), text=summaries[-1]))
        for claim in bundle.executions:
            receipt = next((item for item in bundle.receipts if item.execution_id == claim.id), None)
            remedy = "Inspect active claim; do not dispatch again." if claim.status in {"claimed", "dispatching"} else (
                "Reconcile unknown result; never blindly retry." if claim.status == "result_unknown" else
                "Inspect failure and exact current approval before an explicit permitted retry." if claim.status == "failed" else
                "Saved execution succeeded; inspect independent receipt verification, then record outcome separately.")
            citations.append(Citation(kind="execution", id=str(claim.id), label="Saved execution; not live health",
                source_time=claim.created_at.isoformat(), text=f"{claim.status}; attempt {claim.attempt}; receipt verification "
                    f"{receipt.verification if receipt else 'missing'}. {remedy}"))
    answer = " ".join([*summaries, *(item.text for item in citations if item.kind == "execution")])
    caveats = ("Saved execution is not current integration health. No provider probe, refresh, retry, reconciliation or configuration change follows advice.",
        f"Inspected first5 newest account missions within organization100-record window ({len(values)} account matches); "
        + ("additional organization rows omitted." if more else "no additional organization rows omitted."),
        "Staging freshness is distinct from source promotion and deterministic assessment time. An empty queue does not certify health.")
    navigation = Navigation(target="mission", account_id=session.account_id, mission_id=values[0].id, step="Execution") if values else None
    return "answered", answer, tuple(citations), caveats, (), navigation


def present(companion, connection, actor, session, message):
    try:
        if session.persona == "executive_advisor" and re.search(r"\b(portfolio|brief|priority|priorities|change|changes|alternative|alternatives)\b", message):
            return portfolio(companion, connection, actor, session)
        if session.persona == "sales_director" and re.search(r"\b(team|seller|sellers|mission|missions|coaching|outcome|outcomes|review|summary)\b", message):
            return director(companion, connection, actor, session)
        if session.persona == "operations_advisor" and re.search(r"\b(readiness|integration|integrations|refresh|queue|queues|receipt|receipts|mission|execution|outage|mailbox|health)\b", message):
            return operations(companion, connection, actor, session)
        if session.persona == "mission_guide" and re.search(r"\b(mission|missions|step|steps|blocker|blockers|review|evidence|outreach|approval|execution|outcome|resume)\b", message):
            return mission_advice(companion, connection, actor, session, message)
    except (ValidationError, ValueError, KeyError, TypeError):
        raise PolicyDenied("companion_source_unavailable", 409) from None
    return None
