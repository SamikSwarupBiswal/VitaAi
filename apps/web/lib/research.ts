import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

export type ResearchRun = components["schemas"]["ResearchRun"];
export type ResearchReadiness = components["schemas"]["ResearchReadiness"];
export type ResearchRequest = components["schemas"]["ResearchRequest"];
export type ResearchRecoveryReadiness = components["schemas"]["ResearchRecoveryReadiness"];
export type ResearchContextView = components["schemas"]["ResearchContext"];
const prefix = "integrations/research";
export const researchAccountPath = (id: string) => `${prefix}/accounts/${encodeURIComponent(id)}`;
// Retain the transport lock across panel remounts until the request settles.
export const researchPending = new Set<string>();

export function checkResearchRun(view: AccountView, run: ResearchRun) {
  if (run.account_id !== view.account.id || run.organization_id !== view.account.organization_id) {
    throw new Error("Research record unavailable for this account.");
  }
  return run;
}

export async function readResearch(view: AccountView, signal: AbortSignal) {
  const path = researchAccountPath(view.account.id);
  const [readiness, runs] = await Promise.all([
    api<ResearchReadiness>(`${path}/readiness`, { signal }), api<ResearchRun[]>(`${path}/runs`, { signal }),
  ]);
  if (readiness.account_id !== view.account.id || readiness.organization_id !== view.account.organization_id
    || readiness.account_revision !== view.account.revision) throw new Error("Account changed. Refresh portfolio before research.");
  runs.forEach(run => checkResearchRun(view, run));
  return { readiness, runs };
}

export async function readResearchRun(view: AccountView, id: string, signal: AbortSignal) {
  const run = await api<ResearchRun>(`${prefix}/runs/${encodeURIComponent(id)}`, { signal });
  if (run.id !== id) throw new Error("Research run identity changed. Refresh history.");
  return checkResearchRun(view, run);
}

export async function readResearchContext(view: AccountView, run: ResearchRun, signal: AbortSignal) {
  const value = await api<ResearchContextView>(`${prefix}/runs/${encodeURIComponent(run.id)}/context`, { signal });
  checkResearchRun(view, value.retained_run);
  const current = value.internal;
  if (value.retained_run.id !== run.id || value.retained_run.revision !== run.revision
    || current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.assessment.snapshot_hash !== view.assessment.snapshot_hash
    || (current.source?.id ?? null) !== (view.source?.id ?? null)) throw new Error("Research context changed. Refresh the account and inspect again.");
  return value;
}

export function researchContextUsable(value: ResearchContextView, now: number | null) {
  const run = value.retained_run;
  return now !== null && value.status === "usable" && run.mode === "live" && run.status === "succeeded"
    && !!run.expires_at && now < Date.parse(run.expires_at) && now >= Date.parse(value.evaluated_at)
    && !!value.usable_sources?.length && value.usable_sources.every(source => source.published_at
      && Number.isFinite(Date.parse(source.published_at)) && Date.parse(source.published_at) <= now
      && now - Date.parse(source.published_at) <= 30 * 86400000 && researchSourceMatchedLink(source, run.target));
}

export function startResearch(view: AccountView, mode: "mock" | "live", signal: AbortSignal) {
  const body: ResearchRequest = { schema_version: "1", expected_account_revision: view.account.revision, mode };
  return api<ResearchRun>(`${researchAccountPath(view.account.id)}/search`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
}

export async function readResearchRecovery(view: AccountView, run: ResearchRun, signal: AbortSignal) {
  const ready = await api<ResearchRecoveryReadiness>(`${prefix}/runs/${encodeURIComponent(run.id)}/recovery-readiness`, { signal });
  if (ready.run_id !== run.id || ready.run_revision !== run.revision || ready.account_id !== view.account.id
    || ready.organization_id !== view.account.organization_id || ready.account_revision !== view.account.revision
    || ready.recover_after !== (run.worker_deadline_at ?? null)) throw new Error("Recovery state changed. Inspect the saved run again.");
  return ready;
}

export async function recoverResearch(view: AccountView, run: ResearchRun, ready: ResearchRecoveryReadiness, signal: AbortSignal) {
  const body: components["schemas"]["ResearchRecoveryRequest"] = { schema_version: "1",
    expected_revision: ready.run_revision, expected_account_revision: view.account.revision };
  const saved = checkResearchRun(view, await api<ResearchRun>(`${prefix}/runs/${encodeURIComponent(run.id)}/recover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }));
  if (saved.id !== run.id || saved.status !== "interrupted" || saved.revision !== ready.run_revision + 1
    || saved.recovery?.previous_revision !== ready.run_revision) throw new Error("Recovery response could not be confirmed.");
  return saved;
}

export function researchSourceLink(value: string, domain: string) {
  try {
    const url = new URL(value);
    return !/[\s\\]/.test(value) && url.protocol === "https:" && !url.username && !url.password
      && !url.port && !url.search && !url.hash && (url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

export function researchContext(run: ResearchRun, readiness: ResearchReadiness | null, now: number | null) {
  if (!readiness || run.account_revision !== readiness.account_revision || !readiness.target
    || run.target.company_name !== readiness.target.company_name || run.target.domain !== readiness.target.domain
    || JSON.stringify(run.target.publisher_domains ?? []) !== JSON.stringify(readiness.target.publisher_domains ?? [])) {
    return "Historical revision or target; current context is not established.";
  }
  if (now === null || !run.expires_at || !Number.isFinite(Date.parse(run.expires_at)) || now >= Date.parse(run.expires_at)) {
    return "Historical context; expired or no valid context window.";
  }
  if (run.mode !== "live" || run.status !== "succeeded" || !run.sources?.length) return "No live research context from this run.";
  return "Matching revision and target; context window open. Sources remain unverified.";
}

export function researchSourceMatchedLink(source: components["schemas"]["ResearchSource"], target: components["schemas"]["ResearchTarget"]) {
  if ((source.match ?? "configured_domain") === "configured_domain") return researchSourceLink(source.url, target.domain);
  return source.match === "configured_publisher_company_mention"
    && !!target.publisher_domains?.some(domain => researchSourceLink(source.url, domain));
}
