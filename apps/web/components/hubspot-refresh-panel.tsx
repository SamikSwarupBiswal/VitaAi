"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountView } from "@/lib/api";
import { accountPath, type HubSpotSyncRun } from "@/lib/hubspot";
import { mutateRefresh, occurrencePath, readOccurrence, readOccurrences, readOccurrenceSync, readRecovery,
  readSchedule, refreshKey, refreshRequests, type RefreshOccurrence, type RefreshRecovery, type RefreshSchedule } from "@/lib/hubspot-refresh";
import { useSession } from "./session-gate";

export function HubSpotRefreshPanel({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor) return null;
  return <RefreshAccount view={view} admin={actor.role === "admin"}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.source?.id || "none"}`} />;
}

function RefreshAccount({ view, admin }: { view: AccountView; admin: boolean }) {
  const [schedule, setSchedule] = useState<RefreshSchedule | null>(null);
  const [records, setRecords] = useState<RefreshOccurrence[]>([]);
  const [selected, setSelected] = useState<RefreshOccurrence | null>(null);
  const [recovery, setRecovery] = useState<RefreshRecovery | null>(null);
  const [sync, setSync] = useState<HubSpotSyncRun | null>(null);
  const [interval, setInterval] = useState("");
  const [duration, setDuration] = useState("");
  const [lookup, setLookup] = useState("");
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [readyDisplay, setReadyDisplay] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [inputVersion, setInputVersion] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const sequence = useRef(0), detailSequence = useRef(0), syncSequence = useRef(0);
  const currentSchedule = useRef<RefreshSchedule | null>(null);
  const currentRecord = useRef<RefreshOccurrence | null>(null);
  const currentRecovery = useRef<RefreshRecovery | null>(null);
  const inputRevision = useRef(0), locked = useRef(false), ready = useRef(false);
  const capturedInput = inputVersion;

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const request = ++sequence.current;
    setGeneration(request); setReadyDisplay(false);
    ++detailSequence.current; ++syncSequence.current;
    currentSchedule.current = null; currentRecord.current = null; currentRecovery.current = null; ready.current = false;
    setSchedule(null); setSelected(null); setRecovery(null); setSync(null); setRecords([]); setError(null); setReading(true);
    const results = await Promise.allSettled([readSchedule(view, signal), readOccurrences(view, signal)]);
    if (signal.aborted || request !== sequence.current) return;
    if (results[0].status === "fulfilled") { currentSchedule.current = results[0].value; setSchedule(results[0].value); }
    if (results[1].status === "fulfilled") setRecords(results[1].value);
    ready.current = results.every(result => result.status === "fulfilled");
    setReadyDisplay(ready.current);
    if (!ready.current) setError("Some refresh records are unavailable or the account changed. New grants are blocked; independently valid saved records remain inspectable.");
    setReading(false);
  }, [view]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload); window.addEventListener("vitaai-refresh-changed", reload);
    return () => { controller.abort(); currentSchedule.current = null; currentRecord.current = null; currentRecovery.current = null;
      ready.current = false; window.removeEventListener("focus", reload); window.removeEventListener("vitaai-refresh-changed", reload); };
  }, [refresh]);

  async function inspect(id: string, expectedSequence: number) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || reading || expectedSequence !== sequence.current) return;
    const request = ++detailSequence.current; ++syncSequence.current;
    currentRecord.current = null; currentRecovery.current = null;
    setSelected(null); setRecovery(null); setSync(null); setError(null);
    try {
      const record = await readOccurrence(view, id, signal);
      if (signal.aborted || request !== detailSequence.current) return;
      currentRecord.current = record; setSelected(record);
      try {
        const value = await readRecovery(view, record, signal);
        if (!signal.aborted && request === detailSequence.current) { currentRecovery.current = value; setRecovery(value); }
      } catch { if (!signal.aborted && request === detailSequence.current) setError("Recovery readiness unavailable. Saved occurrence remains historical; finalization is disabled."); }
    } catch { if (!signal.aborted && request === detailSequence.current) setError("Saved occurrence unavailable for this account."); }
  }

  async function inspectSync(record: RefreshOccurrence) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || currentRecord.current !== record) return;
    const request = ++syncSequence.current; setSync(null); setError(null);
    try {
      const value = await readOccurrenceSync(view, record, signal);
      if (!signal.aborted && request === syncSequence.current && currentRecord.current === record) setSync(value);
    } catch { if (!signal.aborted && request === syncSequence.current) setError("No confirmed saved sync result is available. A pending occurrence may still have committed staging. No fetch or retry occurred."); }
  }

  async function mutate(kind: "grant" | "revoke" | "recover") {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !admin || locked.current || refreshRequests.has(refreshKey(view))) return;
    const retained = schedule?.authorization, seconds = Number(interval), durationSeconds = Number(duration);
    if (kind !== "recover" && (!schedule || currentSchedule.current !== schedule)) return;
    if (kind === "grant" && (!ready.current || !schedule?.can_authorize || capturedInput !== inputRevision.current
      || !Number.isSafeInteger(seconds) || seconds < 900 || seconds > 86400
      || !Number.isSafeInteger(durationSeconds) || durationSeconds <= seconds || durationSeconds > 86400)) return;
    if (kind === "revoke" && retained?.status !== "authorized") return;
    if (kind === "recover" && (!selected || currentRecord.current !== selected || currentRecovery.current !== recovery
      || !recovery?.eligible || selected.status !== "pending" || Date.now() < Date.parse(selected.worker_deadline_at))) return;
    const body = kind === "grant" ? { schema_version: "1" as const, expected_revision: retained?.revision || 0,
      expected_account_revision: view.account.revision, expected_configuration_hash: schedule!.configuration_hash,
      interval_seconds: seconds, duration_seconds: durationSeconds }
      : kind === "revoke" ? { schema_version: "1" as const, expected_revision: retained!.revision }
      : { schema_version: "1" as const, expected_revision: selected!.revision, expected_account_revision: recovery!.account_revision,
        expected_worker_deadline_at: selected!.worker_deadline_at };
    const path = kind === "recover" ? `${occurrencePath(selected!.id)}/recover`
      : `${accountPath(view.account.id)}/refresh-schedule${kind === "revoke" ? "/revoke" : ""}`;
    locked.current = true; ready.current = false; ++sequence.current; ++detailSequence.current; ++syncSequence.current;
    setGeneration(sequence.current); setReadyDisplay(false);
    currentSchedule.current = null; currentRecord.current = null; currentRecovery.current = null;
    setBusy(true); setRecovery(null); setError(null); setNotice(null);
    try {
      await mutateRefresh(view, path, body, signal);
      if (!signal.aborted) setNotice("Request returned. Saved records must refresh to confirm the disposition. Staging never selects source facts.");
    } catch {
      if (!signal.aborted) setNotice("Response could not be confirmed and may have persisted. Refresh reads saved records without repeating the request. Aborting transport does not prove rollback or remote cancellation.");
    } finally {
      locked.current = false;
      if (!signal.aborted) { setBusy(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-refresh-changed"));
    }
  }

  const pending = busy || refreshRequests.has(refreshKey(view));
  const grant = schedule?.authorization, inspectionSequence = generation;
  const validInterval = Number.isSafeInteger(Number(interval)) && Number(interval) >= 900 && Number(interval) <= 86400;
  const validDuration = Number.isSafeInteger(Number(duration)) && Number(duration) > Number(interval) && Number(duration) <= 86400;
  function submit(event: FormEvent) { event.preventDefault(); void mutate("grant"); }
  return <details className="pipeline-panel hubspot-panel"><summary>Scheduled HubSpot staging · {view.account.name}</summary>
    <p>Read-only staging on a bounded schedule. Granting permits future configured provider reads under this session; source promotion and saved-change detection remain separate explicit actions.</p>
    <p>Current account revision {view.account.revision}; configuration {schedule?.configuration_hash || "unavailable"}; schedule revision {grant?.revision ?? (schedule ? 0 : "unavailable")}.</p>
    <p>Worker configured eligibility: {schedule ? (schedule.worker_available ? "eligible" : "unavailable") : "unknown"}. This does not prove thread liveness, connectivity, successful staging or factual freshness.</p>
    {!admin && <p>Read only. An administrator must grant, revoke or finalize.</p>}
    {grant && <section aria-label="Retained refresh authorization"><h3>Retained authorization · {grant.status}</h3>
      <p>{grant.id}; revision {grant.revision}; previous {grant.previous_id || "none"}; actor {grant.actor_id}; recorded {grant.recorded_at}.</p>
      <p>Account revision {grant.account_revision}; configuration {grant.configuration_hash}; portal {grant.portal_id}; company {grant.company_id}; mapping {grant.mapping_hash}.</p>
      <p>Authorized {grant.authorized_at}; first due {grant.first_due_at}; expires {grant.expires_at}; interval {grant.interval_seconds} seconds. Original-session expiry may shorten the requested duration. Historical intent does not establish current authority.</p>
      <button disabled={pending || reading || !admin || grant.status !== "authorized"} onClick={() => mutate("revoke")}>Revoke refresh authorization</button>
    </section>}
    <form onSubmit={submit}><label>Refresh interval in seconds (900–86400)<input type="number" min="900" max="86400" step="1" required value={interval}
      onChange={event => { setInputVersion(++inputRevision.current); setInterval(event.target.value); }} /></label>
      <label>Authorization duration in seconds (900–86400)<input type="number" min="900" max="86400" step="1" required value={duration}
        onChange={event => { setInputVersion(++inputRevision.current); setDuration(event.target.value); }} /></label>
      <p>Choose both explicitly. Duration must exceed the interval; the original session must last beyond the first due time. No backlog or automatic retry.</p>
      <button disabled={pending || reading || !admin || !readyDisplay || !schedule?.can_authorize || !validInterval || !validDuration}>Authorize scheduled staging reads</button>
    </form>
    <button disabled={pending} onClick={() => refresh()}>Refresh staging records</button>
    {reading && <p role="status">Loading saved refresh records...</p>}{pending && <p role="status">Refresh request pending.</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-banner">{error}</p>}
    <section aria-label="Refresh occurrence history"><h3>Refresh occurrences</h3>
      <p>Latest twenty by authorization revision and slot. Pending work across all history blocks every grant; failed or interrupted work blocks its grant. Finalization never renews it.</p>
      {schedule?.pending_occurrence_id && <button disabled={pending || reading} onClick={() => inspect(schedule.pending_occurrence_id!, inspectionSequence)}>Inspect pending staging occurrence</button>}
      <ul>{records.map(record => <li key={record.id}><button disabled={pending || reading} onClick={() => inspect(record.id, inspectionSequence)}>Inspect occurrence {record.id}</button> · {record.status} · grant revision {record.authorization_revision}, slot {record.slot}; started {record.started_at}</li>)}</ul>
      <form onSubmit={event => { event.preventDefault(); void inspect(lookup, inspectionSequence); }}><label>Saved occurrence ID<input maxLength={36} required value={lookup} onChange={event => setLookup(event.target.value)} /></label>
        <button disabled={pending || reading}>Load saved occurrence</button></form>
      {selected && <section aria-label="Saved refresh occurrence"><h4>{selected.id} · {selected.status}</h4>
        <p>Revision {selected.revision}; grant {selected.authorization_id} revision {selected.authorization_revision}; slot {selected.slot}.</p>
        <p>Due {selected.due_at}; started {selected.started_at}; original worker deadline {selected.worker_deadline_at}; finished {selected.finished_at || "none"}; error {selected.error_code || "none"}.</p>
        <p>Recovered by {selected.recovered_by || "none"}; recovered {selected.recovered_at || "none"}. Local finalization cannot prove remote cancellation.</p>
        <p>Reserved sync {selected.sync_run_id}. A reservation alone does not prove a saved result.</p>
        <button disabled={pending} onClick={() => inspectSync(selected)}>Inspect saved staging result</button>
        <button disabled={pending || reading || !admin || !recovery?.eligible || selected.status !== "pending"}
          onClick={() => mutate("recover")}>Finalize interrupted staging occurrence</button>
        {sync && <section aria-label="Saved staging result"><h4>Saved sync {sync.id}</h4><p>Status {sync.status}; disposition {sync.disposition || "none"}; error {sync.error_code || "none"}; observation {sync.observation_id || "none"}.</p>
          <p>Started {sync.started_at}; finished {sync.finished_at || "none"}. This retained staging result does not establish current selected facts.</p></section>}
      </section>}
    </section>
  </details>;
}
