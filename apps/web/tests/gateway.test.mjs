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
      `executions/${id}`, `receipts/${id}`],
    POST: ["plans", "plans/generate", "missions", `missions/${id}/prepare`, `missions/${id}/outcomes`,
      `actions/${id}/submit`, `actions/${id}/review`, `actions/${id}/execute`, `executions/${id}/reconcile`,
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
  for (const [method, name] of [["GET", "plans/generate"], ["GET", `actions/${id}/execute`],
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
