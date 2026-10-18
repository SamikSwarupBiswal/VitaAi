"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountView } from "@/lib/api";
import { checkResearchRun, readResearch, readResearchRun, researchContext, researchSourceLink, startResearch,
  type ResearchReadiness, type ResearchRun } from "@/lib/research";
import { useSession } from "./session-gate";

export function ResearchPanel({ view }: { view: AccountView }) {
  const session = useSession();
  const actor = session?.actor;
  if (session?.mode !== "session" || !actor) return <details className="pipeline-panel"><summary>Advisory research</summary>
    <p>Research controls require session identity.</p></details>;
  return <ResearchAccount view={view} writer={actor.role !== "viewer"}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}`} />;
}

function ResearchAccount({ view, writer }: { view: AccountView; writer: boolean }) {
  const [readiness, setReadiness] = useState<ResearchReadiness | null>(null);
  const [runs, setRuns] = useState<ResearchRun[]>([]);
  const [selected, setSelected] = useState<ResearchRun | null>(null);
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const sequence = useRef(0);

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const current = ++sequence.current;
    setReading(true); setReadiness(null); setSelected(null); setRuns([]); setError(null);
    try {
      const value = await readResearch(view, signal);
      if (!signal.aborted && current === sequence.current) {
        setReadiness(value.readiness); setRuns(value.runs); setNow(Date.now());
      }
    } catch { if (!signal.aborted && current === sequence.current) setError("Research records unavailable. Refresh records or portfolio before starting another run."); }
    finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }, [view]);

  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    // Defer the initial read; the same function handles explicit/focus revalidation.
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("focus", reload);
    window.addEventListener("vitaai-research-changed", reload);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener("focus", reload);
      window.removeEventListener("vitaai-research-changed", reload); };
  }, [refresh]);

  async function search() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || reading || !writer || !readiness?.can_start
      || (live && readiness.live_status !== "configured_unverified")) return;
    locked.current = true; ++sequence.current; setBusy(true); setReadiness(null); setSelected(null); setError(null);
    setNotice(null);
    const mode = live ? "live" : "mock";
    try {
      const run = checkResearchRun(view, await startResearch(view, mode, signal));
      if (run.account_revision !== view.account.revision || run.requested_mode !== mode) throw new Error("Context changed");
      if (!signal.aborted) setNotice(`Run ${run.id}: ${run.mode} / ${run.status}. Inspect saved history; account intelligence is unchanged.`);
    } catch {
      if (!signal.aborted) setNotice("Search response could not be confirmed and may have persisted. Refresh reads saved records; it never repeats the search. Pending may require operator investigation.");
    } finally {
      locked.current = false;
      if (!signal.aborted) { setBusy(false); setLive(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-research-changed"));
    }
  }

  async function inspect(id: string) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || reading) return;
    const current = ++sequence.current;
    setSelected(null); setError(null);
    try {
      const run = await readResearchRun(view, id, signal);
      if (!signal.aborted && current === sequence.current) setSelected(run);
    } catch { if (!signal.aborted && current === sequence.current) setError("Saved research run unavailable for this account."); }
  }

  const disabled = busy || reading;
  return <details className="pipeline-panel research-panel"><summary>Advisory research · {view.account.name}</summary>
    <p>Untrusted advisory context. Search never ingests evidence or changes facts, scores, model runs, plans, approvals or execution.</p>
    <p role="status">{reading ? "Loading research records..." : readiness ? !readiness.enabled ? "Research disabled for this organization."
      : `Live provider: ${readiness.live_status}. Configuration is not proof of provider success or live authorization.` : "Readiness unavailable."}</p>
    <p>Current account revision {view.account.revision}. Mapped target: {readiness?.target ? `${readiness.target.company_name} / ${readiness.target.domain}` : "Unmapped or unavailable"}.</p>
    {!writer && <p>Read only. Your current role cannot start research.</p>}
    {readiness?.pending_run_id && <p>Pending run {readiness.pending_run_id}. New starts are blocked; interrupted runs require operator investigation. No recovery or automatic retry is available.</p>}
    {readiness?.next_start_at && <p>Account cooldown ends {readiness.next_start_at}. Refresh records to check eligibility.</p>}
    <label><input type="checkbox" checked={live} disabled={disabled || !writer || readiness?.live_status !== "configured_unverified"}
      onChange={event => setLive(event.target.checked)} />Use live Tavily search for this run (requires authorized service access)</label>
    <p>Default mock performs no provider call and creates no illustrative facts. Live is an explicit request for the mapped company/domain only.</p>
    <div className="source-actions"><button disabled={disabled || !writer || !readiness?.can_start} onClick={search}>{live ? "Start live research" : "Record mock research"}</button>
      <button disabled={busy} onClick={() => refresh()}>Refresh research records</button></div>
    {busy && <p role="status">Research request in progress...</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    <section aria-label="Research history"><h2>Research history</h2><p>Latest 20 saved runs. Viewing history never searches or renews freshness.</p>
      {!reading && !runs.length && <p>No saved research runs.</p>}
      <ul>{runs.map(run => <li key={run.id}><button disabled={disabled} onClick={() => inspect(run.id)}>Inspect {run.id}</button>
        <span> · {run.mode} / {run.status} · revision {run.account_revision} · {run.started_at}</span></li>)}</ul>
      {selected && <ResearchRecord run={selected} readiness={readiness} now={now} />}
    </section>
  </details>;
}

function ResearchRecord({ run, readiness, now }: { run: ResearchRun; readiness: ResearchReadiness | null; now: number | null }) {
  return <section aria-label="Saved research run"><h3>Saved research run</h3>
    <p>Run {run.id} · {run.provider} · requested {run.requested_mode} · returned {run.mode} / {run.status}.</p>
    <p>Original account revision {run.account_revision}; target {run.target.company_name} / {run.target.domain}.</p>
    <p>Started {run.started_at}; finished {run.finished_at || "Pending"}; context expires {run.expires_at || "No context window"}.</p>
    <p>{researchContext(run, readiness, now)}</p>
    <p>{run.caveat}</p>
    {run.error_code && <p>Server result: {run.error_code}</p>}
    {run.status === "pending" && <p>Pending is unresolved. It blocks new searches; viewing this run cannot recover or retry it.</p>}
    {run.status === "discarded" && <p>Context or authority changed. Retrieved text was discarded.</p>}
    {!run.sources?.length && <p>No sources from this run. Disabled, mock, empty live results and fallback do not establish external facts.</p>}
    <ul>{run.sources?.map(source => <li key={source.url}>
      <h4>{researchSourceLink(source.url, run.target.domain) ? <a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.title}</a> : source.title}</h4>
      <p>{source.text}</p><p>Source: {source.url}</p>
      <p>Published {source.published_at || "Unknown"}; fetched {source.fetched_at}. Freshness at fetch: {source.freshness_at_fetch} (30-day horizon).</p>
      <p>Publication age now: {now === null || !source.published_at ? "Unknown" : now - Date.parse(source.published_at) > 30 * 86400000 ? "Older than 30 days" : "Within 30 days"}.</p>
      <p>Provider relevance {source.provider_relevance} (0–1); factual confidence {source.factual_confidence}. Match: configured domain; operator-declared, not verified.</p>
    </li>)}</ul>
  </section>;
}
