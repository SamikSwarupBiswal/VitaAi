import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const filename = fileURLToPath(new URL("../components/guide-target.tsx", import.meta.url));
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];

function harness() {
  let cursor = 0, effects = [], cleanups = [], found = true, visible = true, hidden = false, contained = true, failFocus = false;
  const slots = [], listeners = new Map(), disclosureListeners = new Map(), calls = [];
  globalThis.window = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name, fn) => {
    if (listeners.get(name) === fn) listeners.delete(name);
  } };
  const disclosure = { open: true, addEventListener: (name, fn) => disclosureListeners.set(name, fn), removeEventListener: name => disclosureListeners.delete(name) };
  const button = { isConnected: true, closest: () => disclosure, focus: options => calls.push(["return", options]),
    scrollIntoView: options => calls.push(["return-scroll", options]) };
  const attrs = new Map(), element = { isConnected: true, getClientRects: () => visible ? [{}] : [], closest: () => hidden ? {} : null,
    setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key),
    focus: options => { if (failFocus) throw new Error("denied"); calls.push(["focus", options]); }, scrollIntoView: options => calls.push(["scroll", options]) };
  const root = { current: { dataset: { guideContext: "current" }, contains: () => contained,
    querySelector: selector => { calls.push(["query", selector]); return found ? element : null; } } };
  let props = { root, context: "current", target: "evidence" };
  const hooks = {
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useLayoutEffect(callback, deps) { const i = cursor++; if (!slots[i] || deps.some((value, j) => value !== slots[i][j])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); });
    } },
  };
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target); target.require = name => name === "react" ? hooks : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: {
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename);
  const render = () => { cursor = 0; const tree = target.exports.GuideTarget(props); const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const find = label => walk(render()).find(node => node.type === "button" && node.props.children === label);
  return { calls, root, button, attrs, element, listeners, disclosureListeners, render,
    show: () => find("Show this step").props.onClick({ currentTarget: button }),
    back: () => find("Return to guide").props.onClick(),
    state: () => walk(render()).find(node => node.props?.role === "status").props.children,
    active: () => !find("Return to guide").props.disabled,
    capture: () => find("Show this step").props.onClick,
    event: name => listeners.get(name)?.({ key: "Escape" }),
    close() { disclosure.open = false; disclosureListeners.get("toggle")?.({ currentTarget: disclosure }); },
    configure(values) { ({ found = found, visible = visible, hidden = hidden, contained = contained, failFocus = failFocus } = values); },
    props(values) { props = { ...props, ...values }; }, unmount() { cleanups.forEach(fn => fn?.()); },
  };
}

test("explicit focus highlights only the scoped target, scrolls without animation and restores the guide", () => {
  const app = harness(); assert.equal(app.active(), false); assert.deepEqual(app.calls, []);
  app.show(); assert.equal(app.attrs.get("data-guide-highlight"), "true"); assert.equal(app.active(), true);
  assert.deepEqual(app.calls, [["query", '[data-guide-target="evidence"]'], ["focus", { preventScroll: true }], ["scroll", { behavior: "instant", block: "center" }]]);
  assert.match(app.state(), /No action has been performed/); app.back(); assert.equal(app.attrs.size, 0);
  assert.equal(app.active(), false); assert.deepEqual(app.calls.slice(-2), [["return", { preventScroll: true }], ["return-scroll", { behavior: "instant", block: "center" }]]);
  app.show(); app.event("keydown"); assert.equal(app.attrs.size, 0); assert.deepEqual(app.calls.at(-1), ["return-scroll", { behavior: "instant", block: "center" }]);
});

test("closing, context invalidation and unmount remove highlights and listeners without restoring old focus", () => {
  for (const invalidate of [app => app.close(), ...["blur", "vitaai-source-changed", "vitaai-workflow-changed"].map(name => app => app.event(name))]) {
    const app = harness(); app.show(); invalidate(app); assert.equal(app.attrs.size, 0); assert.equal(app.active(), false);
    assert.equal(app.disclosureListeners.size, 0); assert.equal(app.calls.some(call => call[0] === "return"), false); app.unmount(); assert.equal(app.listeners.size, 0);
  }
  const app = harness(); app.show(); const captured = app.capture(); app.unmount(); captured({ currentTarget: app.button });
  assert.equal(app.attrs.size, 0); assert.equal(app.listeners.size, 0); assert.equal(app.calls.filter(call => call[0] === "focus").length, 1);
});

test("captured context and disconnected or foreign controls cannot focus a new selection", () => {
  for (const invalidate of [app => { app.root.current.dataset.guideContext = "other-account"; }, app => { app.button.isConnected = false; }, app => app.configure({ contained: false })]) {
    const app = harness(), captured = app.capture(); invalidate(app); captured({ currentTarget: app.button });
    assert.equal(app.calls.length, 0); assert.equal(app.attrs.size, 0); app.unmount();
  }
  const app = harness(); app.show(); app.root.current.dataset.guideContext = "other-account"; app.back();
  assert.equal(app.attrs.size, 0); assert.equal(app.calls.some(call => call[0] === "return"), false);
});

test("missing, hidden, disconnected and failed focus targets report failure without stale success", () => {
  for (const mode of ["missing", "hidden", "zero-layout", "disconnected", "focus-failure"]) {
    const app = harness(); app.show();
    if (mode === "missing") app.configure({ found: false });
    if (mode === "hidden") app.configure({ hidden: true });
    if (mode === "zero-layout") app.configure({ visible: false });
    if (mode === "disconnected") app.element.isConnected = false;
    if (mode === "focus-failure") app.configure({ failFocus: true });
    app.show(); assert.equal(app.active(), false); assert.equal(app.attrs.size, 0); assert.match(app.state(), /unavailable|could not be focused/);
    assert.equal(app.disclosureListeners.size, 0); app.unmount();
  }
});
