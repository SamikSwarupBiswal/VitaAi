import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { NextRequest } = require("next/server");
const ts = require("typescript");
const routePath = fileURLToPath(new URL("../app/api/[...path]/route.ts", import.meta.url));
const compiled = ts.transpileModule(readFileSync(routePath, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const route = new Module(routePath);
route.filename = routePath;
route.paths = Module._nodeModulePaths(path.dirname(routePath));
route._compile(compiled, routePath);

test("mapped connection probe allows only explicit GET readiness and POST probe", async t => {
  const base = "integrations/hubspot/accounts/29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session");
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.cache, "no-store");
    return Response.json({ status: "synthetic" });
  });
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  for (const [method, suffix, status] of [["GET", "connection-readiness", 200], ["POST", "probe", 200],
    ["GET", "probe", 404], ["POST", "connection-readiness", 404], ["HEAD", "connection-readiness", 404],
    ["HEAD", "probe", 404], ["POST", "probe/extra", 404], ["GET", "connection-readiness/extra", 404]]) {
    const name = `${base}/${suffix}`;
    const response = await methods[method](new NextRequest(`http://127.0.0.1:3000/api/${name}`, { method,
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", cookie: "vitaai_session=opaque-session" },
      ...(method === "POST" ? { body: '{"expected_account_revision":3}' } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, status);
  }
  assert.equal(upstream.mock.callCount(), 2);
});

test("scheduled staging forwards only seven explicit method/path pairs, never implicit HEAD", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8", prefix = "integrations/hubspot";
  const body = '{"expected_revision":1,"expected_account_revision":3,"expected_worker_deadline_at":"2026-10-22T00:02:00Z"}';
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/api\/integrations\/hubspot\//);
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session"); assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.cache, "no-store"); if (init.method === "POST") assert.equal(init.body, body);
    return Response.json({ status: "retained" });
  });
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  const pairs = [["GET", `accounts/${id}/refresh-schedule`], ["POST", `accounts/${id}/refresh-schedule`],
    ["POST", `accounts/${id}/refresh-schedule/revoke`], ["GET", `accounts/${id}/refresh-occurrences`],
    ["GET", `refresh-occurrences/${id}`], ["GET", `refresh-occurrences/${id}/recovery-readiness`], ["POST", `refresh-occurrences/${id}/recover`]];
  for (const [method, suffix] of pairs) {
    const name = `${prefix}/${suffix}`;
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, { method,
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", cookie: "vitaai_session=opaque-session; other=private", authorization: "never" },
      ...(method === "POST" ? { body } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(upstream.mock.callCount(), 7); upstream.mock.resetCalls();
  for (const [method, suffix] of [...pairs.map(([, suffix]) => ["HEAD", suffix]),
    ["GET", `accounts/${id}/refresh-schedule/revoke`], ["GET", `refresh-occurrences/${id}/recover`],
    ["POST", `accounts/${id}/refresh-occurrences`], ["POST", `refresh-occurrences/${id}`], ["POST", `refresh-occurrences/${id}/recovery-readiness`],
    ["GET", "refresh-occurrences/invalid"], ["POST", `accounts/${id}/refresh-schedule/extra`]]) {
    const name = `${prefix}/${suffix}`;
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, { method, headers: { host: "127.0.0.1:3000" } }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("provider tests forward only explicit bounded methods without credential headers or retries", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const body = JSON.stringify({ mode: "live", expected_configuration_revision: 7, api_key: "synthetic-one-use-key" });
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/api\/provider-comparison\//);
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session");
    assert.equal(init.headers.Authorization, undefined); assert.equal(init.headers["X-Byok-Api-Key"], undefined);
    assert.equal(init.cache, "no-store");
    if (init.method === "POST") assert.equal(init.body, body);
    return Response.json({ status: "pending" });
  });
  for (const provider of ["nebius", "openai", "anthropic", "nvidia", "foundry"]) {
    for (const [method, suffix] of [["GET", "test-readiness"], ["GET", "tests"], ["POST", "test"]]) {
      const name = `provider-comparison/providers/${provider}/${suffix}`;
      const response = await route.exports[method](new NextRequest(`http://localhost:3000/api/${name}`, {
        method, headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "X-VitaAi-Request": "1",
          cookie: "vitaai_session=opaque-session; other=private", authorization: "private", "X-Byok-Api-Key": "never-forward" },
        ...(method === "POST" ? { body } : {}),
      }), { params: Promise.resolve({ path: name.split("/") }) });
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }
  const detail = `provider-comparison/tests/${id}`;
  assert.equal((await route.exports.GET(new NextRequest(`http://localhost:3000/api/${detail}`, {
    headers: { host: "127.0.0.1:3000", cookie: "vitaai_session=opaque-session" },
  }), { params: Promise.resolve({ path: detail.split("/") }) })).status, 200);
  assert.equal(upstream.mock.callCount(), 16); upstream.mock.resetCalls();
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  for (const [method, suffix] of [["GET", "providers/openai/test"], ["HEAD", "providers/openai/test"],
    ["POST", "providers/openai/tests"], ["POST", "providers/openai/test-readiness"], ["POST", `tests/${id}`],
    ["POST", "providers/unknown/test"], ["POST", "providers/foundry/test/extra"], ["GET", "tests/invalid"],
    ["GET", `tests/${id}/extra`], ["HEAD", "providers/openai/tests"]]) {
    const name = `provider-comparison/${suffix}`;
    assert.equal((await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000" },
    }), { params: Promise.resolve({ path: name.split("/") }) })).status, 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("provider test recovery only forwards canonical readiness GET and explicit exact-body POST", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8", prefix = `provider-comparison/tests/${id}`;
  const body = JSON.stringify({ schema_version: "1", expected_provider: "openai", expected_revision: 1,
    expected_worker_deadline_at: "2026-10-21T00:02:00Z" });
  const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session"); assert.equal(init.cache, "no-store");
    if (init.method === "POST") assert.equal(init.body, body);
    return Response.json({ status: "interrupted" });
  });
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  for (const [method, name, expected] of [["GET", `${prefix}/recovery-readiness`, 200], ["POST", `${prefix}/recover`, 200],
    ["GET", `${prefix}/recover`, 404], ["HEAD", `${prefix}/recover`, 404], ["POST", `${prefix}/recovery-readiness`, 404],
    ["POST", `${prefix}/recover/extra`, 404], ["POST", "provider-comparison/tests/invalid/recover", 404]]) {
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, { method,
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", cookie: "vitaai_session=opaque-session" },
      ...(method === "POST" ? { body } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, expected);
  }
  assert.equal(upstream.mock.callCount(), 2);
});

test("research allows bounded reads, explicit search/finalization; implicit HEAD cannot mutate", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session");
    assert.equal(init.cache, "no-store");
    return Response.json({ status: "pending" });
  });
  for (const [method, suffix] of [["GET", ""], ["GET", `/accounts/${id}/readiness`], ["GET", `/accounts/${id}/runs`],
    ["GET", `/runs/${id}`], ["POST", `/accounts/${id}/search`],
    ["GET", `/runs/${id}/recovery-readiness`], ["POST", `/runs/${id}/recover`], ["GET", `/runs/${id}/context`],
    ["GET", `/runs/${id}/narrative-readiness`], ["GET", `/runs/${id}/narratives`],
    ["POST", `/runs/${id}/narratives`], ["GET", `/narratives/${id}`],
    ["GET", `/narratives/${id}/recovery-readiness`], ["POST", `/narratives/${id}/recover`]]) {
    const name = `integrations/research${suffix}`;
    const body = '{"expected_account_revision":3,"mode":"mock"}';
    const response = await route.exports[method](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000", cookie: "vitaai_session=opaque-session; other=private", "X-VitaAi-Request": "1" },
      ...(method === "POST" ? { body } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(upstream.mock.calls.at(-1).arguments[0], `http://127.0.0.1:8000/api/${name}`);
    if (method === "POST") assert.equal(upstream.mock.calls.at(-1).arguments[1].body, body);
  }
  upstream.mock.resetCalls();
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  for (const [method, suffix] of [["GET", `/accounts/${id}/search`], ["HEAD", `/accounts/${id}/search`],
    ["POST", `/accounts/${id}/runs`], ["POST", `/accounts/${id}/readiness`], ["GET", "/accounts/invalid/runs"],
    ["GET", `/runs/${id}/extra`], ["POST", ""], ["GET", `/runs/${id}/recover`], ["HEAD", `/runs/${id}/recover`],
    ["POST", `/runs/${id}/recovery-readiness`], ["POST", `/runs/${id}/recover/extra`], ["POST", "/runs/invalid/recover"],
    ["POST", `/runs/${id}/context`], ["GET", `/runs/${id}/context/extra`], ["GET", "/runs/invalid/context"],
    ["POST", `/runs/${id}/narrative-readiness`], ["HEAD", `/runs/${id}/narratives`], ["POST", `/narratives/${id}`],
    ["GET", `/runs/${id}/narratives/extra`], ["POST", "/runs/invalid/narratives"],
    ["GET", `/narratives/${id}/recover`], ["HEAD", `/narratives/${id}/recover`],
    ["POST", `/narratives/${id}/recovery-readiness`], ["POST", `/narratives/${id}/recover/extra`],
    ["POST", "/narratives/invalid/recover"]]) {
    const name = `integrations/research${suffix}`;
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000" },
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("Microsoft forwards only bounded paths and response flow cookies", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const flow = "vitaai_microsoft_flow=opaque-flow; HttpOnly; SameSite=Lax; Path=/api/integrations/microsoft/callback; Max-Age=600";
  const upstream = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.Cookie, "vitaai_session=opaque-session");
    return Response.json({ configured: true }, { headers: { "Set-Cookie": flow } });
  });
  for (const [method, suffix] of [["GET", ""], ["GET", `/missions/${id}/execution-readiness`], ["POST", "/connect"], ["POST", "/signout"], ["POST", "/refresh"]]) {
    const name = `integrations/microsoft${suffix}`;
    const response = await route.exports[method](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000", cookie: "vitaai_session=opaque-session; vitaai_microsoft_flow=never-forward; other=private",
        "X-VitaAi-Request": "1" }, ...(method === "POST" ? { body: "{}" } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(response.headers.get("set-cookie"), method === "POST" && suffix !== "/refresh" ? flow : null);
    const call = upstream.mock.calls.at(-1).arguments;
    assert.equal(call[0], `http://127.0.0.1:8000/api/${name}`);
    if (method === "POST") assert.equal(call[1].headers.Origin, "http://127.0.0.1:3000");
  }
  upstream.mock.resetCalls();
  for (const [method, suffix] of [["GET", "/connect"], ["POST", ""], ["GET", "/callback?code=private&state=private"],
    ["POST", `/missions/${id}/execution-readiness`], ["GET", "/missions/invalid/execution-readiness"], ["HEAD", "/signout"],
    ["GET", "/refresh"], ["HEAD", "/refresh"], ["POST", "/refresh/extra"]]) {
    const name = `integrations/microsoft${suffix}`;
    const response = await route.exports[method === "POST" ? "POST" : "GET"](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000" },
    }), { params: Promise.resolve({ path: name.split("?")[0].split("/") }) });
    assert.equal(response.status, 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("loopback Host binds POST origin despite Next URL normalization", async t => {
  const upstream = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.Cookie, "vitaai_session=opaque-session");
    assert.equal(options.headers["X-VitaAi-Request"], "1");
    return Response.json({ status: "deterministic" }, { headers: {
      "Set-Cookie": "vitaai_session=new-opaque; HttpOnly; SameSite=Strict; Path=/",
    } });
  });
  const request = new NextRequest("http://localhost:3000/api/pipeline", {
    method: "POST", headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000",
      cookie: "vitaai_session=opaque-session; unrelated=never-forward", "X-VitaAi-Request": "1" }, body: "{}",
  });
  const response = await route.exports.POST(request, { params: Promise.resolve({ path: ["pipeline"] }) });
  assert.equal(response.status, 200);
  assert.equal(upstream.mock.callCount(), 1);
  assert.match(response.headers.get("set-cookie"), /HttpOnly/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("foreign origins, forged hosts and unknown routes never dispatch", async t => {
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not dispatch"); });
  for (const [host, origin, routeName, expected] of [
    ["127.0.0.1:3000", "https://foreign.example", "pipeline", 403],
    ["foreign.example", "http://foreign.example", "pipeline", 403],
    ["127.0.0.1:3000", "http://127.0.0.1:3000", "arbitrary", 404],
  ]) {
    const request = new NextRequest(`http://localhost:3000/api/${routeName}`, {
      method: "POST", headers: { host, origin }, body: "{}",
    });
    const response = await route.exports.POST(request, { params: Promise.resolve({ path: [routeName] }) });
    assert.equal(response.status, expected);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("governed workflow routes preserve method, session, body and safe denial", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url.origin, undefined); // The fixed upstream is passed as a string.
    assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/api\//);
    assert.equal(options.headers.Cookie, "vitaai_session=opaque-session");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.cache, "no-store");
    return Response.json({ detail: { code: "approval_required", correlation_id: id } }, { status: 409 });
  });
  const routes = {
    GET: [`plans/${id}`, `plans/runs/${id}`, "missions", `missions/${id}`, `missions/${id}/audit`,
      `missions/${id}/actions`, `missions/${id}/outcomes`, `actions/${id}`, `actions/${id}/history`,
      `actions/${id}/decisions`, `actions/${id}/executions`, `executions/${id}`, `receipts/${id}`],
    POST: ["plans", "plans/generate", "missions", `missions/${id}/prepare`, `missions/${id}/supersede`, `missions/${id}/outcomes`,
      `actions/${id}/submit`, `actions/${id}/review`, `actions/${id}/renew-review`, `actions/${id}/execute`, `executions/${id}/reconcile`,
      `executions/${id}/retry`],
  };
  for (const [method, paths] of Object.entries(routes)) {
    for (const name of paths) {
      const body = method === "POST" ? JSON.stringify({ body: "Exact বাংলা\n " }) : undefined;
      const request = new NextRequest(`http://localhost:3000/api/${name}`, { method, body, headers: {
        host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "X-VitaAi-Request": "1",
        authorization: "never-forward", cookie: "vitaai_session=opaque-session; unrelated=never-forward",
      } });
      const response = await route.exports[method](request, { params: Promise.resolve({ path: name.split("/") }) });
      assert.equal(response.status, 409, `${method} ${name}`);
      assert.equal((await response.json()).detail.code, "approval_required");
      assert.equal(response.headers.get("cache-control"), "no-store");
      const call = upstream.mock.calls.at(-1).arguments;
      assert.equal(call[1].method, method);
      assert.equal(call[1].body, body);
    }
  }
  assert.equal(upstream.mock.callCount(), routes.GET.length + routes.POST.length);
});

test("HubSpot routes allow staged reads and explicit bounded source operations", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/api\/integrations\/hubspot/);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(options.headers.Cookie, "vitaai_session=opaque-session");
    return Response.json({ status: "configured_unverified" });
  });
  for (const [method, name, expected] of [
    ["GET", "integrations/hubspot", 200], ["GET", `integrations/hubspot/runs/${id}`, 200],
    ["GET", `integrations/hubspot/observations/${id}`, 200],
    ["GET", `integrations/hubspot/sources/${id}`, 200],
    ["GET", `integrations/hubspot/detections/${id}`, 200],
    ["GET", `integrations/hubspot/accounts/${id}/detections`, 200],
    ["POST", `integrations/hubspot/accounts/${id}/detect-changes`, 200],
    ["GET", `integrations/hubspot/detections/${id}/mission`, 200],
    ["POST", `integrations/hubspot/detections/${id}/mission`, 200],
    ["POST", `integrations/hubspot/detections/${id}/mission/extra`, 404],
    ["GET", "integrations/hubspot/detections/not-a-uuid/mission", 404],
    ["GET", `integrations/hubspot/accounts/${id}/detect-changes`, 404],
    ["POST", `integrations/hubspot/accounts/${id}/detections`, 404],
    ["POST", `integrations/hubspot/detections/${id}`, 404],
    ["POST", `integrations/hubspot/accounts/${id}/detect-changes/extra`, 404],
    ["GET", `integrations/hubspot/accounts/${id}/preview`, 200],
    ["GET", `integrations/hubspot/accounts/${id}/execution-readiness`, 200],
    ["POST", `integrations/hubspot/accounts/${id}/execution-readiness`, 404],
    ["POST", `integrations/hubspot/accounts/${id}/sync`, 200],
    ["POST", `integrations/hubspot/accounts/${id}/promote`, 200],
    ["POST", `integrations/hubspot/accounts/${id}/restore-sample`, 200],
    ["GET", `integrations/hubspot/accounts/${id}/promote`, 404],
    ["GET", `integrations/hubspot/accounts/${id}/restore-sample`, 404],
    ["POST", `integrations/hubspot/accounts/${id}/preview`, 404],
    ["POST", `integrations/hubspot/sources/${id}`, 404],
    ["GET", `integrations/hubspot/accounts/${id}/sync`, 404],
    ["POST", "integrations/hubspot", 404], ["POST", `integrations/hubspot/runs/${id}`, 404],
    ["POST", `integrations/hubspot/accounts/${id}/write`, 404],
    ["POST", `integrations/hubspot/accounts/${id}/sync/extra`, 404],
    ["POST", "integrations/hubspot/accounts/not-a-uuid/sync", 404],
    ["POST", "integrations/hubspot/accounts/../../foreign/sync", 404],
  ]) {
    const request = new NextRequest(`http://localhost:3000/api/${name}`, { method, headers: {
      host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", cookie: "vitaai_session=opaque-session",
      authorization: "never-forward", "X-VitaAi-Request": "1",
    }, ...(method === "POST" ? { body: JSON.stringify({ expected_account_revision: 1 }) } : {}) });
    const response = await route.exports[method](request, { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, expected, `${method} ${name}`);
  }
  assert.equal(upstream.mock.callCount(), 14);
});

test("Next implicit HEAD cannot forward a HubSpot source mutation", async t => {
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods.js");
  const methods = autoImplementMethods(route.exports);
  const upstream = t.mock.method(globalThis, "fetch", async () => Response.json({}, { status: 405 }));
  for (const operation of ["sync", "promote", "restore-sample", "detect-changes"]) {
    const name = `integrations/hubspot/accounts/29d4bc06-1bb6-483e-bc96-2ed2ff42efc8/${operation}`;
    const request = new NextRequest(`http://localhost:3000/api/${name}`, { method: "HEAD", headers: {
      host: "127.0.0.1:3000", origin: "https://foreign.example",
    } });
    const response = await methods.HEAD(request, { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 404);
  }
  const path = "integrations/hubspot/detections/29d4bc06-1bb6-483e-bc96-2ed2ff42efc8/mission";
  const request = new NextRequest(`http://localhost:3000/api/${path}`, { method: "HEAD", headers: {
    host: "127.0.0.1:3000",
  } });
  assert.equal((await methods.HEAD(request, { params: Promise.resolve({ path: path.split("/") }) })).status, 404);
  assert.equal(upstream.mock.callCount(), 0);
});

test("workflow request size permits valid reviewed bodies but remains bounded", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(JSON.parse(options.body).payload.body.length, 20000);
    return Response.json({ status: "draft" });
  });
  for (const [name, body, expected] of [
    [`missions/${id}/prepare`, JSON.stringify({ payload: { kind: "hubspot_note_create", body: "x".repeat(20000) } }), 200],
    [`missions/${id}/prepare`, "x".repeat(262145), 413],
    ["pipeline", "x".repeat(4097), 413],
  ]) {
    const request = new NextRequest(`http://localhost:3000/api/${name}`, { method: "POST", body, headers: {
      host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "X-VitaAi-Request": "1",
    } });
    const response = await route.exports.POST(request, { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, expected);
  }
  assert.equal(upstream.mock.callCount(), 1);
});

test("workflow allowlist rejects wrong verbs, invalid IDs and extra paths before dispatch", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async () => { throw new Error("Must not dispatch"); });
  for (const [method, name] of [["GET", "plans/generate"], ["GET", `actions/${id}/execute`], ["GET", `actions/${id}/renew-review`],
    ["GET", `missions/${id}/supersede`], ["POST", `missions/${id}/supersede/extra`],
    ["POST", `receipts/${id}`], ["POST", `missions/${id}/delete`], ["GET", "missions/not-a-uuid"],
    ["GET", `missions/${id}/audit/extra`], ["POST", "plans/arbitrary"], ["GET", `plans/runs/${"-".repeat(36)}`]]) {
    const request = new NextRequest(`http://localhost:3000/api/${name}`, { method, headers: {
      host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000",
    } });
    const response = await route.exports[method](request, { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 404, `${method} ${name}`);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("comparison allows only bounded paths; implicit HEAD cannot discover or compare", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8";
  const upstream = t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session");
    assert.equal(init.cache, "no-store");
    return Response.json({ status: "pending" });
  });
  for (const [method, suffix] of [["GET", "/catalog"], ["GET", `/accounts/${id}/readiness`], ["GET", `/accounts/${id}/runs`],
    ["GET", `/runs/${id}`], ["POST", `/accounts/${id}/compare`], ["POST", "/providers/openai/discover"],
    ["POST", "/providers/foundry/discover"], ["GET", `/runs/${id}/recovery-readiness`], ["POST", `/runs/${id}/recover`]]) {
    const name = `provider-comparison${suffix}`;
    const body = '{"expected_revision":3,"mode":"mock"}';
    const response = await route.exports[method](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000", cookie: "vitaai_session=opaque-session; other=private", "X-VitaAi-Request": "1" },
      ...(method === "POST" ? { body } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(upstream.mock.calls.at(-1).arguments[0], `http://127.0.0.1:8000/api/${name}`);
    if (method === "POST") assert.equal(upstream.mock.calls.at(-1).arguments[1].body, body);
  }
  upstream.mock.resetCalls();
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  for (const [method, suffix] of [["GET", `/accounts/${id}/compare`], ["HEAD", `/accounts/${id}/compare`],
    ["POST", `/accounts/${id}/runs`], ["POST", `/accounts/${id}/readiness`], ["GET", "/accounts/invalid/runs"],
    ["GET", `/runs/${id}/extra`], ["POST", "/catalog"], ["HEAD", "/providers/openai/discover"], ["GET", "/providers/openai/discover"],
    ["HEAD", "/providers/foundry/discover"], ["GET", "/providers/foundry/discover"],
    ["POST", "/providers/foundry/discover/extra"], ["POST", "/providers/unknown/discover"],
    ["GET", `/runs/${id}/recover`], ["HEAD", `/runs/${id}/recover`], ["POST", `/runs/${id}/recovery-readiness`],
    ["POST", `/runs/${id}/recover/extra`], ["POST", "/runs/invalid/recover"]]) {
    const name = `provider-comparison${suffix}`;
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, {
      method, headers: { host: "127.0.0.1:3000" },
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
});

test("associated ingestion forwards only six explicit method/path pairs, never implicit HEAD", async t => {
  const id = "29d4bc06-1bb6-483e-bc96-2ed2ff42efc8", prefix = "integrations/hubspot";
  const body = '{"expected_revision":1,"expected_account_revision":3,"expected_worker_deadline_at":"2026-10-22T00:02:00Z"}';
  const upstream = t.mock.method(globalThis, "fetch", async (url, init) => {
    assert.match(url, /^http:\/\/127\.0\.0\.1:8000\/api\/integrations\/hubspot\//);
    assert.equal(init.headers.Cookie, "vitaai_session=opaque-session"); assert.equal(init.headers.Authorization, undefined);
    assert.equal(init.cache, "no-store"); if (init.method === "POST") assert.equal(init.body, body);
    return Response.json({ status: "retained" });
  });
  const { autoImplementMethods } = require("next/dist/server/route-modules/app-route/helpers/auto-implement-methods");
  const methods = autoImplementMethods(route.exports);
  const pairs = [["GET", `accounts/${id}/ingestions/readiness`], ["GET", `accounts/${id}/ingestions`],
    ["POST", `accounts/${id}/ingestions`], ["GET", `ingestions/${id}`],
    ["GET", `ingestions/${id}/recovery-readiness`], ["POST", `ingestions/${id}/recover`]];
  for (const [method, suffix] of pairs) {
    const name = `${prefix}/${suffix}`;
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, { method,
      headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", cookie: "vitaai_session=opaque-session; other=private", authorization: "never" },
      ...(method === "POST" ? { body } : {}),
    }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(upstream.mock.callCount(), 6); upstream.mock.resetCalls();
  for (const [method, suffix] of [...pairs.map(([, suffix]) => ["HEAD", suffix]),
    ["POST", `accounts/${id}/ingestions/readiness`], ["GET", `ingestions/${id}/recover`],
    ["POST", `ingestions/${id}`], ["POST", `ingestions/${id}/recovery-readiness`],
    ["GET", "ingestions/invalid"], ["POST", `accounts/${id}/ingestions/extra`], ["GET", `ingestions/${id}/extra`]]) {
    const name = `${prefix}/${suffix}`;
    const response = await methods[method](new NextRequest(`http://localhost:3000/api/${name}`, { method, headers: { host: "127.0.0.1:3000" } }), { params: Promise.resolve({ path: name.split("/") }) });
    assert.equal(response.status, 404);
  }
  assert.equal(upstream.mock.callCount(), 0);
});
