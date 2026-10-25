import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const id = "11111111-1111-4111-8111-111111111111";
const view = { account: { id: "account", organization_id: "org", revision: 1 }, assessment: { snapshot_hash: "a".repeat(64) } };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
function walk(node, type) {
  if (Array.isArray(node)) return node.flatMap(item => walk(item, type));
  if (!node || typeof node !== "object") return [];
  return [...(node.type === type ? [node] : []), ...walk(node.props?.children, type)];
}
function harness(file, name, props, helpers) {
  const slots = [], requests = [], listeners = new Map(), timers = [], initial = [], cleanups = [];
  let cursor = 0, effects = [];
  const hooks = {
    useState(value) { const i = cursor++; if (!(i in slots)) slots[i] = value;
      return [slots[i], next => { slots[i] = typeof next === "function" ? next(slots[i]) : next; }]; },
    useRef(value) { const i = cursor++; if (!(i in slots)) slots[i] = { current: value }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  globalThis.window = { setTimeout(fn) { initial.push(fn); return initial.length; }, clearTimeout() {},
    setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    addEventListener(event, fn) { listeners.set(event, fn); }, removeEventListener(event) { listeners.delete(event); },
    dispatchEvent(event) { listeners.get(event.type)?.(); } };
  const request = (kind, body, signal) => new Promise((resolve, reject) => requests.push({ kind, body, signal, resolve, reject }));
  const mocks = { react: hooks, "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role: "admin" } }) },
    "@/lib/api": { api: (_url, init) => request(init.method || "GET", init.body && JSON.parse(init.body), init.signal) }, ...helpers(request) };
  const filename = fileURLToPath(new URL(`../components/${file}.tsx`, import.meta.url));
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = mod.require.bind(mod); mod.require = key => key in mocks ? mocks[key] : normal(key);
  mod._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  const render = () => { cursor = 0; const outer = mod.exports[name](props), tree = outer.type(outer.props);
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const nodes = type => walk(render(), type);
  return { requests, render, nodes, button: text => nodes("button").find(n => [n.props.children].flat(Infinity).join("") === text),
    html: () => renderToStaticMarkup(render()), start() { initial.splice(0).forEach(fn => fn()); },
    focus() { listeners.get("focus")?.(); }, tick() { timers.forEach(fn => fn()); }, unmount() { cleanups.forEach(fn => fn?.()); } };
}

test("identity decisions bind exact source, invalidate captured forms and never replay uncertain saves", async () => {
  const run = { id, revision: 2, target: { company_name: "Example Company", domain: "example.test" },
    sources: [{ url: "https://publisher.test/article", title: "Example Company update" }] };
  const ready = { organization_id: "org", account_id: "account", account_revision: 1, snapshot_hash: "a".repeat(64),
    run_id: id, run_revision: 2, sources_hash: "b".repeat(64), decisions: [], history: [], can_review: true };
  const pending = new Set();
  const app = harness("research-identity-panel", "ResearchIdentityPanel", { view, run }, () => ({ "@/lib/research": { researchPending: pending } }));
  app.render(); assert.equal(app.requests.length, 0);
  app.button("Inspect identity records").props.onClick(); app.requests.shift().resolve(ready); await flush();
  app.nodes("input")[0].props.onChange({ target: { value: "Example Company" } });
  app.nodes("textarea")[0].props.onChange({ target: { value: "<script>uncertain subject</script>" } });
  const captured = app.nodes("form")[0].props.onSubmit;
  app.nodes("textarea")[0].props.onChange({ target: { value: "Exact current uncertainty" } });
  await captured({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  const submit = app.nodes("form")[0].props.onSubmit;
  const save = submit({ preventDefault() {} }); submit({ preventDefault() {} });
  assert.equal(app.requests.length, 1); assert.equal(pending.has("org"), true);
  const request = app.requests.shift(); assert.equal(request.kind, "POST");
  assert.equal(request.body.expected_sources_hash, ready.sources_hash); assert.equal(request.body.expected_revision, 0);
  assert.equal(request.body.source_url, run.sources[0].url); assert.equal(request.body.decision, "uncertain");
  assert.deepEqual(request.body.references, []); assert.equal(request.body.note, "Exact current uncertainty");
  request.reject(new Error("lost response")); await save;
  assert.equal(pending.size, 0); assert.equal(app.requests.length, 0); assert.match(app.html(), /may have persisted/);
  app.button("Inspect identity records").props.onClick(); app.requests.shift().resolve(ready); await flush();
  const stale = app.nodes("form")[0].props.onSubmit; app.focus();
  await stale({ preventDefault() {} }); assert.equal(app.requests.length, 0); app.unmount();
});

test("identity inspection rejects foreign data and corroboration requires reference evidence", async () => {
  const run = { id, revision: 2, target: { company_name: "Example", domain: "example.test" }, sources: [{ url: "https://example.test/update", title: "Example" }] };
  const ready = { organization_id: "org", account_id: "account", account_revision: 1, snapshot_hash: "a".repeat(64),
    run_id: id, run_revision: 2, sources_hash: "b".repeat(64), decisions: [], history: [], can_review: true };
  const app = harness("research-identity-panel", "ResearchIdentityPanel", { view, run }, () => ({ "@/lib/research": { researchPending: new Set() } }));
  app.render(); app.button("Inspect identity records").props.onClick(); app.requests.shift().resolve({ ...ready, run_id: "foreign" }); await flush();
  assert.match(app.html(), /unavailable/); assert.equal(app.nodes("form").length, 0);
  app.button("Inspect identity records").props.onClick(); app.requests.shift().resolve(ready); await flush();
  app.nodes("select")[1].props.onChange({ target: { value: "corroborated" } });
  app.nodes("input")[0].props.onChange({ target: { value: "Example" } });
  app.nodes("textarea")[0].props.onChange({ target: { value: "Insufficient reference" } });
  await app.nodes("form")[0].props.onSubmit({ preventDefault() {} }); assert.equal(app.requests.length, 0); app.unmount();
});

test("quality child rejects captured input/focus and uncertain saves never replay", async () => {
  const run = { id, revision: 1, sources: [{ url: "https://example.test/update", title: "Retained source" }] };
  const ready = { organization_id: "org", account_id: "account", account_revision: 1, snapshot_hash: "a".repeat(64),
    run_id: id, run_revision: 1, sources_hash: "b".repeat(64), latest_revision: 0, reviews: [], can_review: true };
  const app = harness("research-quality-panel", "ResearchQualityPanel", { view, run }, () => ({}));
  app.render(); assert.equal(app.requests.length, 0);
  app.button("Inspect source-quality records").props.onClick(); app.requests.shift().resolve(ready); await flush();
  app.nodes("textarea")[0].props.onChange({ target: { value: "First human note" } });
  const old = app.nodes("form")[0].props.onSubmit;
  app.nodes("textarea")[0].props.onChange({ target: { value: "Current human note" } });
  await old({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  const submit = app.nodes("form")[0].props.onSubmit;
  const pending = submit({ preventDefault() {} }); submit({ preventDefault() {} });
  const request = app.requests.shift(); assert.equal(request.kind, "POST");
  assert.equal(request.body.note, "Current human note"); assert.equal(request.body.expected_sources_hash, ready.sources_hash);
  request.reject(new Error("lost response")); await pending; assert.equal(app.requests.length, 0);
  assert.match(app.html(), /may have persisted/);
  app.button("Inspect source-quality records").props.onClick(); app.requests.shift().resolve(ready); await flush();
  const captured = app.nodes("form")[0].props.onSubmit; app.focus();
  await captured({ preventDefault() {} }); assert.equal(app.requests.length, 0); app.unmount();
});

test("saved fusion child invalidates edited IDs, late reads, focus and expiry", async () => {
  let usable = true;
  const app = harness("saved-research-fusion", "SavedResearchFusion", { current: { id: "pipeline", organization_id: "org" }, accountId: "account" }, request => ({
    "@/lib/research": { researchContextUsable: () => usable }, "./research-panel": { ResearchContextRecord: () => null },
    "@/lib/research-fusion": { savedResearchId: /^[a-f0-9-]{36}$/, readSavedResearchFusion: (_p, _a, key, signal) => request("GET", key, signal) },
  }));
  app.render(); app.nodes("input")[0].props.onChange({ target: { value: id } });
  const old = app.nodes("form")[0].props.onSubmit;
  app.nodes("input")[0].props.onChange({ target: { value: "22222222-2222-4222-8222-222222222222" } });
  await old({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  const pending = app.nodes("form")[0].props.onSubmit({ preventDefault() {} }); const late = app.requests.shift();
  app.focus(); late.resolve({ research_context: {}, research_specialist: { findings: [{ question: "obsolete" }] } }); await pending;
  assert.equal(late.signal.aborted, true); assert.doesNotMatch(app.html(), /obsolete/);
  const latest = app.nodes("form")[0].props.onSubmit({ preventDefault() {} });
  app.requests.shift().resolve({ pipeline_run_id: "pipeline", research_context: {}, research_specialist: {
    findings: [{ question: "Verify retained source", evidence_ids: [], source_urls: [] }] } }); await latest;
  assert.match(app.html(), /Verify retained source/); usable = false; app.tick();
  assert.doesNotMatch(app.html(), /Verify retained source/); assert.equal(app.requests.length, 0); app.unmount();
});

test("seed child blocks missing version history and captured review after refresh", async () => {
  const job = { id, revision: 1, sequence: 1, account_id: "account", account_revision: 1, status: "draft", test_portal_id: "456",
    expires_at: "2099-01-01T00:00:00Z", review_expires_at: "2099-01-01T00:00:00Z", items: [], preview: { created_at: "2026-10-24T00:00:00Z" } };
  const inspection = { job, can_review: true, can_execute: true };
  const app = harness("hubspot-seed-panel", "HubSpotSeedPanel", { view }, request => ({ "@/lib/hubspot-seeding": {
    seedId: /^[a-f0-9-]{36}$/, readSeedReadiness: (_v, signal) => request("ready", null, signal),
    readSeedHistory: (_v, signal) => request("history", null, signal), inspectSeed: (_v, key, signal) => request("inspect", key, signal),
    readSeedVersions: (_v, _j, signal) => request("versions", null, signal), mutateSeed: (_v, _j, op, reason, signal) => request(op, reason, signal),
  } }));
  app.render(); app.start(); app.requests.shift().resolve({ configured: true }); app.requests.shift().resolve([job]); await flush();
  app.button("Inspect seed job 1").props.onClick(); app.requests.shift().resolve(inspection); await flush();
  app.requests.shift().reject(new Error("history unavailable")); await flush(); app.tick();
  assert.equal(app.button("Approve exact seed preview").props.disabled, true);
  app.button("Inspect seed job 1").props.onClick(); app.requests.shift().resolve(inspection); await flush();
  app.requests.shift().resolve([job]); await flush(); app.tick();
  app.nodes("textarea")[0].props.onChange({ target: { value: "Reviewed exact synthetic bytes" } });
  app.nodes("input")[4].props.onChange({ target: { checked: true } });
  assert.equal(app.button("Approve exact seed preview").props.disabled, false);
  const old = app.button("Approve exact seed preview").props.onClick; app.focus(); old();
  assert.deepEqual(app.requests.map(r => r.kind), ["ready", "history"]);
  app.requests.shift().resolve({ configured: true }); app.requests.shift().resolve([job]); await flush();
  app.unmount(); assert.equal(app.requests.length, 0);
});
