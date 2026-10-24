import { api, type PipelineRun } from "./api";
import type { components } from "./api.generated";

export type ResearchFusion = components["schemas"]["ResearchFusion"];
export const savedResearchId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function readSavedResearchFusion(current: PipelineRun, accountId: string, researchId: string, signal: AbortSignal) {
  const selected = current.recommendations.filter(item => item.account_id === accountId);
  const inputs = current.contexts.filter(item => item.account.id === accountId);
  if (!savedResearchId.test(current.id) || !savedResearchId.test(researchId) || selected.length !== 1 || inputs.length !== 1) {
    throw new Error("Choose a saved research run for this recommendation.");
  }
  const value = await api<ResearchFusion>(`pipeline/${current.id}/research/${researchId}`, { signal });
  const context = value.research_context, view = context.internal, specialist = value.research_specialist;
  if (value.policy_version !== "saved-research-fusion-1" || value.external_execution !== false
    || value.pipeline_run_id !== current.id || value.pipeline_started_at !== current.started_at
    || value.account_id !== accountId || value.organization_id !== current.organization_id
    || view.account.organization_id !== current.organization_id || view.account.id !== accountId
    || context.retained_run.organization_id !== current.organization_id || context.retained_run.account_id !== accountId
    || context.retained_run.id !== researchId || specialist.research_run_id !== researchId
    || specialist.context_expires_at !== context.retained_run.expires_at || specialist.role !== "research"
    || specialist.factual_confidence !== "unverified" || context.factual_confidence !== "unverified"
    || canonical(value.recommendation) !== canonical(selected[0]) || canonical(view.account) !== canonical(inputs[0].account)
    || canonical(view.assessment) !== canonical(selected[0].assessment)
    || canonical([...view.evidence].sort((a, b) => a.id.localeCompare(b.id)))
      !== canonical([...inputs[0].evidence].sort((a, b) => a.id.localeCompare(b.id)))
    || specialist.status !== (context.status === "usable" ? "supporting_context" : "missing_source")
    || canonical(specialist.findings) !== canonical(context.status === "usable" ? context.brief?.verification_questions ?? [] : [])) {
    throw new Error("Saved research or recommendation binding changed. Refresh and inspect again.");
  }
  return value;
}
