import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

export type HubSpotStatus = components["schemas"]["HubSpotStatus"];
export type HubSpotProbeReadiness = components["schemas"]["HubSpotProbeReadiness"];
export type HubSpotProbeResult = components["schemas"]["HubSpotProbeResult"];
export type HubSpotSeedPreview = components["schemas"]["SeedPreview"];
export type HubSpotPreview = components["schemas"]["HubSpotPreview"];
export type HubSpotObservation = components["schemas"]["HubSpotObservation"];
export type HubSpotSyncRun = components["schemas"]["HubSpotSyncRun"];
export type SourceVersion = components["schemas"]["AccountSourceVersion"];
export type AccountSource = components["schemas"]["AccountSource"];
export type SourceDetection = components["schemas"]["SourceDetection"];
export type SourceSnapshot = components["schemas"]["SourceSnapshot"];
export type SourceField = components["schemas"]["SourceField"];
export type SourceDetectionBatch = components["schemas"]["SourceDetectionBatch"];
type DetectionRequest = components["schemas"]["SourceDetectionRequest"];
type PromoteRequest = components["schemas"]["HubSpotPromoteRequest"];
type SyncRequest = components["schemas"]["HubSpotSyncRequest"];
const prefix = "integrations/hubspot";
export const accountPath = (id: string) => `${prefix}/accounts/${encodeURIComponent(id)}`;

function checkProbeScope(view: AccountView, value: HubSpotProbeReadiness | HubSpotProbeResult | HubSpotSeedPreview) {
  if (value.account_id !== view.account.id || value.organization_id !== view.account.organization_id
    || value.account_revision !== view.account.revision) throw new Error("Connection check context changed. Refresh current state.");
}

export async function readProbeReadiness(view: AccountView, signal: AbortSignal) {
  const value = await api<HubSpotProbeReadiness>(`${accountPath(view.account.id)}/connection-readiness`, { signal });
  checkProbeScope(view, value);
  return value;
}

export async function probeConnection(view: AccountView, ready: HubSpotProbeReadiness, signal: AbortSignal) {
  checkProbeScope(view, ready);
  if (!ready.can_probe || signal.aborted) throw new Error("Inspect current connection readiness first.");
  const body: components["schemas"]["HubSpotProbeRequest"] = { schema_version: "1",
    expected_account_revision: ready.account_revision, expected_configuration_hash: ready.configuration_hash };
  const value = await api<HubSpotProbeResult>(`${accountPath(view.account.id)}/probe`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  checkProbeScope(view, value);
  if (value.configuration_hash !== ready.configuration_hash) throw new Error("Connection check configuration changed.");
  return value;
}

export function postHubSpot<T>(path: string, body: PromoteRequest | SyncRequest, signal: AbortSignal) {
  return api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
}

export async function previewSeed(view: AccountView, count: number, signal: AbortSignal) {
  if (signal.aborted || !Number.isInteger(count) || count < 1 || count > 3) throw new Error("Choose 1 to 3 synthetic companies.");
  const ready = await readProbeReadiness(view, signal);
  if (signal.aborted) throw new Error("Preview cancelled.");
  const body: components["schemas"]["SeedPreviewRequest"] = { schema_version: "1", count,
    expected_account_revision: ready.account_revision, expected_configuration_hash: ready.configuration_hash };
  const value = await api<HubSpotSeedPreview>(`${accountPath(view.account.id)}/seed-preview`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  checkProbeScope(view, value);
  if (value.configuration_hash !== ready.configuration_hash || value.mode !== "preview" || value.execution_available !== false
    || value.method !== "POST" || value.path !== "/crm/v3/objects/companies" || !Array.isArray(value.companies)
    || value.companies.length !== count || value.companies.some(company => typeof company.name !== "string" || typeof company.description !== "string")) {
    throw new Error("Synthetic preview binding changed. Request a new preview explicitly.");
  }
  return value;
}

export async function readPreview(view: AccountView, signal: AbortSignal) {
  const preview = await api<HubSpotPreview>(`${accountPath(view.account.id)}/preview`, { signal });
  if (signal.aborted) return null;
  if (preview.account.id !== view.account.id || preview.account.organization_id !== view.account.organization_id
    || preview.expected_account_revision !== view.account.revision) throw new Error("Account changed. Refresh current state.");
  const observation = await api<HubSpotObservation>(`${prefix}/observations/${encodeURIComponent(preview.observation_id)}`, { signal });
  if (signal.aborted) return null;
  if (observation.id !== preview.observation_id || observation.account_id !== view.account.id
    || observation.organization_id !== view.account.organization_id) throw new Error("Observation unavailable for this account.");
  return { preview, observation };
}

export async function readSource(view: AccountView, id: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("Enter a valid source version ID.");
  const version = await api<SourceVersion>(`${prefix}/sources/${encodeURIComponent(id)}`, { signal });
  if (signal.aborted) return null;
  if (version.account_id !== view.account.id || version.account.organization_id !== view.account.organization_id
    || version.selection.id !== id) throw new Error("Source version unavailable for this account.");
  return version;
}

export function checkDetection(view: AccountView, record: SourceDetection) {
  if (record.account_id !== view.account.id || record.organization_id !== view.account.organization_id) {
    throw new Error("Saved detection unavailable for this account.");
  }
  return record;
}

export async function readDetections(view: AccountView, signal: AbortSignal) {
  const [current, records] = await Promise.all([
    api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal }),
    api<SourceDetection[]>(`${accountPath(view.account.id)}/detections`, { signal }),
  ]);
  if (current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.source?.id !== view.source?.id) {
    throw new Error("Account changed. Refresh portfolio before detection.");
  }
  records.forEach(record => checkDetection(view, record));
  return records;
}

export async function readDetection(view: AccountView, id: string, signal: AbortSignal) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error("Enter a valid detection ID.");
  const record = checkDetection(view, await api<SourceDetection>(`${prefix}/detections/${encodeURIComponent(id)}`, { signal }));
  if (record.id !== id) throw new Error("Detection identity changed. Refresh history.");
  return record;
}

// A component remount must not release a still-pending request's duplicate guard.
const detectionRequests = new Set<string>();
const detectionKey = (view: AccountView) => JSON.stringify([view.account.organization_id, view.account.id]);
export const detectionPending = (view: AccountView) => detectionRequests.has(detectionKey(view));

export async function detectSourceChanges(view: AccountView, signal: AbortSignal) {
  const key = detectionKey(view);
  if (signal.aborted || !view.source?.id || detectionRequests.has(key)) throw new Error("Detection unavailable.");
  detectionRequests.add(key);
  const body: DetectionRequest = { schema_version: "1", expected_account_revision: view.account.revision, expected_source_id: view.source.id };
  try {
    const result = await api<SourceDetectionBatch>(`${accountPath(view.account.id)}/detect-changes`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
    });
    if (result.account_id !== view.account.id || result.organization_id !== view.account.organization_id
      || result.account_revision !== view.account.revision || result.selected_source_id !== view.source.id) throw new Error("Detection context changed.");
    result.processed.forEach(record => checkDetection(view, record));
    return result;
  } finally { detectionRequests.delete(key); }
}
