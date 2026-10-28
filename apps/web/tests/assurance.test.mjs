import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const fixture = () => ({ schema_version: "1", actor_id: "actor", organization_id: "org", report: JSON.parse(readFileSync(new URL("../../../services/api/vita_api/data/guardrail-evaluation.generated.json", import.meta.url), "utf8")) });
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function load(mocks = {}) {
  const filename = fileURLToPath(new URL("../components/assurance-page.tsx", import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  target.require = name => mocks[name] ?? (name === "@/lib/api" ? {} : name === "./session-gate" ? { useSession: () => null } : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return target.exports;
}
test("assurance validates scope, measured counts, row failures, hashes and renderable text", () => {
  const helper = load(); helper.checkAssurance(fixture(), "actor", "org");
  for (const mutate of [x => x.actor_id = "other", x => x.report.evidence_tier = "live", x => x.report.total_cases = 0,
    x => x.report.failed_cases = 1, x => x.report.classifier_failed_cases = 0, x => x.report.meets_rubric = false,
    x => x.report.artifact_sha256 = "wrong", x => x.report.cases[0].scenario_title = {}, x => x.report.caveats = [{}],
    x => x.report.cases[1].case_id = x.report.cases[0].case_id, x => x.report.cases[0].actual_decision = "blocked",
    x => x.report.cases.find(row => row.classifier_mode === "simulated_failure").actual_error_code = null,
    x => x.report.cases[0].actual_error_code = "invented", x => x.report.cases[0].failures = ["invented_failure"],
    x => { x.report.cases[0].failures = ["classifier_error_mismatch"]; x.report.passed_cases--; x.report.failed_cases++; x.report.meets_rubric = false; }]) {
    const value = fixture(); mutate(value); assert.throws(() => helper.checkAssurance(value, "actor", "org"));
  }
});
function setup(t) {
  const slots = [], cleanups = [], callbacks = [], requests = [], listeners = new Map(); let cursor = 0, effects = [], changed = false, currentTree;
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  const hooks = { ...React, useEffect(fn, deps) { const index = cursor++; callbacks[index] = fn; if (!(index in slots) || deps.some((item, n) => item !== slots[index][n])) { slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { changed = true; slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; } };
  const component = load({ react: hooks, "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) } });
  const render = () => { cursor = 0; changed = false; currentTree = component.AssuranceWorkspace({ actor: "actor", organization: "org" }); const pending = effects; effects = []; pending.forEach(fn => fn()); return currentTree; };
  const unmount = () => cleanups.forEach(fn => fn?.()); t.after(() => { unmount(); globalThis.window = oldWindow; }); render();
  return { requests, render, unmount, html: () => renderToStaticMarkup(render()), button() { return walk(render()).find(node => node.type === "button"); }, focus() { listeners.get("focus")(); render(); },
    replay() { changed = false; cleanups.forEach(fn => fn?.()); callbacks.forEach((fn, index) => { cleanups[index] = fn(); }); if (changed) render(); return walk(currentTree).find(node => node.type === "button"); } };
}
test("StrictMode effect reactivation leaves the visible Inspect handler usable", async t => {
  const app = setup(t), pending = app.replay().props.onClick(); assert.equal(app.requests.length, 1); app.requests.shift().resolve(fixture()); await pending;
  assert.match(app.html(), /PASS — synthetic rubric/);
});
test("valid measured FAIL remains visible and failed refresh removes previous report", async t => {
  const app = setup(t), value = fixture(), row = value.report.cases.find(item => item.actual_decision === "blocked");
  row.actual_decision = row.final_decision = "explanation_only"; row.failures = ["decision_mismatch"];
  value.report.passed_cases--; value.report.failed_cases++; value.report.meets_rubric = false;
  const pending = app.button().props.onClick(); app.requests.shift().resolve(value); await pending;
  assert.match(app.html(), /FAIL — synthetic rubric/); assert.match(app.html(), /decision_mismatch/); assert.match(app.html(), /Artifact SHA256/);
  const refresh = app.button().props.onClick(); assert.doesNotMatch(app.html(), /FAIL — synthetic rubric/); app.requests.shift().reject(new Error("unavailable")); await refresh;
  assert.match(app.html(), /Report unavailable/); assert.doesNotMatch(app.html(), /measured cases/);
});
test("duplicate, captured, focus and unmount reads cannot restore obsolete report", async t => {
  const app = setup(t), captured = app.button(), pending = captured.props.onClick(); await captured.props.onClick(); assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.equal(request.url, "assurance/guardrails"); assert.equal(request.init.method, undefined); request.resolve(fixture()); await pending;
  assert.match(app.html(), /PASS — synthetic rubric/); await captured.props.onClick(); assert.equal(app.requests.length, 0);
  const late = app.button().props.onClick(), next = app.requests.shift(); app.focus(); next.resolve(fixture()); await late; assert.ok(next.init.signal.aborted); assert.doesNotMatch(app.html(), /PASS — synthetic rubric/);
  const last = app.button().props.onClick(), finalRequest = app.requests.shift(); app.unmount(); finalRequest.resolve(fixture()); await last; assert.doesNotMatch(app.html(), /PASS — synthetic rubric/);
});
