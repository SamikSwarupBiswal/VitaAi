import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

export type IngestionReadiness = components["schemas"]["IngestionReadiness"];
export type IngestionRun = components["schemas"]["IngestionRun"];
export type IngestionRecoveryReadiness = components["schemas"]["IngestionRecoveryReadiness"];
export type IngestionObjectType = IngestionRun["object_type"];
export const accountPath = (id: string) => `integrations/hubspot/accounts/${encodeURIComponent(id)}/ingestions`;
export const recordPath = (id: string) => `integrations/hubspot/ingestions/${encodeURIComponent(id)}`;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const time = (value: unknown) => typeof value === "string" && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const optionalTime = (value: unknown) => value == null || time(value);

function scope(view: AccountView, record: { organization_id: string; account_id: string }) {
  if (record.organization_id !== view.account.organization_id || record.account_id !== view.account.id) {
    throw new Error("Ingestion record scope changed.");
  }
}

export function checkIngestion(view: AccountView, run: IngestionRun) {
  scope(view, run);
  if (!uuid.test(run.id) || !Number.isSafeInteger(run.account_revision) || run.account_revision < 1
    || !Number.isSafeInteger(run.configuration_revision) || run.configuration_revision < 1
    || (run.configuration_hash != null && !/^[a-f0-9]{64}$/.test(run.configuration_hash))
    || !Number.isSafeInteger(run.sequence) || run.sequence < 1 || !Number.isSafeInteger(run.revision) || run.revision < 1
    || !["contacts", "deals", "notes", "tasks"].includes(run.object_type)
    || !["pending", "succeeded", "failed", "interrupted"].includes(run.status)
    || ![run.started_at, run.worker_deadline_at].every(time) || !optionalTime(run.finished_at)
    || !Array.isArray(run.objects) || run.objects.length > 20) throw new Error("Invalid saved ingestion record.");
  for (const item of run.objects) {
    if (!/^[1-9][0-9]{0,19}$/.test(item.object_id) || !time(item.created_at) || !time(item.updated_at)
      || !item.properties || typeof item.properties !== "object" || Array.isArray(item.properties)
      || Object.values(item.properties).some(value => value !== null && (typeof value !== "string" || value.length > 8000))
      || !Array.isArray(item.association_types) || !item.association_types.length || item.association_types.length > 20) {
      throw new Error("Invalid saved associated object.");
    }
    for (const association of item.association_types) {
      if (!["HUBSPOT_DEFINED", "USER_DEFINED", "INTEGRATOR_DEFINED"].includes(association.category)
        || !Number.isSafeInteger(association.type_id) || association.type_id < 1
        || (association.label !== null && (typeof association.label !== "string" || association.label.length > 200))) {
        throw new Error("Invalid saved association.");
      }
    }
  }
  return run;
}

export async function readIngestionReadiness(view: AccountView, signal: AbortSignal) {
  const [current, ready] = await Promise.all([
    api<AccountView>(`accounts/${view.account.id}`, { signal }),
    api<IngestionReadiness>(`${accountPath(view.account.id)}/readiness`, { signal }),
  ]);
  if (current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.source?.id !== view.source?.id) {
    throw new Error("Refresh current account first.");
  }
  scope(view, ready);
  if (ready.account_revision !== view.account.revision || !Number.isSafeInteger(ready.configuration_revision)
    || !/^[a-f0-9]{64}$/.test(ready.configuration_hash) || typeof ready.can_start !== "boolean"
    || typeof ready.connector_configured !== "boolean" || typeof ready.ingestion_enabled !== "boolean"
    || ready.configuration_revision < 1
    || (ready.pending_run_id != null && !uuid.test(ready.pending_run_id)) || !optionalTime(ready.cooldown_until)) {
    throw new Error("Ingestion readiness binding changed.");
  }
  return ready;
}

export async function readIngestionHistory(view: AccountView, signal: AbortSignal) {
  const runs = await api<IngestionRun[]>(accountPath(view.account.id), { signal });
  if (!Array.isArray(runs) || runs.length > 20) throw new Error("Invalid ingestion history.");
  return runs.map(run => checkIngestion(view, run));
}

export async function readIngestion(view: AccountView, id: string, signal: AbortSignal) {
  if (!uuid.test(id)) throw new Error("Enter a valid ingestion ID.");
  const run = checkIngestion(view, await api<IngestionRun>(recordPath(id), { signal }));
  if (run.id !== id) throw new Error("Ingestion identity changed.");
  return run;
}

export async function readIngestionRecovery(view: AccountView, run: IngestionRun, signal: AbortSignal) {
  const ready = await api<IngestionRecoveryReadiness>(`${recordPath(run.id)}/recovery-readiness`, { signal });
  checkIngestion(view, ready.run);
  if (JSON.stringify(ready.run) !== JSON.stringify(run) || ready.account_revision !== view.account.revision
    || typeof ready.eligible !== "boolean") throw new Error("Recovery binding changed. Inspect again.");
  return ready;
}

export const ingestionRequests = new Set<string>();
export const ingestionKey = (view: AccountView) => JSON.stringify([view.account.organization_id, view.account.id]);
export async function mutateIngestion(view: AccountView, path: string, body: object, signal: AbortSignal) {
  const key = ingestionKey(view);
  if (signal.aborted || ingestionRequests.has(key)) throw new Error("Ingestion mutation already pending.");
  ingestionRequests.add(key);
  try {
    await api(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } finally { ingestionRequests.delete(key); }
}
