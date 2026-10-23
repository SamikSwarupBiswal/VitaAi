"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type PipelineRequest, type PipelineRun } from "@/lib/api";
import { comparePipelineRuns } from "@/lib/pipeline-delta";

export function PipelinePanel({ onSelect, organizationId, snapshots, configured, expanded = false }: {
  onSelect: (id: string) => void; organizationId: string; snapshots: Record<string, string>; configured: boolean; expanded?: boolean;
}) {
  const [intent, setIntent] = useState<PipelineRequest["intent"]>("attention");
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useModel, setUseModel] = useState(false);
  const requestSequence = useRef(0);
  const storageKey = `vitaai-pipeline:${organizationId}`;
  const stale = run && (run.recommendations.some(item => snapshots[item.account_id] !== item.assessment.snapshot_hash)
    || Object.entries(run.portfolio_specialists?.input_snapshots ?? {}).some(([id, hash]) => snapshots[id] !== hash));
  useEffect(() => {
    let active = true;
    const sequence = ++requestSequence.current;
    let id: string | null = null;
    try { id = localStorage.getItem(storageKey); } catch { /* Storage is optional. */ }
    if (id) api<PipelineRun>(`pipeline/${encodeURIComponent(id)}`)
      .then(saved => { if (active && sequence === requestSequence.current) setRun(saved); })
      .catch(() => { if (active && sequence === requestSequence.current) setError("Saved preparation unavailable. Prepare a new run."); });
    return () => { active = false; };
  }, [storageKey]);
  async function start() {
    ++requestSequence.current;
    setBusy(true);
    setError(null);
    setRun(null);
    try {
      const prepared = await api<PipelineRun>("pipeline", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intent, limit: useModel ? 1 : 3, communicate: useModel, communication_mode: "drafts" }) });
      setRun(prepared);
      try { localStorage.setItem(storageKey, prepared.id); } catch { /* The API still retains the run. */ }
    } catch (error) { setError(error instanceof Error ? error.message : "Pipeline failed."); }
    finally { setBusy(false); }
  }
  return <details className="pipeline-panel" open={expanded || undefined}><summary>Intelligence pipeline</summary>
    <p>Six roles prepare recommendations and drafts from the current evidence. Templates by default; drafts require human review. No external actions.</p>
    <label>Focus <select aria-label="Pipeline focus" value={intent} onChange={event => setIntent(event.target.value as PipelineRequest["intent"])}>
      <option value="attention">Attention</option><option value="risk">Risk</option><option value="growth">Growth</option>
      <option value="renewal">Renewal</option><option value="manual_review">Manual review</option><option value="monitor">Monitor</option>
    </select></label> <label><input type="checkbox" checked={useModel} disabled={busy || !configured} onChange={event => setUseModel(event.target.checked)} /> Use Nebius for one account (paid inference)</label>
    <button onClick={start} disabled={busy}>{busy ? "Preparing..." : "Prepare recommendations"}</button>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {stale && <p role="status" className="caveat">Saved preparation belongs to an older account snapshot. Prepare a new run to view current drafts.</p>}
    {run && !stale && <div aria-live="polite"><p>{run.steps.map(step => `${step.role} (${step.processed})`).join(" → ")}</p>
      <details className="preparation-provenance"><summary>Preparation provenance</summary><p>{run.id} / {run.started_at} / {run.status}</p></details>
      {run.portfolio_specialists && <details><summary>Portfolio specialist highlights</summary>
        <p>{run.portfolio_specialists.account_count} retained input accounts · {run.portfolio_specialists.policy_version}. Recommendation order is unchanged.</p>
        {([ ["Highest baseline risk", run.portfolio_specialists.highest_risk],
          ["Highest baseline opportunity", run.portfolio_specialists.highest_opportunity] ] as const).map(([label, highlight]) => <div key={label}>
          <p>{label}: {highlight ? <><button onClick={() => onSelect(highlight.account_id)}>{run.contexts.find(c => c.account.id === highlight.account_id)?.account.name ?? highlight.account_id}</button>
            {" "}{highlight.score}/100 · revision {highlight.account_revision} · {highlight.snapshot_hash}<br />Evidence: {highlight.evidence_ids.join(", ") || "None; missing data does not establish safety or opportunity"}</> : "No input accounts"}</p>
        </div>)}
        <p className="caveat">{run.portfolio_specialists.caveats.join(" ")}</p>
      </details>}
      <ol>{run.recommendations.map(item => <li key={item.account_id}>
        <button onClick={() => onSelect(item.account_id)}>{run.contexts.find(c => c.account.id === item.account_id)?.account.name}</button>
        <p>{item.action.kind.replaceAll("_", " ")} · {item.governance.status.replaceAll("_", " ")}</p>
        <p>{item.communication.status.replaceAll("_", " ")}</p>
        {item.communication.drafts ? <dl>{([
          ["Email", item.communication.drafts.email], ["Call script", item.communication.drafts.call_script],
          ["Voice summary", item.communication.drafts.voice_summary], ["Internal note", item.communication.drafts.internal_note],
        ] as const).map(([label, draft]) => draft && <div key={label}><dt>{label}</dt><dd>{draft.text}<br />Evidence: {draft.evidence_ids.join(", ")}</dd></div>)}</dl> : <p>{item.communication.internal_note}</p>}
        {item.communication.model_run && <p>{item.communication.model_run.provider} / {item.communication.model_run.model} / {item.communication.model_run.validation}
          {item.communication.model_run.error_code && ` / ${item.communication.model_run.error_code}`}</p>}
        {item.communication.drafts && <p className="caveat">{item.communication.drafts.caveats.join(" ")}</p>}
        {item.specialists ? <details><summary>Specialist findings</summary>
          <p>{item.specialists.policy_version} · account revision {item.specialists.account_revision} · assessment {item.specialists.as_of} · {item.specialists.snapshot_hash}</p>
          <p className="caveat">{item.specialists.caveats.join(" ")}</p>
          {item.specialists.perspectives.map(perspective => <section key={perspective.role} aria-label={`${perspective.role} specialist`}>
            <h3>{perspective.role} · {perspective.status.replaceAll("_", " ")}</h3>
            {(perspective.missing_sources?.length ?? 0) > 0 && <p>Missing sources: {perspective.missing_sources?.join(", ").replaceAll("_", " ")}</p>}
            {perspective.model_run_id && <p>Retained communication run: {perspective.model_run_id}; no additional inference.</p>}
            <ul>{perspective.findings.map((finding, index) => <li key={index}>{finding.text}<br />Evidence: {finding.evidence_ids.join(", ") || "None for this limitation"}</li>)}</ul>
          </section>)}
          <h3>Disagreement and competing signals</h3>
          {item.specialists.disagreements.length ? <ul>{item.specialists.disagreements.map((finding, index) => <li key={index}>
            {finding.kind.replaceAll("_", " ")} · {finding.roles.join(", ")}: {finding.text}<br />Evidence: {finding.evidence_ids.join(", ")}
          </li>)}</ul> : <p>No conflict detected by these bounded rules. This does not certify agreement or factual truth.</p>}
          <details><summary>Retained source observations</summary>
            {run.contexts.find(c => c.account.id === item.account_id)?.evidence.map(fact => <p key={fact.id}>
              {fact.id} · {fact.metric}: {fact.value} · {fact.fact}<br />{fact.source} / {fact.source_record} · observed {fact.observed_at} · ingested {fact.ingested_at} · {fact.synthetic ? "Synthetic" : "Selected source observation"}
            </p>)}
          </details>
        </details> : <p>Specialist findings were not recorded in this saved run.</p>}
      </li>)}</ol><p>{run.caveats.join(" ")}</p>
      <SavedRunComparison key={run.id} current={run} />
    </div>}
  </details>;
}

const savedRunId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

export function SavedRunComparison({ current }: { current: PipelineRun }) {
  const [baselineId, setBaselineId] = useState("");
  const [result, setResult] = useState<ReturnType<typeof comparePipelineRuns> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = useRef({ mounted: false, input: "", busy: false, sequence: 0 });
  const controller = useRef<AbortController | null>(null);
  const currentRef = useRef<PipelineRun | null>(current);
  useLayoutEffect(() => { currentRef.current = current; return () => { currentRef.current = null; controller.current?.abort(); }; }, [current]);
  useEffect(() => { const binding = active.current; binding.mounted = true;
    return () => { binding.mounted = false; controller.current?.abort(); }; }, []);
  async function inspect() {
    const binding = active.current;
    if (!binding.mounted || binding.busy || binding.input !== baselineId || currentRef.current !== current
      || !savedRunId.test(baselineId) || baselineId === current.id) return;
    const sequence = ++binding.sequence;
    binding.busy = true; setBusy(true); setError(null); setResult(null);
    const request = new AbortController(); controller.current = request;
    const matches = () => binding.mounted && !request.signal.aborted && binding.sequence === sequence
      && binding.input === baselineId && currentRef.current === current;
    try {
      const baseline = await api<PipelineRun>(`pipeline/${encodeURIComponent(baselineId)}`, { signal: request.signal });
      if (!matches()) return;
      if (baseline.id !== baselineId) throw new Error("Saved baseline identity does not match the requested run.");
      setResult(comparePipelineRuns(baseline, current));
    } catch (failure) {
      if (matches()) setError(failure instanceof Error ? failure.message : "Saved baseline unavailable.");
    } finally { if (matches()) { binding.busy = false; setBusy(false); } }
  }
  return <details><summary>Compare saved recommendations</summary>
    <p>Displayed run {current.id} · {current.started_at}. Enter an older saved pipeline run ID. Inspection reads history only.</p>
    <label>Baseline run ID <input aria-label="Baseline pipeline run ID" value={baselineId} maxLength={36} onChange={event => {
      active.current.input = event.target.value; active.current.sequence++; active.current.busy = false;
      controller.current?.abort(); setBaselineId(event.target.value); setBusy(false); setResult(null); setError(null);
    }} /></label>
    <button onClick={inspect} disabled={busy || !savedRunId.test(baselineId) || baselineId === current.id}>{busy ? "Inspecting baseline..." : "Compare saved baseline"}</button>
    {error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite"><p>Baseline {result.beforeId} · {result.beforeAt} · assessment {result.beforeAsOf}<br />Displayed {result.afterId} · {result.afterAt} · assessment {result.afterAsOf}</p>
      {result.caveats.map(text => <p className="caveat" key={text}>{text}</p>)}
      {!result.rows.length && <p>Both selected results are empty. No recommendation changes can be established.</p>}
      <ul>{result.rows.map(row => <li key={row.accountId}>
        <h3>{row.afterContext?.account.name ?? row.beforeContext?.account.name ?? row.accountId} · {row.kind.replaceAll("_", " ")}</h3>
        {row.caveats.map(text => <p className="caveat" key={text}>{text}</p>)}
        {([ ["Baseline", row.before, row.beforeContext], ["Displayed", row.after, row.afterContext] ] as const).map(([label, recommendation, context]) => <div key={label}>
          <p>{label}: {recommendation ? <>rank {recommendation.rank} · {recommendation.action.kind.replaceAll("_", " ")} · risk {recommendation.assessment.risk} / opportunity {recommendation.assessment.opportunity} / confidence {recommendation.assessment.confidence}%</> : context ? "Outside selected result" : "Outside retained input"}</p>
          {context && <p>Account revision {context.account.revision} · annual value {context.account.annual_value ?? "Unknown"} · renewal {context.account.renewal_date ?? "Unknown"}</p>}
          {recommendation && <p>{recommendation.assessment.policy_version} · {recommendation.assessment.as_of} · {recommendation.assessment.snapshot_hash}<br />{recommendation.assessment.caveats.join(" ")}</p>}
          <details><summary>{label} retained evidence and factors</summary><pre>{JSON.stringify({ account: context?.account ?? null, evidence: context?.evidence ?? [], factors: recommendation?.assessment.factors ?? null }, null, 2)}</pre></details>
        </div>)}
      </li>)}</ul>
    </div>}
  </details>;
}
