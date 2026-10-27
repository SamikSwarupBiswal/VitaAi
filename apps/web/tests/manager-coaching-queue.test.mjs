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
const portfolio = { organization_id: "org", as_of: "2026-10-26", accounts: [{ account: { id: "account", organization_id: "org", revision: 2, name: "<script>Account</script>" }, source: { id: "source" }, assessment: { snapshot_hash: "hash" } }] };
const mission = (id = "mission") => ({ id, account_id: "account", organization_id: "org", owner_id: "owner", revision: 8, status: "completed", created_at: "2026-10-20T00:00:00Z" });
const report = (n = 1, id = "mission") => ({ id: `${id}-report${n}`, mission_id: id, organization_id: "org", revision: n, supersedes_id: n === 1 ? null : `${id}-report${n-1}`,
  observed_at: "2026-10-25T00:00:00Z", report: { kind: "follow_up_required", basis: "manual_report", evidence_ids: [], note: "Original" } });
const review = (n = 1, reportN = 1, id = "mission") => ({ id: `${id}-review${n}`, mission_id: id, organization_id: "org", revision: n,
  supersedes_id: n === 1 ? null : `${id}-review${n-1}`, outcome_id: `${id}-report${reportN}`, outcome_revision: reportN,
  mission_revision: 7, status: "reviewed", reviewer_id: "reviewer", created_at: "2026-10-25T01:00:00Z" });
const data = (id = "mission") => ({ outcomes: [report(1, id), report(2, id)], reviews: [review(1, 1, id)] });
function library(options = {}) {
  const requests = [], reads = new Map();
  const api = async (url, init) => {
    requests.push({ url, init }); assert.equal(init.method, undefined); assert.ok(init.signal);
    const id = url.split("/")[1], saved = options.records?.[id] ?? data(id);
    if (id === options.fail) throw new Error("private body");
    if (url.endsWith("/outcomes")) return saved.outcomes;
    if (url.endsWith("/coaching-reviews")) return saved.reviews;
    const count = (reads.get(id) || 0) + 1; reads.set(id, count);
    return options.changed === id && count > 1 ? { ...mission(id), revision: 9 } : options.fresh ?? mission(id);
  };
  return { requests, helper: load("../lib/manager-reports.ts", { "./api": { api } }) };
}

test("coaching disposition follows latest saved report and latest review, retaining correction and superseding history", () => {
  const { helper } = library(), value = data(), original = JSON.stringify(value);
  assert.equal(helper.coachingDisposition({ outcomes: [], reviews: [] }), "no_report");
  assert.equal(helper.coachingDisposition({ outcomes: [report()], reviews: [] }), "no_review");
  assert.equal(helper.coachingDisposition(value), "report_changed");
  value.reviews.push(review(2, 2)); assert.equal(helper.coachingDisposition(value), "reviewed");
  value.reviews.push({ ...review(3, 2), status: "revision_required" }); assert.equal(helper.coachingDisposition(value), "revision_required");
  assert.equal(original, JSON.stringify(data())); assert.equal(value.reviews[0].outcome_id, report().id);
});

test("queue inspects at most five completed current-portfolio missions in retained order with separate older/unavailable coverage", async () => {
  const missions = [mission("uncompleted"), mission("outside"), ...Array.from({ length: 7 }, (_, i) => mission(`m${i}`))];
  missions[0].status = "rejected"; missions[1].account_id = "other";
  const app = library({ fail: "m1", changed: "m2" }), original = JSON.stringify(missions);
  const result = await app.helper.readCoachingQueue(portfolio, missions, new AbortController().signal);
  assert.equal(result.total, 7); assert.deepEqual(result.rows.map(x => x.mission.id), ["m0", "m1", "m2", "m3", "m4"]);
  assert.equal(result.rows[1].data, null); assert.equal(result.rows[2].data, null); assert.ok(result.rows[0].data);
  assert.ok(app.requests.every(x => !/m[56]|outside|uncompleted/.test(x.url))); assert.equal(JSON.stringify(missions), original);
});

test("crossed lists and malformed report/review chains cannot become a valid latest coaching disposition", async () => {
  for (const missions of [[mission(), mission()], [{ ...mission(), organization_id: "other" }]]) {
    await assert.rejects(library().helper.readCoachingQueue(portfolio, missions, new AbortController().signal), /list changed/);
  }
  for (const corrupt of [x => { x.outcomes[1].supersedes_id = "wrong"; }, x => { x.reviews[0].outcome_revision = 2; },
    x => { x.outcomes[0].organization_id = "foreign"; }, x => { x.reviews[0].mission_id = "foreign"; },
    x => { x.reviews[0].mission_revision = 99; }, x => { x.outcomes[1].id = x.outcomes[0].id; }]) {
    const value = data(); corrupt(value); const app = library({ records: { mission: value } });
    const result = await app.helper.readCoachingQueue(portfolio, [mission()], new AbortController().signal);
    assert.equal(result.rows[0].data, null);
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(library().helper.readCoachingQueue(portfolio, [mission()], controller.signal), /Inspection ended/);
});

const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function setup(t) {
  const slots = [], cleanups = [], requests = [], listeners = new Map(); let cursor = 0, effects = [], props = { portfolio, missions: [mission()] }, unmounted = false;
  let session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } };
  const previous = globalThis.window, surface = { addEventListener(n, fn) { listeners.set(n, fn); }, removeEventListener(n) { listeners.delete(n); } };
  globalThis.window = surface;
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
    slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { ...React, useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === "function" ? v(slots[i]) : v; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const component = load("../components/manager-coaching-queue.tsx", { react: hooks, "next/link": { __esModule: true, default: p => React.createElement("a", p) },
    "./session-gate": { useSession: () => session }, "@/lib/manager-reports": { coachingDisposition: library().helper.coachingDisposition,
      readCoachingQueue: (portfolio, missions, signal) => new Promise((resolve, reject) => requests.push({ portfolio, missions, signal, resolve, reject })) } });
  const outer = () => component.ManagerCoachingQueue(props);
  const render = () => { cursor = 0; const node = outer(), tree = node ? node.type(node.props) : null;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const button = () => walk(render()).find(x => x.type === "button");
  const unmount = () => { if (unmounted) return; unmounted = true; cleanups.forEach(fn => fn?.()); };
  t.after(() => { unmount(); globalThis.window = previous; });
  return { requests, render, outer, button, unmount, setProps(value) { props = { ...props, ...value }; }, setSession(v) { session = v; }, emit(n) { listeners.get(n)?.(); },
    async inspect(result) { const p = button().props.onClick(); requests.shift().resolve(result); await p; } };
}

test("manager queue discloses report/review dispositions, owner scope and omissions with exact Outcome links and no writes", async t => {
  const app = setup(t); app.render(); assert.equal(app.requests.length, 0);
  const variants = [{ outcomes: [], reviews: [] }, { outcomes: [report()], reviews: [] }, data(),
    { outcomes: [report()], reviews: [review()] }, { outcomes: [report()], reviews: [{ ...review(), status: "revision_required" }] }];
  const rows = variants.map((value, i) => ({ mission: mission(`m${i}`), data: value }));
  await app.inspect({ total: 9, rows }); const html = renderToStaticMarkup(app.render());
  for (const text of ["No retained outcome report", "Latest report has no coaching review", "Latest report changed since coaching", "Latest report reviewed",
    "Coaching revision requested", "Inspected 5 of 9", "4 older missions excluded", "0 inspected missions unavailable", "not a complete team", "not a verified seller directory", "Corrects report", "never reopen missions"]) assert.ok(html.includes(text), text);
  assert.match(html, /&lt;script&gt;Account/); assert.doesNotMatch(html, /<script>/);
  const links = walk(app.render()).filter(x => x.props?.href).map(x => new URL(x.props.href, "http://localhost"));
  assert.equal(links.length, 5); links.forEach((url, i) => { assert.equal(url.searchParams.get("account"), "account"); assert.equal(url.searchParams.get("mission"), `m${i}`); assert.equal(url.searchParams.get("step"), "Outcome"); });
  assert.equal(walk(app.render()).filter(x => x.type === "form").length, 0);
  await app.inspect({ total: 1, rows: [{ mission: mission(), data: null }] });
  assert.match(renderToStaticMarkup(app.render()), /1 inspected missions unavailable/);
  assert.match(renderToStaticMarkup(app.render()), /No review disposition inferred/);
});

test("focus/workflow/source invalidation, duplicate and captured unmounted reads cannot publish obsolete queue results", async t => {
  const app = setup(t); app.render(); const handler = app.button().props.onClick;
  const old = handler(); await handler(); assert.equal(app.requests.length, 1); const request = app.requests.shift(); app.emit("focus");
  request.resolve({ total: 1, rows: [{ mission: mission(), data: data() }] }); await old;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Latest report changed/);
  for (const name of ["focus", "vitaai-workflow-changed", "vitaai-source-changed"]) {
    await app.inspect({ total: 1, rows: [{ mission: mission(), data: data() }] }); app.emit(name);
    assert.doesNotMatch(renderToStaticMarkup(app.render()), /Latest report changed/); assert.equal(app.requests.length, 0);
  }
  const last = handler(), pending = app.requests.shift(); app.unmount(); await handler(); pending.resolve({ total: 0, rows: [] }); await last;
  assert.equal(pending.signal.aborted, true); assert.equal(app.requests.length, 0);
});

test("actor, portfolio and mission identity keys remount the queue; session and error/empty states stay explicit", async t => {
  const app = setup(t), key = app.outer().key;
  for (const value of [{ portfolio: { ...portfolio, as_of: "2026-10-27" } }, { missions: [{ ...mission(), revision: 9 }] },
    { missions: [{ ...mission(), owner_id: "other" }] }, { portfolio: { ...portfolio, accounts: [{ ...portfolio.accounts[0], source: { id: "other" } }] } }]) {
    app.setProps(value); assert.notEqual(app.outer().key, key); app.setProps({ portfolio, missions: [mission()] });
  }
  app.setSession({ mode: "session", actor: { id: "actor", organization_id: "org", role: "admin" } }); assert.notEqual(app.outer().key, key);
  for (const session of [null, { mode: "sample" }, { mode: "session", actor: { organization_id: "foreign" } }]) { app.setSession(session); assert.equal(app.render(), null); assert.equal(app.requests.length, 0); }
  app.setSession({ mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } });
  await app.inspect({ total: 0, rows: [] }); assert.match(renderToStaticMarkup(app.render()), /No completed missions/);
  const p = app.button().props.onClick(); app.requests.shift().reject(new Error("private details")); await p;
  assert.match(renderToStaticMarkup(app.render()), /queue unavailable or changed/); assert.doesNotMatch(renderToStaticMarkup(app.render()), /private details/);
});

test("coaching queue shows retained plans as planned or historical and rejects crossed recorded owners", async t => {
  const plan = { focus: "Evidence review", discussion: "Discuss original report", practice: "Explain unknowns", follow_up: "Internal review" };
  const historical = { ...review(1, 1), intervention: plan, intervention_owner_id: "owner" };
  const current = { ...review(2, 2), intervention: plan, intervention_owner_id: "owner" };
  const app = setup(t);
  await app.inspect({ total: 2, rows: [{ mission: mission(), data: { outcomes: [report(), report(2)], reviews: [historical] } },
    { mission: mission("second"), data: { outcomes: [report(), report(2)], reviews: [historical, current] } }] });
  const html = renderToStaticMarkup(app.render());
  assert.match(html, /Historical internal coaching plan; report changed/); assert.match(html, /Planned internal coaching intervention/);
  assert.match(html, /recorded owner owner/); assert.match(html, /no notification or recipient acceptance/);
  const valid = library({ records: { mission: { outcomes: [report(), report(2)], reviews: [historical, current] } } });
  assert.ok((await valid.helper.readCoachingQueue(portfolio, [mission()], new AbortController().signal)).rows[0].data);
  const crossed = library({ records: { mission: { outcomes: [report(), report(2)], reviews: [{ ...historical, intervention_owner_id: "other" }] } } });
  assert.equal((await crossed.helper.readCoachingQueue(portfolio, [mission()], new AbortController().signal)).rows[0].data, null);
});
