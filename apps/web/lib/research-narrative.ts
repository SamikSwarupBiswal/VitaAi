import { api, type AccountView } from "./api";
import type { components } from "./api.generated";
import type { ResearchContextView } from "./research";

export type NarrativeRun = components["schemas"]["NarrativeRun"];
export type NarrativeReadiness = components["schemas"]["NarrativeReadiness"];
export type NarrativeRecoveryReadiness = components["schemas"]["ResearchRecoveryReadiness"];
export const narrativePending = new Set<string>();
const prefix = "integrations/research";
const runPath = (context: ResearchContextView) => `${prefix}/runs/${encodeURIComponent(context.retained_run.id)}`;

export function checkNarrative(view: AccountView, context: ResearchContextView, run: NarrativeRun) {
  const internal = run.context.internal;
  if (run.organization_id !== view.account.organization_id || run.account_id !== view.account.id
    || run.research_run_id !== context.retained_run.id || run.context.retained_run.id !== context.retained_run.id
    || run.context.retained_run.revision !== context.retained_run.revision
    || internal.account.id !== run.account_id || internal.account.organization_id !== run.organization_id) {
    throw new Error("Narrative record does not match this account and research run.");
  }
  return run;
}

export async function readNarratives(view: AccountView, context: ResearchContextView, signal: AbortSignal) {
  const [readiness, runs] = await Promise.all([
    api<NarrativeReadiness>(`${runPath(context)}/narrative-readiness`, { signal }).catch(() => null),
    api<NarrativeRun[]>(`${runPath(context)}/narratives`, { signal }),
  ]);
  let ready = readiness;
  if (ready && (ready.organization_id !== view.account.organization_id || ready.account_id !== view.account.id
    || ready.account_revision !== view.account.revision || ready.snapshot_hash !== view.assessment.snapshot_hash
    || ready.research_run_id !== context.retained_run.id || ready.research_run_revision !== context.retained_run.revision)) {
    ready = null;
  }
  runs.forEach(run => checkNarrative(view, context, run));
  return { ready, runs };
}

export async function readNarrative(view: AccountView, context: ResearchContextView, id: string, signal: AbortSignal) {
  const run = await api<NarrativeRun>(`${prefix}/narratives/${encodeURIComponent(id)}`, { signal });
  if (run.id !== id) throw new Error("Narrative identity changed.");
  return checkNarrative(view, context, run);
}

export async function startNarrative(view: AccountView, context: ResearchContextView, ready: NarrativeReadiness,
  mode: "mock" | "live", signal: AbortSignal) {
  const body: components["schemas"]["NarrativeRequest"] = { schema_version: "1",
    expected_account_revision: ready.account_revision, expected_snapshot_hash: ready.snapshot_hash,
    expected_run_revision: ready.research_run_revision, expected_configuration_revision: ready.configuration_revision, mode };
  const run = checkNarrative(view, context, await api<NarrativeRun>(`${runPath(context)}/narratives`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }));
  if (run.requested_mode !== mode || run.configuration_revision !== ready.configuration_revision
    || run.context.internal.account.revision !== ready.account_revision
    || run.context.internal.assessment.snapshot_hash !== ready.snapshot_hash) throw new Error("Narrative response binding changed.");
  return run;
}

export async function readNarrativeRecovery(view: AccountView, run: NarrativeRun, signal: AbortSignal) {
  const ready = await api<NarrativeRecoveryReadiness>(`${prefix}/narratives/${encodeURIComponent(run.id)}/recovery-readiness`, { signal });
  if (ready.run_id !== run.id || ready.run_revision !== run.revision || ready.account_id !== view.account.id
    || ready.organization_id !== view.account.organization_id || ready.account_revision !== view.account.revision
    || ready.recover_after !== run.worker_deadline_at) throw new Error("Narrative recovery changed. Inspect the saved record again.");
  return ready;
}

export async function recoverNarrative(view: AccountView, context: ResearchContextView, run: NarrativeRun,
  ready: NarrativeRecoveryReadiness, signal: AbortSignal) {
  const body: components["schemas"]["ResearchRecoveryRequest"] = { schema_version: "1",
    expected_revision: ready.run_revision, expected_account_revision: ready.account_revision };
  const saved = checkNarrative(view, context, await api<NarrativeRun>(`${prefix}/narratives/${encodeURIComponent(run.id)}/recover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }));
  if (saved.id !== run.id || saved.status !== "interrupted" || saved.revision !== ready.run_revision + 1
    || saved.recovery?.previous_revision !== ready.run_revision) throw new Error("Narrative finalization could not be confirmed.");
  return saved;
}
