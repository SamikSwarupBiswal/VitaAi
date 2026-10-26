import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const first = "11111111-1111-4111-8111-111111111111", second = "22222222-2222-4222-8222-222222222222";
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => mocks[name] ?? (name.startsWith("./") && relative.startsWith("../lib/")
    ? load(`../lib/${name.slice(2)}.ts`, mocks) : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename);
  return target.exports;
}
const run = (id = first) => ({ id, organization_id: "org", actor_id: "original actor", started_at: "2026-10-24T00:00:00.000002Z", as_of: "2026-10-24",
  request: { intent: "growth", limit: 1, communicate: false, communication_mode: "drafts" }, status: "partial", steps: [], caveats: ["Retained caveat"],
  contexts: [{ account: { id: "account", organization_id: "org", revision: 1, name: "<script>Saved name</script>", annual_value: null, renewal_date: null },
    evidence: [{ id: "fact", organization_id: "org", account_id: "account", value: 0, observed_at: "2026-10-20T01:00:00Z" }] },
    { account: { id: "outside", organization_id: "org", revision: 3, name: "Outside selection", annual_value: 0, renewal_date: null }, evidence: [] }],
  recommendations: [{ account_id: "account", rank: 1, action: { kind: "manual_review", rationale: "Original rationale", evidence_ids: ["fact"] },
    governance: { status: "review_required" }, communication: { status: "blocked" }, assessment: {
      snapshot_hash: "a".repeat(64), as_of: "2026-10-24", policy_version: "baseline-1", risk: 0, opportunity: 0, confidence: 0, factors: [], caveats: [] } }],
});
const summary = saved => ({ id: saved.id, actor_id: saved.actor_id, started_at: saved.started_at, as_of: saved.as_of,
  request: saved.request, status: saved.status, input_account_ids: saved.contexts.map(x => x.account.id), selected_account_ids: saved.recommendations.map(x => x.account_id) });
const history = () => ({ organization_id: "org", limit: 20, total_count: 2, window_count: 2, undated_count: 0, unavailable_count: 0, has_more: false,
  items: [summary(run(second)), summary(run())] });

function setup(t) {
  const slots = [], cleanups = [], requests = [], events = new Map(), selected = [];
  let cursor = 0, effects = [], session = { mode: "session", actor: { id: "viewer", organization_id: "org", role: "viewer" } };
  const prior = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); },
    removeEventListener(name, fn) { events.get(name)?.delete(fn); } };
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((value, j) => value !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { ...require("react"), useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const helper = load("../lib/pipeline-history.ts");
  const component = load("../components/saved-pipeline-history.tsx", { react: hooks, "@/lib/pipeline-history": helper,
    "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "./session-gate": { useSession: () => session } });
  let props = { organizationId: "org", snapshots: { account: "current hash" }, onSelect: id => selected.push(id),
    renderComparison: saved => `Comparison for ${saved.id}` };
  const outer = () => component.SavedPipelineHistory(props);
  const render = () => { cursor = 0; const node = outer(); const tree = typeof node?.type === "function" ? node.type(node.props) : node;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  let unmounted = false;
  const unmount = () => { if (!unmounted) { unmounted = true; cleanups.forEach(fn => fn?.()); } };
  t.after(() => { unmount(); globalThis.window = prior; });
  const button = name => walk(render()).find(x => x.type === "button" && x.props.children === name);
  return { requests, selected, render, outer, button, unmount, props(value) { props = { ...props, ...value }; }, session(value) { session = value; },
    emit(name) { [...(events.get(name) || [])].forEach(fn => fn()); },
    async list(value = history()) { const pending = button("Inspect saved pipeline history").props.onClick();
      const request = requests.shift(); assert.equal(request.url, "pipeline/history"); request.resolve(value); await pending; },
    async detail(id = first, value = run(id)) { const pending = button(`Inspect run ${id}`).props.onClick();
      const request = requests.shift(); assert.equal(request.url, `pipeline/${id}`); request.resolve(value); await pending; } };
}

test("saved history is explicit, dated and bounded; detail preserves input versus selection and current account navigation", async t => {
  const app = setup(t); app.render(); assert.equal(app.requests.length, 0);
  const data = history(), original = structuredClone(data); await app.list(data); await app.detail();
  const html = renderToStaticMarkup(app.render());
  for (const text of ["Latest 20", "original actor", "2026-10-24T00:00:00.000002Z", "Outside selected result", "Unknown", "Original rationale",
    "Retained caveat", "fact", "2026-10-20T01:00:00Z", "partial", "Comparison for", "Historical"]) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;Saved name/); assert.doesNotMatch(html, /<script>/);
  app.button("Open current account").props.onClick(); assert.deepEqual(app.selected, ["account"]);
  assert.equal(walk(app.render()).filter(x => x.type === "button" && x.props.children === "Open current account").length, 1);
  assert.deepEqual(data, original); assert.equal(app.requests.length, 0);
});

test("coverage exposes older, unorderable and unreadable omissions and does not claim a complete timeline", async t => {
  const app = setup(t); const value = history(); value.items = [value.items[0]];
  Object.assign(value, { total_count: 25, undated_count: 23, unavailable_count: 1 });
  await app.list(value);
  let html = renderToStaticMarkup(app.render()); assert.match(html, /23.*unorderable/); assert.match(html, /1.*unreadable/); assert.match(html, /not a complete/);
  value.total_count = 30; value.undated_count = 10; value.window_count = 20; value.unavailable_count = 19;
  await app.list(value); html = renderToStaticMarkup(app.render()); assert.match(html, /Showing 1/);
  await app.list({ ...history(), items: [], total_count: 0, window_count: 0 });
  assert.match(renderToStaticMarkup(app.render()), /No saved pipeline runs/);
});

test("crossed, duplicate, misordered, inconsistent coverage and mismatched detail reject without prior success", async t => {
  for (const mutate of [x => { x.organization_id = "foreign"; }, x => { x.items.push(x.items[0]); },
    x => { x.window_count = 21; }, x => { x.undated_count = 1; }, x => { x.has_more = true; },
    x => { x.items.reverse(); }, x => { x.items[0].selected_account_ids.push("foreign"); }]) {
    const app = setup(t), value = history(); mutate(value); await app.list(value);
    assert.match(renderToStaticMarkup(app.render()), /unavailable or changed/); app.unmount();
  }
  for (const mutate of [x => { x.id = second; }, x => { x.organization_id = "foreign"; }, x => { x.actor_id = "changed"; },
    x => { x.started_at = "2026-10-25T00:00:00Z"; }, x => { x.request.intent = "risk"; },
    x => { x.contexts[0].evidence[0].organization_id = "foreign"; }, x => { x.contexts.push(x.contexts[0]); }]) {
    const app = setup(t), value = run(); mutate(value); await app.list(); await app.detail(first, value);
    const html = renderToStaticMarkup(app.render()); assert.match(html, /unavailable or changed/); assert.doesNotMatch(html, /Original rationale/); app.unmount();
  }
});

test("focus, new-run completion and unmount fence obsolete reads and captured navigation", async t => {
  const app = setup(t); await app.list(); await app.detail();
  const captured = app.button("Open current account").props.onClick;
  app.emit("focus"); captured(); assert.deepEqual(app.selected, []); assert.equal(app.requests.length, 0);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Original rationale/);
  for (const name of ["vitaai-pipeline-history-changed", "vitaai-source-changed"]) {
    const pending = app.button("Inspect saved pipeline history").props.onClick(), request = app.requests.shift();
    app.emit(name); request.resolve(history()); await pending; assert.doesNotMatch(renderToStaticMarkup(app.render()), /Inspect run/);
  }
  await app.list(); const inspect = app.button(`Inspect run ${first}`).props.onClick;
  const pending = inspect(), request = app.requests.shift(); await inspect(); assert.equal(app.requests.length, 0);
  app.unmount(); request.resolve(run()); await pending; assert.equal(request.init.signal.aborted, true);
  await inspect(); assert.equal(app.requests.length, 0);
});

test("older-ID inspection keeps naive original dates historical and rejects captured forms after an edit", async t => {
  const app = setup(t), input = () => walk(app.render()).find(x => x.type === "input");
  input().props.onChange({ target: { value: first } }); const captured = app.button("Inspect saved run ID").props.onClick;
  input().props.onChange({ target: { value: second } }); await captured(); assert.equal(app.requests.length, 0);
  const pending = app.button("Inspect saved run ID").props.onClick(), request = app.requests.shift();
  const legacy = run(second); legacy.started_at = "2026-10-24T00:00:00"; request.resolve(legacy); await pending;
  let html = renderToStaticMarkup(app.render()); assert.match(html, /2026-10-24T00:00:00/); assert.match(html, /not orderable/); assert.doesNotMatch(html, /Comparison for/);
  input().props.onChange({ target: { value: first } }); html = renderToStaticMarkup(app.render()); assert.doesNotMatch(html, /Original rationale/);
});

test("history scope keys include actor and current portfolio snapshot; sample and foreign scopes cannot inspect", t => {
  const app = setup(t), key = app.outer().key;
  app.props({ snapshots: { account: "new" } }); assert.notEqual(app.outer().key, key);
  app.props({ snapshots: { account: "current hash" } }); app.session({ mode: "session", actor: { id: "other", organization_id: "org", role: "viewer" } });
  assert.notEqual(app.outer().key, key);
  for (const value of [null, { mode: "sample" }, { mode: "session", actor: { organization_id: "foreign" } }]) {
    app.session(value); assert.match(renderToStaticMarkup(app.render()), /Session identity/); assert.equal(app.requests.length, 0);
  }
});

test("saved instant comparison retains microseconds and timezone equivalence", () => {
  const helper = load("../lib/pipeline-delta.ts"), older = run(), newer = run(second);
  older.started_at = "2026-10-24T00:00:00.000001Z"; newer.started_at = "2026-10-24T05:30:00.000002+05:30";
  assert.doesNotThrow(() => helper.comparePipelineRuns(older, newer));
  assert.throws(() => helper.comparePipelineRuns(newer, older), /no later/);
});
