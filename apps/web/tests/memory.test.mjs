import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => mocks[name] ?? (name.startsWith("./") && relative.startsWith("../lib/") ? load(`../lib/${name.slice(2)}.ts`, mocks) : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename); return target.exports;
}
const id = "11111111-1111-4111-8111-111111111111", account = "22222222-2222-4222-8222-222222222222";
const item = () => ({ id, organization_id: "org", account_id: account, revision: 1, state: "active", visibility: "organization",
  captured_by: "actor", created_at: "2026-10-27T01:00:00Z", source: { pipeline_id: id, actor_id: "original", started_at: "2026-10-26T00:00:00Z", as_of: "2026-10-26" },
  context: { account: { id: account, organization_id: "org", annual_value: null, renewal_date: null }, evidence: [{ id: "fact", account_id: account, organization_id: "org", source: "SYNTHETIC", observed_at: "2026-10-20", fact: "<script>Unknown</script>" }] },
  recommendation: { account_id: account, action: { kind: "manual_review", rationale: "Retained proposal" } } });
const history = () => ({ organization_id: "org", account_id: account, limit: 20, total_count: 1, has_more: false, items: [item()] });
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function setup(t, role = "admin") {
  const slots = [], cleanups = [], requests = [], events = new Map(); let cursor = 0, effects = [];
  const old = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); }, removeEventListener(name, fn) { events.get(name)?.delete(fn); } };
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((x, n) => x !== slots[i][n])) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { ...React, useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const helper = load("../lib/memory.ts");
  const component = load("../components/memory-panel.tsx", { react: hooks, "@/lib/memory": helper,
    "@/lib/pipeline-history": load("../lib/pipeline-history.ts"), "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role } }) } });
  const render = () => { cursor = 0; const outer = component.MemoryPanel({ view: { account: { id: account, organization_id: "org", revision: 1 }, assessment: { snapshot_hash: "hash" } } });
    const tree = outer.type(outer.props), pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const unmount = () => cleanups.forEach(fn => fn?.());
  t.after(() => { unmount(); globalThis.window = old; });
  return { requests, render, unmount, button: name => walk(render()).find(node => node.type === "button" && node.props.children === name),
    emit(name) { for (const fn of events.get(name) ?? []) fn(); }, async list(value = history()) { const pending = this.button("Inspect account memory").props.onClick(); requests.shift().resolve(value); await pending; } };
}
test("memory validation rejects crossed scope and inconsistent coverage", () => {
  const helper = load("../lib/memory.ts"); helper.validateMemoryHistory(history(), "org", account);
  for (const mutate of [x => x.organization_id = "foreign", x => x.items[0].context.evidence[0].account_id = "foreign", x => x.total_count = 3]) {
    const value = history(); mutate(value); assert.throws(() => helper.validateMemoryHistory(value, "org", account));
  }
});
test("memory history is explicit with original dates, Unknowns and escaped facts; viewers cannot change lifecycle", async t => {
  const app = setup(t, "viewer"); app.render(); assert.equal(app.requests.length, 0); await app.list();
  const html = renderToStaticMarkup(app.render());
  for (const value of ["2026-10-26T00:00:00Z", "original", "Unknown", "Retained proposal", "SYNTHETIC"]) assert.ok(html.includes(value));
  assert.match(html, /&lt;script&gt;/); assert.equal(app.button("Archive memory"), undefined);
});
test("duplicate reads, captured lifecycle handlers and obsolete results are fenced", async t => {
  const app = setup(t); const button = app.button("Inspect account memory"); const first = button.props.onClick(); await button.props.onClick();
  assert.equal(app.requests.length, 1); app.requests.shift().resolve(history()); await first;
  const oldEvents = app.button("Inspect memory events"); app.emit("focus"); await oldEvents.props.onClick(); assert.equal(app.requests.length, 0);
  const late = app.button("Inspect account memory").props.onClick(), request = app.requests.shift(); app.unmount(); request.resolve(history()); await late;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Retained proposal/);
});
