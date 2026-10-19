import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const id = n => `${String(n).padStart(8, "0")}-1111-1111-1111-111111111111`;
const view = { account: { id: id(1), organization_id: "org", revision: 3, name: "Account" }, source: { id: id(3), kind: "hubspot" },
  evidence: [{ id: id(90) }], assessment: { snapshot_hash: "hash", policy_version: "policy", as_of: "2026-10-19", confidence: 100, requires_review: false } };
const field = value => ({ value, status: "valid", unit: "percent", evidence_id: id(90), observed_at: "2026-10-18T01:00:00Z" });
const record = { id: id(10), organization_id: "org", account_id: id(1), actor_id: "detector", detected_at: "2026-10-18T02:00:00Z",
  status: "changed", before: { kind: "hubspot" }, after: { kind: "hubspot", source_version_id: id(3), account_revision: 3 },
  event: { id: id(11), changes: [{ field: "usage_change", kind: "value_changed", before: field(-10), after: field(-20) }] } };
const plan = { id: id(20), organization_id: "org", account_id: id(1), revision: 2, status: "valid", validation: "valid", source: "deterministic",
  evidence: { account_id: id(1), account_revision: 3, snapshot_hash: "hash", assessment_policy_version: "policy", as_of: "2026-10-19", evidence_ids: [id(90)] },
  selected_alternative_id: id(21), alternatives: [{ id: id(21), rationale: "Review <script> evidence", risks: [],
    steps: [{ id: id(22), kind: "hubspot_task_create", dependencies: [], evidence_ids: [id(90)] }] }] };
const body = { schema_version: "1", event_id: id(11), expected_account_revision: 3, expected_source_id: id(3), plan_id: id(20),
  expected_revision: 2, template: "account-action-1", alternative_id: id(21) };
const selection = { id: id(30), organization_id: "org", actor_id: "original <actor>", created_at: "2026-10-18T03:00:00Z",
  policy_version: "source-mission-1", detection: record, request: body, mission_id: id(40) };
const mission = { id: id(40), organization_id: "org", account_id: id(1), plan_id: id(20), source_detection_id: id(10) };
const flush = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };
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
function environment(t) {
  const requests = [], events = [], listeners = new Map(), previous = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); },
    dispatchEvent(event) { events.push(event.type); [...(listeners.get(event.type) || [])].forEach(fn => fn()); } };
  t.after(() => { globalThis.window = previous; });
  const helper = load("../lib/source-missions.ts", { "./api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) } });
  function mount(role = "seller", initialView = view, detection = record) {
    let cursor = 0, effects = [], cleanups = []; const slots = [];
    const hooks = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
        return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useCallback(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn; },
      useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
        slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
    };
    const panel = load("../components/source-mission-panel.tsx", { react: hooks, "@/lib/source-missions": helper,
      "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role } }) } });
    const render = () => { cursor = 0; const tree = panel.SourceMissionPanel({ view: initialView, record: detection });
      const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
    return { render, button: text => walk(render(), n => n.type === "button" && n.props.children === text)[0],
      input: () => walk(render(), n => n.type === "input" && n.props.type !== "radio")[0],
      choose() { walk(render(), n => n.type === "input" && n.props.type === "radio")[0].props.onChange(); },
      form: () => walk(render(), n => n.type === "form")[0], unmount() { cleanups.forEach(fn => fn?.()); } };
  }
  async function context(missions = [], current = view) {
    const reads = requests.splice(0); assert.equal(reads.length, 2);
    for (const r of reads) { assert.ok(!r.init.method); r.resolve(r.url === "missions" ? missions : current); }
    await flush();
    if (missions.some(m => m.source_detection_id === record.id)) { const r = requests.shift(); assert.match(r.url, /\/mission$/); r.resolve(selection); await flush(); }
  }
  async function ready(app, missions = [], current = view) { app.render(); await flush(); await context(missions, current); }
  async function proposal(app, saved = plan) {
    app.input().props.onChange({ target: { value: saved.id } }); app.form().props.onSubmit({ preventDefault() {} });
    await flush(); const reads = requests.splice(0); assert.equal(reads.length, 3);
    reads.forEach(r => r.resolve(r.url === "missions" ? [] : r.url.startsWith("plans/") ? saved : view)); await flush();
  }
  return { requests, events, helper, mount, ready, context, proposal };
}

test("reads never create; explicit plan and alternative bind one exact unprepared-draft request", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app);
  assert.equal(env.requests.length, 0); assert.equal(app.button("Create draft from selected event and plan").props.disabled, true);
  await env.proposal(app); assert.equal(app.button("Create draft from selected event and plan").props.disabled, true);
  app.choose(); const click = app.button("Create draft from selected event and plan").props.onClick;
  const pending = click(); click(); assert.equal(env.requests.length, 1);
  const request = env.requests.shift(); assert.match(request.url, /detections\/.*\/mission$/); assert.deepEqual(JSON.parse(request.init.body), body);
  request.resolve({ status: "mission_created", selection }); await flush(); await env.context([mission]); await pending;
  const html = renderToStaticMarkup(app.render()); assert.match(html, /unprepared draft/i); assert.match(html, /original &lt;actor&gt;/);
  assert.match(html, /2026-10-18T03:00:00Z/); assert.match(html, new RegExp(id(40))); assert.doesNotMatch(html, /<script>/);
  assert.equal(app.input(), undefined); assert.deepEqual(env.events, ["vitaai-workflow-changed"]); app.unmount();
});

test("uncertain response reads saved selection without POST replay; failed refresh blocks further writes", async t => {
  for (const failRefresh of [false, true]) {
    const env = environment(t), app = env.mount(); await env.ready(app); await env.proposal(app); app.choose();
    const pending = app.button("Create draft from selected event and plan").props.onClick(); env.requests.shift().reject(new Error("lost")); await flush();
    if (failRefresh) { const reads = env.requests.splice(0); reads[0].reject(new Error("read failed")); reads[1].resolve([]); await flush(); }
    else await env.context([mission]);
    await pending; assert.match(renderToStaticMarkup(app.render()), /may have persisted/); assert.equal(env.requests.length, 0);
    if (failRefresh) { assert.equal(app.button("Create draft from selected event and plan").props.disabled, true);
      await app.button("Create draft from selected event and plan").props.onClick(); assert.equal(env.requests.length, 0); }
    app.unmount();
  }
});

test("viewer, stale/unsupported events and incompatible/used plans cannot select", async t => {
  const env = environment(t);
  for (const [role, detection] of [["viewer", record], ["seller", { ...record, status: "baseline", event: null }],
    ["seller", { ...record, after: { ...record.after, account_revision: 2 } }],
    ["seller", { ...record, event: { ...record.event, changes: [{ ...record.event.changes[0], kind: "availability_changed" }] } }]]) {
    const app = env.mount(role, view, detection); await env.ready(app);
    assert.equal(app.button("Create draft from selected event and plan").props.disabled, true);
    await app.button("Create draft from selected event and plan").props.onClick(); assert.equal(env.requests.length, 0); app.unmount();
  }
  for (const saved of [{ ...plan, account_id: id(2) }, { ...plan, organization_id: "foreign" },
    { ...plan, evidence: { ...plan.evidence, snapshot_hash: "old" } }]) {
    const app = env.mount(); await env.ready(app); await env.proposal(app, saved);
    assert.equal(app.button("Create draft from selected event and plan").props.disabled, true); app.unmount();
  }
  const app = env.mount(); await env.ready(app);
  app.input().props.onChange({ target: { value: plan.id } }); app.form().props.onSubmit({ preventDefault() {} }); await flush();
  env.requests.splice(0).forEach(r => r.resolve(r.url === "missions" ? [{ ...mission, source_detection_id: null }] : r.url.startsWith("plans/") ? plan : view)); await flush();
  assert.equal(app.button("Create draft from selected event and plan").props.disabled, true); app.unmount();
});

test("plan input changes discard late reads and clear explicit alternative choice", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app);
  app.input().props.onChange({ target: { value: plan.id } }); app.form().props.onSubmit({ preventDefault() {} }); await flush();
  const old = env.requests.splice(0); app.input().props.onChange({ target: { value: id(99) } });
  old.forEach(r => r.resolve(r.url === "missions" ? [] : r.url.startsWith("plans/") ? plan : view)); await flush();
  assert.equal(app.button("Create draft from selected event and plan").props.disabled, true);
  assert.equal(walk(app.render(), n => n.type === "input" && n.props.type === "radio").length, 0);
  await env.proposal(app); app.choose(); app.input().props.onChange({ target: { value: id(99) } });
  await app.button("Create draft from selected event and plan").props.onClick(); assert.equal(env.requests.length, 0); app.unmount();
});

test("pending guard survives unmount; obsolete responses cannot restore controls", async t => {
  const env = environment(t), app = env.mount(); await env.ready(app); await env.proposal(app); app.choose();
  const pending = app.button("Create draft from selected event and plan").props.onClick(), request = env.requests.shift(); app.unmount();
  const next = env.mount(); await env.ready(next); assert.equal(request.init.signal.aborted, true);
  assert.equal(next.button("Create draft from selected event and plan").props.disabled, true);
  request.resolve({ status: "mission_exists", selection }); await pending; await flush(); await env.context([mission]);
  assert.match(renderToStaticMarkup(next.render()), /Historical selection/); assert.equal(env.requests.length, 0); next.unmount();
});

test("historical selection remains readable after source changes and mismatched responses stay hidden", async t => {
  const env = environment(t), current = { ...view, account: { ...view.account, revision: 4 }, source: { id: id(4), kind: "local_sample" } };
  const app = env.mount("viewer", current); await env.ready(app, [mission], current);
  const html = renderToStaticMarkup(app.render()); assert.match(html, /Historical selection/); assert.match(html, /differs/i);
  assert.match(html, /No renewed approval/); assert.equal(app.input(), undefined); app.unmount();
  const pending = env.helper.readSourceSelection(view, record, { ...mission, id: id(77) }, new AbortController().signal);
  env.requests.shift().resolve(selection); await assert.rejects(pending, /unavailable/);
});
