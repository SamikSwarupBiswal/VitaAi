"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Portfolio } from "@/lib/api";
import type { Mission } from "@/lib/workflow";
import { readOperationsReceipts, receiptDiagnosis, type ReceiptMission } from "@/lib/operations-receipts";
import { useSession } from "./session-gate";

export function OperationsReceipts({ portfolio, missions }: { portfolio: Portfolio; missions: Mission[] }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== portfolio.organization_id) return null;
  return <ReceiptInspection portfolio={portfolio} missions={missions} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    portfolio.as_of, portfolio.accounts.map(view => [view.account.id, view.account.organization_id, view.account.revision,
      view.source?.id, view.assessment.as_of, view.assessment.snapshot_hash]),
    missions.map(mission => [mission.id, mission.organization_id, mission.account_id, mission.owner_id, mission.revision,
      mission.content_revision, mission.status, mission.plan_id, mission.plan_revision])])} />;
}

function ReceiptInspection({ portfolio, missions }: { portfolio: Portfolio; missions: Mission[] }) {
  const [result, setResult] = useState<{ total: number; rows: ReceiptMission[]; readAt: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [invalidated, setInvalidated] = useState(false);
  const lifetime = useRef<AbortController | null>(null), pending = useRef(false), sequence = useRef(0), stale = useRef(false);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => {
      lifetime.current?.abort();
      stale.current = true; ++sequence.current; setResult(null); setBusy(false); setError(null); setInvalidated(true);
    };
    const names = ["focus", "vitaai-workflow-changed", "vitaai-source-changed"];
    names.forEach(name => window.addEventListener(name, invalidate));
    return () => names.forEach(name => window.removeEventListener(name, invalidate));
  }, []);
  async function inspect() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current || stale.current) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && !stale.current && request === sequence.current;
    setResult(null); setBusy(true); setError(null);
    try {
      const value = await readOperationsReceipts(portfolio, missions, signal);
      if (active()) setResult({ ...value, readAt: new Date().toISOString() });
    } catch { if (active()) setError("Receipt inspection unavailable or changed. Refresh mission attention and inspect again."); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  return <section aria-label="Operations receipt diagnostics" style={{ overflowWrap: "anywhere" }}>
    <h3>Saved execution and receipt diagnostics</h3>
    <p>Inspect the newest five saved missions in current portfolio accounts by server creation order, across all lifecycle states. Creation order is not last execution activity order.</p>
    <p>Local saved-record reads only. Inspection makes no provider request and cannot reconcile, retry, dispatch or change configuration.</p>
    <button type="button" disabled={busy || invalidated} onClick={inspect}>Inspect saved receipts</button>
    {busy && <p role="status">Reading saved execution and receipt bindings...</p>}
    {invalidated && <p role="status">Saved inspection cleared. Refresh mission attention to inspect current records.</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite">
      <p>Local read completed {result.readAt}. Inspected {result.rows.length} of {result.total} saved missions; {result.total - result.rows.length} older missions excluded. {result.rows.filter(row => row.actions === null).length} inspected missions unavailable or changed.</p>
      <p>{result.rows.flatMap(row => row.actions ?? []).length} actions in available missions; {result.rows.flatMap(row => row.actions ?? []).filter(row => row.unavailable).length} claim reads unavailable or changed; {result.rows.flatMap(row => row.actions ?? []).filter(row => row.receiptUnavailable).length} referenced receipt reads unavailable or mismatched.</p>
      <p>This is bounded collected coverage, not a complete queue or a transactional snapshot. Empty or verified records do not establish ongoing integration health, current action authorization or customer results.</p>
      {!result.total && <p>No saved missions in current portfolio accounts. No operational health inferred.</p>}
      <ol>{result.rows.map(({ mission, actions }) => {
        const view = portfolio.accounts.find(item => item.account.id === mission.account_id)!;
        const historical = mission.evidence.account_revision !== view.account.revision
          || mission.evidence.snapshot_hash !== view.assessment.snapshot_hash || mission.evidence.as_of !== view.assessment.as_of;
        return <li key={mission.id}>
          <h4>{view.account.name}</h4>
          <p>Mission {mission.id} · revision {mission.revision} · {mission.status.replaceAll("_", " ")} · created {mission.created_at}.</p>
          <p>{historical ? "Historical evidence binding; saved receipts grant no renewed authority." : "Matches displayed evidence snapshot; authorization must still be checked separately."}</p>
          {actions === null ? <p>Saved mission or action list unavailable or changed. No execution result inferred.</p>
            : !actions.length ? <p>No saved actions in this mission. No receipt or completion inferred.</p>
              : <ul>{actions.map(row => <li key={row.action.id}>
                <p>Action {row.action.id} · revision {row.action.revision} · {row.action.mode} · {row.action.destination.provider}.</p>
                <p>{receiptDiagnosis(row)}</p>
                {row.execution && <>
                  <p>Execution {row.execution.id} · revision {row.execution.revision} · attempt {row.execution.attempt} · {row.execution.status.replaceAll("_", " ")}.</p>
                  <p>Claimed {row.execution.claimed_at} · dispatched {row.execution.dispatched_at ?? "Not recorded"} · finished {row.execution.finished_at ?? "Not recorded"}.</p>
                  {row.receiptUnavailable ? <p>Referenced receipt {row.execution.receipt_id} unavailable or mismatched; retained execution status is separate.</p>
                    : !row.receipt && <p>No receipt reference recorded for this execution.</p>}
                </>}
                {row.receipt && <>
                  <p>Receipt {row.receipt.id} · {row.receipt.mode} · result {row.receipt.result.replaceAll("_", " ")} · verification {row.receipt.verification.replaceAll("_", " ")} · recorded {row.receipt.recorded_at}.</p>
                  <p>Provider resource {row.receipt.provider_resource_id ?? "Unknown"} · readback {row.receipt.readback_at ?? "Not recorded"} · readback hash {row.receipt.readback_hash ?? "Not recorded"}.</p>
                  {row.receipt.error_code && <p>Saved error code: {row.receipt.error_code}.</p>}
                </>}
              </li>)}</ul>}
          <Link href={`/missions?${new URLSearchParams({ account: mission.account_id, mission: mission.id, step: "Execution" })}`}>Inspect Execution for this mission</Link>
        </li>;
      })}</ol>
      <p>Use the exact mission link for full history and separately authorized recovery. Unknown results must not be repeated. Provider creation/readback and manually reported business outcomes remain separate.</p>
    </div>}
  </section>;
}
