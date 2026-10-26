"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type AccountView, type Portfolio } from "@/lib/api";
import { readDetections, type SourceDetection, type SourceField } from "@/lib/hubspot";
import { useSession } from "./session-gate";

type Row = { view: AccountView; latest: SourceDetection | null; error: boolean };
type Result = { generation: number; rows: Row[] };

export function ExecutiveChangeBrief({ portfolio, onSelect }: { portfolio: Portfolio; onSelect: (id: string) => void }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== portfolio.organization_id
    || portfolio.accounts.some(view => view.account.organization_id !== portfolio.organization_id)) {
    return <section><h3>Saved source change brief</h3><p>Session identity and a coherent portfolio in this organization are required to inspect saved changes.</p></section>;
  }
  return <ChangeInspection portfolio={portfolio} onSelect={onSelect} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    portfolio.organization_id, portfolio.as_of, portfolio.accounts.slice(0, 5).map(view => [view.account.id, view.account.revision,
      view.source?.id, view.assessment.snapshot_hash, view.assessment.as_of])])} />;
}

function ChangeInspection({ portfolio, onSelect }: { portfolio: Portfolio; onSelect: (id: string) => void }) {
  const [result, setResult] = useState<Result | null>(null), [busy, setBusy] = useState(false);
  const current = useRef<Result | null>(null), lifetime = useRef<AbortController | null>(null);
  const sequence = useRef(0), pending = useRef(false);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; current.current = null; pending.current = false; setResult(null); setBusy(false); };
    const events = ["focus", "vitaai-detections-changed", "vitaai-source-history-changed", "vitaai-source-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => events.forEach(name => window.removeEventListener(name, invalidate));
  }, []);

  async function inspect() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true; const generation = ++sequence.current;
    const active = () => !signal.aborted && generation === sequence.current;
    current.current = null; setResult(null); setBusy(true);
    const rows = await Promise.all(portfolio.accounts.slice(0, 5).map(async view => {
      try {
        const saved = await readDetections(view, signal);
        if (!active()) return { view, latest: null, error: true };
        const fresh = await api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal });
        if (fresh.account.id !== view.account.id || fresh.account.organization_id !== portfolio.organization_id
          || fresh.account.revision !== view.account.revision || fresh.source?.id !== view.source?.id
          || fresh.assessment.snapshot_hash !== view.assessment.snapshot_hash || fresh.assessment.as_of !== view.assessment.as_of
          || !Array.isArray(saved) || saved.length > 20 || new Set(saved.map(item => item.id)).size !== saved.length
          || new Set(saved.map(item => item.after.source_version_id)).size !== saved.length
          || new Set(saved.map(item => item.after.account_revision)).size !== saved.length
          || saved.some(item => item.account_id !== view.account.id || item.organization_id !== portfolio.organization_id
            || item.after.account_revision > view.account.revision
            || (item.after.account_revision === view.account.revision && item.after.source_version_id !== view.source?.id))) {
          throw new Error("Saved change binding changed");
        }
        return { view, latest: [...saved].sort((a, b) => b.after.account_revision - a.after.account_revision)[0] || null, error: false };
      } catch { return { view, latest: null, error: true }; }
    }));
    if (active()) { const value = { generation, rows }; current.current = value; setResult(value); pending.current = false; setBusy(false); }
  }
  function select(row: Row, generation: number) {
    if (lifetime.current?.signal.aborted || pending.current || generation !== current.current?.generation
      || row.error || !current.current?.rows.includes(row)) return;
    onSelect(row.view.account.id);
  }
  return <section aria-label="Executive saved source changes" style={{ overflowWrap: "anywhere" }}>
    <h3>Saved source change brief</h3>
    <p>Inspect the first {Math.min(5, portfolio.accounts.length)} of {portfolio.accounts.length} accounts in the displayed server order. Each account reads its latest 20 saved detections; this does not establish a complete portfolio history or a time range.</p>
    {!portfolio.accounts.length && <p>No accounts available for saved-change inspection.</p>}
    <button type="button" disabled={busy || !portfolio.accounts.length} onClick={inspect}>Inspect saved changes</button>
    {busy && <p role="status">Inspecting retained source results...</p>}
    {result && <div aria-live="polite"><ol>{result.rows.map(row => {
      const { view, latest } = row;
      return <li key={view.account.id}><h4>{view.account.name}</h4>
        {row.error ? <p>Saved history unavailable or account changed. Inspect the account after refreshing; no source state is inferred.</p>
          : <><button type="button" onClick={() => select(row, result.generation)}>Inspect {view.account.name}</button>
            {!latest ? <p>No saved detections. This does not establish unchanged facts or no customer activity.</p> : <>
              <p>Latest saved result: {latest.status.replaceAll("_", " ")} · {latest.reason.replaceAll("_", " ")} · detection {latest.id}.</p>
              <p>Selected {latest.after.selected_at} · detected {latest.detected_at}. Measurement dates are separate.</p>
              {latest.after.source_version_id !== view.source?.id && <p>History does not cover the displayed selection. Detection must be requested separately.</p>}
              <p>Before source {latest.before?.source_version_id || "none"} · revision {latest.before?.account_revision ?? "none"} · selected {latest.before?.selected_at || "Unknown"} · observation {latest.before?.observation_id || "none"}.</p>
              <p>After source {latest.after.source_version_id} · revision {latest.after.account_revision} · observation {latest.after.observation_id || "none"}.</p>
              {latest.status === "baseline" && <p>Baseline; no comparable earlier change is inferred.</p>}
              {latest.status === "source_reset" && <p>Synthetic source reset; original sample dates remain unchanged.</p>}
              {latest.status === "unchanged" && <p>Comparable saved values and availability were unchanged; customer activity is not inferred.</p>}
              {latest.event && <><p>Saved event {latest.event.id} · fingerprint {latest.event.fingerprint}.</p>
                <ul>{latest.event.changes.map(change => <li key={change.field}>{change.field.replaceAll("_", " ")} · {change.kind.replaceAll("_", " ")}
                  <p>Before: <FieldValue field={change.before} /></p><p>After: <FieldValue field={change.after} /></p>
                </li>)}</ul></>}
            </>}
          </>}
      </li>;
    })}</ol><p>Saved source differences do not establish cause, risk direction, revenue impact, current approval or a business outcome. Open the account for full source chronology and original evidence.</p></div>}
  </section>;
}

function FieldValue({ field }: { field: SourceField }) {
  return <span>{field.value === null ? "Unknown" : String(field.value)} · {field.status} · {field.unit}; measured {field.observed_at || "Unknown"}; evidence {field.evidence_id || "none"}</span>;
}
