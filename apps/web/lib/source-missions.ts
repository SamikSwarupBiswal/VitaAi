import { api, type AccountView } from "./api";
import type { components } from "./api.generated";
import type { SourceDetection } from "./hubspot";
import type { Mission, Plan } from "./workflow";

export type SourceSelection = components["schemas"]["SourceMissionSelection"];
type SelectionRequest = components["schemas"]["SourceMissionRequest"];
type SelectionResult = components["schemas"]["SourceMissionResult"];
const selectionPath = (id: string) => `integrations/hubspot/detections/${encodeURIComponent(id)}/mission`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function currentEvent(view: AccountView, record: SourceDetection) {
  return record.account_id === view.account.id && record.organization_id === view.account.organization_id
    && record.status === "changed" && record.before?.kind === "hubspot" && record.after.kind === "hubspot"
    && record.after.source_version_id === view.source?.id && record.after.account_revision === view.account.revision
    && !!record.event?.changes.some(change => change.kind === "value_changed"
      && ["usage_change", "support_cases", "expansion", "renewal_date"].includes(change.field)
      && change.before.status === "valid" && change.after.status === "valid" && change.after.evidence_id);
}

export function compatibleChoices(record: SourceDetection, plan: Plan) {
  const evidence = new Set(record.event?.changes.filter(change => change.kind === "value_changed"
    && ["usage_change", "support_cases", "expansion", "renewal_date"].includes(change.field)
    && change.before.status === "valid" && change.after.status === "valid").map(change => change.after.evidence_id));
  return plan.alternatives.flatMap(alternative => {
    if (!alternative.steps.some(step => step.evidence_ids.some(id => evidence.has(id)))) return [];
    const [first, second] = alternative.steps;
    let template: Mission["template"];
    if (alternative.steps.length === 1 && first.dependencies.length === 0) {
      template = first.kind === "hubspot_task_create" ? "account-action-1" : first.kind === "hubspot_note_create"
        ? "account-note-1" : "account-outlook-draft-1";
    } else if (alternative.steps.length === 2 && first.dependencies.length === 0
      && ["hubspot_task_create", "outlook_draft_create"].includes(first.kind) && second.kind === "hubspot_note_create"
      && second.dependencies.length === 1 && second.dependencies[0] === first.id) template = "account-follow-up-1";
    else return [];
    return [{ alternative, template }];
  });
}

function checkContext(view: AccountView, current: AccountView, records: Mission[]) {
  if (current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.source?.id !== view.source?.id
    || current.assessment.snapshot_hash !== view.assessment.snapshot_hash
    || records.some(record => record.organization_id !== view.account.organization_id)) throw new Error("Account changed. Refresh portfolio.");
}

export async function readSourceSelection(view: AccountView, record: SourceDetection, mission: Mission, signal: AbortSignal) {
  const selection = await api<SourceSelection>(selectionPath(record.id), { signal });
  if (selection.organization_id !== view.account.organization_id || selection.detection.organization_id !== view.account.organization_id
    || selection.detection.account_id !== view.account.id || selection.detection.id !== record.id
    || selection.detection.event?.id !== record.event?.id || selection.mission_id !== mission.id
    || mission.organization_id !== view.account.organization_id || mission.account_id !== view.account.id
    || mission.source_detection_id !== record.id || selection.request.plan_id !== mission.plan_id
    || selection.request.event_id !== record.event?.id) throw new Error("Saved selection unavailable for this mission.");
  return selection;
}

export async function readSourceContext(view: AccountView, record: SourceDetection, signal: AbortSignal) {
  if (record.account_id !== view.account.id || record.organization_id !== view.account.organization_id) throw new Error("Detection unavailable.");
  const [current, missions] = await Promise.all([api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal }),
    api<Mission[]>("missions", { signal })]);
  checkContext(view, current, missions);
  const mission = missions.find(item => item.source_detection_id === record.id && item.account_id === view.account.id);
  const selection = mission ? await readSourceSelection(view, record, mission, signal) : null;
  return { missions, selection };
}

export async function readSourcePlan(view: AccountView, record: SourceDetection, id: string, signal: AbortSignal) {
  if (!uuid.test(id)) throw new Error("Enter a valid saved plan ID.");
  const [plan, context] = await Promise.all([api<Plan>(`plans/${encodeURIComponent(id)}`, { signal }), readSourceContext(view, record, signal)]);
  const binding = plan.evidence;
  if (!currentEvent(view, record) || context.selection || context.missions.some(mission => mission.plan_id === id)
    || plan.id !== id || plan.organization_id !== view.account.organization_id || plan.account_id !== view.account.id
    || plan.status !== "valid" || plan.validation !== "valid" || view.assessment.confidence < 100 || view.assessment.requires_review
    || binding.account_id !== view.account.id || binding.account_revision !== view.account.revision
    || binding.snapshot_hash !== view.assessment.snapshot_hash || binding.as_of !== view.assessment.as_of
    || binding.assessment_policy_version !== view.assessment.policy_version
    || JSON.stringify([...binding.evidence_ids].sort()) !== JSON.stringify(view.evidence.map(item => item.id).sort())
    || !compatibleChoices(record, plan).length) throw new Error("Plan unavailable, already used or incompatible with the current event.");
  return plan;
}

// Retain only an in-flight lock, never approval or a cached private record.
const pending = new Set<string>();
const keyFor = (view: AccountView) => JSON.stringify([view.account.organization_id, view.account.id]);
export const sourceSelectionPending = (view: AccountView) => pending.has(keyFor(view));

export async function selectSourceMission(view: AccountView, record: SourceDetection, plan: Plan, alternativeId: string, signal: AbortSignal) {
  const key = keyFor(view), choice = compatibleChoices(record, plan).find(item => item.alternative.id === alternativeId);
  if (signal.aborted || pending.has(key) || !currentEvent(view, record) || !choice) throw new Error("Selection unavailable.");
  const body: SelectionRequest = { schema_version: "1", event_id: record.event!.id,
    expected_account_revision: view.account.revision, expected_source_id: view.source!.id, plan_id: plan.id,
    expected_revision: plan.revision, template: choice.template, alternative_id: alternativeId };
  pending.add(key);
  try {
    const result = await api<SelectionResult>(selectionPath(record.id), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body), signal });
    if (!["mission_created", "mission_exists"].includes(result.status) || result.selection.organization_id !== view.account.organization_id
      || result.selection.detection.account_id !== view.account.id || result.selection.detection.id !== record.id
      || result.selection.request.event_id !== body.event_id || result.selection.request.plan_id !== body.plan_id
      || result.selection.request.expected_revision !== body.expected_revision
      || result.selection.request.expected_account_revision !== body.expected_account_revision
      || result.selection.request.expected_source_id !== body.expected_source_id
      || result.selection.request.alternative_id !== body.alternative_id || result.selection.request.template !== body.template) {
      throw new Error("Selection response unavailable. Read saved records.");
    }
    return result;
  } finally { pending.delete(key); }
}
