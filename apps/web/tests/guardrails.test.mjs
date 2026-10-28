import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ids = ["evidence-summary", "instruction-override", "approval-shortcut", "external-action", "evidence-change", "secret-extraction", "scope-swap"];
const rules = ["instruction_override", "approval_bypass", "external_action", "record_manipulation", "secret_request", "identity_substitution"];
const catalog = () => ({ schema_version: "1", policy_version: "request-constraints-1", dataset_version: "guardrail-lab-1", scenarios: ids.map(id => ({ id, title: id, text: `Synthetic scenario ${id}` })) });
const result = (scenario = "approval-shortcut", mode = "mock") => ({ schema_version: "1", policy_version: "request-constraints-1", dataset_version: "guardrail-lab-1", actor_id: "actor", organization_id: "org",
  evaluated_at: "2026-10-28T00:00:00Z", scenario: catalog().scenarios.find(item => item.id === scenario), scope: "curated_read_only_lab", caveats: ["Synthetic, no workflow authority"],
  findings: rules.map(rule_id => ({ rule_id, description: rule_id, triggered: rule_id === "approval_bypass" })), deterministic_decision: "blocked", final_decision: "blocked",
  classifier: { mode, status: mode === "mock" ? "mock" : mode === "disabled" ? "disabled" : "failed", evidence_tier: mode === "disabled" ? "not_run" : "synthetic", advisory_flag: mode === "mock" ? false : null, error_code: mode === "simulated_failure" ? "simulated_failure" : null } });
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const text = node => Array.isArray(node) ? node.map(text).join("") : node && typeof node === "object" ? text(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);
function load(mocks = {}) {
  const filename = fileURLToPath(new URL("../components/guardrails-lab.tsx", import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  target.require = name => mocks[name] ?? (name === "@/lib/api" ? {} : name === "./session-gate" ? { useSession: () => null } : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
  return target.exports;
}
test("guardrail validators reject malformed rendered text, crossed scope/verdict and mislabeled classifier", () => {
  const helper = load(); helper.checkCatalog(catalog()); helper.checkResult(result(), catalog(), "approval-shortcut", "mock", "actor", "org");
  for (const mutate of [x => x.scenarios[0].title = {}, x => x.scenarios[0].text = [], x => x.scenarios[0] = null, x => x.scenarios.reverse()]) {
    const value = catalog(); mutate(value); assert.throws(() => helper.checkCatalog(value));
  }
  for (const mutate of [x => x.actor_id = "other", x => x.organization_id = "foreign", x => x.final_decision = "explanation_only", x => x.scenario.text = "crossed",
    x => x.classifier.evidence_tier = "live", x => x.classifier.advisory_flag = 1, x => x.findings[0].description = {}, x => x.caveats = [{}], x => x.evaluated_at = null]) {
    const value = result(); mutate(value); assert.throws(() => helper.checkResult(value, catalog(), "approval-shortcut", "mock", "actor", "org"));
  }
});
function setup(t) {
  const slots = [], cleanups = [], requests = [], listeners = new Map(); let cursor = 0, effects = [];
  const oldWindow = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  const hooks = { ...React, useEffect(fn, deps) { const index = cursor++; if (!(index in slots) || deps.some((item, n) => item !== slots[index][n])) { slots[index] = deps; effects.push(() => { cleanups[index]?.(); cleanups[index] = fn(); }); } },
    useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial; return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; } };
  const component = load({ react: hooks, "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) } });
  const render = () => { cursor = 0; const tree = component.GuardrailWorkspace({ actor: "actor", organization: "org" }); const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const unmount = () => cleanups.forEach(fn => fn?.()); t.after(() => { unmount(); globalThis.window = oldWindow; }); render();
  return { requests, render, unmount, html: () => renderToStaticMarkup(render()),
    button(name) { const node = walk(render()).find(node => node.type === "button" && text(node.props.children) === name); assert.ok(node); return node; },
    field(name, value) { const label = walk(render()).find(node => node.type === "label" && text(node.props.children).startsWith(name)); walk(label).find(node => node.type === "select").props.onChange({ target: { value } }); render(); },
    async load() { const pending = this.button("Load scenario catalog").props.onClick(); requests.shift().resolve(catalog()); await pending; render(); },
    focus() { listeners.get("focus")(); render(); } };
}
test("captured and duplicate controls cannot evaluate an obsolete selection or completed inspection", async t => {
  const app = setup(t); await app.load(); app.field("Curated scenario", "approval-shortcut"); app.field("Classifier demonstration", "mock");
  const stale = app.button("Inspect deterministic decision"); app.field("Curated scenario", "external-action"); await stale.props.onClick(); assert.equal(app.requests.length, 0);
  const captured = app.button("Inspect deterministic decision"), pending = captured.props.onClick(); await captured.props.onClick(); assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.deepEqual(JSON.parse(request.init.body), { scenario_id: "external-action", classifier_mode: "mock" }); request.resolve(result("external-action")); await pending;
  assert.match(app.html(), /Blocked by lab policy/); assert.match(app.html(), /Synthetic advisory flag/); await captured.props.onClick(); assert.equal(app.requests.length, 0);
  app.field("Classifier demonstration", "simulated_failure"); assert.doesNotMatch(app.html(), /Blocked by lab policy/);
});
test("malformed result fails visibly and focus/unmount fence late publication without retry", async t => {
  const app = setup(t); await app.load(); app.field("Curated scenario", "approval-shortcut"); app.field("Classifier demonstration", "mock");
  const pending = app.button("Inspect deterministic decision").props.onClick(), value = result(); value.caveats = [{}]; app.requests.shift().resolve(value); await pending;
  assert.match(app.html(), /Inspection unavailable/); assert.doesNotMatch(app.html(), /Blocked by lab policy/); assert.equal(app.requests.length, 0);
  const load = app.button("Load scenario catalog").props.onClick(), request = app.requests.shift(); app.focus(); assert.ok(request.init.signal.aborted); request.resolve(catalog()); await load;
  assert.doesNotMatch(app.html(), /Curated scenario/);
  const late = app.button("Load scenario catalog").props.onClick(), last = app.requests.shift(); app.unmount(); last.resolve(catalog()); await late; assert.doesNotMatch(app.html(), /Curated scenario/);
});
test("simulated classifier failure retains blocked result and failure disclosure", async t => {
  const app = setup(t); await app.load(); app.field("Curated scenario", "approval-shortcut"); app.field("Classifier demonstration", "simulated_failure");
  const pending = app.button("Inspect deterministic decision").props.onClick(); app.requests.shift().resolve(result("approval-shortcut", "simulated_failure")); await pending;
  assert.match(app.html(), /Blocked by lab policy/); assert.match(app.html(), /Classifier unavailable: simulated_failure/); assert.doesNotMatch(app.html(), /Synthetic advisory flag:/);
});
