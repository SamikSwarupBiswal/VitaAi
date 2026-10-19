import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

type Schema = components["schemas"];
export type Mission = Schema["Mission"];
export type Plan = Schema["Plan"];
export type PlanRequest = Schema["PlanRequest"];
export type Action = Schema["ActionPreview"];
export type Decision = Schema["ReviewDecision"];
export type Execution = Schema["Execution"];
export type Receipt = Schema["Receipt"];
export type Outcome = Schema["Outcome"];
export type OutcomeRequest = Schema["OutcomeRequest"];
export type Step = Schema["PlanStep"];
export type Payload = Action["payload"];
export type ExecutionReadiness = Schema["HubSpotExecutionReadiness"];
export type MicrosoftReadiness = Schema["MicrosoftExecutionReadiness"];
export type SourceSelection = Schema["SourceMissionSelection"];
export type MissionData = {
  mission: Mission; plan: Plan; account: AccountView; actions: Action[];
  decisions: Decision[]; executions: Execution[]; receipts: Receipt[];
  outcomes: Outcome[]; audit: Schema["AuditEvent"][];
  readiness?: ExecutionReadiness;
  microsoft?: MicrosoftReadiness;
  sourceSelection?: SourceSelection;
};

export const steps = ["Review", "Evidence", "Outreach", "CRM Note", "Approval", "Execution", "Outcome"] as const;
export const kindLabel = (kind: Payload["kind"]) => kind === "hubspot_task_create" ? "CRM task"
  : kind === "hubspot_note_create" ? "CRM note" : "Unsent Outlook draft";

export function currentDecision(action: Action, decisions: Decision[]) {
  return decisions.find(item => item.action_id === action.id && item.action_revision === action.revision
    && item.binding_hash === action.binding_hash);
}

export async function readMission(id: string, signal: AbortSignal): Promise<MissionData> {
  const get = <T>(path: string) => api<T>(path, { signal });
  const mission = await get<Mission>(`missions/${id}`);
  const [plan, account, actions, outcomes, audit, readiness, microsoft, sourceSelection] = await Promise.all([
    get<Plan>(`plans/${mission.plan_id}`), get<AccountView>(`accounts/${mission.account_id}`),
    get<Action[]>(`missions/${id}/actions`), get<Outcome[]>(`missions/${id}/outcomes`),
    get<Schema["AuditEvent"][]>(`missions/${id}/audit`),
    get<ExecutionReadiness>(`integrations/hubspot/accounts/${mission.account_id}/execution-readiness`),
    get<MicrosoftReadiness>(`integrations/microsoft/missions/${id}/execution-readiness`),
    // Optional enrichment may be inaccessible after mapping removal; the UI discloses its absence.
    mission.source_detection_id ? get<SourceSelection>(`integrations/hubspot/detections/${mission.source_detection_id}/mission`).catch(() => undefined) : undefined,
  ]);
  const records = await Promise.all(actions.map(async action => {
    const [decisions, executions] = await Promise.all([
      get<Decision[]>(`actions/${action.id}/decisions`), get<Execution[]>(`actions/${action.id}/executions`),
    ]);
    const receipts = await Promise.all(executions.filter(item => item.receipt_id)
      .map(item => get<Receipt>(`receipts/${item.receipt_id}`)));
    return { decisions, executions, receipts };
  }));
  // Independent GETs may straddle a concurrent edit. Never offer a mixed revision for review.
  const latest = await get<Mission>(`missions/${id}`);
  if (latest.revision !== mission.revision) throw new Error("Mission changed while loading. Refresh current state.");
  if (sourceSelection && (sourceSelection.organization_id !== mission.organization_id
    || sourceSelection.organization_id !== account.account.organization_id || sourceSelection.mission_id !== mission.id
    || sourceSelection.detection.id !== mission.source_detection_id || sourceSelection.detection.account_id !== mission.account_id
    || sourceSelection.detection.organization_id !== mission.organization_id
    || sourceSelection.request.plan_id !== mission.plan_id || sourceSelection.request.expected_revision !== mission.plan_revision
    || sourceSelection.request.template !== mission.template || sourceSelection.request.event_id !== sourceSelection.detection.event?.id
    || sourceSelection.request.expected_source_id !== sourceSelection.detection.after.source_version_id
    || sourceSelection.request.expected_account_revision !== sourceSelection.detection.after.account_revision
    || (sourceSelection.request.alternative_id || plan.selected_alternative_id) !== (mission.alternative_id || plan.selected_alternative_id))) {
    throw new Error("Source provenance changed while loading. Refresh current state.");
  }
  if (readiness.account_id !== account.account.id || readiness.organization_id !== account.account.organization_id
    || readiness.account_revision !== account.account.revision) throw new Error("Account changed while loading. Refresh current state.");
  if (microsoft.mission_id !== mission.id || microsoft.mission_revision !== mission.revision
    || microsoft.account_id !== account.account.id || microsoft.organization_id !== account.account.organization_id
    || microsoft.account_revision !== account.account.revision || microsoft.actions.some(record => !actions.some(action =>
      action.id === record.action_id && action.revision === record.action_revision && action.binding_hash === record.binding_hash))) {
    throw new Error("Microsoft binding changed while loading. Refresh current state.");
  }
  return { mission, plan, account, actions, outcomes, audit, readiness, microsoft, sourceSelection,
    decisions: records.flatMap(item => item.decisions), executions: records.flatMap(item => item.executions),
    receipts: records.flatMap(item => item.receipts) };
}

export function postWorkflow<T>(path: string, body: object, signal: AbortSignal) {
  return api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal });
}
