import { api, type AccountView } from "./api";
import type { components } from "./api.generated";

export type ResearchRun = components["schemas"]["ResearchRun"];
export type ResearchReadiness = components["schemas"]["ResearchReadiness"];
export type ResearchRequest = components["schemas"]["ResearchRequest"];
const prefix = "integrations/research";
export const researchAccountPath = (id: string) => `${prefix}/accounts/${encodeURIComponent(id)}`;

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

export function startResearch(view: AccountView, mode: "mock" | "live", signal: AbortSignal) {
  const body: ResearchRequest = { schema_version: "1", expected_account_revision: view.account.revision, mode };
  return api<ResearchRun>(`${researchAccountPath(view.account.id)}/search`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
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
    || run.target.company_name !== readiness.target.company_name || run.target.domain !== readiness.target.domain) {
    return "Historical revision or target; current context is not established.";
  }
  if (now === null || !run.expires_at || !Number.isFinite(Date.parse(run.expires_at)) || now >= Date.parse(run.expires_at)) {
    return "Historical context; expired or no valid context window.";
  }
  if (run.mode !== "live" || run.status !== "succeeded" || !run.sources?.length) return "No live research context from this run.";
  return "Matching revision and target; context window open. Sources remain unverified.";
}
