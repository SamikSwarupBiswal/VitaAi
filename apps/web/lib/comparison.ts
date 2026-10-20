import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

export type CatalogEntry = components["schemas"]["CatalogEntry"];
export type ComparisonRun = components["schemas"]["ComparisonRun"];
export type ComparisonReadiness = components["schemas"]["ComparisonReadiness"];
export type ComparisonChoice = components["schemas"]["ComparisonChoice"];
export type DiscoveryResult = components["schemas"]["DiscoveryResult"];
const prefix = "provider-comparison";
const accountPath = (view: AccountView) => `${prefix}/accounts/${encodeURIComponent(view.account.id)}`;
// Retain transport locks across account/panel remounts within this organization.
export const comparisonPending = new Set<string>();

export function checkComparisonRun(view: AccountView, run: ComparisonRun) {
  if (run.account_id !== view.account.id || run.organization_id !== view.account.organization_id
    || run.snapshot.account.id !== run.account_id || run.snapshot.account.organization_id !== run.organization_id
    || run.snapshot.account.revision !== run.account_revision || run.snapshot.assessment.snapshot_hash !== run.snapshot_hash) {
    throw new Error("Comparison record unavailable for this account.");
  }
  return run;
}

export async function readComparisons(view: AccountView, signal: AbortSignal) {
  const [readiness, catalog, runs] = await Promise.all([
    api<ComparisonReadiness>(`${accountPath(view)}/readiness`, { signal }),
    api<CatalogEntry[]>(`${prefix}/catalog`, { signal }),
    api<ComparisonRun[]>(`${accountPath(view)}/runs`, { signal }),
  ]);
  if (readiness.account_id !== view.account.id || readiness.organization_id !== view.account.organization_id
    || readiness.account_revision !== view.account.revision || readiness.snapshot_hash !== view.assessment.snapshot_hash) {
    throw new Error("Account changed. Refresh portfolio before comparison.");
  }
  runs.forEach(run => checkComparisonRun(view, run));
  return { readiness, catalog, runs };
}

export async function readComparisonRun(view: AccountView, id: string, signal: AbortSignal) {
  const run = await api<ComparisonRun>(`${prefix}/runs/${encodeURIComponent(id)}`, { signal });
  if (run.id !== id) throw new Error("Comparison identity changed. Refresh records.");
  return checkComparisonRun(view, run);
}

export function startComparison(view: AccountView, providers: ComparisonChoice[], signal: AbortSignal) {
  const body: components["schemas"]["ComparisonRequest"] = { schema_version: "1",
    expected_revision: view.account.revision, expected_snapshot_hash: view.assessment.snapshot_hash, providers };
  return api<ComparisonRun>(`${accountPath(view)}/compare`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

export async function discoverComparisonProvider(entry: CatalogEntry, mode: "mock" | "live", signal: AbortSignal) {
  const body: components["schemas"]["DiscoveryRequest"] = { schema_version: "1", mode };
  const result = await api<DiscoveryResult>(`${prefix}/providers/${entry.provider}/discover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (result.provider !== entry.provider || result.configuration_revision !== entry.configuration_revision
    || result.requested_mode !== mode) throw new Error("Provider configuration changed. Refresh records.");
  return result;
}
