import { api, type AccountView } from "./api";
import { accountPath, type HubSpotSyncRun } from "./hubspot";
import type { components } from "./api.generated";

export type RefreshSchedule = components["schemas"]["RefreshScheduleView"];
export type RefreshOccurrence = components["schemas"]["RefreshOccurrence"];
export type RefreshRecovery = components["schemas"]["RefreshRecoveryReadiness"];
type GrantRequest = components["schemas"]["RefreshGrantRequest"];
type RevokeRequest = components["schemas"]["RefreshRevokeRequest"];
type RecoveryRequest = components["schemas"]["RefreshRecoveryRequest"];
const prefix = "integrations/hubspot/refresh-occurrences";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const hash = /^[a-f0-9]{64}$/;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
function scoped(view: AccountView, record: { organization_id: string; account_id: string }) {
  if (record.organization_id !== view.account.organization_id || record.account_id !== view.account.id) throw new Error("Refresh record scope changed.");
}
export function checkOccurrence(view: AccountView, record: RefreshOccurrence) {
  scoped(view, record);
  if (!uuid.test(record.id) || !uuid.test(record.authorization_id) || !uuid.test(record.sync_run_id)
    || !positive(record.revision) || !positive(record.authorization_revision) || !Number.isSafeInteger(record.slot) || record.slot < 0
    || !["pending", "succeeded", "failed", "interrupted"].includes(record.status)
    || ![record.due_at, record.started_at, record.worker_deadline_at].every(value => Number.isFinite(Date.parse(value)))) throw new Error("Invalid occurrence record.");
  return record;
}
export async function readSchedule(view: AccountView, signal: AbortSignal) {
  const [current, schedule] = await Promise.all([
    api<AccountView>(`accounts/${view.account.id}`, { signal }),
    api<RefreshSchedule>(`${accountPath(view.account.id)}/refresh-schedule`, { signal }),
  ]);
  if (current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.source?.id !== view.source?.id) throw new Error("Refresh current account first.");
  scoped(view, schedule);
  if (schedule.account_revision !== view.account.revision || !hash.test(schedule.configuration_hash)
    || typeof schedule.can_authorize !== "boolean" || typeof schedule.worker_available !== "boolean"
    || (schedule.pending_occurrence_id != null && !uuid.test(schedule.pending_occurrence_id))) throw new Error("Refresh schedule changed.");
  if (schedule.authorization) {
    const grant = schedule.authorization; scoped(view, grant);
    if (!uuid.test(grant.id) || !positive(grant.revision) || !positive(grant.account_revision)
      || !hash.test(grant.configuration_hash) || !["authorized", "revoked"].includes(grant.status)) throw new Error("Invalid saved authorization.");
  }
  return schedule;
}
export async function readOccurrences(view: AccountView, signal: AbortSignal) {
  const records = await api<RefreshOccurrence[]>(`${accountPath(view.account.id)}/refresh-occurrences`, { signal });
  if (!Array.isArray(records) || records.length > 20) throw new Error("Invalid occurrence history.");
  return records.map(record => checkOccurrence(view, record));
}
export async function readOccurrence(view: AccountView, id: string, signal: AbortSignal) {
  if (!uuid.test(id)) throw new Error("Enter a valid occurrence ID.");
  const record = checkOccurrence(view, await api<RefreshOccurrence>(`${prefix}/${id}`, { signal }));
  if (record.id !== id) throw new Error("Occurrence identity changed.");
  return record;
}
export async function readRecovery(view: AccountView, record: RefreshOccurrence, signal: AbortSignal) {
  const ready = await api<RefreshRecovery>(`${prefix}/${record.id}/recovery-readiness`, { signal });
  checkOccurrence(view, ready.occurrence);
  if (JSON.stringify(ready.occurrence) !== JSON.stringify(record) || ready.account_revision !== view.account.revision
    || typeof ready.eligible !== "boolean") throw new Error("Recovery binding changed. Inspect again.");
  return ready;
}
export async function readOccurrenceSync(view: AccountView, record: RefreshOccurrence, signal: AbortSignal) {
  const run = await api<HubSpotSyncRun>(`integrations/hubspot/runs/${record.sync_run_id}`, { signal });
  scoped(view, run);
  if (run.id !== record.sync_run_id) throw new Error("Saved sync identity changed.");
  return run;
}
// Keep account-wide locks until transport settles, including across component remounts.
export const refreshRequests = new Set<string>();
export const refreshKey = (view: AccountView) => JSON.stringify([view.account.organization_id, view.account.id]);
export async function mutateRefresh(view: AccountView, suffix: string, body: GrantRequest | RevokeRequest | RecoveryRequest, signal: AbortSignal) {
  const key = refreshKey(view);
  if (signal.aborted || refreshRequests.has(key)) throw new Error("Refresh mutation already pending.");
  refreshRequests.add(key);
  try {
    await api(suffix, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  } finally { refreshRequests.delete(key); }
}
export const occurrencePath = (id: string) => `${prefix}/${id}`;
