"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Portfolio } from "@/lib/api";
import type { Mission } from "@/lib/workflow";
import { coachingDisposition, readCoachingQueue, type CoachingQueueRow } from "@/lib/manager-reports";
import { useSession } from "./session-gate";

export function ManagerCoachingQueue({ portfolio, missions }: { portfolio: Portfolio; missions: Mission[] }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== portfolio.organization_id) return null;
  return <QueueInspection portfolio={portfolio} missions={missions} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    portfolio.as_of, portfolio.accounts.map(view => [view.account.id, view.account.revision, view.source?.id, view.assessment.snapshot_hash]),
    missions.map(mission => [mission.id, mission.account_id, mission.organization_id, mission.owner_id, mission.revision, mission.status])])} />;
}

function QueueInspection({ portfolio, missions }: { portfolio: Portfolio; missions: Mission[] }) {
  const [result, setResult] = useState<{ total: number; rows: CoachingQueueRow[] } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), pending = useRef(false), sequence = useRef(0);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; setResult(null); setBusy(false); setError(null); };
    const names = ["focus", "vitaai-workflow-changed", "vitaai-source-changed"];
    names.forEach(name => window.addEventListener(name, invalidate));
    return () => names.forEach(name => window.removeEventListener(name, invalidate));
  }, []);
  async function inspect() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && request === sequence.current;
    setResult(null); setBusy(true); setError(null);
    try { const value = await readCoachingQueue(portfolio, missions, signal); if (active()) setResult(value); }
    catch { if (active()) setError("Coaching queue unavailable or changed. Refresh mission attention and inspect again."); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  const labels = { no_report: "No retained outcome report", no_review: "Latest report has no coaching review",
    report_changed: "Latest report changed since coaching", reviewed: "Latest report reviewed", revision_required: "Coaching revision requested" };
  return <section aria-label="Manager coaching queue" style={{ overflowWrap: "anywhere" }}>
    <h3>Latest report coaching</h3>
    <p>Inspect the newest five completed missions in this saved portfolio list by server creation order. Creation order is not completion or last coaching activity order.</p>
    <button type="button" disabled={busy} onClick={inspect}>Inspect coaching queue</button>
    {busy && <p role="status">Reading saved coaching bindings...</p>}{error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite">
      <p>Inspected {result.rows.length} of {result.total} completed missions in current portfolio accounts; {result.total - result.rows.length} older missions excluded. {result.rows.filter(row => !row.data).length} inspected missions unavailable or changed.</p>
      <p>This is bounded saved-record coverage, not a complete team review queue. Owner IDs are recorded owners, not a verified seller directory or performance ranking.</p>
      {!result.total && <p>No completed missions in this saved portfolio list. No coaching or customer result is inferred.</p>}
      <ol>{result.rows.map(({ mission, data }) => {
        const view = portfolio.accounts.find(item => item.account.id === mission.account_id)!;
        const report = data?.outcomes.at(-1), review = data?.reviews.at(-1);
        return <li key={mission.id}>
          <h4>{view.account.name} · owner {mission.owner_id}</h4>
          <p>Mission {mission.id} · retained revision {mission.revision} · created {mission.created_at}.</p>
          {!data ? <p>Saved reports unavailable or changed. No review disposition inferred.</p> : <>
            <p>{labels[coachingDisposition(data)]}.</p>
            {report && <><p>Latest human report {report.id} revision {report.revision} · observed {report.observed_at} · {report.report.kind.replaceAll("_", " ")} · {report.report.basis.replaceAll("_", " ")}.</p>
              {report.supersedes_id && <p>Corrects report {report.supersedes_id}.</p>}</>}
            {review && <p>Latest coaching {review.id} revision {review.revision} · {review.status.replaceAll("_", " ")} · reviewer {review.reviewer_id} · recorded {review.created_at}. Bound to report {review.outcome_id} revision {review.outcome_revision} and mission revision {review.mission_revision}.</p>}
            {review?.intervention && <p>{review.outcome_id === report?.id ? "Planned internal coaching intervention" : "Historical internal coaching plan; report changed"} · recorded owner {review.intervention_owner_id}. Inspect Outcome for the retained plan; no notification or recipient acceptance is recorded.</p>}
          </>}
          <Link href={`/missions?${new URLSearchParams({ account: mission.account_id, mission: mission.id, step: "Outcome" })}`}>Inspect outcome and coaching for this mission</Link>
        </li>;
      })}</ol>
      <p>Human reports and coaching do not independently verify customer results. These read-only views never reopen missions, authorize customer actions or notify anyone. An internal coaching plan requires the separate exact reviewed Outcome controls. Use the exact Outcome link for full history and separately authorized review.</p>
    </div>}
  </section>;
}
