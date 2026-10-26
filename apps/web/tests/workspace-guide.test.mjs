import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
const selected = { account: { id: "account", name: "<script>Account</script>", organization_id: "org", revision: 2, annual_value: null, renewal_date: null },
  source: { id: "source" }, assessment: { as_of: "2026-10-27", snapshot_hash: "hash", requires_review: true } };
const portfolio = { organization_id: "org", as_of: "2026-10-27", mode: "local_sample", accounts: [selected] };
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function GuideTargetMarker() { return null; }
function setup() {
  let step = 0, props = { portfolio, selected, persona: "seller", context: "current", root: { current: null } }, session = { mode: "session", actor: { id: "actor", organization_id: "org", role: "viewer" } };
  const filename = fileURLToPath(new URL("../components/workspace-guide.tsx", import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename)); const normal = target.require.bind(target);
  target.require = name => name === "react" ? { ...React, useState: () => [step, value => { step = typeof value === "function" ? value(step) : value; }] }
    : name === "next/link" ? { __esModule: true, default: p => React.createElement("a", p) }
      : name === "./guide-target" ? { GuideTarget: GuideTargetMarker }
      : name === "./session-gate" ? { useSession: () => session } : normal(name);
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, filename);
  const outer = () => target.exports.WorkspaceGuide(props), render = () => { const node = outer(); return node ? node.type(node.props) : null; };
  return { outer, render, html: () => renderToStaticMarkup(render()), props(value) { props = { ...props, ...value }; }, session(value) { session = value; },
    click(name) { walk(render()).find(x => x.type === "button" && x.props.children === name).props.onClick(); } };
}

test("opt-in guide advances local instructions only, retains exact context, Unknowns and viewer/governance boundaries", () => {
  const app = setup(), original = JSON.stringify(portfolio); assert.equal(app.render().type, "details"); assert.match(app.html(), /Seller: inspect saved recommendations/);
  assert.match(app.html(), /role is viewer/); assert.match(app.html(), /Synthetic sample/); app.click("Back"); assert.match(app.html(), /Step 1 of 4/);
  app.click("Next"); assert.match(app.html(), /Annual value Unknown/); assert.match(app.html(), /Evidence review is required/); assert.match(app.html(), /&lt;script&gt;Account/);
  let links = walk(app.render()).filter(x => x.props?.href); assert.equal(links[0].props.href, "/accounts?persona=seller&account=account");
  app.click("Next"); assert.match(app.html(), /Viewers can inspect saved work but cannot/); assert.match(app.html(), /unknown execution result needs reconciliation/);
  links = walk(app.render()).filter(x => x.props?.href); assert.equal(links[0].props.href, "/missions?account=account");
  app.click("Next"); assert.match(app.html(), /does not establish onboarding, mission or business completion/);
  assert.deepEqual(walk(app.render()).filter(x => x.props?.href).map(x => x.props.href), ["/walkthrough?account=account", "/tester-guide"]);
  app.click("Restart guide"); assert.match(app.html(), /Step 1 of 4/); assert.equal(JSON.stringify(portfolio), original);
  assert.equal(walk(app.render()).filter(x => x.type === "form").length, 0);
});

test("perspective, current role and source labels derive from loaded state without inferred readiness", () => {
  const app = setup(); app.props({ persona: "executive", portfolio: { ...portfolio, mode: "mixed" } }); assert.match(app.html(), /Executive: inspect server-ranked/); assert.match(app.html(), /Mixed synthetic/);
  app.props({ persona: "operations" }); assert.match(app.html(), /Operations: inspect saved mission attention/); assert.match(app.html(), /do not certify facts or connector health/);
  app.session({ mode: "sample", actor: null }); assert.match(app.html(), /Sample mode has no mission review authority/);
  app.session({ mode: "session", actor: { id: "seller", organization_id: "org", role: "seller" } }); app.click("Next"); app.click("Next"); assert.match(app.html(), /current admin or reviewer must make/);
});

test("empty, crossed and absent session states never invent an account or private mission context", () => {
  const app = setup(); app.props({ portfolio: { ...portfolio, accounts: [] }, selected: null }); app.click("Next"); assert.match(app.html(), /No account is selected/);
  app.click("Next"); assert.equal(walk(app.render()).filter(x => x.props?.href).length, 0);
  for (const session of [null, { mode: "session", actor: null }, { mode: "session", actor: { organization_id: "foreign" } }]) { app.session(session); assert.equal(app.render(), null); }
  app.session({ mode: "sample" }); app.props({ portfolio, selected: { ...selected, account: { ...selected.account, organization_id: "foreign" } } }); assert.equal(app.render(), null);
  app.props({ selected: { ...selected } }); assert.equal(app.render(), null);
});

test("actual actor/account/source/date/hash and perspective keys reset presentation on scope changes", () => {
  const app = setup(), key = app.outer().key;
  for (const next of [{ ...selected, account: { ...selected.account, revision: 3 } }, { ...selected, source: { id: "other" } },
    { ...selected, assessment: { ...selected.assessment, snapshot_hash: "other" } }]) {
    app.props({ portfolio: { ...portfolio, accounts: [next] }, selected: next }); assert.notEqual(app.outer().key, key);
  }
  app.props({ portfolio, selected, persona: "operations" }); assert.notEqual(app.outer().key, key);
  app.props({ persona: "seller" }); app.session({ mode: "session", actor: { id: "actor", organization_id: "org", role: "admin" } }); assert.notEqual(app.outer().key, key);
});

test("each instruction maps to its actual focus target without navigating or changing data", () => {
  const app = setup(), original = JSON.stringify(portfolio), key = app.outer().key;
  for (const [index, target] of ["perspective", "evidence", "missions", "walkthrough"].entries()) {
    const tree = app.render(), focus = walk(tree).find(node => node.type === GuideTargetMarker);
    assert.equal(focus.props.target, target); assert.equal(focus.props.context, "current"); assert.equal(focus.key, String(index));
    if (index >= 2) assert.equal(walk(tree).filter(node => node.props?.["data-guide-target"] === target).length, 1);
    if (index < 3) app.click("Next");
  }
  app.props({ context: "new-source-generation" }); assert.notEqual(app.outer().key, key);
  assert.equal(JSON.stringify(portfolio), original);
});
