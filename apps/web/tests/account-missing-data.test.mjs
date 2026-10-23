import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");

function load(relative, mocks = {}, extra = "") {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = new Module(filename);
  target.filename = filename;
  target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(compiled + extra, filename);
  return target.exports;
}

const api = load("../lib/api.ts");
const table = load("../components/account-table.tsx", { "@/lib/api": api });
const detail = load("../components/account-detail.tsx");
const view = (id, value, renewal) => ({
  account: { id, name: id, industry: "Test", annual_value: value, revision: 1 }, renewal_days: renewal,
  assessment: { health: 100, risk: 0, opportunity: 0, confidence: 75, caveats: [], factors: [],
    recommendation: "Review missing data", snapshot_hash: id }, evidence: [], latest_run: null,
});

function briefingWorkspace(hooks = {}, navigation = {}) {
  return load("../components/workspace.tsx", {
    react: hooks, "next/navigation": navigation, "next/link": { __esModule: true, default: ({ children }) => children },
    "@/lib/api": api, "./account-table": table, "./account-detail": detail,
    ...Object.fromEntries(["pipeline-panel", "session-gate", "hubspot-panel", "research-panel", "comparison-panel",
      "source-detection-panel", "hubspot-ingestion-panel", "hubspot-refresh-panel"].map(name => ["./" + name, {}])),
  }, "\nexports.briefForAcceptance = PortfolioBriefing; exports.contentForAcceptance = WorkspaceContent;");
}
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object"
  ? [node, ...walk(node.props?.children)] : [];

test("brief preserves server order, snapshot evidence, caveats and Unknowns without mutating input", () => {
  const workspace = briefingWorkspace(), accounts = Array.from({ length: 6 }, (_, i) => {
    const item = view(`Account ${i}`, null, null);
    return { ...item, account: { ...item.account, organization_id: "org", synthetic: true, renewal_date: null },
      assessment: { ...item.assessment, as_of: "2026-10-23", risk: i, requires_review: true,
        caveats: ["Excluded stale evidence: stale", "<script>untrusted</script>"], factors: [{ evidence_id: "used" }] },
      evidence: [{ id: "used", account_id: item.account.id, organization_id: "org", fact: "Usage declined",
        source: "CRM", source_record: "original", observed_at: "2026-10-22T00:00:00Z" },
      { id: "stale", account_id: item.account.id, organization_id: "org", fact: "Older observation", observed_at: "2026-08-01" },
      { id: "foreign", account_id: item.account.id, organization_id: "other", fact: "Foreign private text" }],
      latest_run: { status: "failed", snapshot_hash: "old" } };
  });
  const portfolio = { accounts, organization_id: "org", mode: "local_sample", as_of: "2026-10-23" };
  const before = structuredClone(portfolio), selected = [];
  for (const persona of ["executive", "seller"]) {
    const tree = workspace.briefForAcceptance({ portfolio, persona, provider: { configured: true, status: "failed" },
      runs: {}, unavailable: false, onSelect: id => selected.push(id) });
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Showing the first 5 of 6/); assert.ok(html.indexOf("Account 0") < html.indexOf("Account 4"));
    assert.doesNotMatch(html, /Account 5|Foreign private text|<script>/);
    for (const text of ["Annual value unknown", "Renewal date unknown", "Excluded stale evidence", "observed 2026-10-22",
      "evidence used / used by assessment", "evidence stale / not used by assessment", "older snapshot", "Provider reported a failure",
      "Snapshot Account 0", "Synthetic sample", "&lt;script&gt;"]) assert.ok(html.includes(text), text);
    walk(tree).filter(n => n.type === "button")[3].props.onClick();
  }
  assert.deepEqual(selected, ["Account 3", "Account 3"]); assert.deepEqual(portfolio, before);
});

test("brief empty and unavailable states offer no priorities", () => {
  const workspace = briefingWorkspace(), portfolio = { accounts: [view("Hidden priority", 1, 1)], as_of: "2026-10-23" };
  const paused = workspace.briefForAcceptance({ portfolio, persona: "seller", runs: {}, provider: null, unavailable: true, onSelect() {} });
  assert.match(renderToStaticMarkup(paused), /Briefing paused/); assert.doesNotMatch(renderToStaticMarkup(paused), /Hidden priority/);
  assert.equal(walk(paused).filter(n => n.type === "button").length, 0);
  const empty = renderToStaticMarkup(workspace.briefForAcceptance({ portfolio: { ...portfolio, accounts: [] }, persona: "executive",
    runs: {}, provider: null, unavailable: false, onSelect() {} }));
  assert.match(empty, /No accounts available/); assert.match(empty, /Model unavailable or unconfigured/);
});

test("seller brief links the exact account to saved missions without creating work", () => {
  const workspace = briefingWorkspace(), account = view("B & C", 1, 1);
  const props = { portfolio: { accounts: [account], as_of: "2026-10-23" }, runs: {}, provider: null,
    unavailable: false, onSelect() {} };
  const seller = workspace.briefForAcceptance({ ...props, persona: "seller" });
  const links = walk(seller).filter(n => n.props?.href);
  assert.deepEqual(links.map(n => n.props.href), ["/missions?account=B+%26+C"]);
  assert.equal(walk(workspace.briefForAcceptance({ ...props, persona: "executive" })).filter(n => n.props?.href).length, 0);
  assert.equal(walk(workspace.briefForAcceptance({ ...props, persona: "seller", unavailable: true })).filter(n => n.props?.href).length, 0);
});

test("brief drilldown clears filters and keeps exact account; refresh failures block navigation", () => {
  for (const [loading, error, blocked] of [[false, null, false], [true, null, false], [false, "Refresh failed", false], [false, null, true]]) {
    const changes = [], routes = [], accounts = [view("A", 1, 1), view("B & C", 1, 1)];
    const states = [{ accounts, as_of: "2026-10-23" }, null, loading, error, "A", "growth", "risk", true,
      false, null, {}, null, blocked]; let cursor = 0;
    const workspace = briefingWorkspace({ useEffect() {}, useCallback: fn => fn, useRef: initial => ({ current: initial }),
      useMemo: fn => fn(), useState(initial) { const i = cursor++; return [i < states.length ? states[i] : initial,
        value => changes.push([i, value])]; } }, {
      useRouter: () => ({ replace: (...args) => routes.push(args) }), useSearchParams: () => new URLSearchParams(),
    });
    const brief = walk(workspace.contentForAcceptance({ accountDirectory: false, persona: "seller" }))
      .find(n => n.type === workspace.briefForAcceptance);
    assert.equal(brief.props.unavailable, loading || !!error || blocked);
    brief.props.onSelect("B & C"); brief.props.onSelect("missing");
    if (!loading && !error && !blocked) {
      assert.deepEqual(routes, [["/?persona=seller&account=B%20%26%20C", { scroll: false }]]);
      assert.ok(changes.some(([i, value]) => i === 4 && value === ""));
      assert.ok(changes.some(([i, value]) => i === 5 && value === "all"));
    } else assert.deepEqual(routes, []);
  }
});

test("account displays distinguish missing value and renewal from actual zero", () => {
  assert.equal(api.currency(null), "Unknown");
  assert.equal(api.currency(0), "$0");
  const html = renderToStaticMarkup(table.AccountTable({ rows: [view("Missing", null, null), view("Zero", 0, 0)],
    sort: "value", descending: false, onSort() {}, onSelect() {} }));
  assert.match(html, /<td class="">Unknown<\/td><td>Unknown<\/td>/);
  assert.match(html, /0 days<\/td><td>\$0<\/td>/);
  assert.doesNotMatch(html, /class="risk-text">Unknown/);
  const account = renderToStaticMarkup(detail.AccountDetail({ view: view("Missing", null, null),
    provider: null, busy: false, onAnalyze() {}, run: null, error: null }));
  assert.match(account, /<dt>Renewal<\/dt><dd>Unknown<\/dd>/);
});

test("account source exposes raw observation and missing or invalid normalized fields", () => {
  const sourced = { ...view("Sourced", null, null), source: { kind: "hubspot", observation_id: "observation-1",
    provider_updated_at: "2026-10-17T00:00:00Z", field_status: { annual_value: "unconfigured", renewal_date: "invalid", name: "valid" } } };
  const html = renderToStaticMarkup(detail.AccountDetail({ view: sourced,
    provider: null, busy: false, onAnalyze() {}, run: null, error: null }));
  assert.match(html, /HubSpot.*revision 1/);
  assert.match(html, /Observation observation-1.*2026-10-17T00:00:00Z/);
  assert.match(html, /annual value: unconfigured/);
  assert.match(html, /renewal date: invalid/);
  assert.doesNotMatch(html, /name: valid/);
  assert.doesNotThrow(() => renderToStaticMarkup(detail.AccountDetail({ view: { ...sourced, source: { kind: "local_sample" } },
    provider: null, busy: false, onAnalyze() {}, run: null, error: null })));
});

test("pipeline suppresses saved drafts after source revision or snapshot changes", () => {
  const saved = { id: "saved", started_at: "2026-10-17T00:00:00Z", status: "deterministic", steps: [], caveats: [],
    contexts: [{ account: { id: "a", name: "Account" } }], recommendations: [{ account_id: "a",
      assessment: { snapshot_hash: "original" }, action: { kind: "follow_up" }, governance: { status: "ready_for_preparation" },
      communication: { status: "deterministic_template", internal_note: "Original saved draft" } }] };
  for (const snapshots of [{ a: "original" }, { a: "different-source" }, {}]) {
    let cursor = 0;
    const state = ["attention", saved, false, null, false];
    const pipeline = load("../components/pipeline-panel.tsx", { react: {
      useEffect() {}, useRef: initial => ({ current: initial }),
      useState: initial => [state[cursor++] ?? initial, () => {}],
    }, "@/lib/api": api });
    const html = renderToStaticMarkup(pipeline.PipelinePanel({ onSelect() {}, organizationId: "org",
      snapshots, configured: false }));
    if (snapshots.a === "original") {
      assert.match(html, /Original saved draft/);
      assert.doesNotMatch(html, /older account snapshot/);
    } else {
      assert.doesNotMatch(html, /Original saved draft/);
      assert.match(html, /older account snapshot/);
    }
  }
});

test("workspace discloses incomplete totals and sorts unknowns last in both directions", () => {
  const accounts = [view("Unknown", null, null), view("Low", 0, 0), view("High", 100, 10)];
  const portfolio = { annual_value: 100, annual_value_missing_count: 1, accounts, as_of: "2026-10-18" };
  for (const sort of ["value", "renewal"]) for (const descending of [true, false]) {
    let cursor = 0;
    const state = [portfolio, null, false, null, "", "all", sort, descending];
    const workspace = load("../components/workspace.tsx", {
      react: { useEffect() {}, useCallback: fn => fn, useRef: initial => ({ current: initial }),
        useMemo: fn => fn(), useState: initial => [state[cursor++] ?? initial, () => {}] },
      "next/navigation": { useRouter: () => ({}), useSearchParams: () => new URLSearchParams() },
      "next/link": { __esModule: true, default: ({ children }) => children }, "@/lib/api": api,
      "./account-table": table, "./account-detail": detail,
      "./pipeline-panel": { PipelinePanel: () => null }, "./session-gate": {},
      "./hubspot-panel": { HubSpotPanel: () => null },
      "./research-panel": { ResearchPanel: () => null },
      "./comparison-panel": { ComparisonPanel: () => null },
      "./source-detection-panel": { SourceDetectionPanel: () => null },
      "./hubspot-ingestion-panel": { HubSpotIngestionPanel: () => null },
      "./hubspot-refresh-panel": { HubSpotRefreshPanel: () => null },
    }, "\nexports.contentForAcceptance = WorkspaceContent;");
    const tree = workspace.contentForAcceptance({ accountDirectory: true, persona: "executive" });
    const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object"
      ? [node, ...walk(node.props?.children)] : [];
    const renderedTable = walk(tree).find(node => node.type === table.AccountTable);
    assert.deepEqual(renderedTable.props.rows.map(row => row.account.id),
      descending ? ["High", "Low", "Unknown"] : ["Low", "High", "Unknown"]);
    const html = renderToStaticMarkup(tree);
    assert.match(html, /Known portfolio value/);
    assert.match(html, /1 account.*missing annual value/);
  }
});
