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
  target.require = name => name in mocks ? name === "react" ? { useLayoutEffect() {}, ...mocks[name] } : mocks[name]
    : name === "@/lib/pipeline-delta" ? delta : normal(name);
  target._compile(compiled + extra, filename);
  return target.exports;
}

const delta = load("../lib/pipeline-delta.ts");
const api = load("../lib/api.ts");
const table = load("../components/account-table.tsx", { "@/lib/api": api });
const detail = load("../components/account-detail.tsx");
const view = (id, value, renewal) => ({
  account: { id, name: id, industry: "Test", annual_value: value, revision: 1 }, renewal_days: renewal,
  assessment: { health: 100, risk: 0, opportunity: 0, confidence: 75, caveats: [], factors: [],
    recommendation: "Review missing data", snapshot_hash: id }, evidence: [], latest_run: null,
});

function briefingWorkspace(hooks = {}, navigation = {}, session = null, apiOverride = api) {
  return load("../components/workspace.tsx", {
    react: hooks, "next/navigation": navigation, "next/link": { __esModule: true, default: ({ children }) => children },
    "@/lib/api": apiOverride, "./account-table": table, "./account-detail": detail,
    ...Object.fromEntries(["pipeline-panel", "session-gate", "hubspot-panel", "research-panel", "comparison-panel",
      "source-detection-panel", "hubspot-ingestion-panel", "hubspot-refresh-panel"].map(name => ["./" + name, {}])),
    "./session-gate": { useSession: () => session },
  }, "\nexports.briefForAcceptance = PortfolioBriefing; exports.contentForAcceptance = WorkspaceContent; exports.operationsForAcceptance = OperationsMissions; exports.managerForAcceptance = ManagerWorkSummary;");
}
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object"
  ? [node, ...walk(node.props?.children)] : [];

test("operations inspects scoped saved attention with exact links; refresh failure and obsolete reads cannot show success", async t => {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "window"), listeners = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    addEventListener(name, handler) { listeners.set(name, handler); }, removeEventListener(name) { listeners.delete(name); },
  } });
  t.after(() => { if (prior) Object.defineProperty(globalThis, "window", prior); else delete globalThis.window; });
  const slots = [], cleanups = [], requests = []; let cursor = 0, effects = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useEffect(callback, deps) { const i = cursor++; if (!(i in slots) || deps.some((value, index) => value !== slots[i][index])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); });
    } },
  };
  const workspace = briefingWorkspace(hooks, {}, { actor: { id: "actor", organization_id: "org", role: "viewer" } },
    { ...api, api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) });
  const account = view("account", 1, 1); account.account.organization_id = "org"; account.assessment.as_of = "2026-10-23";
  const portfolio = { accounts: [account], organization_id: "org", as_of: "2026-10-23" };
  const render = () => { cursor = 0; const tree = workspace.operationsForAcceptance({ portfolio });
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  const mission = (id, status, extra = {}) => ({ id, status, owner_id: "saved-owner", account_id: "account", organization_id: "org", revision: 2,
    created_at: "2026-10-23T00:00:00Z", evidence: { account_revision: 0, snapshot_hash: "old", as_of: "old" }, ...extra });
  assert.match(renderToStaticMarkup(render()), /Loading current mission attention/);
  assert.equal(requests[0].url, "missions"); assert.equal(requests[0].init.method, undefined);
  requests[0].resolve([mission("unknown", "reconciliation_required"), mission("review", "awaiting_review"),
    mission("outcome", "executed"), mission("done", "completed"), mission("draft", "draft"),
    mission("foreign", "execution_failed", { organization_id: "other" }), mission("missing", "executing", { account_id: "missing" })]);
  await flush(); let tree = render(), html = renderToStaticMarkup(tree);
  assert.match(html, /Uncertain result/); assert.match(html, /historical evidence binding/); assert.match(html, /business outcome are separate/);
  const links = walk(tree).filter(node => node.props?.href).map(node => node.props.href);
  assert.deepEqual(links.map(href => new URL(href, "http://localhost").searchParams.get("mission")), ["unknown", "review", "outcome"]);
  assert.deepEqual(links.map(href => new URL(href, "http://localhost").searchParams.get("step")), ["Execution", "Approval", "Outcome"]);
  listeners.get("focus")(); assert.match(renderToStaticMarkup(render()), /Loading current mission attention/);
  assert.equal(requests[0].init.signal.aborted, true);
  listeners.get("vitaai-workflow-changed")(); render(); assert.equal(requests[1].init.signal.aborted, true);
  requests[1].resolve([mission("obsolete", "awaiting_review")]); requests[2].reject(new Error("private server detail")); await flush();
  html = renderToStaticMarkup(render()); assert.match(html, /Mission attention is unavailable/);
  assert.doesNotMatch(html, /obsolete|private server detail|inspect Approval/);
  walk(render()).find(node => node.type === "button").props.onClick(); render(); requests[3].resolve([]); await flush();
  assert.match(renderToStaticMarkup(render()), /No saved review, execution or outcome attention/);
  cleanups.forEach(fn => fn?.());
});

test("operations sample mode offers no private mission request", () => {
  let requested = false;
  const workspace = briefingWorkspace({ useState: initial => [initial, () => {}], useEffect: callback => callback() }, {},
    { actor: null }, { ...api, api() { requested = true; } });
  const prior = globalThis.window; globalThis.window = { addEventListener() {}, removeEventListener() {} };
  try {
    const html = renderToStaticMarkup(workspace.operationsForAcceptance({ portfolio: { organization_id: "org", accounts: [] } }));
    assert.match(html, /Session identity/); assert.equal(requested, false);
  } finally { if (prior === undefined) delete globalThis.window; else globalThis.window = prior; }
});

test("manager summary counts exact owner lifecycle records and links only actual completed missions", () => {
  const workspace = briefingWorkspace(), account = view("account", 1, 1); account.account.organization_id = "org";
  const portfolio = { organization_id: "org", accounts: [account] };
  const mission = (id, status, owner_id = "owner <one>", extra = {}) => ({ id, status, owner_id,
    account_id: "account", organization_id: "org", revision: 2, created_at: "2026-10-23T00:00:00Z", ...extra });
  const missions = [mission("complete", "completed"), mission("unknown", "reconciliation_required"),
    mission("rejected", "rejected"), mission("review", "awaiting_review", "owner-two"), mission("replaced", "superseded"),
    mission("private", "completed", "foreign-owner", { organization_id: "foreign" }),
    mission("absent", "completed", "missing-owner", { account_id: "absent" })];
  const original = structuredClone(missions), tree = workspace.managerForAcceptance({ portfolio, missions });
  const html = renderToStaticMarkup(tree), hrefs = walk(tree).filter(n => n.props?.href).map(n => n.props.href);
  assert.deepEqual(hrefs, ["/missions?account=account&mission=complete&step=Outcome"]);
  for (const text of ["completed: 1", "reconciliation required: 1", "rejected: 1", "awaiting review: 1", "superseded: 1",
    "Owner owner &lt;one&gt;", "Creation is not completion time", "not a verified seller directory", "does not independently verify"]) assert.ok(html.includes(text), text);
  assert.doesNotMatch(html, /foreign-owner|missing-owner|<one>/);
  assert.equal(walk(tree).some(n => n.type === "button" || n.type === "form"), false);
  assert.deepEqual(missions, original);
  const empty = renderToStaticMarkup(workspace.managerForAcceptance({ portfolio, missions: [] }));
  assert.match(empty, /No saved missions for current portfolio accounts/);
});

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

test("walkthrough preserves valid account and mission context across all seven read-only step links", async () => {
  const page = load("../app/walkthrough/page.tsx", { "next/link": { __esModule: true, default: ({ children }) => children } }).default;
  const account = "11111111-1111-4111-8111-111111111111", mission = "22222222-2222-4222-8222-222222222222";
  const tree = await page({ searchParams: Promise.resolve({ account, mission }) });
  const links = walk(tree).filter(n => n.props?.href).map(n => n.props.href);
  const stepLinks = links.filter(href => href.includes("&step="));
  assert.equal(stepLinks.length, 7);
  assert.deepEqual(stepLinks.map(href => new URL(href, "http://localhost").searchParams.get("step")),
    ["Review", "Evidence", "Outreach", "CRM Note", "Approval", "Execution", "Outcome"]);
  for (const href of stepLinks) {
    const query = new URL(href, "http://localhost").searchParams;
    assert.equal(query.get("account"), account); assert.equal(query.get("mission"), mission);
  }
  const html = renderToStaticMarkup(tree);
  for (const text of ["simulation", "unknown result", "current admin or reviewer", "business outcome", "does not verify"]) assert.ok(html.includes(text), text);
  assert.equal(walk(tree).filter(n => n.type === "button" || n.type === "form").length, 0);
});

test("walkthrough rejects malformed and repeated context without reflecting it or selecting a fallback", async () => {
  const page = load("../app/walkthrough/page.tsx", { "next/link": { __esModule: true, default: ({ children }) => children } }).default;
  for (const context of [{ account: "<script>bad</script>", mission: "invalid" }, { account: ["one", "two"] },
    { mission: "22222222-2222-4222-8222-222222222222" }, {}]) {
    const tree = await page({ searchParams: Promise.resolve(context) }), html = renderToStaticMarkup(tree);
    const hrefs = walk(tree).filter(n => n.props?.href).map(n => n.props.href);
    assert.doesNotMatch(html, /<script>|&lt;script&gt;/);
    assert.ok(hrefs.includes("/missions")); assert.ok(hrefs.includes("/?persona=seller"));
    assert.equal(hrefs.some(href => href.includes("account=") || href.includes("step=")), false);
    if (Object.keys(context).length) assert.match(html, /context is invalid or missing/);
  }
});

test("brief and full-pool pipeline drilldown clear filters and keep exact account; refresh failures block navigation", () => {
  for (const [loading, error, blocked] of [[false, null, false], [true, null, false], [false, "Refresh failed", false], [false, null, true]]) {
    const changes = [], routes = [], accounts = [view("A", 1, 1), view("B & C", 1, 1)];
    accounts[0].assessment.growth_signal = true;
    const states = [{ accounts, as_of: "2026-10-23" }, null, loading, error, "A", "growth", "risk", true,
      false, null, {}, null, blocked]; let cursor = 0;
    const workspace = briefingWorkspace({ useEffect() {}, useCallback: fn => fn, useRef: initial => ({ current: initial }),
      useMemo: fn => fn(), useState(initial) { const i = cursor++; return [i < states.length ? states[i] : initial,
        value => changes.push([i, value])]; } }, {
      useRouter: () => ({ replace: (...args) => routes.push(args) }), useSearchParams: () => new URLSearchParams(),
    });
    const tree = workspace.contentForAcceptance({ accountDirectory: false, persona: "seller" });
    if (!blocked) {
      const integrationKeys = walk(tree).filter(n => n.props?.view?.account && n.key !== null).map(n => n.key);
      assert.equal(integrationKeys.length, 6);
      assert.equal(new Set(integrationKeys).size, integrationKeys.length, "integration siblings must preserve distinct React identities");
    }
    const brief = walk(tree)
      .find(n => n.type === workspace.briefForAcceptance);
    assert.equal(brief.props.unavailable, loading || !!error || blocked);
    brief.props.onSelect("B & C"); brief.props.onSelect("missing");
    if (!loading && !error && !blocked) {
      assert.deepEqual(routes, [["/?persona=seller&account=B%20%26%20C", { scroll: false }]]);
      assert.ok(changes.some(([i, value]) => i === 4 && value === ""));
      assert.ok(changes.some(([i, value]) => i === 5 && value === "all"));
    } else assert.deepEqual(routes, []);
    changes.length = 0; routes.length = 0;
    const pipeline = walk(tree).find(n => n.props?.snapshots);
    if (pipeline) {
      pipeline.props.onSelect("B & C");
      pipeline.props.onSelect("missing");
      if (!loading && !error && !blocked) {
        assert.deepEqual(routes, [["/?persona=seller&account=B%20%26%20C", { scroll: false }]]);
        assert.ok(changes.some(([i, value]) => i === 4 && value === ""));
        assert.ok(changes.some(([i, value]) => i === 5 && value === "all"));
      } else assert.deepEqual(routes, []);
    }
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

test("pipeline specialist findings retain failures, sources, conflicts and exact highlight navigation", () => {
  const saved = { id: "saved", started_at: "2026-10-24", status: "partial", steps: [], caveats: [],
    contexts: [{ account: { id: "a", name: "Selected account" }, evidence: [{ id: "fact", metric: "usage_change", value: -20,
      fact: "<script>untrusted source</script>", source: "CRM", source_record: "record", observed_at: "2026-10-23", ingested_at: "2026-10-24", synthetic: true }] },
      { account: { id: "b", name: "Full-pool opportunity" }, evidence: [] }],
    portfolio_specialists: { account_count: 2, policy_version: "specialists-1", input_snapshots: { a: "hash-a", b: "hash-b" },
      highest_risk: { account_id: "a", score: 60, account_revision: 2, snapshot_hash: "hash-a", evidence_ids: ["fact"] },
      highest_opportunity: { account_id: "b", score: 80, account_revision: 1, snapshot_hash: "hash-b", evidence_ids: [] }, caveats: ["Rank unchanged"] },
    recommendations: [{ account_id: "a", assessment: { snapshot_hash: "hash-a" }, action: { kind: "follow_up" },
      governance: { status: "ready_for_preparation" }, communication: { status: "failed" },
      specialists: { policy_version: "specialists-1", account_revision: 2, as_of: "2026-10-24", snapshot_hash: "hash-a", caveats: ["No factual confidence inferred"],
        perspectives: [{ role: "engagement", status: "failed", missing_sources: ["contact_history"], model_run_id: "retained-run",
          findings: [{ text: "Preparation only", evidence_ids: ["fact"] }] }, { role: "research", status: "missing_source", missing_sources: ["selected_external_context"],
          findings: [{ text: "No search performed", evidence_ids: [] }] }],
        disagreements: [{ kind: "conflicting_observations", roles: ["risk", "governance"], text: "Review both sources", evidence_ids: ["fact", "conflict"] }] } }] };
  for (const snapshots of [{ a: "hash-a", b: "hash-b" }, { a: "hash-a", b: "changed" }, { a: "hash-a" }]) {
    let cursor = 0;
    const selected = [];
    const state = ["attention", saved, false, null, false];
    const pipeline = load("../components/pipeline-panel.tsx", { react: { useEffect() {}, useRef: initial => ({ current: initial }),
      useState: initial => [state[cursor++] ?? initial, () => {}] }, "@/lib/api": api });
    const tree = pipeline.PipelinePanel({ onSelect: id => selected.push(id), organizationId: "org", snapshots, configured: false });
    const html = renderToStaticMarkup(tree);
    if (snapshots.b !== "hash-b") {
      assert.match(html, /older account snapshot/);
      assert.doesNotMatch(html, /Specialist findings|Portfolio specialist highlights|Review both sources/);
      continue;
    }
    assert.match(html, /engagement · failed/);
    assert.match(html, /research · missing source/);
    assert.match(html, /Missing sources: contact history/);
    assert.match(html, /retained-run/);
    assert.match(html, /fact, conflict/);
    assert.match(html, /observed 2026-10-23.*ingested 2026-10-24/);
    assert.match(html, /&lt;script&gt;untrusted source&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    const highlightButton = walk(tree).find(n => n.type === "button" && n.props.children === "Full-pool opportunity");
    highlightButton.props.onClick();
    assert.deepEqual(selected, ["b"]);
  }
});

test("pipeline legacy and empty specialist records show no invented findings", () => {
  for (const portfolio_specialists of [null, { account_count: 0, policy_version: "specialists-1", input_snapshots: {}, highest_risk: null, highest_opportunity: null, caveats: [] }]) {
    let cursor = 0;
    const state = ["attention", { id: "old", steps: [], contexts: [], recommendations: [], caveats: [], portfolio_specialists }, false, null, false];
    const pipeline = load("../components/pipeline-panel.tsx", { react: { useEffect() {}, useRef: initial => ({ current: initial }),
      useState: initial => [state[cursor++] ?? initial, () => {}] }, "@/lib/api": api });
    const html = renderToStaticMarkup(pipeline.PipelinePanel({ onSelect() {}, organizationId: "org", snapshots: {}, configured: false }));
    if (portfolio_specialists) assert.match(html, /No input accounts/);
    else assert.doesNotMatch(html, /Portfolio specialist highlights/);
    assert.doesNotMatch(html, /Specialist findings/);
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
