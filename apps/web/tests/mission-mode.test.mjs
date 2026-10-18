import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript"), react = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const walk = (node, predicate) => Array.isArray(node) ? node.flatMap(item => walk(item, predicate))
  : !node || typeof node !== "object" ? [] : [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
function load(relative, mocks, extra = "") {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    fileName: filename, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target); target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(compiled + extra, filename); return target.exports;
}
const destination = { connector_id: "hubspot-live", provider: "hubspot", configuration_revision: 1,
  tenant_id: "456", target_account_id: "account", target_resource_id: "123" };
const action = { id: "action", step_id: "task", mode: "live", revision: 4, status: "submitted", binding_hash: "exact-hash",
  payload_hash: "payload-hash", destination, mission_revision: 3, policy_version: "governance-1",
  payload: { kind: "hubspot_task_create", title: " Exact title ", body: "Line\n  body", due_at: "2026-10-21T00:00:00.123Z" },
  provider_request: '{"properties":{"hs_task_body":"Line\\n  body"}}' };
const decision = { id: "decision", action_id: "action", action_revision: 4, binding_hash: "exact-hash", decision: "approved",
  expires_at: "2099-01-01T00:00:00Z", reviewer_id: "reviewer" };
const item = { id: "task", kind: "hubspot_task_create", content: "Proposed body", dependencies: [] };
function data() {
  return { mission: { id: "mission", account_id: "account", revision: 8, status: "approved", current_step: "Execution",
    evidence: { account_revision: 1, snapshot_hash: "snapshot", evidence_ids: ["evidence"] } },
    plan: { selected_alternative_id: "choice", alternatives: [{ id: "choice", steps: [item] }] },
    account: { account: { id: "account", organization_id: "org", revision: 1, name: "Account" }, assessment: { snapshot_hash: "snapshot" } },
    actions: [action], decisions: [decision], executions: [], receipts: [], outcomes: [], audit: [],
    readiness: { account_id: "account", organization_id: "org", account_revision: 1, write_configured: true,
      readback_configured: true, can_prepare: true, can_reconcile: true, destination } };
}
function harness(role = "reviewer", step = "Execution") {
  let cursor = 0, effects = []; const cleanups = [], requests = [], refreshes = [], slots = [];
  const hooks = { ...react,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(callback, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, n) => v !== slots[i][n])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); });
    } },
  };
  const api = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const workflow = load("../lib/workflow.ts", { "./api": { api } });
  const components = load("../components/mission-workspace.tsx", { react: hooks, "@/lib/api": { api }, "@/lib/workflow": workflow,
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", role, organization_id: "org" } }) },
    "next/navigation": { useSearchParams: () => new URLSearchParams({ step }), useRouter: () => ({ replace() {} }) },
  }, "\nexports.panels=MissionPanels; exports.editor=ActionEditor; exports.loader=MissionLoader; exports.preview=ExactPreview;");
  function render(component, props) {
    cursor = 0; const tree = component(props), pending = effects; effects = []; pending.forEach(fn => fn()); return tree;
  }
  return { components, requests, refreshes, render,
    panels(value) { return render(components.panels, { data: value, configured: false, refresh: message => refreshes.push(message) }); },
    unmount() { cleanups.forEach(fn => fn?.()); } };
}
const button = (tree, label) => walk(tree, n => n.type === "button" && [n.props.children].flat().join("") === label)[0];

test("preparation defaults to simulation; explicit live task requires UTC due time", () => {
  const app = harness(); let saved;
  const props = { item, disabled: false, liveAvailable: true, save: async (...args) => { saved = args; } };
  const render = () => app.render(app.components.editor, props);
  let tree = render(); assert.equal(walk(tree, n => n.type === "select")[0].props.value, "simulation");
  walk(tree, n => n.type === "input" && n.props.maxLength === 255)[0].props.onChange({ target: { value: " Exact title " } });
  walk(tree, n => n.type === "select")[0].props.onChange({ target: { value: "live" } });
  tree = render(); walk(tree, n => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(saved, undefined); assert.match(renderToStaticMarkup(render()), /explicit UTC due time/);
  walk(tree, n => n.props?.type === "datetime-local")[0].props.onChange({ target: { value: "2026-10-21T02:03:04.123" } });
  tree = render(); walk(tree, n => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.equal(saved[1], "live"); assert.equal(saved[0].due_at, "2026-10-21T02:03:04.123Z");
  assert.equal(saved[0].title, " Exact title "); assert.equal(saved[0].body, item.content);
  const denied = harness(), blocked = denied.render(denied.components.editor, { ...props, liveAvailable: false });
  assert.equal(walk(blocked, n => n.type === "option" && n.props.value === "live")[0].props.disabled, true);
  const outlook = harness(), draft = outlook.render(outlook.components.editor, { ...props, item: { ...item, kind: "outlook_draft_create" } });
  assert.equal(walk(draft, n => n.type === "option" && n.props.value === "live").length, 0);
});

test("parent sends exact live preparation; lost response refreshes and duplicate clicks lock", async () => {
  const app = harness("seller", "Outreach"), value = data(); value.actions = []; value.decisions = []; value.mission.status = "draft";
  const editor = walk(app.panels(value), n => n.type === app.components.editor)[0];
  const pending = editor.props.save(action.payload, "live"); await flush();
  await editor.props.save(action.payload, "live"); assert.equal(app.requests.length, 1);
  assert.equal(app.requests[0].url, "missions/mission/prepare");
  assert.deepEqual(JSON.parse(app.requests[0].init.body), { expected_revision: 8, alternative_id: "choice", step_id: "task",
    mode: "live", connector_id: "hubspot-live", payload: action.payload });
  app.requests[0].reject(new Error("Connection lost")); await pending; assert.match(app.refreshes[0], /may have committed/);
  await editor.props.save(action.payload, "live"); assert.equal(app.requests.length, 1);
  const html = renderToStaticMarkup(app.components.preview({ action }));
  assert.match(html, /Exact provider request · live/); assert.match(html, /exact-hash/); assert.match(html, /456/); assert.match(html, /Line\\n  body/);
});

test("live execution gates roles, readiness, destination, expiry, mixed modes and prerequisite mode", () => {
  for (const [role, update, blocked] of [
    ["seller", () => {}, false], ["reviewer", () => {}, false], ["admin", () => {}, false], ["viewer", () => {}, true],
    ["seller", d => { d.readiness.can_prepare = false; }, true],
    ["seller", d => { d.readiness.destination = { ...destination, configuration_revision: 2 }; }, true],
    ["seller", d => { d.decisions = [{ ...decision, expires_at: "2000-01-01T00:00:00Z" }]; }, true],
    ["seller", d => { d.actions.push({ ...action, id: "other", mode: "simulation" }); }, true],
    ["seller", d => { d.plan.alternatives[0].steps = [{ ...item, dependencies: ["before"] }, { ...item, id: "before" }];
      d.actions.push({ ...action, id: "previous", step_id: "before" }); d.executions = [{ action_id: "previous", status: "succeeded" }];
      d.receipts = [{ action_id: "previous", mode: "simulation", result: "succeeded", verification: "verified" }]; }, true],
  ]) { const app = harness(role), value = data(); update(value);
    assert.equal(button(app.panels(value), "Execute live CRM task").props.disabled, blocked, role); }
});

test("execute uses saved approval; unknown allows reviewer GET reconciliation with writes disabled", async () => {
  const app = harness("seller"), pending = button(app.panels(data()), "Execute live CRM task").props.onClick(); await flush();
  assert.deepEqual(JSON.parse(app.requests[0].init.body), { expected_revision: 4, decision_id: "decision", idempotency_key: "mission-action:action" });
  app.requests[0].resolve({ status: "result_unknown" }); await pending; await flush(); assert.equal(app.refreshes.length, 1);
  for (const [role, permitted] of [["reviewer", true], ["admin", true], ["seller", false], ["viewer", false]]) {
    const probe = harness(role), value = data(); value.readiness.can_prepare = false; value.readiness.write_configured = false;
    value.mission.evidence.snapshot_hash = "old";
    value.executions = [{ id: "execution", action_id: "action", revision: 7, status: "result_unknown", attempt: 1 }];
    const tree = probe.panels(value), reconcile = button(tree, "Reconcile recorded execution");
    assert.equal(reconcile.props.disabled, !permitted);
    assert.equal(walk(tree, n => n.type === "button" && String(n.props.children).startsWith("Retry")).length, 0);
    if (permitted) { const result = reconcile.props.onClick(); await flush();
      assert.equal(probe.requests[0].url, "executions/execution/reconcile"); assert.deepEqual(JSON.parse(probe.requests[0].init.body), { expected_revision: 7 });
      probe.requests[0].resolve({ status: "result_unknown" }); await result; }
  }
});

test("readiness cannot cross account revisions; unmounted loader ignores late responses", async () => {
  const app = harness(), value = data(), props = { id: "mission", configured: false, refresh() {} };
  app.render(app.components.loader, props); app.requests.shift().resolve(value.mission); await flush();
  for (const request of app.requests.splice(0)) request.resolve(request.url.startsWith("plans/") ? value.plan
    : request.url.startsWith("accounts/") ? value.account : request.url.endsWith("execution-readiness") ? { ...value.readiness, account_revision: 2 } : []);
  await flush(); app.requests.shift().resolve(value.mission); await flush();
  assert.match(renderToStaticMarkup(app.render(app.components.loader, props)), /Account changed while loading/);
  const late = harness(); late.render(late.components.loader, props); const request = late.requests.shift();
  late.unmount(); assert.equal(request.init.signal.aborted, true); request.reject(new Error("old account failed")); await flush();
  assert.match(renderToStaticMarkup(late.render(late.components.loader, props)), /Loading mission/);
});

test("reviewers can cancel an undispatched claim after connector removal; unknown stays gated", () => {
  for (const [role, status, expected] of [["reviewer", "claimed", false], ["admin", "claimed", false],
    ["seller", "claimed", true], ["viewer", "claimed", true], ["reviewer", "result_unknown", true]]) {
    const app = harness(role), value = data();
    value.readiness = { ...value.readiness, can_prepare: false, can_reconcile: false, destination: null };
    value.executions = [{ id: "execution", action_id: "action", status, attempt: 1, revision: 2 }];
    assert.equal(button(app.panels(value), "Reconcile recorded execution").props.disabled, expected);
  }
});
