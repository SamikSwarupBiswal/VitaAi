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
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => name in mocks ? mocks[name] : name.startsWith("./") && relative.startsWith("../lib/")
    ? load(`../lib/${name.slice(2)}.ts`, mocks) : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, filename); return target.exports;
}
const view = { account: { id: "account", organization_id: "org", revision: 5 }, source: { id: "source5" },
  assessment: { as_of: "2026-10-26", snapshot_hash: "current" } };
const runId = "11111111-1111-4111-8111-111111111111";
const summary = { id: runId, actor_id: "original actor", started_at: "2026-10-25T00:00:00.000002Z", as_of: "2026-10-25", status: "partial",
  request: { intent: "growth", limit: 1, communicate: false, communication_mode: "drafts" }, input_account_ids: ["account"], selected_account_ids: [] };
const history = () => ({ organization_id: "org", limit: 20, total_count: 24, window_count: 20, undated_count: 2, unavailable_count: 19,
  has_more: true, items: [structuredClone(summary)] });
const detection = { id: "detection", organization_id: "org", account_id: "account", actor_id: "source actor", detected_at: "2026-10-26T00:00:00Z",
  status: "changed", reason: "values_changed", before: null, after: { source_version_id: "source5", account_revision: 5,
    selected_at: "2026-10-25T00:00:00.000001Z", fields: { usage_change: { value: 0, status: "valid", unit: "percent" } } },
  event: { id: "event", changes: [], fingerprint: "f" } };
const mission = (id = "mission") => ({ id, organization_id: "org", account_id: "account", revision: 3, plan_id: "plan", plan_revision: 1,
  owner_id: "owner", status: "completed", current_step: "Outcome", correlation_id: `correlation:${id}`, source_detection_id: "detection", transition_ids: [] });
const audit = (sequence = 1) => ({ id: `audit${sequence}`, organization_id: "org", sequence, created_at: "2026-10-25T00:00:00Z",
  entity_id: "mission", entity_revision: 3, correlation_id: "correlation:mission", actor_id: "actor", event_kind: "completed" });
const report = (n = 1) => ({ id: `report${n}`, organization_id: "org", mission_id: "mission", revision: n, supersedes_id: n === 1 ? null : `report${n-1}`,
  observed_at: "2026-10-25T01:00:00+01:00", correlation_id: `report:${n}`, report: { basis: "manual_report", kind: "follow_up_required", note: "<script>Retained note</script>" } });
const missionData = m => ({ mission: m, plan: { id: "plan", revision: 1, organization_id: "org", account_id: "account" }, account: view,
  actions: [], decisions: [], executions: [], receipts: [], outcomes: m.id === "mission" ? [report(), report(2)] : [],
  audit: m.id === "mission" ? [audit(), audit(7)] : [] });
const available = value => ({ status: "available", value }), unavailable = { status: "unavailable" };
const combined = () => ({ sources: available([structuredClone(detection)]), recommendations: available(history()),
  missions: available({ total: 7, items: [{ mission: mission(), data: available(missionData(mission())) }, { mission: mission("failed"), data: unavailable }] }) });
function library(options = {}) {
  const calls = [], activities = [], missions = options.missions ?? [mission()]; let missionReads = 0;
  const api = async (url, init) => {
    calls.push({ url, init }); assert.equal(init.method, undefined); assert.ok(init.signal);
    if (url.endsWith("/detections")) { if (options.sourceError) throw new Error("private"); return options.detections ?? [structuredClone(detection)]; }
    if (url === "pipeline/history") { if (options.pipelineError) throw new Error("private"); return options.history ?? history(); }
    if (url === "missions") return missions;
    if (url.startsWith("pipeline/")) return options.run;
    if (url === "accounts/account") return options.fresh ?? view;
    if (url.endsWith("/coaching-reviews")) return [];
    if (url.startsWith("missions/")) { ++missionReads; const found = missions.find(x => url === `missions/${x.id}`);
      return options.finalMissionChanged && missionReads > missions.slice(0, 5).length ? { ...found, revision: 99 } : found; }
    throw new Error(`Unexpected GET ${url}`);
  };
  return { calls, activities, lib: load("../lib/account-timeline.ts", { "./api": { api }, "./workflow": {
    readMission: async (id, signal) => { activities.push({ id, signal }); if (options.failMission === id) throw new Error("private");
      const data = structuredClone(missionData(missions.find(x => x.id === id))); options.corrupt?.(data); return data; },
  } }) };
}

test("combined chronology orders semantic source/run/audit/report instants exactly, preserves identities and corrections without mutation", () => {
  const { lib } = library(), value = combined(), before = JSON.stringify(value);
  const source = value.sources.value[0]; source.detected_at = "2027-01-01T00:00:00Z";
  value.missions.value.items[0].data.value.outcomes[0].observed_at = "undated";
  const snapshot = JSON.stringify(value), events = lib.timelineEvents(value, "account");
  assert.deepEqual(events.dated.map(x => x.key), [`recommendation:${runId}:account`, "source:detection", "audit:audit7", "audit:audit1", "report:report2"]);
  assert.equal(events.undated[0].key, "report:report1"); assert.equal(events.dated[1].at, detection.after.selected_at);
  assert.equal(events.dated.at(-1).record.supersedes_id, "report1"); assert.equal(JSON.stringify(value), snapshot); assert.notEqual(before, snapshot);
  value.recommendations.value.items[0].input_account_ids = ["other"];
  assert.ok(!lib.timelineEvents(value, "account").dated.some(x => x.kind === "recommendation"));
  value.sources.value.push(source); assert.throws(() => lib.timelineEvents(value, "account"), /Duplicate timeline identity/);
});

test("reader reuses scoped GETs, retains original records and bounds mission inspection to newest five account missions", async () => {
  const missions = [mission("other") , ...Array.from({ length: 7 }, (_, i) => mission(`m${i}`))]; missions[0].account_id = "outside";
  const app = library({ missions, failMission: "m2" }), signal = new AbortController().signal;
  const value = await app.lib.readAccountTimeline(view, signal);
  assert.equal(value.sources.status, "available"); assert.equal(value.recommendations.value.undated_count, 2);
  assert.equal(value.missions.value.total, 7); assert.equal(value.missions.value.items.length, 5);
  assert.deepEqual(app.activities.map(x => x.id), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(value.missions.value.items[2].data.status, "unavailable"); assert.ok(app.calls.every(x => x.init.signal === signal));
});

test("independent failed/crossed streams remain unavailable while valid histories survive; final account mismatch hides everything", async () => {
  for (const options of [{ sourceError: true }, { detections: [{ ...detection, account_id: "other" }] }]) {
    const { lib } = library(options), value = await lib.readAccountTimeline(view, new AbortController().signal);
    assert.equal(value.sources.status, "unavailable"); assert.equal(value.recommendations.status, "available"); assert.equal(value.missions.status, "available");
  }
  for (const options of [{ pipelineError: true }, { history: { ...history(), organization_id: "other" } }]) {
    const { lib } = library(options), value = await lib.readAccountTimeline(view, new AbortController().signal);
    assert.equal(value.recommendations.status, "unavailable"); assert.equal(value.sources.status, "available");
  }
  for (const fresh of [{ ...view, account: { ...view.account, revision: 6 } }, { ...view, source: { id: "changed" } },
    { ...view, assessment: { ...view.assessment, as_of: "2026-10-27" } }, { ...view, account: { ...view.account, organization_id: "foreign" } }]) {
    await assert.rejects(library({ fresh }).lib.readAccountTimeline(view, new AbortController().signal), /snapshot changed/);
  }
});

test("mission current revision and historical correlation checks preserve unavailable activity without stale audit/report events", async () => {
  for (const options of [{ finalMissionChanged: true }, { corrupt(data) { data.audit[0].correlation_id = "wrong"; } },
    { corrupt(data) { data.outcomes[1].supersedes_id = "wrong"; } }]) {
    const { lib } = library(options), value = await lib.readAccountTimeline(view, new AbortController().signal);
    assert.equal(value.missions.value.items[0].data.status, "unavailable");
    assert.ok(lib.timelineEvents(value, "account").dated.every(x => ["source", "recommendation"].includes(x.kind)));
  }
  const options = { missions: [{ ...mission(), organization_id: "foreign" }] };
  assert.equal((await library(options).lib.readAccountTimeline(view, new AbortController().signal)).missions.status, "unavailable");
});

test("exact recommendation inspection binds listed summary, saved input membership and final current account", async () => {
  const run = { ...summary, organization_id: "org", contexts: [{ account: { ...view.account, annual_value: null, renewal_date: null }, evidence: [] }], recommendations: [] };
  for (const [value, fresh, ok] of [[run, view, true], [{ ...run, id: "wrong" }, view, false],
    [{ ...run, contexts: [] }, view, false], [run, { ...view, account: { ...view.account, revision: 6 } }, false]]) {
    const { lib, calls } = library({ run: value, fresh }); const read = lib.readTimelineRecommendation(view, summary, new AbortController().signal);
    if (ok) { assert.deepEqual(await read, run); assert.deepEqual(calls.map(x => x.url), [`pipeline/${runId}`, "accounts/account"]); }
    else await assert.rejects(read);
  }
});

const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function setup(t) {
  const slots = [], cleanups = [], reads = [], details = [], listeners = new Map(); let cursor = 0, effects = [], props = { view }, unmounted = false;
  let session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } };
  const previous = globalThis.window, surface = { addEventListener(n, fn) { listeners.set(n, fn); }, removeEventListener(n) { listeners.delete(n); } };
  globalThis.window = surface;
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { ...React, useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const helper = library().lib;
  const SourceSnapshot = ({ snapshot, label }) => React.createElement("p", null, `${label}: ${JSON.stringify(snapshot)}`);
  const Comparison = () => null;
  const component = load("../components/account-timeline.tsx", { react: hooks, "next/link": { __esModule: true, default: p => React.createElement("a", p) },
    "./session-gate": { useSession: () => session }, "./account-chronology": { SourceSnapshot }, "./pipeline-panel": { SavedRunComparison: Comparison },
    "@/lib/account-timeline": { timelineEvents: helper.timelineEvents,
      readAccountTimeline: (view, signal) => new Promise((resolve, reject) => reads.push({ view, signal, resolve, reject })),
      readTimelineRecommendation: (view, summary, signal) => new Promise((resolve, reject) => details.push({ view, summary, signal, resolve, reject })) } });
  const outer = () => component.AccountTimeline(props);
  const render = () => { cursor = 0; const node = outer(), tree = typeof node?.type === "function" ? node.type(node.props) : node;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = text => walk(render()).find(x => x.type === "button" && (Array.isArray(x.props.children) ? x.props.children.join("") : x.props.children) === text);
  const unmount = () => { if (unmounted) return; unmounted = true; const prior = globalThis.window; globalThis.window = surface;
    try { cleanups.forEach(fn => fn?.()); } finally { globalThis.window = prior; } };
  t.after(() => { unmount(); globalThis.window = previous; });
  return { reads, details, render, outer, button, unmount, Comparison, setView(v) { props = { view: v }; }, setSession(v) { session = v; },
    emit(n) { listeners.get(n)?.(); }, async inspect(value = combined()) { const p = button("Inspect combined history").props.onClick(); reads.shift().resolve(value); await p; } };
}

test("combined UI discloses independent coverage and exact correlated drilldown, preserves Unknowns and escapes saved text", async t => {
  const app = setup(t); app.render(); assert.equal(app.reads.length, 0); await app.inspect();
  const html = renderToStaticMarkup(app.render());
  for (const text of ["Older records may exist", "2 unorderable", "19 unreadable", "Older dated organization runs exist", "Account membership of omitted", "newest 2 of 7", "5 older missions excluded",
    "activity unavailable", "not newest activity", "UTC microseconds", "not one transactional snapshot", "corrects report1", "correlation:mission", "Outside selected result"]) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;Retained note/); assert.doesNotMatch(html, /<script>/);
  const links = walk(app.render()).filter(x => x.props?.href).map(x => new URL(x.props.href, "http://localhost"));
  assert.ok(links.length > 0); assert.ok(links.every(x => x.searchParams.get("account") === "account" && x.searchParams.get("mission") === "mission"));
  const p = app.button(`Inspect recommendation ${runId}`).props.onClick(), detail = app.details.shift();
  assert.equal(detail.summary.id, runId); detail.resolve({ ...summary, contexts: [{ account: { ...view.account, annual_value: null, renewal_date: null }, evidence: [] }], recommendations: [] }); await p;
  assert.match(renderToStaticMarkup(app.render()), /Annual value Unknown/);
  const comparator = walk(app.render()).find(x => x.type === app.Comparison); assert.equal(comparator.key, runId); assert.equal(comparator.props.accountId, "account");
});

test("duplicate/captured and late timeline/detail callbacks cannot publish after refresh, scope change or unmount", async t => {
  const app = setup(t); app.render(); const captured = app.button("Inspect combined history").props.onClick;
  const p = captured(); await captured(); assert.equal(app.reads.length, 1); const old = app.reads.shift(); app.emit("focus"); old.resolve(combined()); await p;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Retained note/);
  await app.inspect(); const stale = app.button(`Inspect recommendation ${runId}`).props.onClick;
  for (const name of ["vitaai-source-changed", "vitaai-source-history-changed", "vitaai-detections-changed", "vitaai-workflow-changed", "vitaai-pipeline-history-changed"]) {
    app.emit(name); await stale(); assert.equal(app.details.length, 0); await app.inspect();
  }
  const d = app.button(`Inspect recommendation ${runId}`).props.onClick(); const obsolete = app.details.shift(); app.emit("focus"); obsolete.resolve({ contexts: [], recommendations: [] }); await d;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Saved recommendation/);
  const key = app.outer().key;
  for (const next of [{ ...view, account: { ...view.account, id: "other" } }, { ...view, account: { ...view.account, revision: 6 } },
    { ...view, source: { id: "other" } }, { ...view, assessment: { ...view.assessment, as_of: "2026-10-27" } },
    { ...view, assessment: { ...view.assessment, snapshot_hash: "other" } }]) { app.setView(next); assert.notEqual(app.outer().key, key); }
  app.setView(view); app.setSession({ mode: "session", actor: { id: "other", organization_id: "org", role: "admin" } }); assert.notEqual(app.outer().key, key);
  const last = captured(); const pending = app.reads.shift(); app.unmount(); await captured(); pending.resolve(combined()); await last;
  assert.equal(pending.signal.aborted, true); assert.equal(app.reads.length, 0);
});

test("empty/unavailable and session states never infer unchanged facts, completion or a complete account history", async t => {
  const app = setup(t);
  for (const session of [null, { mode: "sample" }, { mode: "session", actor: { organization_id: "foreign" } }]) {
    app.setSession(session); assert.match(renderToStaticMarkup(app.render()), /Session identity/); assert.equal(app.reads.length, 0);
  }
  app.setSession({ mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } }); app.render();
  await app.inspect({ sources: unavailable, recommendations: unavailable, missions: unavailable });
  const html = renderToStaticMarkup(app.render()); assert.match(html, /Source history unavailable/); assert.match(html, /Mission history unavailable/);
  assert.match(html, /Recommendation history unavailable/); assert.match(html, /does not establish an empty or unchanged/);
  const p = app.button("Inspect combined history").props.onClick(); app.reads.shift().reject(new Error("private details")); await p;
  assert.match(renderToStaticMarkup(app.render()), /unavailable or changed/); assert.doesNotMatch(renderToStaticMarkup(app.render()), /private details/);
});
