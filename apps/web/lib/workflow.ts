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
export type MissionData = {
  mission: Mission; plan: Plan; account: AccountView; actions: Action[];
  decisions: Decision[]; executions: Execution[]; receipts: Receipt[];
  outcomes: Outcome[]; audit: Schema["AuditEvent"][];
  readiness?: ExecutionReadiness;
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
  const [plan, account, actions, outcomes, audit, readiness] = await Promise.all([
    get<Plan>(`plans/${mission.plan_id}`), get<AccountView>(`accounts/${mission.account_id}`),
    get<Action[]>(`missions/${id}/actions`), get<Outcome[]>(`missions/${id}/outcomes`),
    get<Schema["AuditEvent"][]>(`missions/${id}/audit`),
    get<ExecutionReadiness>(`integrations/hubspot/accounts/${mission.account_id}/execution-readiness`),
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
  if (readiness.account_id !== account.account.id || readiness.organization_id !== account.account.organization_id
    || readiness.account_revision !== account.account.revision) throw new Error("Account changed while loading. Refresh current state.");
  return { mission, plan, account, actions, outcomes, audit, readiness,
    decisions: records.flatMap(item => item.decisions), executions: records.flatMap(item => item.executions),
    receipts: records.flatMap(item => item.receipts) };
}

export function postWorkflow<T>(path: string, body: object, signal: AbortSignal) {
  return api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body), signal });
}
