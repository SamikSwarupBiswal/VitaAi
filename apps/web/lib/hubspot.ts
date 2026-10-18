import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

export type HubSpotStatus = components["schemas"]["HubSpotStatus"];
export type HubSpotPreview = components["schemas"]["HubSpotPreview"];
export type HubSpotObservation = components["schemas"]["HubSpotObservation"];
export type HubSpotSyncRun = components["schemas"]["HubSpotSyncRun"];
export type SourceVersion = components["schemas"]["AccountSourceVersion"];
export type AccountSource = components["schemas"]["AccountSource"];
type PromoteRequest = components["schemas"]["HubSpotPromoteRequest"];
type SyncRequest = components["schemas"]["HubSpotSyncRequest"];
const prefix = "integrations/hubspot";
export const accountPath = (id: string) => `${prefix}/accounts/${encodeURIComponent(id)}`;

export function postHubSpot<T>(path: string, body: PromoteRequest | SyncRequest, signal: AbortSignal) {
  return api<T>(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
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
