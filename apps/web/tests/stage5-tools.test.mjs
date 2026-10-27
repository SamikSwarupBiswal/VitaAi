import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const uuid = number => `${String(number).padStart(8, "0")}-1111-4111-8111-111111111111`;
const account = uuid(1), actor = uuid(2), other = uuid(3), runId = uuid(4), secondRun = uuid(5), mission = uuid(6);
const hash = "a".repeat(64), projection = "b".repeat(64), time = "2026-10-26T12:00:00Z";
const record = (id = uuid(7)) => ({ id, organization_id: "org", account_id: account, revision: 1, created_at: time, correlation_id: uuid(8), schema_version: "1" });
const assessment = () => ({ as_of: "2026-10-26", snapshot_hash: hash, policy_version: "baseline-1", risk: 60, health: 40, opportunity: 10, factors: [], caveats: [] });
const view = () => ({ account: { id: account, organization_id: "org", name: "Synthetic Account", revision: 1 }, evidence: [], assessment: assessment() });
const saved = () => ({ id: runId, organization_id: "org", actor_id: "original", started_at: time, contexts: [{ account: view().account }], recommendations: [{ account_id: account, assessment: assessment() }] });
const scenario = (id = uuid(7), title = "Scenario A", request = {}) => ({ ...record(id), author_id: actor, source_started_at: time, source_author_id: "original",
  request: { schema_version: "1", request_id: uuid(10), pipeline_id: runId, expected_snapshot_hash: hash, title, assumptions: ["Unverified assumption"], overrides: { usage_change: -10 }, ...request },
  mode: "simulation", policy_version: "what-if-1", model_version: "none-deterministic", baseline: view(), projected: assessment(), projection_hash: projection, caveats: [], alternatives: [] });
const promotion = item => ({ ...record(uuid(12)), scenario_id: item.id, scenario_projection_hash: item.projection_hash, approval_status: "unapproved", assumption_acknowledgement: "Investigate before action",
  plan: { id: uuid(13), revision: 1, selected_alternative_id: uuid(16), organization_id: "org", account_id: account, pipeline_run_id: runId, source: "deterministic", status: "valid", validation: "valid",
    evidence: { account_id: account, snapshot_hash: hash }, caveats: [`Scenario provenance ${item.id} ${item.projection_hash}`] } });
const trend = () => ({ ...record(uuid(14)), author_id: actor, policy_version: "trend-1", mode: "synthetic_history", input_count: 2, available_count: 2,
  request: { pipeline_ids: [runId, secondRun], start: "2026-10-01T00:00:00Z", end: "2026-10-27T00:00:00Z" }, caveats: [],
  metrics: Object.entries({ usage_change: "percent", support_cases: "count", expansion: "score/100", renewal: "days" }).map(([metric, unit]) => ({ metric, unit, status: "unchanged", delta: 0, per_day: null,
    points: [{ pipeline_id: runId, snapshot_hash: hash, observed_at: time, saved_at: time, value: 1, source: "Synthetic CRM", source_record: metric, evidence_id: uuid(15) }], duplicate_count: 1, corrected_count: 0, excluded_count: 0 })) });
const handoff = (id = uuid(20), reason = "Handoff A") => ({ ...record(id), mission_id: mission, mission_revision: 1, sender_id: other, recipient_id: actor, evidence_ids: [uuid(21)], reason, status: "pending" });
const handoffHistory = item => ({ handoff: item, current_mission_revision: 1, refresh_required: false,
  events: [{ ...record(uuid(22)), handoff_id: item.id, status: item.status, actor_id: other, note: item.reason, mission_revision: 1 }] });
const memory = () => ({ ...record(uuid(23)), state: "active", captured_by: actor, source_hash: projection, source: { organization_id: "org", account_id: account, kind: "mission", source_id: mission, content_hash: hash, summary: "Original mission", source_time: time } });
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);

function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  target.require = name => mocks[name] ?? (name === "./pipeline-history" ? { savedRunId: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/ } : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return target.exports;
}
const helper = load("../lib/intelligence.ts");

function setup(t, subject = "intelligence", role = "admin") {
  const slots = [], cleanups = [], requests = [], listeners = new Map(); let cursor = 0, effects = [];
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); }, removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  const effect = (fn, deps) => { const index = cursor++; if (!(index in slots) || deps.some((value, n) => value !== slots[index][n])) { slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } };
  const hooks = { ...React, useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial; return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; } };
  const component = load(`../components/${subject === "intelligence" ? "intelligence-page" : "account-tools"}.tsx`, {
    react: hooks, "next/navigation": { useSearchParams: () => new URLSearchParams({ account }) }, "@/lib/intelligence": helper,
    "@/lib/pipeline-history": { savedRunId: /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/ },
    "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: actor, role, organization_id: "org" } }) },
  });
  const render = () => { cursor = 0; let tree;
    if (subject === "intelligence") tree = component.IntelligenceWorkspace({ account, organization: "org", canWrite: role !== "viewer" });
    else { const node = component.AccountTools({ view: view() }); tree = node.type(node.props); }
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree;
  };
  const unmount = () => cleanups.forEach(fn => fn?.());
  t.after(() => { unmount(); globalThis.window = oldWindow; });
  const app = { requests, render, unmount, html: () => renderToStaticMarkup(render()),
    button(name) { const node = walk(render()).find(node => node.type === "button" && text(node.props.children) === name); assert.ok(node, `Missing button ${name}`); return node; },
    click(name) { return this.button(name).props.onClick(); },
    field(name, value) { const label = walk(render()).find(node => node.type === "label" && text(node.props.children).startsWith(name)); assert.ok(label, `Missing field ${name}`); const field = walk(label).find(node => ["input", "textarea", "select"].includes(node.type)); field.props.onChange({ target: { value } }); render(); },
    request(url) { const index = requests.findIndex(item => item.url === url); assert.notEqual(index, -1, `Missing request ${url}; queued ${requests.map(item => item.url)}`); return requests.splice(index, 1)[0]; },
    emit(name) { for (const fn of listeners.get(name) ?? []) fn(); render(); },
    async inspect() { const pending = this.click("Inspect current account"); this.request(`accounts/${account}`).resolve(view()); await pending; render(); },
    async history(items = []) { const pending = this.click("Inspect saved scenarios and trends"); this.request(`intelligence/accounts/${account}/scenarios`).resolve(items); this.request(`intelligence/accounts/${account}/trends`).resolve([]); await pending; render(); },
    async baseline() { this.field("Exact saved recommendation run", runId); const pending = this.click("Inspect baseline"); this.request(`pipeline/${runId}`).resolve(saved()); await pending; render(); },
    async handoffs(items = [handoff()]) { const pending = this.click("Inspect handoffs and recipients"); this.request("missions").resolve([{ ...record(mission), evidence: { evidence_ids: [uuid(21)] } }]); this.request("collaboration/recipients").resolve({ limit: 100, items: [{ id: other, username: "Other", role: "seller" }], has_more: false }); this.request(`collaboration/accounts/${account}/handoffs`).resolve({ limit: 50, items, has_more: false }); await pending; render(); },
    async detail(item) { const pending = this.click(`${item.status} · ${item.reason} · ${item.id}`); this.request(`collaboration/handoffs/${item.id}`).resolve(handoffHistory(item)); await pending; render(); },
  };
  render(); return app;
}

test("what-if values and trend instants require finite bounded inputs and explicit valid timezone", () => {
  assert.equal(helper.explicitInstant("2026-10-26T17:30:00+05:30"), "2026-10-26T12:00:00.000Z");
  for (const value of ["2026-10-26", "2026-10-26T12:00:00", "2026-02-30T12:00:00Z", "garbage"]) assert.throws(() => helper.explicitInstant(value));
  assert.deepEqual(helper.parseOverrides({ support_cases: "0", usage_change: "-32" }), { schema_version: "1", support_cases: 0, usage_change: -32 });
  for (const values of [{}, { usage_change: "NaN" }, { support_cases: "1.5" }, { expansion: "101" }, { renewal_days: "-1" }]) assert.throws(() => helper.parseOverrides(values));
  assert.throws(() => helper.trendIds(`${runId},${runId}`));
});

test("scenario, promotion and trend validators reject crossed bindings, units and calculated invalid statuses", () => {
  const item = scenario(); helper.scenarioScope(item, "org", account); helper.promotionScope(promotion(item), item, "org", account, hash); helper.trendScope(trend(), "org", account);
  for (const mutate of [x => x.account_id = other, x => x.request.expected_snapshot_hash = projection, x => x.projected.as_of = "2026-01-01"]) { const value = scenario(); mutate(value); assert.throws(() => helper.scenarioScope(value, "org", account)); }
  for (const mutate of [x => x.scenario_id = other, x => x.plan.account_id = other, x => x.scenario_projection_hash = hash, x => x.plan.caveats = [], x => x.approval_status = "approved"]) { const value = promotion(item); mutate(value); assert.throws(() => helper.promotionScope(value, item, "org", account)); }
  for (const mutate of [x => x.metrics[0].unit = "count", x => x.metrics[0].points[0].pipeline_id = other, x => x.metrics[0].status = "conflicting", x => x.metrics[0].points[0].observed_at = "2025-01-01T00:00:00Z"]) { const value = trend(); mutate(value); assert.throws(() => helper.trendScope(value, "org", account)); }
});

test("captured scenario controls cannot promote an earlier selection and crossed saved promotions stay hidden", async t => {
  const app = setup(t), first = scenario(), second = scenario(uuid(30), "Scenario B");
  await app.history([first, second]); await app.inspect(); await app.click("Scenario A — " + time); app.field("Human acknowledgement", "Investigate before action");
  const captured = app.button("Prepare unapproved review plan"); await app.click("Scenario B — " + time); await captured.props.onClick(); assert.equal(app.requests.length, 0);
  assert.equal(app.button("Prepare unapproved review plan").props.disabled, true);
  const read = app.click("Inspect saved promotion"); app.request(`intelligence/scenarios/${second.id}/promotion`).resolve(promotion(first)); await read;
  assert.match(app.html(), /Promotion binding changed/); assert.doesNotMatch(app.html(), /Unapproved plan/);
});

test("uncertain scenario writes require history readback and exact input rebinding without replay", async t => {
  const app = setup(t); await app.baseline(); app.field("Scenario title", "Scenario A"); app.field("Assumption and uncertainty", "Unverified assumption"); app.field("Usage change", "-10");
  const captured = app.button("Save what-if scenario"), pending = captured.props.onClick(); const sent = app.request(`intelligence/accounts/${account}/scenarios`);
  await captured.props.onClick(); assert.equal(app.requests.length, 0); sent.reject(new Error("Lost response")); await pending;
  await app.click("Save what-if scenario"); assert.equal(app.requests.length, 0); assert.match(app.html(), /writes are paused/);
  await app.history(); await captured.props.onClick(); assert.equal(app.requests.length, 0);
  await app.click("Save what-if scenario"); assert.equal(app.requests.length, 0); await app.baseline();
  app.field("Scenario title", "New explicit scenario"); app.field("Assumption and uncertainty", "Separate reviewed assumption"); app.field("Usage change", "-12");
  const save = app.click("Save what-if scenario"), request = app.request(`intelligence/accounts/${account}/scenarios`), body = JSON.parse(request.init.body);
  request.resolve(scenario(uuid(31), body.title, body)); await save;
  assert.match(app.html(), /New explicit scenario — simulation/); assert.equal(app.requests.length, 0);
});

test("timezone-free trend ranges fail before any mutation and late/unmounted reads cannot publish", async t => {
  const app = setup(t); app.field("Two to fifty", `${runId},${secondRun}`); app.field("Range start", "2026-10-01T00:00:00"); app.field("Range end", "2026-10-27T00:00:00Z");
  await app.click("Save observed trend report"); assert.equal(app.requests.length, 0); assert.match(app.html(), /explicit timezone/);
  const pending = app.click("Inspect current account"), request = app.request(`accounts/${account}`); app.unmount(); request.resolve(view()); await pending; assert.doesNotMatch(app.html(), /Current account: Synthetic Account/);
});

test("captured handoff transition and navigation cannot target the previous inspected handoff", async t => {
  const app = setup(t, "tools"), first = handoff(), second = handoff(uuid(32), "Handoff B"); await app.handoffs([first, second]); await app.detail(first);
  app.field("Handoff reason or transition note", "Reviewed recipient note"); const captured = app.button("Accept internal handoff"), link = walk(app.render()).find(node => node.type === "a" && text(node.props.children) === "Open exact mission for review");
  await app.detail(second); await captured.props.onClick(); assert.equal(app.requests.length, 0); let prevented = false; link.props.onClick({ preventDefault() { prevented = true; } }); assert.ok(prevented);
  assert.equal(app.button("Accept internal handoff").props.disabled, true);
});

test("uncertain handoff transition locks writes until participant history refresh and new exact detail", async t => {
  const app = setup(t, "tools"), item = handoff(); await app.handoffs([item]); await app.detail(item); app.field("Handoff reason or transition note", "Reviewed note");
  const captured = app.button("Accept internal handoff"), pending = captured.props.onClick(), sent = app.request(`collaboration/handoffs/${item.id}/transition`);
  sent.reject(new Error("Lost response")); await pending; await captured.props.onClick(); assert.equal(app.requests.length, 0); assert.match(app.html(), /Writes are paused/);
  await app.handoffs([item]); await captured.props.onClick(); assert.equal(app.requests.length, 0); await app.detail(item);
  assert.equal(app.button("Accept internal handoff").props.disabled, true); app.field("Handoff reason or transition note", "Fresh explicit note");
  const next = app.click("Accept internal handoff"), request = app.request(`collaboration/handoffs/${item.id}/transition`); request.resolve({ ...item, revision: 2, status: "accepted" }); await next;
  assert.equal(app.requests.length, 0); assert.doesNotMatch(app.html(), /Writes are paused/);
});

test("source-memory capture validates returned source identity and uncertainty requires matching memory history", async t => {
  const app = setup(t, "tools"), item = memory(); app.field("Saved source ID", mission);
  const inspect = app.click("Inspect original source"); app.request(`memory/sources/accounts/${account}/preview/mission/${mission}`).resolve(item.source); await inspect;
  const captured = app.button("Capture inspected source memory"), pending = captured.props.onClick(), sent = app.request(`memory/sources/accounts/${account}`);
  sent.resolve({ ...item, source: { ...item.source, source_id: other } }); await pending; assert.match(app.html(), /Writes are paused/);
  await app.handoffs([]); await captured.props.onClick(); assert.equal(app.requests.length, 0); assert.match(app.html(), /Writes are paused/);
  const history = app.click("Inspect source memory"); app.request(`memory/sources/accounts/${account}`).resolve({ organization_id: "org", account_id: account, limit: 20, total_count: 1, has_more: false, items: [item] }); await history;
  await captured.props.onClick(); assert.equal(app.requests.length, 0); assert.doesNotMatch(app.html(), /Writes are paused/);
});

test("a failed detail read invalidates captured writes even when no mutation was sent", async t => {
  const app = setup(t, "tools"), item = handoff(); await app.handoffs([item]); await app.detail(item); app.field("Handoff reason or transition note", "Reviewed note");
  const captured = app.button("Accept internal handoff"), pending = app.click(`${item.status} · ${item.reason} · ${item.id}`), request = app.request(`collaboration/handoffs/${item.id}`);
  request.reject(new Error("Unavailable saved history")); await pending; await captured.props.onClick(); assert.equal(app.requests.length, 0);
});

test("crossed nested source records cannot be rendered as an inspected original", async t => {
  const app = setup(t, "tools"), item = memory(); app.field("Saved source ID", mission);
  const pending = app.click("Inspect original source"); app.request(`memory/sources/accounts/${account}/preview/mission/${mission}`).resolve({ ...item.source, original: { mission: { organization_id: "foreign", account_id: other, note: "Private foreign note" } } }); await pending;
  assert.doesNotMatch(app.html(), /Private foreign note/); assert.match(app.html(), /Unavailable or changed/);
});

test("viewers have read-only source and history controls", t => {
  const app = setup(t, "tools", "viewer"); const html = app.html(); assert.doesNotMatch(html, /Create exact mission handoff|Lifecycle reason/); assert.match(html, /Inspect source memory/); assert.equal(app.requests.length, 0);
});

test("scenario promotion continues into the exact unapproved draft mission with explicit creation and guarded navigation", async t => {
  const app = setup(t), item = scenario(), promoted = promotion(item);
  await app.history([item]); await app.click("Scenario A — " + time);
  const read = app.click("Inspect saved promotion"); app.request(`intelligence/scenarios/${item.id}/promotion`).resolve(promoted); await read;
  assert.equal(walk(app.render()).some(node => node.type === "button" && text(node.props.children) === "Start unapproved scenario review mission"), false);
  const inspect = app.click("Inspect missions for this exact promoted plan"); app.request("missions").resolve([]); await inspect;
  const button = app.button("Start unapproved scenario review mission"), pending = button.props.onClick(); await button.props.onClick();
  const request = app.request("missions"), body = JSON.parse(request.init.body);
  assert.deepEqual(body, { plan_id: promoted.plan.id, expected_revision: 1, template: "account-action-1", alternative_id: promoted.plan.selected_alternative_id });
  request.resolve({ ...record(mission), plan_id: promoted.plan.id, plan_revision: 1, template: "account-action-1",
    evidence: { account_id: account, snapshot_hash: hash }, status: "draft", current_step: "Review" }); await pending;
  assert.match(app.html(), /Saved scenario mission/); assert.equal(app.requests.length, 0);
  const link = walk(app.render()).find(node => node.type === "a" && text(node.props.children) === "Open exact scenario mission");
  assert.equal(link.props.href, `/missions?account=${account}&mission=${mission}&step=Review`);
  await app.history([item]); let prevented = false; link.props.onClick({ preventDefault() { prevented = true; } }); assert.ok(prevented);
});

test("uncertain scenario mission creation requires saved mission readback and cannot replay captured controls", async t => {
  const app = setup(t), item = scenario(), promoted = promotion(item);
  async function open() { await app.history([item]); await app.click("Scenario A — " + time);
    const pending = app.click("Inspect saved promotion"); app.request(`intelligence/scenarios/${item.id}/promotion`).resolve(promoted); await pending; }
  await open(); const read = app.click("Inspect missions for this exact promoted plan"); app.request("missions").resolve([]); await read;
  const button = app.button("Start unapproved scenario review mission"), pending = button.props.onClick(), request = app.request("missions");
  request.reject(new Error("Lost response")); await pending; await button.props.onClick(); assert.equal(app.requests.length, 0);
  assert.match(app.html(), /writes are paused/); await open(); await button.props.onClick(); assert.equal(app.requests.length, 0);
  const inspect = app.click("Inspect missions for this exact promoted plan"); app.request("missions").resolve([{ ...record(mission), plan_id: promoted.plan.id,
    plan_revision: 1, template: "account-action-1", evidence: { account_id: account, snapshot_hash: hash }, status: "draft", current_step: "Review" }]); await inspect;
  assert.match(app.html(), /Open exact scenario mission/);
  assert.equal(walk(app.render()).some(node => node.type === "button" && text(node.props.children) === "Start unapproved scenario review mission"), false);
});
