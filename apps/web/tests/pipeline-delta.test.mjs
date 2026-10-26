import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  mocks = { "./saved-research-fusion": { SavedResearchFusion: () => null },
    "./saved-pipeline-history": { SavedPipelineHistory: () => null }, ...mocks };
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target); target.require = name => mocks[name]
    ?? (name === "./seller-priorities" ? load("../components/seller-priorities.tsx") : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename); return target.exports;
}
const helper = load("../lib/pipeline-delta.ts");
const firstId = "11111111-1111-4111-8111-111111111111", secondId = "22222222-2222-4222-8222-222222222222";
const run = (id = firstId, started_at = "2026-10-24T00:00:00Z") => ({ id, organization_id: "org", started_at, as_of: "2026-10-24",
  request: { intent: "attention", limit: 3, communicate: false, communication_mode: "drafts" },
  contexts: [{ account: { id: "account", organization_id: "org", name: "<script>Source</script>", revision: 1, annual_value: null, renewal_date: null },
    evidence: [{ id: "fact", account_id: "account", organization_id: "org", fact: "Observed fact", observed_at: "2026-10-23T00:00:00Z" }] }],
  recommendations: [{ account_id: "account", rank: 1, action: { kind: "manual_review" }, assessment: {
    snapshot_hash: "a".repeat(64), policy_version: "baseline-1", as_of: "2026-10-24", risk: 0, opportunity: 0, confidence: 0,
    caveats: ["Missing source"], factors: [{ metric: "usage_change", value: null, evidence_id: null }] } }],
});
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];

test("seller priorities preserve server order, exact navigation, source dates, Unknowns and failures", () => {
  const { SellerPriorities } = load("../components/seller-priorities.tsx"), saved = run();
  saved.contexts[0].evidence[0] = { ...saved.contexts[0].evidence[0], source: "CRM", source_record: "retained-record",
    ingested_at: "2026-10-23T01:00:00Z", synthetic: false };
  saved.recommendations = [7, 2, 9].map((rank, i) => ({ ...saved.recommendations[0], account_id: `account-${i}`, rank,
    action: { kind: i === 0 ? "manual_review" : "follow_up", rationale: "Review retained observation", evidence_ids: i ? ["fact"] : [] },
    governance: { status: i === 0 ? "review_required" : "ready_for_preparation", caveats: ["Original policy caveat"] },
    communication: { status: "failed" } }));
  saved.contexts = saved.recommendations.map((item, i) => ({ ...saved.contexts[0],
    account: { ...saved.contexts[0].account, id: item.account_id, name: `Account ${i} <script>` } }));
  const original = structuredClone(saved), selected = [];
  const tree = SellerPriorities({ run: saved, onSelect: id => selected.push(id) }), html = renderToStaticMarkup(tree);
  assert.match(html, /Now · rank 7.*Next · rank 2.*Later · rank 9/);
  assert.match(html, /annual value Unknown.*renewal Unknown/);
  assert.match(html, /Communication: failed/); assert.match(html, /Evidence review required before preparation/);
  assert.match(html, /Original policy caveat/); assert.match(html, /observed 2026-10-23T00:00:00Z.*ingested 2026-10-23T01:00:00Z/);
  assert.match(html, /Context only; not cited by this action/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  walk(tree).filter(node => node.type === "button").forEach(node => node.props.onClick());
  assert.deepEqual(selected, saved.recommendations.map(item => item.account_id));
  assert.deepEqual(walk(tree).filter(node => node.type === "a").map(node => node.props.href),
    selected.map(account => `/missions?account=${account}`));
  assert.deepEqual(saved, original);
});

test("empty seller priorities invent no work; missing context has no navigation", () => {
  const { SellerPriorities } = load("../components/seller-priorities.tsx"), saved = run();
  saved.recommendations[0].governance = { status: "review_required", caveats: [] };
  saved.recommendations[0].communication = { status: "blocked" };
  saved.recommendations[0].action.evidence_ids = [];
  saved.contexts = [];
  const tree = SellerPriorities({ run: saved, onSelect() { assert.fail("No account context"); } });
  assert.match(renderToStaticMarkup(tree), /Unknown account/);
  assert.equal(walk(tree).filter(node => node.type === "a" || node.type === "button").length, 0);
  saved.recommendations = [];
  assert.match(renderToStaticMarkup(SellerPriorities({ run: saved, onSelect() {} })), /No recommendations selected/);
});

test("seller effort and intended outcomes are action-specific review proposals, never measured impact", () => {
  const { SellerPriorities } = load("../components/seller-priorities.tsx");
  const expectations = [
    ["manual_review", /Scope unknown/, /Identify the missing or contradictory evidence/],
    ["support_escalation", /Extended review/, /Identify unresolved support questions/],
    ["renewal_prep", /Focused review/, /Prepare renewal evidence and open questions/],
    ["optimization_review", /Extended review/, /Explore usage and growth signals together/],
    ["reactivation", /Focused review/, /Prepare questions about declining usage/],
    ["follow_up", /Focused review/, /Assess whether growth evidence supports a follow-up/],
    ["monitor", /Brief review/, /Review retained signals without preparing outreach/],
  ];
  for (const [kind, effort, outcome] of expectations) {
    const saved = run(), item = saved.recommendations[0];
    item.action = { kind, rationale: `Original ${kind} rationale`, evidence_ids: ["fact"] };
    item.governance = { status: kind === "manual_review" ? "review_required" : "ready_for_preparation", caveats: [] };
    item.communication = { status: "failed" };
    const original = structuredClone(saved);
    const html = renderToStaticMarkup(SellerPriorities({ run: saved, onSelect() {} }));
    assert.match(html, /Proposed review effort:/); assert.match(html, effort);
    assert.match(html, /Intended outcome \(proposal\):/); assert.match(html, outcome);
    assert.match(html, /Actual time and customer impact are unknown/);
    assert.match(html, /Communication: failed/); assert.match(html, new RegExp(`Original ${kind} rationale`));
    assert.doesNotMatch(html, /\d+ minutes|reduces churn|protects revenue|scheduled follow-up/i);
    assert.deepEqual(saved, original);
  }
});

test("seller proposals retain evidence blockers and cannot infer work from absent context or sources", () => {
  const { SellerPriorities } = load("../components/seller-priorities.tsx");
  for (const mode of ["review-required", "missing-context", "missing-evidence"]) {
    const saved = run(), item = saved.recommendations[0];
    item.action = { kind: "follow_up", rationale: "Historical growth proposal", evidence_ids: ["fact"] };
    item.governance = { status: mode === "review-required" ? "review_required" : "ready_for_preparation", caveats: [] };
    item.communication = { status: "blocked" };
    if (mode === "missing-context") saved.contexts = [];
    if (mode === "missing-evidence") saved.contexts[0].evidence = [];
    const html = renderToStaticMarkup(SellerPriorities({ run: saved, onSelect() {} }));
    assert.match(html, /Proposed review effort:.*Scope unknown/);
    assert.doesNotMatch(html, /Assess whether growth evidence supports a follow-up/);
    assert.match(html, mode === "review-required" ? /Identify the missing or contradictory evidence/ : /Retained account evidence is unavailable/);
  }
});

test("parent shows seller priorities only for current saved snapshots and hides them during a new run", async () => {
  const saved = run(); saved.steps = []; saved.caveats = [];
  saved.recommendations[0].action.evidence_ids = ["fact"];
  saved.recommendations[0].governance = { status: "review_required", caveats: [] };
  saved.recommendations[0].communication = { status: "blocked", evidence_ids: [] };
  for (const [seller, hash] of [[true, "a".repeat(64)], [true, "changed"], [false, "a".repeat(64)]]) {
    const state = ["attention", saved, false, null, false]; let cursor = 0, resolve, calls = 0;
    const { PipelinePanel } = load("../components/pipeline-panel.tsx", { react: {
      useEffect() {}, useLayoutEffect() {}, useRef: initial => ({ current: initial }),
      useState(initial) { const i = cursor++; return [state[i] ?? initial, value => { state[i] = value; }]; },
    }, "@/lib/api": { api() { calls++; return new Promise(done => { resolve = done; }); } }, "@/lib/pipeline-delta": helper });
    const render = () => { cursor = 0; return PipelinePanel({ seller, organizationId: "org", snapshots: { account: hash }, configured: false, onSelect() {} }); };
    let tree = render(), html = renderToStaticMarkup(tree);
    assert.equal(html.includes('aria-label="Saved recommendation priorities"'), seller && hash === "a".repeat(64));
    assert.equal(calls, 0);
    if (!seller || hash === "changed") continue;
    const pending = walk(tree).find(node => node.type === "button" && node.props.children === "Prepare recommendations").props.onClick();
    assert.equal(calls, 1);
    html = renderToStaticMarkup(render()); assert.doesNotMatch(html, /Saved recommendation priorities/);
    resolve(saved); await pending;
    assert.match(renderToStaticMarkup(render()), /Saved recommendation priorities/);
  }
});

function preparationHarness(deferPassive = false) {
  const states = [], refs = [], effects = [], layouts = [], requests = [], writes = [];
  const passive = [];
  let s = 0, r = 0, e = 0, l = 0;
  const lifecycle = (list, index, fn, deps) => {
    if (!list[index] || deps.some((value, i) => value !== list[index].deps[i])) {
      list[index]?.cleanup?.(); list[index] = { deps, cleanup: fn() };
    }
  };
  const hooks = {
    useState(initial) { const i = s++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef(initial) { return refs[r++] ??= { current: initial }; },
    useEffect(fn, deps) { const i = e++; if (deferPassive) passive.push(() => lifecycle(effects, i, fn, deps)); else lifecycle(effects, i, fn, deps); },
    useLayoutEffect(fn, deps) { lifecycle(layouts, l++, fn, deps); },
  };
  const { PipelinePanel } = load("../components/pipeline-panel.tsx", { react: hooks, "@/lib/pipeline-delta": helper,
    "@/lib/api": { api(url, init) { return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })); } } });
  let organizationId = "org";
  return { requests, states, writes,
    flushPassive() { passive.splice(0).forEach(fn => fn()); },
    render() { s = r = e = l = 0; return PipelinePanel({ seller: true, organizationId, snapshots: { account: "a".repeat(64) }, configured: false, onSelect() {} }); },
    changeOrganization(value) { organizationId = value; return this.render(); },
    unmount() { [...layouts, ...effects].forEach(value => value.cleanup?.()); },
  };
}

test("preparation rejects captured duplicates, unmounted handlers and obsolete organization responses", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  let writes;
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { return null; }, setItem(...args) { writes.push(args); } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  for (const mode of ["normal", "organization", "unmount", "foreign-result"]) {
    const app = preparationHarness(); writes = app.writes;
    const captured = walk(app.render()).find(n => n.type === "button" && n.props.children === "Prepare recommendations").props.onClick;
    const pending = captured(), duplicate = captured(); assert.equal(app.requests.length, 1, mode); await duplicate;
    if (mode === "organization") app.changeOrganization("new-org");
    if (mode === "unmount") app.unmount();
    const saved = run(); saved.steps = []; saved.caveats = [];
    saved.recommendations[0].action.evidence_ids = ["fact"];
    saved.recommendations[0].governance = { status: "review_required", caveats: [] };
    saved.recommendations[0].communication = { status: "blocked" };
    if (mode === "foreign-result") saved.organization_id = "foreign";
    app.requests[0].resolve(saved); await pending;
    if (mode === "normal") { assert.equal(app.states[1], saved); assert.deepEqual(writes, [["vitaai-pipeline:org", firstId]]); }
    else { assert.equal(app.states[1], null, mode); assert.deepEqual(writes, [], mode); }
    if (mode === "organization" || mode === "unmount") { await captured(); assert.equal(app.requests.length, 1); }
    app.unmount();
  }
});

test("restore rejects a different saved run or organization without publishing it", async t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { return firstId; } } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else delete globalThis.localStorage; });
  for (const saved of [run(secondId), { ...run(), organization_id: "foreign" }]) {
    const app = preparationHarness(); app.render(); assert.equal(app.requests.length, 1);
    app.requests[0].resolve(saved); for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(app.states[1], null); assert.match(app.states[3], /Saved preparation unavailable/); app.unmount();
  }
});

test("explicit preparation started before passive restore keeps its result and releases its lock", async () => {
  for (const completesFirst of [false, true]) {
    const app = preparationHarness(true);
    const captured = walk(app.render()).find(n => n.type === "button" && n.props.children === "Prepare recommendations").props.onClick;
    const pending = captured(); if (!completesFirst) app.flushPassive();
    const saved = run(); app.requests[0].resolve(saved); await pending;
    if (completesFirst) { app.flushPassive(); await Promise.resolve(); }
    assert.equal(app.states[1], saved); assert.equal(app.states[2], false);
    const next = captured(); assert.equal(app.requests.length, 2);
    app.unmount(); app.requests[1].resolve(saved); await next;
  }
});

test("saved comparison preserves exact history and distinguishes selection from account deletion", () => {
  const before = run(), after = run(secondId, "2026-10-24T01:00:00Z");
  const original = structuredClone([before, after]);
  assert.equal(helper.comparePipelineRuns(before, after).rows[0].kind, "unchanged");
  after.recommendations[0].action.kind = "follow_up";
  after.recommendations[0].rank = 2;
  after.recommendations[0].assessment.snapshot_hash = "b".repeat(64);
  const changed = helper.comparePipelineRuns(before, after);
  assert.equal(changed.rows[0].kind, "changed");
  assert.equal(changed.rows[0].before, before.recommendations[0]);
  assert.equal(changed.rows[0].afterContext.evidence[0].observed_at, original[1].contexts[0].evidence[0].observed_at);
  assert.equal(changed.beforeAt, before.started_at);
  const left = helper.comparePipelineRuns(before, { ...after, recommendations: [] });
  assert.equal(left.rows[0].kind, "left_selection"); assert.ok(left.rows[0].afterContext);
  const entered = helper.comparePipelineRuns({ ...before, recommendations: [] }, after);
  assert.equal(entered.rows[0].kind, "entered_selection"); assert.equal(entered.rows[0].before, null);
  assert.deepEqual(helper.comparePipelineRuns({ ...before, recommendations: [] }, { ...after, recommendations: [] }).rows, []);
  assert.deepEqual(before, original[0]);
});

test("request, date and policy changes stay distinct from source drift", () => {
  const before = run(), after = run(secondId, "2026-10-25T00:00:00Z");
  after.as_of = "2026-10-25"; after.request = { intent: "growth", limit: 1, communicate: true, communication_mode: "internal_note" };
  after.recommendations[0].assessment.policy_version = "future-policy";
  const result = helper.comparePipelineRuns(before, after);
  assert.ok(result.caveats.some(text => text.includes("Intent or selection limit differs")));
  assert.ok(result.caveats.some(text => text.includes("Communication settings differ")));
  assert.ok(result.caveats.some(text => text.includes("Assessment dates differ")));
  assert.ok(result.rows[0].caveats.some(text => text.includes("policy differs")));
});

test("crossed, duplicate, inconsistent and reversed saved contexts fail visibly", () => {
  const before = run(), good = run(secondId, "2026-10-24T01:00:00Z");
  for (const corrupt of [r => { r.organization_id = "foreign"; }, r => { r.contexts.push(structuredClone(r.contexts[0])); },
    r => { r.contexts[0].evidence[0].organization_id = "foreign"; }, r => { r.contexts[0].evidence[0].account_id = "foreign"; },
    r => { r.recommendations[0].account_id = "missing"; }, r => { r.recommendations.push(structuredClone(r.recommendations[0])); },
    r => { r.contexts[0].evidence.push(structuredClone(r.contexts[0].evidence[0])); }, r => { r.started_at = "invalid"; }]) {
    const bad = structuredClone(good); corrupt(bad); assert.throws(() => helper.comparePipelineRuns(before, bad));
  }
  assert.throws(() => helper.comparePipelineRuns(before, before), /different saved baseline/);
  assert.throws(() => helper.comparePipelineRuns(good, before), /no later/);
});

function mount(current = run(secondId, "2026-10-24T01:00:00Z"), baselines = [], accountId) {
  const states = [], refs = [], effects = [], layouts = [], calls = [];
  let s = 0, r = 0, e = 0, l = 0, component;
  const hooks = {
    useState(initial) { const index = s++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useRef(initial) { const index = r++; return refs[index] ??= { current: initial }; },
    useEffect(fn) { const index = e++; if (!(index in effects)) effects[index] = fn(); },
    useLayoutEffect(fn, deps) { const index = l++; if (!layouts[index] || deps.some((value, i) => value !== layouts[index].deps[i])) {
      layouts[index]?.cleanup?.(); layouts[index] = { deps, cleanup: fn() }; } },
  };
  component = load("../components/pipeline-panel.tsx", { react: hooks, "@/lib/pipeline-delta": helper,
    "@/lib/api": { api(url, options) { return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })); } } });
  return {
    calls, states,
    render() { s = r = e = l = 0; return component.SavedRunComparison({ current, baselines, accountId }); },
    scope(value) { accountId = value; return this.render(); },
    unmount() { layouts.forEach(value => value?.cleanup?.()); effects.forEach(cleanup => cleanup?.()); },
  };
}
const input = tree => walk(tree).find(n => n.type === "input");
const button = tree => walk(tree).find(n => n.type === "button");
function enter(app, value) { input(app.render()).props.onChange({ target: { value } }); return app.render(); }

test("listed baselines preserve precise chronology, require explicit compare and invalidate previous results", async () => {
  const current = run(secondId, "2026-10-24T00:00:00.000002Z"), older = run(firstId, "2026-10-24T00:00:00.000001Z");
  const otherId = "33333333-3333-4333-8333-333333333333";
  const baselines = [current, older, run(otherId, "2026-10-24T00:00:00.000003Z")].map(saved => ({
    id: saved.id, started_at: saved.started_at, request: saved.request,
  }));
  const app = mount(current, baselines), select = () => walk(app.render()).find(n => n.type === "select");
  assert.deepEqual(walk(select()).filter(n => n.type === "option").map(n => n.props.value), ["", firstId]);
  select().props.onChange({ target: { value: firstId } }); assert.equal(input(app.render()).props.value, firstId);
  assert.equal(app.calls.length, 0);
  let pending = button(app.render()).props.onClick(); app.calls[0].resolve(older); await pending;
  assert.equal(app.calls[0].url, `pipeline/${firstId}`);
  assert.match(renderToStaticMarkup(app.render()), /Historical comparison only/);
  select().props.onChange({ target: { value: "" } }); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Historical comparison only/);
  select().props.onChange({ target: { value: firstId } }); pending = button(app.render()).props.onClick();
  select().props.onChange({ target: { value: "" } }); assert.equal(app.calls[1].options.signal.aborted, true);
  app.calls[1].resolve(older); await pending; assert.doesNotMatch(renderToStaticMarkup(app.render()), /Historical comparison only/);
});

test("settled preparation invalidates history once even after navigation or an uncertain response without replay", async t => {
  const prior = globalThis.window; const surface = new EventTarget(); globalThis.window = surface;
  t.after(() => { globalThis.window = prior; });
  let completions = 0; surface.addEventListener("vitaai-pipeline-history-changed", () => { ++completions; });
  for (const mode of ["success", "unmount", "uncertain"]) {
    const app = preparationHarness(), start = walk(app.render()).find(n => n.type === "button").props.onClick;
    const pending = start(); assert.equal(app.requests.length, 1);
    if (mode === "unmount") app.unmount();
    if (mode === "uncertain") app.requests[0].reject(new Error("Response lost")); else app.requests[0].resolve(run());
    await pending; assert.equal(app.requests.length, 1); app.unmount();
  }
  assert.equal(completions, 3);
});

test("comparison makes one explicit scoped GET, renders Unknown/source facts safely and never prepares", async () => {
  const app = mount(); app.render(); assert.equal(app.calls.length, 0);
  const tree = enter(app, firstId), captured = button(tree).props.onClick;
  const pending = captured(); await captured();
  assert.equal(app.calls.length, 1); assert.equal(app.calls[0].url, `pipeline/${firstId}`);
  assert.equal(app.calls[0].options.method, undefined); assert.ok(app.calls[0].options.signal);
  app.calls[0].resolve(run()); await pending;
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /unchanged/); assert.match(html, /annual value Unknown.*renewal Unknown/);
  assert.match(html, /&lt;script&gt;Source&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /2026-10-23T00:00:00Z/); assert.match(html, /Historical comparison only/);
});

test("input edits cancel reads and reject captured handlers and obsolete responses", async () => {
  const app = mount(); app.render(); const tree = enter(app, firstId);
  const captured = button(tree).props.onClick, pending = captured();
  enter(app, "33333333-3333-4333-8333-333333333333");
  assert.equal(app.calls[0].options.signal.aborted, true);
  await captured(); assert.equal(app.calls.length, 1);
  app.calls[0].resolve(run()); await pending;
  assert.equal(app.states[1], null); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Historical comparison only/);
});

test("unmount fences late success; failed and crossed reads never show prior comparison", async () => {
  for (const mode of ["unmount", "failure", "wrong-id", "wrong-scope"]) {
    const app = mount(); app.render(); const pending = button(enter(app, firstId)).props.onClick();
    if (mode === "unmount") app.unmount();
    if (mode === "failure") app.calls[0].reject(new Error("Saved baseline unavailable"));
    else app.calls[0].resolve(mode === "wrong-id" ? run(secondId) : mode === "wrong-scope" ? { ...run(), organization_id: "foreign" } : run());
    await pending;
    assert.equal(app.states[1], null);
    if (mode !== "unmount") assert.match(renderToStaticMarkup(app.render()), /role="alert"/);
  }
});

test("invalid or same baseline cannot issue a read", async () => {
  const app = mount(); app.render();
  for (const id of ["", "invalid", "-".repeat(36), "a".repeat(36), secondId]) {
    const tree = enter(app, id); assert.equal(button(tree).props.disabled, true); await button(tree).props.onClick();
  }
  assert.equal(app.calls.length, 0);
});

test("account comparison retains outside-selection inputs, original Unknowns and membership changes without unrelated rows", () => {
  const before = run(), after = run(secondId, "2026-10-24T01:00:00Z"), original = structuredClone([before, after]);
  for (const saved of [before, after]) saved.contexts.push({ account: { id: "outside", organization_id: "org", name: "Other", revision: 1 }, evidence: [] });
  const scoped = helper.comparePipelineRuns(before, after, "outside");
  assert.deepEqual(scoped.rows.map(item => item.accountId), ["outside"]); assert.equal(scoped.rows[0].kind, "outside_selection");
  assert.equal(scoped.rows[0].before, null); assert.equal(scoped.rows[0].after, null);
  assert.equal(scoped.rows[0].beforeContext.account.id, "outside");
  assert.equal(helper.comparePipelineRuns({ ...before, recommendations: [] }, after, "account").rows[0].kind, "entered_selection");
  assert.equal(helper.comparePipelineRuns(before, { ...after, recommendations: [] }, "account").rows[0].kind, "left_selection");
  assert.throws(() => helper.comparePipelineRuns(before, { ...after, contexts: after.contexts.filter(x => x.account.id !== "outside") }, "outside"), /retained input/);
  before.contexts.pop(); after.contexts.pop(); assert.deepEqual([before, after], original);
});

test("account comparison hides obsolete results and fences captured/late handlers when account scope changes", async () => {
  const older = run(), current = run(secondId, "2026-10-24T01:00:00Z");
  for (const saved of [older, current]) saved.contexts.push({ account: { id: "outside", organization_id: "org", name: "Other", revision: 1 }, evidence: [] });
  const baselines = [{ id: firstId, started_at: older.started_at, request: older.request, input_account_ids: ["account", "outside"] },
    { id: "33333333-3333-4333-8333-333333333333", started_at: older.started_at, request: older.request, input_account_ids: ["unrelated"] }];
  const app = mount(current, baselines, "account"), select = () => walk(app.render()).find(n => n.type === "select");
  assert.deepEqual(walk(select()).filter(n => n.type === "option").map(n => n.props.value), ["", firstId]);
  let pending = button(enter(app, firstId)).props.onClick(); app.calls[0].resolve(older); await pending;
  assert.match(renderToStaticMarkup(app.render()), /Historical comparison only/);
  app.scope("outside"); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Historical comparison only/);
  const captured = button(app.render()).props.onClick; pending = captured(); app.scope("account");
  assert.equal(app.calls[1].options.signal.aborted, true); await captured(); assert.equal(app.calls.length, 2);
  app.calls[1].resolve(older); await pending; assert.doesNotMatch(renderToStaticMarkup(app.render()), /Historical comparison only/);
  app.unmount();
});
