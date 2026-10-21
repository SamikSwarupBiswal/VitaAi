"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountView } from "@/lib/api";
import { narrativePending, readNarrative, readNarratives, readNarrativeRecovery, readPendingNarrative, recoverNarrative, startNarrative,
  type NarrativeReadiness, type NarrativeRecoveryReadiness, type NarrativeRun } from "@/lib/research-narrative";
import { researchContextUsable, researchSourceMatchedLink, type ResearchContextView } from "@/lib/research";

export function ResearchNarrativePanel({ view, context, writer }: {
  view: AccountView; context: ResearchContextView; writer: boolean;
}) {
  const [ready, setReady] = useState<NarrativeReadiness | null>(null);
  const [runs, setRuns] = useState<NarrativeRun[]>([]);
  const [selected, setSelected] = useState<NarrativeRun | null>(null);
  const [recovery, setRecovery] = useState<NarrativeRecoveryReadiness | null>(null);
  const [live, setLive] = useState(false);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const readyBinding = useRef<NarrativeReadiness | null>(null);
  const recoveryBinding = useRef<{ run: NarrativeRun; ready: NarrativeRecoveryReadiness } | null>(null);
  const sequence = useRef(0);
  const detailSequence = useRef(0);
  const scope = `${view.account.organization_id}:${view.account.id}`;

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const current = ++sequence.current; ++detailSequence.current;
    readyBinding.current = null;
    recoveryBinding.current = null; setRecovery(null);
    setReading(true); setReady(null); setRuns([]); setSelected(null); setLive(false); setError(null);
    try {
      const value = await readNarratives(view, context, signal);
      if (!signal.aborted && current === sequence.current) {
        readyBinding.current = value.ready; setReady(value.ready); setRuns(value.runs); setNow(Date.now());
        if (!value.ready) setError("Narrative generation readiness unavailable. Saved history remains read only; generation is disabled.");
      }
    } catch {
      if (!signal.aborted && current === sequence.current) setError("Narrative records unavailable. Refresh before another request.");
    } finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }, [view, context]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    window.addEventListener("focus", reload);
    window.addEventListener("vitaai-research-narrative-changed", reload);
    return () => { controller.abort(); readyBinding.current = null; recoveryBinding.current = null; window.clearInterval(timer);
      window.removeEventListener("focus", reload); window.removeEventListener("vitaai-research-narrative-changed", reload); };
  }, [refresh]);

  async function generate() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || narrativePending.has(scope) || reading || !writer
      || !ready?.can_start || readyBinding.current !== ready || !researchContextUsable(context, Date.now())
      || (live && !ready.live_configured)) return;
    locked.current = true; narrativePending.add(scope); readyBinding.current = null;
    recoveryBinding.current = null; setRecovery(null);
    ++sequence.current; ++detailSequence.current;
    setBusy(true); setReady(null); setSelected(null); setError(null); setNotice(null);
    const mode = live ? "live" : "mock";
    try {
      const run = await startNarrative(view, context, ready, mode, signal);
      if (!signal.aborted) setNotice(`Narrative ${run.id}: ${run.mode} / ${run.status}. Inspect saved history; no facts or workflow authority changed.`);
    } catch {
      if (!signal.aborted) setNotice("Narrative response could not be confirmed and may have persisted. Refresh reads saved history; it never repeats inference. Pending may require investigation.");
    } finally {
      locked.current = false; narrativePending.delete(scope);
      if (!signal.aborted) { setBusy(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-research-narrative-changed"));
    }
  }

  async function inspect(id: string, accountPending = false) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || reading || narrativePending.has(scope)
      || (accountPending && (!ready || readyBinding.current !== ready || ready.pending_run_id !== id))) return;
    const current = ++detailSequence.current;
    recoveryBinding.current = null; setRecovery(null);
    setSelected(null); setError(null);
    try {
      const run = accountPending ? await readPendingNarrative(view, id, signal) : await readNarrative(view, context, id, signal);
      if (signal.aborted || current !== detailSequence.current) return;
      setSelected(run);
      if (run.status !== "pending") return;
      try {
        const value = await readNarrativeRecovery(view, run, signal);
        if (!signal.aborted && current === detailSequence.current) {
          recoveryBinding.current = { run, ready: value }; setRecovery(value);
        }
      } catch {
        if (!signal.aborted && current === detailSequence.current) setError("Narrative recovery readiness unavailable. Inspect again before finalization.");
      }
    } catch {
      if (!signal.aborted && current === detailSequence.current) setError("Saved narrative unavailable for this account and research run.");
    }
  }

  async function finalize() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || narrativePending.has(scope) || reading || !writer
      || !selected || !recovery?.can_recover || recoveryBinding.current?.run !== selected
      || recoveryBinding.current.ready !== recovery || !recovery.recover_after
      || !(Date.now() >= Date.parse(recovery.recover_after))) return;
    locked.current = true; narrativePending.add(scope); readyBinding.current = null; recoveryBinding.current = null;
    ++sequence.current; ++detailSequence.current;
    setBusy(true); setReady(null); setRecovery(null); setSelected(null); setError(null); setNotice(null);
    try {
      const saved = await recoverNarrative(view, selected.context, selected, recovery, signal);
      if (!signal.aborted) setNotice(`Narrative ${saved.id} finalized as interrupted. No inference was retried.`);
    } catch {
      if (!signal.aborted) setNotice("Narrative finalization could not be confirmed and may have persisted. Refresh reads saved history without repeating finalization or inference.");
    } finally {
      locked.current = false; narrativePending.delete(scope);
      if (!signal.aborted) { setBusy(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-research-narrative-changed"));
    }
  }

  const usable = researchContextUsable(context, now);
  const disabled = busy || reading || narrativePending.has(scope);
  return <section aria-label="Advisory research narrative"><h3>Advisory research narrative</h3>
    <p>Generated interpretations are unverified hypotheses for review. Internal Unknowns, confidence, scores and workflow authority stay unchanged.</p>
    <p>{reading ? "Loading narrative records..." : ready ? `Narrative model: ${ready.model || "Unconfigured"}; ${ready.live_configured ? "configured, unverified" : "live unavailable"}.` : "Readiness unavailable."}</p>
    {!usable && <p>Current public context is unavailable or expired. Historical narratives never renew it.</p>}
    {!writer && <p>Read only. Your current role cannot request a narrative.</p>}
    {ready?.pending_run_id && <p>Pending narrative {ready.pending_run_id} blocks new starts. Inspect its saved record for explicit finalization after the worker deadline. Reading never retries inference.
      <button disabled={disabled} onClick={() => inspect(ready.pending_run_id!, true)}>Inspect pending narrative</button></p>}
    {ready?.next_start_at && <p>Account cooldown ends {ready.next_start_at}. Refresh to recheck eligibility.</p>}
    <label><input type="checkbox" checked={live} disabled={disabled || !writer || !usable || !ready?.live_configured}
      onChange={event => setLive(event.target.checked)} />Use live Nebius for this narrative (paid call; requires authorized service access)</label>
    <p>Default mock makes no model call and fabricates no narrative.</p>
    <button disabled={disabled || !writer || !usable || !ready?.can_start} onClick={generate}>{live ? "Generate live narrative" : "Record mock narrative"}</button>
    <button disabled={busy} onClick={() => refresh()}>Refresh narrative records</button>
    {busy && <p role="status">Narrative request in progress...</p>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-banner">{error}</p>}
    <p>Latest 20 saved narratives for research run {context.retained_run.id}. Inspection never generates or renews context.</p>
    {!reading && !runs.length && <p>No saved narratives for this research run.</p>}
    <ul>{runs.map(run => <li key={run.id}><button disabled={disabled} onClick={() => inspect(run.id)}>Inspect narrative {run.id}</button>
      <span> · {run.mode} / {run.status} · {run.started_at}</span></li>)}</ul>
    {selected && <NarrativeRecord run={selected} current={usable
      && selected.research_run_id === context.retained_run.id && selected.context.retained_run.revision === context.retained_run.revision
      && selected.context.internal.assessment.snapshot_hash === view.assessment.snapshot_hash
      && researchContextUsable(selected.context, now)} />}
    {selected?.status === "pending" && <section aria-label="Interrupted narrative recovery"><h4>Interrupted narrative recovery</h4>
      <p>Finalization retains original context, dates, model and modes. It fences late publication and never retries inference or renews context. An authorized remote call may still finish; this does not prove provider cancellation.</p>
      <p>Recovery: {recovery?.reason || "Unavailable"}; original worker deadline {selected.worker_deadline_at}.</p>
      <button disabled={disabled || !writer || !recovery?.can_recover} onClick={finalize}>Finalize interrupted narrative</button>
    </section>}
  </section>;
}

function NarrativeRecord({ run, current }: { run: NarrativeRun; current: boolean }) {
  const internal = run.context.internal;
  return <section aria-label="Saved unverified narrative"><h4>Saved unverified narrative</h4>
    <p>{current ? "Retained context window open; hypotheses still require verification." : "Historical or expired context; this narrative is not current account intelligence."}</p>
    <p>Narrative {run.id}; research {run.research_run_id}; {run.provider}; requested {run.requested_mode}; returned {run.mode} / {run.status}.</p>
    <p>Started {run.started_at}; finished {run.finished_at || "Pending"}; worker deadline {run.worker_deadline_at}.
      Original context evaluated {run.context.evaluated_at}; expires {run.context.retained_run.expires_at || "Unavailable"}.</p>
    <p>Requested model {run.model || "Unavailable"}; expected response {run.expected_response_model || "Unavailable"}; actual {run.response_model || "Unavailable"}.
      Configuration revision {run.configuration_revision}; validation {run.validation}; factual confidence {run.factual_confidence}.</p>
    <p>Measured latency {run.latency_ms ?? "Unavailable"} ms; input tokens {run.input_tokens ?? "Unavailable"}; output tokens {run.output_tokens ?? "Unavailable"}; request {run.request_id || "Unavailable"}.</p>
    <p>{run.caveat}</p>{run.error_code && <p>Server result: {run.error_code}</p>}
    {run.recovery && <p>Finalized by {run.recovery.actor_id} at {run.recovery.recovered_at}; previous revision {run.recovery.previous_revision}. Reason {run.recovery.reason}.</p>}
    <p>Original account revision {internal.account.revision}; snapshot {internal.assessment.snapshot_hash}; selected source {internal.source?.id || "Synthetic sample"}.
      Annual value {internal.account.annual_value ?? "Unknown"}; renewal {internal.account.renewal_date ?? "Unknown"}.</p>
    <p>{run.context.brief?.internal_summary}</p>
    <ul>{run.context.brief?.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul>
    {!run.output && <p>No generated narrative. Mock, disabled, failed, discarded and pending records establish no interpretation.</p>}
    <ol>{run.output?.hypotheses.map((item, index) => <li key={index}><p>Unverified hypothesis: {item.interpretation}</p>
      <p>Verify: {item.verification_question}</p><p>Internal evidence: {item.evidence_ids.join(", ")}.</p>
      <ul>{item.source_urls.map(url => {
        const source = run.context.usable_sources?.find(value => value.url === url);
        return <li key={url}>{source && researchSourceMatchedLink(source, run.context.retained_run.target)
          ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{url}</a> : url}
          {source && <span> · published {source.published_at || "Unknown"}; fetched {source.fetched_at}; unverified.</span>}</li>;
      })}</ul>
    </li>)}</ol>
    <ul>{run.output?.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul>
  </section>;
}
