import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
globalThis.window = { dispatchEvent() {} };
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const account = { account: { id: "a", organization_id: "org", revision: 3, name: "Account A" }, source: null };
const preview = { observation_id: "observation", expected_account_revision: 3, mapping_hash: "mapping", preview_hash: "displayed-hash",
  account: { ...account.account, revision: 4, annual_value: null, renewal_date: null, synthetic: false }, evidence: [],
  field_status: { annual_value: "unconfigured", renewal_date: "invalid", usage_change: "missing" } };
const observation = { id: "observation", account_id: "a", organization_id: "org", portal_id: "12", company_id: "34",
  provider_updated_at: "2026-10-16T00:00:00Z", fetched_at: "2026-10-17T00:00:00Z", properties: { name: "Source name" } };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function load(relative, mocks, extra = "") {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(output + extra, filename); return target.exports;
}
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(item => walk(item, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}
function harness(role = "admin") {
  let cursor = 0, effects = [], cleanups = [], invalidations = 0, refreshes = [];
  const slots = [], requests = [];
  const hooks = {
    createElement: require("react").createElement,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(callback, deps) { const i = cursor++;
      if (!(i in slots) || deps.some((value, index) => value !== slots[i][index])) {
        slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); });
      }
    },
  };
  const api = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const integration = load("../lib/hubspot.ts", { "./api": { api } });
  const panel = load("../components/hubspot-panel.tsx", { react: hooks, "@/lib/api": { api, currency: value => value === null ? "Unknown" : `$${value}` }, "@/lib/hubspot": integration,
    "./session-gate": { useSession: () => ({ mode: "session", actor: { role, id: "actor", organization_id: "org" } }) } });
  let view = account;
  const render = () => { cursor = 0; const outer = panel.HubSpotPanel({ view, onInvalidate() { invalidations++; },
    async onRefresh(message) { refreshes.push(message); } }); const tree = outer.type(outer.props);
    const pending = effects; effects = []; pending.forEach(effect => effect()); return tree; };
  const button = label => walk(render(), node => node.type === "button" && node.props.children === label)[0];
  return { requests, render, button, setView(value) { view = value; }, unmount() { cleanups.forEach(fn => fn?.()); },
    invalidations: () => invalidations, refreshes: () => refreshes };
}
async function ready(app) {
  app.render(); app.requests.shift().resolve({ configured: true, status: "configured_unverified" }); await flush();
}
async function showPreview(app) {
  const pending = app.button("Load normalization preview").props.onClick();
  app.requests.shift().resolve(preview); await flush();
  app.requests.shift().resolve(observation); await pending;
}

test("exact preview, missing fields and provenance bind explicit admin promotion", async () => {
  const app = harness(); await ready(app); await showPreview(app);
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /annual value: unconfigured/); assert.match(html, /renewal date: invalid/);
  assert.match(html, /displayed-hash/); assert.match(html, /2026-10-16T00:00:00Z/);
  assert.match(html, /Unknown/); assert.match(html, /No normalized metric evidence/);
  const pending = app.button("Use displayed HubSpot preview").props.onClick();
  const request = app.requests.shift();
  assert.equal(request.url, "integrations/hubspot/accounts/a/promote");
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_account_revision: 3, observation_id: "observation", preview_hash: "displayed-hash" });
  assert.equal(app.invalidations(), 1);
  // A double click from the same render cannot send another mutation.
  await app.button("Use displayed HubSpot preview").props.onClick(); assert.equal(app.requests.length, 0);
  request.resolve({ kind: "hubspot", account_revision: 4 }); await pending;
  assert.equal(app.refreshes().length, 1);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Use displayed HubSpot preview/);
});

test("lost mutation responses clear previews, disclose uncertainty and require shared refresh", async () => {
  const app = harness(); await ready(app); await showPreview(app);
  const pending = app.button("Use displayed HubSpot preview").props.onClick();
  app.requests.shift().reject(new Error("Connection lost")); await pending;
  assert.match(app.refreshes()[0], /may have/);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /displayed-hash/);
});

test("sync uses current revision, reports failed runs and never promotes automatically", async () => {
  const app = harness(); await ready(app);
  const pending = app.button("Sync mapped company (read only)").props.onClick();
  const request = app.requests.shift(); assert.equal(request.url, "integrations/hubspot/accounts/a/sync");
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_account_revision: 3 });
  request.resolve({ id: "run", status: "failed", error_code: "hubspot_timeout" }); await pending;
  assert.match(app.refreshes()[0], /hubspot_timeout/); assert.equal(app.requests.length, 0);
});

test("role, revision and unmount guards deny stale operations and late previews", async () => {
  for (const role of ["viewer", "seller", "reviewer"]) {
    const app = harness(role); await ready(app); await showPreview(app);
    assert.equal(app.button("Sync mapped company (read only)").props.disabled, true);
    await app.button("Sync mapped company (read only)").props.onClick();
    assert.equal(app.button("Use displayed HubSpot preview").props.disabled, true);
    await app.button("Use displayed HubSpot preview").props.onClick(); assert.equal(app.requests.length, 0);
  }
  const app = harness(); await ready(app);
  const pending = app.button("Load normalization preview").props.onClick(); const stale = app.requests.shift();
  app.unmount(); stale.resolve(preview); await pending;
  assert.equal(stale.init.signal.aborted, true); assert.equal(app.requests.length, 0);
  const changed = harness(); await ready(changed);
  const loading = changed.button("Load normalization preview").props.onClick();
  changed.requests.shift().resolve({ ...preview, expected_account_revision: 2 }); await loading;
  assert.match(renderToStaticMarkup(changed.render()), /changed/);
  assert.equal(changed.requests.length, 0);
});

test("restoration is explicit and source lookup rejects another account before display", async () => {
  const app = harness();
  app.setView({ ...account, source: { id: "12345678-1234-1234-1234-123456789012", kind: "hubspot" } });
  app.render(); app.requests.shift().resolve({ configured: false, status: "unconfigured" }); await flush();
  app.requests.shift().resolve({ account_id: "other", selection: { id: "foreign" } }); await flush();
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /foreign/);
  const pending = app.button("Restore original synthetic facts").props.onClick();
  const request = app.requests.shift(); assert.equal(request.url, "integrations/hubspot/accounts/a/restore-sample");
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_account_revision: 3 });
  request.resolve({ kind: "local_sample", account_revision: 4 }); await pending;
  assert.match(app.refreshes()[0], /original/);
});

test("explicit history lookup wins over delayed automatic success or failure", async () => {
  const currentId = "11111111-1111-1111-1111-111111111111", earlierId = "22222222-2222-2222-2222-222222222222";
  const version = id => ({ account_id: "a", account: account.account,
    selection: { id, kind: "hubspot", account_revision: id === currentId ? 3 : 2, actor_id: "historical-actor", selected_at: "2026-10-16T00:00:00Z" } });
  for (const outcome of ["success", "failure"]) {
    const app = harness(); app.setView({ ...account, source: { id: currentId, kind: "hubspot" } });
    app.render(); app.requests.shift().resolve({ configured: true, status: "configured_unverified" });
    const automatic = app.requests.shift(); await flush();
    const input = walk(app.render(), node => node.type === "input")[0]; input.props.onChange({ target: { value: earlierId } });
    const pending = app.button("Load source version").props;
    const form = walk(app.render(), node => node.type === "form")[0];
    assert.equal(pending.disabled, false); form.props.onSubmit({ preventDefault() {} });
    app.requests.shift().resolve(version(earlierId)); await flush();
    if (outcome === "success") automatic.resolve(version(currentId)); else automatic.reject(new Error("Late failure"));
    await flush(); const html = renderToStaticMarkup(app.render());
    assert.match(html, new RegExp(`version ${earlierId}`)); assert.doesNotMatch(html, /Current source history unavailable/);
    assert.doesNotMatch(html, new RegExp(`version ${currentId}`));
    assert.match(html, /<h2>Source history<\/h2>/);
  }
});

function workspaceHarness(t) {
  let cursor = 0, effects = [], cleanups = [];
  const slots = [], requests = [], listeners = {};
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = { addEventListener: (name, fn) => { listeners[name] = fn; }, removeEventListener: name => { delete listeners[name]; },
    dispatchEvent: event => listeners[event.type]?.() };
  globalThis.document = { documentElement: { dataset: {} } };
  t.after(() => { globalThis.window = previous.window; globalThis.document = previous.document; });
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn) { const i = cursor++; if (!(i in slots)) slots[i] = fn; return slots[i]; },
    useMemo: fn => fn(),
    useEffect(callback, deps) { const i = cursor++; if (!(i in slots) || deps.some((value, index) => value !== slots[i][index])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); }); } },
  };
  const children = Object.fromEntries(["AccountTable", "AccountDetail", "PipelinePanel", "HubSpotPanel", "ResearchPanel", "SourceDetectionPanel"].map(name => [name, () => null]));
  const workspace = load("../components/workspace.tsx", { react: hooks,
    "next/navigation": { useRouter: () => ({}), useSearchParams: () => new URLSearchParams({ account: "a" }) },
    "next/link": { __esModule: true, default: () => null }, "./session-gate": {},
    "./account-table": children, "./account-detail": children, "./pipeline-panel": children, "./hubspot-panel": children, "./research-panel": children, "./source-detection-panel": children,
    "@/lib/api": { currency: String, api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
  }, "\nexports.contentForAcceptance = WorkspaceContent;");
  const render = () => { cursor = 0; const tree = workspace.contentForAcceptance({ accountDirectory: false, persona: "operations" });
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const child = name => walk(render(), node => node.type === children[name])[0];
  const data = revision => ({ organization_id: "org", mode: "hubspot", as_of: "2026-10-18", annual_value: 0,
    accounts: [{ ...account, account: { ...account.account, revision }, assessment: { snapshot_hash: `snapshot-${revision}` } }] });
  render();
  return { requests, render, child, data, listeners, unmount() { cleanups.forEach(fn => fn?.()); },
    refreshButton: () => walk(render(), node => node.type === "button" && node.props["aria-label"] === "Refresh portfolio")[0] };
}
async function readyWorkspace(app) {
  app.requests.shift().resolve(app.data(3)); app.requests.shift().resolve({ configured: false }); await flush();
}

test("parent invalidation cancels old analysis and reads; failed refresh keeps authority blocked", async t => {
  const app = workspaceHarness(t); await readyWorkspace(app);
  const researchKey = app.child("ResearchPanel").key;
  const detectionKey = app.child("SourceDetectionPanel").key;
  const analysis = app.child("AccountDetail").props.onAnalyze(); const oldAnalysis = app.requests.shift();
  app.refreshButton().props.onClick(); const oldPortfolio = app.requests.shift(), oldProvider = app.requests.shift();
  app.child("HubSpotPanel").props.onInvalidate();
  assert.equal(oldAnalysis.init.signal.aborted, true); assert.equal(oldPortfolio.init.signal.aborted, true);
  assert.equal(app.child("AccountDetail"), undefined); assert.equal(app.child("PipelinePanel"), undefined);
  assert.equal(app.child("ResearchPanel"), undefined);
  assert.equal(app.child("SourceDetectionPanel"), undefined);
  assert.equal(app.child("HubSpotPanel").props.blocked, true);
  assert.equal(app.refreshButton().props.disabled, true);
  const refresh = app.child("HubSpotPanel").props.onRefresh("Request may have persisted.");
  app.requests.shift().reject(new Error("Refresh unavailable")); app.requests.shift().resolve({ configured: false }); await refresh;
  oldAnalysis.resolve({ id: "stale-analysis" }); await analysis;
  oldPortfolio.resolve(app.data(2)); oldProvider.resolve({ configured: true }); await flush();
  assert.equal(app.child("AccountDetail"), undefined); assert.equal(app.child("PipelinePanel"), undefined);
  assert.equal(app.refreshButton().props.disabled, false);
  app.refreshButton().props.onClick(); app.requests.shift().resolve(app.data(4)); app.requests.shift().resolve({ configured: false }); await flush();
  assert.equal(app.child("AccountDetail").props.view.account.revision, 4);
  assert.equal(app.child("AccountDetail").props.run, null);
  assert.deepEqual(app.child("PipelinePanel").props.snapshots, { a: "snapshot-4" });
  assert.equal(app.child("HubSpotPanel").props.blocked, false);
  assert.equal(app.child("ResearchPanel").props.view.account.revision, 4);
  assert.notEqual(app.child("ResearchPanel").key, researchKey);
  assert.equal(app.child("SourceDetectionPanel").props.view.account.revision, 4);
  assert.notEqual(app.child("SourceDetectionPanel").key, detectionKey);
});

test("source completion after navigation refreshes mounted workspace and mission readers", async t => {
  const app = workspaceHarness(t); await readyWorkspace(app);
  app.listeners["vitaai-source-changed"]();
  assert.equal(app.child("PipelinePanel"), undefined);
  app.requests.shift().resolve(app.data(5)); app.requests.shift().resolve({ configured: false }); await flush();
  assert.equal(app.child("AccountDetail").props.view.account.revision, 5);
  const props = app.child("HubSpotPanel").props;
  app.unmount(); await props.onRefresh("Old session"); assert.equal(app.requests.length, 0);

  const source = readFileSync(fileURLToPath(new URL("../components/mission-workspace.tsx", import.meta.url)), "utf8");
  const output = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS } }).outputText;
  const filename = fileURLToPath(new URL("../components/mission-workspace.tsx", import.meta.url));
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target); const effects = [], events = {}; let cursor = 0; const states = [];
  target.require = name => name === "react" ? { useState(initial) { const i = cursor++; states[i] ??= initial;
    return [states[i], fn => { states[i] = typeof fn === "function" ? fn(states[i]) : fn; }]; }, useEffect: fn => effects.push(fn) }
    : name === "next/navigation" ? { useSearchParams: () => new URLSearchParams(), useRouter: () => ({}) }
    : name.startsWith("@/") || name === "./session-gate" ? {} : normal(name);
  target._compile(output + "\nexports.directoryForAcceptance = MissionDirectory;", filename);
  globalThis.window = { addEventListener: (name, fn) => { events[name] = fn; }, removeEventListener: name => { delete events[name]; } };
  target.exports.directoryForAcceptance(); const cleanup = effects[0]();
  events["vitaai-source-changed"](); assert.equal(states[0], 1);
  events.focus(); assert.equal(states[0], 2); cleanup(); assert.deepEqual(events, {});
});
