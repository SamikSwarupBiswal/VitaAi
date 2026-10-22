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
const schedule = { account_id: id, organization_id: "org", account_revision: 3, configuration_revision: 7,
  configuration_hash: "a".repeat(64), connector_configured: true, ingestion_enabled: true, can_start: true,
  reason: "ready", pending_run_id: other, cooldown_until: null };
const occurrence = { id: other, account_id: id, organization_id: "org", account_revision: 2, configuration_revision: 6,
  actor_id: "original", portal_id: "1", company_id: "2", object_type: "deals", sequence: 1, revision: 1,
  status: "pending", started_at: "2026-10-21T00:00:00Z", worker_deadline_at: "2026-10-21T00:02:00Z", objects: [] };
const recovery = { run: occurrence, account_revision: 3, eligible: true };
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
  const helper = load("../lib/hubspot-ingestion.ts", { "./api": { api } });
  helper.ingestionRequests.has = shared.has.bind(shared); helper.ingestionRequests.add = shared.add.bind(shared); helper.ingestionRequests.delete = shared.delete.bind(shared);
  const panel = load("../components/hubspot-ingestion-panel.tsx", { react: hooks, "@/lib/hubspot-ingestion": helper,
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role } }) } });
  const render = () => { globalThis.window = surface; cursor = 0; const outer = panel.HubSpotIngestionPanel({ view }); const tree = outer.type(outer.props);
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render(), n => n.type === "button" && [n.props.children].flat(Infinity).join("") === text)[0];
  return { requests, events, helper, render, button,
    forms: () => walk(render(), n => n.type === "form"), inputs: () => walk(render(), n => n.type === "input"),
    fill(value = "contacts") { walk(render(), n => n.type === "select")[0].props.onChange({ target: { value } }); },
    unmount() { cleanups.forEach(fn => fn?.()); }, focus() { listeners.get("focus")?.(); },
    async reads(value = schedule, records = []) {
      assert.equal(requests.length, 3);
      requests.shift().resolve(view); const request = requests.shift();
      if (value instanceof Error) request.reject(value); else request.resolve(value);
      requests.shift().resolve(records); await flush();
    },
    async mount(value = schedule, records = []) { render(); await flush(); await this.reads(value, records); },
    async inspect(value = recovery) {
      const promise = button("Inspect pending ingestion").props.onClick();
      requests.shift().resolve(occurrence); await flush();
      const request = requests.shift(); assert.match(request.url, /recovery-readiness$/);
      if (value instanceof Error) request.reject(value); else request.resolve(value); await promise;
    },
  };
}

test("all seven explicit types bind displayed configuration; duplicates and uncertainty never replay POST", async () => {
  for (const type of ["contacts", "deals", "notes", "tasks", "calls", "meetings", "emails"]) {
    const app = harness(); await app.mount();
    assert.equal(app.button("Stage associated records").props.disabled, true);
    app.fill(type); const submit = app.forms()[0].props.onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} });
    const request = app.requests.shift(); assert.equal(app.requests.length, 0);
    assert.match(request.url, /accounts\/.*\/ingestions$/);
    assert.deepEqual(JSON.parse(request.init.body), { expected_account_revision: 3, expected_configuration_revision: 7,
      expected_configuration_hash: "a".repeat(64), object_type: type });
    request.reject(new Error("lost")); await flush(); assert.ok(app.requests.every(r => !r.init.method));
    await app.reads(); assert.match(renderToStaticMarkup(app.render()), /may have persisted/); app.unmount();
  }
});
test("captured start and inspection handlers reject edits, focus, refresh and unmount", async () => {
  for (const change of ["input", "focus", "refresh", "unmount"]) {
    const app = harness(); await app.mount(); app.fill(); const submit = app.forms()[0].props.onSubmit;
    const inspect = app.button("Inspect pending ingestion").props.onClick;
    if (change === "input") app.fill("notes");
    if (change === "focus") app.focus();
    if (change === "refresh") void app.button("Refresh ingestion records").props.onClick();
    if (change === "unmount") app.unmount();
    submit({ preventDefault() {} }); assert.ok(app.requests.every(r => !r.init.method));
    if (change !== "input") { const count = app.requests.length; inspect(); assert.equal(app.requests.length, count); }
    app.unmount();
  }
});
test("disabled/remapped starts preserve account-wide pending inspection and exact recovery", async () => {
  const app = harness(); await app.mount({ ...schedule, can_start: false, ingestion_enabled: false, connector_configured: false });
  assert.equal(app.button("Stage associated records").props.disabled, true);
  await app.inspect(); const handler = app.button("Finalize interrupted ingestion").props.onClick;
  const promise = handler(); handler(); const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.match(request.url, /ingestions\/.*\/recover$/);
  assert.deepEqual(JSON.parse(request.init.body), { expected_revision: 1, expected_account_revision: 3,
    expected_worker_deadline_at: occurrence.worker_deadline_at });
  request.reject(new Error("uncertain")); await flush(); assert.ok(app.requests.every(r => !r.init.method));
  await app.reads(); await promise; handler(); assert.equal(app.requests.length, 0); app.unmount();
});
test("failed start and recovery readiness preserve independently validated history", async () => {
  const app = harness(); await app.mount(new Error("unavailable"), [occurrence]);
  const pending = app.button(`Inspect ingestion ${other}`).props.onClick(); app.requests.shift().resolve(occurrence); await flush();
  app.requests.shift().reject(new Error("no readiness")); await pending;
  assert.match(renderToStaticMarkup(app.render()), /Saved ingestion/);
  assert.equal(app.button("Finalize interrupted ingestion").props.disabled, true);
  app.button("Finalize interrupted ingestion").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
});
test("captured recovery rejects refresh, replacement and future deadline", async () => {
  const app = harness(); await app.mount(); await app.inspect();
  const action = app.button("Finalize interrupted ingestion").props.onClick;
  const refresh = app.button("Refresh ingestion records").props.onClick(); action(); assert.equal(app.requests.length, 3);
  await app.reads(); await refresh; action(); assert.equal(app.requests.length, 0);
  const promise = app.button("Inspect pending ingestion").props.onClick();
  const future = { ...occurrence, worker_deadline_at: "2099-01-01T00:00:00Z" };
  app.requests.shift().resolve(future); await flush(); app.requests.shift().resolve({ ...recovery, run: future }); await promise;
  app.button("Finalize interrupted ingestion").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
});
test("remounted panel remains locked until old transport settles and then reloads", async () => {
  const shared = new Set(), first = harness("admin", shared); await first.mount(); first.fill();
  first.forms()[0].props.onSubmit({ preventDefault() {} }); const request = first.requests.shift(); first.unmount();
  const second = harness("admin", shared); await second.mount(); second.fill();
  assert.equal(second.button("Stage associated records").props.disabled, true);
  second.forms()[0].props.onSubmit({ preventDefault() {} }); assert.equal(second.requests.length, 0);
  request.reject(new Error("aborted")); await flush(); assert.ok(second.events.includes("vitaai-ingestion-changed"));
  await second.reads(); assert.equal(shared.size, 0); second.unmount();
});
test("viewer and crossed account/history cannot start; stale detail cannot replace selection", async () => {
  const viewer = harness("viewer"); await viewer.mount(); viewer.fill(); viewer.forms()[0].props.onSubmit({ preventDefault() {} });
  await viewer.inspect(); viewer.button("Finalize interrupted ingestion").props.onClick(); assert.equal(viewer.requests.length, 0); viewer.unmount();
  const app = harness(); await app.mount();
  const old = app.button("Inspect pending ingestion").props.onClick(), first = app.requests.shift();
  const newer = app.button("Inspect pending ingestion").props.onClick(); app.requests.shift().resolve(occurrence); await flush();
  app.requests.shift().resolve({ ...recovery, run: { ...occurrence, revision: 9 } }); await newer;
  first.resolve({ ...occurrence, organization_id: "foreign" }); await old;
  assert.equal(app.button("Finalize interrupted ingestion").props.disabled, true); app.unmount();
});
test("required timestamps reject null/missing/naive while nullable finish and legacy hash remain valid", () => {
  const app = harness(), check = app.helper.checkIngestion;
  assert.equal(check(view, occurrence), occurrence);
  for (const field of ["started_at", "worker_deadline_at"]) for (const value of [null, undefined, "2026-10-21", "invalid"]) {
    assert.throws(() => check(view, { ...occurrence, [field]: value }));
  }
  const object = { object_id: "23", created_at: occurrence.started_at, updated_at: occurrence.started_at,
    properties: { amount: "10.00", deal_currency_code: null }, association_types: [{ category: "HUBSPOT_DEFINED", type_id: 280, label: null }] };
  for (const field of ["created_at", "updated_at"]) for (const value of [null, undefined, "invalid"]) {
    assert.throws(() => check(view, { ...occurrence, objects: [{ ...object, [field]: value }] }));
  }
  assert.equal(check(view, { ...occurrence, finished_at: null, configuration_hash: null, objects: [object] }).objects[0], object);
  assert.throws(() => check(view, { ...occurrence, objects: [{ ...object, association_types: [{ category: "bad", type_id: 0 }] }] }));
  app.unmount();
});
test("saved ID lookup preserves raw text/null/dates and rejects foreign identity", async () => {
  const app = harness(); await app.mount(); app.inputs()[0].props.onChange({ target: { value: other } });
  const promise = app.forms()[1].props.onSubmit({ preventDefault() {} });
  const saved = { ...occurrence, status: "succeeded", objects: [{ object_id: "23", created_at: occurrence.started_at,
    updated_at: occurrence.started_at, properties: { amount: "10.00", deal_currency_code: null, dealname: "<script>" },
    association_types: [{ category: "HUBSPOT_DEFINED", type_id: 280, label: null }] }] };
  app.requests.shift().resolve(saved); await flush(); app.requests.shift().resolve({ ...recovery, run: saved, eligible: false }); await flush(); await promise;
  const markup = renderToStaticMarkup(app.render()); assert.match(markup, /10.00/); assert.match(markup, /&lt;script&gt;/); assert.match(markup, /2026-10-21T00:00:00Z/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("crossed current account, readiness and history disable starts without displaying foreign records", async () => {
  for (const crossing of ["account", "readiness", "history"]) {
    const app = harness(); app.render(); await flush();
    app.requests.shift().resolve(crossing === "account" ? { ...view, account: { ...view.account, revision: 4 } } : view);
    app.requests.shift().resolve(crossing === "readiness" ? { ...schedule, organization_id: "foreign" } : schedule);
    app.requests.shift().resolve(crossing === "history" ? [{ ...occurrence, account_id: other }] : []); await flush(); app.fill();
    assert.equal(app.button("Stage associated records").props.disabled, true);
    app.forms()[0].props.onSubmit({ preventDefault() {} }); assert.equal(app.requests.length, 0);
    assert.equal(app.button(`Inspect ingestion ${other}`), undefined); app.unmount();
  }
});
test("detail identity and exact recovery account/deadline bindings reject successful crossed responses", async () => {
  for (const crossing of ["identity", "account", "deadline"]) {
    const app = harness(); await app.mount();
    const promise = app.button("Inspect pending ingestion").props.onClick();
    app.requests.shift().resolve(crossing === "identity" ? { ...occurrence, id } : occurrence); await flush();
    if (crossing !== "identity") {
      app.requests.shift().resolve(crossing === "account" ? { ...recovery, account_revision: 4 }
        : { ...recovery, run: { ...occurrence, worker_deadline_at: "2099-01-01T00:00:00Z" } });
    }
    await promise; const action = app.button("Finalize interrupted ingestion");
    if (action) { assert.equal(action.props.disabled, true); action.props.onClick(); }
    assert.equal(app.requests.length, 0); app.unmount();
  }
});
test("session/organization scope and actor/account/source changes bound the private panel", () => {
  let session = { mode: "sample", actor: null };
  const panel = load("../components/hubspot-ingestion-panel.tsx", { "@/lib/hubspot-ingestion": {},
    "./session-gate": { useSession: () => session } });
  assert.equal(panel.HubSpotIngestionPanel({ view }), null);
  session = { mode: "session", actor: { id: "actor", organization_id: "foreign", role: "admin" } };
  assert.equal(panel.HubSpotIngestionPanel({ view }), null);
  session.actor.organization_id = "org"; const original = panel.HubSpotIngestionPanel({ view }).key;
  for (const next of [{ ...view, account: { ...view.account, revision: 4 } }, { ...view, source: { id: other } }]) {
    assert.notEqual(panel.HubSpotIngestionPanel({ view: next }).key, original);
  }
  session.actor.role = "viewer"; assert.notEqual(panel.HubSpotIngestionPanel({ view }).key, original);
});
