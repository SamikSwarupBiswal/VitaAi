import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const view = { account: { id: "a", organization_id: "org", revision: 3, name: "Account A" },
  assessment: { snapshot_hash: "a".repeat(64), as_of: "2026-10-18", health: 80, risk: 20, opportunity: 30, confidence: 100, caveats: [] }, evidence: [] };
const catalog = ["openai", "anthropic"].map(provider => ({ provider, configuration_revision: 7, enabled: true, live_configured: true,
  model: "requested-alias", expected_response_model: "canonical", status: "configured_unverified" }));
const ready = { organization_id: "org", account_id: "a", account_revision: 3, snapshot_hash: view.assessment.snapshot_hash,
  configured: true, can_start: true, pending_run_id: null, next_start_at: null };
const run = { id: "run-1", organization_id: "org", account_id: "a", actor_id: "actor", account_revision: 3,
  revision: 4,
  snapshot_hash: view.assessment.snapshot_hash, snapshot: view, policy_version: "comparison-1", status: "completed",
  started_at: "2026-10-18T00:00:00Z", finished_at: "2026-10-18T00:00:01Z", results: [
    { id: "result-1", provider: "openai", requested_mode: "mock", mode: "mock", configuration_revision: 7,
      model: "requested-alias", expected_response_model: "canonical", response_model: null, status: "unavailable",
      validation: "not_run", factual_confidence: "unverified", analysis: null },
  ] };
const recoveryReady = { organization_id: "org", account_id: "a", account_revision: 3,
  snapshot_hash: view.assessment.snapshot_hash, run_id: run.id, run_revision: run.revision,
  can_recover: true, reason: "eligible", recover_after: "2026-10-18T00:05:00Z" };
const interruptedRun = { ...run, status: "interrupted", revision: 5,
  recovery: { actor_id: "recovering-actor", recovered_at: "2026-10-18T00:06:00Z", previous_revision: 4, reason: "worker_deadline_elapsed" } };

async function inspectPending(app, eligibility = recoveryReady) {
  const pending = app.inspect().props.onClick();
  app.requests.shift().resolve({ ...run, status: "pending" }); await flush();
  const read = app.requests.shift(); assert.match(read.url, /recovery-readiness$/);
  assert.equal(read.init.method, undefined); read.resolve(eligibility); await pending;
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

test("interrupted finalization is explicit, revision bound and duplicate guarded; history retains attribution", async () => {
  const app = harness(); await mount(app, { ...ready, can_start: false, pending_run_id: run.id }, [{ ...run, status: "pending" }]);
  await inspectPending(app);
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /already-authorized dispatch may still begin or finish/);
  const action = app.button("Finalize interrupted comparison").props.onClick;
  assert.equal(app.button("Finalize interrupted comparison").props.disabled, false);
  const pending = action(); action();
  const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.match(request.url, /runs\/run-1\/recover$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_revision: 4,
    expected_account_revision: 3, expected_snapshot_hash: view.assessment.snapshot_hash });
  request.resolve(interruptedRun); await flush(); assert.ok(app.requests.every(item => !item.init.method));
  await app.settle(ready, [interruptedRun]); await pending;
  const inspection = app.inspect().props.onClick(); app.requests.shift().resolve(interruptedRun); await inspection;
  assert.match(renderToStaticMarkup(app.render()), /recovering-actor/);
  assert.match(renderToStaticMarkup(app.render()), /2026-10-18T00:06:00Z/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("recovery rejects crossed readiness and role, active-worker or legacy state cannot finalize", async () => {
  for (const change of [{ run_id: "other" }, { run_revision: 99 }, { account_id: "other" },
    { organization_id: "other" }, { account_revision: 99 }, { snapshot_hash: "other" }]) {
    const app = harness(); await mount(app, ready, [run]); await inspectPending(app, { ...recoveryReady, ...change });
    assert.equal(app.button("Finalize interrupted comparison").props.disabled, true);
    await app.button("Finalize interrupted comparison").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
  }
  for (const [role, reason] of [["viewer", "eligible"], ["admin", "worker_active"], ["seller", "legacy_worker"]]) {
    const app = harness(role); await mount(app, ready, [run]);
    await inspectPending(app, { ...recoveryReady, reason, can_recover: reason === "eligible" });
    assert.equal(app.button("Finalize interrupted comparison").props.disabled, true);
    await app.button("Finalize interrupted comparison").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
  }
});

test("uncertain recovery only refreshes; failed refresh keeps all mutations blocked", async () => {
  const app = harness(); await mount(app, ready, [run]); await inspectPending(app);
  const pending = app.button("Finalize interrupted comparison").props.onClick(); app.requests.shift().reject(new Error("lost"));
  await flush(); const reads = app.requests.splice(0); assert.ok(reads.every(item => !item.init.method));
  reads[0].reject(new Error("offline")); reads[1].resolve(catalog); reads[2].resolve([interruptedRun]); await pending;
  assert.match(renderToStaticMarkup(app.render()), /Recovery response could not be confirmed and may have persisted/);
  assert.equal(app.button("Compare selected providers").props.disabled, true);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("recovery lock survives navigation and aborted completion triggers reads only", async () => {
  const lock = new Set(), first = harness("admin", lock); await mount(first, ready, [run]); await inspectPending(first);
  const pending = first.button("Finalize interrupted comparison").props.onClick(), request = first.requests.shift(); first.unmount();
  assert.equal(request.init.signal.aborted, true);
  const next = harness("admin", lock); await mount(next, ready, [run]); await inspectPending(next);
  await next.button("Finalize interrupted comparison").props.onClick(); assert.equal(next.requests.length, 0);
  request.resolve(interruptedRun); await pending;
  assert.deepEqual(next.events, ["vitaai-comparison-changed"]); assert.equal(lock.size, 0);
  assert.ok(next.requests.every(item => !item.init.method)); await next.settle(ready, [interruptedRun]); next.unmount();
});

test("late recovery readiness cannot restore eligibility after refresh or another inspection", async () => {
  const app = harness(); await mount(app, ready, [run]);
  const pending = app.inspect().props.onClick(); app.requests.shift().resolve({ ...run, status: "pending" }); await flush();
  const obsolete = app.requests.shift();
  const current = app.inspect().props.onClick(); app.requests.shift().resolve(interruptedRun); await current;
  obsolete.resolve(recoveryReady); await pending;
  assert.match(renderToStaticMarkup(app.render()), /recovering-actor/);
  assert.equal(app.button("Finalize interrupted comparison"), undefined);
  assert.equal(app.requests.length, 0); app.unmount();
});
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
function harness(role = "admin", sharedPending = new Set(), available = catalog) {
  const slots = [], requests = [], listeners = new Map(), timers = [], events = [];
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
  const helper = load("../lib/comparison.ts", { "./api": { api } });
  helper.comparisonPending.clear();
  helper.comparisonPending.add = sharedPending.add.bind(sharedPending);
  helper.comparisonPending.has = sharedPending.has.bind(sharedPending);
  helper.comparisonPending.delete = sharedPending.delete.bind(sharedPending);
  const panel = load("../components/comparison-panel.tsx", { react: hooks, "@/lib/comparison": helper,
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", role, organization_id: "org" } }) } });
  let key;
  const render = () => { cursor = 0; const outer = panel.ComparisonPanel({ view }); key = outer.key;
    const tree = outer.type(outer.props); const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render(), n => n.type === "button" && [n.props.children].flat(Infinity).join("") === text)[0];
  const inspect = () => walk(render(), n => n.type === "button" && Array.isArray(n.props.children) && n.props.children[0] === "Inspect ")[0];
  async function settle(status = ready, history = []) {
    requests.shift().resolve(status); requests.shift().resolve(available); requests.shift().resolve(history); await flush();
  }
  return { requests, helper, render, button, inspect, settle, events, key: () => key,
    input: index => walk(render(), n => n.type === "input")[index], unmount() { cleanups.forEach(fn => fn?.()); },
    focus() { listeners.get("focus")?.(); }, tick() { timers.forEach(fn => fn()); } };
}
async function mount(app, status = ready, history = []) { app.render(); await flush(); await app.settle(status, history); }

test("BYOK is sent once only on explicit live compare and clears before uncertainty refresh", async () => {
  const available = [{ ...catalog[0], byok_allowed: true, live_configured: false }];
  const app = harness("seller", new Set(), available); await mount(app);
  const key = "synthetic-private-one-use-key";
  assert.equal(app.input(2).props.type, "password");
  assert.equal(app.input(2).props.autoComplete, "off");
  app.input(2).props.onChange({ target: { value: key } });
  app.input(0).props.onChange({ target: { checked: true } });
  app.input(1).props.onChange({ target: { checked: true } });
  const action = app.button("Compare selected providers").props.onClick;
  const pending = action(); action();
  const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  const body = JSON.parse(request.init.body);
  assert.equal(body.providers[0].api_key, key); assert.equal(body.providers[0].mode, "live");
  assert.equal(app.input(2).props.value, "");
  request.reject(new Error("uncertain")); await flush();
  assert.ok(app.requests.every(item => !item.init.method && !item.init.body));
  await app.settle({ ...ready, can_start: false, pending_run_id: run.id }, []); await pending;
  assert.equal(app.input(2).props.value, ""); assert.equal(app.requests.length, 0); app.unmount();
});

test("clearing a request key allows returning to mock when no server key exists", async () => {
  const available = [{ ...catalog[0], byok_allowed: true, live_configured: false }];
  for (const clear of ["button", "keyboard"]) {
    const app = harness("seller", new Set(), available); await mount(app);
    app.input(2).props.onChange({ target: { value: "synthetic-private-one-use-key" } });
    app.input(0).props.onChange({ target: { checked: true } });
    app.input(1).props.onChange({ target: { checked: true } });
    if (clear === "button") app.button("Clear openai key").props.onClick();
    else app.input(2).props.onChange({ target: { value: "" } });
    assert.equal(app.input(1).props.checked, true);
    assert.equal(app.input(1).props.disabled, false);
    app.input(1).props.onChange({ target: { checked: false } });
    const pending = app.button("Compare selected providers").props.onClick();
    const request = app.requests.shift();
    assert.deepEqual(JSON.parse(request.init.body).providers, [{ schema_version: "1", provider: "openai",
      mode: "mock", expected_configuration_revision: 7 }]);
    request.resolve(run); await flush(); await app.settle(); await pending; app.unmount();
  }
});

test("clear, focus and unmount prevent captured BYOK callbacks from reusing cleared keys", async () => {
  const available = [{ ...catalog[0], byok_allowed: true, live_configured: false }];
  for (const clear of ["button", "focus", "unmount"]) {
    const app = harness("seller", new Set(), available); await mount(app);
    app.input(2).props.onChange({ target: { value: "synthetic-private-one-use-key" } });
    app.input(0).props.onChange({ target: { checked: true } });
    app.input(1).props.onChange({ target: { checked: true } });
    const captured = app.button("Compare selected providers").props.onClick;
    if (clear === "button") app.button("Clear openai key").props.onClick();
    else if (clear === "focus") { app.focus(); await flush(); await app.settle(); }
    else app.unmount();
    await captured(); assert.equal(app.requests.length, 0);
    if (clear !== "unmount") { assert.equal(app.input(2).props.value, ""); app.unmount(); }
  }
});


test("reads never dispatch; deliberate mock choices bind exact snapshot and configuration once", async () => {
  const app = harness(); await mount(app);
  assert.equal(app.button("Compare selected providers").props.disabled, true);
  assert.equal(app.input(1).props.checked, false);
  app.input(0).props.onChange({ target: { checked: true } });
  const action = app.button("Compare selected providers").props.onClick;
  const pending = action(); action();
  const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.match(request.url, /accounts\/a\/compare$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_revision: 3,
    expected_snapshot_hash: view.assessment.snapshot_hash,
    providers: [{ schema_version: "1", provider: "openai", mode: "mock", expected_configuration_revision: 7 }] });
  request.resolve(run); await flush(); assert.ok(app.requests.every(r => !r.init.method));
  await app.settle({ ...ready, can_start: false }, [run]); await pending;
  assert.equal(app.input(0).props.checked, false); assert.equal(app.input(1).props.checked, false);
  app.focus(); await flush(); assert.ok(app.requests.every(r => !r.init.method)); await app.settle(ready, [run]);
  const inspection = app.inspect().props.onClick(); app.requests.shift().resolve(run); await inspection;
  assert.match(renderToStaticMarkup(app.render()), /No model analysis from this result/); app.unmount();
});

test("explicit live uses independent choices; lost responses only refresh and pending blocks starts", async () => {
  const app = harness(); await mount(app);
  app.input(0).props.onChange({ target: { checked: true } }); app.input(1).props.onChange({ target: { checked: true } });
  const pending = app.button("Compare selected providers").props.onClick();
  const request = app.requests.shift(); assert.equal(JSON.parse(request.init.body).providers[0].mode, "live");
  request.reject(new Error("lost")); await flush(); assert.ok(app.requests.every(r => !r.init.method));
  await app.settle({ ...ready, can_start: false, pending_run_id: "saved-pending" }, [{ ...run, status: "pending" }]); await pending;
  assert.match(renderToStaticMarkup(app.render()), /may have persisted/);
  assert.match(renderToStaticMarkup(app.render()), /Pending run saved-pending/);
  assert.equal(app.button("Compare selected providers").props.disabled, true); app.unmount();
});

test("discovery is a separate explicit admin action, mock by default and dated without inference", async () => {
  const app = harness(); await mount(app);
  const pending = app.button("Discover openai models").props.onClick(); const request = app.requests.shift();
  assert.match(request.url, /providers\/openai\/discover$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", mode: "mock", expected_configuration_revision: 7 });
  request.resolve({ provider: "openai", configuration_revision: 7, requested_mode: "mock", mode: "mock", source: "configuration",
    observed_at: "2026-10-18T00:00:00Z", models: ["requested-alias"], has_more: true }); await flush();
  await app.settle(); await pending;
  const html = renderToStaticMarkup(app.render()); assert.match(html, /Model discovery/); assert.match(html, /pagination was not followed/);
  assert.match(html, /observed 2026-10-18T00:00:00Z/); assert.equal(app.requests.length, 0); app.unmount();
  for (const role of ["viewer", "seller"]) {
    const reader = harness(role); await mount(reader);
    await reader.button("Discover openai models").props.onClick(); assert.equal(reader.requests.length, 0);
    if (role === "viewer") { reader.input(0).props.onChange({ target: { checked: true } });
      await reader.button("Compare selected providers").props.onClick(); assert.equal(reader.requests.length, 0); }
    reader.unmount();
  }
});

test("failed/crossed reads block requests and obsolete inspection cannot replace the selected run", async () => {
  const blocked = harness(); blocked.render(); await flush(); await blocked.settle({ ...ready, snapshot_hash: "wrong" });
  assert.equal(blocked.button("Compare selected providers").props.disabled, true); blocked.unmount();
  const app = harness(); await mount(app, ready, [run]);
  const first = app.inspect().props.onClick(), old = app.requests.shift();
  const second = app.inspect().props.onClick(); app.requests.shift().resolve({ ...run, actor_id: "Latest actor" }); await second;
  old.resolve({ ...run, actor_id: "Obsolete actor" }); await first;
  assert.match(renderToStaticMarkup(app.render()), /Latest actor/); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Obsolete actor/);
  const crossed = app.inspect().props.onClick(); app.requests.shift().resolve({ ...run, account_id: "foreign", actor_id: "Private" }); await crossed;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Private/); app.unmount();
});

test("transport lock survives remount; cancelled completions only emit a read revalidation event", async () => {
  const lock = new Set(), first = harness("admin", lock); await mount(first);
  first.input(0).props.onChange({ target: { checked: true } });
  const pending = first.button("Compare selected providers").props.onClick(), request = first.requests.shift(); first.unmount();
  const next = harness("admin", lock); await mount(next);
  next.input(0).props.onChange({ target: { checked: true } });
  await next.button("Compare selected providers").props.onClick(); assert.equal(next.requests.length, 0);
  request.resolve(run); await pending; assert.deepEqual(next.events, ["vitaai-comparison-changed"]);
  assert.equal(lock.size, 0); await next.settle(ready, [run]); next.unmount();
});

test("history preserves original baseline, modes, model bindings, dates and escaped advisory text", async () => {
  const app = harness(); await mount(app, ready, [run]);
  const historical = { ...run, account_revision: 1, snapshot: { ...view, account: { ...view.account, revision: 1 },
      assessment: { ...view.assessment, health: 12 } }, results: [{ ...run.results[0], mode: "live", requested_mode: "live",
      status: "succeeded", validation: "schema_and_references_valid", response_model: "canonical", request_id: "request-1",
      input_tokens: 0, output_tokens: 9, latency_ms: 0, analysis: { findings: [{ text: "<script>untrusted</script>", evidence_ids: ["e1"] }],
      next_steps: [{ text: "Proposed only", evidence_ids: ["e1"] }], caveats: ["Unverified interpretation"] } }] };
  const pending = app.inspect().props.onClick(); app.requests.shift().resolve(historical); await pending;
  const html = renderToStaticMarkup(app.render());
  for (const phrase of ["Historical snapshot", "health 12", "requested-alias", "canonical", "factual confidence unverified", "input tokens 0", "2026-10-18T00:00:00Z", "Unverified interpretation"]) assert.ok(html.includes(phrase), phrase);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  for (const changed of [{ account_id: "foreign" }, { organization_id: "foreign" }, { snapshot_hash: "wrong" },
    { snapshot: { ...view, account: { ...view.account, revision: 99 } } }]) {
    assert.throws(() => app.helper.checkComparisonRun(view, { ...run, ...changed }));
  }
  app.unmount();
});

test("failed uncertainty refresh cannot restore eligibility; cancelled initial reads never publish", async () => {
  const app = harness(); await mount(app);
  app.input(0).props.onChange({ target: { checked: true } });
  const pending = app.button("Compare selected providers").props.onClick(); app.requests.shift().reject(new Error("lost")); await flush();
  const reads = app.requests.splice(0); reads[0].reject(new Error("read failed")); reads[1].resolve(catalog); reads[2].resolve([run]); await pending;
  assert.equal(app.button("Compare selected providers").props.disabled, true);
  await app.button("Compare selected providers").props.onClick(); assert.equal(app.requests.length, 0);
  const retryRead = app.button("Refresh comparison records").props.onClick(); await app.settle(ready, [run]); await retryRead;
  assert.equal(app.button("Compare selected providers").props.disabled, true); // deliberate selection was cleared
  app.input(0).props.onChange({ target: { checked: true } });
  assert.equal(app.button("Compare selected providers").props.disabled, false); app.unmount();
  const cancelled = harness(); cancelled.render(); await flush(); const late = cancelled.requests.splice(0); cancelled.unmount();
  assert.ok(late.every(request => request.init.signal.aborted));
  late[0].resolve(ready); late[1].resolve(catalog); late[2].resolve([{ ...run, actor_id: "Private late text" }]); await flush();
  assert.doesNotMatch(renderToStaticMarkup(cancelled.render()), /Private late text/);
});

test("request-only discovery clears before dispatch, binds revision and never compares or retries", async () => {
  const app = harness("admin", new Set(), [{ ...catalog[0], byok_allowed: true, live_configured: false }]); await mount(app);
  app.input(2).props.onChange({ target: { value: "synthetic-discovery-key" } });
  app.input(1).props.onChange({ target: { checked: true } });
  const action = app.button("Discover openai models").props.onClick;
  const pending = action(); action();
  const request = app.requests.shift(); assert.equal(app.requests.length, 0);
  assert.equal(app.input(2).props.value, "");
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", mode: "live",
    expected_configuration_revision: 7, api_key: "synthetic-discovery-key" });
  request.resolve({ provider: "openai", configuration_revision: 7, requested_mode: "live", mode: "live",
    credential_source: "request", models: ["discovered-model"], observed_at: "2026-10-21T00:00:00Z" });
  await flush(); assert.ok(app.requests.every(item => !item.init.method)); await app.settle(); await pending;
  assert.match(renderToStaticMarkup(app.render()), /one-request user key \(not retained\)/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("cleared discovery keys and obsolete entry callbacks cannot send another request", async () => {
  for (const clear of ["button", "focus", "unmount"]) {
    const app = harness("admin", new Set(), [{ ...catalog[0], byok_allowed: true, live_configured: false }]); await mount(app);
    app.input(2).props.onChange({ target: { value: "synthetic-discovery-key" } });
    app.input(1).props.onChange({ target: { checked: true } });
    const action = app.button("Discover openai models").props.onClick;
    if (clear === "button") app.button("Clear openai key").props.onClick();
    else if (clear === "focus") { app.focus(); await flush(); await app.settle(); }
    else app.unmount();
    await action(); assert.equal(app.requests.length, 0); if (clear !== "unmount") app.unmount();
  }
});

test("pre-refresh discovery callback cannot use a newly entered key without renewed live selection", async () => {
  const app = harness("admin", new Set(), [{ ...catalog[0], byok_allowed: true, live_configured: false }]); await mount(app);
  app.input(2).props.onChange({ target: { value: "synthetic-old-discovery-key" } });
  app.input(1).props.onChange({ target: { checked: true } });
  const obsolete = app.button("Discover openai models").props.onClick;
  app.focus(); await flush(); await app.settle();
  assert.equal(app.input(1).props.checked, false);
  app.input(2).props.onChange({ target: { value: "synthetic-new-discovery-key" } });
  await obsolete(); assert.equal(app.requests.length, 0);
  const pending = app.button("Discover openai models").props.onClick(), request = app.requests.shift();
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", mode: "mock", expected_configuration_revision: 7 });
  request.resolve({ provider: "openai", requested_mode: "mock", configuration_revision: 7, credential_source: "server" });
  await flush(); await app.settle(); await pending; app.unmount();
});

test("live, key and choice edits invalidate captured discovery and comparison callbacks", async () => {
  for (const edit of ["live", "key", "choice"]) {
    const app = harness("admin", new Set(), [{ ...catalog[0], byok_allowed: true }]); await mount(app);
    app.input(2).props.onChange({ target: { value: "synthetic-first-discovery-key" } });
    app.input(0).props.onChange({ target: { checked: true } });
    app.input(1).props.onChange({ target: { checked: true } });
    const discover = app.button("Discover openai models").props.onClick;
    const compare = app.button("Compare selected providers").props.onClick;
    if (edit === "live") app.input(1).props.onChange({ target: { checked: false } });
    else if (edit === "key") app.input(2).props.onChange({ target: { value: "synthetic-replacement-key" } });
    else app.input(0).props.onChange({ target: { checked: false } });
    await discover(); await compare(); assert.equal(app.requests.length, 0); app.unmount();
  }
});

test("uncertain discovery only reads, and crossed credential provenance hides output", async () => {
  for (const result of [null, { provider: "openai", configuration_revision: 7, requested_mode: "live", mode: "live",
    credential_source: "server", models: ["crossed-private-model"] }]) {
    const app = harness("admin", new Set(), [{ ...catalog[0], byok_allowed: true }]); await mount(app);
    app.input(2).props.onChange({ target: { value: "synthetic-discovery-key" } });
    app.input(1).props.onChange({ target: { checked: true } });
    const pending = app.button("Discover openai models").props.onClick(), request = app.requests.shift();
    if (result) request.resolve(result); else request.reject(new Error("uncertain"));
    await flush(); assert.ok(app.requests.every(item => !item.init.method && !item.init.body));
    await app.settle(); await pending;
    assert.doesNotMatch(renderToStaticMarkup(app.render()), /crossed-private-model/);
    assert.equal(app.input(2).props.value, ""); assert.equal(app.requests.length, 0); app.unmount();
  }
});

test("crossed discovery configuration or requested mode is rejected without repeating POST", async () => {
  const app = harness(); await mount(app);
  const pending = app.button("Discover openai models").props.onClick();
  app.requests.shift().resolve({ provider: "openai", configuration_revision: 8, requested_mode: "live", mode: "live", models: ["Crossed private model"] });
  await flush(); assert.ok(app.requests.every(request => !request.init.method)); await app.settle(); await pending;
  assert.match(renderToStaticMarkup(app.render()), /could not be confirmed/);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Crossed private model/); app.unmount();
});

test("five-provider catalog keeps four-choice bound and explicit Foundry deployment semantics", async () => {
  const available = ["foundry", "openai", "anthropic", "nebius", "nvidia"].map(provider => ({ ...catalog[0], provider }));
  const app = harness("admin", new Set(), available); await mount(app);
  assert.match(renderToStaticMarkup(app.render()), /Foundry requests use the configured deployment name/);
  assert.match(renderToStaticMarkup(app.render()), /up to four providers/);
  for (const index of [0, 2, 4, 6]) app.input(index).props.onChange({ target: { checked: true } });
  assert.equal(app.input(8).props.disabled, true);
  app.input(8).props.onChange({ target: { checked: true } });
  assert.equal(app.input(8).props.checked, false);
  assert.equal(app.input(6).props.disabled, false); // selected entries can be removed
  const pending = app.button("Compare selected providers").props.onClick(), request = app.requests.shift();
  const choices = JSON.parse(request.init.body).providers;
  assert.deepEqual(choices.map(item => item.provider), ["foundry", "openai", "anthropic", "nebius"]);
  assert.ok(choices.every(item => item.mode === "mock"));
  request.reject(new Error("lost")); await flush(); await app.settle(); await pending;
  assert.equal(app.requests.length, 0); app.unmount();
});
