import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const view = { account: { id: "account", organization_id: "org", revision: 3, name: "A <source>" },
  source: { id: "source" }, assessment: { as_of: "2026-10-27", snapshot_hash: "hash" } };
const base = { organization_id: "org", account_id: "account", account_revision: 3 };
const values = [
  { ...base, authorization: { id: "original-grant", status: "revoked", expires_at: "2026-10-23T10:00:00Z" },
    can_authorize: false, worker_available: false, pending_occurrence_id: "pending-occurrence" },
  { ...base, ingestion_enabled: true, connector_configured: true, can_start: false, reason: "ingestion_pending",
    pending_run_id: "pending-ingestion", cooldown_until: "2026-10-24T10:00:00Z" },
  { ...base, live_status: "unconfigured", can_start: false, pending_run_id: null, next_start_at: null },
  { ...base, configured: true, can_start: true, pending_run_id: null, next_start_at: null, snapshot_hash: "hash" },
  { ...base, write_configured: false, readback_configured: true, can_prepare: false, can_reconcile: false,
    destination: { provider: "hubspot", target_account_id: "account" } },
  { configured: true, connected: false, write_configured: true, refresh_pending: true,
    binding_id: null, mailbox_id: null, expires_at: null },
];
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object"
  ? [node, ...walk(node.props?.children)] : [];

function environment(t, initialSession = { mode: "session", actor: { id: "viewer", role: "viewer", organization_id: "org" } }) {
  const requests = [], calls = [], listeners = new Map(), prior = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); },
    removeEventListener(name, fn) { listeners.get(name)?.delete(fn); } };
  t.after(() => { globalThis.window = prior; });
  let session = initialSession, sessionResult, cursor = 0, effects = [], cleanups = [], selected = view;
  const slots = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i].deps[j])) slots[i] = { fn, deps }; return slots[i].fn; },
    useEffect(fn, deps) { const i = cursor++; if (!(i in slots) || deps.some((v, j) => v !== slots[i][j])) {
      slots[i] = deps; effects.push(() => { cleanups[i]?.(); cleanups[i] = fn(); }); } },
  };
  hooks.useLayoutEffect = hooks.useEffect;
  const filename = fileURLToPath(new URL("../components/operations-readiness.tsx", import.meta.url));
  const output = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const mod = new Module(filename); mod.filename = filename; mod.paths = Module._nodeModulePaths(path.dirname(filename));
  const mocks = { react: hooks, "./session-gate": { useSession: () => session },
    "@/lib/api": { api: (url, init) => {
      calls.push({ url, init });
      if (url === "auth/session") return sessionResult instanceof Error ? Promise.reject(sessionResult) : Promise.resolve(sessionResult ?? session);
      return new Promise((resolve, reject) => requests.push({ url, init, resolve, reject }));
    } } };
  const normal = mod.require.bind(mod); mod.require = name => name in mocks ? mocks[name] : normal(name);
  mod._compile(output, filename);
  const render = () => { cursor = 0; const tree = mod.exports.OperationsReadiness({ view: selected });
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  function reply(batch = requests.splice(0), records = values, current = selected) {
    assert.equal(batch.length, 7); assert.ok(batch.every(r => !r.init.method && r.init.signal));
    batch[0].resolve(current);
    batch.slice(1).forEach((r, i) => records[i] instanceof Error ? r.reject(records[i]) : r.resolve(records[i]));
  }
  return { requests, calls, reply, render, read: (value, signal, actor = initialSession.actor) => mod.exports.readOperationsReadiness(value, signal, actor),
    button: () => walk(render()).find(n => n.type === "button"),
    select(value) { selected = value; }, actor(value) { session = value; },
    sessionResult(value) { sessionResult = value; },
    unmount() { cleanups.forEach(fn => fn?.()); }, listeners };
}

test("readiness reads only current scoped local records and retains pending IDs and original dates", async t => {
  const env = environment(t), pending = env.read(view, new AbortController().signal);
  assert.deepEqual(env.requests.map(r => r.url), ["accounts/account", "integrations/hubspot/accounts/account/refresh-schedule",
    "integrations/hubspot/accounts/account/ingestions/readiness", "integrations/research/accounts/account/readiness", "provider-comparison/accounts/account/readiness",
    "integrations/hubspot/accounts/account/execution-readiness", "integrations/microsoft"]);
  env.reply(); const rows = await pending;
  assert.match(rows[0].detail, /pending-occurrence.*original-grant.*revoked.*2026-10-23T10:00:00Z/);
  assert.match(rows[1].detail, /pending-ingestion.*2026-10-24T10:00:00Z/);
  assert.match(rows[2].detail, /Live service unconfigured/); assert.match(rows[3].detail, /Configured, unverified/);
  assert.match(rows[4].detail, /Writes unavailable; retained-ID readback configured, unverified.*Preparation role capability unavailable/);
  assert.match(rows[5].detail, /Current signed-in actor.*refresh pending.*not the saved action maker/);
  assert.equal(env.calls.at(-1).url, "auth/session"); assert.ok(env.calls.every(call => !call.init.method && call.init.signal));
});

test("an unavailable or crossed integration hides only that row; crossed account verification rejects all", async t => {
  const env = environment(t);
  for (const bad of [new Error("private upstream error"), { ...values[1], account_id: "foreign", pending_run_id: "private-pending" },
    { ...values[1], organization_id: "foreign" }, { ...values[1], account_revision: 2 }]) {
    const pending = env.read(view, new AbortController().signal); env.reply(undefined, [values[0], bad, ...values.slice(2)]);
    const rows = await pending; assert.match(rows[1].detail, /Read unavailable/); assert.match(rows[0].detail, /original-grant/);
    assert.doesNotMatch(JSON.stringify(rows), /private/);
  }
  for (const current of [{ ...view, account: { ...view.account, revision: 4 } }, { ...view, source: { id: "changed" } },
    { ...view, assessment: { ...view.assessment, snapshot_hash: "other" } }, { ...view, account: { ...view.account, organization_id: "foreign" } },
    { ...view, assessment: { ...view.assessment, as_of: "2026-10-28" } }]) {
    const pending = env.read(view, new AbortController().signal); env.reply(undefined, values, current);
    await assert.rejects(pending, /Current account unavailable/);
  }
});

test("viewer summary preserves escaped text and links only to existing read-only control targets", async t => {
  const env = environment(t); env.render(); await flush(); env.reply(); await flush();
  const tree = env.render(), html = renderToStaticMarkup(tree);
  assert.match(html, /A &lt;source&gt;/); assert.match(html, /No provider request was made/); assert.match(html, /pending-occurrence/);
  assert.deepEqual(walk(tree).filter(n => n.type === "a").map(n => n.props.href),
    ["#scheduled-staging", "#associated-records", "#advisory-research", "#provider-comparison", "/missions?account=account", "/missions?account=account"]);
  assert.equal(walk(tree).filter(n => n.type === "form").length, 0); assert.equal(env.requests.length, 0); env.unmount();
});

test("refresh clears prior success and late reads cannot replace the latest result", async t => {
  const env = environment(t); env.render(); await flush(); env.reply(); await flush();
  const first = env.button().props.onClick(); const obsolete = env.requests.splice(0);
  assert.doesNotMatch(renderToStaticMarkup(env.render()), /original-grant/);
  const latest = env.button().props.onClick(); const fresh = env.requests.splice(0);
  env.reply(fresh, [{ ...values[0], authorization: null, pending_occurrence_id: null }, ...values.slice(1)]); await latest;
  env.reply(obsolete); await first;
  assert.doesNotMatch(renderToStaticMarkup(env.render()), /original-grant/);
  const failed = env.button().props.onClick(), batch = env.requests.splice(0); batch[0].reject(new Error("read failed"));
  batch.slice(1).forEach((r, i) => r.resolve(values[i])); await failed;
  assert.match(renderToStaticMarkup(env.render()), /Current readiness unavailable/); assert.equal(env.requests.length, 0); env.unmount();
});

test("sample mode makes no private read; account and actor changes cancel and hide prior records", async t => {
  const sample = environment(t, { mode: "sample", actor: null }); sample.render(); await flush();
  assert.equal(sample.requests.length, 0); assert.match(renderToStaticMarkup(sample.render()), /Sign in/); sample.unmount();
  const env = environment(t); env.render(); await flush(); const batch = env.requests.splice(0);
  env.select({ ...view, account: { ...view.account, id: "other" } }); env.render(); await flush();
  assert.ok(batch.every(r => r.init.signal.aborted)); env.reply(batch); await flush();
  assert.doesNotMatch(renderToStaticMarkup(env.render()), /original-grant/);
  env.actor({ mode: "session", actor: { id: "foreign", role: "viewer", organization_id: "foreign" } });
  env.render(); await flush(); const prior = env.requests.splice(0); assert.ok(prior.every(r => r.init.signal.aborted));
  assert.match(renderToStaticMarkup(env.render()), /Sign in/); env.unmount();
});

test("execution and Microsoft failures remain independent and crossed destinations never become readiness", async t => {
  const env = environment(t);
  for (const bad of [new Error("private upstream body"), { ...values[4], account_id: "foreign" },
    { ...values[4], organization_id: "foreign" }, { ...values[4], account_revision: 2 },
    { ...values[4], destination: { provider: "microsoft", target_account_id: "account" } },
    { ...values[4], destination: { provider: "hubspot", target_account_id: "foreign" } },
    { ...values[4], can_prepare: true }, { ...values[4], can_reconcile: true }, { ...values[4], readback_configured: true, destination: null }]) {
    const pending = env.read(view, new AbortController().signal); env.reply(undefined, [...values.slice(0, 4), bad, values[5]]);
    const rows = await pending;
    assert.match(rows[4].detail, /Read unavailable/); assert.match(rows[5].detail, /refresh pending/); assert.match(rows[0].detail, /original-grant/);
    assert.doesNotMatch(JSON.stringify(rows), /private upstream|foreign/);
  }
  for (const bad of [new Error("private Microsoft body"), null, "wrong response", { ...values[5], refresh_pending: "yes" },
    { ...values[5], connected: true }, { ...values[5], expires_at: Infinity }]) {
    const pending = env.read(view, new AbortController().signal); env.reply(undefined, [...values.slice(0, 5), bad]);
    const rows = await pending;
    assert.match(rows[5].detail, /Read unavailable/); assert.match(rows[4].detail, /retained-ID readback configured/);
    assert.doesNotMatch(JSON.stringify(rows), /private Microsoft/);
  }
});

test("Microsoft current-actor configured, pending and expiry states never imply saved-maker capability", async t => {
  const env = environment(t);
  const connected = { configured: true, connected: true, write_configured: true, refresh_pending: false,
    binding_id: "binding", mailbox_id: "private-mailbox", expires_at: 4102444800 };
  for (const [status, pattern] of [[{ ...connected, configured: false, connected: false, write_configured: false, expires_at: null }, /unconfigured; disconnected or expired.*Draft writes disabled/],
    [connected, /connected at this read.*2100-01-01T00:00:00.000Z/],
    [{ ...connected, expires_at: 1 }, /disconnected or expired.*1970-01-01T00:00:01.000Z/],
    [{ ...connected, connected: false, refresh_pending: true }, /refresh pending; connection unavailable/]]) {
    const pending = env.read(view, new AbortController().signal); env.reply(undefined, [...values.slice(0, 5), status]);
    const rows = await pending;
    assert.match(rows[5].detail, pattern); assert.match(rows[5].detail, /not the saved action maker/);
    assert.doesNotMatch(rows[5].detail, /private-mailbox/); assert.equal(rows[5].href, "/missions?account=account");
  }
  const admin = { id: "viewer", organization_id: "org", role: "admin" }; env.actor({ mode: "session", actor: admin });
  const pending = env.read(view, new AbortController().signal, admin);
  env.reply(undefined, [...values.slice(0, 4), { ...values[4], write_configured: true, can_prepare: true, can_reconcile: true }, connected]);
  const rows = await pending;
  assert.match(rows[4].detail, /Writes configured, unverified.*Preparation role capability eligible.*do not authorize execution/);
  assert.ok(env.calls.every(call => !call.init.method && !/connect$|refresh$|reconcile$|execute$/.test(call.url)));
});

test("final session verification rejects changed actor, organization, role and lost session without a provider read", async t => {
  const env = environment(t);
  for (const session of [{ mode: "sample", actor: null }, { mode: "session", actor: null },
    { mode: "session", actor: { id: "other", organization_id: "org", role: "viewer" } },
    { mode: "session", actor: { id: "viewer", organization_id: "foreign", role: "viewer" } },
    { mode: "session", actor: { id: "viewer", organization_id: "org", role: "admin" } }, new Error("private session body")]) {
    env.sessionResult(session);
    const pending = env.read(view, new AbortController().signal); env.reply();
    await assert.rejects(pending);
  }
});

test("captured readiness callbacks cannot reuse a later account-date or actor lifetime", async t => {
  const env = environment(t); env.render(); await flush(); env.reply(); await flush();
  const captured = env.button().props.onClick;
  env.select({ ...view, assessment: { ...view.assessment, as_of: "2026-10-28" } }); env.render(); await flush();
  const current = env.requests.splice(0); assert.equal(current.length, 7);
  await captured(); assert.equal(env.requests.length, 0);
  env.reply(current); await flush(); assert.match(renderToStaticMarkup(env.render()), /original-grant/);
  const latest = env.button().props.onClick; env.unmount(); await latest(); assert.equal(env.requests.length, 0);
});

test("Microsoft, source and workflow completion refresh only local rows and clear old readiness first", async t => {
  const env = environment(t); env.render(); await flush(); env.reply(); await flush();
  for (const name of ["vitaai-microsoft-changed", "vitaai-source-changed", "vitaai-workflow-changed"]) {
    env.listeners.get(name).forEach(handler => handler());
    assert.doesNotMatch(renderToStaticMarkup(env.render()), /original-grant/);
    env.reply(); await flush(); assert.match(renderToStaticMarkup(env.render()), /original-grant/);
  }
  assert.ok(env.calls.every(call => !call.init.method)); env.unmount();
});
