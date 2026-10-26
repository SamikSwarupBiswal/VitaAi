import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript"), { renderToStaticMarkup } = require("react-dom/server");
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const view = { account: { id: "account", organization_id: "org", revision: 5, name: "Account A" }, source: { id: "source" },
  assessment: { snapshot_hash: "current", as_of: "2026-10-26" } };
const mission = { id: "mission", organization_id: "org", account_id: "account", revision: 8, content_revision: 2, owner_id: "owner",
  plan_id: "plan", plan_revision: 1, status: "completed", current_step: "Outcome", created_at: "2026-10-20T01:00:00Z",
  correlation_id: "mission-correlation", source_detection_id: "detection", transition_ids: ["audit-mission"],
  evidence: { account_id: "account", account_revision: 4, snapshot_hash: "old", as_of: "2026-10-20" } };
const report = { id: "report", organization_id: "org", mission_id: "mission", revision: 1, correlation_id: "report-correlation",
  observer_id: "observer", observed_at: "2026-10-21T01:00:00Z", report: { kind: "follow_up_required", basis: "manual_report",
    manual_action_reference: "manual:review", receipt_id: null, note: "<script>Original report</script>", evidence_ids: ["old-evidence"] } };
const correction = { ...report, id: "correction", revision: 2, supersedes_id: "report", observed_at: "2026-10-22T01:00:00Z" };
const action = { id: "action", organization_id: "org", mission_id: "mission", revision: 3, correlation_id: "action-correlation", mode: "simulation", payload: { kind: "hubspot_task_create" } };
const audit = (id, sequence, record, event_kind) => ({ id, sequence, organization_id: "org", entity_id: record.id,
  entity_revision: record.revision, correlation_id: record.correlation_id, actor_id: "historical reviewer", created_at: "2026-10-22T02:00:00Z",
  event_kind, previous_state: "draft", new_state: "completed", binding_hash: "historical-hash", action_id: null, decision_id: null, execution_id: null });
const data = () => ({ mission, account: view, plan: { id: "plan", organization_id: "org", account_id: "account", revision: 1 },
  actions: [action], outcomes: [report, correction], decisions: [], executions: [], receipts: [],
  audit: [audit("audit-mission", 3, mission, "completed"), audit("audit-action", 7, action, "approval_invalidated"),
    audit("audit-correction", 12, correction, "outcome_corrected")] });

function setup(t, session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } }) {
  const filename = fileURLToPath(new URL("../components/account-mission-history.tsx", import.meta.url));
  let cursor = 0, effects = [], selectedView = view, unmounted = false; const slots = [], cleanups = [], requests = [], activity = [], listeners = new Map();
  const previous = globalThis.window, surface = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  globalThis.window = surface;
  const unmount = () => { if (unmounted) return; unmounted = true; const current = globalThis.window; globalThis.window = surface;
    try { cleanups.forEach(fn => fn?.()); } finally { globalThis.window = current; } };
  t.after(() => { unmount(); globalThis.window = previous; });
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  const mocks = { react: hooks, "next/link": { __esModule: true, default: props => require("react").createElement("a", props) },
    "./session-gate": { useSession: () => session }, "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "@/lib/workflow": { readMission: (id, signal) => new Promise((resolve, reject) => activity.push({ id, signal, resolve, reject })) } };
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename);
  const outer = () => target.exports.AccountMissionHistory({ view: selectedView });
  const render = () => { cursor = 0; const node = outer(); const tree = typeof node?.type === "function" ? node.type(node.props) : node;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = label => walk(render()).find(node => node.type === "button" && node.props.children === label);
  return { requests, activity, render, outer, unmount, button, setView(value) { selectedView = value; },
    emit(name) { listeners.get(name)?.(); }, list() { return button("Inspect saved missions").props.onClick(); },
    inspect() { return button("Inspect saved activity").props.onClick(); } };
}
async function list(app, records = [mission], fresh = view) {
  const pending = app.list(); const request = app.requests.shift(); assert.equal(request.url, "missions"); assert.equal(request.init.method, undefined);
  request.resolve(records); await flush(); app.requests.shift().resolve(fresh); await pending;
}
async function activity(app, pending, value = data(), reviews = [], versions = [action], fresh = view, current = mission) {
  app.activity.shift().resolve(value); app.requests.shift().resolve(reviews); await flush();
  app.requests.splice(0).forEach(request => {
    assert.equal(request.init.method, undefined); assert.ok(request.init.signal);
    request.resolve(request.url.endsWith("/history") ? versions : request.url === "missions/mission" ? current : fresh);
  });
  await flush();
  app.requests.splice(0).forEach(request => request.resolve(request.url === "missions/mission" ? current : fresh)); await pending;
}

test("account mission activity preserves historical events, modes, audit gaps and corrected manual reports without writes", async t => {
  const app = setup(t); app.render(); assert.equal(app.requests.length, 0); assert.equal(app.activity.length, 0);
  await list(app, [mission, { ...mission, id: "other-account", account_id: "other" }]);
  let html = renderToStaticMarkup(app.render()); assert.doesNotMatch(html, /other-account/); assert.match(html, /historical evidence/);
  const pending = app.inspect(); await app.inspect(); assert.equal(app.activity.length, 1); assert.equal(app.activity[0].id, "mission");
  assert.match(app.requests[0].url, /missions\/mission\/coaching-reviews$/); assert.equal(app.requests[0].init.method, undefined);
  const saved = data(), before = JSON.stringify(saved); await activity(app, pending, saved);
  html = renderToStaticMarkup(app.render());
  for (const text of ["approval_invalidated", "outcome_corrected", "historical reviewer", "historical-hash", "manual report", "follow up required",
    "corrects report", "old-evidence", "simulation", "2026-10-21T01:00:00Z", "2026-10-22T01:00:00Z", "detection"]) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;Original report/); assert.doesNotMatch(html, /<script>/);
  assert.ok(html.indexOf("audit-mission") < html.indexOf("audit-action")); assert.equal(JSON.stringify(saved), before);
  const links = walk(app.render()).filter(node => node.props?.href).map(node => new URL(node.props.href, "http://localhost"));
  assert.ok(links.every(link => link.searchParams.get("account") === "account" && link.searchParams.get("mission") === "mission"));
  assert.match(html, /does not grant current approval/); assert.equal(app.requests.length, 0);
});

test("crossed or concurrently changed mission activity never publishes a prior account's private history", async t => {
  for (const corrupt of [
    x => { x.mission = { ...x.mission, account_id: "other" }; }, x => { x.mission = { ...x.mission, revision: 9 }; },
    x => { x.account = { ...view, source: { id: "other" } }; }, x => { x.actions[0].mission_id = "other"; },
    x => { x.audit[0].organization_id = "foreign"; }, x => { x.audit[0].entity_id = "foreign"; },
    x => { x.audit[0].correlation_id = "foreign"; }, x => { x.audit[1].sequence = 3; },
    x => { x.outcomes[1].supersedes_id = "missing"; }, x => { x.outcomes[0].mission_id = "other"; },
  ]) {
    const app = setup(t); await list(app); const value = structuredClone(data()); corrupt(value);
    const pending = app.inspect(); await activity(app, pending, value);
    const html = renderToStaticMarkup(app.render()); assert.match(html, /unavailable or changed/); assert.doesNotMatch(html, /historical reviewer|Original report/); app.unmount();
  }
});

test("valid earlier action correlations and correction transition IDs remain readable as historical records", async t => {
  for (const correctionTransition of [false, true]) {
    const app = setup(t); await list(app); const value = structuredClone(data());
    const old = { ...action, revision: 1, correlation_id: "original-action-correlation", binding_hash: "original-hash" };
    value.audit.unshift(audit("old-action-event", 1, old, "action_prepared"));
    if (correctionTransition) value.mission.transition_ids.push("audit-correction");
    const pending = app.inspect(); await activity(app, pending, value, [], [old, action]);
    const html = renderToStaticMarkup(app.render()); assert.doesNotMatch(html, /unavailable or changed/);
    assert.match(html, /old-action-event/); assert.match(html, /original-action-correlation/); app.unmount();
  }
});

test("missing or crossed action versions and final concurrent mission/account changes deny activity publication", async t => {
  for (const [versions, fresh, current] of [
    [[], view, mission], [[{ ...action, organization_id: "foreign" }], view, mission],
    [[{ ...action, mission_id: "other" }], view, mission], [[action, action], view, mission],
    [[action], { ...view, assessment: { ...view.assessment, snapshot_hash: "changed" } }, mission],
    [[action], view, { ...mission, revision: 9 }], [[action], view, { ...mission, owner_id: "other" }],
  ]) {
    const app = setup(t); await list(app); const pending = app.inspect(); await activity(app, pending, data(), [], versions, fresh, current);
    const html = renderToStaticMarkup(app.render()); assert.match(html, /unavailable or changed/); assert.doesNotMatch(html, /historical reviewer|Original report/); app.unmount();
  }
});

test("refresh events, selection keys, duplicate and captured/unmounted reads retain no stale activity", async t => {
  for (const session of [null, { mode: "sample", actor: null }, { mode: "session", actor: { organization_id: "foreign" } }]) {
    const app = setup(t, session); assert.match(renderToStaticMarkup(app.render()), /Session identity/); assert.equal(app.requests.length, 0);
  }
  const app = setup(t), key = app.outer().key; app.setView({ ...view, assessment: { ...view.assessment, snapshot_hash: "other" } });
  assert.notEqual(app.outer().key, key); app.setView(view); await list(app);
  const captured = app.button("Inspect saved activity").props.onClick; let pending = captured();
  app.emit("vitaai-workflow-changed"); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Inspect saved activity/);
  app.activity.shift().resolve(data()); app.requests.shift().resolve([]); await pending; assert.equal(app.requests.length, 0);
  await captured(); assert.equal(app.activity.length, 0);
  await list(app); pending = app.inspect(); const old = app.activity.shift(); app.unmount(); old.resolve(data()); app.requests.shift().resolve([]); await pending;
  assert.equal(old.signal.aborted, true); assert.equal(app.requests.length, 0); assert.doesNotMatch(renderToStaticMarkup(app.render()), /historical reviewer/);
});

test("empty account mission history and unavailable refresh do not imply completion", async t => {
  const app = setup(t); await list(app, []); assert.match(renderToStaticMarkup(app.render()), /No saved missions for this account/);
  await list(app); const pending = app.list(); app.requests.shift().reject(new Error("private failure")); await pending;
  const html = renderToStaticMarkup(app.render()); assert.match(html, /unavailable or changed/); assert.doesNotMatch(html, /Inspect saved activity|private failure/);
});
