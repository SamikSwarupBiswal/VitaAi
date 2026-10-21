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
  return { id: "narrative", revision: 1, organization_id: "org", account_id: "account", research_run_id: "research", context: ctx,
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

function pendingRun(ctx) {
  return { ...saved(ctx), status: "pending", finished_at: null,
    worker_deadline_at: new Date(Date.now() - 1000).toISOString() };
}
function recoveryReady(run, change = {}) {
  return { organization_id: "org", account_id: "account", account_revision: 3, run_id: run.id,
    run_revision: run.revision, recover_after: run.worker_deadline_at, reason: "eligible", can_recover: true, ...change };
}
async function inspectPending(app, run, change = {}) {
  const reading = app.inspect().props.onClick(); app.requests.shift().resolve(run); await flush();
  assert.match(app.requests[0].url, /narratives\/narrative\/recovery-readiness$/);
  app.requests.shift().resolve(recoveryReady(run, change)); await reading;
}
function interrupted(run) {
  return { ...run, status: "interrupted", revision: run.revision + 1,
    recovery: { actor_id: "actor", previous_revision: run.revision, recovered_at: new Date().toISOString(), reason: "worker_deadline_elapsed" } };
}

test("explicit inspected recovery sends one revision-bound finalization and only reads after uncertainty", async () => {
  const app = harness(); const run = pendingRun(app.ctx); await mount(app, ready, [run]);
  await inspectPending(app, run);
  const finalize = app.button("Finalize interrupted narrative").props.onClick;
  const pending = finalize(); finalize();
  assert.equal(app.requests.length, 1); const post = app.requests.shift();
  assert.match(post.url, /narratives\/narrative\/recover$/);
  assert.deepEqual(JSON.parse(post.init.body), { schema_version: "1", expected_revision: 1, expected_account_revision: 3 });
  post.reject(new Error("response lost")); await flush();
  assert.equal(app.requests.length, 2); assert.ok(app.requests.every(r => !r.init.method));
  app.requests.shift().reject(new Error("read failed")); app.requests.shift().resolve([]); await pending;
  assert.match(app.html(), /may have persisted/); await finalize(); assert.equal(app.requests.length, 0); app.unmount();
});

test("recovery rejects stale readiness, active workers, viewer and captured handlers after refresh", async () => {
  for (const change of [{ run_revision: 99 }, { account_revision: 99 }, { recover_after: null }]) {
    const app = harness(); const run = pendingRun(app.ctx); await mount(app, ready, [run]);
    await inspectPending(app, run, change); assert.equal(app.button("Finalize interrupted narrative").props.disabled, true); app.unmount();
  }
  const viewer = harness({ writer: false }); const run = pendingRun(viewer.ctx); await mount(viewer, ready, [run]);
  await inspectPending(viewer, run, { can_recover: false, reason: "role_denied" });
  await viewer.button("Finalize interrupted narrative").props.onClick(); assert.equal(viewer.requests.length, 0); viewer.unmount();
  const app = harness(); const active = { ...pendingRun(app.ctx), worker_deadline_at: new Date(Date.now() + 60000).toISOString() };
  await mount(app, ready, [active]); await inspectPending(app, active);
  await app.button("Finalize interrupted narrative").props.onClick(); assert.equal(app.requests.length, 0);
  const refresh = app.button("Refresh narrative records").props.onClick(); await app.settle(ready, [run]); await refresh;
  await inspectPending(app, run); const captured = app.button("Finalize interrupted narrative").props.onClick;
  const reload = app.button("Refresh narrative records").props.onClick(); await captured();
  assert.equal(app.requests.length, 2); assert.ok(app.requests.every(r => !r.init.method)); await app.settle(); await reload; app.unmount();
});

test("recovery lock survives remount and completion only reads saved interrupted history", async () => {
  const first = harness(); const run = pendingRun(first.ctx); await mount(first, ready, [run]); await inspectPending(first, run);
  const pending = first.button("Finalize interrupted narrative").props.onClick(); const post = first.requests.shift(); first.unmount();
  const second = harness({ ctx: first.ctx, transport: { helper: first.helper, requests: first.requests } });
  await mount(second, { ...ready, can_start: false }, [run]); assert.equal(second.inspect().props.disabled, true);
  post.resolve(interrupted(run)); await pending; await flush();
  assert.equal(second.requests.length, 2); assert.ok(second.requests.every(r => !r.init.method));
  await second.settle(ready, [interrupted(run)]);
  const reading = second.inspect().props.onClick(); second.requests.shift().resolve(interrupted(run)); await reading;
  assert.match(second.html(), /Finalized by actor/); assert.match(second.html(), /previous revision 1/);
  assert.equal(second.requests.length, 0); second.unmount();
});

test("recovery helper rejects a wrong terminal identity or revision receipt", async () => {
  const app = harness(); const run = pendingRun(app.ctx), binding = recoveryReady(run);
  for (const change of [{ id: "other" }, { revision: 99 }, { recovery: { previous_revision: 99 } }, { status: "succeeded" }]) {
    const result = app.helper.recoverNarrative(view, app.ctx, run, binding, new AbortController().signal);
    app.requests.shift().resolve({ ...interrupted(run), ...change }); await assert.rejects(result);
  }
});

test("saved pending history remains visible when recovery readiness fails", async () => {
  const app = harness(); const run = pendingRun(app.ctx); await mount(app, ready, [run]);
  const inspection = app.inspect().props.onClick(); app.requests.shift().resolve(run); await flush();
  app.requests.shift().reject(new Error("readiness unavailable")); await inspection;
  assert.match(app.html(), /Saved unverified narrative/); assert.match(app.html(), /previous revision|worker deadline/);
  assert.match(app.html(), /recovery readiness unavailable/); assert.equal(app.button("Finalize interrupted narrative").props.disabled, true);
  await app.button("Finalize interrupted narrative").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
});

test("generation readiness failure preserves scoped history and explicit recovery without enabling generation", async () => {
  const app = harness(); const run = pendingRun(app.ctx); app.render(); await flush();
  app.requests.shift().reject(new Error("research disabled or remapped")); app.requests.shift().resolve([run]); await flush();
  assert.match(app.html(), /generation readiness unavailable/);
  assert.equal(app.button("Record mock narrative").props.disabled, true);
  await inspectPending(app, run);
  const pending = app.button("Finalize interrupted narrative").props.onClick(); const request = app.requests.shift();
  assert.match(request.url, /narratives\/narrative\/recover$/); request.resolve(interrupted(run)); await flush();
  await app.settle({ ...ready, can_start: false }, [interrupted(run)]); await pending;
  assert.equal(app.button("Record mock narrative").props.disabled, true); app.unmount();
});

test("account pending inspection finds an older research narrative outside selected history and finalizes its own binding", async () => {
  const app = harness();
  const older = { ...app.ctx, status: "expired", retained_run: { ...app.ctx.retained_run, id: "older-research", revision: 1,
    expires_at: new Date(Date.now() - 60000).toISOString() } };
  const run = { ...pendingRun(older), research_run_id: "older-research" };
  await mount(app, { ...ready, can_start: false, pending_run_id: run.id }, []);
  assert.equal(app.inspect(), undefined);
  const button = app.button("Inspect pending narrative");
  assert.ok(button, "Account-wide pending narrative must be inspectable outside selected-run history");
  const inspection = button.props.onClick();
  assert.equal(app.requests.length, 1); assert.match(app.requests[0].url, /narratives\/narrative$/);
  app.requests.shift().resolve(run); await flush();
  assert.match(app.requests[0].url, /narratives\/narrative\/recovery-readiness$/);
  app.requests.shift().resolve(recoveryReady(run)); await inspection;
  assert.match(app.html(), /research older-research/); assert.match(app.html(), /Historical or expired context/);
  assert.equal(app.button("Record mock narrative").props.disabled, true);
  const finalization = app.button("Finalize interrupted narrative").props.onClick();
  const post = app.requests.shift();
  assert.deepEqual(JSON.parse(post.init.body), { schema_version: "1", expected_revision: 1, expected_account_revision: 3 });
  post.resolve(interrupted(run)); await flush(); await app.settle(ready, []); await finalization;
  assert.match(app.html(), /finalized as interrupted/); assert.doesNotMatch(app.html(), /could not be confirmed/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("account pending inspection rejects crossed records and captured callbacks after refresh", async () => {
  const app = harness(); const run = pendingRun(app.ctx);
  await mount(app, { ...ready, can_start: false, pending_run_id: run.id });
  const captured = app.button("Inspect pending narrative").props.onClick;
  const refresh = app.button("Refresh narrative records").props.onClick();
  await captured(); assert.equal(app.requests.length, 2);
  await app.settle({ ...ready, can_start: false, pending_run_id: "new-pending" }); await refresh;
  await captured(); assert.equal(app.requests.length, 0);
  for (const change of [{ id: "different" }, { account_id: "foreign" }, { organization_id: "foreign" },
    { research_run_id: "different" }, { context: { ...app.ctx, retained_run: { ...app.ctx.retained_run, account_id: "foreign" } } },
    { context: { ...app.ctx, retained_run: { ...app.ctx.retained_run, organization_id: "foreign" } } }]) {
    const result = app.helper.readPendingNarrative(view, run.id, new AbortController().signal);
    app.requests.shift().resolve({ ...run, ...change }); await assert.rejects(result);
  }
  app.unmount();
});

test("late account-pending inspection cannot restore recovery after refresh or unmount", async () => {
  const app = harness(); const run = pendingRun(app.ctx);
  await mount(app, { ...ready, can_start: false, pending_run_id: run.id });
  const inspection = app.button("Inspect pending narrative").props.onClick(); const detail = app.requests.shift();
  const refresh = app.button("Refresh narrative records").props.onClick();
  detail.resolve(run); await inspection;
  assert.equal(app.requests.length, 2); assert.doesNotMatch(app.html(), /Saved unverified narrative/);
  await app.settle({ ...ready, can_start: false, pending_run_id: run.id }); await refresh;
  const next = app.button("Inspect pending narrative").props.onClick(); const late = app.requests.shift();
  app.unmount(); late.resolve(run); await next;
  assert.equal(app.requests.length, 0); assert.doesNotMatch(app.html(), /Saved unverified narrative/);
});
