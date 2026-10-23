import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target); target.require = name => mocks[name] ?? normal(name);
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

function mount(current = run(secondId, "2026-10-24T01:00:00Z")) {
  const states = [], refs = [], effects = [], layouts = [], calls = [];
  let s = 0, r = 0, e = 0, l = 0, component;
  const hooks = {
    useState(initial) { const index = s++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = value; }]; },
    useRef(initial) { const index = r++; return refs[index] ??= { current: initial }; },
    useEffect(fn) { const index = e++; if (!(index in effects)) effects[index] = fn(); },
    useLayoutEffect(fn) { const index = l++; if (!(index in layouts)) layouts[index] = fn(); },
  };
  component = load("../components/pipeline-panel.tsx", { react: hooks, "@/lib/pipeline-delta": helper,
    "@/lib/api": { api(url, options) { return new Promise((resolve, reject) => calls.push({ url, options, resolve, reject })); } } });
  return {
    calls, states,
    render() { s = r = e = l = 0; return component.SavedRunComparison({ current }); },
    unmount() { [...layouts, ...effects].forEach(cleanup => cleanup?.()); },
  };
}
const input = tree => walk(tree).find(n => n.type === "input");
const button = tree => walk(tree).find(n => n.type === "button");
function enter(app, value) { input(app.render()).props.onChange({ target: { value } }); return app.render(); }

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
