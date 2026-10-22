import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8", other = "39d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
const view = { account: { id, organization_id: "org", revision: 3, name: "Synthetic account" }, source: null };
const schedule = { account_id: id, organization_id: "org", account_revision: 3, configuration_hash: "a".repeat(64),
  authorization: null, can_authorize: true, worker_available: false, pending_occurrence_id: other };
const occurrence = { schema_version: "1", id: other, account_id: id, organization_id: "org", authorization_id: id,
  authorization_revision: 2, revision: 1, slot: 0, sync_run_id: other, status: "pending",
  due_at: "2026-10-21T00:00:00Z", started_at: "2026-10-21T00:00:00Z", worker_deadline_at: "2026-10-21T00:02:00Z" };
const grant = { id: other, account_id: id, organization_id: "org", account_revision: 2, revision: 7, status: "authorized",
  configuration_hash: "b".repeat(64), portal_id: "1", company_id: "2", mapping_hash: "c".repeat(64),
  interval_seconds: 900, authorized_at: "2026-10-21T00:00:00Z", first_due_at: "2026-10-21T00:15:00Z", expires_at: "2026-10-21T01:00:00Z" };
const recovery = { occurrence, account_revision: 3, eligible: true };
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
function harness(role = "admin", shared = new Set()) {
  const slots = [], requests = [], listeners = new Map(), events = [];
  let cursor = 0, effects = [], cleanups = [];
  const surface = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
    dispatchEvent(event) { events.push(event.type); listeners.get(event.type)?.(); } };
  globalThis.window = surface;
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const api = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const hubspot = { accountPath: id => `integrations/hubspot/accounts/${id}` };
  const helper = load("../lib/hubspot-refresh.ts", { "./api": { api }, "./hubspot": hubspot });
  helper.refreshRequests.has = shared.has.bind(shared); helper.refreshRequests.add = shared.add.bind(shared); helper.refreshRequests.delete = shared.delete.bind(shared);
  const panel = load("../components/hubspot-refresh-panel.tsx", { react: hooks, "@/lib/hubspot-refresh": helper, "@/lib/hubspot": hubspot,
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role } }) } });
  const render = () => { globalThis.window = surface; cursor = 0; const outer = panel.HubSpotRefreshPanel({ view }); const tree = outer.type(outer.props);
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render(), n => n.type === "button" && [n.props.children].flat(Infinity).join("") === text)[0];
  return { requests, events, helper, render, button,
    forms: () => walk(render(), n => n.type === "form"), inputs: () => walk(render(), n => n.type === "input"),
    fill() { const inputs = this.inputs(); inputs[0].props.onChange({ target: { value: "900" } }); inputs[1].props.onChange({ target: { value: "3600" } }); },
    unmount() { cleanups.forEach(fn => fn?.()); }, focus() { listeners.get("focus")?.(); },
    async reads(value = schedule, records = []) {
      assert.equal(requests.length, 3);
      requests.shift().resolve(view); const request = requests.shift();
      if (value instanceof Error) request.reject(value); else request.resolve(value);
      requests.shift().resolve(records); await flush();
    },
    async mount(value = schedule, records = []) { render(); await flush(); await this.reads(value, records); },
    async inspect(value = recovery) {
      const promise = button("Inspect pending staging occurrence").props.onClick();
      requests.shift().resolve(occurrence); await flush();
      const request = requests.shift(); assert.match(request.url, /recovery-readiness$/);
      if (value instanceof Error) request.reject(value); else request.resolve(value); await promise;
    },
  };
}

test("explicit duration/interval bind current schedule and duplicate/lost responses only refresh reads", async () => {
  const app = harness(); await app.mount(); app.fill();
  const submit = app.forms()[0].props.onSubmit;
  submit({ preventDefault() {} }); submit({ preventDefault() {} });
  const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_revision: 0, expected_account_revision: 3,
    expected_configuration_hash: "a".repeat(64), interval_seconds: 900, duration_seconds: 3600 });
  request.reject(new Error("uncertain")); await flush(); assert.ok(app.requests.every(r => !r.init.method));
  await app.reads({ ...schedule, authorization: grant }); assert.match(renderToStaticMarkup(app.render()), /may have persisted/); app.unmount();
});

test("captured grant handlers reject input edits, focus and refresh before rerender", async () => {
  for (const edit of ["input", "focus", "refresh"]) {
    const app = harness(); await app.mount(); app.fill(); const submit = app.forms()[0].props.onSubmit;
    if (edit === "input") app.inputs()[0].props.onChange({ target: { value: "1200" } });
    if (edit === "focus") app.focus();
    if (edit === "refresh") void app.button("Refresh staging records").props.onClick();
    submit({ preventDefault() {} }); assert.ok(app.requests.every(r => !r.init.method)); app.unmount();
  }
});

test("disabled/remapped grant still permits exact retained revocation and occurrence finalization", async () => {
  const app = harness(); await app.mount({ ...schedule, can_authorize: false, authorization: grant });
  assert.equal(app.button("Revoke refresh authorization").props.disabled, false);
  const revoke = app.button("Revoke refresh authorization").props.onClick();
  let request = app.requests.shift(); assert.match(request.url, /refresh-schedule\/revoke$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_revision: 7 });
  request.resolve({}); await flush(); await app.reads({ ...schedule, can_authorize: false }); await revoke;
  await app.inspect(); const action = app.button("Finalize interrupted staging occurrence").props.onClick;
  const recover = action(); action(); request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.match(request.url, /refresh-occurrences\/.*\/recover$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_revision: 1, expected_account_revision: 3,
    expected_worker_deadline_at: occurrence.worker_deadline_at });
  request.reject(new Error("lost")); await flush(); await app.reads(); await recover; app.unmount();
});

test("failed schedule or recovery reads preserve independent history without enabling finalization", async () => {
  const app = harness(); await app.mount(new Error("disabled"), [occurrence]);
  const read = app.button(`Inspect occurrence ${other}`).props.onClick(); app.requests.shift().resolve(occurrence); await flush();
  app.requests.shift().reject(new Error("unavailable")); await read;
  assert.match(renderToStaticMarkup(app.render()), /Saved refresh occurrence/);
  assert.equal(app.button("Finalize interrupted staging occurrence").props.disabled, true);
  assert.equal(app.button("Authorize scheduled staging reads").props.disabled, true); app.unmount();
});

test("captured recovery and saved-sync handlers cannot survive refresh or replacement inspection", async () => {
  const app = harness(); await app.mount(); await app.inspect();
  const recover = app.button("Finalize interrupted staging occurrence").props.onClick;
  const sync = app.button("Inspect saved staging result").props.onClick;
  const refresh = app.button("Refresh staging records").props.onClick(); recover(); sync();
  assert.equal(app.requests.length, 3); assert.ok(app.requests.every(r => !r.init.method));
  await app.reads(); await refresh; recover(); sync(); assert.equal(app.requests.length, 0); app.unmount();
});

test("remount locks persist until mutation transport settles and completion invalidates mounted readers", async () => {
  const shared = new Set(), first = harness("admin", shared); await first.mount(); first.fill(); first.forms()[0].props.onSubmit({ preventDefault() {} });
  const request = first.requests.shift(); first.unmount();
  const second = harness("admin", shared); await second.mount(); second.fill();
  assert.equal(second.button("Authorize scheduled staging reads").props.disabled, true);
  second.forms()[0].props.onSubmit({ preventDefault() {} }); assert.equal(second.requests.length, 0);
  request.reject(new Error("aborted")); await flush(); assert.ok(second.events.includes("vitaai-refresh-changed"));
  await second.reads(); assert.equal(shared.size, 0); second.unmount();
});

test("scope/revision/deadline crossing rejects records and late inspections cannot replace selection", async () => {
  const app = harness(); await app.mount();
  const old = app.button("Inspect pending staging occurrence").props.onClick(), first = app.requests.shift();
  const newer = app.button("Inspect pending staging occurrence").props.onClick(); app.requests.shift().resolve(occurrence); await flush();
  app.requests.shift().resolve({ ...recovery, occurrence: { ...occurrence, worker_deadline_at: "2099-01-01T00:00:00Z" } }); await newer;
  first.resolve({ ...occurrence, account_id: other }); await old;
  assert.equal(app.button("Finalize interrupted staging occurrence").props.disabled, true);
  assert.match(renderToStaticMarkup(app.render()), /Recovery readiness unavailable/); app.unmount();
});

test("viewer captured form and recovery callbacks cannot mutate; saved sync is a separate scoped read", async () => {
  const app = harness("viewer"); await app.mount(); app.fill(); app.forms()[0].props.onSubmit({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  await app.inspect(); app.button("Finalize interrupted staging occurrence").props.onClick(); assert.equal(app.requests.length, 0);
  const promise = app.button("Inspect saved staging result").props.onClick(); const read = app.requests.shift(); assert.match(read.url, /hubspot\/runs\//); assert.equal(read.init.method, undefined);
  read.resolve({ id: other, account_id: id, organization_id: "foreign" }); await promise;
  assert.match(renderToStaticMarkup(app.render()), /No confirmed saved sync result/); app.unmount();
});

test("saved sync read preserves original result and dates without source promotion", async () => {
  const app = harness(); await app.mount(); await app.inspect();
  const promise = app.button("Inspect saved staging result").props.onClick();
  app.requests.shift().resolve({ id: other, account_id: id, organization_id: "org", status: "succeeded", disposition: "unchanged",
    observation_id: id, started_at: occurrence.started_at, finished_at: "2026-10-21T00:00:01Z" }); await promise;
  const markup = renderToStaticMarkup(app.render()); assert.match(markup, /unchanged/); assert.match(markup, /2026-10-21T00:00:01Z/);
  assert.match(markup, /does not establish current selected facts/); assert.equal(app.requests.length, 0); app.unmount();
});

test("future deadline blocks even captured eligible recovery and stale revoked handlers cannot POST", async () => {
  const app = harness(); await app.mount({ ...schedule, authorization: grant });
  const revoke = app.button("Revoke refresh authorization").props.onClick;
  const refresh = app.button("Refresh staging records").props.onClick(); revoke(); assert.ok(app.requests.every(r => !r.init.method));
  await app.reads(); await refresh;
  const pending = app.button("Inspect pending staging occurrence").props.onClick();
  const future = { ...occurrence, worker_deadline_at: "2099-01-01T00:00:00Z" };
  app.requests.shift().resolve(future); await flush(); app.requests.shift().resolve({ ...recovery, occurrence: future }); await pending;
  await app.button("Finalize interrupted staging occurrence").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
});

test("crossed current account or history blocks new grants and foreign occurrences never display", async () => {
  const app = harness(); app.render(); await flush(); app.requests.shift().resolve({ ...view, account: { ...view.account, revision: 4 } });
  app.requests.shift().resolve(schedule); app.requests.shift().resolve([{ ...occurrence, organization_id: "foreign" }]); await flush(); app.fill();
  assert.equal(app.button("Authorize scheduled staging reads").props.disabled, true);
  app.forms()[0].props.onSubmit({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  assert.equal(app.button(`Inspect occurrence ${other}`), undefined); app.unmount();
});
