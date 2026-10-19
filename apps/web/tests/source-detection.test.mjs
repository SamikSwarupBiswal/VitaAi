import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const id = n => `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const view = { account: { id: "a", organization_id: "org", revision: 25, name: "Account A" }, source: { id: id(25), kind: "hubspot" } };
const snapshot = n => ({ source_version_id: id(n), account_revision: n, kind: "hubspot", selected_at: "2026-10-17T01:00:00Z",
  observation_id: id(n + 100), portal_id: "12", company_id: "34", mapping_hash: "mapping", provider_created_at: "2026-10-01T00:00:00Z",
  provider_updated_at: "2026-10-15T00:00:00Z", fetched_at: "2026-10-16T00:00:00Z",
  fields: { usage_change: { value: n, status: "valid", unit: "percent", observed_at: "2026-10-14T00:00:00Z", evidence_id: `evidence-${n}` } } });
const record = n => ({ id: id(n + 200), organization_id: "org", account_id: "a", actor_id: "historical-actor", detected_at: "2026-10-18T00:00:00Z",
  status: "unchanged", reason: "values_unchanged", policy_version: "source-change-1", before: snapshot(n - 1), after: snapshot(n), event: null });
const batch = { organization_id: "org", account_id: "a", account_revision: 25, selected_source_id: id(25),
  processed: [record(20)], last_processed_revision: 20, has_more: true };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function load(relative, mocks) {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = mod.require.bind(mod); mod.require = name => name in mocks ? mocks[name] : normal(name);
  mod._compile(output, filename); return mod.exports;
}
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(item => walk(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}
function environment(t) {
  const requests = [], events = [], listeners = new Map(), selections = [];
  const previous = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { events.push(event.type); [...(listeners.get(event.type) || [])].forEach(fn => fn()); } };
  t.after(() => { globalThis.window = previous; });
  const api = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const helper = load("../lib/hubspot.ts", { "./api": { api } });
  function mount(role = "admin", initialView = view) {
    let cursor = 0, effects = [], cleanups = [], currentView = initialView;
    const slots = [];
    const hooks = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
        return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useCallback(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn; },
      useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
        slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
    };
    const panel = load("../components/source-detection-panel.tsx", { react: hooks, "@/lib/hubspot": helper,
      "./source-mission-panel": { SourceMissionPanel: props => { selections.push(props); return null; } },
      "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role } }) } });
    const render = () => { cursor = 0; const outer = panel.SourceDetectionPanel({ view: currentView });
      const tree = outer.type(outer.props); const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
    return { render, key: () => panel.SourceDetectionPanel({ view: currentView }).key,
      button: text => walk(render(), n => n.type === "button" && n.props.children === text)[0],
      form: () => walk(render(), n => n.type === "form")[0], input: () => walk(render(), n => n.type === "input")[0],
      setView(value) { currentView = value; }, unmount() { cleanups.forEach(fn => fn?.()); } };
  }
  async function settle(current = view, history = []) {
    const reads = requests.splice(0); assert.equal(reads.length, 2);
    for (const r of reads) { assert.ok(!r.init.method); r.resolve(r.url.endsWith("/detections") ? history : current); }
    await flush();
  }
  async function ready(app, current = view, history = []) { app.render(); await flush(); await settle(current, history); }
  return { requests, events, selections, helper, mount, settle, ready, focus() { globalThis.window.dispatchEvent(new Event("focus")); } };
}

test("reads never detect; explicit admin batches bind displayed revision/source and require another click", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app);
  const action = app.button("Detect saved source changes").props.onClick;
  const pending = action(); action(); assert.equal(env.requests.length, 1);
  const request = env.requests.shift(); assert.match(request.url, /accounts\/a\/detect-changes$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_account_revision: 25, expected_source_id: id(25) });
  request.resolve(batch); await flush(); await env.settle(view, [record(20)]); await pending;
  let html = renderToStaticMarkup(app.render()); assert.match(html, /Backlog remains/); assert.match(html, /20/);
  env.focus(); await flush(); await env.settle(view, [record(20)]);
  assert.equal(env.requests.length, 0);
  const again = app.button("Detect saved source changes").props.onClick(); env.requests.shift().resolve({ ...batch, processed: [], has_more: false, last_processed_revision: 25 });
  await flush(); await env.settle(view, [record(25)]); await again;
  html = renderToStaticMarkup(app.render()); assert.match(html, /0 saved selections/); assert.match(html, /No backlog/); app.unmount();
});

test("lost responses refresh saved records without mutation retry; failed refresh blocks eligibility", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app);
  const pending = app.button("Detect saved source changes").props.onClick(); env.requests.shift().reject(new Error("lost response")); await flush();
  const reads = env.requests.splice(0); reads[0].reject(new Error("refresh failed")); reads[1].resolve([]); await pending;
  assert.match(renderToStaticMarkup(app.render()), /may have persisted/);
  assert.equal(app.button("Detect saved source changes").props.disabled, true);
  await app.button("Detect saved source changes").props.onClick(); assert.equal(env.requests.length, 0);
  const refresh = app.button("Refresh detection records").props.onClick(); await env.settle(view, [record(25)]); await refresh;
  assert.equal(app.button("Detect saved source changes").props.disabled, false); app.unmount();
});

test("scope/revision/source mismatches, non-admin and missing selection deny starts", async t => {
  const env = environment(t);
  for (const role of ["viewer", "seller", "reviewer"]) {
    const app = env.mount(role); await env.ready(app); assert.equal(app.button("Detect saved source changes").props.disabled, true);
    await app.button("Detect saved source changes").props.onClick(); assert.equal(env.requests.length, 0); app.unmount();
  }
  for (const current of [{ ...view, account: { ...view.account, revision: 26 } }, { ...view, source: { id: id(26) } },
    { ...view, account: { ...view.account, organization_id: "foreign" } }]) {
    const app = env.mount(); await env.ready(app, current); assert.equal(app.button("Detect saved source changes").props.disabled, true); app.unmount();
  }
  const empty = env.mount("admin", { ...view, source: null }); await env.ready(empty, { ...view, source: null });
  assert.match(renderToStaticMarkup(empty.render()), /No saved source selection/); assert.equal(empty.button("Detect saved source changes").props.disabled, true); empty.unmount();
});

test("unmount cancels obsolete reads; in-flight guard survives remount and completion only refreshes", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app);
  const oldKey = app.key(); app.setView({ ...view, account: { ...view.account, revision: 26 } }); assert.notEqual(app.key(), oldKey);
  app.setView(view);
  const pending = app.button("Detect saved source changes").props.onClick(); const request = env.requests.shift(); app.unmount();
  const next = env.mount(); await env.ready(next); assert.equal(next.button("Detect saved source changes").props.disabled, true);
  await next.button("Detect saved source changes").props.onClick(); assert.equal(env.requests.length, 0);
  assert.equal(request.init.signal.aborted, true); request.resolve(batch); await pending; await flush();
  assert.deepEqual(env.events, ["vitaai-detections-changed"]); await env.settle(view, [record(20)]);
  assert.equal(next.button("Detect saved source changes").props.disabled, false); next.unmount();
  const obsolete = env.mount(); obsolete.render(); await flush(); const reads = env.requests.splice(0); obsolete.unmount();
  reads.forEach(r => r.resolve(r.url.endsWith("/detections") ? [record(25)] : view)); await flush();
  assert.ok(reads.every(r => r.init.signal.aborted)); assert.doesNotMatch(renderToStaticMarkup(obsolete.render()), /historical-actor/);
});

test("latest detail wins; invalid or foreign IDs never display; history order stays descending", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app, view, [record(25), record(24)]);
  const html = renderToStaticMarkup(app.render()); assert.ok(html.indexOf(id(225)) < html.indexOf(id(224)));
  const submit = async idValue => { app.input().props.onChange({ target: { value: idValue } }); app.form().props.onSubmit({ preventDefault() {} }); await flush(); };
  await submit("invalid"); assert.equal(env.requests.length, 0);
  await submit(id(224)); const old = env.requests.shift(); await submit(id(223)); env.requests.shift().resolve(record(23)); await flush();
  old.resolve(record(24)); await flush(); assert.match(renderToStaticMarkup(app.render()), /revision 23/);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Saved detection.*revision 24/);
  await submit(id(224)); env.requests.shift().resolve({ ...record(24), organization_id: "foreign", actor_id: "Private foreign text" }); await flush();
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Private foreign text/); app.unmount();
});

test("saved records render exact historical identities/status/units/dates safely, including reset and zero", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app, view, [record(24)]);
  const changed = { ...record(24), status: "changed", reason: "values_changed", event: { id: id(999), fingerprint: "fingerprint", changes: [
    { field: "usage_change", kind: "availability_changed", before: { value: null, status: "missing", unit: "percent" },
      after: { value: 0, status: "valid", unit: "percent" } }] } };
  changed.after.fields.name = { value: "<img src=x onerror=alert(1)>", status: "valid", unit: "text" };
  for (const saved of [changed, { ...record(24), status: "baseline", reason: "mapping_changed", before: null },
    { ...record(24), status: "source_reset", reason: "local_sample", after: { ...snapshot(24), kind: "local_sample", fields: {} } }]) {
    app.input().props.onChange({ target: { value: saved.id } }); app.form().props.onSubmit({ preventDefault() {} }); env.requests.shift().resolve(saved); await flush();
    const html = renderToStaticMarkup(app.render()); assert.match(html, /Historical selection/); assert.match(html, new RegExp(saved.reason.replaceAll("_", " ")));
    assert.equal(env.selections.at(-1).record, saved); assert.equal(env.selections.at(-1).view, view);
    assert.match(html, /2026-10-18T00:00:00Z/); assert.match(html, /historical-actor/); assert.doesNotMatch(html, /<img /);
    if (saved === changed) for (const text of ["availability changed", "Unknown", "0", "percent", "12", "34", id(124), "mapping", "2026-10-14T00:00:00Z", "2026-10-16T00:00:00Z", "&lt;img"]) assert.ok(html.includes(text), text);
  }
  app.unmount();
});
