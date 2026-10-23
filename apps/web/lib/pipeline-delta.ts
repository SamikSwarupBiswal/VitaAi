import type { PipelineRun } from "./api";

type Recommendation = PipelineRun["recommendations"][number];
type Context = PipelineRun["contexts"][number];

export type PipelineDelta = {
  accountId: string;
  kind: "entered_selection" | "left_selection" | "changed" | "unchanged";
  before: Recommendation | null;
  after: Recommendation | null;
  beforeContext: Context | null;
  afterContext: Context | null;
  caveats: string[];
};

export function comparePipelineRuns(before: PipelineRun, after: PipelineRun) {
  if (before.organization_id !== after.organization_id) throw new Error("Saved runs belong to different organizations.");
  if (before.id === after.id) throw new Error("Choose a different saved baseline run.");
  if (!Number.isFinite(Date.parse(before.started_at)) || !Number.isFinite(Date.parse(after.started_at))
    || Date.parse(before.started_at) > Date.parse(after.started_at)) throw new Error("Baseline must be dated no later than the displayed run.");
  for (const run of [before, after]) {
    const ids = new Set(run.contexts.map(context => context.account.id));
    const selected = new Set(run.recommendations.map(item => item.account_id));
    if (ids.size !== run.contexts.length || selected.size !== run.recommendations.length
      || run.contexts.some(context => context.account.organization_id !== run.organization_id
        || new Set(context.evidence.map(item => item.id)).size !== context.evidence.length
        || context.evidence.some(item => item.account_id !== context.account.id || item.organization_id !== run.organization_id))
      || run.recommendations.some(item => !ids.has(item.account_id))) throw new Error("Saved run context is inconsistent; comparison unavailable.");
  }
  const caveats = ["Historical comparison only. Changes do not establish cause, freshness, approval, execution or business impact.",
    "Entering or leaving a selected result does not mean an account was created, deleted or resolved."];
  if (before.request.intent !== after.request.intent || before.request.limit !== after.request.limit) {
    caveats.push("Intent or selection limit differs; rank and selection changes are not like-for-like priority drift.");
  }
  if (before.request.communicate !== after.request.communicate || before.request.communication_mode !== after.request.communication_mode) {
    caveats.push("Communication settings differ. Provider/template differences are not changes to account facts.");
  }
  if (before.as_of !== after.as_of) caveats.push("Assessment dates differ; elapsed time can change renewal and evidence eligibility without a new observation.");
  const accountIds = [...new Set([...after.recommendations.map(item => item.account_id), ...before.recommendations.map(item => item.account_id)])];
  const rows: PipelineDelta[] = accountIds.map(accountId => {
    const prior = before.recommendations.find(item => item.account_id === accountId) ?? null;
    const current = after.recommendations.find(item => item.account_id === accountId) ?? null;
    return {
      accountId,
      kind: !prior ? "entered_selection" : !current ? "left_selection"
        : prior.rank !== current.rank || prior.action.kind !== current.action.kind
          || prior.assessment.snapshot_hash !== current.assessment.snapshot_hash ? "changed" : "unchanged",
      before: prior, after: current,
      beforeContext: before.contexts.find(context => context.account.id === accountId) ?? null,
      afterContext: after.contexts.find(context => context.account.id === accountId) ?? null,
      caveats: prior && current && prior.assessment.policy_version !== current.assessment.policy_version
        ? ["Assessment policy differs; score and recommendation changes are not like-for-like."] : [],
    };
  });
  return { beforeId: before.id, afterId: after.id, beforeAt: before.started_at, afterAt: after.started_at,
    beforeAsOf: before.as_of, afterAsOf: after.as_of, caveats, rows };
}
