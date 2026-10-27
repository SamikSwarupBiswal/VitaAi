import { api, type Portfolio } from "./api";
import type { Mission, Outcome } from "./workflow";
import type { components } from "./api.generated";

type Review = components["schemas"]["CoachingReview"];
export type ReportData = { outcomes: Outcome[]; reviews: Review[] };
export function sameMission(mission: Mission, fresh: Mission) {
  return fresh.id === mission.id && fresh.organization_id === mission.organization_id && fresh.account_id === mission.account_id
    && fresh.owner_id === mission.owner_id && fresh.revision === mission.revision && fresh.status === mission.status;
}
export function validateManagerReports(outcomes: Outcome[], reviews: Review[], mission: Mission, fresh: Mission): ReportData {
  if (fresh.id !== mission.id || fresh.organization_id !== mission.organization_id || fresh.account_id !== mission.account_id
        || fresh.owner_id !== mission.owner_id || fresh.revision !== mission.revision || fresh.status !== "completed"
        || !Array.isArray(outcomes) || !Array.isArray(reviews)
        || new Set(outcomes.map(item => item.id)).size !== outcomes.length || new Set(reviews.map(item => item.id)).size !== reviews.length
        || outcomes.some((item, index) => item.organization_id !== mission.organization_id || item.mission_id !== mission.id
          || item.revision !== index + 1 || (item.supersedes_id ?? null) !== (index ? outcomes[index - 1].id : null))
        || reviews.some((item, index) => item.organization_id !== mission.organization_id || item.mission_id !== mission.id
          || item.revision !== index + 1 || item.mission_revision > mission.revision
          || (item.supersedes_id ?? null) !== (index ? reviews[index - 1].id : null)
          || (item.intervention == null ? item.intervention_owner_id != null
            : item.status !== "reviewed" || item.intervention_owner_id !== mission.owner_id
              || [item.intervention.focus, item.intervention.discussion, item.intervention.practice, item.intervention.follow_up]
                .some(text => typeof text !== "string" || !text.trim() || text.length > 2000 || text.includes("\0")))
          || !outcomes.some(report => report.id === item.outcome_id && report.revision === item.outcome_revision))) {
        throw new Error("Report bindings changed");
      }
  return { outcomes, reviews };
}

export async function readManagerReports(mission: Mission, signal: AbortSignal): Promise<ReportData> {
  const id = encodeURIComponent(mission.id);
  const [outcomes, reviews] = await Promise.all([
    api<Outcome[]>(`missions/${id}/outcomes`, { signal }), api<Review[]>(`missions/${id}/coaching-reviews`, { signal }),
  ]);
  if (signal.aborted) throw new Error("Inspection ended");
  const fresh = await api<Mission>(`missions/${id}`, { signal });
  if (signal.aborted) throw new Error("Inspection ended");
  return validateManagerReports(outcomes, reviews, mission, fresh);
}

export function coachingDisposition(data: ReportData) {
  const report = data.outcomes.at(-1), review = data.reviews.at(-1);
  if (!report) return "no_report";
  if (!review) return "no_review";
  if (review.outcome_id !== report.id || review.outcome_revision !== report.revision) return "report_changed";
  return review.status;
}

export type CoachingQueueRow = { mission: Mission; data: ReportData | null };
export async function readCoachingQueue(portfolio: Portfolio, missions: Mission[], signal: AbortSignal) {
  if (!Array.isArray(missions) || new Set(missions.map(item => item.id)).size !== missions.length
    || missions.some(item => item.organization_id !== portfolio.organization_id)) throw new Error("Mission list changed");
  const eligible = missions.filter(item => item.status === "completed" && portfolio.accounts.some(view =>
    view.account.id === item.account_id && view.account.organization_id === item.organization_id));
  const rows: CoachingQueueRow[] = await Promise.all(eligible.slice(0, 5).map(async mission => {
    try { return { mission, data: await readManagerReports(mission, signal) }; }
    catch { return { mission, data: null }; }
  }));
  await Promise.all(rows.map(async row => {
    if (!row.data) return;
    try {
      const fresh = await api<Mission>(`missions/${encodeURIComponent(row.mission.id)}`, { signal });
      if (!sameMission(row.mission, fresh)) row.data = null;
    } catch { row.data = null; }
  }));
  if (signal.aborted) throw new Error("Inspection ended");
  return { total: eligible.length, rows };
}
