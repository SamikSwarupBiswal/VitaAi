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
  assessment: { snapshot_hash: "current-snapshot" } };
const target = { company_name: "Example Company", domain: "example.test" };
const ready = { organization_id: "org", account_id: "a", account_revision: 3, target, enabled: true,
  can_start: true, live_status: "configured_unverified", pending_run_id: null, next_start_at: null };
const run = { id: "run-1", revision: 1, organization_id: "org", account_id: "a", account_revision: 3, target,
  requested_mode: "mock", mode: "mock", status: "succeeded", started_at: "2026-10-18T00:00:00Z",
  finished_at: "2026-10-18T00:00:01Z", expires_at: "2026-10-18T00:15:01Z", sources: [], caveat: "Untrusted advisory context" };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
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
function harness(role = "admin", transport) {
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
  const helper = transport?.helper ?? load("../lib/research.ts", { "./api": { api } });
  const panel = load("../components/research-panel.tsx", { react: hooks, "@/lib/research": helper,
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", role, organization_id: "org" } }) } });
  let key;
  const render = () => { cursor = 0; const outer = panel.ResearchPanel({ view }); key = outer.key;
    const tree = outer.type(outer.props); const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render(), n => n.type === "button" && n.props.children === text)[0];
  const inspect = () => walk(render(), n => n.type === "button" && Array.isArray(n.props.children) && n.props.children[0] === "Inspect ")[0];
  async function settle(status = ready, history = []) {
    requests.shift().resolve(status); requests.shift().resolve(history); await flush();
  }
  return { requests, helper, render, button, inspect, settle, events, key: () => key,
    checkbox: () => walk(render(), n => n.type === "input")[0], unmount() { cleanups.forEach(fn => fn?.()); },
    focus() { listeners.get("focus")?.(); }, tick() { timers.forEach(fn => fn()); } };
}
async function mount(app, status = ready, history = []) { app.render(); await flush(); await app.settle(status, history); }

test("mount/history/focus use only GET; mock defaults and double clicks send one exact mutation", async () => {
  const app = harness(); await mount(app);
  assert.equal(app.checkbox().props.checked, false);
  const action = app.button("Record mock research").props.onClick;
  const pending = action(); action();
  assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.match(request.url, /accounts\/a\/search$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_account_revision: 3, mode: "mock" });
  request.resolve(run); await flush();
  assert.ok(app.requests.every(r => !r.init.method));
  await app.settle({ ...ready, can_start: false, next_start_at: "2026-10-19T00:01:00Z" }, [run]); await pending;
  assert.equal(app.button("Record mock research").props.disabled, true);
  app.focus(); await flush(); assert.ok(app.requests.every(r => !r.init.method));
  await app.settle(ready, [run]);
  const inspect = app.inspect().props.onClick(); app.requests.shift().resolve(run); await inspect;
  assert.match(renderToStaticMarkup(app.render()), /No sources from this run/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("live requires opt-in and role; uncertain responses refresh records without another POST", async () => {
  const app = harness(); await mount(app);
  app.checkbox().props.onChange({ target: { checked: true } });
  const pending = app.button("Start live research").props.onClick();
  const request = app.requests.shift(); assert.equal(JSON.parse(request.init.body).mode, "live");
  request.reject(new Error("lost response")); await flush();
  assert.ok(app.requests.every(r => !r.init.method));
  await app.settle({ ...ready, pending_run_id: "pending", can_start: false }, [{ ...run, status: "pending" }]); await pending;
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /may have persisted/); assert.match(html, /Pending run pending/);
  assert.equal(app.checkbox().props.checked, false); app.unmount();
  const viewer = harness("viewer"); await mount(viewer);
  assert.equal(viewer.button("Record mock research").props.disabled, true);
  await viewer.button("Record mock research").props.onClick(); assert.equal(viewer.requests.length, 0); viewer.unmount();
});

test("failed or obsolete readiness blocks starts; unmount rejects late records and completion", async () => {
  const app = harness(); app.render(); await flush();
  await app.settle({ ...ready, account_revision: 2 }, []);
  assert.equal(app.button("Record mock research").props.disabled, true);
  assert.match(renderToStaticMarkup(app.render()), /Research records unavailable/); app.unmount();
  const changed = harness(); changed.render(); await flush(); const reads = changed.requests.splice(0);
  changed.unmount(); reads[0].resolve(ready); reads[1].resolve([{ ...run, target: { ...target, company_name: "Obsolete private text" } }]); await flush();
  assert.ok(reads.every(r => r.init.signal.aborted)); assert.doesNotMatch(renderToStaticMarkup(changed.render()), /Obsolete private text/);
  const writing = harness(); await mount(writing);
  const pending = writing.button("Record mock research").props.onClick(); const request = writing.requests.shift();
  writing.unmount(); request.resolve(run); await pending;
  assert.deepEqual(writing.events, ["vitaai-research-changed"]); assert.equal(writing.requests.length, 0);
});

test("latest explicit inspection wins and foreign run responses never display", async () => {
  const app = harness(); await mount(app, ready, [run]);
  const first = app.inspect().props.onClick(), old = app.requests.shift();
  const second = app.inspect().props.onClick(); app.requests.shift().resolve({ ...run, caveat: "Latest selection" }); await second;
  old.resolve({ ...run, caveat: "Obsolete selection" }); await first;
  assert.match(renderToStaticMarkup(app.render()), /Latest selection/); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Obsolete selection/);
  const foreign = app.inspect().props.onClick(); app.requests.shift().resolve({ ...run, account_id: "foreign", caveat: "Foreign private text" }); await foreign;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Foreign private text/); app.unmount();
});

test("history retains original dates/target and escapes text and unsafe links", async () => {
  const app = harness(); await mount(app, ready, [run]);
  const historical = { ...run, account_revision: 1, mode: "live", requested_mode: "live", sources: [
    { url: "https://example.test/news", title: "<script>title</script>", text: "<img src=x onerror=alert(1)>",
      published_at: null, fetched_at: "2026-10-18T00:00:01Z", freshness_at_fetch: "unknown", provider_relevance: 0.8, factual_confidence: "unverified" },
    { url: "javascript:alert(1)", title: "Unsafe link", text: "plain", published_at: null, factual_confidence: "unverified" },
  ] };
  const pending = app.inspect().props.onClick(); app.requests.shift().resolve(historical); await pending;
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /Historical revision or target/); assert.match(html, /Original account revision 1/);
  assert.match(html, /Published Unknown/); assert.match(html, /2026-10-18T00:15:01Z/);
  assert.match(html, /Provider relevance 0.8/); assert.match(html, /factual confidence unverified/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>|<img |href="javascript/);
  assert.match(html, /rel="noopener noreferrer"/);
  const current = { ...historical, account_revision: 3 };
  assert.match(app.helper.researchContext(current, ready, Date.parse(run.expires_at)), /expired/);
  assert.match(app.helper.researchContext(current, { ...ready, target: { ...target, domain: "other.test" } }, 0), /Historical revision or target/);
  assert.match(app.helper.researchContext(current, ready, Date.parse(run.finished_at)), /window open/);
  for (const url of ["http://example.test/", "https://example.test.evil.test/", "https://user@example.test/", "https://example.test/?x=1", "https://example.test/#x", "https://example.test:8443/", "https://example.test\\@evil.test/"]) {
    assert.equal(app.helper.researchSourceLink(url, "example.test"), false);
  }
  app.unmount();
});

function contextFixture(now = Date.now()) {
  const source = { url: "https://example.test/news", title: "<script>Public title</script>",
    text: "<img src=x onerror=alert(1)> Untrusted public text", provider_relevance: 0.8,
    published_at: new Date(now - 86400000).toISOString(), fetched_at: new Date(now - 1000).toISOString(),
    freshness_at_fetch: "fresh", factual_confidence: "unverified" };
  const saved = { ...run, mode: "live", requested_mode: "live", sources: [source],
    started_at: new Date(now - 2000).toISOString(), finished_at: source.fetched_at,
    expires_at: new Date(now + 60000).toISOString() };
  return { internal: { ...view, account: { ...view.account, annual_value: null, renewal_date: null },
    assessment: { ...view.assessment, as_of: new Date(now).toISOString().slice(0, 10), health: 50, risk: 50,
      opportunity: 20, confidence: 75, requires_review: true },
    evidence: [{ id: "evidence-1", fact: "Internal observation", source: "Synthetic CRM",
      observed_at: source.fetched_at, ingested_at: source.fetched_at }] },
    retained_run: saved, status: "usable", evaluated_at: new Date(now).toISOString(),
    usable_sources: [source], exclusions: [{ source_index: 1, url: "javascript:excluded", reason: "unsafe_url" }],
    factual_confidence: "unverified", caveat: "Untrusted supporting context; no score or authority changes.",
    review_question: { question: "Verify the cited sources before planning.", evidence_ids: ["evidence-1"], source_urls: [source.url] } };
}

test("declared publisher links retain unverified match labels and target changes invalidate context", async () => {
  const value = contextFixture();
  const publisher = { ...target, publisher_domains: ["publisher.test"] };
  const source = { ...value.usable_sources[0], url: "https://publisher.test/article",
    title: "Example Company update", match: "configured_publisher_company_mention" };
  value.retained_run = { ...value.retained_run, target: publisher, sources: [source] };
  value.usable_sources = [source];
  const app = harness(); const status = { ...ready, target: publisher };
  await mount(app, status, [value.retained_run]); await inspectSaved(app, value.retained_run);
  const pending = app.button("Inspect current research context").props.onClick(); app.requests.shift().resolve(value); await pending;
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /configured publisher and company mention/); assert.match(html, /href="https:\/\/publisher.test\/article"/);
  assert.match(html, /factual confidence unverified/);
  assert.equal(app.helper.researchSourceMatchedLink({ ...source, url: "https://publisher.test.evil.test/" }, publisher), false);
  assert.equal(app.helper.researchSourceMatchedLink({ ...source, match: "configured_domain" }, publisher), false);
  assert.equal(app.helper.researchSourceMatchedLink(source, target), false);
  assert.match(app.helper.researchContext(value.retained_run, ready, Date.now()), /Historical revision or target/);
  assert.equal(app.requests.length, 0); app.unmount();
});
async function inspectSaved(app, record) {
  const pending = app.inspect().props.onClick(); app.requests.shift().resolve(record); await pending;
}

test("explicit context GET pairs separate evidence, preserves unknowns and escapes public text for viewers", async () => {
  const app = harness("viewer"); const value = contextFixture(); await mount(app, ready, [value.retained_run]);
  await inspectSaved(app, value.retained_run); assert.equal(app.requests.length, 0);
  const action = app.button("Inspect current research context").props.onClick;
  const pending = action(); await action(); assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.match(request.url, /runs\/run-1\/context$/);
  assert.equal(request.init.method, undefined); request.resolve(value); await pending;
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /Internal account observations/); assert.match(html, /Annual value Unknown/);
  assert.match(html, /review Required/); assert.match(html, /current-snapshot/); assert.match(html, /evidence-1/);
  assert.match(html, /Server eligibility: usable/); assert.match(html, /Excluded sources/); assert.match(html, /unsafe_url/);
  assert.match(html, /&lt;script&gt;Public title/); assert.doesNotMatch(html, /<script>|<img |href="javascript/);
  assert.match(html, /Provider relevance 0.8/); assert.match(html, /factual confidence unverified/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("context loader rejects crossed account, snapshot, source or inspected-run bindings", async () => {
  const fixture = contextFixture();
  for (const change of [value => { value.retained_run.id = "other"; }, value => { value.retained_run.revision++; },
    value => { value.retained_run.organization_id = "other"; }, value => { value.internal.account.id = "other"; },
    value => { value.internal.account.organization_id = "other"; }, value => { value.internal.account.revision++; },
    value => { value.internal.assessment.snapshot_hash = "other"; }, value => { value.internal.source = { id: "other" }; }]) {
    const app = harness(); await mount(app, ready, [fixture.retained_run]); await inspectSaved(app, fixture.retained_run);
    const value = structuredClone(fixture); change(value);
    const pending = app.button("Inspect current research context").props.onClick(); app.requests.shift().resolve(value); await pending;
    const html = renderToStaticMarkup(app.render()); assert.match(html, /Research context unavailable/);
    assert.doesNotMatch(html, /Internal account observations/); app.unmount();
  }
});

test("refresh and new selection discard late context; captured old handlers cannot start a read", async () => {
  const app = harness(); const value = contextFixture(); await mount(app, ready, [value.retained_run]);
  await inspectSaved(app, value.retained_run);
  const stale = app.button("Inspect current research context").props.onClick;
  const pending = stale(); const request = app.requests.shift();
  app.focus(); await flush(); await stale(); assert.equal(app.requests.length, 2);
  await app.settle(ready, [value.retained_run]); request.resolve(value); await pending;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Internal account observations/);
  await inspectSaved(app, value.retained_run);
  const reading = app.button("Inspect current research context").props.onClick(); const old = app.requests.shift();
  await inspectSaved(app, { ...value.retained_run, caveat: "Latest retained run" });
  old.resolve(value); await reading;
  assert.match(renderToStaticMarkup(app.render()), /Latest retained run/);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Internal account observations/); app.unmount();
});

test("expiry hides usable public context without retrying or refreshing its dates", async t => {
  const instant = Date.now(); const value = contextFixture(instant);
  const clock = t.mock.method(Date, "now", () => instant);
  const app = harness(); await mount(app, ready, [value.retained_run]); await inspectSaved(app, value.retained_run);
  const pending = app.button("Inspect current research context").props.onClick(); app.requests.shift().resolve(value); await pending;
  assert.match(renderToStaticMarkup(app.render()), /Verify the cited sources before planning/);
  clock.mock.mockImplementation(() => instant + 60000); app.tick();
  const html = renderToStaticMarkup(app.render()); assert.match(html, /No currently usable public context/);
  assert.doesNotMatch(html, /Verify the cited sources before planning/); assert.equal(app.requests.length, 0);
  for (const status of ["expired", "account_changed", "target_changed", "disabled", "mock", "fallback", "run_unavailable", "invalid_window", "no_usable_sources"]) {
    assert.equal(app.helper.researchContextUsable({ ...value, status }, instant), false);
  }
  assert.equal(app.helper.researchContextUsable(value, null), false); app.unmount();
});

test("failed context GET stays explicit; unmounted requests cannot publish private context", async () => {
  const app = harness(); const value = contextFixture(); await mount(app, ready, [value.retained_run]); await inspectSaved(app, value.retained_run);
  const failed = app.button("Inspect current research context").props.onClick(); app.requests.shift().reject(new Error("offline")); await failed;
  assert.match(renderToStaticMarkup(app.render()), /Research context unavailable/); assert.equal(app.requests.length, 0);
  const pending = app.button("Inspect current research context").props.onClick(); const request = app.requests.shift();
  app.unmount(); assert.equal(request.init.signal.aborted, true); request.resolve(value); await pending;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Internal account observations/); assert.equal(app.requests.length, 0);
});

test("advisory brief is escaped and cited; expiry removes public verification questions", async t => {
  const instant = Date.now(); const clock = t.mock.method(Date, "now", () => instant);
  const value = contextFixture(instant);
  value.brief = { policy_version: "research-brief-1", basis: "supporting_context",
    internal_summary: "<script>Internal summary</script>", internal_evidence_ids: ["evidence-1"],
    caveats: ["Internal review remains required."], verification_questions: [{ question: "Check public relevance to saved support observations.",
      evidence_ids: ["evidence-1"], source_urls: ["https://example.test/news"] }] };
  const app = harness(); await mount(app, ready, [value.retained_run]); await inspectSaved(app, value.retained_run);
  const pending = app.button("Inspect current research context").props.onClick(); app.requests.shift().resolve(value); await pending;
  let html = renderToStaticMarkup(app.render()); assert.match(html, /Advisory research brief/);
  assert.match(html, /research-brief-1/); assert.match(html, /&lt;script&gt;Internal summary/);
  assert.match(html, /Check public relevance to saved support/); assert.match(html, /Internal review remains required/);
  assert.doesNotMatch(html, /<script>/);
  clock.mock.mockImplementation(() => instant + 60000); app.tick(); html = renderToStaticMarkup(app.render());
  assert.match(html, /Public context is no longer usable/); assert.doesNotMatch(html, /Check public relevance to saved support/);
  assert.equal(app.requests.length, 0); app.unmount();
});

test("briefs tolerate omitted optional verification questions", async () => {
  const value = contextFixture(); value.brief = { policy_version: "research-brief-1", basis: "supporting_context",
    internal_summary: "Retained internal summary", internal_evidence_ids: [], caveats: [] };
  const app = harness(); await mount(app, ready, [value.retained_run]); await inspectSaved(app, value.retained_run);
  const pending = app.button("Inspect current research context").props.onClick(); app.requests.shift().resolve(value); await pending;
  assert.match(renderToStaticMarkup(app.render()), /Retained internal summary/);
  assert.equal(app.requests.length, 0); app.unmount();
});

const pendingRun = { ...run, status: "pending", revision: 1, account_revision: 1,
  worker_deadline_at: "2026-10-18T00:02:00Z", finished_at: null, expires_at: null };
const recoveryReady = { organization_id: "org", account_id: "a", account_revision: 3,
  run_id: run.id, run_revision: 1, can_recover: true, reason: "eligible", recover_after: pendingRun.worker_deadline_at };
const interruptedRun = { ...pendingRun, status: "interrupted", revision: 2, error_code: "research_interrupted",
  finished_at: "2026-10-20T00:00:00Z", recovery: { actor_id: "recovering-actor", recovered_at: "2026-10-20T00:00:00Z",
    previous_revision: 1, reason: "worker_deadline_elapsed" } };
async function inspectPending(app, record = pendingRun, recovery = recoveryReady) {
  const action = app.button("Inspect pending research run").props.onClick();
  const request = app.requests.shift(); assert.match(request.url, /runs\/run-1$/); request.resolve(record); await flush();
  const check = app.requests.shift(); assert.match(check.url, /runs\/run-1\/recovery-readiness$/);
  assert.equal(check.init.method, undefined); check.resolve(recovery); await action;
}

test("explicit interrupted finalization binds inspected run and current account, preserves historical context", async () => {
  const app = harness(); await mount(app, { ...ready, pending_run_id: run.id, can_start: false }, []);
  // A pending ID outside the latest twenty remains explicitly inspectable.
  await inspectPending(app);
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /Original account revision 1/); assert.match(html, /provider cancellation/);
  const action = app.button("Finalize interrupted research").props.onClick;
  const first = action(); await action(); assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.match(request.url, /runs\/run-1\/recover$/);
  assert.deepEqual(JSON.parse(request.init.body), { schema_version: "1", expected_revision: 1, expected_account_revision: 3 });
  request.resolve(interruptedRun); await flush(); assert.ok(app.requests.every(r => !r.init.method));
  await app.settle(ready, [interruptedRun]); await first;
  const inspect = app.inspect().props.onClick(); app.requests.shift().resolve(interruptedRun); await inspect;
  const saved = renderToStaticMarkup(app.render());
  assert.match(saved, /recovering-actor/); assert.match(saved, /previous run revision 1/);
  assert.match(saved, /2026-10-18T00:00:00Z/); assert.match(saved, /No context window/);
  assert.match(saved, /No sources from this run/); assert.equal(app.requests.length, 0); app.unmount();
});

test("active, legacy and viewer recovery are read only and require fresh explicit inspection", async () => {
  for (const [role, reason] of [["admin", "worker_active"], ["admin", "legacy_worker"], ["viewer", "role_denied"]]) {
    const app = harness(role); await mount(app, { ...ready, can_start: false, pending_run_id: run.id }, []);
    const legacy = reason === "legacy_worker";
    await inspectPending(app, legacy ? { ...pendingRun, worker_deadline_at: null } : pendingRun,
      { ...recoveryReady, can_recover: false, reason, ...(legacy ? { recover_after: null } : {}) });
    assert.equal(app.button("Finalize interrupted research").props.disabled, true);
    await app.button("Finalize interrupted research").props.onClick(); assert.equal(app.requests.length, 0);
    if (legacy) assert.match(renderToStaticMarkup(app.render()), /operator investigation/);
    app.tick(); assert.equal(app.requests.length, 0); app.unmount();
  }
});

test("crossed recovery identity, revisions or deadline cannot enable finalization", async () => {
  for (const delta of [{ run_id: "foreign" }, { run_revision: 2 }, { account_id: "foreign" },
    { organization_id: "foreign" }, { account_revision: 2 }, { recover_after: null }]) {
    const app = harness(); await mount(app, { ...ready, can_start: false, pending_run_id: run.id }, []);
    await inspectPending(app, pendingRun, { ...recoveryReady, ...delta });
    assert.equal(app.button("Finalize interrupted research").props.disabled, true);
    await app.button("Finalize interrupted research").props.onClick(); assert.equal(app.requests.length, 0); app.unmount();
  }
});

test("focus invalidates inspected recovery synchronously and obsolete recovery reads stay discarded", async () => {
  const app = harness(); await mount(app, { ...ready, can_start: false, pending_run_id: run.id }, []);
  await inspectPending(app); const staleAction = app.button("Finalize interrupted research").props.onClick;
  app.focus(); await staleAction(); assert.equal(app.requests.length, 2);
  assert.ok(app.requests.every(r => !r.init.method)); await app.settle({ ...ready, can_start: false, pending_run_id: run.id }, []);
  const inspect = app.button("Inspect pending research run").props.onClick(); app.requests.shift().resolve(pendingRun); await flush();
  const obsolete = app.requests.shift(); app.focus(); await app.settle(ready, []);
  obsolete.resolve(recoveryReady); await inspect;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Recovery: eligible/); assert.equal(app.requests.length, 0); app.unmount();
});

test("uncertain finalization makes only saved reads and failed refresh blocks further action", async () => {
  const app = harness(); await mount(app, { ...ready, can_start: false, pending_run_id: run.id }, []); await inspectPending(app);
  const pending = app.button("Finalize interrupted research").props.onClick(); app.requests.shift().reject(new Error("lost response"));
  await flush(); assert.ok(app.requests.every(r => !r.init.method));
  app.requests.shift().reject(new Error("unavailable")); app.requests.shift().resolve([]); await pending;
  assert.match(renderToStaticMarkup(app.render()), /may have persisted/);
  assert.equal(app.button("Record mock research").props.disabled, true); assert.equal(app.requests.length, 0); app.unmount();
});

test("recovery transport lock survives remount and completion revalidates the new panel without retry", async () => {
  const old = harness(); await mount(old, { ...ready, can_start: false, pending_run_id: run.id }, []); await inspectPending(old);
  const pending = old.button("Finalize interrupted research").props.onClick(); const request = old.requests.shift(); old.unmount();
  const app = harness("admin", old); await mount(app);
  assert.equal(app.button("Record mock research").props.disabled, true);
  await app.button("Record mock research").props.onClick(); assert.equal(app.requests.length, 0);
  request.resolve(interruptedRun); await pending; await flush(); assert.equal(request.init.signal.aborted, true);
  assert.deepEqual(app.events, ["vitaai-research-changed"]); assert.ok(app.requests.every(r => !r.init.method));
  await app.settle(ready, [interruptedRun]); assert.equal(app.button("Record mock research").props.disabled, false); app.unmount();
});
