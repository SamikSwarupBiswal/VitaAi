import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const view = { account: { id: "account", organization_id: "org", revision: 5, name: "Account A" },
  source: { id: "source5", kind: "hubspot" }, assessment: { snapshot_hash: "hash", as_of: "2026-10-26" } };
const field = (value, status = "valid") => ({ value, status, unit: "percent", observed_at: "2026-10-20T01:00:00Z", evidence_id: `evidence:${value}` });
const snapshot = n => ({ source_version_id: `source${n}`, account_revision: n, kind: "hubspot", selected_at: `2026-10-2${n}T02:00:00Z`,
  observation_id: `observation${n}`, portal_id: "12", company_id: "34", mapping_hash: "mapping", provider_created_at: "2026-10-01T01:00:00Z",
  provider_updated_at: "2026-10-20T02:00:00Z", fetched_at: "2026-10-20T03:00:00Z", fields: { usage_change: field(-n) } });
const record = n => ({ id: `detection${n}`, organization_id: "org", account_id: "account", actor_id: "historical actor",
  policy_version: "source-change-1", detected_at: "2026-10-26T03:00:00Z", status: "unchanged", reason: "values_unchanged",
  before: snapshot(n - 1), after: snapshot(n), event: null });

function historyHelper() {
  const filename = fileURLToPath(new URL("../lib/account-history.ts", import.meta.url)), target = new Module(filename);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return target.exports;
}
function setup(t, session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } }) {
  const filename = fileURLToPath(new URL("../components/account-chronology.tsx", import.meta.url));
  const slots = [], cleanups = [], requests = [], listeners = new Map(); let cursor = 0, effects = [], selected = view, unmounted = false;
  const previous = globalThis.window;
  const surface = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  globalThis.window = surface;
  const unmount = () => {
    if (unmounted) return;
    unmounted = true; const current = globalThis.window; globalThis.window = surface;
    try { cleanups.forEach(fn => fn?.()); } finally { globalThis.window = current; }
  };
  t.after(() => { unmount(); globalThis.window = previous; });
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  const mocks = { "@/lib/account-history": historyHelper(), react: hooks, "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "./session-gate": { useSession: () => session } };
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename);
  const outer = () => target.exports.AccountChronology({ view: selected });
  const render = () => { cursor = 0; const node = outer(); const tree = typeof node?.type === "function" ? node.type(node.props) : node;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  return { requests, render, outer, setView(value) { selected = value; }, setSession(value) { session = value; },
    inspect() { return walk(render()).find(node => node.type === "button").props.onClick(); },
    unmount, emit(name) { [...(listeners.get(name) || [])].forEach(fn => fn()); } };
}
async function finish(app, pending, records = [record(5), record(4)], current = view) {
  const history = app.requests.shift(); assert.match(history.url, /accounts\/account\/detections$/); history.resolve(records); await flush();
  const final = app.requests.shift(); assert.equal(final.url, "accounts/account"); final.resolve(current); await pending;
}

test("explicit account chronology reads saved before/after sources only and keeps original dates, Unknowns and boundaries", async t => {
  const app = setup(t); app.render(); assert.equal(app.requests.length, 0);
  const original = record(5), changed = { ...original, status: "changed", reason: "values_changed", event: { id: "event5", fingerprint: "fingerprint", changes: [
    { field: "usage_change", kind: "availability_changed", before: field(null, "missing"), after: field(0) }] } };
  changed.before.fields.usage_change = field(null, "missing"); changed.after.fields.usage_change = field(0);
  changed.after.fields.name = { value: "<script>untrusted text</script>", unit: "text", status: "valid" };
  const baseline = { ...record(2), status: "baseline", reason: "first_source", before: null };
  const reset = { ...record(3), status: "source_reset", reason: "local_sample", after: { ...snapshot(3), kind: "local_sample", fields: {} } };
  const records = [baseline, changed, reset, record(4)], before = JSON.stringify(records);
  const captured = walk(app.render()).find(node => node.type === "button").props.onClick;
  const pending = captured(); await captured(); assert.equal(app.requests.length, 1);
  const all = app.requests.slice(); await finish(app, pending, records);
  const html = renderToStaticMarkup(app.render());
  for (const text of ["source5", "source4", "source3", "source2", "event5", "fingerprint", "historical actor", "Unknown", "0", "percent",
    "availability changed", "baseline", "source reset", "unchanged", "first source", "local sample", "2026-10-20T01:00:00Z",
    "2026-10-20T03:00:00Z", "2026-10-25T02:00:00Z", "2026-10-26T03:00:00Z", "observation5", "mapping", "evidence:0"]) assert.ok(html.includes(text), text);
  assert.ok(html.indexOf("detection5") < html.indexOf("detection4")); assert.ok(html.indexOf("detection4") < html.indexOf("detection3"));
  assert.match(html, /&lt;script&gt;untrusted text/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /No inferred cause or business outcome/); assert.match(html, /latest 20/);
  assert.equal(JSON.stringify(records), before); assert.equal(walk(app.render()).filter(node => node.type === "form").length, 0);
  assert.ok(all.every(request => !request.init.method && request.init.signal));
});

test("chronology rejects crossed, duplicated, later and stale snapshots without retaining prior success", async t => {
  for (const mutate of [
    x => { x.records[0].organization_id = "foreign"; }, x => { x.records[0].account_id = "foreign"; },
    x => { x.records.push(x.records[0]); }, x => { x.records[1].after.source_version_id = "source5"; },
    x => { x.records[0].after.account_revision = 6; }, x => { x.records[0].after.source_version_id = "wrong"; },
    x => { x.current.account.revision++; }, x => { x.current.account.organization_id = "foreign"; },
    x => { x.current.source.id = "wrong"; }, x => { x.current.assessment.snapshot_hash = "changed"; },
    x => { x.current.assessment.as_of = "2026-10-27"; },
  ]) {
    const app = setup(t), values = structuredClone({ records: [record(5), record(4)], current: view });
    mutate(values); const pending = app.inspect(); await finish(app, pending, values.records, values.current);
    const html = renderToStaticMarkup(app.render()); assert.match(html, /unavailable or changed/); assert.doesNotMatch(html, /historical actor/); app.unmount();
  }
  const app = setup(t); let pending = app.inspect(); await finish(app, pending);
  pending = app.inspect(); assert.doesNotMatch(renderToStaticMarkup(app.render()), /historical actor/);
  app.requests.shift().reject(new Error("private error")); await pending;
  const html = renderToStaticMarkup(app.render()); assert.match(html, /unavailable or changed/); assert.doesNotMatch(html, /historical actor|private error/);
});

test("scope, focus, detection completion and unmount clear saved chronology and fence captured/late reads", async t => {
  for (const session of [null, { mode: "sample", actor: null }, { mode: "session", actor: { organization_id: "foreign" } }]) {
    const app = setup(t, session); assert.match(renderToStaticMarkup(app.render()), /Session identity/); assert.equal(app.requests.length, 0);
  }
  const app = setup(t); const key = app.outer().key;
  for (const next of [{ ...view, account: { ...view.account, revision: 6 } }, { ...view, source: { id: "other" } },
    { ...view, assessment: { ...view.assessment, snapshot_hash: "other" } }]) { app.setView(next); assert.notEqual(app.outer().key, key); }
  app.setView(view); app.setSession({ mode: "session", actor: { id: "actor", organization_id: "org", role: "admin" } }); assert.notEqual(app.outer().key, key);
  let pending = app.inspect(); await finish(app, pending);
  for (const name of ["focus", "vitaai-detections-changed", "vitaai-source-history-changed", "vitaai-source-changed"]) {
    app.emit(name); assert.doesNotMatch(renderToStaticMarkup(app.render()), /historical actor/); assert.equal(app.requests.length, 0);
    pending = app.inspect(); const obsolete = app.requests.shift(); app.emit(name);
    obsolete.resolve([record(5)]); await pending; assert.equal(app.requests.length, 0);
  }
  const captured = walk(app.render()).find(node => node.type === "button").props.onClick;
  pending = captured(); const last = app.requests.shift(); app.unmount(); await captured(); last.resolve([record(5)]); await pending;
  assert.equal(last.init.signal.aborted, true); assert.equal(app.requests.length, 0); assert.doesNotMatch(renderToStaticMarkup(app.render()), /historical actor/);
});

test("empty, backlog and bounded history are explicit without treating missing detection as unchanged facts", async t => {
  const app = setup(t); let pending = app.inspect(); await finish(app, pending, []);
  assert.match(renderToStaticMarkup(app.render()), /No saved source detections/);
  pending = app.inspect(); await finish(app, pending, [record(4)]);
  assert.match(renderToStaticMarkup(app.render()), /does not cover the displayed source selection/);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /No changes detected/);
});
