import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const filename = fileURLToPath(new URL("../components/coaching-panel.tsx", import.meta.url));
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const walk = (node, predicate) => Array.isArray(node) ? node.flatMap(item => walk(item, predicate))
  : !node || typeof node !== "object" ? [] : [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const data = { mission: { id: "mission", organization_id: "org", revision: 8, status: "completed" },
  outcomes: [{ id: "outcome", revision: 2 }, { id: "corrected", revision: 3 }] };
const review = { id: "review", mission_id: "mission", organization_id: "org", revision: 1,
  mission_revision: 7, outcome_id: "outcome", outcome_revision: 2, supersedes_id: null,
  reviewer_id: "reviewer", created_at: "2026-10-23T10:00:00Z", status: "revision_required", note: "<script>Human note</script>" };
function setup() {
  let active;
  const requests = [], changes = [];
  globalThis.window = { dispatchEvent: event => changes.push(event.type) };
  const hooks = {
    useState(initial) { const a = active, i = a.cursor++; if (!(i in a.slots)) a.slots[i] = initial;
      return [a.slots[i], value => { a.slots[i] = value; }]; },
    useRef(initial) { const a = active, i = a.cursor++; if (!(i in a.slots)) a.slots[i] = { current: initial }; return a.slots[i]; },
    useEffect(callback, deps) { const a = active, i = a.cursor++;
      if (!(i in a.slots) || deps.some((value, index) => value !== a.slots[i][index])) {
        a.slots[i] = deps; a.effects.push(() => { a.cleanups[i]?.(); a.cleanups[i] = callback(); });
      } },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const request = (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => name === "react" ? hooks : name === "@/lib/api" ? { api: request }
    : name === "@/lib/workflow" ? { postWorkflow: (url, body, signal) => request(url, { body, signal, method: "POST" }) }
    : name === "./session-gate" ? { useSession: () => ({ actor: { id: "actor", organization_id: "org", role: active.role } }) } : normal(name);
  target._compile(compiled, filename);
  function mount(role = "reviewer", view = data) {
    const a = { role, view, blocked: false, cursor: 0, slots: [], effects: [], cleanups: [], refreshes: [] };
    const render = () => { active = a; a.cursor = 0;
      const outer = target.exports.CoachingPanel({ data: a.view, blocked: a.blocked, refresh: message => a.refreshes.push(message) });
      const tree = outer ? outer.type(outer.props) : null;
      const effects = a.effects; a.effects = []; effects.forEach(run => run()); return tree; };
    const find = type => walk(render(), node => node.type === type)[0];
    return { a, render, find, unmount: () => a.cleanups.forEach(run => run?.()) };
  }
  return { mount, requests, changes };
}

test("history preserves outcome, actor, date and escaped human text without verified impact", async () => {
  const app = setup(), view = app.mount("viewer"); view.render();
  assert.equal(app.requests.length, 1); app.requests.shift().resolve([review]); await flush();
  const html = renderToStaticMarkup(view.render());
  assert.match(html, /Historical review of an earlier outcome/); assert.match(html, /2026-10-23T10:00:00Z/);
  assert.match(html, /&lt;script&gt;Human note/); assert.doesNotMatch(html, /<script>/);
  assert.equal(view.find("form"), undefined); assert.match(html, /not independently verified customer results/);
  view.unmount();
});

test("save binds latest outcome and coaching revision; duplicate/remount replay is blocked", async () => {
  const app = setup(), view = app.mount(); view.render(); app.requests.shift().resolve([review]); await flush();
  view.find("textarea").props.onChange({ target: { value: "  Clarification\n " } });
  view.find("select").props.onChange({ target: { value: "reviewed" } });
  const submit = view.find("form").props.onSubmit;
  const pending = submit({ preventDefault() {} }); submit({ preventDefault() {} });
  assert.equal(app.requests.length, 1);
  const post = app.requests.shift(); assert.equal(post.init.method, "POST");
  assert.deepEqual(post.init.body, { schema_version: "1", expected_revision: 1, expected_mission_revision: 8, outcome_id: "corrected",
    expected_outcome_revision: 3, status: "reviewed", note: "  Clarification\n " });
  view.unmount();
  const remount = app.mount(); remount.render(); app.requests.shift().resolve([review]); await flush();
  remount.find("textarea").props.onChange({ target: { value: "Second" } });
  await remount.find("form").props.onSubmit({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  post.reject(new Error("lost response")); await pending;
  assert.deepEqual(app.changes, ["vitaai-workflow-changed"]); assert.equal(view.a.refreshes.length, 0);
  assert.equal(app.requests.length, 0); remount.unmount();
});

test("failed/crossed history, blocked snapshots and captured unmounted handlers cannot write", async () => {
  for (const records of [null, [{ ...review, mission_id: "foreign" }], [{ ...review, outcome_id: "foreign" }]]) {
    const app = setup(), view = app.mount(); view.render(); const read = app.requests.shift();
    if (records) read.resolve(records); else read.reject(new Error("unavailable")); await flush();
    view.find("textarea").props.onChange({ target: { value: "Note" } });
    await view.find("form").props.onSubmit({ preventDefault() {} });
    assert.equal(app.requests.length, 0); assert.ok(view.find("fieldset").props.disabled); view.unmount();
  }
  const app = setup(), view = app.mount(); view.render(); app.requests.shift().resolve([]); await flush();
  view.find("textarea").props.onChange({ target: { value: "Note" } });
  const submit = view.find("form").props.onSubmit; view.a.blocked = true; view.render();
  await submit({ preventDefault() {} }); assert.equal(app.requests.length, 0);
  view.a.blocked = false; view.render(); view.unmount(); await submit({ preventDefault() {} });
  assert.equal(app.requests.length, 0);
});

test("completion and seller gates expose no mutation; late history stays suppressed", async () => {
  const app = setup();
  for (const status of ["draft", "rejected", "reconciliation_required", "superseded"]) {
    assert.equal(app.mount("reviewer", { ...data, mission: { ...data.mission, status } }).render(), null);
  }
  const seller = app.mount("seller"); seller.render(); const request = app.requests.shift(); seller.unmount();
  request.resolve([review]); await flush(); assert.equal(seller.a.slots[0], null);
  assert.equal(seller.find("form"), undefined); seller.unmount(); assert.equal(app.requests.length, 0);
});
