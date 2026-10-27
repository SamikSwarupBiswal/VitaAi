"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { explicitInstant, parseOverrides, promotionScope, scenarioRequestMatches, scenarioScope, trendIds, trendScope, type PromotedScenario, type Scenario, type TrendReport } from "@/lib/intelligence";
import { savedRunId } from "@/lib/pipeline-history";
import { useSession } from "./session-gate";

type Pipeline = components["schemas"]["PipelineRun"];
type Mission = components["schemas"]["Mission"];
const fields = [["usage_change", "Usage change (%)"], ["support_cases", "Unresolved support cases"], ["expansion", "Expansion interest (0–100)"], ["renewal_days", "Days until renewal"]] as const;

export function IntelligencePage() {
  const account = useSearchParams().get("account"), actor = useSession()?.actor;
  if (!account || !savedRunId.test(account) || !actor) return <main><h1>Decision and trend intelligence</h1><p>Select an accessible account to begin.</p><a href="/accounts">Open accounts</a></main>;
  return <IntelligenceWorkspace account={account} organization={actor.organization_id} canWrite={actor.role !== "viewer"} key={JSON.stringify([actor.id, actor.role, actor.organization_id, account])} />;
}

export function IntelligenceWorkspace({ account, organization, canWrite }: { account: string; organization: string; canWrite: boolean }) {
  const [view, setView] = useState<AccountView | null>(null), [baseline, setBaseline] = useState<Pipeline | null>(null);
  const [runId, setRunId] = useState(""), [title, setTitle] = useState(""), [assumption, setAssumption] = useState("");
  const [values, setValues] = useState<Record<string, string>>({}), [scenario, setScenario] = useState<Scenario | null>(null);
  const [scenarioList, setScenarioList] = useState<Scenario[]>([]), [reportList, setReportList] = useState<TrendReport[]>([]);
  const [report, setReport] = useState<TrendReport | null>(null), [promotion, setPromotion] = useState<PromotedScenario | null>(null);
  const [promotedMissions, setPromotedMissions] = useState<Mission[]>([]), [checkedPlan, setCheckedPlan] = useState<string | null>(null);
  const [ack, setAck] = useState(""), [idsText, setIdsText] = useState(""), [start, setStart] = useState(""), [end, setEnd] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [writeBlocked, setWriteBlocked] = useState(false), [tick, setTick] = useState(0);
  const life = useRef({ alive: false, epoch: 0, pending: false, uncertain: false, attempted: false, controller: null as AbortController | null });
  const epoch = life.current.epoch;

  useEffect(() => {
    const state = life.current; state.alive = true;
    const invalidate = () => {
      if (state.attempted) { state.uncertain = true; setWriteBlocked(true); }
      state.controller?.abort(); state.epoch++; state.pending = false;
      setPending(false); setView(null); setBaseline(null); setScenario(null); setReport(null); setPromotion(null); setScenarioList([]); setReportList([]); setPromotedMissions([]); setCheckedPlan(null);
      setTick(value => value + 1);
    };
    const events = ["focus", "vitaai-source-changed", "vitaai-workflow-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => { state.alive = false; state.controller?.abort(); state.epoch++; events.forEach(name => window.removeEventListener(name, invalidate)); };
  }, [account, organization]);

  const valid = () => life.current.alive && life.current.epoch === epoch;
  const run = async (work: (signal: AbortSignal) => Promise<() => void>) => {
    const state = life.current;
    if (!valid() || state.pending) return;
    state.pending = true; state.attempted = false; setPending(true); setError(""); const controller = new AbortController(); state.controller = controller;
    try { const publish = await work(controller.signal); if (valid() && !controller.signal.aborted) {
      state.pending = false; state.attempted = false; setPending(false); state.epoch++; setTick(value => value + 1); publish();
    } }
    catch (failure) { if (valid() && !controller.signal.aborted) {
      if (state.attempted) { state.uncertain = true; setWriteBlocked(true); }
      state.pending = false; state.attempted = false; setPending(false); state.epoch++; setTick(value => value + 1);
      setError(failure instanceof Error ? failure.message : "Request unavailable. Inspect saved history before retrying a write.");
    } }
    finally { if (valid() && state.controller === controller) { state.pending = false; setPending(false); } }
  };
  const write = <T,>(path: string, body: unknown, signal: AbortSignal) => {
    const state = life.current;
    if (!valid() || !state.pending || state.uncertain || signal.aborted) throw new Error("Inspect saved scenarios and trends, then rebind the exact inputs before another write");
    state.attempted = true;
    return api<T>(path, { signal, method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  };
  const change = (action: () => void) => { if (!valid() || life.current.pending) return; life.current.epoch++; action(); setError(""); setTick(value => value + 1); };
  const inspect = () => run(async signal => {
    const current = await api<AccountView>(`accounts/${account}`, { signal });
    if (current.account.id !== account || current.account.organization_id !== organization) throw new Error("Account scope changed");
    return () => setView(current);
  });
  const readHistory = () => run(async signal => {
    const [saved, trends] = await Promise.all([api<Scenario[]>(`intelligence/accounts/${account}/scenarios`, { signal }), api<TrendReport[]>(`intelligence/accounts/${account}/trends`, { signal })]);
    saved.forEach(item => scenarioScope(item, organization, account)); trends.forEach(item => trendScope(item, organization, account));
    return () => {
      setScenarioList(saved); setReportList(trends); setScenario(null); setReport(null); setPromotion(null); setAck(""); setPromotedMissions([]); setCheckedPlan(null);
      if (life.current.uncertain) {
        life.current.uncertain = false; setWriteBlocked(false); setView(null); setBaseline(null); setRunId("");
        setTitle(""); setAssumption(""); setValues({}); setIdsText(""); setStart(""); setEnd("");
      }
    };
  });
  const inspectBaseline = () => run(async signal => {
    if (!savedRunId.test(runId)) throw new Error("Enter an exact saved run ID");
    const saved = await api<Pipeline>(`pipeline/${runId}`, { signal });
    const context = saved.contexts.filter(item => item.account.id === account), recommended = saved.recommendations.filter(item => item.account_id === account);
    if (saved.id !== runId || saved.organization_id !== organization || context.length !== 1 || recommended.length !== 1
      || context[0].account.organization_id !== organization) throw new Error("Saved run does not contain this account's recommendation");
    return () => { setBaseline(saved); setScenario(null); setPromotion(null); };
  });
  const saveScenario = () => run(async signal => {
    if (!baseline || !canWrite) return () => {};
    const recommendation = baseline.recommendations.find(item => item.account_id === account)!;
    const overrides = parseOverrides(values);
    const request: components["schemas"]["ScenarioRequest"] = {
      schema_version: "1",
      request_id: crypto.randomUUID(), pipeline_id: baseline.id, expected_snapshot_hash: recommendation.assessment.snapshot_hash,
      title, assumptions: [assumption], overrides,
    };
    const result = scenarioScope(await write<Scenario>(`intelligence/accounts/${account}/scenarios`, request, signal), organization, account);
    if (!scenarioRequestMatches(result, request)) throw new Error("Scenario request binding changed");
    return () => { setScenario(result); setPromotion(null); };
  });
  const promote = () => run(async signal => {
    if (!scenario || !view || !canWrite) return () => {};
    const result = promotionScope(await write<PromotedScenario>(`intelligence/scenarios/${scenario.id}/promotion`, {
      expected_revision: scenario.revision, expected_current_snapshot_hash: view.assessment.snapshot_hash, assumption_acknowledgement: ack,
    }, signal), scenario, organization, account, view.assessment.snapshot_hash);
    if (result.assumption_acknowledgement !== ack) throw new Error("Promotion acknowledgement changed");
    return () => { setPromotion(result); setPromotedMissions([]); setCheckedPlan(null); };
  });
  function promotedMission(item: Mission, plan: PromotedScenario["plan"]): Mission {
    if (!savedRunId.test(item.id) || item.organization_id !== organization || item.account_id !== account
      || item.plan_id !== plan.id || item.plan_revision !== plan.revision || item.template !== "account-action-1"
      || item.evidence.account_id !== account || item.evidence.snapshot_hash !== plan.evidence.snapshot_hash) throw new Error("Promoted mission binding changed");
    return item;
  }
  const inspectPromotedMissions = () => run(async signal => {
    if (!promotion) throw new Error("Inspect the saved promotion first");
    const values = await api<Mission[]>("missions", { signal });
    if (values.some(item => item.organization_id !== organization) || new Set(values.map(item => item.id)).size !== values.length) throw new Error("Mission scope changed");
    const selected = values.filter(item => item.plan_id === promotion.plan.id).map(item => promotedMission(item, promotion.plan));
    return () => { setPromotedMissions(selected); setCheckedPlan(promotion.plan.id); };
  });
  const startPromotedMission = () => run(async signal => {
    if (!promotion || checkedPlan !== promotion.plan.id || promotedMissions.length || !canWrite) return () => {};
    setCheckedPlan(null);
    const item = promotedMission(await write<Mission>("missions", { plan_id: promotion.plan.id, expected_revision: promotion.plan.revision,
      template: "account-action-1", alternative_id: promotion.plan.selected_alternative_id }, signal), promotion.plan);
    if (item.status !== "draft" || item.current_step !== "Review") throw new Error("Mission was not created as an unapproved draft");
    return () => { setPromotedMissions([item]); setCheckedPlan(promotion.plan.id); };
  });
  const buildTrend = () => run(async signal => {
    if (!canWrite) return () => {};
    const pipeline_ids = trendIds(idsText), first = explicitInstant(start), last = explicitInstant(end);
    if (new Date(first) > new Date(last)) throw new Error("Range end must follow its start");
    const result = trendScope(await write<TrendReport>(`intelligence/accounts/${account}/trends`, { pipeline_ids, start: first, end: last }, signal), organization, account);
    if (JSON.stringify(result.request.pipeline_ids) !== JSON.stringify(pipeline_ids)
      || explicitInstant(result.request.start) !== first || explicitInstant(result.request.end) !== last) throw new Error("Trend request binding changed");
    return () => setReport(result);
  });

  return <main style={{ overflowWrap: "anywhere" }} data-generation={tick}><h1>Decision and trend intelligence</h1><a href={`/accounts?${new URLSearchParams({ account })}`}>Return to account workspace</a>
    <p>What-if assumptions stay separate from observed facts. Nothing here approves or executes a customer action.</p>
    <button disabled={pending} onClick={inspect}>Inspect current account</button> <button disabled={pending} onClick={readHistory}>Inspect saved scenarios and trends</button>
    {view && <p>Current account: {view.account.name}. Snapshot {view.assessment.snapshot_hash}. As of {view.assessment.as_of}.</p>}
    {error && <p role="alert">{error} Inspect saved history after an uncertain write; do not replay automatically.</p>}{pending && <p role="status">Reading or saving selected analysis…</p>}
    {writeBlocked && <p role="alert">A write may already be saved. Inspect saved scenarios and trends before rebinding new inputs; writes are paused.</p>}
    <section aria-labelledby="scenario-heading"><h2 id="scenario-heading">Decision Intelligence Studio</h2>
      <label>Exact saved recommendation run <input value={runId} disabled={pending} onChange={event => change(() => { setRunId(event.target.value); setBaseline(null); setScenario(null); })} /></label>
      <button disabled={pending} onClick={inspectBaseline}>Inspect baseline</button>
      {baseline && <p>Original saved run {baseline.id}, author {baseline.actor_id ?? "Unknown"}, saved {baseline.started_at}. Baseline records remain unchanged.</p>}
      {canWrite && <fieldset disabled={pending || writeBlocked || !baseline}><legend>Explicit simulation assumptions</legend>
        <label>Scenario title <input maxLength={2000} value={title} onChange={event => change(() => setTitle(event.target.value))} /></label>
        <label>Assumption and uncertainty <textarea maxLength={2000} value={assumption} onChange={event => change(() => setAssumption(event.target.value))} /></label>
        {fields.map(([name, label]) => <label key={name}>{label}<input inputMode="decimal" value={values[name] ?? ""} placeholder="Leave blank to preserve baseline" onChange={event => change(() => setValues({ ...values, [name]: event.target.value }))} /></label>)}
        <button disabled={!title.trim() || !assumption.trim()} onClick={saveScenario}>Save what-if scenario</button>
      </fieldset>}
      <p>Saved history shows at most 20 records in stable ID order. Retained exact IDs remain available through the API.</p>
      {scenarioList.map(item => <button key={item.id} disabled={pending} onClick={() => change(() => { setScenario(item); setPromotion(null); setAck(""); })}>{item.request.title} — {item.created_at}</button>)}
      {scenario && <article><h3>{scenario.request.title} — simulation</h3><p>Scenario {scenario.id}; author {scenario.author_id}; {scenario.created_at}; {scenario.policy_version}; {scenario.model_version}.</p>
        <ul>{scenario.request.assumptions.map((text, index) => <li key={index}>{text}</li>)}</ul><p>Explicit overrides: {JSON.stringify(scenario.request.overrides)}</p>
        <table><caption>Baseline versus hypothetical projection</caption><thead><tr><th>Metric</th><th>Baseline</th><th>Projection</th></tr></thead><tbody>
          {(["risk", "opportunity", "health"] as const).map(metric => <tr key={metric}><th>{metric}</th><td>{scenario.baseline.assessment[metric]}</td><td>{scenario.projected[metric]}</td></tr>)}
          {scenario.baseline.assessment.factors.map(factor => { const projected = scenario.projected.factors.find(item => item.metric === factor.metric); return <tr key={factor.metric}><th>{factor.metric} (risk / opportunity contribution)</th><td>{factor.value ?? "Unknown"}: {factor.risk_contribution} / {factor.opportunity_contribution}</td><td>{projected?.value ?? "Unknown"}: {projected?.risk_contribution} / {projected?.opportunity_contribution}</td></tr>; })}
        </tbody></table><ul>{[...scenario.baseline.assessment.caveats, ...scenario.caveats].map((text, index) => <li key={index}>{text}</li>)}</ul>
        <ol>{scenario.alternatives.map(option => <li key={option.id}>{option.description} {option.depends_on.length > 0 && `Depends on: ${option.depends_on.join(", ")}`}</li>)}</ol>
        {canWrite && <><label>Human acknowledgement of unverified assumptions <textarea value={ack} maxLength={2000} disabled={pending} onChange={event => change(() => setAck(event.target.value))} /></label>
          <button disabled={pending || writeBlocked || !view || !ack.trim()} onClick={promote}>Prepare unapproved review plan</button></>}
        <button disabled={pending} onClick={() => run(async signal => { const result = await api<PromotedScenario | null>(`intelligence/scenarios/${scenario.id}/promotion`, { signal }); if (result) promotionScope(result, scenario, organization, account); return () => { setPromotion(result); setPromotedMissions([]); setCheckedPlan(null); }; })}>Inspect saved promotion</button>
        {promotion && <section aria-label="Promoted scenario mission"><p role="status">Unapproved plan {promotion.plan.id}. Scenario assumptions remain linked to {promotion.scenario_id}. Continue through the normal mission preview and human approval flow.</p>
          <button disabled={pending} onClick={inspectPromotedMissions}>Inspect missions for this exact promoted plan</button>
          {canWrite && checkedPlan === promotion.plan.id && promotedMissions.length === 0 && <button disabled={pending || writeBlocked} onClick={startPromotedMission}>Start unapproved scenario review mission</button>}
          {checkedPlan === promotion.plan.id && promotedMissions.map(item => <p key={item.id}>Saved scenario mission {item.id}: {item.status}. <a href={`/missions?${new URLSearchParams({ account, mission: item.id, step: "Review" })}`}
            onClick={event => { if (!valid() || life.current.pending) event.preventDefault(); }}>Open exact scenario mission</a></p>)}
        </section>}
      </article>}
    </section>
    <section aria-labelledby="trend-heading"><h2 id="trend-heading">Trend Intelligence</h2>
      {canWrite && <fieldset disabled={pending || writeBlocked}><legend>Compare retained observed history</legend>
        <label>Two to fifty distinct saved run IDs <textarea value={idsText} onChange={event => change(() => setIdsText(event.target.value))} /></label>
        <label>Range start (ISO 8601 with timezone)<input placeholder="2026-10-01T00:00:00Z" value={start} onChange={event => change(() => setStart(event.target.value))} /></label>
        <label>Range end (ISO 8601 with timezone)<input placeholder="2026-10-27T00:00:00Z" value={end} onChange={event => change(() => setEnd(event.target.value))} /></label>
        <button onClick={buildTrend}>Save observed trend report</button></fieldset>}
      {reportList.map(item => <button key={item.id} disabled={pending} onClick={() => change(() => setReport(item))}>Report {item.id} — {item.created_at}</button>)}
      {report && <article><h3>Saved {report.mode}</h3><p>Report {report.id}; author {report.author_id}; {report.created_at}. {report.available_count} / {report.input_count} chosen runs. Range {report.request.start} to {report.request.end}.</p>
        {report.metrics.map(metric => <section key={metric.metric}><h4>{metric.metric} ({metric.unit}) — {metric.status}</h4><p>Delta {metric.delta ?? "Unavailable"}; change/day {metric.per_day ?? "Unavailable"}. Repeats {metric.duplicate_count}; corrections {metric.corrected_count}; excluded {metric.excluded_count}.</p>
          <table><thead><tr><th>Observed</th><th>Value</th><th>Source record / saved run</th></tr></thead><tbody>{metric.points.map((point, index) => <tr key={index}><td>{point.observed_at}</td><td>{point.value} {metric.unit}</td><td>{point.source}: {point.source_record}; {point.pipeline_id}; snapshot {point.snapshot_hash}</td></tr>)}</tbody></table></section>)}
        <ul>{report.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul></article>}
    </section>
  </main>;
}
