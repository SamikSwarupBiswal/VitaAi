"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountView } from "@/lib/api";
import { accountPath, recordPath, mutateIngestion, readIngestion, readIngestionHistory, readIngestionRecovery,
  readIngestionReadiness, ingestionKey, ingestionRequests, type IngestionRun, type IngestionRecoveryReadiness,
  type IngestionReadiness, type IngestionObjectType } from "@/lib/hubspot-ingestion";
import { useSession } from "./session-gate";

export function HubSpotIngestionPanel({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== view.account.organization_id) return null;
  return <IngestionAccount view={view} admin={actor.role === "admin"}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.source?.id || "none"}`} />;
}

function IngestionAccount({ view, admin }: { view: AccountView; admin: boolean }) {
  const [readiness, setReadiness] = useState<IngestionReadiness | null>(null);
  const [records, setRecords] = useState<IngestionRun[]>([]);
  const [selected, setSelected] = useState<IngestionRun | null>(null);
  const [recovery, setRecovery] = useState<IngestionRecoveryReadiness | null>(null);
  const [objectType, setObjectType] = useState<IngestionObjectType | "">("");
  const [lookup, setLookup] = useState("");
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readyDisplay, setReadyDisplay] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [inputVersion, setInputVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const sequence = useRef(0), detailSequence = useRef(0);
  const currentReadiness = useRef<IngestionReadiness | null>(null);
  const currentRecord = useRef<IngestionRun | null>(null);
  const currentRecovery = useRef<IngestionRecoveryReadiness | null>(null);
  const inputRevision = useRef(0), locked = useRef(false), ready = useRef(false);
  const capturedInput = inputVersion;

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const request = ++sequence.current;
    setGeneration(request); setReadyDisplay(false);
    ++detailSequence.current;
    currentReadiness.current = null; currentRecord.current = null; currentRecovery.current = null; ready.current = false;
    setReadiness(null); setSelected(null); setRecovery(null); setRecords([]); setError(null); setReading(true);
    const results = await Promise.allSettled([readIngestionReadiness(view, signal), readIngestionHistory(view, signal)]);
    if (signal.aborted || request !== sequence.current) return;
    if (results[0].status === "fulfilled") { currentReadiness.current = results[0].value; setReadiness(results[0].value); }
    if (results[1].status === "fulfilled") setRecords(results[1].value);
    ready.current = results.every(result => result.status === "fulfilled");
    setReadyDisplay(ready.current);
    if (!ready.current) setError("Some ingestion records are unavailable or the account changed. Starts are blocked; independently valid saved records remain inspectable.");
    setReading(false);
  }, [view]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload); window.addEventListener("vitaai-ingestion-changed", reload);
    return () => { controller.abort(); currentReadiness.current = null; currentRecord.current = null; currentRecovery.current = null;
      ready.current = false; window.removeEventListener("focus", reload); window.removeEventListener("vitaai-ingestion-changed", reload); };
  }, [refresh]);

  async function inspect(id: string, expectedSequence: number) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || reading || expectedSequence !== sequence.current) return;
    const request = ++detailSequence.current;
    currentRecord.current = null; currentRecovery.current = null;
    setSelected(null); setRecovery(null); setError(null);
    try {
      const record = await readIngestion(view, id, signal);
      if (signal.aborted || request !== detailSequence.current) return;
      currentRecord.current = record; setSelected(record);
      try {
        const value = await readIngestionRecovery(view, record, signal);
        if (!signal.aborted && request === detailSequence.current) { currentRecovery.current = value; setRecovery(value); }
      } catch { if (!signal.aborted && request === detailSequence.current) setError("Recovery readiness unavailable. Saved ingestion remains historical; finalization is disabled."); }
    } catch { if (!signal.aborted && request === detailSequence.current) setError("Saved ingestion unavailable for this account."); }
  }

  async function mutate(kind: "start" | "recover") {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !admin || locked.current || ingestionRequests.has(ingestionKey(view))) return;
    if (kind === "start" && (!ready.current || !readiness?.can_start || currentReadiness.current !== readiness
      || capturedInput !== inputRevision.current || !["contacts", "deals", "notes", "tasks", "calls", "meetings", "emails"].includes(objectType))) return;
    if (kind === "recover" && (!selected || currentRecord.current !== selected || currentRecovery.current !== recovery
      || !recovery?.eligible || selected.status !== "pending" || Date.now() < Date.parse(selected.worker_deadline_at))) return;
    const body = kind === "start" ? { expected_account_revision: view.account.revision,
      expected_configuration_revision: readiness!.configuration_revision, expected_configuration_hash: readiness!.configuration_hash,
      object_type: objectType } : { expected_revision: selected!.revision, expected_account_revision: recovery!.account_revision,
        expected_worker_deadline_at: selected!.worker_deadline_at };
    const path = kind === "recover" ? `${recordPath(selected!.id)}/recover` : accountPath(view.account.id);
    locked.current = true; ready.current = false; ++sequence.current; ++detailSequence.current;
    setGeneration(sequence.current); setReadyDisplay(false);
    currentReadiness.current = null; currentRecord.current = null; currentRecovery.current = null;
    setBusy(true); setRecovery(null); setError(null); setNotice(null);
    try {
      await mutateIngestion(view, path, body, signal);
      if (!signal.aborted) setNotice("Request returned. Saved records must refresh to confirm the disposition. Staging never selects source facts.");
    } catch {
      if (!signal.aborted) setNotice("Response could not be confirmed and may have persisted. Refresh reads saved records without repeating the request. Aborting transport does not prove rollback or remote cancellation.");
    } finally {
      locked.current = false;
      if (!signal.aborted) { setBusy(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-ingestion-changed"));
    }
  }

  const pending = busy || ingestionRequests.has(ingestionKey(view));
  const inspectionSequence = generation;
  function submit(event: FormEvent) { event.preventDefault(); void mutate("start"); }
  return <details className="pipeline-panel hubspot-panel"><summary>Associated HubSpot records · {view.account.name}</summary>
    <p>Explicit read-only staging of one associated object type, limited to five pages and twenty unique objects. Incomplete reads fail without partial output. Source promotion and scheduled staging are separate.</p>
    <p>Current account revision {view.account.revision}; configuration revision {readiness?.configuration_revision ?? "unavailable"}; hash {readiness?.configuration_hash || "unavailable"}.</p>
    <p>Start readiness: {readiness?.reason || "unavailable"}. Configuration does not prove connectivity or factual freshness.</p>
    {!admin && <p>Read only. An administrator must start or finalize ingestion.</p>}
    <form onSubmit={submit}><label>Associated object type<select required value={objectType} onChange={event => {
      setInputVersion(++inputRevision.current); setObjectType(event.target.value as IngestionObjectType | "");
    }}><option value="">Choose a type</option>{["contacts", "deals", "notes", "tasks", "calls", "meetings", "emails"].map(type => <option key={type} value={type}>{type}</option>)}</select></label>
      <button disabled={pending || reading || !admin || !readyDisplay || !readiness?.can_start || !objectType}>Stage associated records</button></form>
    <button disabled={pending} onClick={() => refresh()}>Refresh ingestion records</button>
    {reading && <p role="status">Loading saved ingestion records...</p>}{pending && <p role="status">Ingestion request pending.</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-banner">{error}</p>}
    <section aria-label="Ingestion history"><h3>Saved ingestions</h3><p>Latest twenty. Pending work across all account history blocks new starts. Original dates remain historical.</p>
      {readiness?.pending_run_id && <button disabled={pending || reading} onClick={() => inspect(readiness.pending_run_id!, inspectionSequence)}>Inspect pending ingestion</button>}
      <ul>{records.map(record => <li key={record.id}><button disabled={pending || reading} onClick={() => inspect(record.id, inspectionSequence)}>Inspect ingestion {record.id}</button> · {record.object_type} · {record.status} · started {record.started_at}</li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void inspect(lookup, inspectionSequence); }}><label>Saved ingestion ID<input maxLength={36} required value={lookup} onChange={event => setLookup(event.target.value)} /></label><button disabled={pending || reading}>Load saved ingestion</button></form>
      {selected && <section aria-label="Saved ingestion"><h4>{selected.id} · {selected.object_type} · {selected.status}</h4>
        <p>Sequence {selected.sequence}; revision {selected.revision}; original actor {selected.actor_id}; account revision {selected.account_revision}; portal {selected.portal_id}; company {selected.company_id}.</p>
        <p>Configuration revision {selected.configuration_revision}; hash {selected.configuration_hash || "legacy unavailable"}; fingerprint {selected.fingerprint || "none"}; disposition {selected.disposition || "none"}; previous run {selected.previous_run_id || "none"}.</p>
        <p>Started {selected.started_at}; original deadline {selected.worker_deadline_at}; finished {selected.finished_at || "none"}; error {selected.error_code || "none"}; recovered by {selected.recovered_by || "none"}.</p>
        <p>Raw properties preserve missing and null values. Deal amount is not annual value; object update time is not activity time. These records do not change facts, metrics, scores, detection or workflow authority.</p>
        <pre>{JSON.stringify(selected.objects, null, 2)}</pre>
        <button disabled={pending || reading || !admin || !recovery?.eligible || selected.status !== "pending"} onClick={() => mutate("recover")}>Finalize interrupted ingestion</button>
        <p>Finalization preserves original intent without fetching, retrying or renewing its deadline. It cannot prove remote cancellation.</p>
      </section>}
    </section>
  </details>;
}
