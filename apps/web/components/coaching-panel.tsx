"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { postWorkflow, type MissionData } from "@/lib/workflow";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Review = components["schemas"]["CoachingReview"];
type Request = components["schemas"]["CoachingRequest"];
type Plan = components["schemas"]["CoachingPlan"];
const pending = new Set<string>();
const sections = [["focus", "Coaching focus"], ["discussion", "Discussion questions"],
  ["practice", "Planned practice"], ["follow_up", "Internal follow-up"]] as const;

export function coachingGuidance(data: MissionData): Plan {
  const outcome = data.outcomes.at(-1)!;
  return { schema_version: "1",
    focus: `Discuss the saved ${outcome.report.kind.replaceAll("_", " ")} report for mission ${data.mission.id}.`,
    discussion: `Ask which observations support report ${outcome.id} revision ${outcome.revision}, and which statements remain unverified human observations.`,
    practice: "Rehearse explaining the cited evidence and open questions without predicting a customer response or attributing performance to the owner.",
    follow_up: "Agree on an internal evidence review. Record any new business observation separately; this plan does not authorize customer activity." };
}

export function CoachingPlanRecord({ review, currentOutcomeId, latestReviewId }: { review: Review; currentOutcomeId?: string; latestReviewId?: string }) {
  if (!review.intervention) return null;
  return <section aria-label={`Internal coaching plan revision ${review.revision}`}>
    <p>{review.outcome_id === currentOutcomeId && review.id === latestReviewId ? "Planned internal coaching intervention" : "Historical internal coaching plan"} · recorded owner {review.intervention_owner_id}.</p>
    {sections.map(([key, label]) => <div key={key}><strong>{label}</strong><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit" }}>{review.intervention![key]}</pre></div>)}
    <p>Recorded planning only; no notification, recipient acceptance or coaching effectiveness is established.</p>
  </section>;
}

function validPlan(review: Review, owner: string) {
  return review.intervention == null ? review.intervention_owner_id == null
    : review.status === "reviewed" && review.intervention_owner_id === owner
      && sections.every(([key]) => typeof review.intervention?.[key] === "string" && !!review.intervention[key].trim()
        && review.intervention[key].length <= 2000 && !review.intervention[key].includes("\0"));
}

export function CoachingPanel({ data, blocked, refresh }: {
  data: MissionData; blocked: boolean; refresh: (message?: string) => void;
}) {
  const actor = useSession()?.actor;
  const outcome = data.outcomes.at(-1);
  if (!actor || data.mission.status !== "completed" || !outcome) return null;
  return <CoachingReviewPanel key={`${actor.id}:${actor.organization_id}:${actor.role}:${data.mission.id}:${data.mission.owner_id}:${data.mission.revision}:${outcome.id}`}
    data={data} blocked={blocked} refresh={refresh} />;
}

function CoachingReviewPanel({ data, blocked, refresh }: {
  data: MissionData; blocked: boolean; refresh: (message?: string) => void;
}) {
  const { mission, outcomes } = data;
  const outcome = outcomes.at(-1)!;
  const actor = useSession()!.actor!;
  const [history, setHistory] = useState<Review[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [status, setStatus] = useState<Request["status"]>("reviewed");
  const [busy, setBusy] = useState(false);
  const [includePlan, setIncludePlan] = useState(false);
  const [plan, setPlan] = useState<Plan>(coachingGuidance(data));
  const lifetime = useRef<AbortController | null>(null);
  const started = useRef(false);
  const current = useRef({ blocked, history, error, note, status, includePlan, plan });
  useLayoutEffect(() => { current.current = { blocked, history, error, note, status, includePlan, plan }; }, [blocked, history, error, note, status, includePlan, plan]);
  const lock = `${mission.organization_id}:${mission.id}`;
  const reviewer = actor.role === "admin" || actor.role === "reviewer";
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    api<Review[]>(`missions/${mission.id}/coaching-reviews`, { signal: controller.signal }).then(records => {
      if (controller.signal.aborted) return;
      if (!Array.isArray(records) || records.some((item, index) => item.organization_id !== mission.organization_id
        || item.mission_id !== mission.id || item.revision !== index + 1 || item.mission_revision > mission.revision
        || (item.supersedes_id ?? null) !== (index ? records[index - 1].id : null)
        || !validPlan(item, mission.owner_id)
        || !outcomes.some(saved => saved.id === item.outcome_id && saved.revision === item.outcome_revision))) {
        throw new Error("Coaching history changed. Refresh current mission records.");
      }
      setHistory(records);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Coaching history unavailable. Refresh current mission records before another review.");
    });
    return () => controller.abort();
  }, [mission.id, mission.organization_id, mission.owner_id, mission.revision, outcomes]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = current.current, signal = lifetime.current?.signal;
    if (!signal || signal.aborted || started.current || pending.has(lock) || value.blocked || value.error
      || !reviewer || !value.history || !value.note.trim() || value.note.length > 2000
      || (value.includePlan && (value.status !== "reviewed" || sections.some(([key]) => !value.plan[key].trim()
        || value.plan[key].length > 2000 || value.plan[key].includes("\0"))))) return;
    started.current = true;
    pending.add(lock);
    setBusy(true);
    let message: string | undefined;
    try {
      const body: Request = { schema_version: "1", expected_revision: value.history.at(-1)?.revision ?? 0,
        expected_mission_revision: mission.revision, outcome_id: outcome.id,
        expected_outcome_revision: outcome.revision, status: value.status, note: value.note };
      if (value.includePlan) body.intervention = value.plan;
      await postWorkflow(`missions/${mission.id}/coaching-reviews`, body, signal);
    } catch {
      message = "Coaching response unavailable. It may have saved; refresh history before another review.";
    } finally {
      pending.delete(lock);
      if (!signal.aborted) refresh(message);
      else window.dispatchEvent(new Event("vitaai-workflow-changed"));
    }
  }

  return <section aria-label="Manager coaching review">
    <h3>Manager coaching review</h3>
    <p>Human notes on mission revision {mission.revision} and outcome report {outcome.revision} ({outcome.id}).
      These reports are human observations, not independently verified customer results.</p>
    <p>Coaching review does not approve customer actions or reopen this mission. An optional internal plan records intended discussion for the saved owner; it sends no notification.</p>
    <details><summary>Discussion guidance for this saved report</summary>
      <p>Mission {mission.id} · recorded owner {mission.owner_id} · report {outcome.id} revision {outcome.revision}, observed {outcome.observed_at} · {outcome.report.basis.replaceAll("_", " ")}.</p>
      <p>These are discussion proposals derived from the saved report, not a seller performance assessment, customer prediction or verified business result.</p>
      {sections.map(([key, label]) => <p key={key}><strong>{label}: </strong>{coachingGuidance(data)[key]}</p>)}
      <p>Report evidence references: {outcome.report.evidence_ids.join(", ") || "None recorded; resolve the source gap before relying on this report."}</p>
      <p>The report and mission retain their original evidence/date binding; current account facts cannot renew historical claims.</p>
    </details>
    {!history && !error && <p role="status">Loading coaching history...</p>}
    {error && <p role="alert">{error}</p>}
    {history?.length === 0 && <p>No coaching review recorded.</p>}
    <ol>{history?.map(item => <li key={item.id}>
      <strong>Coaching revision {item.revision}: {item.status.replaceAll("_", " ")}</strong>
      <p>Reviewer {item.reviewer_id} · {item.created_at} · mission revision {item.mission_revision} · outcome {item.outcome_id} revision {item.outcome_revision}.</p>
      {item.outcome_id !== outcome.id && <p>Historical review of an earlier outcome report; the current report requires separate review.</p>}
      <pre>{item.note}</pre>
      <CoachingPlanRecord review={item} currentOutcomeId={outcome.id} latestReviewId={history?.at(-1)?.id} />
    </li>)}</ol>
    {!reviewer && <p>Only current administrators and reviewers may record coaching reviews.</p>}
    {reviewer && <form onSubmit={submit}>
      <fieldset disabled={blocked || busy || !!error || !history || pending.has(lock)}>
        <legend>{history?.length ? "Append coaching revision" : "Record coaching review"}</legend>
        <label>Coaching disposition<select aria-label="Coaching disposition" value={status} onChange={event => setStatus(event.target.value as Request["status"])}>
          <option value="reviewed">Reviewed</option><option value="revision_required">Revision required</option>
        </select></label>
        <label>Human coaching note<textarea aria-label="Human coaching note" required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label>
        <label><input type="checkbox" checked={includePlan} onChange={event => setIncludePlan(event.target.checked)} />Record an internal coaching plan for owner {mission.owner_id}</label>
        {includePlan && <>
          <p>This saves a planned internal intervention with this reviewed report. It neither notifies the owner nor records their acceptance.</p>
          {status !== "reviewed" && <p role="status">Choose Reviewed before recording an internal coaching plan.</p>}
          {sections.map(([key, label]) => <label key={key}>{label}<textarea aria-label={label} required maxLength={2000} value={plan[key]}
            onChange={event => setPlan({ ...plan, [key]: event.target.value })} /></label>)}
        </>}
        <button disabled={!note.trim() || note.length > 2000} type="submit">Save coaching review</button>
      </fieldset>
    </form>}
  </section>;
}
