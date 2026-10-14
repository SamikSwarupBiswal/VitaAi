"use client";

import { useEffect, useRef, useState } from "react";
import { api, type PipelineRequest, type PipelineRun } from "@/lib/api";

export function PipelinePanel({ onSelect, organizationId, configured, expanded = false }: {
  onSelect: (id: string) => void; organizationId: string; configured: boolean; expanded?: boolean;
}) {
  const [intent, setIntent] = useState<PipelineRequest["intent"]>("attention");
  const [run, setRun] = useState<PipelineRun | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [useModel, setUseModel] = useState(false);
  const requestSequence = useRef(0);
  const storageKey = `vitaai-pipeline:${organizationId}`;
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
    {run && <div aria-live="polite"><p>{run.steps.map(step => `${step.role} (${step.processed})`).join(" → ")}</p>
      <details className="preparation-provenance"><summary>Preparation provenance</summary><p>{run.id} / {run.started_at} / {run.status}</p></details>
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
      </li>)}</ol><p>{run.caveats.join(" ")}</p></div>}
  </details>;
}
