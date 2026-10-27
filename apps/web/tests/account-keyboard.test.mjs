import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript");
const filename = fileURLToPath(new URL("../components/account-table.tsx", import.meta.url)), mod = new Module(filename);
mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
const normal = mod.require.bind(mod);
mod.require = name => name === "@/lib/api" ? { currency: value => String(value) } : normal(name);
mod._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
} }).outputText, filename);
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
const view = id => ({ account: { id, name: id, annual_value: null }, assessment: { health: 50, risk: 50, opportunity: 0 }, renewal_days: null });

function setup(ids) {
  const rows = ids.map(view), selected = [], focused = []; let selectedId = ids[0];
  const render = () => mod.exports.AccountTable({ rows, selectedId, onSelect: id => { selected.push(id); selectedId = id; },
    sort: "risk", descending: true, onSort() { throw new Error("Navigation must not sort"); } });
  const buttons = () => walk(render()).filter(node => node.type === "button" && node.props.className === "account-link");
  const nodes = ids.map(id => ({ focus() { focused.push(id); } }));
  const press = (index, key, extra = {}) => {
    let prevented = false;
    buttons()[index].props.onKeyDown({ key, preventDefault() { prevented = true; },
      currentTarget: { closest(selector) { assert.equal(selector, "tbody"); return { querySelectorAll(selector) {
        assert.equal(selector, "button.account-link"); return nodes;
      } }; } }, ...extra }); return prevented;
  };
  return { rows, selected, focused, render, buttons, press };
}

test("arrows follow the displayed sorted/filtered row order through the same exact selection callback as click", () => {
  for (const order of [["risk-high", "risk-mid", "risk-low"], ["risk-low", "risk-high"], ["risk-mid", "risk-low", "risk-high"]]) {
    const app = setup(order), before = JSON.stringify(app.rows);
    assert.equal(app.press(0, "ArrowDown"), true); assert.deepEqual(app.selected, [order[1]]); assert.deepEqual(app.focused, [order[1]]);
    assert.equal(app.buttons()[1].props["aria-pressed"], true); assert.equal(app.buttons()[0].props["aria-pressed"], false);
    app.buttons()[0].props.onClick(); assert.equal(app.selected.at(-1), order[0]);
    app.press(1, "ArrowUp"); assert.equal(app.selected.at(-1), order[0]); assert.equal(app.focused.at(-1), order[0]);
    assert.equal(JSON.stringify(app.rows), before); assert.equal(app.buttons()[0].props["aria-keyshortcuts"], "ArrowUp ArrowDown");
  }
});

test("boundaries, single/empty rows and ordinary or modified keys preserve native keyboard behavior without selecting unrelated accounts", () => {
  const app = setup(["a", "b"]);
  assert.equal(app.press(0, "ArrowUp"), true); assert.equal(app.press(1, "ArrowDown"), true);
  for (const [key, extra] of [["Enter", {}], ["Tab", {}], ["ArrowLeft", {}], ["ArrowDown", { ctrlKey: true }],
    ["ArrowUp", { shiftKey: true }], ["ArrowDown", { altKey: true }], ["ArrowUp", { metaKey: true }]]) assert.equal(app.press(0, key, extra), false);
  assert.deepEqual(app.selected, []); assert.deepEqual(app.focused, []);
  const single = setup(["only"]); single.press(0, "ArrowDown"); single.press(0, "ArrowUp"); assert.deepEqual(single.selected, []);
  assert.equal(setup([]).buttons().length, 0);
});
