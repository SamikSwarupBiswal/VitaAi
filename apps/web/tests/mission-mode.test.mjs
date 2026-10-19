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
  }, "\nexports.panels=MissionPanels; exports.editor=ActionEditor; exports.loader=MissionLoader; exports.preview=ExactPreview; exports.connection=MicrosoftConnection; exports.directory=MissionDirectory; exports.newMission=NewMission;");
  function render(component, props) {
    cursor = 0; const tree = component(props), pending = effects; effects = []; pending.forEach(fn => fn()); return tree;
  }
  return { components, requests, refreshes, render,
    panels(value) { return render(components.panels, { data: value, configured: false, refresh: message => refreshes.push(message) }); },
    unmount() { cleanups.forEach(fn => fn?.()); } };
}
const button = (tree, label) => walk(tree, n => n.type === "button" && [n.props.children].flat().join("") === label)[0];

function microsoftData() {
  const value = data(), payload = { kind: "outlook_draft_create", to: ["one@example.com", "two@example.com"], subject: " Exact Ω ", body_text: "Body\n Ω " };
  value.actions = [{ ...action, payload, destination: { ...destination, connector_id: "microsoft-live", provider: "microsoft",
    delegated_user_id: "maker", mailbox_id: "maker", target_resource_id: "original-binding" }, provider_request: JSON.stringify(payload) }];
  value.plan.alternatives[0].steps = [{ ...item, kind: payload.kind }];
  value.microsoft = { mission_id: "mission", mission_revision: 8, account_id: "account", account_revision: 1,
    organization_id: "org", can_prepare: false, destination: null,
    actions: [{ action_id: "action", action_revision: 4, binding_hash: "exact-hash", can_write: true, can_reconcile: true }] };
  return value;
}

test("explicit planning exposes saved ID for event selection without starting a mission", async () => {
  const app = harness("seller"), account = data().account;
  const props = { account, configured: false, onCreated() { assert.fail("Planning must not start a mission"); } };
  const render = () => app.render(app.components.newMission, props);
  walk(render(), n => n.type === "form")[0].props.onSubmit({ preventDefault() {} }); await flush();
  assert.equal(app.requests.length, 1); assert.equal(app.requests[0].url, "plans");
  app.requests.shift().resolve({ id: "saved-plan", revision: 3, source: "deterministic", validation: "valid", caveats: [],
    selected_alternative_id: "choice", alternatives: [{ id: "choice", rationale: "Review", risks: [], steps: [item] }] }); await flush();
  assert.match(renderToStaticMarkup(render()), /Saved plan ID: saved-plan/);
  assert.equal(app.requests.length, 0); app.unmount();
});

function sourcedData() {
  const value = microsoftData(); value.actions = []; value.microsoft.actions = [];
  value.account.evidence = [];
  value.plan.caveats = []; value.plan.alternatives[0].risks = [];
  value.plan.alternatives[0].steps[0].evidence_ids = ["evidence"];
  Object.assign(value.mission, { organization_id: "org", plan_id: "plan", plan_revision: 2,
    template: "account-action-1", alternative_id: "choice", source_detection_id: "detection" });
  value.account.source = { id: "new-source" };
  const snapshot = n => ({ kind: "hubspot", source_version_id: `source-${n}`, account_revision: n,
    selected_at: "2026-10-17T01:00:00Z", observation_id: `observation-${n}`, portal_id: "12", company_id: "34", mapping_hash: "c".repeat(64),
    provider_created_at: "2026-10-01T00:00:00Z", provider_updated_at: "2026-10-16T00:00:00Z", fetched_at: "2026-10-16T01:00:00Z" });
  const field = n => ({ value: n, status: "valid", unit: "percent", observed_at: "2026-10-15T00:00:00Z", evidence_id: `evidence-${n}` });
  value.sourceSelection = { id: "selection", organization_id: "org", actor_id: "original <actor>", created_at: "2026-10-18T03:00:00Z",
    policy_version: "source-mission-1", mission_id: "mission", request: { event_id: "event", expected_account_revision: 3,
      expected_source_id: "source-3", plan_id: "plan", expected_revision: 2, template: "account-action-1", alternative_id: "choice" },
    detection: { id: "detection", account_id: "account", organization_id: "org", actor_id: "detector", detected_at: "2026-10-18T02:00:00Z",
      before: snapshot(2), after: snapshot(3), event: { id: "event", fingerprint: "a".repeat(64),
        changes: [{ field: "usage_change", kind: "value_changed", before: field(-10), after: field(-20) }] } } };
  return value;
}

async function loadSavedMission(app, value, reply = value.sourceSelection) {
  const props = { id: "mission", configured: false, refresh() {} }, urls = [];
  app.render(app.components.loader, props); app.requests.shift().resolve(value.mission); await flush();
  for (const request of app.requests.splice(0)) {
    assert.ok(!request.init.method); urls.push(request.url);
    if (request.url.endsWith("/mission") && reply instanceof Error) { request.reject(reply); continue; }
    request.resolve(request.url.startsWith("plans/") ? value.plan : request.url.startsWith("accounts/") ? value.account
      : request.url.endsWith("/mission") ? reply : request.url.includes("microsoft/") ? value.microsoft
        : request.url.endsWith("execution-readiness") ? value.readiness : []);
  }
  await flush(); const latest = app.requests.shift(); if (latest) latest.resolve(value.mission); await flush();
  return { tree: app.render(app.components.loader, props), urls };
}

test("mission reload reads original selection only for sourced missions and rejects crossed provenance", async () => {
  const app = harness(), value = sourcedData();
  const { tree, urls } = await loadSavedMission(app, value);
  assert.ok(urls.includes("integrations/hubspot/detections/detection/mission"));
  assert.deepEqual(tree.props.data.sourceSelection, value.sourceSelection); assert.equal(app.requests.length, 0); app.unmount();
  for (const alter of [s => { s.mission_id = "other"; }, s => { s.detection.account_id = "other"; },
    s => { s.organization_id = "foreign"; }, s => { s.request.expected_revision = 9; },
    s => { s.request.alternative_id = "other"; }, s => { s.request.expected_source_id = "other"; }]) {
    const app = harness(), value = sourcedData(), invalid = structuredClone(value.sourceSelection); alter(invalid);
    const { tree } = await loadSavedMission(app, value, invalid);
    assert.match(renderToStaticMarkup(tree), /Source provenance changed/); app.unmount();
  }
  const legacy = harness(), old = sourcedData(); old.mission.source_detection_id = null;
  const loaded = await loadSavedMission(legacy, old); assert.ok(!loaded.urls.some(url => url.endsWith("/mission")));
  assert.equal(loaded.tree.props.data.sourceSelection, undefined); legacy.unmount();
});

test("all mission steps retain read-only dated provenance and disclose current-source mismatch", () => {
  for (const step of ["Review", "Evidence", "Outreach", "CRM Note", "Approval", "Execution", "Outcome"]) {
    const app = harness("viewer", step), value = sourcedData(), tree = app.panels(value);
    const provenance = walk(tree, n => typeof n.type === "function" && n.type.name === "MissionSourceProvenance")[0];
    assert.ok(provenance); const html = renderToStaticMarkup(provenance);
    for (const text of ["Historical source selection", "differs", "No renewed approval", "original &lt;actor&gt;", "event", "a".repeat(64), "c".repeat(64), "source-2", "source-3",
      "observation-2", "observation-3", "2026-10-15T00:00:00Z", "2026-10-16T01:00:00Z", "2026-10-18T03:00:00Z", "percent", "-20"]) assert.ok(html.includes(text), text);
    assert.equal(walk(provenance.type(provenance.props), n => n.type === "button" || n.type === "form").length, 0); app.unmount();
  }
});

test("unavailable optional provenance preserves mission reads and safe claimed cancellation", async () => {
  const app = harness("reviewer"), value = sourcedData();
  value.readiness = { account_id: "account", organization_id: "org", account_revision: 1,
    write_configured: false, readback_configured: false, can_prepare: false, can_reconcile: false, destination: null };
  const { tree } = await loadSavedMission(app, value, new Error("Request failed (404)."));
  assert.ok(tree.props.data, "Otherwise authorized mission records must remain readable");
  assert.equal(tree.props.data.sourceSelection, undefined);
  const data = tree.props.data;
  data.actions = [action]; data.executions = [{ id: "claim", action_id: "action", status: "claimed", revision: 1 }];
  const recovery = harness("reviewer"), panels = recovery.panels(data);
  assert.match(renderToStaticMarkup(walk(panels, n => n.type === "p" && n.props.role === "status")[0]), /Original source provenance unavailable/);
  assert.equal(button(panels, "Reconcile recorded execution").props.disabled, false);
  assert.equal(app.requests.length, 0); app.unmount(); recovery.unmount();
});

test("live draft preparation is explicit, ordered and uses current editor capability", async () => {
  const app = harness("seller", "Outreach"), value = microsoftData();
  value.microsoft.can_prepare = true;
  const editor = walk(app.panels(value), n => n.type === app.components.editor)[0];
  assert.equal(editor.props.liveAvailable, true);
  const pending = editor.props.save(value.actions[0].payload, "live"); await flush();
  assert.deepEqual(JSON.parse(app.requests[0].init.body), { expected_revision: 8, alternative_id: "choice", step_id: "task",
    mode: "live", connector_id: "microsoft-live", payload: value.actions[0].payload });
  app.requests[0].resolve({}); await pending;
  const draft = harness(), props = { ...editor.props, save: async (payload, mode) => { props.saved = { payload, mode }; } };
  let tree = draft.render(draft.components.editor, props);
  assert.equal(walk(tree, n => n.type === "select")[0].props.value, "live");
  walk(tree, n => n.type === "form")[0].props.onSubmit({ preventDefault() {} });
  assert.deepEqual(props.saved, { payload: { schema_version: "1", ...value.actions[0].payload }, mode: "live" });
  const unavailable = harness("seller", "Outreach"), blocked = microsoftData();
  assert.equal(walk(unavailable.panels(blocked), n => n.type === unavailable.components.editor)[0].props.liveAvailable, false);
});

test("original maker readiness enables reviewer without own mailbox; reconnect only enables readback", () => {
  for (const [role, changes, permitted] of [["reviewer", {}, true], ["seller", {}, true], ["viewer", {}, false],
    ["reviewer", { can_write: false }, false], ["reviewer", { binding_hash: "obsolete" }, false]]) {
    const app = harness(role), value = microsoftData(); Object.assign(value.microsoft.actions[0], changes);
    assert.equal(button(app.panels(value), "Execute live Unsent Outlook draft").props.disabled, !permitted);
  }
  const review = harness("reviewer", "Approval"), value = microsoftData(); value.decisions = [];
  assert.equal(walk(review.panels(value), n => typeof n.type === "function" && n.type.name === "ReviewForm")[0].props.disabled, false);
  for (const [role, allowed] of [["reviewer", true], ["admin", true], ["seller", false], ["viewer", false]]) {
    const app = harness(role), value = microsoftData(); value.microsoft.actions[0].can_write = false;
    value.executions = [{ id: "execution", action_id: "action", status: "result_unknown", revision: 2 }];
    value.mission.evidence.snapshot_hash = "stale";
    assert.equal(button(app.panels(value), "Reconcile recorded execution").props.disabled, !allowed);
    value.microsoft.actions[0].can_reconcile = false;
    assert.equal(button(app.panels(value), "Reconcile recorded execution").props.disabled, true);
  }
});

test("loader rejects stale Microsoft mission/action readiness", async () => {
  for (const update of [r => { r.mission_revision = 9; }, r => { r.actions[0].binding_hash = "old"; }, r => { r.account_id = "foreign"; }]) {
    const app = harness(), value = microsoftData(), props = { id: "mission", configured: false, refresh() {} };
    update(value.microsoft); app.render(app.components.loader, props); app.requests.shift().resolve(value.mission); await flush();
    for (const request of app.requests.splice(0)) request.resolve(request.url.startsWith("plans/") ? value.plan
      : request.url.startsWith("accounts/") ? value.account : request.url.includes("microsoft/") ? value.microsoft
      : request.url.endsWith("execution-readiness") ? value.readiness : request.url.endsWith("/actions") ? value.actions : []);
    await flush(); for (const request of app.requests.splice(0)) request.resolve([]);
    await flush(); app.requests.shift().resolve(value.mission); await flush();
    assert.match(renderToStaticMarkup(app.render(app.components.loader, props)), /Microsoft binding changed/);
  }
});

test("connection locks duplicates, blocks wrong host/viewer and refreshes after uncertain completion", async t => {
  const events = [], navigations = [];
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { origin: "http://127.0.0.1:3000", assign: url => navigations.push(url) }, dispatchEvent: event => events.push(event.type) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; });
  const status = { configured: true, connected: true, write_configured: true, connection_origin: "http://127.0.0.1:3000",
    mailbox_id: "maker", binding_id: "binding", expires_at: 1800000000 };
  for (const outcome of ["success", "lost", "unmounted", "unsafe-url"]) {
    const app = harness(), changes = [], invalidations = [], props = { invalidate: () => invalidations.push(true), changed: m => changes.push(m) };
    let tree = app.render(app.components.connection, props); app.requests.shift().resolve(status); await flush();
    tree = app.render(app.components.connection, props);
    button(tree, "Reconnect Microsoft").props.onClick(); button(tree, "Reconnect Microsoft").props.onClick(); await flush();
    assert.equal(app.requests.length, 1); assert.equal(invalidations.length, 1);
    const request = app.requests.shift(); assert.equal(request.url, "integrations/microsoft/connect");
    if (outcome === "unmounted") { app.unmount(); assert.equal(request.init.signal.aborted, true); }
    if (outcome === "lost") request.reject(new Error("Lost response"));
    else request.resolve({ authorization_url: outcome === "unsafe-url" ? "https://foreign.example/authorize" : "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize" });
    await flush();
    if (outcome === "unmounted") assert.equal(changes.length, 0);
    else { assert.equal(changes.length, 1); if (outcome !== "success") assert.match(changes[0], /may have committed/); }
  }
  assert.equal(navigations.length, 1); assert.deepEqual(events, ["vitaai-microsoft-changed"]);
  for (const [role, origin] of [["viewer", status.connection_origin], ["seller", "http://localhost:3000"]]) {
    const app = harness(role), props = { invalidate() {}, changed() {} };
    app.render(app.components.connection, props); app.requests.shift().resolve({ ...status, connection_origin: origin }); await flush();
    const tree = app.render(app.components.connection, props);
    assert.equal(button(tree, "Reconnect Microsoft").props.disabled, true);
    button(tree, "Reconnect Microsoft").props.onClick(); assert.equal(app.requests.length, 0);
    button(tree, "Sign out Microsoft").props.onClick(); await flush(); assert.equal(app.requests.length, 1);
    app.requests[0].resolve({}); await flush();
  }
});

test("connection completion after a focus remount releases directory lock and reloads authority", async t => {
  const listeners = new Map();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: name => listeners.delete(name),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "window", previous); else delete globalThis.window; });
  const app = harness(), directory = () => app.render(app.components.directory, {});
  const loading = tree => walk(tree, n => n.type === "p" && n.props.children === "Loading current missions...").length > 0;
  const resolveReads = async () => { for (const request of app.requests.splice(0)) request.resolve(request.url === "portfolio"
    ? { accounts: [] } : request.url === "missions" ? [] : { configured: false }); await flush(); };
  directory(); await resolveReads();
  let tree = directory(), connection = walk(tree, n => n.type === app.components.connection)[0];
  connection.props.invalidate();
  tree = directory(); assert.equal(loading(tree), true);
  listeners.get("focus")(); directory(); await resolveReads();
  tree = directory(); connection = walk(tree, n => n.type === app.components.connection)[0];
  assert.equal(connection.props.blocked, true);
  listeners.get("vitaai-microsoft-changed")(); directory(); await resolveReads();
  tree = directory(); connection = walk(tree, n => n.type === app.components.connection)[0];
  assert.equal(connection.props.blocked, false);
  assert.equal(loading(tree), false);
});

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
  assert.equal(walk(draft, n => n.type === "option" && n.props.value === "live")[0].props.children, "Live Microsoft · unsent draft");
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
