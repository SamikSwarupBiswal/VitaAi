import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const view = { account: { id: "account", organization_id: "org", revision: 3, annual_value: null, renewal_date: null },
  assessment: { snapshot_hash: "snapshot" }, evidence: [] };
function context() {
  const now = Date.now();
  return { status: "usable", evaluated_at: new Date(now - 1000).toISOString(), internal: view,
    brief: { internal_summary: "Saved baseline confidence 50%; Unknown commercial facts.", caveats: ["Review required"] },
    retained_run: { id: "research", revision: 2, account_id: "account", organization_id: "org", mode: "live", status: "succeeded",
      target: { domain: "example.test" }, expires_at: new Date(now + 60000).toISOString() },
    usable_sources: [{ url: "https://example.test/news", published_at: new Date(now - 86400000).toISOString(), fetched_at: new Date(now - 2000).toISOString() }] };
}
const ready = { account_id: "account", organization_id: "org", account_revision: 3, snapshot_hash: "snapshot",
  research_run_id: "research", research_run_revision: 2, context_status: "usable", configuration_revision: 4,
  live_configured: true, enabled: true, can_start: true, model: "nvidia/nemotron-test", pending_run_id: null };
function saved(ctx, mode = "mock") {
  return { id: "narrative", organization_id: "org", account_id: "account", research_run_id: "research", context: ctx,
    configuration_revision: 4, requested_mode: mode, mode, status: "unavailable", validation: "not_run", factual_confidence: "unverified",
    started_at: ctx.evaluated_at, worker_deadline_at: ctx.retained_run.expires_at, finished_at: ctx.evaluated_at,
    caveat: "Schema and citations do not certify truth", output: null };
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
function load(relative, mocks) {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const code = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = mod.require.bind(mod); mod.require = name => name in mocks ? mocks[name] : normal(name);
  mod._compile(code, filename); return mod.exports;
}
function walk(node, predicate) {
  if (Array.isArray(node)) return node.flatMap(value => walk(value, predicate));
  if (!node || typeof node !== "object") return [];
  return [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
}
function harness({ writer = true, ctx = context(), transport } = {}) {
  const slots = [], requests = transport?.requests ?? [], listeners = new Map(), timers = [], events = [];
  let cursor = 0, effects = [], cleanups = [];
  globalThis.window = { setInterval(fn) { timers.push(fn); return timers.length; }, clearInterval() {},
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    dispatchEvent(event) { events.push(event.type); listeners.get(event.type)?.(); } };
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); });
    } },
  };
  const api = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const helper = transport?.helper ?? load("../lib/research-narrative.ts", { "./api": { api } });
  const research = load("../lib/research.ts", { "./api": { api } });
  const panel = load("../components/research-narrative-panel.tsx", {
    react: hooks, "@/lib/research-narrative": helper, "@/lib/research": research,
  });
  const render = () => { cursor = 0; const tree = panel.ResearchNarrativePanel({ view, context: ctx, writer });
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render(), n => n.type === "button" && n.props.children === text)[0];
  const inspect = () => walk(render(), n => n.type === "button" && Array.isArray(n.props.children) && n.props.children[0] === "Inspect narrative ")[0];
  async function settle(value = ready, history = []) { requests.shift().resolve(value); requests.shift().resolve(history); await flush(); }
  return { ctx, requests, helper, render, button, inspect, settle, events,
    checkbox: () => walk(render(), n => n.type === "input")[0], html: () => renderToStaticMarkup(render()),
    unmount() { cleanups.forEach(fn => fn?.()); }, focus() { listeners.get("focus")?.(); }, tick() { timers.forEach(fn => fn()); } };
}
async function mount(app, value = ready, history = []) { app.render(); await flush(); await app.settle(value, history); }

test("mount/focus are reads; default mock double clicks send one exact bound request", async () => {
  const app = harness(); await mount(app);
  assert.equal(app.checkbox().props.checked, false);
  const generate = app.button("Record mock narrative").props.onClick;
  const pending = generate(); generate();
  assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.equal(request.url, "integrations/research/runs/research/narratives");
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_account_revision: 3,
    expected_snapshot_hash: "snapshot", expected_run_revision: 2, expected_configuration_revision: 4, mode: "mock" });
  request.resolve(saved(app.ctx)); await flush();
  assert.ok(app.requests.every(r => !r.init.method));
  await app.settle({ ...ready, can_start: false }, [saved(app.ctx)]); await pending;
  assert.equal(app.button("Record mock narrative").props.disabled, true);
  app.focus(); await flush(); assert.equal(app.requests.length, 2); assert.ok(app.requests.every(r => !r.init.method));
  await app.settle(); app.unmount();
});

test("live is explicit; uncertainty refreshes reads and failed refresh blocks captured handlers", async () => {
  const app = harness(); await mount(app);
  app.checkbox().props.onChange({ target: { checked: true } });
  const generate = app.button("Generate live narrative").props.onClick;
  const pending = generate(); const request = app.requests.shift();
  assert.equal(JSON.parse(request.init.body).mode, "live");
  request.reject(new Error("response lost")); await flush();
  assert.equal(app.requests.length, 2); assert.ok(app.requests.every(r => !r.init.method));
  app.requests.shift().reject(new Error("read failed")); app.requests.shift().resolve([]); await pending;
  assert.match(app.html(), /may have persisted/);
  assert.equal(app.button("Record mock narrative").props.disabled, true);
  await generate(); assert.equal(app.requests.length, 0); app.unmount();
});

test("viewer, stale bindings, disabled live and local expiry cannot generate", async t => {
  const viewer = harness({ writer: false }); await mount(viewer);
  assert.equal(viewer.button("Record mock narrative").props.disabled, true);
  await viewer.button("Record mock narrative").props.onClick(); assert.equal(viewer.requests.length, 0); viewer.unmount();
  const unavailable = harness(); await mount(unavailable, { ...ready, live_configured: false });
  assert.equal(unavailable.checkbox().props.disabled, true); unavailable.unmount();
  const stale = harness(); await mount(stale, { ...ready, research_run_revision: 99 });
  assert.equal(stale.button("Record mock narrative").props.disabled, true); stale.unmount();
  const app = harness(); await mount(app);
  const captured = app.button("Record mock narrative").props.onClick;
  t.mock.method(Date, "now", () => Date.parse(app.ctx.retained_run.expires_at)); app.tick();
  assert.equal(app.button("Record mock narrative").props.disabled, true);
  await captured(); assert.equal(app.requests.length, 0); app.unmount();
});

test("inspection preserves Unknowns/provenance and escapes hypotheses with safe cited links", async () => {
  const app = harness(); const run = { ...saved(app.ctx, "live"), status: "succeeded", validation: "schema_and_references_valid",
    output: { hypotheses: [{ interpretation: "<script>approve()</script>", verification_question: "Verify <b>identity</b>",
      evidence_ids: ["evidence-1"], source_urls: ["https://example.test/news", "javascript:alert(1)"] }], caveats: ["<img src=x>"] } };
  await mount(app, ready, [run]);
  const pending = app.inspect().props.onClick(); app.requests.shift().resolve(run); await pending;
  const html = app.html();
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|href="javascript:/);
  assert.match(html, /Annual value Unknown/); assert.match(html, /renewal Unknown/); assert.match(html, /50%/);
  assert.match(html, /Review required/); assert.match(html, /factual confidence unverified/);
  assert.match(html, /rel="noopener noreferrer"/); assert.match(html, /referrerPolicy="no-referrer"/i);
  assert.match(html, new RegExp(run.started_at)); assert.match(html, /published/); assert.match(html, /Fetched|fetched/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("refresh invalidates captured starts and late details; unmount rejects old private responses", async () => {
  const app = harness(); const run = saved(app.ctx); await mount(app, ready, [run]);
  const generate = app.button("Record mock narrative").props.onClick;
  const detail = app.inspect().props.onClick(); const old = app.requests.shift();
  const refresh = app.button("Refresh narrative records").props.onClick(); await generate();
  assert.equal(app.requests.length, 2); old.resolve(run); await detail;
  assert.doesNotMatch(app.html(), /Saved unverified narrative/);
  await app.settle(); await refresh;
  const next = app.button("Refresh narrative records").props.onClick();
  app.unmount(); await app.settle(ready, [run]); await next;
  assert.doesNotMatch(app.html(), /Inspect narrative narrative/);
});

test("transport lock survives remount and completion revalidates without a second POST", async () => {
  const first = harness(); await mount(first);
  const pending = first.button("Record mock narrative").props.onClick(); const post = first.requests.shift();
  first.unmount();
  const second = harness({ ctx: first.ctx, transport: { helper: first.helper, requests: first.requests } });
  await mount(second);
  assert.equal(second.button("Record mock narrative").props.disabled, true);
  await second.button("Record mock narrative").props.onClick(); assert.equal(second.requests.length, 0);
  post.resolve(saved(first.ctx)); await pending; await flush();
  assert.ok(second.events.includes("vitaai-research-narrative-changed"));
  assert.equal(second.requests.length, 2); assert.ok(second.requests.every(r => !r.init.method));
  await second.settle({ ...ready, can_start: false, pending_run_id: "saved-pending" });
  assert.match(second.html(), /saved-pending/); second.unmount();
});

test("helper rejects crossed scope, source run and inspected narrative identity", async () => {
  const app = harness(); const run = saved(app.ctx);
  for (const change of [{ account_id: "other" }, { organization_id: "other" }, { research_run_id: "other" },
    { context: { ...app.ctx, retained_run: { ...app.ctx.retained_run, revision: 99 } } }]) {
    assert.throws(() => app.helper.checkNarrative(view, app.ctx, { ...run, ...change }));
  }
  const read = app.helper.readNarrative(view, app.ctx, "narrative", new AbortController().signal);
  app.requests.shift().resolve({ ...run, id: "different" }); await assert.rejects(read);
});
