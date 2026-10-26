import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const filename = fileURLToPath(new URL("../components/manager-reports.tsx", import.meta.url));
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const mission = { id: "mission", organization_id: "org", account_id: "account", owner_id: "owner", revision: 8, status: "completed" };
const outcome = { id: "report", mission_id: "mission", organization_id: "org", revision: 1, supersedes_id: null,
  observer_id: "observer", observed_at: "2026-10-23T09:00:00Z", report: { kind: "follow_up_required", basis: "manual_report",
    manual_action_reference: "manual:synthetic-review", receipt_id: null, evidence_ids: ["fact"], note: "<script>Original report</script>" } };
const correction = { ...outcome, id: "correction", revision: 2, supersedes_id: "report", observed_at: "2026-10-23T11:00:00Z" };
const review = { id: "review", organization_id: "org", mission_id: "mission", revision: 1, supersedes_id: null,
  outcome_id: "report", outcome_revision: 1, mission_revision: 7, status: "revision_required", reviewer_id: "reviewer",
  created_at: "2026-10-23T10:00:00Z", note: "Human coaching" };
function setup(actor = { id: "actor", organization_id: "org", role: "viewer" }, selected = mission) {
  const states = [], refs = [], cleanups = [], requests = []; let s = 0, r = 0, e = 0;
  const hooks = {
    useState(initial) { const i = s++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = value; }]; },
    useRef(initial) { const i = r++; return refs[i] ??= { current: initial }; },
    useEffect(fn) { const i = e++; if (!(i in cleanups)) cleanups[i] = fn(); },
  };
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  const api = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const helperFile = fileURLToPath(new URL("../lib/manager-reports.ts", import.meta.url)), helper = new Module(helperFile);
  helper.require = name => name === "./api" ? { api } : normal(name);
  helper._compile(ts.transpileModule(readFileSync(helperFile, "utf8"), { fileName: helperFile, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, helperFile);
  target.require = name => name === "react" ? hooks : name === "@/lib/manager-reports" ? helper.exports
    : name === "./session-gate" ? { useSession: () => ({ actor }) } : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename);
  const render = () => { s = r = e = 0; const outer = target.exports.ManagerReports({ mission: selected }); return outer ? outer.type(outer.props) : null; };
  return { requests, render, unmount() { cleanups.forEach(fn => fn?.()); },
    inspect() { return walk(render()).find(n => n.type === "button").props.onClick(); } };
}
async function finish(app, pending, reports = [outcome, correction], reviews = [review], fresh = mission) {
  const [first, second] = app.requests.splice(0);
  assert.equal(first.url, "missions/mission/outcomes"); assert.equal(second.url, "missions/mission/coaching-reviews");
  first.resolve(reports); second.resolve(reviews); await flush();
  const last = app.requests.shift(); assert.equal(last.url, "missions/mission"); last.resolve(fresh); await pending;
}

test("manager explicitly inspects immutable outcome corrections and historical coaching with exact provenance", async () => {
  const app = setup(); app.render(); assert.equal(app.requests.length, 0);
  const captured = walk(app.render()).find(n => n.type === "button").props.onClick;
  const pending = captured(); await captured(); assert.equal(app.requests.length, 2);
  assert.ok(app.requests.every(r => r.init.method === undefined && r.init.signal));
  await finish(app, pending);
  const html = renderToStaticMarkup(app.render());
  for (const text of [/manual report/, /observer/, /2026-10-23T09:00:00Z/, /manual:synthetic-review/, /fact/,
    /Latest report revision 2/, /Historical coaching for an earlier report/, /No coaching review of the latest report/,
    /reviewer/, /revision required/, /not independently verified customer results/]) assert.match(html, text);
  assert.match(html, /&lt;script&gt;Original report&lt;\/script&gt;/); assert.doesNotMatch(html, /<script>/);
  assert.equal(walk(app.render()).filter(n => n.type === "form").length, 0);
  const refreshing = app.inspect();
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Original report/);
  app.requests[0].reject(new Error("read failed")); app.requests[1].resolve([]); await refreshing;
  assert.match(renderToStaticMarkup(app.render()), /Refresh mission attention/);
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Original report/);
  app.unmount();
});

test("manager rejects crossed, duplicated, inconsistent and concurrently corrected report snapshots", async () => {
  for (const corrupt of [
    value => { value.reports[0].organization_id = "foreign"; },
    value => { value.reports[0].mission_id = "foreign"; },
    value => { value.reports[1].id = "report"; },
    value => { value.reports[1].supersedes_id = "missing"; },
    value => { value.reviews[0].outcome_revision = 2; },
    value => { value.reviews[0].mission_id = "foreign"; },
    value => { value.fresh.revision++; }, value => { value.fresh.owner_id = "foreign"; },
    value => { value.fresh.status = "executing"; }, value => { value.fresh.account_id = "foreign"; },
  ]) {
    const app = setup(), value = structuredClone({ reports: [outcome, correction], reviews: [review], fresh: mission });
    corrupt(value); const pending = app.inspect(); await finish(app, pending, value.reports, value.reviews, value.fresh);
    const html = renderToStaticMarkup(app.render());
    assert.match(html, /Refresh mission attention/); assert.doesNotMatch(html, /Original report|Human coaching/); app.unmount();
  }
});

test("scope, lifecycle and unmount prevent private reads and captured or obsolete inspection results", async () => {
  for (const [actor, selected] of [[null, mission], [{ organization_id: "foreign" }, mission],
    [{ organization_id: "org" }, { ...mission, status: "reconciliation_required" }]]) {
    const app = setup(actor, selected); assert.equal(app.render(), null); assert.equal(app.requests.length, 0);
  }
  const app = setup(), captured = walk(app.render()).find(n => n.type === "button").props.onClick;
  const pending = captured(); app.unmount(); await captured(); assert.equal(app.requests.length, 2);
  assert.ok(app.requests.every(r => r.init.signal.aborted));
  app.requests.splice(0).forEach((request, i) => request.resolve(i ? [review] : [outcome, correction])); await pending;
  assert.equal(app.requests.length, 0); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Original report|Human coaching/);
});

test("empty retained reports and absent coaching are explicit without claiming customer success", async () => {
  const app = setup(), pending = app.inspect(); await finish(app, pending, [], []);
  const html = renderToStaticMarkup(app.render()); assert.match(html, /No retained outcome reports/);
  assert.match(html, /No coaching reviews/); assert.doesNotMatch(html, /Latest report|customer contacted/); app.unmount();
});
