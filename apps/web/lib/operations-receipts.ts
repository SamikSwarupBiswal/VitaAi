import { api, type Portfolio } from "./api";
import { sameAccount } from "./account-history";
import { sameMission } from "./manager-reports";
import type { Action, Decision, Execution, Mission, Receipt } from "./workflow";

export type ReceiptInspection = { action: Action; execution: Execution | null; receipt: Receipt | null;
  unavailable: boolean; receiptUnavailable: boolean };
export type ReceiptMission = { mission: Mission; actions: ReceiptInspection[] | null };

function validActions(actions: Action[], mission: Mission) {
  return Array.isArray(actions) && actions.length <= 12 && new Set(actions.map(item => item.id)).size === actions.length
    && new Set(actions.map(item => item.slot_id)).size === actions.length
    && actions.every(item => item.organization_id === mission.organization_id && item.mission_id === mission.id
      && item.mission_revision === mission.content_revision && item.plan_id === mission.plan_id && item.plan_revision === mission.plan_revision
      && item.evidence.account_id === mission.account_id && item.evidence.account_revision === mission.evidence.account_revision
      && item.evidence.snapshot_hash === mission.evidence.snapshot_hash && item.evidence.as_of === mission.evidence.as_of
      && item.destination.target_account_id === mission.account_id
      && item.destination.provider === (item.payload.kind === "outlook_draft_create" ? "microsoft" : "hubspot"));
}

function sameExecution(before: Execution, after: Execution) {
  return after.id === before.id && after.organization_id === before.organization_id && after.action_id === before.action_id
    && after.action_revision === before.action_revision && after.binding_hash === before.binding_hash && after.decision_id === before.decision_id
    && after.revision === before.revision && after.attempt === before.attempt && after.status === before.status
    && after.receipt_id === before.receipt_id;
}

function validReceipt(receipt: Receipt, execution: Execution, action: Action) {
  const destination = action.destination;
  const keys = ["connector_id", "provider", "configuration_revision", "tenant_id", "target_account_id", "target_resource_id",
    "delegated_user_id", "mailbox_id"] as const;
  return receipt.id === execution.receipt_id && receipt.organization_id === action.organization_id
    && receipt.execution_id === execution.id && receipt.action_id === action.id && receipt.decision_id === execution.decision_id
    && receipt.binding_hash === action.binding_hash && receipt.mode === action.mode && receipt.result === execution.status
    && keys.every(key =>
      (receipt.destination[key] ?? null) === (destination[key] ?? null))
    && (!receipt.error_code || /^[a-z][a-z0-9_]{0,79}$/.test(receipt.error_code))
    && (receipt.result !== "succeeded" || !!receipt.provider_resource_id)
    && (receipt.verification !== "verified" || (receipt.result === "succeeded" && /^[a-f0-9]{64}$/.test(receipt.readback_hash ?? "") && !!receipt.readback_at));
}

async function readAction(action: Action, signal: AbortSignal): Promise<ReceiptInspection> {
  const row: ReceiptInspection = { action, execution: null, receipt: null, unavailable: false, receiptUnavailable: false };
  try {
    const executions = await api<Execution[]>(`actions/${encodeURIComponent(action.id)}/executions`, { signal });
    if (!Array.isArray(executions) || executions.length > 1) throw new Error("Claim list changed");
    if (!executions.length) return row;
    const execution = executions[0];
    if (execution.organization_id !== action.organization_id || execution.action_id !== action.id
      || execution.action_revision !== action.revision || execution.binding_hash !== action.binding_hash) throw new Error("Claim binding changed");
    const decisions = await api<Decision[]>(`actions/${encodeURIComponent(action.id)}/decisions`, { signal });
    if (!Array.isArray(decisions) || new Set(decisions.map(item => item.id)).size !== decisions.length
      || decisions.some(item => item.organization_id !== action.organization_id || item.action_id !== action.id)
      || !decisions.some(item => item.id === execution.decision_id && item.action_revision === action.revision
        && item.binding_hash === action.binding_hash && item.decision === "approved")) throw new Error("Decision binding changed");
    row.execution = execution;
    if (execution.receipt_id) {
      try {
        const receipt = await api<Receipt>(`receipts/${encodeURIComponent(execution.receipt_id)}`, { signal });
        if (!validReceipt(receipt, execution, action)) throw new Error("Receipt binding changed");
        row.receipt = receipt;
      } catch { row.receiptUnavailable = true; }
    }
  } catch { row.unavailable = true; row.execution = null; row.receipt = null; }
  return row;
}

export async function readOperationsReceipts(portfolio: Portfolio, missions: Mission[], signal: AbortSignal) {
  if (signal.aborted) throw new Error("Inspection ended");
  if (!Array.isArray(missions) || new Set(missions.map(item => item.id)).size !== missions.length
    || missions.some(item => item.organization_id !== portfolio.organization_id)) throw new Error("Mission list changed");
  const eligible = missions.filter(item => portfolio.accounts.some(view => view.account.id === item.account_id
    && view.account.organization_id === item.organization_id));
  const rows: ReceiptMission[] = await Promise.all(eligible.slice(0, 5).map(async mission => {
    try {
      const current = await api<Mission>(`missions/${encodeURIComponent(mission.id)}`, { signal });
      if (!sameMission(mission, current) || current.content_revision !== mission.content_revision
        || current.plan_id !== mission.plan_id || current.plan_revision !== mission.plan_revision) throw new Error("Mission changed");
      const actions = await api<Action[]>(`missions/${encodeURIComponent(mission.id)}/actions`, { signal });
      if (!validActions(actions, mission)) throw new Error("Actions changed");
      return { mission, actions: await Promise.all(actions.map(action => readAction(action, signal))) };
    } catch { return { mission, actions: null }; }
  }));
  // A claim may progress without changing the aggregate mission lifecycle/revision.
  await Promise.all(rows.map(async row => {
    if (!row.actions) return;
    await Promise.all(row.actions.map(async item => {
      if (item.unavailable) return;
      try {
        const fresh = await api<Execution[]>(`actions/${encodeURIComponent(item.action.id)}/executions`, { signal });
        if (!Array.isArray(fresh) || (item.execution ? fresh.length !== 1 || !sameExecution(item.execution, fresh[0]) : fresh.length !== 0)) {
          throw new Error("Claim changed");
        }
      } catch { item.unavailable = true; item.execution = null; item.receipt = null; item.receiptUnavailable = false; }
    }));
    try {
      const [fresh, actions] = await Promise.all([
        api<Mission>(`missions/${encodeURIComponent(row.mission.id)}`, { signal }),
        api<Action[]>(`missions/${encodeURIComponent(row.mission.id)}/actions`, { signal }),
      ]);
      if (!sameMission(row.mission, fresh) || fresh.content_revision !== row.mission.content_revision
        || fresh.plan_id !== row.mission.plan_id || fresh.plan_revision !== row.mission.plan_revision
        || !validActions(actions, fresh) || actions.length !== row.actions.length
        || row.actions.some(item => !actions.some(action => action.id === item.action.id && action.revision === item.action.revision
          && action.binding_hash === item.action.binding_hash && action.mode === item.action.mode))) row.actions = null;
    } catch { row.actions = null; }
  }));
  await Promise.all([...new Set(rows.map(row => row.mission.account_id))].map(async id => {
    try {
      const view = portfolio.accounts.find(item => item.account.id === id)!;
      const current = await api<typeof view>(`accounts/${encodeURIComponent(id)}`, { signal });
      if (!sameAccount(view, current)) throw new Error("Account changed");
    } catch { rows.filter(row => row.mission.account_id === id).forEach(row => { row.actions = null; }); }
  }));
  if (signal.aborted) throw new Error("Inspection ended");
  return { total: eligible.length, rows };
}

export function receiptDiagnosis(row: ReceiptInspection) {
  if (row.unavailable) return "Saved claim unavailable or changed. No execution result inferred.";
  const execution = row.execution, receipt = row.receipt;
  if (!execution) return "No saved execution claim. This is not permission to execute.";
  if (execution.status === "claimed" || execution.status === "dispatching") return "Execution active or interrupted. Inspect saved state; do not redispatch.";
  if (execution.status === "result_unknown") return "Result unknown. Do not repeat the write; an authorized reviewer must inspect reconciliation separately.";
  if (execution.status === "failed") return "Known failed execution. Inspect the saved failure and approval before any separately authorized recovery; retry is not implied.";
  if (!receipt || receipt.verification !== "verified") return "Saved success lacks verified readback here. Inspect the receipt; no verified result inferred.";
  return "Saved successful execution with matching readback. This does not establish a business outcome or current provider health.";
}
