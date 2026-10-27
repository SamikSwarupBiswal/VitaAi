import type { components } from "./api.generated";
import { savedRunId } from "./pipeline-history";

export type Scenario = components["schemas"]["Scenario"];
export type TrendReport = components["schemas"]["TrendReport"];
export type PromotedScenario = components["schemas"]["PromotedScenario"];
export type ScenarioOverrides = components["schemas"]["ScenarioOverrides"];
const hash = /^[a-f0-9]{64}$/;
const metricUnits = { usage_change: "percent", support_cases: "count", expansion: "score/100", renewal: "days" } as const;

export function explicitInstant(text: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) throw new Error("Use an ISO date and time with an explicit timezone");
  const value = new Date(text);
  if (!Number.isFinite(value.getTime())) throw new Error("Use a valid date and time");
  const date = text.slice(0, 10), calendar = new Date(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 10) !== date) throw new Error("Use a valid calendar date");
  return value.toISOString();
}

export function intelligenceScope<T extends { id: string; organization_id: string; account_id: string; revision: number }>(value: T, organization: string, account: string): T {
  if (!savedRunId.test(value.id) || value.organization_id !== organization || value.account_id !== account
    || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error("Intelligence scope changed");
  return value;
}

export function scenarioScope(value: Scenario, organization: string, account: string): Scenario {
  intelligenceScope(value, organization, account);
  if (value.mode !== "simulation" || value.policy_version !== "what-if-1" || value.model_version !== "none-deterministic"
    || !savedRunId.test(value.request.pipeline_id) || !savedRunId.test(value.request.request_id) || !hash.test(value.projection_hash)
    || !hash.test(value.request.expected_snapshot_hash) || value.baseline.account.id !== account || value.baseline.account.organization_id !== organization
    || value.baseline.assessment.snapshot_hash !== value.request.expected_snapshot_hash
    || value.projected.as_of !== value.baseline.assessment.as_of || value.projected.policy_version !== value.baseline.assessment.policy_version
    || new Set(value.baseline.evidence.map(item => item.id)).size !== value.baseline.evidence.length
    || value.baseline.evidence.some(item => item.account_id !== account || item.organization_id !== organization)) throw new Error("Scenario source changed");
  return value;
}

export function scenarioRequestMatches(value: Scenario, expected: components["schemas"]["ScenarioRequest"]): boolean {
  const actual = value.request;
  return actual.request_id === expected.request_id && actual.pipeline_id === expected.pipeline_id
    && actual.expected_snapshot_hash === expected.expected_snapshot_hash && actual.title === expected.title
    && JSON.stringify(actual.assumptions) === JSON.stringify(expected.assumptions)
    && (["usage_change", "support_cases", "expansion", "renewal_days"] as const)
      .every(key => (actual.overrides[key] ?? null) === (expected.overrides[key] ?? null));
}

export function promotionScope(value: PromotedScenario, scenario: Scenario, organization: string, account: string, currentHash?: string): PromotedScenario {
  intelligenceScope(value, organization, account);
  if (value.scenario_id !== scenario.id || value.scenario_projection_hash !== scenario.projection_hash || value.approval_status !== "unapproved"
    || !savedRunId.test(value.plan.id) || value.plan.organization_id !== organization || value.plan.account_id !== account
    || value.plan.evidence.account_id !== account || value.plan.pipeline_run_id !== scenario.request.pipeline_id
    || value.plan.source !== "deterministic" || value.plan.status !== "valid" || value.plan.validation !== "valid"
    || !hash.test(value.plan.evidence.snapshot_hash) || currentHash !== undefined && value.plan.evidence.snapshot_hash !== currentHash
    || !value.plan.caveats.some(text => text.includes(scenario.id) && text.includes(scenario.projection_hash))) throw new Error("Promotion binding changed");
  return value;
}

export function trendScope(value: TrendReport, organization: string, account: string): TrendReport {
  intelligenceScope(value, organization, account);
  const ids = value.request.pipeline_ids;
  const first = explicitInstant(value.request.start), last = explicitInstant(value.request.end);
  if (new Date(first) > new Date(last) || value.policy_version !== "trend-1" || !["observed_history", "synthetic_history"].includes(value.mode)
    || new Set(ids).size !== ids.length || ids.length < 2 || ids.length > 50 || ids.some(id => !savedRunId.test(id))
    || value.input_count !== ids.length || value.available_count !== ids.length
    || value.metrics.length !== 4 || new Set(value.metrics.map(item => item.metric)).size !== 4
    || value.metrics.some(metric => !Object.hasOwn(metricUnits, metric.metric) || metric.unit !== metricUnits[metric.metric]
      || ![metric.duplicate_count, metric.corrected_count, metric.excluded_count].every(count => Number.isSafeInteger(count) && count >= 0)
      || metric.points.some((point, index) => !ids.includes(point.pipeline_id) || !Number.isFinite(point.value) || !hash.test(point.snapshot_hash)
        || new Date(explicitInstant(point.observed_at)) < new Date(first) || new Date(explicitInstant(point.observed_at)) > new Date(last)
        || !explicitInstant(point.saved_at) || index > 0 && new Date(point.observed_at) < new Date(metric.points[index - 1].observed_at))
      || metric.delta !== null && !Number.isFinite(metric.delta) || metric.per_day !== null && !Number.isFinite(metric.per_day)
      || ["insufficient", "incompatible_sources", "conflicting"].includes(metric.status) && (metric.delta !== null || metric.per_day !== null)
      || metric.status === "gapped" && metric.per_day !== null || metric.status === "unchanged" && metric.delta !== 0
      || ["observed", "unchanged", "gapped"].includes(metric.status) && new Set(metric.points.map(point => point.source)).size > 1)) throw new Error("Trend source changed");
  return value;
}

export function parseOverrides(values: Record<string, string>): ScenarioOverrides {
  const result: Record<string, number> = {};
  for (const key of ["usage_change", "support_cases", "expansion", "renewal_days"]) {
    const text = values[key]?.trim();
    if (!text) continue;
    const value = Number(text);
    const [min, max] = { usage_change: [-100, 1000], support_cases: [0, 100000], expansion: [0, 100], renewal_days: [0, 3650] }[key]!;
    if (!Number.isFinite(value) || value < min || value > max || ((key === "support_cases" || key === "renewal_days") && !Number.isInteger(value))) throw new Error("Use values within the allowed ranges and whole case/day counts");
    result[key] = value;
  }
  if (!Object.keys(result).length) throw new Error("Enter at least one explicit assumption value");
  return { schema_version: "1", ...result };
}

export function trendIds(text: string): string[] {
  const ids = text.split(/[\s,]+/).filter(Boolean);
  if (ids.length < 2 || ids.length > 50 || new Set(ids).size !== ids.length || ids.some(id => !savedRunId.test(id))) throw new Error("Choose 2–50 distinct saved run IDs");
  return ids;
}
