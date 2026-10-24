"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { AccountView } from "@/lib/api";
import { inspectSeed, mutateSeed, prepareSeed, prepareSeedCleanup, readSeedHistory, readSeedReadiness, readSeedVersions, seedId,
  type SeedInspection, type SeedJob, type SeedOperation, type SeedReadiness } from "@/lib/hubspot-seeding";
import { useSession } from "./session-gate";

const mutations = new Set<string>();
type Props = { view: AccountView; blocked?: boolean };

export function HubSpotSeedPanel({ view, blocked = false }: Props) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== view.account.organization_id) return null;
  return <SeedControls view={view} blocked={blocked} admin={actor.role === "admin"}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.source?.id ?? "sample"}`} />;
}

function SeedControls({ view, blocked, admin }: Props & { admin: boolean }) {
  const [ready, setReady] = useState<SeedReadiness | null>(null), [history, setHistory] = useState<SeedJob[]>([]);
  const [selected, setSelected] = useState<SeedInspection | null>(null), [versions, setVersions] = useState<SeedJob[] | null>(null);
  const [input, setInput] = useState({ id: "", count: 1, reason: "", reviewed: false, execute: false,
    include_contacts: false, include_notes: false, include_deals: false, cleanup: [] as number[] });
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null), [now, setNow] = useState<number | null>(null);
  const life = useRef<AbortController | null>(null), detailRequest = useRef<AbortController | null>(null);
  const state = useRef({ mounted: false, view, blocked, input, ready, selected, versions, read: 0, detail: 0, busy: false });
  const key = `${view.account.organization_id}:${view.account.id}`;
  useLayoutEffect(() => { const active = state.current; active.view = view; active.blocked = blocked;
    return () => { active.blocked = true; };
  }, [view, blocked]);

  const refresh = useCallback(async (signal: AbortSignal) => {
    const active = state.current, sequence = ++active.read;
    active.detail++; detailRequest.current?.abort(); active.ready = null; active.selected = null; active.versions = null;
    active.input = { ...active.input, reviewed: false, execute: false, reason: "", cleanup: [] };
    setInput(active.input); setReady(null); setSelected(null); setVersions(null); setHistory([]); setError(null);
    const results = await Promise.allSettled([readSeedReadiness(view, signal), readSeedHistory(view, signal)]);
    if (!active.mounted || signal.aborted || sequence !== active.read || active.view !== view) return;
    const [readiness, records] = results;
    if (readiness.status === "fulfilled") { active.ready = readiness.value; setReady(readiness.value); }
    if (records.status === "fulfilled") setHistory(records.value);
    if (results.some(result => result.status === "rejected")) setError("Some seed records or readiness are unavailable. Refresh before another action; independently loaded history remains inspectable.");
  }, [view]);

  useEffect(() => {
    const active = state.current, controller = new AbortController(); life.current = controller; active.mounted = true;
    const reload = () => { void refresh(controller.signal); };
    const initial = window.setTimeout(reload, 0);
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("focus", reload); window.addEventListener("vitaai-seeds-changed", reload);
    return () => { active.mounted = false; active.read++; active.detail++; controller.abort(); detailRequest.current?.abort();
      window.clearTimeout(initial); window.clearInterval(timer); window.removeEventListener("focus", reload);
      window.removeEventListener("vitaai-seeds-changed", reload); };
  }, [refresh]);

  function edit(changes: Partial<typeof input>) {
    const active = state.current;
    active.input = { ...active.input, ...changes }; setInput(active.input);
    if (changes.id !== undefined) {
      active.detail++; detailRequest.current?.abort(); active.selected = null; active.versions = null; setSelected(null); setVersions(null);
    }
  }

  async function inspect(id: string, captured = input) {
    const active = state.current;
    if (!active.mounted || active.view !== view || active.busy || mutations.has(key) || active.input !== captured || !seedId.test(id)) return;
    const sequence = ++active.detail; detailRequest.current?.abort(); const controller = new AbortController(); detailRequest.current = controller;
    active.selected = null; active.versions = null; setSelected(null); setVersions(null); setError(null);
    active.input = { ...active.input, reviewed: false, execute: false, reason: "", cleanup: [] }; setInput(active.input);
    const matches = () => active.mounted && !controller.signal.aborted && sequence === active.detail && active.view === view;
    try {
      const value = await inspectSeed(view, id, controller.signal);
      if (!matches()) return;
      active.selected = value; setSelected(value);
      try {
        const rows = await readSeedVersions(view, value, controller.signal);
        if (matches() && active.selected === value) { active.versions = rows; setVersions(rows); }
      } catch { if (matches()) setError("Seed version history unavailable. Inspect again before reviewing or executing."); }
    } catch { if (matches()) setError("Seed inspection unavailable for this account. Refresh and inspect the saved ID again."); }
  }

  async function mutate(operation: "prepare" | "cleanup" | SeedOperation) {
    const active = state.current, signal = life.current?.signal;
    if (!admin || !active.mounted || active.view !== view || active.blocked || active.busy || mutations.has(key)
      || active.input !== input || !signal || signal.aborted) return;
    const inspected = active.selected;
    if (operation === "prepare" ? active.ready !== ready || !ready?.can_prepare
      : !inspected || inspected !== selected) return;
    if (["approved", "rejected", "execute"].includes(operation) && (!versions || active.versions !== versions)) return;
    const clock = Date.now();
    if (operation === "approved" && (!input.reviewed || !input.reason.trim() || !inspected?.can_review
      || clock >= Date.parse(inspected.job.expires_at))) return;
    if (operation === "rejected" && (!input.reason.trim() || !inspected?.can_review)) return;
    if (operation === "execute" && (!input.execute || !inspected?.can_execute
      || clock >= Date.parse(inspected.job.review_expires_at ?? "") || clock >= Date.parse(inspected.job.expires_at))) return;
    if (operation === "recover" && (!inspected?.can_recover || !inspected.job.worker_deadline_at
      || clock < Date.parse(inspected.job.worker_deadline_at))) return;
    if (operation === "cleanup" && (!inspected?.can_prepare_cleanup || !input.cleanup.length
      || !versions || active.versions !== versions)) return;
    active.busy = true; mutations.add(key); setBusy(true); setError(null); setNotice(null);
    active.read++; active.detail++; detailRequest.current?.abort(); active.ready = null; active.selected = null; active.versions = null;
    setReady(null); setSelected(null); setVersions(null);
    try {
      const job = operation === "prepare" ? await prepareSeed(view, ready!, { count: input.count,
        include_contacts: input.include_contacts, include_notes: input.include_notes, include_deals: input.include_deals }, signal)
        : operation === "cleanup" ? await prepareSeedCleanup(view, inspected!, input.cleanup, signal)
        : await mutateSeed(view, inspected!, operation, input.reason, signal);
      if (active.mounted && !signal.aborted) setNotice(`Saved seed job ${job.id}, revision ${job.revision}. Inspect the retained record before another action.`);
    } catch {
      if (active.mounted && !signal.aborted) setNotice("The seed operation was not confirmed. It may have persisted. Inspect saved history; no request was repeated.");
    } finally {
      active.busy = false; mutations.delete(key);
      if (active.mounted && !signal.aborted) setBusy(false);
      window.dispatchEvent(new Event("vitaai-seeds-changed"));
    }
  }

  const disabled = !!blocked || busy || mutations.has(key);
  const fresh = now !== null && !!selected && now < Date.parse(selected.job.expires_at);
  const reviewable = admin && !disabled && selected?.can_review && fresh && !!versions;
  const executable = admin && !disabled && selected?.can_execute && fresh && !!versions
    && now !== null && now < Date.parse(selected.job.review_expires_at ?? "");
  return <details className="pipeline-panel hubspot-panel"><summary>Governed synthetic HubSpot seeding</summary>
    <p>Prepare 1–3 synthetic companies with explicitly selected related records. Cleanup is a separate selected-ID preview with fresh review and archive opt-in. No automatic cleanup runs.</p>
    <button disabled={disabled} onClick={() => { const signal = life.current?.signal; if (signal && !signal.aborted) void refresh(signal); }}>Refresh saved seed records</button>
    <p>{ready ? `Configured eligibility: ${ready.configured}. Portal ${ready.portal_id || "unconfigured"}; declared test portal ${ready.test_portal_id || "none"}.` : "Seed readiness unavailable."} Configuration is unverified.</p>
    {ready?.blocking_job_id && <button disabled={disabled} onClick={() => void inspect(ready.blocking_job_id!)}>Inspect blocking seed job</button>}
    <label>Synthetic company count<select value={input.count} disabled={disabled} onChange={event => edit({ count: Number(event.target.value) })}>
      {[1, 2, 3].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
    <label><input type="checkbox" checked={input.include_contacts} disabled={disabled}
      onChange={event => edit({ include_contacts: event.target.checked })} />One synthetic contact per company (no email or phone)</label>
    <label><input type="checkbox" checked={input.include_notes} disabled={disabled}
      onChange={event => edit({ include_notes: event.target.checked })} />One synthetic note per company</label>
    <label><input type="checkbox" checked={input.include_deals} disabled={disabled || !ready?.deal_seed_available}
      onChange={event => edit({ include_deals: event.target.checked })} />One synthetic deal per company (no amount or close date)</label>
    <p>Deal placement: {ready?.deal_pipeline || "unconfigured"} / {ready?.deal_stage || "unconfigured"}. A configured stage is unverified until the provider accepts and readback verifies it.</p>
    <button disabled={disabled || !admin || !ready?.can_prepare} onClick={() => void mutate("prepare")}>Save synthetic seed preview (no upload)</button>
    {busy && <p role="status">Saving seed operation...</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
    <h3>Saved seed jobs</h3><p>Latest twenty. Reading or refreshing does not create companies or renew approval.</p>
    <ul>{history.map(job => <li key={job.id}>{job.id} · {job.status} · revision {job.revision} · {job.preview.created_at}
      <button disabled={disabled} onClick={() => void inspect(job.id)}>Inspect seed job {job.sequence}</button></li>)}</ul>
    {!history.length && <p>No saved seed history loaded.</p>}
    <form onSubmit={(event: FormEvent) => { event.preventDefault(); void inspect(input.id); }}>
      <label>Saved seed job ID<input value={input.id} maxLength={36} required onChange={event => edit({ id: event.target.value })} /></label>
      <button disabled={disabled || !seedId.test(input.id)}>Inspect saved seed job</button></form>
    {selected && <section aria-label="Exact synthetic seed review"><h3>Exact synthetic seed review</h3>
      <p>Job {selected.job.id} · revision {selected.job.revision} · {selected.job.status}. Portal {selected.job.test_portal_id}; account scope {selected.job.account_id} revision {selected.job.account_revision}.</p>
      <p>Operation: {selected.job.operation ?? "create"}. {selected.job.operation === "archive" && `Archive selected verified resources from seed job ${selected.job.source_job_id}; children are processed first.`}</p>
      <p>Original preview {selected.job.preview.created_at}; expires {selected.job.expires_at}. Binding {selected.job.binding_hash}.</p>
      <p>The embedded preview checksum grants no authority. The separate saved review and claim govern this {selected.job.operation === "archive" ? "archive" : "creation"} operation.</p>
      {selected.job.items.map(item => <section key={item.index}><h4>Synthetic {item.object_type} · item {item.index + 1}</h4>
        <p>{selected.job.operation === "archive" ? `${item.archive_selected ? "DELETE" : "Not selected"} /crm/v3/objects/${item.object_type}/${item.archive_target_id ?? "Unknown"}` : `POST /crm/v3/objects/${item.object_type}`}. {item.parent_index != null
          ? `${selected.job.operation === "archive" ? "Original retained association to" : "Associate only to newly verified"} company item ${item.parent_index + 1}, HUBSPOT_DEFINED type ${item.association_type_id}.` : selected.job.operation === "archive" ? "Retained synthetic company." : "New company with no parent association."}</p>
        <pre>{item.provider_request}</pre>
        {item.resolved_request && <details><summary>Retained exact dispatched payload</summary><pre>{item.resolved_request}</pre></details>}
        <p>{item.status}; resource {item.resource_id ?? "Unknown"}; readback {item.verification}. {item.error_code}</p>
        {selected.can_prepare_cleanup && item.status === "succeeded" && item.verification === "verified" && <label>
          <input type="checkbox" checked={input.cleanup.includes(item.index)} disabled={disabled || !versions}
            onChange={event => edit({ cleanup: event.target.checked ? [...input.cleanup, item.index]
              : input.cleanup.filter(index => index !== item.index) })} />Select this exact verified resource for a separate cleanup preview</label>}
        {item.verified_at && <p>Independently read {item.verified_at}; exact request hash {item.verified_request_hash}.</p>}</section>)}
      <label>Review reason<textarea value={input.reason} maxLength={1000} disabled={!reviewable} onChange={event => edit({ reason: event.target.value })} /></label>
      <label><input type="checkbox" checked={input.reviewed} disabled={!reviewable} onChange={event => edit({ reviewed: event.target.checked })} />I reviewed these exact synthetic fields and test portal.</label>
      <button disabled={!reviewable || !input.reviewed || !input.reason.trim()} onClick={() => void mutate("approved")}>Approve exact seed preview</button>
      <button disabled={!reviewable || !input.reason.trim()} onClick={() => void mutate("rejected")}>Reject seed preview</button>
      {selected.can_prepare_cleanup && <><p>Select children with their company. Unknown writes cannot be archived by guessing. Saving this preview performs no provider operation and requires a new review.</p>
        <button disabled={disabled || !admin || !versions || !input.cleanup.length} onClick={() => void mutate("cleanup")}>Save selected cleanup preview (no archive)</button></>}
      <p>Reviewer {selected.job.reviewed_by ?? "None"}; reviewed {selected.job.reviewed_at ?? "not reviewed"}; approval expires {selected.job.review_expires_at ?? "none"}. {selected.job.review_reason}</p>
      <label><input type="checkbox" checked={input.execute} disabled={!executable} onChange={event => edit({ execute: event.target.checked })} />
        {selected.job.operation === "archive" ? "Archive exactly the selected verified synthetic IDs in this approved cleanup preview." : "Create exactly these approved synthetic records and associations in the configured test portal."}</label>
      <button disabled={!executable || !input.execute} onClick={() => void mutate("execute")}>{selected.job.operation === "archive" ? "Archive approved synthetic records" : "Create approved synthetic records"}</button>
      <p>Claim {selected.job.claimed_at ?? "none"}; original worker deadline {selected.job.worker_deadline_at ?? "none"}. Unknown results retain their claim and cannot retry. Recovery does not prove remote cancellation.</p>
      <button disabled={disabled || !admin || !selected.can_reconcile} onClick={() => void mutate("reconcile")}>Read back retained company IDs</button>
      <button disabled={disabled || !admin || !selected.can_recover} onClick={() => void mutate("recover")}>Finalize interrupted seed worker</button>
      <details><summary>Saved seed versions · latest 100</summary>{versions ? <pre>{JSON.stringify(versions, null, 2)}</pre> : <p>Version history unavailable.</p>}</details>
      <p>Creation/readback establishes synthetic resource state only. Source mapping, facts, scores, missions and business outcomes do not change.</p>
    </section>}
  </details>;
}
