"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { api, type PipelineRun } from "@/lib/api";
import { hasOrderedDate, savedRunId, validatePipelineHistory, validateSavedPipelineRun, type PipelineHistory, type PipelineRunSummary } from "@/lib/pipeline-history";
import { useSession } from "./session-gate";

type Props = {
  organizationId: string; snapshots: Record<string, string>; onSelect?: (id: string) => void; accountId?: string;
  renderComparison: (run: PipelineRun, baselines: PipelineRunSummary[]) => ReactNode;
};

export function SavedPipelineHistory(props: Props) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== props.organizationId) {
    return <p>Session identity in this organization is required to inspect saved pipeline history.</p>;
  }
  return <HistoryInspection {...props} key={JSON.stringify([actor.id, actor.organization_id, actor.role, props.snapshots, props.accountId])} />;
}

function HistoryInspection({ organizationId, snapshots, onSelect, renderComparison, accountId }: Props) {
  const [history, setHistory] = useState<PipelineHistory | null>(null), [detail, setDetail] = useState<PipelineRun | null>(null);
  const [input, setInput] = useState(""), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), pending = useRef(false);
  const historyRef = useRef<PipelineHistory | null>(null), detailRef = useRef<PipelineRun | null>(null), inputRef = useRef("");
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; historyRef.current = null; detailRef.current = null;
      setHistory(null); setDetail(null); setError(null); setBusy(false); };
    const events = ["focus", "vitaai-source-changed", "vitaai-pipeline-history-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => events.forEach(name => window.removeEventListener(name, invalidate));
  }, []);

  async function inspect(summary?: PipelineRunSummary) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current || (summary && !historyRef.current?.items.includes(summary))) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && request === sequence.current;
    setBusy(true); setError(null); setDetail(null); detailRef.current = null;
    if (!summary) { historyRef.current = null; setHistory(null); }
    try {
      if (summary) {
        const value = await api<PipelineRun>(`pipeline/${summary.id}`, { signal });
        if (!active()) return;
        const saved = validateSavedPipelineRun(value, organizationId, summary.id, summary, accountId);
        detailRef.current = saved; setDetail(saved);
      } else {
        const value = await api<PipelineHistory>("pipeline/history", { signal });
        if (!active()) return;
        const saved = validatePipelineHistory(value, organizationId);
        historyRef.current = saved; setHistory(saved);
      }
    } catch { if (active()) setError("Saved pipeline history unavailable or changed. Inspect again after refreshing the workspace."); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }

  async function inspectId() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current || inputRef.current !== input || !savedRunId.test(input)) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && request === sequence.current && inputRef.current === input;
    setBusy(true); setError(null); setDetail(null); detailRef.current = null;
    try {
      const value = await api<PipelineRun>(`pipeline/${input}`, { signal });
      if (!active()) return;
      const saved = validateSavedPipelineRun(value, organizationId, input, undefined, accountId);
      detailRef.current = saved; setDetail(saved);
    } catch { if (active()) setError("Saved pipeline run unavailable or changed. Check the ID and inspect again."); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }

  const matching = history?.items.filter(item => accountId === undefined || item.input_account_ids.includes(accountId)) ?? [];
  return <section aria-label={accountId === undefined ? "Saved pipeline history" : "Account saved recommendation history"} style={{ overflowWrap: "anywhere" }}>
    <h3>{accountId === undefined ? "Saved pipeline history" : "Saved recommendations for this account"}</h3>
    <p>Historical preparation only. Inspection cannot generate recommendations, refresh facts, approve or execute work.</p>
    <button type="button" disabled={busy} onClick={() => inspect()}>Inspect saved pipeline history</button>
    <label>Saved pipeline run ID <input aria-label="Saved pipeline run ID" value={input} maxLength={36} onChange={event => {
      ++sequence.current; pending.current = false; inputRef.current = event.target.value; detailRef.current = null;
      setInput(event.target.value); setDetail(null); setError(null); setBusy(false);
    }} /></label>
    <button type="button" disabled={busy || !savedRunId.test(input)} onClick={inspectId}>Inspect saved run ID</button>
    {busy && <p role="status">Reading saved pipeline history...</p>}
    {error && <p role="alert">{error}</p>}
    {history && <div aria-live="polite">
      <p>Latest 20 dated runs in this organization, newest original start first; equal instants use descending ID, not causal order. Showing {history.items.length} readable runs from {history.window_count} inspected dated records, of {history.total_count} total retained runs.</p>
      <p>{history.undated_count} unorderable records without an aware original start; {history.unavailable_count} unreadable records in this window. No dates or missing history are reconstructed.</p>
      <p>{history.has_more ? "Older dated runs exist outside this window." : "No additional dated runs outside this window."} Inspect a known older ID separately. This is not a complete account, source or mission timeline.</p>
      {accountId !== undefined && <p>{matching.length} matching run(s) containing account {accountId} within this organization&apos;s dated window. This is not complete account history; unmatched, older, undated or unreadable runs do not establish account absence or resolution.</p>}
      {!history.total_count && <p>No saved pipeline runs. This does not establish an empty account history.</p>}
      <ol>{matching.map(item => <li key={item.id}>
        <p>{item.started_at} · assessment {item.as_of} · actor {item.actor_id ?? "Not recorded"} · {item.status} · {item.request.intent} / limit {item.request.limit} / {item.request.communication_mode} / model requested {String(item.request.communicate)}</p>
        {accountId === undefined ? <p>Input accounts: {item.input_account_ids.join(", ") || "None"}. Selected accounts: {item.selected_account_ids.join(", ") || "None"}.</p>
          : <p>Account retained in input · {item.selected_account_ids.includes(accountId) ? "Selected result" : "Outside selected result"}.</p>}
        <button type="button" disabled={busy} onClick={() => inspect(item)}>{`Inspect run ${item.id}`}</button>
      </li>)}</ol>
    </div>}
    {detail && <div aria-live="polite">
      <h4>Historical run {detail.id}</h4>
      <p>Started {detail.started_at} · assessment {detail.as_of} · actor {detail.actor_id ?? "Not recorded"} · {detail.status}.</p>
      <p>Request: {detail.request.intent} / limit {detail.request.limit} / {detail.request.communication_mode} / model requested {String(detail.request.communicate)}.</p>
      <p>{detail.caveats.join(" ")}</p>
      <ul>{detail.contexts.filter(context => accountId === undefined || context.account.id === accountId).map(context => { const item = detail.recommendations.find(value => value.account_id === context.account.id);
        return <li key={context.account.id}>
          <h4>{context.account.name} · revision {context.account.revision}</h4>
          <p>Annual value {context.account.annual_value ?? "Unknown"} · renewal {context.account.renewal_date ?? "Unknown"}.</p>
          {item ? <><p>Saved rank {item.rank} · {item.action.kind} · {item.governance.status} · communication {item.communication.status}</p>
            <p>{item.action.rationale}</p><p>{item.assessment.policy_version} · {item.assessment.as_of} · {item.assessment.snapshot_hash} · risk {item.assessment.risk} / opportunity {item.assessment.opportunity} / confidence {item.assessment.confidence}%</p></>
            : <p>Outside selected result; this is not account deletion, resolution or a missing input.</p>}
          <details><summary>Original account, evidence and recommendation</summary><pre>{JSON.stringify({ context, recommendation: item ?? null }, null, 2)}</pre></details>
          {accountId === undefined && snapshots[context.account.id] && onSelect && <button type="button" onClick={() => {
            if (lifetime.current?.signal.aborted || detailRef.current !== detail) return;
            onSelect(context.account.id);
          }}>Open current account</button>}
        </li>; })}</ul>
      {hasOrderedDate(detail) ? renderComparison(detail, matching) : <p>Original start is not orderable; no timezone or comparison chronology is inferred.</p>}
      <p className="caveat">These saved proposals grant no current preparation, approval, execution or business-outcome authority.</p>
    </div>}
  </section>;
}
