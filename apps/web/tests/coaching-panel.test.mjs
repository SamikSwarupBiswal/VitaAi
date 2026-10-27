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
const report = { kind: "follow_up_required", basis: "manual_report", evidence_ids: ["original-fact"] };
const data = { mission: { id: "mission", organization_id: "org", owner_id: "recorded-owner", revision: 8, status: "completed" },
  outcomes: [{ id: "outcome", revision: 2, report, observed_at: "2026-10-22T10:00:00Z" },
    { id: "corrected", revision: 3, report, observed_at: "2026-10-23T09:00:00Z" }] };
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
  return { mount, requests, changes, guidance: target.exports.coachingGuidance };
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

test("discussion guidance cites the exact saved human report without predicting impact or filling missing evidence", () => {
  const app = setup(), value = app.guidance(data);
  assert.match(value.focus, /follow up required.*mission/);
  assert.match(value.discussion, /corrected revision 3.*unverified human/);
  assert.match(value.practice, /without predicting a customer response/);
  assert.match(value.follow_up, /does not authorize customer activity/);
  const missing = { ...data, outcomes: [{ ...data.outcomes[1], report: { ...report, evidence_ids: [] } }] };
  const view = app.mount("viewer", missing), html = renderToStaticMarkup(view.render());
  assert.match(html, /None recorded; resolve the source gap/); assert.match(html, /recorded owner recorded-owner/);
  view.unmount();
});

test("internal plan is explicit, editable, exact-report bound and omitted from ordinary reviews", async () => {
  const app = setup(), view = app.mount(); view.render(); app.requests.shift().resolve([]); await flush();
  view.find("textarea").props.onChange({ target: { value: "Human reviewed the original report." } });
  const checkbox = walk(view.render(), node => node.type === "input" && node.props.type === "checkbox")[0];
  assert.equal(checkbox.props.checked, false);
  checkbox.props.onChange({ target: { checked: true } });
  const fields = walk(view.render(), node => node.type === "textarea" && node.props["aria-label"] === "Internal follow-up");
  assert.equal(fields.length, 1); fields[0].props.onChange({ target: { value: "  Follow up on the saved uncertainty.\n " } });
  const saved = view.find("form").props.onSubmit({ preventDefault() {} }), post = app.requests.shift();
  assert.equal(post.init.body.intervention.follow_up, "  Follow up on the saved uncertainty.\n ");
  assert.equal(post.init.body.outcome_id, "corrected"); assert.equal(post.init.body.expected_outcome_revision, 3);
  assert.equal(post.init.body.expected_mission_revision, 8); assert.equal(post.init.body.intervention_owner_id, undefined);
  post.resolve({}); await saved; view.unmount();
});

test("unreviewed, invalid or crossed internal plans cannot submit or become accepted history", async () => {
  const plan = setup().guidance(data);
  for (const changed of [{ status: "revision_required" }, { planText: " " }, { planText: "x".repeat(2001) }, { planText: "a\0b" }]) {
    const app = setup(), view = app.mount(); view.render(); app.requests.shift().resolve([]); await flush();
    view.find("textarea").props.onChange({ target: { value: "Human note" } });
    walk(view.render(), node => node.type === "input" && node.props.type === "checkbox")[0].props.onChange({ target: { checked: true } });
    if (changed.status) view.find("select").props.onChange({ target: { value: changed.status } });
    if (changed.planText !== undefined) walk(view.render(), node => node.type === "textarea" && node.props["aria-label"] === "Coaching focus")[0]
      .props.onChange({ target: { value: changed.planText } });
    await view.find("form").props.onSubmit({ preventDefault() {} }); assert.equal(app.requests.length, 0); view.unmount();
  }
  const app = setup(), view = app.mount(); view.render();
  app.requests.shift().resolve([{ ...review, status: "reviewed", intervention: plan, intervention_owner_id: "foreign" }]); await flush();
  assert.match(renderToStaticMarkup(view.render()), /Coaching history unavailable/); view.unmount();
});

test("saved internal plans retain escaped original text, owner and historical report binding", async () => {
  const app = setup(), view = app.mount("viewer"); view.render();
  app.requests.shift().resolve([{ ...review, status: "reviewed", intervention_owner_id: "recorded-owner",
    intervention: { ...app.guidance(data), focus: "<script>Original coaching focus</script>" } }]); await flush();
  const html = renderToStaticMarkup(view.render());
  assert.match(html, /Historical internal coaching plan/); assert.match(html, /recorded owner recorded-owner/);
  assert.match(html, /&lt;script&gt;Original coaching focus/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /no notification, recipient acceptance or coaching effectiveness/); view.unmount();
});

test("a later review without a plan makes an earlier plan historical even for the same report", async () => {
  const app = setup(), view = app.mount("viewer"), first = { ...review, status: "reviewed", outcome_id: "corrected", outcome_revision: 3,
    intervention_owner_id: "recorded-owner", intervention: app.guidance(data) };
  view.render(); app.requests.shift().resolve([first, { ...review, id: "new-review", revision: 2, supersedes_id: first.id,
    status: "reviewed", outcome_id: "corrected", outcome_revision: 3 }]); await flush();
  const html = renderToStaticMarkup(view.render()); assert.match(html, /Historical internal coaching plan/);
  assert.doesNotMatch(html, /Planned internal coaching intervention/); view.unmount();
});
