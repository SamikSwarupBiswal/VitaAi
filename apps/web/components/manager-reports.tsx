"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { Mission, Outcome } from "@/lib/workflow";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Review = components["schemas"]["CoachingReview"];

export function ManagerReports({ mission }: { mission: Mission }) {
  const actor = useSession()?.actor;
  if (!actor || actor.organization_id !== mission.organization_id || mission.status !== "completed") return null;
  return <ReportInspection key={`${actor.id}:${actor.organization_id}:${actor.role}:${mission.id}:${mission.revision}`} mission={mission} />;
}

function ReportInspection({ mission }: { mission: Mission }) {
  const [result, setResult] = useState<{ outcomes: Outcome[]; reviews: Review[] } | null>(null);
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
      const [outcomes, reviews] = await Promise.all([
        api<Outcome[]>(`missions/${mission.id}/outcomes`, { signal }),
        api<Review[]>(`missions/${mission.id}/coaching-reviews`, { signal }),
      ]);
      if (signal.aborted) return;
      const fresh = await api<Mission>(`missions/${mission.id}`, { signal });
      if (signal.aborted) return;
      if (fresh.id !== mission.id || fresh.organization_id !== mission.organization_id || fresh.account_id !== mission.account_id
        || fresh.owner_id !== mission.owner_id || fresh.revision !== mission.revision || fresh.status !== "completed"
        || !Array.isArray(outcomes) || !Array.isArray(reviews)
        || new Set(outcomes.map(item => item.id)).size !== outcomes.length || new Set(reviews.map(item => item.id)).size !== reviews.length
        || outcomes.some((item, index) => item.organization_id !== mission.organization_id || item.mission_id !== mission.id
          || item.revision !== index + 1 || (item.supersedes_id ?? null) !== (index ? outcomes[index - 1].id : null))
        || reviews.some((item, index) => item.organization_id !== mission.organization_id || item.mission_id !== mission.id
          || item.revision !== index + 1 || item.mission_revision > mission.revision
          || (item.supersedes_id ?? null) !== (index ? reviews[index - 1].id : null)
          || !outcomes.some(report => report.id === item.outcome_id && report.revision === item.outcome_revision))) {
        throw new Error("Report bindings changed");
      }
      setResult({ outcomes, reviews });
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
      </li>)}</ol>
      <p>Use the mission’s Outcome link for full records and separately authorized coaching review. No assignment or notification is made here.</p>
    </div>}
  </section>;
}
