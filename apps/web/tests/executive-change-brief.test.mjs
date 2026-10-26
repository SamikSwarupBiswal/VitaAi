import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript"), { renderToStaticMarkup } = require("react-dom/server");
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const account = id => ({ account: { id, name: `Account ${id}`, organization_id: "org", revision: 3 }, source: { id: `source-${id}` },
  assessment: { snapshot_hash: `hash-${id}`, as_of: "2026-10-26" } });
const portfolio = { organization_id: "org", as_of: "2026-10-26", accounts: [account("b"), account("a"), account("c"), account("d"), account("e"), account("f")] };
const field = value => ({ value, status: value === null ? "missing" : "valid", unit: "percent", observed_at: "2026-10-20T01:00:00Z", evidence_id: "evidence" });
const record = id => ({ id: `detection-${id}`, organization_id: "org", account_id: id, status: "changed", reason: "values_changed",
  detected_at: "2026-10-25T03:00:00Z", before: { source_version_id: `old-${id}`, account_revision: 2, selected_at: "2026-10-24T01:00:00Z", observation_id: "old-observation" },
  after: { source_version_id: `source-${id}`, account_revision: 3, selected_at: "2026-10-25T01:00:00Z", observation_id: "new-observation" },
  event: { id: `event-${id}`, fingerprint: "fingerprint", changes: [{ field: "usage_change", kind: "availability_changed", before: field(null), after: field(0) }] } });

function setup(t, selected = portfolio, session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } }) {
  const filename = fileURLToPath(new URL("../components/executive-change-brief.tsx", import.meta.url));
  let cursor = 0, effects = [], unmounted = false; const slots = [], cleanups = [], saved = [], requests = [], choices = [], listeners = new Map();
  const previous = globalThis.window, surface = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  globalThis.window = surface;
  const unmount = () => { if (unmounted) return; unmounted = true; const current = globalThis.window; globalThis.window = surface;
    try { cleanups.forEach(fn => fn?.()); } finally { globalThis.window = current; } };
  t.after(() => { unmount(); globalThis.window = previous; });
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  const mocks = { react: hooks, "./session-gate": { useSession: () => session },
    "@/lib/hubspot": { readDetections: (view, signal) => new Promise((resolve, reject) => saved.push({ view, signal, resolve, reject })) },
    "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) } };
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename);
  const outer = () => target.exports.ExecutiveChangeBrief({ portfolio: selected, onSelect: id => choices.push(id) });
  const render = () => { cursor = 0; const node = outer(); const tree = typeof node?.type === "function" ? node.type(node.props) : node;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = label => walk(render()).find(node => node.type === "button" && [].concat(node.props.children).join("") === label);
  return { saved, requests, choices, render, outer, unmount, button, setPortfolio(value) { selected = value; },
    emit(name) { listeners.get(name)?.(); }, inspect() { return button("Inspect saved changes").props.onClick(); } };
}
async function finish(app, pending, results = {}, mutate = () => {}) {
  for (const read of app.saved.splice(0)) {
    const value = results[read.view.account.id]; if (value instanceof Error) read.reject(value); else read.resolve(value ?? [record(read.view.account.id)]);
  }
  await flush();
  for (const request of app.requests.splice(0)) {
    assert.equal(request.init.method, undefined); const id = decodeURIComponent(request.url.split("/").at(-1));
    const fresh = structuredClone(portfolio.accounts.find(item => item.account.id === id)); mutate(fresh); request.resolve(fresh);
  }
  await pending;
}

test("executive explicitly inspects bounded saved source changes in original portfolio order with dated factual pairs", async t => {
  const app = setup(t); app.render(); assert.equal(app.saved.length, 0);
  const pending = app.inspect(); await app.inspect(); assert.deepEqual(app.saved.map(read => read.view.account.id), ["b", "a", "c", "d", "e"]);
  const baseline = { ...record("a"), status: "baseline", reason: "first_source", before: null, event: null };
  const unchanged = { ...record("c"), status: "unchanged", reason: "values_unchanged", event: null };
  const reset = { ...record("d"), status: "source_reset", reason: "local_sample", event: null };
  await finish(app, pending, { a: [baseline], c: [unchanged], d: [reset], e: [] });
  const html = renderToStaticMarkup(app.render());
  for (const text of ["first 5 of 6", "latest 20", "Unknown", "0", "percent", "availability changed", "event-b", "detection-b", "evidence",
    "2026-10-20T01:00:00Z", "2026-10-25T01:00:00Z", "2026-10-25T03:00:00Z", "baseline", "unchanged", "source reset", "No saved detections"]) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf("Account b") < html.indexOf("Account a")); assert.doesNotMatch(html, /Account f|Portfolio is steady|revenue exposed/);
  app.button("Inspect Account b").props.onClick(); assert.deepEqual(app.choices, ["b"]);
});

test("independent unavailable, stale and crossed histories cannot create portfolio steady claims or unsafe drilldown", async t => {
  const app = setup(t), pending = app.inspect(), crossed = { ...record("a"), organization_id: "foreign" };
  await finish(app, pending, { b: new Error("private provider detail"), a: [crossed] }, fresh => { if (fresh.account.id === "c") fresh.assessment.snapshot_hash = "changed"; });
  const html = renderToStaticMarkup(app.render()); assert.match(html, /Saved history unavailable/); assert.match(html, /Account d/);
  assert.equal(app.button("Inspect Account b"), undefined); assert.equal(app.button("Inspect Account a"), undefined); assert.equal(app.button("Inspect Account c"), undefined);
  assert.ok(app.button("Inspect Account d")); assert.doesNotMatch(html, /private provider detail|Portfolio is steady|event-a|event-c/);
});

test("saved source metadata is escaped and historical backlog is disclosed without freshening dates", async t => {
  const app = setup(t), value = record("b"); value.after.source_version_id = "older-source"; value.after.account_revision = 2;
  value.event.changes[0].after = { ...field("<script>unsafe</script>"), unit: "text" };
  const pending = app.inspect(); await finish(app, pending, { b: [value] }); const html = renderToStaticMarkup(app.render());
  assert.match(html, /does not cover the displayed selection/); assert.match(html, /&lt;script&gt;unsafe/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /2026-10-20T01:00:00Z/);
});

test("focus/completion, snapshot keys and unmount invalidate late reads and captured account navigation", async t => {
  const app = setup(t), key = app.outer().key;
  app.setPortfolio({ ...portfolio, accounts: [...portfolio.accounts].reverse() }); assert.notEqual(app.outer().key, key); app.setPortfolio(portfolio);
  let pending = app.inspect(); await finish(app, pending); const captured = app.button("Inspect Account b").props.onClick;
  for (const name of ["focus", "vitaai-detections-changed", "vitaai-source-history-changed", "vitaai-source-changed"]) {
    app.emit(name); captured(); assert.deepEqual(app.choices, []); assert.doesNotMatch(renderToStaticMarkup(app.render()), /event-b/);
    pending = app.inspect(); const reads = app.saved.splice(0); app.emit(name); reads.forEach(read => read.resolve([record(read.view.account.id)])); await pending;
    assert.equal(app.requests.length, 0);
  }
  pending = app.inspect(); const reads = app.saved.splice(0); app.unmount(); reads.forEach(read => { assert.equal(read.signal.aborted, true); read.resolve([]); }); await pending;
  assert.equal(app.requests.length, 0); assert.doesNotMatch(renderToStaticMarkup(app.render()), /event-b/);
});

test("sample, foreign and empty portfolio scopes perform no private history reads", t => {
  for (const session of [null, { mode: "sample", actor: null }, { mode: "session", actor: { organization_id: "foreign" } }]) {
    const app = setup(t, portfolio, session); assert.match(renderToStaticMarkup(app.render()), /Session identity/); assert.equal(app.saved.length, 0);
  }
  const app = setup(t, { ...portfolio, accounts: [] }); assert.match(renderToStaticMarkup(app.render()), /No accounts available/);
  assert.equal(app.button("Inspect saved changes").props.disabled, true); assert.equal(app.saved.length, 0);
});
