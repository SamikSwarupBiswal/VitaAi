import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, filename); return target.exports;
}
const view = { account: { id: "account", organization_id: "org", revision: 3, name: "<script>Account</script>" },
  source: { id: "source" }, assessment: { as_of: "2026-10-27", snapshot_hash: "hash" } };
const portfolio = { organization_id: "org", as_of: "2026-10-27", accounts: [view] };
const mission = (id = "mission") => ({ id, organization_id: "org", account_id: "account", owner_id: "owner", status: "reconciliation_required",
  revision: 8, content_revision: 2, plan_id: `${id}-plan`, plan_revision: 1, created_at: "2026-10-25T01:00:00Z",
  evidence: { account_id: "account", account_revision: 2, snapshot_hash: "old-hash", as_of: "2026-10-25" } });
function records(id = "mission", suffix = "a") {
  const action = { id: `${id}-${suffix}`, organization_id: "org", mission_id: id, mission_revision: 2, plan_id: `${id}-plan`, plan_revision: 1,
    revision: 4, slot_id: `${id}-slot-${suffix}`, evidence: mission(id).evidence, mode: "live", payload: { kind: "hubspot_task_create" },
    binding_hash: "binding", destination: { connector_id: "hubspot-live", provider: "hubspot", configuration_revision: 1,
      tenant_id: "portal", target_account_id: "account", target_resource_id: "company", delegated_user_id: null, mailbox_id: null } };
  const decision = { id: `${action.id}-decision`, organization_id: "org", action_id: action.id, action_revision: 4, binding_hash: "binding", decision: "approved" };
  const execution = { id: `${action.id}-execution`, organization_id: "org", action_id: action.id, action_revision: 4, decision_id: decision.id,
    binding_hash: "binding", revision: 5, attempt: 2, status: "result_unknown", receipt_id: `${action.id}-receipt`,
    claimed_at: "2026-10-25T02:00:00Z", dispatched_at: "2026-10-25T02:01:00Z", finished_at: "2026-10-25T02:02:00Z" };
  const receipt = { id: execution.receipt_id, organization_id: "org", execution_id: execution.id, action_id: action.id, decision_id: decision.id,
    binding_hash: "binding", destination: { ...action.destination }, mode: "live", result: "result_unknown", verification: "unavailable",
    recorded_at: "2026-10-25T02:02:00Z", provider_resource_id: null, readback_hash: null, readback_at: null, error_code: "provider_timeout" };
  return { action, decision, execution, receipt };
}
function library(options = {}) {
  const requests = [], counts = new Map(), all = options.records ?? [records()];
  const api = async (url, init) => {
    assert.equal(init.method, undefined); assert.ok(init.signal); requests.push(url);
    const n = (counts.get(url) || 0) + 1; counts.set(url, n);
    if (options.reply) { const value = options.reply(url, n); if (value !== undefined) return value; }
    if (url.startsWith("accounts/")) return view;
    const [kind, id, suffix] = url.split("/");
    if (kind === "missions") return suffix ? all.filter(item => item.action.mission_id === id).map(item => item.action) : mission(id);
    const item = all.find(item => kind === "receipts" ? item.receipt.id === id : item.action.id === id);
    assert.ok(item, url);
    if (kind === "receipts") return item.receipt;
    return suffix === "decisions" ? [item.decision] : item.execution ? [item.execution] : [];
  };
  const helpers = { "./api": { api } }, account = load("../lib/account-history.ts"), manager = load("../lib/manager-reports.ts", helpers);
  const helper = load("../lib/operations-receipts.ts", { ...helpers, "./account-history": account, "./manager-reports": manager });
  return { helper, requests, all, read: (missions = [mission()], signal = new AbortController().signal) => helper.readOperationsReceipts(portfolio, missions, signal) };
}

test("bounded GET inspection retains exact original execution/receipt identity, unknown status and all lifecycle coverage", async () => {
  const list = Array.from({ length: 7 }, (_, i) => ({ ...mission(`m${i}`), status: i ? "completed" : "draft" }));
  const app = library({ records: list.map(item => records(item.id)), reply: url => list.find(item => url === `missions/${item.id}`) }), original = JSON.stringify(app.all);
  const result = await app.read([{ ...mission("outside"), account_id: "outside" }, ...list]);
  assert.equal(result.total, 7); assert.deepEqual(result.rows.map(row => row.mission.id), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(result.rows[1].actions[0].receipt.id, "m1-a-receipt"); assert.equal(result.rows[1].actions[0].execution.attempt, 2);
  assert.match(app.helper.receiptDiagnosis(result.rows[0].actions[0]), /Result unknown.*Do not repeat/);
  assert.ok(app.requests.every(url => !/outside|m5|m6|readiness|reconcile|retry|execute/.test(url)));
  assert.equal(original, JSON.stringify(app.all)); assert.equal(app.requests.filter(url => url === "accounts/account").length, 1);
});

test("independent mission, action and receipt failures preserve other saved results without exposing error bodies", async () => {
  const all = [records("m0"), records("m0", "b"), records("m1"), records("m2")];
  const app = library({ records: all, reply(url) {
    if (["missions/m1", "actions/m0-b/executions", "receipts/m2-a-receipt"].includes(url)) throw new Error("private provider body");
  } });
  const result = await app.read([mission("m0"), mission("m1"), mission("m2")]);
  assert.ok(result.rows[0].actions[0].receipt); assert.equal(result.rows[0].actions[1].unavailable, true);
  assert.equal(result.rows[1].actions, null); assert.equal(result.rows[2].actions[0].receiptUnavailable, true);
  assert.equal(result.rows[2].actions[0].execution.status, "result_unknown");
  assert.doesNotMatch(JSON.stringify(result), /private provider/);
});

test("crossed mission/action/decision/claim/receipt bindings are unavailable at their own boundary", async () => {
  for (const corrupt of [x => { x.action.mission_id = "foreign"; }, x => { x.action.plan_revision = 7; },
    x => { x.action.organization_id = "foreign"; }, x => { x.action.mission_revision = 9; },
    x => { x.action.destination.target_account_id = "foreign"; }, x => { x.execution.action_revision = 7; },
    x => { x.action.evidence = { ...x.action.evidence, snapshot_hash: "other" }; },
    x => { x.execution.action_id = "foreign"; }, x => { x.execution.organization_id = "foreign"; },
    x => { x.execution.binding_hash = "wrong"; }, x => { x.decision.id = "foreign"; },
    x => { x.decision.decision = "rejected"; }, x => { x.decision.action_revision = 9; },
    x => { x.receipt.execution_id = "foreign"; }, x => { x.receipt.organization_id = "foreign"; },
    x => { x.receipt.decision_id = "foreign"; }, x => { x.receipt.mode = "simulation"; },
    x => { x.receipt.binding_hash = "wrong"; }, x => { x.receipt.destination.tenant_id = "wrong"; },
    x => { x.receipt.destination.mailbox_id = "wrong"; }, x => { x.receipt.result = "failed"; },
    x => { x.receipt.verification = "verified"; }, x => { x.receipt.error_code = "private body with spaces"; },
    x => { delete x.action.destination.mailbox_id; x.receipt.destination.mailbox_id = "other"; }]) {
    const value = records(); corrupt(value);
    // Keep the response route fixed even when its retained membership was crossed.
    const app = library({ records: [value], reply: url => url.endsWith("/actions") ? [value.action]
      : url === "actions/mission-a/executions" ? [value.execution]
        : url === "receipts/mission-a-receipt" ? value.receipt : undefined });
    const result = await app.read(), row = result.rows[0].actions?.[0];
    assert.ok(!row || row.unavailable || row.receiptUnavailable, String(corrupt));
  }
  for (const list of [[mission(), mission()], [{ ...mission(), organization_id: "foreign" }]]) await assert.rejects(library().read(list), /list changed/);
  for (const bad of [[records().action, records().action], Array.from({ length: 13 }, (_, i) => records("mission", `${i}`).action)]) {
    assert.equal((await library({ reply: url => url.endsWith("/actions") ? bad : undefined }).read()).rows[0].actions, null);
  }
});

test("final claim/action/mission/account reads reject concurrent changes even without mission revision changes", async () => {
  for (const [route, value] of [["actions/mission-a/executions", [{ ...records().execution, revision: 6, receipt_id: "new" }]],
    ["missions/mission/actions", [{ ...records().action, revision: 5 }]], ["missions/mission", { ...mission(), revision: 9 }],
    ["missions/mission", { ...mission(), content_revision: 3 }], ["missions/mission", { ...mission(), account_id: "foreign" }]]) {
    const result = await library({ reply: (url, n) => url === route && n > 1 ? value : undefined }).read();
    assert.ok(result.rows[0].actions === null || result.rows[0].actions[0].unavailable, route);
  }
  for (const changed of [{ ...view, source: { id: "other" } }, { ...view, account: { ...view.account, revision: 4 } },
    { ...view, assessment: { ...view.assessment, as_of: "2026-10-28" } }, { ...view, assessment: { ...view.assessment, snapshot_hash: "other" } }]) {
    assert.equal((await library({ reply: url => url.startsWith("accounts/") ? changed : undefined }).read()).rows[0].actions, null);
  }
  const value = records(); value.execution = null;
  const result = await library({ records: [value], reply: (url, n) => url.endsWith("/executions") && n > 1 ? [records().execution] : undefined }).read();
  assert.equal(result.rows[0].actions[0].unavailable, true);
  const controller = new AbortController(); controller.abort(); const app = library(); await assert.rejects(app.read([mission()], controller.signal), /ended/); assert.equal(app.requests.length, 0);
});

test("diagnostic wording preserves no-claim, active, known failure, unverified success and saved verified simulation distinctions", () => {
  const { helper } = library(), value = records(), base = { ...value, unavailable: false, receiptUnavailable: false };
  assert.match(helper.receiptDiagnosis({ ...base, execution: null }), /No saved execution claim/);
  for (const status of ["claimed", "dispatching"]) assert.match(helper.receiptDiagnosis({ ...base, execution: { ...value.execution, status } }), /active or interrupted/);
  assert.match(helper.receiptDiagnosis({ ...base, execution: { ...value.execution, status: "failed" } }), /Known failed/);
  assert.match(helper.receiptDiagnosis({ ...base, execution: { ...value.execution, status: "succeeded" }, receipt: null }), /lacks verified readback/);
  assert.match(helper.receiptDiagnosis({ ...base, execution: { ...value.execution, status: "succeeded" }, receipt: { ...value.receipt, verification: "verified", mode: "simulation" } }), /does not establish a business outcome/);
});

const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function setup(t) {
  const slots = [], cleanups = [], requests = [], listeners = new Map(); let cursor = 0, effects = [], props = { portfolio, missions: [mission()] }, unmounted = false;
  let session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } };
  const previous = globalThis.window;
  globalThis.window = { addEventListener(n, fn) { listeners.set(n, fn); }, removeEventListener(n) { listeners.delete(n); } };
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { ...React, useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const component = load("../components/operations-receipts.tsx", { react: hooks, "next/link": { __esModule: true, default: p => React.createElement("a", p) },
    "./session-gate": { useSession: () => session }, "@/lib/operations-receipts": { receiptDiagnosis: library().helper.receiptDiagnosis,
      readOperationsReceipts: (portfolio, missions, signal) => new Promise((resolve, reject) => requests.push({ portfolio, missions, signal, resolve, reject })) } });
  const outer = () => component.OperationsReceipts(props);
  const render = () => { cursor = 0; const node = outer(), tree = node ? node.type(node.props) : null;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = () => walk(render()).find(x => x.type === "button");
  const unmount = () => { if (unmounted) return; unmounted = true; cleanups.forEach(fn => fn?.()); };
  t.after(() => { unmount(); globalThis.window = previous; });
  return { requests, render, outer, button, unmount, setProps(value) { props = { ...props, ...value }; }, setSession(v) { session = v; }, emit(n) { listeners.get(n)?.(); },
    async inspect(result) { const p = button().props.onClick(); requests.shift().resolve(result); await p; } };
}

test("viewer diagnostics disclose independent coverage, historical mode/dates and exact Execution links without mutations", async t => {
  const app = setup(t); app.render(); assert.equal(app.requests.length, 0);
  const value = records(), row = { ...value, unavailable: false, receiptUnavailable: false };
  await app.inspect({ total: 8, rows: [{ mission: mission(), actions: [row, { ...row, action: { ...row.action, id: "bad" }, unavailable: true, execution: null, receipt: null }] },
    { mission: mission("missing"), actions: null }, { mission: mission("unavailable"), actions: [{ ...row, receipt: null, receiptUnavailable: true }] }] });
  const tree = app.render(), html = renderToStaticMarkup(tree);
  for (const text of ["Inspected 3 of 8", "5 older missions excluded", "1 inspected missions unavailable", "1 claim reads unavailable", "1 referenced receipt reads unavailable",
    "Result unknown", "Do not repeat the write", "Historical evidence binding", "provider_timeout", "2026-10-25T02:02:00Z", "not a complete queue", "No execution result inferred"]) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;Account/); assert.doesNotMatch(html, /<script>/);
  const links = walk(tree).filter(x => x.props?.href).map(x => new URL(x.props.href, "http://localhost"));
  links.forEach((url, i) => { assert.equal(url.searchParams.get("account"), "account"); assert.equal(url.searchParams.get("mission"), ["mission", "missing", "unavailable"][i]); assert.equal(url.searchParams.get("step"), "Execution"); });
  assert.equal(walk(tree).filter(x => x.type === "form").length, 0); assert.equal(app.requests.length, 0);
});

test("duplicate, captured and unmounted handlers cannot publish or request obsolete diagnostics", async t => {
  const app = setup(t); app.render(); const handler = app.button().props.onClick;
  const old = handler(); await handler(); assert.equal(app.requests.length, 1); const request = app.requests.shift();
  app.emit("focus"); await handler(); assert.equal(app.requests.length, 0); assert.equal(app.button().props.disabled, true);
  request.resolve({ total: 1, rows: [{ mission: mission(), actions: [] }] }); await old;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /No saved actions/);
  app.unmount(); await handler(); assert.equal(request.signal.aborted, true); assert.equal(app.requests.length, 0);
});

test("workflow/source events clear results and fence captured handlers; errors and empty states stay explicit", async t => {
  for (const event of ["vitaai-workflow-changed", "vitaai-source-changed"]) {
    const app = setup(t); await app.inspect({ total: 1, rows: [{ mission: mission(), actions: [] }] });
    const handler = app.button().props.onClick; app.emit(event); await handler(); assert.equal(app.requests.length, 0);
    assert.doesNotMatch(renderToStaticMarkup(app.render()), /No saved actions/); app.unmount();
  }
  const app = setup(t); await app.inspect({ total: 0, rows: [] }); assert.match(renderToStaticMarkup(app.render()), /No saved missions/);
  const pending = app.button().props.onClick(); app.requests.shift().reject(new Error("private failure")); await pending;
  assert.match(renderToStaticMarkup(app.render()), /inspection unavailable or changed/); assert.doesNotMatch(renderToStaticMarkup(app.render()), /private failure/);
});

test("actor, source, account, mission and date keys remount diagnostics and sample/foreign sessions read nothing", t => {
  const app = setup(t), key = app.outer().key;
  for (const value of [{ portfolio: { ...portfolio, as_of: "2026-10-28" } }, { missions: [{ ...mission(), revision: 9 }] },
    { missions: [{ ...mission(), plan_revision: 2 }] }, { missions: [{ ...mission(), content_revision: 3 }] },
    { portfolio: { ...portfolio, accounts: [{ ...view, source: { id: "changed" } }] } },
    { portfolio: { ...portfolio, accounts: [{ ...view, assessment: { ...view.assessment, as_of: "2026-10-28" } }] } }]) {
    app.setProps(value); assert.notEqual(app.outer().key, key); app.setProps({ portfolio, missions: [mission()] });
  }
  app.setSession({ mode: "session", actor: { id: "actor", organization_id: "org", role: "admin" } }); assert.notEqual(app.outer().key, key);
  for (const session of [null, { mode: "sample" }, { mode: "session", actor: { organization_id: "foreign" } }]) {
    app.setSession(session); assert.equal(app.render(), null); assert.equal(app.requests.length, 0);
  }
});
