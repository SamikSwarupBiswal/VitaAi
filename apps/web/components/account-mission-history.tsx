"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { readMission, type Action, type Mission, type MissionData } from "@/lib/workflow";
import { sameAccount, validateActivity } from "@/lib/account-history";
import { useSession } from "./session-gate";

type Coaching = components["schemas"]["CoachingReview"];

export function AccountMissionHistory({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== view.account.organization_id) {
    return <section><h3>Saved mission activity</h3><p>Session identity in this organization is required to inspect mission history.</p></section>;
  }
  return <MissionHistory view={view} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    view.account.id, view.account.revision, view.source?.id, view.assessment.snapshot_hash, view.assessment.as_of])} />;
}

function MissionHistory({ view }: { view: AccountView }) {
  const [listing, setListing] = useState<{ generation: number; missions: Mission[] } | null>(null);
  const [activity, setActivity] = useState<MissionData | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), pending = useRef(false);
  const currentListing = useRef<typeof listing>(null);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; currentListing.current = null;
      setListing(null); setActivity(null); setError(null); setBusy(false); };
    const events = ["focus", "vitaai-workflow-changed", "vitaai-source-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => events.forEach(name => window.removeEventListener(name, invalidate));
  }, []);

  async function inspect(selected?: Mission, generation?: number) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current || (selected && (generation !== currentListing.current?.generation
      || !currentListing.current?.missions.includes(selected)))) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && request === sequence.current;
    setBusy(true); setError(null); setActivity(null);
    if (!selected) { currentListing.current = null; setListing(null); }
    try {
      if (!selected) {
        const saved = await api<Mission[]>("missions", { signal });
        if (!active()) return;
        const fresh = await api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal });
        if (!active()) return;
        if (!sameAccount(view, fresh) || !Array.isArray(saved) || new Set(saved.map(item => item.id)).size !== saved.length
          || saved.some(item => item.organization_id !== view.account.organization_id)) throw new Error("Mission list changed");
        const result = { generation: request, missions: saved.filter(item => item.account_id === view.account.id) };
        currentListing.current = result; setListing(result);
      } else {
        const [value, reviews] = await Promise.all([readMission(selected.id, signal),
          api<Coaching[]>(`missions/${encodeURIComponent(selected.id)}/coaching-reviews`, { signal })]);
        if (!active()) return;
        const histories = await Promise.all(value.actions.map(action =>
          api<Action[]>(`actions/${encodeURIComponent(action.id)}/history`, { signal })));
        if (!active()) return;
        const [fresh, current] = await Promise.all([
          api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal }),
          api<Mission>(`missions/${encodeURIComponent(selected.id)}`, { signal }),
        ]);
        if (!active()) return;
        if (!sameAccount(view, fresh)) throw new Error("Account changed");
        validateActivity(value, reviews, histories, selected, current, view); setActivity(value);
      }
    } catch { if (active()) setError("Saved mission history unavailable or changed. Refresh portfolio and inspect again."); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  const mission = activity?.mission;
  return <section aria-label="Account mission history" style={{ overflowWrap: "anywhere" }}>
    <h3>Saved mission activity</h3>
    <button type="button" disabled={busy} onClick={() => inspect()}>Inspect saved missions</button>
    {busy && <p role="status">Loading saved mission history...</p>}{error && <p role="alert">{error}</p>}
    {listing && <>
      <p>Showing the newest {Math.min(20, listing.missions.length)} of {listing.missions.length} saved missions for this account in server creation order. Creation time is not completion or last activity time.</p>
      {!listing.missions.length && <p>No saved missions for this account. This does not imply completed work or a customer outcome.</p>}
      <ol>{listing.missions.slice(0, 20).map(item => <li key={item.id}>
        <Link href={`/missions?${new URLSearchParams({ account: view.account.id, mission: item.id, step: item.current_step })}`}>Open mission {item.id}</Link>
        <p>{item.status.replaceAll("_", " ")} · revision {item.revision} · owner {item.owner_id} · created {item.created_at}.</p>
        {(item.evidence.account_revision !== view.account.revision || item.evidence.snapshot_hash !== view.assessment.snapshot_hash
          || item.evidence.as_of !== view.assessment.as_of) && <p>Uses historical evidence; inspect the full mission before further work.</p>}
        <button type="button" disabled={busy} onClick={() => inspect(item, listing.generation)}>Inspect saved activity</button>
      </li>)}</ol>
    </>}
    {activity && mission && <div aria-live="polite">
      <h4>Activity for mission {mission.id}</h4><p>Retained revision {mission.revision} · {mission.status.replaceAll("_", " ")}.</p>
      <p>Original account revision {mission.evidence.account_revision} · snapshot {mission.evidence.snapshot_hash} · assessment {mission.evidence.as_of} · source detection {mission.source_detection_id || "none"}.</p>
      <p>Current retained preview modes: {activity.actions.map(item => `${item.payload.kind}: ${item.mode}`).join("; ") || "No prepared actions"}. Historical audit events do not establish their original preview mode.</p>
      <p>Inspection does not grant current approval, verify provider execution or establish a business outcome. Use the full mission for exact revisions, receipts and separately authorized review.</p>
      <h4>Retained audit activity</h4><p>Oldest sequence first; organization-wide sequence gaps are valid. Event dates are retained, not inferred measurement times.</p>
      {!activity.audit.length && <p>No retained audit events in this inspection.</p>}
      <ol>{[...activity.audit].sort((a, b) => a.sequence - b.sequence).map(event => <li key={event.id}>
        <details><summary>{event.sequence}. {event.event_kind} · {event.created_at}</summary>
          <p>Event {event.id} · actor {event.actor_id} · entity {event.entity_id} revision {event.entity_revision}.</p>
          <p>{event.previous_state ?? "No previous state recorded"} → {event.new_state} · binding {event.binding_hash || "none"}.</p>
          <p>Action {event.action_id || "none"} · decision {event.decision_id || "none"} · execution {event.execution_id || "none"} · correlation {event.correlation_id}.</p>
        </details>
      </li>)}</ol>
      <h4>Retained human reports and corrections</h4>
      {!activity.outcomes.length && <p>No saved outcome reports. A lifecycle event alone is not a customer result.</p>}
      <ol>{activity.outcomes.map(report => <li key={report.id}>
        <p>{report.report.kind.replaceAll("_", " ")} · {report.report.basis.replaceAll("_", " ")} · report {report.id} revision {report.revision}{report.supersedes_id && ` · corrects ${report.supersedes_id}`}.</p>
        <p>Observer {report.observer_id} · observed {report.observed_at} · evidence {report.report.evidence_ids.join(", ")}.</p>
        <p>{report.report.receipt_id ? `Receipt reference ${report.report.receipt_id}; inspect the full mission for mode and verification.` : `Manual action ${report.report.manual_action_reference}`}</p>
        <pre style={{ whiteSpace: "pre-wrap", font: "inherit" }}>{report.report.note}</pre>
      </li>)}</ol>
    </div>}
  </section>;
}
