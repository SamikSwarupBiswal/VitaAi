import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const view = { account: { id: "a", organization_id: "org", revision: 3, name: "Account A" } };
const target = { company_name: "Example Company", domain: "example.test" };
const ready = { organization_id: "org", account_id: "a", account_revision: 3, target, enabled: true,
  can_start: true, live_status: "configured_unverified", pending_run_id: null, next_start_at: null };
const run = { id: "run-1", organization_id: "org", account_id: "a", account_revision: 3, target,
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
function harness(role = "admin") {
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
  const helper = load("../lib/research.ts", { "./api": { api } });
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
