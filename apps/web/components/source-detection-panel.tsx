"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountView } from "@/lib/api";
import { detectionPending, detectSourceChanges, readDetection, readDetections,
  type SourceDetection, type SourceField, type SourceSnapshot } from "@/lib/hubspot";
import { useSession } from "./session-gate";

export function SourceDetectionPanel({ view }: { view: AccountView }) {
  const session = useSession();
  const actor = session?.actor;
  if (session?.mode !== "session" || !actor) return <details className="pipeline-panel"><summary>Saved source changes</summary>
    <p>Detection history requires session identity.</p></details>;
  return <DetectionAccount view={view} admin={actor.role === "admin"}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.source?.id || "none"}`} />;
}

function DetectionAccount({ view, admin }: { view: AccountView; admin: boolean }) {
  const [records, setRecords] = useState<SourceDetection[]>([]);
  const [selected, setSelected] = useState<SourceDetection | null>(null);
  const [lookupId, setLookupId] = useState("");
  const [ready, setReady] = useState(false);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const eligible = useRef(false);
  const locked = useRef(false);
  const sequence = useRef(0);
  const detailSequence = useRef(0);

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const current = ++sequence.current;
    ++detailSequence.current; eligible.current = false;
    setReady(false); setReading(true); setSelected(null); setRecords([]); setError(null);
    try {
      const value = await readDetections(view, signal);
      if (!signal.aborted && current === sequence.current) {
        setRecords(value); setReady(true); eligible.current = true;
      }
    } catch {
      if (!signal.aborted && current === sequence.current) setError("Detection records unavailable or account selection changed. Refresh records or portfolio before detection.");
    } finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }, [view]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload);
    window.addEventListener("vitaai-detections-changed", reload);
    return () => { controller.abort(); eligible.current = false; window.removeEventListener("focus", reload);
      window.removeEventListener("vitaai-detections-changed", reload); };
  }, [refresh]);

  async function detect() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !admin || !eligible.current || locked.current || detectionPending(view) || !view.source?.id) return;
    locked.current = true; eligible.current = false; ++sequence.current; ++detailSequence.current;
    setBusy(true); setReady(false); setSelected(null); setError(null); setNotice(null);
    try {
      const result = await detectSourceChanges(view, signal);
      if (!signal.aborted) setNotice(`Processed ${result.processed.length} saved selections. Last processed revision ${result.last_processed_revision ?? "none"}. ${result.has_more
        ? "Backlog remains; request another batch explicitly." : "No backlog at this response."} Facts and workflow authority are unchanged.`);
    } catch {
      if (!signal.aborted) setNotice("Detection response could not be confirmed and may have persisted. Refresh reads saved records; it never repeats detection. An aborted request does not prove rollback.");
    } finally {
      locked.current = false;
      if (!signal.aborted) { setBusy(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-detections-changed"));
    }
  }

  async function inspect(id: string) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || reading) return;
    const current = ++detailSequence.current;
    setSelected(null); setError(null);
    try {
      const record = await readDetection(view, id, signal);
      if (!signal.aborted && current === detailSequence.current) setSelected(record);
    } catch { if (!signal.aborted && current === detailSequence.current) setError("Saved detection unavailable. Enter a valid ID for this account."); }
  }

  function lookup(event: FormEvent) { event.preventDefault(); void inspect(lookupId); }
  const pending = busy || detectionPending(view);
  const disabled = pending || reading;
  const latest = records[0]?.after.account_revision;
  return <details className="pipeline-panel hubspot-panel detection-panel"><summary>Saved source changes · {view.account.name}</summary>
    <p>Current account revision {view.account.revision}; selected source {view.source?.id || "none"} ({view.source?.kind || "original sample"}).</p>
    <p>Offline detection processes at most 20 saved selections per explicit request. It never fetches a provider, promotes data, refreshes facts or creates a mission. No automatic retry or continuation.</p>
    {!admin && <p>Read only. An administrator must request detection.</p>}
    {!view.source?.id && <p>No saved source selection. Select source facts explicitly before detection.</p>}
    <p role="status">{reading ? "Loading detection records..." : ready ? `Saved records loaded. Latest processed revision: ${latest ?? "none"}.`
      : "Current selection has not been verified; detection is blocked."}</p>
    {ready && view.source?.id && (latest === undefined || latest < view.account.revision) && <p>Unprocessed selections remain. Each batch needs an explicit detection request.</p>}
    {pending && <p role="status">Detection request in progress. Completion will refresh saved records.</p>}
    <div className="source-actions"><button disabled={disabled || !admin || !ready || !view.source?.id} onClick={detect}>Detect saved source changes</button>
      <button disabled={pending} onClick={() => refresh()}>Refresh detection records</button></div>
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    <section aria-label="Detection history"><h2>Detection history</h2>
      <p>Latest 20 saved results, newest source revision first. Older retained results require their detection ID. Reading history grants no approval or execution authority.</p>
      {!reading && ready && !records.length && <p>No saved detections.</p>}
      <ul>{records.map(record => <li key={record.id}><button disabled={disabled} onClick={() => inspect(record.id)}>Inspect {record.id}</button>
        <span> · {record.status.replaceAll("_", " ")} / {record.reason.replaceAll("_", " ")} · revision {record.after.account_revision} · detected {record.detected_at}</span></li>)}</ul>
      <form onSubmit={lookup}><label>Detection ID<input value={lookupId} required maxLength={36} onChange={event => setLookupId(event.target.value)} /></label>
        <button disabled={disabled}>Load saved detection</button></form>
      {selected && <DetectionRecord record={selected} view={view} />}
    </section>
  </details>;
}

function FieldValue({ field }: { field: SourceField }) {
  return <span>{field.value === null ? "Unknown" : String(field.value)} · {field.status} · {field.unit}; measured {field.observed_at || "Unknown"}; evidence {field.evidence_id || "none"}</span>;
}

function Snapshot({ snapshot, label }: { snapshot: SourceSnapshot | null; label: string }) {
  return <section aria-label={`${label} source snapshot`}><h4>{label} source snapshot</h4>
    {!snapshot ? <p>No earlier source snapshot.</p> : <>
      <p>{snapshot.kind} · revision {snapshot.account_revision}; source version {snapshot.source_version_id}; selected {snapshot.selected_at}.</p>
      <p>Observation {snapshot.observation_id || "none"}; portal {snapshot.portal_id || "none"}; company {snapshot.company_id || "none"}; mapping {snapshot.mapping_hash || "none"}.</p>
      <p>Provider created {snapshot.provider_created_at || "Unknown"}; updated {snapshot.provider_updated_at || "Unknown"}; fetched {snapshot.fetched_at || "Unknown"}.</p>
      {snapshot.kind === "local_sample" && <p>Synthetic source reset; no comparable HubSpot fields.</p>}
      <ul>{Object.entries(snapshot.fields || {}).map(([name, field]) => <li key={name}>{name.replaceAll("_", " ")}: <FieldValue field={field} /></li>)}</ul>
    </>}
  </section>;
}

function DetectionRecord({ record, view }: { record: SourceDetection; view: AccountView }) {
  const matches = record.after.source_version_id === view.source?.id && record.after.account_revision === view.account.revision;
  return <section aria-label="Saved detection"><h3>Saved detection · revision {record.after.account_revision}</h3>
    <p>{matches ? "Matches the displayed selection; this remains a saved historical record." : "Historical selection; differs from the displayed current revision or source."} Viewing it grants no authority.</p>
    <p>Detection {record.id}; {record.status.replaceAll("_", " ")} / {record.reason.replaceAll("_", " ")}; policy {record.policy_version}.</p>
    <p>Detected {record.detected_at}; actor {record.actor_id}.</p>
    {!record.event && <p>No change event. Baseline, unchanged values and source resets are distinct saved results.</p>}
    {record.event && <><p>Event {record.event.id}; fingerprint {record.event.fingerprint}. Changes report values or availability, without inferred causes, risk direction or business outcomes.</p>
      <ul>{record.event.changes.map(change => <li key={change.field}>{change.field.replaceAll("_", " ")} · {change.kind.replaceAll("_", " ")}
        <p>Before: <FieldValue field={change.before} /></p><p>After: <FieldValue field={change.after} /></p></li>)}</ul></>}
    <Snapshot label="Before" snapshot={record.before} /><Snapshot label="After" snapshot={record.after} />
  </section>;
}
