import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { NextRequest } = require("next/server"), { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), result = new Module(filename);
  result.filename = filename; result.paths = Module._nodeModulePaths(path.dirname(filename));
  const original = result.require.bind(result); result.require = name => mocks[name] ?? original(name);
  result._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText, filename); return result.exports;
}
const account = "11111111-1111-4111-8111-111111111111", object = "22222222-2222-4222-8222-222222222222";
test("platform gateway forwards only explicit canonical bearer routes without cookies or redirects", async t => {
  const before = process.env.VITAAI_WEB_ORIGIN; process.env.VITAAI_WEB_ORIGIN = "https://vita.example";
  t.after(() => { if (before === undefined) delete process.env.VITAAI_WEB_ORIGIN; else process.env.VITAAI_WEB_ORIGIN = before; });
  const route = load("../app/api/platform-gateway/[...path]/route.ts");
  const calls = [], mock = t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, init }); return Response.json({}); });
  for (const [method, suffix, status] of [["GET", `context/${account}`, 200], ["POST", "preparation", 200],
    ["POST", "teams/activity", 200], ["GET", "identities", 404], ["POST", "identities", 404],
    ["GET", `context/${account}/extra`, 404], ["POST", `context/${account}`, 404], ["HEAD", `context/${account}`, 405]]) {
    const response = await route[method](new NextRequest(`https://vita.example/api/platform-gateway/${suffix}`, {
      method, headers: { host: "vita.example", authorization: "Bearer token.value.signature", cookie: "vitaai_session=private" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }), { params: Promise.resolve({ path: suffix.split("/") }) }); assert.equal(response.status, status);
  }
  assert.equal(mock.mock.callCount(), 3);
  for (const { url, init } of calls) { assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/api\/platform\//);
    assert.equal(init.headers.Authorization, "Bearer token.value.signature"); assert.equal(init.headers.Cookie, undefined); assert.equal(init.redirect, "error"); }
});
test("platform gateway rejects absent bearer, foreign host/origin, oversized and malformed bodies", async t => {
  const before = process.env.VITAAI_WEB_ORIGIN; process.env.VITAAI_WEB_ORIGIN = "https://vita.example";
  t.after(() => { if (before === undefined) delete process.env.VITAAI_WEB_ORIGIN; else process.env.VITAAI_WEB_ORIGIN = before; });
  const route = load("../app/api/platform-gateway/[...path]/route.ts"), mock = t.mock.method(globalThis, "fetch", async () => Response.json({}));
  for (const [headers, body, status] of [[{ host: "vita.example" }, "{}", 401],
    [{ host: "foreign.example", authorization: "Bearer token" }, "{}", 403],
    [{ host: "vita.example", authorization: "Bearer token", origin: "https://foreign.example" }, "{}", 403],
    [{ host: "vita.example", authorization: "Bearer token" }, "x".repeat(16385), 413],
    [{ host: "vita.example", authorization: "Bearer token" }, "not json", 422]]) {
    const response = await route.POST(new NextRequest("https://vita.example/api/platform-gateway/preparation", { method: "POST", headers, body }),
      { params: Promise.resolve({ path: ["preparation"] }) }); assert.equal(response.status, status);
  }
  assert.equal(mock.mock.callCount(), 0);
});
const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
function teams(t) {
  const slots = [], cleanup = [], requests = [], listeners = new Map(), calls = { tokens: 0 }; let cursor = 0, effects = [];
  const old = globalThis.window;
  globalThis.window = { location: { origin: "https://vita.example", search: `?account=${account}` },
    addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  t.after(() => { cleanup.forEach(fn => fn?.()); globalThis.window = old; });
  const hooks = { ...React, useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(fn, deps) { const index = cursor++; if (!(index in slots) || deps.some((value, n) => value !== slots[index][n])) {
      slots[index] = deps; effects.push(() => { cleanup[index]?.(); cleanup[index] = fn(); }); } } };
  const component = load("../components/teams-page.tsx", { react: hooks,
    "@/lib/pipeline-history": { savedRunId: /^[a-f0-9-]{36}$/ },
    "@microsoft/teams-js": { app: { initialize: async () => {}, getContext: async () => ({ user: { id: object, tenant: { id: account } } }) },
      authentication: { async getAuthToken() { calls.tokens++; return "synthetic-token"; } } },
  });
  t.mock.method(globalThis, "fetch", (url, init) => new Promise(resolve => requests.push({ url, init, resolve })));
  const render = () => { cursor = 0; const tree = component.TeamsPage({ initialAccount: account }); const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  return { render, requests, calls, button: name => walk(render()).find(node => node.type === "button" && node.props.children === name),
    blur: () => listeners.get("blur")(), async flush() { for (let i = 0; i < 6; i++) await Promise.resolve(); } };
}
const context = () => ({ approval_available: false, execution_available: false, workspace_url: `https://vita.example/accounts?account=${account}`,
  caveats: ["Unknown outcome"], account: { account: { id: account, organization_id: "org", name: "<script>Account</script>", revision: 1 },
    assessment: { risk: 70, opportunity: 20, snapshot_hash: "hash", as_of: "2026-10-27", caveats: [] },
    evidence: [{ id: "e", account_id: account, organization_id: "org", fact: "Original fact", source: "Synthetic", observed_at: "2026-10-26", synthetic: true }] } });
test("Teams tab gets SSO only after explicit click, suppresses duplicates and displays escaped sourced evidence", async t => {
  const app = teams(t); app.render(); assert.equal(app.calls.tokens, 0);
  const button = app.button("Sign in and inspect account"), pending = button.props.onClick(); await button.props.onClick(); await app.flush();
  assert.equal(app.requests.length, 1); const request = app.requests.shift(); assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.headers.Authorization, "Bearer synthetic-token"); request.resolve(Response.json({ context: context() })); await pending;
  const html = renderToStaticMarkup(app.render()); assert.match(html, /&lt;script&gt;Account/); assert.match(html, /Original fact/); assert.match(html, /Unknown outcome/);
});
test("Teams tab rejects crossed context and late results after blur; captured handlers are inert", async t => {
  const app = teams(t); app.render(); const button = app.button("Sign in and inspect account"), pending = button.props.onClick(); await app.flush();
  const request = app.requests.shift(); app.blur(); request.resolve(Response.json({ context: context() })); await pending;
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /Original fact/); await button.props.onClick(); assert.equal(app.requests.length, 0);
  const retry = app.button("Sign in and inspect account").props.onClick(); await app.flush();
  const crossed = context(); crossed.account.account.id = object; app.requests.shift().resolve(Response.json({ context: crossed })); await retry;
  assert.match(renderToStaticMarkup(app.render()), /unavailable/); assert.doesNotMatch(renderToStaticMarkup(app.render()), /Original fact/);
});

function admin(t, role = "admin") {
  const slots = [], cleanup = [], requests = [], listeners = new Map(); let cursor = 0, effects = [];
  const old = globalThis.window;
  globalThis.window = { addEventListener(name, fn) { listeners.set(name, fn); }, removeEventListener(name) { listeners.delete(name); } };
  t.after(() => { cleanup.forEach(fn => fn?.()); globalThis.window = old; });
  const hooks = { ...React, useState(initial) { const index = cursor++; if (!(index in slots)) slots[index] = initial;
    return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }]; },
    useRef(initial) { const index = cursor++; return slots[index] ??= { current: initial }; },
    useEffect(fn, deps) { const index = cursor++; if (!(index in slots) || deps.some((value, n) => value !== slots[index][n])) {
      slots[index] = deps; effects.push(() => { cleanup[index]?.(); cleanup[index] = fn(); }); } } };
  const component = load("../components/platform-admin.tsx", { react: hooks,
    "@/lib/pipeline-history": { savedRunId: /^[a-f0-9-]{36}$/ },
    "@/lib/api": { api: (url, init) => new Promise((resolve, reject) => requests.push({ url, init, resolve, reject })) },
    "./session-gate": { useSession: () => ({ mode: "session", actor: { id: account, organization_id: "org", role, username: "current-admin" } }) },
  });
  const render = () => { cursor = 0; const outer = component.PlatformAdmin(), tree = outer ? outer.type(outer.props) : null;
    const pending = effects; effects = []; pending.forEach(fn => fn()); return tree; };
  return { render, requests, button: name => walk(render()).find(node => node.type === "button" && node.props.children === name),
    focus: () => listeners.get("focus")(), async read(configured = true, links = []) {
      const pending = this.button("Inspect Microsoft readiness and mappings").props.onClick();
      requests.shift().resolve({ configured, tenant_id: account, audience: object, delegated_scope: "access_as_user", live_verified: false, notes: ["Unverified"] });
      requests.shift().resolve(links); requests.shift().resolve({ items: [], has_more: false, limit: 100 }); await pending;
    } };
}
test("Microsoft identity admin requires explicit scoped readback and blocks another write after uncertain result", async t => {
  const app = admin(t); app.render(); assert.equal(app.requests.length, 0); await app.read();
  const inputs = walk(app.render()).filter(node => node.type === "input"); inputs[1].props.onChange({ target: { value: object } });
  walk(app.render()).find(node => node.type === "select").props.onChange({ target: { value: account } });
  const button = app.button("Link exact Microsoft identity"), pending = button.props.onClick(); await button.props.onClick();
  assert.equal(app.requests.length, 1); const request = app.requests.shift(), body = JSON.parse(request.init.body);
  assert.equal(body.expected_revision, 0); assert.equal(body.user_id, account); assert.equal(body.actor_id, undefined);
  request.reject(new Error("Lost response")); await pending;
  await button.props.onClick(); assert.equal(app.requests.length, 0);
  assert.match(renderToStaticMarkup(app.render()), /explicit readback/); await app.read();
  assert.doesNotMatch(renderToStaticMarkup(app.render()), /needs explicit readback/);
});
test("Microsoft admin can revoke retained mapping while configuration is disabled and captured handlers cannot replay", async t => {
  const app = admin(t), link = { tenant_id: account, object_id: object, user_id: object, organization_id: "org", revision: 3,
    enabled: true, linked_by: account, updated_at: "2026-10-27T00:00:00Z" };
  await app.read(false, [link]);
  walk(app.render()).find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes(" → ")).props.onClick();
  const button = app.button("Revoke exact mapping"), pending = button.props.onClick();
  const request = app.requests.shift(), body = JSON.parse(request.init.body); assert.equal(body.expected_revision, 3); assert.equal(body.enabled, false);
  request.resolve({ ...link, revision: 4, enabled: false }); await pending; await button.props.onClick(); assert.equal(app.requests.length, 0);
  await app.read(false, [{ ...link, revision: 4, enabled: false }]);
  const old = app.button("Inspect Microsoft readiness and mappings"); app.focus(); await old.props.onClick(); assert.equal(app.requests.length, 0);
});
test("Microsoft administration is absent for non-admins", t => {
  assert.equal(admin(t, "seller").render(), null);
});

test("Microsoft mapping refresh retires captured revoke handlers on success and failure", async t => {
  const app = admin(t), link = { tenant_id: account, object_id: object, user_id: object, organization_id: "org", revision: 3,
    enabled: true, linked_by: account, updated_at: "2026-10-27T00:00:00Z" };
  for (const fails of [false, true]) {
    await app.read(false, [link]);
    walk(app.render()).find(node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes(" → ")).props.onClick();
    const oldRevoke = app.button("Revoke exact mapping");
    const pending = app.button("Inspect Microsoft readiness and mappings").props.onClick();
    const [ready, mappings, members] = app.requests.splice(0);
    if (fails) ready.reject(new Error("Readback lost"));
    else ready.resolve({ configured: false, tenant_id: account, delegated_scope: "access_as_user", live_verified: false, notes: [] });
    mappings.resolve([link]); members.resolve({ items: [], has_more: false, limit: 100 }); await pending;
    await oldRevoke.props.onClick(); assert.equal(app.requests.length, 0);
    assert.equal(app.button("Revoke exact mapping"), undefined);
  }
});
test("Microsoft administration rejects crossed mapping readback", async t => {
  const app = admin(t); await app.read(true, [{ tenant_id: account, object_id: object, user_id: account, organization_id: "foreign", revision: 1, enabled: true }]);
  assert.match(renderToStaticMarkup(app.render()), /Readback unavailable/);
  assert.equal(app.button("Link exact Microsoft identity"), undefined);
});

test("cookie gateway exposes identity administration only; bearer context remains isolated", async t => {
  const before = process.env.VITAAI_WEB_ORIGIN; delete process.env.VITAAI_WEB_ORIGIN;
  t.after(() => { if (before !== undefined) process.env.VITAAI_WEB_ORIGIN = before; });
  const route = load("../app/api/[...path]/route.ts"), calls = [];
  const mock = t.mock.method(globalThis, "fetch", async (url, init) => { calls.push({ url, init }); return Response.json({}); });
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route);
  for (const [method, suffix, status] of [["GET", "readiness", 200], ["GET", "identities", 200], ["POST", "identities", 200],
    ["HEAD", "identities", 404], ["POST", "readiness", 404], ["GET", `context/${account}`, 404], ["POST", "teams/activity", 404]]) {
    const name = `platform/${suffix}`, response = await methods[method](new NextRequest(`http://127.0.0.1:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000", authorization: "Bearer ignored", cookie: "vitaai_session=local-test-only" },
      ...(method === "POST" ? { body: "{}" } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) }); assert.equal(response.status, status);
  }
  assert.equal(mock.mock.callCount(), 3); assert.ok(calls.every(call => call.init.headers.Authorization === undefined));
});
