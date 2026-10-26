"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Detection = components["schemas"]["SourceDetection"];
type Snapshot = components["schemas"]["SourceSnapshot"];
type Field = components["schemas"]["SourceField"];

export function AccountChronology({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== view.account.organization_id) {
    return <section aria-label="Account source chronology"><h3>Saved source chronology</h3><p>Session identity in this organization is required to inspect saved history.</p></section>;
  }
  return <ChronologyInspection view={view} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    view.account.id, view.account.revision, view.source?.id, view.assessment.snapshot_hash, view.assessment.as_of])} />;
}

function ChronologyInspection({ view }: { view: AccountView }) {
  const [records, setRecords] = useState<Detection[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const sequence = useRef(0), pending = useRef(false);
  useLayoutEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; setRecords(null); setError(null); setBusy(false); };
    const events = ["focus", "vitaai-detections-changed", "vitaai-source-history-changed", "vitaai-source-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => events.forEach(name => window.removeEventListener(name, invalidate));
  }, []);

  async function inspect() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true;
    const request = ++sequence.current;
    const active = () => !signal.aborted && request === sequence.current;
    setBusy(true); setRecords(null); setError(null);
    try {
      const saved = await api<Detection[]>(`integrations/hubspot/accounts/${encodeURIComponent(view.account.id)}/detections`, { signal });
      if (!active()) return;
      const fresh = await api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal });
      if (!active()) return;
      if (fresh.account.id !== view.account.id || fresh.account.organization_id !== view.account.organization_id
        || fresh.account.revision !== view.account.revision || fresh.source?.id !== view.source?.id
        || fresh.assessment.snapshot_hash !== view.assessment.snapshot_hash || fresh.assessment.as_of !== view.assessment.as_of
        || !Array.isArray(saved) || saved.length > 20
        || new Set(saved.map(item => item.id)).size !== saved.length
        || new Set(saved.map(item => item.after.source_version_id)).size !== saved.length
        || new Set(saved.map(item => item.after.account_revision)).size !== saved.length
        || saved.some(item => item.organization_id !== view.account.organization_id || item.account_id !== view.account.id
          || item.after.account_revision > view.account.revision
          || (item.after.account_revision === view.account.revision && item.after.source_version_id !== view.source?.id))) {
        throw new Error("Saved history binding changed");
      }
      setRecords([...saved].sort((left, right) => right.after.account_revision - left.after.account_revision));
    } catch {
      if (active()) setError("Saved source chronology unavailable or changed. Refresh portfolio and inspect again.");
    } finally {
      if (active()) { pending.current = false; setBusy(false); }
    }
  }
  const latest = records?.[0];
  return <section aria-label="Account source chronology" style={{ overflowWrap: "anywhere" }}>
    <h3>Saved source chronology</h3>
    <p>Account {view.account.id} · displayed revision {view.account.revision}. Saved source selections, newest revision first; dates retain their original meanings.</p>
    <button type="button" disabled={busy} onClick={inspect}>{busy ? "Inspecting saved source chronology..." : "Inspect saved source chronology"}</button>
    {busy && <p role="status">Loading saved history for this account...</p>}
    {error && <p role="alert">{error}</p>}
    {records && <div aria-live="polite">
      <p>The latest 20 saved detections are available here. Older records may exist; inspect an older detection ID in Saved source changes. This is source history, not a complete recommendation or mission timeline.</p>
      {!records.length && <p>No saved source detections. This does not establish unchanged facts or an empty account history.</p>}
      {view.source?.id && latest?.after.source_version_id !== view.source.id && <p>History does not cover the displayed source selection. Detect saved selections separately; inspection never runs detection.</p>}
      <ol>{records.map(record => <li key={record.id}>
        <details><summary>Revision {record.after.account_revision} · {record.status.replaceAll("_", " ")} · selected {record.after.selected_at}</summary>
          <p>Detection {record.id} · {record.reason.replaceAll("_", " ")} · policy {record.policy_version}.</p>
          <p>Detected {record.detected_at} · actor {record.actor_id}. Detection time is not measurement time.</p>
          <p>{record.after.source_version_id === view.source?.id && record.after.account_revision === view.account.revision
            ? "Matches the displayed source selection; the detection remains a saved record."
            : "Historical source selection; it does not replace current facts."}</p>
          {record.status === "baseline" && <p>Comparison baseline. No change is inferred across missing history, source identity or mapping changes.</p>}
          {record.status === "source_reset" && <p>Synthetic source reset. Original sample dates are retained; this is not a measured customer change.</p>}
          {record.status === "unchanged" && <p>Saved comparable values and availability were unchanged. This does not assert that the customer had no activity.</p>}
          {record.event && <><p>Source event {record.event.id} · fingerprint {record.event.fingerprint}.</p>
            <ul>{record.event.changes.map(change => <li key={change.field}>{change.field.replaceAll("_", " ")} · {change.kind.replaceAll("_", " ")}
              <p>Before: <FieldValue field={change.before} /></p><p>After: <FieldValue field={change.after} /></p>
            </li>)}</ul></>}
          <SourceSnapshot snapshot={record.before} label="Before" />
          <SourceSnapshot snapshot={record.after} label="After" />
        </details>
      </li>)}</ol>
      <p>No inferred cause or business outcome. Source history grants no approval or execution authority.</p>
    </div>}
  </section>;
}

function FieldValue({ field }: { field: Field }) {
  return <span>{field.value === null ? "Unknown" : String(field.value)} · {field.status} · {field.unit}; measured {field.observed_at || "Unknown"}; evidence {field.evidence_id || "none"}</span>;
}

function SourceSnapshot({ snapshot, label }: { snapshot: Snapshot | null; label: string }) {
  return <section aria-label={`${label} retained source snapshot`}><h4>{label} retained source snapshot</h4>
    {!snapshot ? <p>No earlier source snapshot.</p> : <>
      <p>{snapshot.kind} · source {snapshot.source_version_id} · revision {snapshot.account_revision} · selected {snapshot.selected_at}.</p>
      <p>Observation {snapshot.observation_id || "none"} · portal {snapshot.portal_id || "none"} · company {snapshot.company_id || "none"} · mapping {snapshot.mapping_hash || "none"}.</p>
      <p>Provider created {snapshot.provider_created_at || "Unknown"} · updated {snapshot.provider_updated_at || "Unknown"} · fetched {snapshot.fetched_at || "Unknown"}.</p>
      {snapshot.kind === "local_sample" && <p>Synthetic sample; no comparable HubSpot fields.</p>}
      <ul>{Object.entries(snapshot.fields || {}).map(([name, field]) => <li key={name}>{name.replaceAll("_", " ")}: <FieldValue field={field} /></li>)}</ul>
    </>}
  </section>;
}
