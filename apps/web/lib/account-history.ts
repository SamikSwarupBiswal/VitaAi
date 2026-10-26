import type { AccountView } from "./api";
import type { components } from "./api.generated";
import type { Action, Mission, MissionData } from "./workflow";

export type Detection = components["schemas"]["SourceDetection"];
type Coaching = components["schemas"]["CoachingReview"];

export function sameAccount(view: AccountView, current: AccountView) {
  return current.account.id === view.account.id && current.account.organization_id === view.account.organization_id
    && current.account.revision === view.account.revision && current.source?.id === view.source?.id
    && current.assessment.snapshot_hash === view.assessment.snapshot_hash && current.assessment.as_of === view.assessment.as_of;
}

export function validateActivity(data: MissionData, reviews: Coaching[], histories: Action[][], selected: Mission, current: Mission, view: AccountView) {
  const mission = data.mission;
  if (mission.id !== selected.id || mission.account_id !== view.account.id || mission.organization_id !== view.account.organization_id
    || mission.owner_id !== selected.owner_id || mission.revision !== selected.revision
    || current.id !== mission.id || current.account_id !== mission.account_id || current.organization_id !== mission.organization_id
    || current.owner_id !== mission.owner_id || current.revision !== mission.revision || current.status !== mission.status
    || !sameAccount(view, data.account) || data.plan.id !== mission.plan_id || data.plan.revision !== mission.plan_revision
    || data.plan.account_id !== mission.account_id || data.plan.organization_id !== mission.organization_id
    || data.actions.some(item => item.mission_id !== mission.id)
    || data.outcomes.some((item, index) => item.mission_id !== mission.id || item.revision !== index + 1
      || (item.supersedes_id ?? null) !== (index ? data.outcomes[index - 1].id : null))
    || reviews.some((item, index) => item.mission_id !== mission.id || item.revision !== index + 1
      || (item.supersedes_id ?? null) !== (index ? reviews[index - 1].id : null)
      || !data.outcomes.some(report => report.id === item.outcome_id && report.revision === item.outcome_revision))
    || [...data.decisions, ...data.executions].some(item => !data.actions.some(action => action.id === item.action_id))) {
    throw new Error("Mission history binding changed");
  }
  const entities = [mission, ...data.actions, ...data.decisions, ...data.executions, ...data.outcomes, ...reviews];
  const byId = new Map(entities.map(item => [item.id, item]));
  if (byId.size !== entities.length || entities.some(item => item.organization_id !== mission.organization_id)
    || histories.some((history, index) => {
      const action = data.actions[index], latest = history.at(-1);
      return !latest || latest.revision !== action.revision || latest.correlation_id !== action.correlation_id
        || latest.binding_hash !== action.binding_hash || new Set(history.map(item => item.revision)).size !== history.length
        || history.some(item => item.id !== action.id || item.mission_id !== mission.id || item.organization_id !== mission.organization_id
          || item.revision > action.revision);
    })
    || new Set(data.audit.map(item => item.id)).size !== data.audit.length
    || new Set(data.audit.map(item => item.sequence)).size !== data.audit.length
    || data.audit.some(item => {
      const actionIndex = data.actions.findIndex(action => action.id === item.entity_id);
      const entity = actionIndex < 0 ? byId.get(item.entity_id) : histories[actionIndex].find(action => action.revision === item.entity_revision);
      return item.organization_id !== mission.organization_id || !entity || item.correlation_id !== entity.correlation_id
        || item.entity_revision > entity.revision;
    }) || (mission.transition_ids || []).some(id => !data.audit.some(item => item.id === id && (item.entity_id === mission.id
      || (item.event_kind === "outcome_corrected" && data.outcomes.some(report => report.id === item.entity_id)))))) {
    throw new Error("Audit history binding changed");
  }
}

export function validateDetections(saved: Detection[], view: AccountView): Detection[] {
  if (!Array.isArray(saved) || saved.length > 20
        || new Set(saved.map(item => item.id)).size !== saved.length
        || new Set(saved.map(item => item.after.source_version_id)).size !== saved.length
        || new Set(saved.map(item => item.after.account_revision)).size !== saved.length
        || saved.some(item => item.organization_id !== view.account.organization_id || item.account_id !== view.account.id
          || item.after.account_revision > view.account.revision
          || (item.after.account_revision === view.account.revision && item.after.source_version_id !== view.source?.id))) throw new Error("Saved history binding changed");
  return [...saved].sort((left, right) => right.after.account_revision - left.after.account_revision);
}
