"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { api } from "@/lib/api";
import { postWorkflow, type MissionData } from "@/lib/workflow";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Review = components["schemas"]["CoachingReview"];
type Request = components["schemas"]["CoachingRequest"];
const pending = new Set<string>();

export function CoachingPanel({ data, blocked, refresh }: {
  data: MissionData; blocked: boolean; refresh: (message?: string) => void;
}) {
  const actor = useSession()?.actor;
  const outcome = data.outcomes.at(-1);
  if (!actor || data.mission.status !== "completed" || !outcome) return null;
  return <CoachingReviewPanel key={`${actor.id}:${actor.organization_id}:${actor.role}:${data.mission.id}:${data.mission.revision}:${outcome.id}`}
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
  const lifetime = useRef<AbortController | null>(null);
  const started = useRef(false);
  const current = useRef({ blocked, history, error, note, status });
  useLayoutEffect(() => { current.current = { blocked, history, error, note, status }; }, [blocked, history, error, note, status]);
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
        || !outcomes.some(saved => saved.id === item.outcome_id && saved.revision === item.outcome_revision))) {
        throw new Error("Coaching history changed. Refresh current mission records.");
      }
      setHistory(records);
    }).catch(() => {
      if (!controller.signal.aborted) setError("Coaching history unavailable. Refresh current mission records before another review.");
    });
    return () => controller.abort();
  }, [mission.id, mission.organization_id, mission.revision, outcomes]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = current.current, signal = lifetime.current?.signal;
    if (!signal || signal.aborted || started.current || pending.has(lock) || value.blocked || value.error
      || !reviewer || !value.history || !value.note.trim() || value.note.length > 2000) return;
    started.current = true;
    pending.add(lock);
    setBusy(true);
    let message: string | undefined;
    try {
      const body: Request = { schema_version: "1", expected_revision: value.history.at(-1)?.revision ?? 0,
        expected_mission_revision: mission.revision, outcome_id: outcome.id,
        expected_outcome_revision: outcome.revision, status: value.status, note: value.note };
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
    <p>Coaching review does not approve customer actions, reopen this mission, assign work or notify its owner.</p>
    {!history && !error && <p role="status">Loading coaching history...</p>}
    {error && <p role="alert">{error}</p>}
    {history?.length === 0 && <p>No coaching review recorded.</p>}
    <ol>{history?.map(item => <li key={item.id}>
      <strong>Coaching revision {item.revision}: {item.status.replaceAll("_", " ")}</strong>
      <p>Reviewer {item.reviewer_id} · {item.created_at} · mission revision {item.mission_revision} · outcome {item.outcome_id} revision {item.outcome_revision}.</p>
      {item.outcome_id !== outcome.id && <p>Historical review of an earlier outcome report; the current report requires separate review.</p>}
      <pre>{item.note}</pre>
    </li>)}</ol>
    {!reviewer && <p>Only current administrators and reviewers may record coaching reviews.</p>}
    {reviewer && <form onSubmit={submit}>
      <fieldset disabled={blocked || busy || !!error || !history || pending.has(lock)}>
        <legend>{history?.length ? "Append coaching revision" : "Record coaching review"}</legend>
        <label>Coaching disposition<select aria-label="Coaching disposition" value={status} onChange={event => setStatus(event.target.value as Request["status"])}>
          <option value="reviewed">Reviewed</option><option value="revision_required">Revision required</option>
        </select></label>
        <label>Human coaching note<textarea aria-label="Human coaching note" required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label>
        <button disabled={!note.trim() || note.length > 2000} type="submit">Save coaching review</button>
      </fieldset>
    </form>}
  </section>;
}
