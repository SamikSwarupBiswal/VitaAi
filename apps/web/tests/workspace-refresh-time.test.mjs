import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const data = revision => ({ organization_id: "org", mode: "local_sample", as_of: "2026-10-20", annual_value: 0,
  accounts: [{ account: { id: "account", organization_id: "org", revision, name: "Account", annual_value: 0, renewal_date: null, synthetic: true },
    assessment: { as_of: "2026-10-20", snapshot_hash: `snapshot-${revision}`, risk: 0, opportunity: 0, confidence: 0, caveats: [], factors: [], recommendation: "Inspect evidence" },
    evidence: [{ id: "source", account_id: "account", organization_id: "org", source: "CRM", source_record: "record", fact: "Original observation", observed_at: "2026-10-15T00:00:00Z" }] }] });

function setup(t) {
  const previous = { window: globalThis.window, document: globalThis.document, Date: globalThis.Date }, requests = [], slots = [], cleanups = [], listeners = new Map();
  let cursor = 0, effects = [], clock = "2026-10-27T01:00:00Z", persona = "executive";
  class Clock extends previous.Date { constructor(...args) { super(...(args.length ? args : [clock])); } }
  globalThis.Date = Clock;
  globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  globalThis.document = { documentElement: { dataset: {} } };
  const memo = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((value, index) => value !== slots[i].deps[index])) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const hooks = { ...React,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn, deps) { return memo(() => fn, deps); }, useMemo: memo,
    useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((value, index) => value !== slots[i][index])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  const filename = fileURLToPath(new URL("../components/workspace.tsx", import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  const children = Object.fromEntries(["AccountTable", "AccountDetail", "PipelinePanel", "HubSpotPanel", "ResearchPanel", "ComparisonPanel", "SourceDetectionPanel", "HubSpotIngestionPanel", "HubSpotRefreshPanel", "OperationsReadiness", "OperationsReceipts", "ManagerCoachingQueue", "ManagerReports", "WorkspaceGuide", "ExecutiveChangeBrief"].map(name => [name, () => null]));
  const mocks = { react: hooks, "next/navigation": { useRouter: () => ({ replace() {} }), useSearchParams: () => new URLSearchParams({ account: "account" }) },
    "next/link": { __esModule: true, default: props => React.createElement("a", props) }, "./session-gate": {},
    "@/lib/api": { currency: String, api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    ...Object.fromEntries(["account-detail", "account-table", "pipeline-panel", "hubspot-panel", "research-panel", "comparison-panel", "source-detection-panel", "hubspot-ingestion-panel", "hubspot-refresh-panel", "operations-readiness", "operations-receipts", "manager-coaching-queue", "manager-reports", "workspace-guide", "executive-change-brief"].map(name => ["./" + name, children])) };
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText + "\nexports.content = WorkspaceContent; exports.brief = PortfolioBriefing;", filename);
  const render = () => { cursor = 0; const tree = target.exports.content({ accountDirectory: false, persona });
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const brief = () => walk(render()).find(node => node.type === target.exports.brief);
  const html = () => { const node = brief(); return node ? renderToStaticMarkup(node.type(node.props)) : ""; };
  let unmounted = false;
  const unmount = () => { if (unmounted) return; unmounted = true; cleanups.forEach(fn => fn?.()); };
  t.after(() => { unmount(); globalThis.window = previous.window; globalThis.document = previous.document; globalThis.Date = previous.Date; });
  return { requests, render, brief, html, unmount, clock(value) { clock = value; }, persona(value) { persona = value; },
    refresh: () => walk(render()).find(node => node.props?.["aria-label"] === "Refresh portfolio").props.onClick(),
    invalidate: () => listeners.get("vitaai-source-changed")(),
    async reply(batch, value = data(1)) { assert.deepEqual(batch.map(item => item.url), ["portfolio", "providers/nebius"]);
      assert.ok(batch.every(item => !item.init.method && item.init.signal)); batch[0].resolve(value); batch[1].resolve({ configured: false }); await flush(); },
  };
}

test("Executive and Seller briefings show successful local read completion separately from unchanged source/assessment dates", async t => {
  const app = setup(t), original = data(1), before = JSON.stringify(original); app.render(); assert.equal(app.brief(), undefined);
  await app.reply(app.requests.splice(0), original);
  for (const persona of ["executive", "seller"]) {
    app.persona(persona); const html = app.html();
    assert.match(html, /Local portfolio read completed <time dateTime="2026-10-27T01:00:00\.000Z">2026-10-27T01:00:00\.000Z<\/time>/i);
    assert.match(html, /Assessment date 2026-10-20/); assert.match(html, /2026-10-15T00:00:00Z/);
    assert.match(html, /Source observation and model run times remain separate/);
  }
  assert.equal(JSON.stringify(original), before); assert.equal(app.requests.length, 0);
});

test("pending/failed refresh clears prior completion and obsolete responses cannot replace the current read time", async t => {
  const app = setup(t); app.render(); await app.reply(app.requests.splice(0));
  const captured = walk(app.render()).find(node => node.props?.["aria-label"] === "Refresh portfolio").props.onClick;
  captured(); const obsolete = app.requests.splice(0);
  assert.equal(app.brief().props.readAt, null); assert.doesNotMatch(app.html(), /Local portfolio read completed/); assert.match(app.html(), /Briefing paused/);
  captured(); const latest = app.requests.splice(0); assert.ok(obsolete.every(item => item.init.signal.aborted));
  app.clock("2026-10-27T02:00:00Z"); await app.reply(latest, data(2)); assert.equal(app.brief().props.readAt, "2026-10-27T02:00:00.000Z");
  app.clock("2026-10-27T03:00:00Z"); await app.reply(obsolete, data(0));
  assert.equal(app.brief().props.readAt, "2026-10-27T02:00:00.000Z"); assert.equal(app.brief().props.portfolio.accounts[0].account.revision, 2);
  app.refresh(); const failed = app.requests.splice(0); failed[0].reject(new Error("Read unavailable")); failed[1].resolve({ configured: false }); await flush();
  assert.equal(app.brief().props.readAt, null); assert.match(app.html(), /Briefing paused/); assert.doesNotMatch(app.html(), /02:00:00/);
  app.refresh(); app.clock("2026-10-27T04:00:00Z"); await app.reply(app.requests.splice(0), data(3));
  assert.equal(app.brief().props.readAt, "2026-10-27T04:00:00.000Z"); assert.match(app.html(), /Local portfolio read completed/);
});

test("source invalidation and unmount abort pending reads and cannot restore a prior completion time", async t => {
  const app = setup(t); app.render(); await app.reply(app.requests.splice(0));
  app.refresh(); const obsolete = app.requests.splice(0); app.invalidate(); const current = app.requests.splice(0);
  assert.ok(obsolete.every(item => item.init.signal.aborted)); assert.equal(app.brief().props.readAt, null); assert.match(app.html(), /Briefing paused/);
  app.clock("2026-10-27T05:00:00Z"); await app.reply(obsolete); assert.equal(app.brief().props.readAt, null);
  app.unmount(); assert.ok(current.every(item => item.init.signal.aborted)); await app.reply(current);
  assert.equal(app.brief().props.readAt, null); assert.doesNotMatch(app.html(), /Local portfolio read completed/); assert.equal(app.requests.length, 0);
});
