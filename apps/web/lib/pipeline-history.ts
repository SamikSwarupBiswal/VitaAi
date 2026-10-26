import type { PipelineRun } from "./api";
import type { components } from "./api.generated";
import { savedRunInstant } from "./pipeline-delta";

export type PipelineHistory = components["schemas"]["PipelineHistory"];
export type PipelineRunSummary = components["schemas"]["PipelineRunSummary"];
export const savedRunId = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
const unique = (values: string[]) => Array.isArray(values) && values.every(value => typeof value === "string" && value.length > 0)
  && new Set(values).size === values.length;
const requestKey = (request: PipelineRun["request"]) => JSON.stringify([
  request.intent, request.limit, request.communicate, request.communication_mode,
]);

export function validatePipelineHistory(saved: PipelineHistory, organizationId: string): PipelineHistory {
  const counts = [saved.total_count, saved.window_count, saved.undated_count, saved.unavailable_count];
  if (saved.organization_id !== organizationId || saved.limit !== 20 || counts.some(value => !Number.isSafeInteger(value) || value < 0)
    || saved.undated_count > saved.total_count || saved.window_count !== Math.min(20, saved.total_count - saved.undated_count)
    || !Array.isArray(saved.items) || saved.items.length + saved.unavailable_count !== saved.window_count
    || saved.has_more !== (saved.total_count - saved.undated_count > saved.window_count)
    || new Set(saved.items.map(item => item.id)).size !== saved.items.length) throw new Error("Saved history coverage changed");
  saved.items.forEach((item, index) => {
    const instant = savedRunInstant(item.started_at), prior = saved.items[index - 1];
    if (!savedRunId.test(item.id) || !unique(item.input_account_ids) || !unique(item.selected_account_ids)
      || item.selected_account_ids.some(id => !item.input_account_ids.includes(id))
      || (prior && (savedRunInstant(prior.started_at) < instant || (savedRunInstant(prior.started_at) === instant && prior.id < item.id)))) {
      throw new Error("Saved history order or scope changed");
    }
  });
  return saved;
}

export function validateSavedPipelineRun(run: PipelineRun, organizationId: string, id: string, summary?: PipelineRunSummary, accountId?: string): PipelineRun {
  const inputs = run.contexts.map(context => context.account.id), selected = run.recommendations.map(item => item.account_id);
  if (run.id !== id || run.organization_id !== organizationId || !unique(inputs) || !unique(selected)
    || selected.some(selectedId => !inputs.includes(selectedId)) || (accountId !== undefined && !inputs.includes(accountId))
    || run.contexts.some(context => context.account.organization_id !== organizationId
      || !unique(context.evidence.map(fact => fact.id))
      || context.evidence.some(fact => fact.organization_id !== organizationId || fact.account_id !== context.account.id))) {
    throw new Error("Saved run scope changed");
  }
  if (summary && (run.started_at !== summary.started_at || run.actor_id !== summary.actor_id || run.as_of !== summary.as_of
    || run.status !== summary.status || requestKey(run.request) !== requestKey(summary.request)
    || JSON.stringify(inputs) !== JSON.stringify(summary.input_account_ids)
    || JSON.stringify(selected) !== JSON.stringify(summary.selected_account_ids))) throw new Error("Saved run summary changed");
  return run;
}

export function hasOrderedDate(run: PipelineRun): boolean {
  try { savedRunInstant(run.started_at); return true; } catch { return false; }
}
