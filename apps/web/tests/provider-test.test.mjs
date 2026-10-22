import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8", otherId = "39d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
const entry = { schema_version: "1", provider: "openai", configuration_revision: 7, enabled: true, live_configured: true,
  byok_allowed: true, model: "alias", expected_response_model: "canonical", status: "configured_unverified", capabilities: [] };
const ready = { schema_version: "1", organization_id: "org", provider: "openai", configuration_revision: 7,
  model: "alias", expected_response_model: "canonical", can_start: true, live_configured: true, byok_allowed: true,
  pending_run_id: null, next_start_at: null };
const run = { schema_version: "1", id, organization_id: "org", actor_id: "actor", provider: "openai",
  policy_version: "synthetic-probe-1", revision: 2, configuration_revision: 7, model: "alias", expected_response_model: "canonical",
  response_model: null, credential_source: "server", requested_mode: "mock", mode: "mock", status: "unavailable", validation: "not_run",
  started_at: "2026-10-21T00:00:00Z", worker_deadline_at: "2026-10-21T00:02:00Z", finished_at: "2026-10-21T00:00:01Z",
  latency_ms: null, request_id: null, input_tokens: null, output_tokens: null, error_code: "mock_probe_not_run" };
const liveRun = { ...run, requested_mode: "live", mode: "live", status: "succeeded", validation: "synthetic_compatibility_valid",
  response_model: "canonical", request_id: "req-1", input_tokens: 12, output_tokens: 4, latency_ms: 123, error_code: null };
const pendingRun = { ...run, revision: 1, status: "pending", finished_at: null, error_code: null };
const recoveryReady = { schema_version: "1", organization_id: "org", provider: "openai", run_id: id, run_revision: 1,
  worker_deadline_at: pendingRun.worker_deadline_at, can_recover: true, reason: "eligible" };
const interruptedRun = { ...pendingRun, revision: 2, status: "interrupted", error_code: "probe_interrupted", finished_at: "2026-10-21T00:03:00Z",
  recovery: { schema_version: "1", actor_id: "actor", recovered_at: "2026-10-21T00:03:00Z", previous_revision: 1, reason: "worker_deadline_elapsed" } };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

async function inspectPending(app, readiness = recoveryReady) {
  const pending = (app.button("Inspect pending provider test") || app.button(`Inspect test ${id}`)).props.onClick();
  app.requests.shift().resolve(pendingRun); await flush();
  const read = app.requests.shift(); assert.match(read.url, /recovery-readiness$/); assert.equal(read.init.method, undefined);
  read.resolve(readiness); await pending;
}

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
  const surface = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); },
    dispatchEvent(event) { events.push(event.type); listeners.get(event.type)?.(); } };
  globalThis.window = surface;
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
  const helper = load("../lib/provider-tests.ts", { "./api": { api } });
  helper.providerTestPending.add = shared.add.bind(shared); helper.providerTestPending.has = shared.has.bind(shared);
  helper.providerTestPending.delete = shared.delete.bind(shared);
  const panel = load("../components/provider-test-panel.tsx", { react: hooks, "@/lib/provider-tests": helper });
  const render = () => { globalThis.window = surface; cursor = 0;
    const tree = panel.ProviderTestPanel({ organization: "org", actor: "actor", role });
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render(), n => n.type === "button" && [n.props.children].flat(Infinity).join("") === text)[0];
  return { requests, events, helper, render, button, field: () => walk(render(), n => n.type === "select")[0],
    input: type => walk(render(), n => n.type === "input" && n.props.type === type)[0],
    record: () => { const node = walk(render(), n => typeof n.type === "function")[0]; return node ? renderToStaticMarkup(node.type(node.props)) : ""; },
    unmount() { cleanups.forEach(fn => fn?.()); }, focus() { globalThis.window = surface; listeners.get("focus")?.(); },
    async reads(readiness = ready, history = [], entries = [entry]) {
      assert.equal(requests[0].url, "provider-comparison/catalog"); requests.shift().resolve(entries); await flush();
      if (requests[0]?.url.endsWith("test-readiness")) {
        requests.shift().resolve(readiness); requests.shift().resolve(history); await flush();
      }
    },
    async mount(readiness = ready, history = [], entries = [entry]) {
      render(); await flush(); await this.reads(readiness, history, entries);
      this.field().props.onChange({ target: { value: "openai" } }); await this.reads(readiness, history, entries);
    },
  };
}

test("explicit mock test sends no account/model/key and duplicate clicks make one POST", async () => {
  const app = harness(); await app.mount(); assert.equal(app.input("checkbox").props.checked, false);
  const action = app.button("Test selected provider").props.onClick, pending = action(); action();
  const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.match(request.url, /providers\/openai\/test$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", mode: "mock", expected_configuration_revision: 7 });
  request.resolve(run); await pending; await app.reads({ ...ready, can_start: false, next_start_at: "2099-10-21T00:01:00Z" }, [run]);
  assert.equal(app.button("Test selected provider").props.disabled, true); assert.equal(app.requests.length, 0); app.unmount();
});

test("live BYOK clears before submit; uncertainty refreshes saved records without retry or key echo", async () => {
  const app = harness(); await app.mount(); const secret = "synthetic-one-use-key";
  app.input("password").props.onChange({ target: { value: secret } });
  app.input("checkbox").props.onChange({ target: { checked: true } });
  const action = app.button("Test selected provider").props.onClick, pending = action(); action();
  const request = app.requests.shift(); assert.equal(JSON.parse(request.init.body).api_key, secret);
  assert.equal(app.input("password"), undefined); assert.equal(app.input("checkbox").props.checked, false);
  request.reject(new Error(secret)); await pending; assert.ok(app.requests.every(item => !item.init.method));
  await app.reads({ ...ready, can_start: false, pending_run_id: id }, [pendingRun]);
  assert.equal(app.input("password").props.value, "");
  assert.doesNotMatch(renderToStaticMarkup(app.render()), new RegExp(secret));
  assert.match(renderToStaticMarkup(app.render()), /may have persisted or billed/); assert.equal(app.requests.length, 0); app.unmount();
});

test("captured test handlers reject live/key/clear/focus/refresh/provider edits", async () => {
  for (const edit of ["live", "key", "clear", "focus", "refresh", "provider"]) {
    const app = harness(); await app.mount(); app.input("password").props.onChange({ target: { value: "synthetic-one-use-key" } });
    const captured = app.button("Test selected provider").props.onClick;
    if (edit === "live") app.input("checkbox").props.onChange({ target: { checked: true } });
    if (edit === "key") app.input("password").props.onChange({ target: { value: "different-one-use-key" } });
    if (edit === "clear") app.button("Clear provider test key").props.onClick();
    if (edit === "focus") app.focus();
    if (edit === "refresh") void app.button("Refresh provider test records").props.onClick();
    if (edit === "provider") app.field().props.onChange({ target: { value: "" } });
    await captured(); assert.ok(app.requests.every(item => !item.init.method));
    if (["focus", "refresh", "provider"].includes(edit)) await app.reads(); app.unmount();
  }
});

test("focus clears key/live before GET; obsolete catalog and details cannot restore display or eligibility", async () => {
  const app = harness(); await app.mount(ready, [run]);
  const inspection = app.button(`Inspect test ${id}`).props.onClick(), obsoleteDetail = app.requests.shift();
  app.input("password").props.onChange({ target: { value: "synthetic-one-use-key" } });
  app.input("checkbox").props.onChange({ target: { checked: true } }); app.focus();
  assert.equal(app.input("password"), undefined); assert.equal(app.input("checkbox").props.checked, false);
  const obsoleteCatalog = app.requests.shift(); app.focus(); await app.reads({ ...ready, can_start: false });
  obsoleteCatalog.resolve([entry]); obsoleteDetail.resolve(run); await inspection; await flush();
  assert.equal(app.button("Test selected provider").props.disabled, true);
  assert.equal(app.record(), ""); assert.equal(app.requests.length, 0); app.unmount();
});

test("role/default-off readiness/pending/cooldown block directly invoked handlers", async () => {
  for (const [role, readiness] of [["viewer", ready], ["seller", ready], ["reviewer", ready],
    ["admin", { ...ready, can_start: false }], ["admin", { ...ready, can_start: false, pending_run_id: id }],
    ["admin", { ...ready, next_start_at: "2099-10-21T00:01:00Z" }]]) {
    const app = harness(role); await app.mount(readiness); await app.button("Test selected provider").props.onClick();
    assert.equal(app.requests.length, 0); app.unmount();
  }
});

test("readiness failure preserves validated history for inspection while tests stay disabled", async () => {
  const app = harness(); await app.mount({ ...ready, organization_id: "other" }, [run]);
  assert.equal(app.button("Test selected provider").props.disabled, true);
  const inspect = app.button(`Inspect test ${id}`).props.onClick(); app.requests.shift().resolve(run); await inspect;
  assert.match(app.record(), /mock_probe_not_run/); assert.equal(app.requests.length, 0); app.unmount();
});

test("pending inspection works outside latest20 and preserves original deadline without POST", async () => {
  const app = harness(); await app.mount({ ...ready, can_start: false, pending_run_id: id });
  const inspection = app.button("Inspect pending provider test").props.onClick(), request = app.requests.shift();
  assert.match(request.url, new RegExp(`tests/${id}$`)); assert.equal(request.init.method, undefined);
  request.resolve(pendingRun); await flush(); app.requests.shift().resolve(recoveryReady); await inspection;
  assert.match(app.record(), /2026-10-21T00:02:00Z/); assert.match(app.record(), /Unresolved pending intent blocks duplicates/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("transport lock spans remounts; late aborted completion broadcasts saved-state reads", async () => {
  const shared = new Set(), first = harness("admin", shared); await first.mount();
  const pending = first.button("Test selected provider").props.onClick(), request = first.requests.shift(); first.unmount();
  assert.equal(request.init.signal.aborted, true);
  const next = harness("admin", shared); await next.mount(); await next.button("Test selected provider").props.onClick();
  assert.equal(next.requests.length, 0); request.resolve(run); await pending;
  assert.deepEqual(next.events, ["vitaai-provider-tests-changed"]); assert.equal(shared.size, 0);
  await next.reads({ ...ready, can_start: false, pending_run_id: id }, [pendingRun]); assert.equal(next.requests.length, 0); next.unmount();
});

test("crossed POST scope/config/model/mode/actor/credential response requires read-only uncertainty refresh", async () => {
  for (const change of [{ provider: "anthropic" }, { organization_id: "other" }, { configuration_revision: 8 },
    { model: "other" }, { expected_response_model: "other" }, { requested_mode: "live" }, { actor_id: "other" }, { credential_source: "request" }]) {
    const app = harness(); await app.mount(); const pending = app.button("Test selected provider").props.onClick();
    app.requests.shift().resolve({ ...run, ...change }); await pending;
    assert.match(renderToStaticMarkup(app.render()), /could not be confirmed/); assert.ok(app.requests.every(item => !item.init.method));
    await app.reads({ ...ready, can_start: false }, [run]); app.unmount();
  }
});

test("strict history rejects crossed/unsafe/malformed outcomes and detail identity substitution", async () => {
  const app = harness(), signal = new AbortController().signal;
  for (const change of [{ provider: "anthropic" }, { organization_id: "other" }, { api_key: "must-not-display" },
    { actor_id: {} }, { actor_id: [] }, { actor_id: 1 }, { actor_id: " " },
    { request_id: "<script>" }, { input_tokens: -1 }, { error_code: "raw provider body" }, { finished_at: "invalid" },
    { worker_deadline_at: "2020-01-01T00:00:00Z" }, { validation: "synthetic_compatibility_valid" }]) {
    assert.throws(() => app.helper.checkProbeRun("org", "openai", { ...run, ...change }));
  }
  assert.equal(app.helper.checkProbeRun("org", "openai", liveRun), liveRun);
  assert.throws(() => app.helper.checkProbeRun("org", "openai", { ...liveRun, response_model: "different" }));
  const pending = app.helper.readProbe("org", "openai", id, signal); app.requests.shift().resolve({ ...run, id: otherId }); await assert.rejects(pending);
  const history = app.helper.readTestHistory("org", "openai", signal); app.requests.shift().resolve([run, run]); await assert.rejects(history);
});

test("malformed actor history/detail is rejected before rendering and failed refresh keeps testing disabled", async () => {
  const app = harness(); await app.mount(ready, [{ ...run, actor_id: {} }]);
  assert.equal(app.button("Test selected provider").props.disabled, true); assert.equal(app.record(), "");
  await app.button("Test selected provider").props.onClick(); assert.equal(app.requests.length, 0);
  const signal = new AbortController().signal, detail = app.helper.readProbe("org", "openai", id, signal);
  app.requests.shift().resolve({ ...run, actor_id: {} }); await assert.rejects(detail);
  void app.button("Refresh provider test records").props.onClick();
  app.requests.shift().reject(new Error("offline")); await flush();
  assert.equal(app.button("Test selected provider").props.disabled, true); assert.equal(app.requests.length, 0); app.unmount();
});

test("successful test displays original measured metadata and historical configuration without renewed authority", async () => {
  const app = harness(); await app.mount(ready, [{ ...liveRun, configuration_revision: 6 }]);
  const inspection = app.button(`Inspect test ${id}`).props.onClick(); app.requests.shift().resolve({ ...liveRun, configuration_revision: 6 }); await inspection;
  for (const text of ["123", "req-1", "12", "4", "synthetic_compatibility_valid", "Historical configuration differs", "No account analysis"]) assert.ok(app.record().includes(text));
  assert.equal(app.requests.length, 0); app.unmount();
});

test("explicit finalization binds inspected provider/revision/deadline without start-readiness and duplicate clicks make one POST", async () => {
  const app = harness(); await app.mount({ ...ready, organization_id: "unavailable" }, [pendingRun]);
  await inspectPending(app);
  assert.equal(app.button("Test selected provider").props.disabled, true);
  assert.equal(app.button("Finalize interrupted provider test").props.disabled, false);
  const action = app.button("Finalize interrupted provider test").props.onClick, pending = action(); action();
  const request = app.requests.shift(); assert.match(request.url, new RegExp(`tests/${id}/recover$`));
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_provider: "openai", expected_revision: 1,
    expected_worker_deadline_at: pendingRun.worker_deadline_at });
  assert.equal(app.requests.length, 0); request.resolve(interruptedRun); await pending;
  await app.reads({ ...ready, can_start: false }, [interruptedRun]);
  const inspect = app.button(`Inspect test ${id}`).props.onClick(); app.requests.shift().resolve(interruptedRun); await inspect;
  assert.match(app.record(), /Finalized as interrupted by actor/); assert.match(app.record(), /previous revision 1/);
  assert.match(app.record(), /2026-10-21T00:03:00Z/); assert.equal(app.requests.length, 0); app.unmount();
});

test("crossed recovery readiness, non-admin, active worker and readiness failures preserve history without finalization", async () => {
  for (const change of [{ organization_id: "other" }, { provider: "anthropic" }, { run_id: otherId }, { run_revision: 2 },
    { worker_deadline_at: "2026-10-21T00:04:00Z" }, { can_recover: false, reason: "worker_active" }]) {
    const app = harness(); await app.mount({ ...ready, can_start: false, pending_run_id: id }); await inspectPending(app, { ...recoveryReady, ...change });
    assert.equal(app.button("Finalize interrupted provider test").props.disabled, true);
    await app.button("Finalize interrupted provider test").props.onClick(); assert.equal(app.requests.length, 0);
    assert.match(app.record(), /Unresolved pending intent/); app.unmount();
  }
  for (const role of ["seller", "reviewer", "viewer"]) {
    const app = harness(role); await app.mount({ ...ready, can_start: false, pending_run_id: id }); await inspectPending(app);
    await app.button("Finalize interrupted provider test").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
  }
  const app = harness(); await app.mount({ ...ready, can_start: false, pending_run_id: id });
  const pending = app.button("Inspect pending provider test").props.onClick(); app.requests.shift().resolve(pendingRun); await flush();
  app.requests.shift().reject(new Error("offline")); await pending;
  assert.match(app.record(), /Unresolved pending intent/); assert.equal(app.button("Finalize interrupted provider test").props.disabled, true); app.unmount();
});

test("captured finalization handlers cannot survive refresh, new inspection, provider/key/live changes", async () => {
  for (const edit of ["refresh", "inspect", "provider", "key", "live"]) {
    const app = harness(); await app.mount({ ...ready, can_start: false, pending_run_id: id }); await inspectPending(app);
    const captured = app.button("Finalize interrupted provider test").props.onClick;
    if (edit === "refresh") void app.button("Refresh provider test records").props.onClick();
    if (edit === "inspect") void app.button("Inspect pending provider test").props.onClick();
    if (edit === "provider") app.field().props.onChange({ target: { value: "" } });
    if (edit === "key") app.input("password").props.onChange({ target: { value: "synthetic-one-use-key" } });
    if (edit === "live") app.input("checkbox").props.onChange({ target: { checked: true } });
    await captured(); assert.ok(app.requests.every(item => !item.init.method)); app.unmount();
  }
});

test("obsolete recovery reads cannot restore finalization after focus or another record inspection", async () => {
  const app = harness(); await app.mount({ ...ready, can_start: false, pending_run_id: id });
  const pending = app.button("Inspect pending provider test").props.onClick(); app.requests.shift().resolve(pendingRun); await flush();
  const obsolete = app.requests.shift(); app.focus(); await app.reads({ ...ready, can_start: false });
  obsolete.resolve(recoveryReady); await pending;
  assert.equal(app.button("Finalize interrupted provider test"), undefined); assert.equal(app.record(), ""); app.unmount();
});

test("uncertain finalization only refreshes; failed refresh keeps new tests unavailable", async () => {
  const app = harness(); await app.mount({ ...ready, can_start: false, pending_run_id: id }); await inspectPending(app);
  const pending = app.button("Finalize interrupted provider test").props.onClick(); app.requests.shift().reject(new Error("lost")); await pending;
  assert.ok(app.requests.every(item => !item.init.method)); app.requests.shift().reject(new Error("offline")); await flush();
  assert.match(renderToStaticMarkup(app.render()), /Finalization response could not be confirmed/);
  assert.equal(app.button("Test selected provider").props.disabled, true); assert.equal(app.requests.length, 0); app.unmount();
});

test("finalization transport lock spans remount and late completion only refreshes retained history", async () => {
  const shared = new Set(), first = harness("admin", shared); await first.mount({ ...ready, can_start: false, pending_run_id: id }); await inspectPending(first);
  const pending = first.button("Finalize interrupted provider test").props.onClick(), request = first.requests.shift(); first.unmount();
  const next = harness("admin", shared); await next.mount({ ...ready, can_start: false, pending_run_id: id }); await inspectPending(next);
  await next.button("Finalize interrupted provider test").props.onClick(); assert.equal(next.requests.length, 0);
  assert.equal(request.init.signal.aborted, true); request.resolve(interruptedRun); await pending;
  assert.equal(shared.size, 0); await next.reads({ ...ready, can_start: false }, [interruptedRun]); assert.equal(next.requests.length, 0); next.unmount();
});

test("finalization rejects altered original provenance and malformed recovery attribution", async () => {
  const app = harness(), signal = new AbortController().signal;
  for (const change of [{ model: "changed" }, { started_at: "2026-10-20T00:00:00Z" }, { actor_id: "other" }, { credential_source: "request", requested_mode: "live" }]) {
    const pending = app.helper.recoverProbe("org", "actor", pendingRun, recoveryReady, signal);
    app.requests.shift().resolve({ ...interruptedRun, ...change }); await assert.rejects(pending);
  }
  for (const change of [{ actor_id: {} }, { previous_revision: 99 }, { recovered_at: "2026-10-21T00:00:00Z" }, { reason: "retry" }, { api_key: "unsafe" }]) {
    assert.throws(() => app.helper.checkProbeRun("org", "openai", { ...interruptedRun, recovery: { ...interruptedRun.recovery, ...change } }));
  }
  assert.equal(app.requests.length, 0);
});
