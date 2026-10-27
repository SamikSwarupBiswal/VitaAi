import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), target = new Module(filename);
  target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target);
  target.require = name => mocks[name] ?? (name.startsWith("./") && relative.startsWith("../lib/") ? load(`../lib/${name.slice(2)}.ts`, mocks) : normal(name));
  target._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022,
  } }).outputText, filename); return target.exports;
}
const id = "11111111-1111-4111-8111-111111111111", account = "22222222-2222-4222-8222-222222222222";
const item = () => ({ id, organization_id: "org", account_id: account, revision: 1, state: "active", visibility: "organization",
  captured_by: "actor", created_at: "2026-10-27T01:00:00Z", source: { pipeline_id: id, actor_id: "original", started_at: "2026-10-26T00:00:00Z", as_of: "2026-10-26" },
  context: { account: { id: account, organization_id: "org", annual_value: null, renewal_date: null }, evidence: [{ id: "fact", account_id: account, organization_id: "org", source: "SYNTHETIC", observed_at: "2026-10-20", fact: "<script>Unknown</script>" }] },
  recommendation: { account_id: account, action: { kind: "manual_review", rationale: "Retained proposal" } } });
const history = () => ({ organization_id: "org", account_id: account, limit: 20, total_count: 1, has_more: false, items: [item()] });
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function setup(t, role = "admin", subject = "memory") {
  const slots = [], cleanups = [], requests = [], events = new Map(); let cursor = 0, effects = [];
  const old = globalThis.window;
  const navigations = [];
  globalThis.window = { location: { assign(value) { navigations.push(value); } }, addEventListener(name, fn) { if (!events.has(name)) events.set(name, new Set()); events.get(name).add(fn); }, removeEventListener(name, fn) { events.get(name)?.delete(fn); } };
  const effect = (fn, deps) => { const i = cursor++; if (!(i in slots) || deps.some((x, n) => x !== slots[i][n])) { slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } };
  const hooks = { ...React, useEffect: effect, useLayoutEffect: effect,
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; } };
  const helper = load("../lib/memory.ts");
  const component = load(`../components/${subject}-panel.tsx`, { react: hooks, "@/lib/memory": helper, "@/lib/companion": load("../lib/companion.ts"),
    "./voice-controls": { VoiceControls: () => null },
    "./avatar-controls": { AvatarControls: () => null },
    "@/lib/pipeline-history": load("../lib/pipeline-history.ts"), "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: "actor", organization_id: "org", role } }) } });
  const render = () => { cursor = 0; const outer = (component.MemoryPanel ?? component.CompanionPanel)({ view: { account: { id: account, organization_id: "org", revision: 1 }, assessment: { snapshot_hash: "hash" } } });
    const tree = outer.type(outer.props), pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  const unmount = () => cleanups.forEach(fn => fn?.());
  t.after(() => { unmount(); globalThis.window = old; });
  return { requests, render, unmount, navigations, button: name => walk(render()).find(node => node.type === "button" && node.props.children === name),
    emit(name) { for (const fn of events.get(name) ?? []) fn(); }, async list(value = history()) { const pending = this.button("Inspect account memory").props.onClick(); requests.shift().resolve(value); await pending; } };
}
test("memory validation rejects crossed scope and inconsistent coverage", () => {
  const helper = load("../lib/memory.ts"); helper.validateMemoryHistory(history(), "org", account);
  for (const mutate of [x => x.organization_id = "foreign", x => x.items[0].context.evidence[0].account_id = "foreign", x => x.total_count = 3]) {
    const value = history(); mutate(value); assert.throws(() => helper.validateMemoryHistory(value, "org", account));
  }
});
test("memory history is explicit with original dates, Unknowns and escaped facts; viewers cannot change lifecycle", async t => {
  const app = setup(t, "viewer"); app.render(); assert.equal(app.requests.length, 0); await app.list();
  const html = renderToStaticMarkup(app.render());
  for (const value of ["2026-10-26T00:00:00Z", "original", "Unknown", "Retained proposal", "SYNTHETIC"]) assert.ok(html.includes(value));
  assert.match(html, /&lt;script&gt;/); assert.equal(app.button("Archive memory"), undefined);
});
test("duplicate reads, captured lifecycle handlers and obsolete results are fenced", async t => {
  const app = setup(t); const button = app.button("Inspect account memory"); const first = button.props.onClick(); await button.props.onClick();
  assert.equal(app.requests.length, 1); app.requests.shift().resolve(history()); await first;
  const oldEvents = app.button("Inspect memory events"); app.emit("focus"); await oldEvents.props.onClick(); assert.equal(app.requests.length, 0);
  const late = app.button("Inspect account memory").props.onClick(), request = app.requests.shift(); app.unmount(); request.resolve(history()); await late;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Retained proposal/);
});

test("companion navigation denies arbitrary, crossed and incomplete targets", () => {
  const { navigationHref } = load("../lib/companion.ts");
  assert.equal(navigationHref({ target: "mission", account_id: account, mission_id: id, step: "Outcome" }, account), `/missions?account=${account}&mission=${id}&step=Outcome`);
  for (const value of [{ target: "execute", account_id: account }, { target: "account", account_id: id },
    { target: "mission", account_id: account, mission_id: "https://foreign", step: "Outcome" },
    { target: "mission", account_id: account, mission_id: id, step: "send" }]) assert.equal(navigationHref(value, account), null);
});

test("companion questions cite context and duplicate/captured handlers cannot submit or navigate", async t => {
  const app = setup(t, "admin", "companion"); app.render(); assert.equal(app.requests.length, 0);
  const start = app.button("Start sourced conversation").props.onClick();
  app.requests.shift().resolve({ id, actor_id: "actor", organization_id: "org", account_id: account, revision: 1, snapshot_hash: "hash", persona: "companion" }); await start;
  const textarea = walk(app.render()).find(node => node.type === "textarea"); textarea.props.onChange({ target: { value: "Explain risk" } });
  const ask = app.button("Ask from this context"), first = ask.props.onClick(); await ask.props.onClick(); assert.equal(app.requests.length, 1);
  const request = app.requests.shift(); assert.equal(JSON.parse(request.init.body).message, "Explain risk");
  request.resolve({ id, organization_id: "org", session_id: id, number: 1, mode: "deterministic_sourced", status: "answered", message: "Explain risk", answer: "<script>Sourced answer</script>",
    citations: [{ kind: "evidence", id: "fact", label: "Synthetic", text: "Original source", source_time: "2026-10-20" }], caveats: ["Uncertainty retained"], navigation: { target: "evidence", account_id: account } }); await first;
  const html = renderToStaticMarkup(app.render()); assert.match(html, /&lt;script&gt;Sourced answer/); assert.match(html, /Original source/);
  const link = walk(app.render()).find(node => node.type === "a" && node.props.children === "Open cited workspace");
  app.emit("focus"); let prevented = false; link.props.onClick({ preventDefault() { prevented = true; } }); assert.ok(prevented);
  await ask.props.onClick(); assert.equal(app.requests.length, 0);
});

test("portfolio account citations verify the same source snapshot before navigation and cancel captured controls", async t => {
  const app = setup(t, "admin", "companion");
  const start = app.button("Start sourced conversation").props.onClick();
  app.requests.shift().resolve({ id, actor_id: "actor", organization_id: "org", account_id: account, revision: 1, snapshot_hash: "hash", persona: "companion" });
  await start;
  const textarea = walk(app.render()).find(node => node.type === "textarea");
  textarea.props.onChange({ target: { value: "Portfolio priorities" } });
  const ask = app.button("Ask from this context").props.onClick();
  app.requests.shift().resolve({ id, organization_id: "org", session_id: id, number: 1, mode: "deterministic_sourced",
    status: "answered", message: "Portfolio priorities", answer: "Original portfolio", caveats: [], navigation: null,
    citations: [{ kind: "account", id, account_snapshot_hash: "a".repeat(64), label: "Other account", source_time: "2026-10-27T01:00:00Z", text: "Original snapshot and evidence dates" },
      { kind: "account", id: "https://foreign.invalid", label: "Invalid", source_time: null, text: "No arbitrary destination" }] });
  await ask;
  const links = walk(app.render()).filter(node => node.type === "a" && node.props.children === "Open cited account (verify same snapshot)");
  assert.equal(links.length, 1); assert.equal(links[0].props.href, `/accounts?account=${id}`);
  let clicked = false; const navigation = links[0].props.onClick({ preventDefault() { clicked = true; } });
  assert.ok(clicked); assert.equal(app.navigations.length, 0); assert.equal(app.requests[0].url, `accounts/${id}`);
  app.requests.shift().resolve({ account: { id, organization_id: "org" }, assessment: { snapshot_hash: "a".repeat(64) }, evidence: [] }); await navigation;
  assert.deepEqual(app.navigations, [`/accounts?account=${id}`]);
  app.emit("focus"); let prevented = false;
  links[0].props.onClick({ preventDefault() { prevented = true; } });
  assert.ok(prevented); assert.equal(app.requests.length, 0);
});

test("portfolio drilldown rejects missing hashes, another account/organization and changed snapshots", () => {
  const { accountCitationHref, accountCitationMatches } = load("../lib/companion.ts");
  const citation = { kind: "account", id, account_snapshot_hash: "a".repeat(64) };
  const target = { account: { id, organization_id: "org" }, assessment: { snapshot_hash: "a".repeat(64) }, evidence: [] };
  assert.ok(accountCitationMatches(citation, target, "org")); assert.equal(accountCitationHref({ ...citation, account_snapshot_hash: null }), null);
  for (const changed of [{ ...target, account: { id: account, organization_id: "org" } }, { ...target, account: { id, organization_id: "foreign" } },
    { ...target, assessment: { snapshot_hash: "b".repeat(64) } }, { ...target, evidence: [{ account_id: account, organization_id: "org" }] }]) {
    assert.equal(accountCitationMatches(citation, changed, "org"), false);
  }
});
