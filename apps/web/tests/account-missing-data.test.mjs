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

test("workspace discloses incomplete totals and sorts unknowns last in both directions", () => {
  const accounts = [view("Unknown", null, null), view("Low", 0, 0), view("High", 100, 10)];
  const portfolio = { annual_value: 100, annual_value_missing_count: 1, accounts, as_of: "2026-10-18" };
  for (const sort of ["value", "renewal"]) for (const descending of [true, false]) {
    let cursor = 0;
    const state = [portfolio, null, false, null, "", "all", sort, descending];
    const workspace = load("../components/workspace.tsx", {
      react: { useEffect() {}, useMemo: fn => fn(), useState: initial => [state[cursor++] ?? initial, () => {}] },
      "next/navigation": { useRouter: () => ({}), useSearchParams: () => new URLSearchParams() },
      "next/link": { __esModule: true, default: ({ children }) => children }, "@/lib/api": api,
      "./account-table": table, "./account-detail": detail,
      "./pipeline-panel": { PipelinePanel: () => null }, "./session-gate": {},
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
