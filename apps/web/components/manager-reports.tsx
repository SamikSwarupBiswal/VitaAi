"use client";

import { useEffect, useRef, useState } from "react";
import { readManagerReports, type ReportData } from "@/lib/manager-reports";
import type { Mission } from "@/lib/workflow";
import { useSession } from "./session-gate";

export function ManagerReports({ mission }: { mission: Mission }) {
  const actor = useSession()?.actor;
  if (!actor || actor.organization_id !== mission.organization_id || mission.status !== "completed") return null;
  return <ReportInspection key={`${actor.id}:${actor.organization_id}:${actor.role}:${mission.id}:${mission.revision}`} mission={mission} />;
}

function ReportInspection({ mission }: { mission: Mission }) {
  const [result, setResult] = useState<ReportData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const started = useRef(false);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function inspect() {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || started.current) return;
    started.current = true; setBusy(true); setError(null); setResult(null);
    try {
      const value = await readManagerReports(mission, signal);
      if (!signal.aborted) setResult(value);
    } catch {
      if (!signal.aborted) setError("Saved reports unavailable or changed. Refresh mission attention before inspecting again.");
    } finally {
      if (!signal.aborted) { started.current = false; setBusy(false); }
    }
  }
  const latest = result?.outcomes.at(-1);
  return <section aria-label={`Saved reports for mission ${mission.id}`}>
    <button type="button" disabled={busy} onClick={inspect}>{busy ? "Inspecting saved reports..." : "Inspect saved outcome and coaching"}</button>
    {busy && <p role="status">Loading retained reports for this completed mission...</p>}
    {error && <p role="alert">{error}</p>}
    {result && <div aria-live="polite">
      <p>Human reports and coaching are not independently verified customer results or customer-action approval.</p>
      {latest ? <p>Latest report revision {latest.revision} · {latest.id}.</p> : <p>No retained outcome reports. Completed status alone does not establish a customer result.</p>}
      <ol>{result.outcomes.map(report => <li key={report.id}>
        <p>Report revision {report.revision} · {report.report.kind.replaceAll("_", " ")} · {report.report.basis.replaceAll("_", " ")}.</p>
        <p>Observer {report.observer_id} · observed {report.observed_at} · report {report.id}{report.supersedes_id && ` · corrects ${report.supersedes_id}`}.</p>
        <p>{report.report.receipt_id ? `Receipt reference ${report.report.receipt_id}; inspect Outcome for verification and mode.`
          : `Manual action reference ${report.report.manual_action_reference}`}</p>
        <p>Original evidence: {report.report.evidence_ids.join(", ")}</p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{report.report.note}</pre>
      </li>)}</ol>
      <h5>Retained coaching reviews</h5>
      {!result.reviews.length && <p>No coaching reviews recorded.</p>}
      {latest && !result.reviews.some(review => review.outcome_id === latest.id && review.outcome_revision === latest.revision)
        && <p>No coaching review of the latest report in this inspection.</p>}
      <ol>{result.reviews.map(review => <li key={review.id}>
        <p>Coaching revision {review.revision} · {review.status.replaceAll("_", " ")} · reviewer {review.reviewer_id} · {review.created_at}.</p>
        <p>Mission revision {review.mission_revision} · outcome {review.outcome_id} revision {review.outcome_revision}.</p>
        {review.outcome_id !== latest?.id && <p>Historical coaching for an earlier report; it does not review the latest correction.</p>}
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{review.note}</pre>
        {review.intervention && <section aria-label={`Internal coaching plan revision ${review.revision}`}>
          <p>{review.outcome_id === latest?.id && review.id === result.reviews.at(-1)?.id ? "Planned internal coaching intervention" : "Historical internal coaching plan"} · recorded owner {review.intervention_owner_id}.</p>
          {([["focus", "Coaching focus"], ["discussion", "Discussion questions"], ["practice", "Planned practice"], ["follow_up", "Internal follow-up"]] as const)
            .map(([key, label]) => <div key={key}><strong>{label}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{review.intervention![key]}</pre></div>)}
          <p>Internal planning only; no notification, recipient acceptance or coaching effectiveness is established.</p>
        </section>}
      </li>)}</ol>
      <p>Use the mission’s Outcome link for full records and separately authorized coaching review. No assignment or notification is made here.</p>
    </div>}
  </section>;
}
