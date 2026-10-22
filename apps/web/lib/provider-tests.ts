import { api } from "./api";
import type { components } from "./api.generated";
import type { CatalogEntry } from "./comparison";

export type ProbeRun = components["schemas"]["ProbeRun"];
export type ProbeReadiness = components["schemas"]["ProbeReadiness"];
export type ProbeRecoveryReadiness = components["schemas"]["ProbeRecoveryReadiness"];
export type ProviderId = CatalogEntry["provider"];
const prefix = "provider-comparison";
const providers: ProviderId[] = ["nebius", "openai", "anthropic", "nvidia", "foundry"];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const model = (value: unknown) => value === null || typeof value === "string" && /^[A-Za-z0-9_./:-]{1,200}$/.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const measured = (value: unknown) => value === null || Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown): value is string => typeof value === "string"
  && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));
const failure = () => new Error("Provider test record could not be confirmed. Refresh saved records.");
// Provider scope, rather than account scope, survives navigation/remounts.
export const providerTestPending = new Set<string>();
export const probeScope = (organization: string, provider: string) => JSON.stringify([organization, provider]);

export async function readTestCatalog(signal: AbortSignal) {
  const entries = await api<CatalogEntry[]>(`${prefix}/catalog`, { signal });
  if (!Array.isArray(entries) || entries.length > providers.length
    || new Set(entries.map(entry => entry.provider)).size !== entries.length
    || entries.some(entry => !providers.includes(entry.provider) || !positive(entry.configuration_revision)
      || !model(entry.model) || !model(entry.expected_response_model) || typeof entry.enabled !== "boolean"
      || typeof entry.live_configured !== "boolean" || typeof entry.byok_allowed !== "boolean"
      || !["disabled", "unconfigured", "configured_unverified"].includes(entry.status))) throw failure();
  return entries;
}

export function checkProbeRun(organization: string, provider: ProviderId, run: ProbeRun) {
  const fields = ["schema_version", "id", "organization_id", "actor_id", "provider", "policy_version", "revision",
    "configuration_revision", "model", "expected_response_model", "response_model", "credential_source", "requested_mode",
    "mode", "status", "validation", "started_at", "worker_deadline_at", "finished_at", "latency_ms", "request_id",
    "input_tokens", "output_tokens", "error_code", "recovery"];
  if (!run || Object.keys(run).some(key => !fields.includes(key)) || run.schema_version !== "1" || !uuid.test(run.id)
    || run.organization_id !== organization || run.provider !== provider || typeof run.actor_id !== "string" || !run.actor_id.trim()
    || run.policy_version !== "synthetic-probe-1" || !positive(run.revision) || !positive(run.configuration_revision)
    || !model(run.model) || !model(run.expected_response_model) || !model(run.response_model)
    || !["server", "request"].includes(run.credential_source) || !["mock", "live"].includes(run.requested_mode)
    || !["disabled", "mock", "live", "fallback"].includes(run.mode)
    || !["pending", "succeeded", "unavailable", "failed", "invalid_output", "discarded", "interrupted"].includes(run.status)
    || !["not_run", "rejected", "synthetic_compatibility_valid"].includes(run.validation)
    || !date(run.started_at) || !date(run.worker_deadline_at) || Date.parse(run.worker_deadline_at) <= Date.parse(run.started_at)
    || (run.finished_at !== null && (!date(run.finished_at) || Date.parse(run.finished_at) < Date.parse(run.started_at)))
    || !measured(run.latency_ms) || !measured(run.input_tokens) || !measured(run.output_tokens)
    || (run.request_id !== null && (typeof run.request_id !== "string" || !/^[A-Za-z0-9_.:-]{1,200}$/.test(run.request_id)))
    || (run.error_code !== null && (typeof run.error_code !== "string" || !/^[a-z0-9_]{1,100}$/.test(run.error_code)))
    || (run.status === "pending" ? run.finished_at !== null : run.finished_at === null)
    || (run.credential_source === "request" && run.requested_mode !== "live")
    || (run.status === "succeeded" ? run.mode !== "live" || run.requested_mode !== "live"
      || run.validation !== "synthetic_compatibility_valid" || !run.model || !run.expected_response_model
      || run.response_model !== run.expected_response_model || run.error_code !== null
      : run.validation === "synthetic_compatibility_valid")) throw failure();
  const recovery = run.recovery;
  if (run.status === "interrupted") {
    if (!recovery || Object.keys(recovery).some(key => !["schema_version", "actor_id", "recovered_at", "previous_revision", "reason"].includes(key))
      || recovery.schema_version !== "1" || typeof recovery.actor_id !== "string" || !recovery.actor_id.trim()
      || recovery.previous_revision !== run.revision - 1 || !positive(recovery.previous_revision)
      || recovery.reason !== "worker_deadline_elapsed" || !date(recovery.recovered_at)
      || Date.parse(recovery.recovered_at) < Date.parse(run.worker_deadline_at)
      || recovery.recovered_at !== run.finished_at || run.error_code !== "probe_interrupted" || run.validation !== "not_run") throw failure();
  } else if (recovery) throw failure();
  return run;
}

export async function readProbeRecovery(organization: string, run: ProbeRun, signal: AbortSignal) {
  const ready = await api<ProbeRecoveryReadiness>(`${prefix}/tests/${run.id}/recovery-readiness`, { signal });
  if (ready.organization_id !== organization || ready.provider !== run.provider || ready.run_id !== run.id
    || ready.run_revision !== run.revision || ready.worker_deadline_at !== run.worker_deadline_at
    || typeof ready.can_recover !== "boolean" || !["eligible", "role_denied", "terminal", "worker_active"].includes(ready.reason)
    || ready.can_recover !== (ready.reason === "eligible") || ready.can_recover && run.status !== "pending") throw failure();
  return ready;
}

export async function recoverProbe(organization: string, actor: string, run: ProbeRun, ready: ProbeRecoveryReadiness, signal: AbortSignal) {
  const body: components["schemas"]["ProbeRecoveryRequest"] = { schema_version: "1", expected_provider: run.provider,
    expected_revision: ready.run_revision, expected_worker_deadline_at: ready.worker_deadline_at };
  const saved = checkProbeRun(organization, run.provider, await api<ProbeRun>(`${prefix}/tests/${run.id}/recover`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }));
  const mutable = ["revision", "status", "error_code", "finished_at", "recovery"];
  if (saved.id !== run.id || saved.status !== "interrupted" || saved.revision !== run.revision + 1
    || saved.recovery?.actor_id !== actor || Object.keys(run).some(key => !mutable.includes(key)
      && JSON.stringify(saved[key as keyof ProbeRun]) !== JSON.stringify(run[key as keyof ProbeRun]))) throw failure();
  return saved;
}

export async function readTestReadiness(organization: string, entry: CatalogEntry, signal: AbortSignal) {
  const ready = await api<ProbeReadiness>(`${prefix}/providers/${entry.provider}/test-readiness`, { signal });
  if (ready.organization_id !== organization || ready.provider !== entry.provider
    || ready.configuration_revision !== entry.configuration_revision || ready.model !== entry.model
    || ready.expected_response_model !== entry.expected_response_model || typeof ready.can_start !== "boolean"
    || ready.live_configured !== entry.live_configured || ready.byok_allowed !== entry.byok_allowed
    || (ready.pending_run_id !== null && !uuid.test(ready.pending_run_id))
    || (ready.next_start_at !== null && !date(ready.next_start_at))
    || ready.can_start && ready.pending_run_id !== null) throw failure();
  return ready;
}

export async function readTestHistory(organization: string, provider: ProviderId, signal: AbortSignal) {
  const runs = await api<ProbeRun[]>(`${prefix}/providers/${provider}/tests`, { signal });
  if (!Array.isArray(runs) || runs.length > 20 || new Set(runs.map(run => run.id)).size !== runs.length) throw failure();
  runs.forEach(run => checkProbeRun(organization, provider, run));
  return runs;
}

export async function readProbe(organization: string, provider: ProviderId, id: string, signal: AbortSignal) {
  if (!uuid.test(id)) throw failure();
  const run = checkProbeRun(organization, provider, await api<ProbeRun>(`${prefix}/tests/${id}`, { signal }));
  if (run.id !== id) throw failure();
  return run;
}

export async function startProbe(organization: string, actor: string, entry: CatalogEntry, mode: "mock" | "live", signal: AbortSignal, apiKey?: string) {
  const body: components["schemas"]["ProbeRequest"] = { schema_version: "1", mode,
    expected_configuration_revision: entry.configuration_revision, ...(apiKey ? { api_key: apiKey } : {}) };
  const run = checkProbeRun(organization, entry.provider, await api<ProbeRun>(`${prefix}/providers/${entry.provider}/test`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  }));
  if (run.actor_id !== actor || run.configuration_revision !== entry.configuration_revision || run.model !== entry.model
    || run.expected_response_model !== entry.expected_response_model || run.requested_mode !== mode
    || run.credential_source !== (apiKey ? "request" : "server")) throw failure();
  return run;
}
