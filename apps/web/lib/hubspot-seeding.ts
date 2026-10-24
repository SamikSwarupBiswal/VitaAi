import { api, type AccountView } from "./api";
import type { components } from "./api.generated";
import { accountPath } from "./hubspot";

export type SeedJob = components["schemas"]["SeedJob"];
export type SeedReadiness = components["schemas"]["SeedReadiness"];
export type SeedInspection = components["schemas"]["SeedInspection"];
export type SeedOptions = { count: number; include_contacts: boolean; include_notes: boolean; include_deals: boolean };
export type SeedOperation = "approved" | "rejected" | "execute" | "reconcile" | "recover";
export const seedId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const hash = /^[a-f0-9]{64}$/;
const prefix = "integrations/hubspot/seeds";
const timestamp = (value: unknown): value is string => typeof value === "string"
  && /(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
function deny(): never { throw new Error("Seed record binding changed. Refresh and inspect again."); }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function checkSeedJob(view: AccountView, job: SeedJob, id?: string): SeedJob {
  const preview = job.preview;
  if (job.operation === "archive" && (!job.source_job_id || !seedId.test(job.source_job_id)
    || !job.items.some(item => item.archive_selected) || job.items.some(item => item.archive_selected
      && (!item.archive_target_id || !/^[1-9][0-9]{0,19}$/.test(item.archive_target_id))))) deny();
  if (!seedId.test(job.id) || (id && job.id !== id) || job.organization_id !== view.account.organization_id
    || job.account_id !== view.account.id || !Number.isInteger(job.account_revision) || job.account_revision < 1
    || !Number.isInteger(job.revision) || job.revision < 1 || !Number.isInteger(job.sequence) || job.sequence < 1
    || job.policy !== "synthetic-company-seed-1" || !hash.test(job.binding_hash) || !timestamp(job.expires_at)
    || !timestamp(job.last_event_at) || !job.last_actor_id || !["draft", "approved", "rejected", "claimed", "executing", "succeeded", "failed", "result_unknown", "interrupted"].includes(job.status ?? "")
    || preview.id !== ((job.operation ?? "create") === "archive" ? job.source_job_id : job.id)
    || preview.account_id !== job.account_id || ((job.operation ?? "create") === "create" && preview.account_revision !== job.account_revision)
    || preview.organization_id !== job.organization_id || preview.portal_id !== job.test_portal_id
    || preview.mode !== "preview" || preview.execution_available !== false || preview.method !== "POST"
    || preview.path !== "/crm/v3/objects/companies" || !hash.test(preview.preview_hash)
    || !hash.test(preview.configuration_hash) || !timestamp(preview.created_at)
    || !/^[1-9][0-9]{0,19}$/.test(job.test_portal_id) || !Array.isArray(job.items)
    || job.items.length < 1 || job.items.length > 12
    || preview.companies.length !== job.items.filter(item => item.object_type === "companies").length) deny();
  let companyOrdinal = 0;
  for (const [index, item] of job.items.entries()) {
    let parsed: { properties?: Record<string, unknown> };
    try { parsed = JSON.parse(item.provider_request); } catch { deny(); }
    if (item.index !== index || !parsed || Object.keys(parsed).join() !== "properties" || !parsed.properties
      || canonical(parsed) !== item.provider_request
      || !["ready", "dispatching", "succeeded", "failed", "result_unknown", "skipped"].includes(item.status ?? "")
      || (item.resource_id != null && !/^[1-9][0-9]{0,19}$/.test(item.resource_id))
      || (item.status === "succeeded" && (item.verification !== "verified" || !item.resource_id
        || !timestamp(item.verified_at) || !hash.test(item.verified_request_hash ?? "")))) deny();
    let expected: unknown = parsed;
    if (item.object_type === "companies") {
      const company = preview.companies[companyOrdinal++];
      if (!company || !company.name.includes(preview.id) || !company.description.includes(preview.id)
        || item.parent_index != null || item.association_type_id != null
        || canonical(parsed.properties) !== canonical(company)) deny();
    } else {
      const types = { contacts: 279, notes: 190, deals: 5 } as const;
      if (!item.object_type || !(item.object_type in types) || !Number.isInteger(item.parent_index)
        || item.parent_index == null || item.parent_index < 0 || item.parent_index >= index
        || item.association_type_id !== types[item.object_type]) deny();
      const parent = job.items[item.parent_index];
      if (parent.object_type !== "companies") deny();
      const parentProperties = JSON.parse(parent.provider_request).properties;
      const properties = parsed.properties;
      if (item.object_type === "contacts" ? canonical(properties) !== canonical({ firstname: "VitaAi synthetic",
        lastname: parentProperties.name, jobtitle: "Synthetic demonstration only; no real contact" })
        : item.object_type === "notes" ? Object.keys(properties).sort().join() !== "hs_note_body,hs_timestamp"
          || properties.hs_note_body !== parentProperties.description || !timestamp(properties.hs_timestamp)
          || Date.parse(properties.hs_timestamp) !== Date.parse(preview.created_at)
        : Object.keys(properties).sort().join() !== "dealname,dealstage,pipeline"
          || properties.dealname !== `${parentProperties.name} synthetic deal`
          || typeof properties.pipeline !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(properties.pipeline)
          || typeof properties.dealstage !== "string" || !/^[A-Za-z0-9_-]{1,100}$/.test(properties.dealstage)) deny();
      const parentId = job.operation === "archive" ? parent.archive_target_id : parent.resource_id;
      expected = { properties, associations: [{ to: { id: parentId }, types: [{
        associationCategory: "HUBSPOT_DEFINED", associationTypeId: item.association_type_id }] }] };
      if (item.resolved_request != null && (job.operation === "archive" ? !parentId
        : !parent.resource_id || parent.status !== "succeeded" || parent.verification !== "verified")) deny();
    }
    if (item.resolved_request != null && item.resolved_request !== canonical(expected)) deny();
    if (["dispatching", "succeeded", "failed", "result_unknown"].includes(item.status ?? "") && !item.resolved_request) deny();
  }
  for (const date of [job.reviewed_at, job.review_expires_at, job.claimed_at, job.worker_deadline_at, job.finished_at, job.recovered_at]) {
    if (date != null && !timestamp(date)) deny();
  }
  return job;
}

export async function prepareSeedCleanup(view: AccountView, selected: SeedInspection, indices: number[], signal: AbortSignal) {
  if (!selected.can_prepare_cleanup || selected.job.operation === "archive" || !indices.length
    || new Set(indices).size !== indices.length || indices.some(index => !Number.isInteger(index)
      || selected.job.items[index]?.status !== "succeeded" || selected.job.items[index]?.verification !== "verified")) deny();
  const job = await api<SeedJob>(`${prefix}/${selected.job.id}/cleanup-preview`, { method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_revision: selected.job.revision,
      expected_account_revision: selected.account_revision, binding_hash: selected.job.binding_hash, item_indices: indices }) });
  checkSeedJob(view, job);
  if (job.operation !== "archive" || job.source_job_id !== selected.job.id || job.status !== "draft"
    || job.items.filter(item => item.archive_selected).map(item => item.index).sort().join() !== [...indices].sort().join()) deny();
  return job;
}

export async function readSeedReadiness(view: AccountView, signal: AbortSignal) {
  const current = await api<AccountView>(`accounts/${view.account.id}`, { signal });
  const ready = await api<SeedReadiness>(`${accountPath(view.account.id)}/seeds/readiness`, { signal });
  if (current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.assessment.snapshot_hash !== view.assessment.snapshot_hash
    || (current.source?.id ?? null) !== (view.source?.id ?? null) || ready.organization_id !== view.account.organization_id
    || ready.account_id !== view.account.id || ready.account_revision !== view.account.revision
    || !hash.test(ready.configuration_hash) || (ready.blocking_job_id != null && !seedId.test(ready.blocking_job_id))
    || (ready.can_prepare && (!ready.configured || ready.blocking_job_id || !ready.test_portal_id
      || ready.test_portal_id !== ready.portal_id))) deny();
  return ready;
}

export async function readSeedHistory(view: AccountView, signal: AbortSignal) {
  const values = await api<SeedJob[]>(`${accountPath(view.account.id)}/seeds`, { signal });
  if (!Array.isArray(values) || values.length > 20 || new Set(values.map(item => item.id)).size !== values.length) deny();
  return values.map(job => checkSeedJob(view, job));
}

export async function inspectSeed(view: AccountView, id: string, signal: AbortSignal) {
  if (!seedId.test(id)) deny();
  const value = await api<SeedInspection>(`${prefix}/${id}`, { signal });
  checkSeedJob(view, value.job, id);
  if (value.account_revision !== view.account.revision || [value.can_review, value.can_execute, value.can_reconcile, value.can_recover]
    .some(flag => typeof flag !== "boolean") || (value.can_review && value.job.status !== "draft")
    || (value.can_execute && value.job.status !== "approved")
    || (value.can_reconcile && value.job.status !== "result_unknown")
    || (value.can_recover && (!["claimed", "executing"].includes(value.job.status ?? "") || !value.job.worker_deadline_at))) deny();
  return value;
}

export async function readSeedVersions(view: AccountView, selected: SeedInspection, signal: AbortSignal) {
  const rows = await api<SeedJob[]>(`${prefix}/${selected.job.id}/versions`, { signal });
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100
    || rows.at(-1)?.revision !== selected.job.revision) deny();
  rows.forEach((job, index) => {
    checkSeedJob(view, job, selected.job.id);
    if (job.binding_hash !== selected.job.binding_hash || (index && job.revision !== rows[index - 1].revision + 1)) deny();
  });
  return rows;
}

export async function prepareSeed(view: AccountView, ready: SeedReadiness, options: SeedOptions, signal: AbortSignal) {
  const { count } = options;
  if (!ready.can_prepare || ready.account_id !== view.account.id || ready.account_revision !== view.account.revision
    || !Number.isInteger(count) || count < 1 || count > 3 || (options.include_deals && !ready.deal_seed_available)) deny();
  const job = await api<SeedJob>(`${accountPath(view.account.id)}/seeds`, { method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_account_revision: ready.account_revision,
      expected_configuration_hash: ready.configuration_hash, ...options }) });
  checkSeedJob(view, job);
  const expectedItems = count * (1 + Number(options.include_contacts) + Number(options.include_notes) + Number(options.include_deals));
  if (job.preview.configuration_hash !== ready.configuration_hash || job.items.length !== expectedItems || job.status !== "draft"
    || job.items.filter(item => item.object_type === "contacts").length !== (options.include_contacts ? count : 0)
    || job.items.filter(item => item.object_type === "notes").length !== (options.include_notes ? count : 0)
    || job.items.filter(item => item.object_type === "deals").length !== (options.include_deals ? count : 0)) deny();
  return job;
}

export async function mutateSeed(view: AccountView, selected: SeedInspection, operation: SeedOperation, reason: string, signal: AbortSignal) {
  checkSeedJob(view, selected.job);
  const review = operation === "approved" || operation === "rejected";
  if (selected.account_revision !== view.account.revision || (review && (!selected.can_review || !reason.trim()))
    || (operation === "execute" && !selected.can_execute) || (operation === "reconcile" && !selected.can_reconcile)
    || (operation === "recover" && !selected.can_recover)) deny();
  const body = { expected_revision: selected.job.revision, expected_account_revision: selected.account_revision,
    binding_hash: selected.job.binding_hash, ...(review ? { decision: operation, reason } : {}),
    ...(operation === "recover" ? { expected_worker_deadline_at: selected.job.worker_deadline_at } : {}) };
  const job = await api<SeedJob>(`${prefix}/${selected.job.id}/${review ? "review" : operation}`, {
    method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  checkSeedJob(view, job, selected.job.id);
  if (job.revision <= selected.job.revision || job.binding_hash !== selected.job.binding_hash) deny();
  return job;
}
