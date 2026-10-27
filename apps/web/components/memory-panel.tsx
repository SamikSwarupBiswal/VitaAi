"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type AccountView, type PipelineRun } from "@/lib/api";
import { savedRunId, validateSavedPipelineRun } from "@/lib/pipeline-history";
import { validateMemory, validateMemoryHistory, validateRecall, type MemoryEntry, type MemoryEvent, type MemoryHistory, type RecallResult } from "@/lib/memory";
import { useSession } from "./session-gate";

export function MemoryPanel({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (!actor || session?.mode !== "session" || actor.organization_id !== view.account.organization_id) return null;
  return <MemoryInspection view={view} role={actor.role} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    view.account.id, view.account.revision, view.source?.id, view.assessment.snapshot_hash])} />;
}

function MemoryInspection({ view, role }: { view: AccountView; role: string }) {
  const [input, setInput] = useState(""), [query, setQuery] = useState(""), [reason, setReason] = useState("");
  const [history, setHistory] = useState<MemoryHistory | null>(null), [recall, setRecall] = useState<RecallResult | null>(null);
  const [run, setRun] = useState<PipelineRun | null>(null), [audit, setAudit] = useState<MemoryEvent[] | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), pending = useRef(false);
  const inputs = useRef({ input: "", query: "", reason: "" }), runRef = useRef<PipelineRun | null>(null), items = useRef<MemoryEntry[]>([]);
  const served = useRef<string[]>([]);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; runRef.current = null; items.current = [];
      setRun(null); setHistory(null); setRecall(null); setAudit(null); setBusy(false); setError(null); };
    const events = ["focus", "vitaai-source-changed", "vitaai-pipeline-history-changed", "vitaai-workflow-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => events.forEach(name => window.removeEventListener(name, invalidate));
  }, []);
  const org = view.account.organization_id, account = view.account.id, base = `memory/accounts/${account}`;
  function change(field: "input" | "query" | "reason", value: string) {
    if (pending.current) return;
    ++sequence.current; pending.current = false; inputs.current[field] = value; setBusy(false); setError(null);
    if (field === "input") { setInput(value); setRun(null); runRef.current = null; }
    if (field === "query") { setQuery(value); setRecall(null); }
    if (field === "reason") setReason(value);
  }
  async function operate(work: (signal: AbortSignal, active: () => boolean) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && sequence.current === request;
    setBusy(true); setError(null); setAudit(null);
    try { await work(signal, active); }
    catch { if (active()) { items.current = []; runRef.current = null; setRun(null); setHistory(null); setRecall(null);
      setError("Memory unavailable or changed. Inspect history before another write; a lost response may already be saved."); } }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  const post = (body: unknown, signal: AbortSignal): RequestInit => ({ method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function inspect() { await operate(async (signal, active) => {
    const value = validateMemoryHistory(await api<MemoryHistory>(base, { signal }), org, account);
    if (active()) { items.current = value.items; setHistory(value); setRecall(null); }
  }); }
  async function inspectRun() {
    if (inputs.current.input !== input || !savedRunId.test(input)) return;
    await operate(async (signal, active) => {
      const value = validateSavedPipelineRun(await api<PipelineRun>(`pipeline/${input}`, { signal }), org, input, undefined, account);
      if (!value.recommendations.some(item => item.account_id === account)) throw new Error("No selected recommendation");
      if (active()) { runRef.current = value; setRun(value); }
    });
  }
  async function capture() {
    if (!run || run !== runRef.current || inputs.current.input !== input || role === "viewer") return;
    const recommendation = run.recommendations.find(item => item.account_id === account)!;
    await operate(async (signal, active) => {
      validateMemory(await api<MemoryEntry>(base, post({ pipeline_id: run.id, expected_snapshot_hash: recommendation.assessment.snapshot_hash }, signal)), org, account);
      if (active()) { runRef.current = null; setRun(null); items.current = []; setHistory(null); }
    });
  }
  async function retrieve() {
    if (inputs.current.query !== query) return;
    await operate(async (signal, active) => {
      const value = validateRecall(await api<RecallResult>(`${base}/recall`, post({ query, purpose: "recall",
        expected_snapshot_hash: view.assessment.snapshot_hash, served_ids: served.current }, signal)), org, account, view.assessment.snapshot_hash);
      if (active()) { setRecall(value); served.current = [...new Set([...served.current, ...value.items.map(item => item.memory.id)])].slice(-100); }
    });
  }
  async function lifecycle(item: MemoryEntry, state: "archived" | "invalidated") {
    if (!items.current.includes(item) || inputs.current.reason !== reason || !reason.trim() || !["admin", "reviewer"].includes(role)) return;
    await operate(async (signal, active) => {
      validateMemory(await api<MemoryEntry>(`memory/${item.id}/lifecycle`, post({ expected_revision: item.revision, state, reason }, signal)), org, account);
      if (active()) { items.current = []; setHistory(null); setRecall(null); }
    });
  }
  async function events(item: MemoryEntry) {
    if (!items.current.includes(item)) return;
    await operate(async (signal, active) => {
      const value = await api<MemoryEvent[]>(`memory/${item.id}/events`, { signal });
      if (value.length !== item.revision || value.some((event, index) => event.organization_id !== org || event.memory_id !== item.id || event.revision !== index + 1)) throw new Error("History changed");
      if (active()) setAudit(value);
    });
  }
  return <section aria-label="Account memory" style={{ overflowWrap: "anywhere" }}>
    <h3>Memory and continuity</h3><p>Retained preparation with original sources and dates. Memory does not approve work or refresh facts.</p>
    <label>Saved run for memory <input disabled={busy} value={input} maxLength={36} onChange={event => change("input", event.target.value)} /></label>
    <button disabled={busy || !savedRunId.test(input)} onClick={inspectRun}>Inspect run for memory</button>
    {run && <div><p>Original run {run.id} / {run.started_at} / author {run.actor_id ?? "Not recorded"} / assessment {run.as_of}.</p>
      <button disabled={busy || role === "viewer"} onClick={capture}>Capture inspected recommendation</button></div>}
    <button disabled={busy} onClick={inspect}>Inspect account memory</button>
    <label>Recall query <input disabled={busy} value={query} maxLength={500} onChange={event => change("query", event.target.value)} /></label>
    <button disabled={busy} onClick={retrieve}>Recall relevant memories</button>
    <button disabled={busy} onClick={() => { served.current = []; setRecall(null); }}>Include previously recalled memories</button>
    {busy && <p role="status">Reading or saving memory…</p>}{error && <p role="alert">{error}</p>}
    {history && <><p>{history.items.length} of {history.total_count} retained memories in stable ID order. {history.has_more ? "More records exist outside this20-record window." : "No additional records in this account memory store."}</p>
      <label>Lifecycle reason <textarea disabled={busy} value={reason} maxLength={2000} onChange={event => change("reason", event.target.value)} /></label>
      {history.items.map(item => <details key={item.id}><summary>{item.state} · original {item.source.started_at} · {item.recommendation.action.kind}</summary>
        <p>Memory {item.id} / revision {item.revision} / captured {item.created_at} by {item.captured_by}.</p>
        <p>Source run {item.source.pipeline_id} / author {item.source.actor_id ?? "Not recorded"} / assessment {item.source.as_of}.</p>
        <p>Annual value {item.context.account.annual_value ?? "Unknown"} / renewal {item.context.account.renewal_date ?? "Unknown"}.</p>
        <p>{item.recommendation.action.rationale}</p>
        {item.context.evidence.map(fact => <p key={fact.id}>Evidence {fact.id} / {fact.source} / {fact.observed_at}: {fact.fact}</p>)}
        <button disabled={busy} onClick={() => events(item)}>Inspect memory events</button>
        {["admin", "reviewer"].includes(role) && item.state !== "invalidated" && <>
          {item.state === "active" && <button disabled={busy || !reason.trim()} onClick={() => lifecycle(item, "archived")}>Archive memory</button>}
          <button disabled={busy || !reason.trim()} onClick={() => lifecycle(item, "invalidated")}>Invalidate memory</button></>}
      </details>)}</>}
    {audit && <ol>{audit.map(event => <li key={event.id}>{event.revision} · {event.kind} · {event.created_at} · actor {event.actor_id} · {event.reason ?? "Original capture"}</li>)}</ol>}
    {recall && <div aria-live="polite"><h4>Why these memories</h4><p>{recall.policy} / evaluated {recall.evaluated_at} / inspected {recall.inspected_count} of {recall.total_count}. {recall.has_more && "Additional candidates omitted."}</p>
      <p>Exclusions: {Object.entries(recall.excluded).map(([key, count]) => `${key}: ${count}`).join("; ") || "None"}.</p>
      {recall.caveats.map(caveat => <p className="caveat" key={caveat}>{caveat}</p>)}
      {!recall.items.length && <p>No eligible matching memory. This does not establish no past work.</p>}
      {recall.items.map(item => <details key={item.memory.id}><summary>{item.memory.source.started_at} · score {item.score} · {item.memory.recommendation.action.kind}</summary>
        <p>{item.memory.recommendation.action.rationale}</p><p>Memory {item.memory.id} / run {item.memory.source.pipeline_id}.</p>
        <p>Relevance {item.relevance} + significance {item.significance} + original confidence {item.confidence}% − age penalty {item.decay_penalty} ({item.age_days} days).</p>
        {item.reasons.map(value => <p key={value}>{value}</p>)}</details>)}</div>}
  </section>;
}
