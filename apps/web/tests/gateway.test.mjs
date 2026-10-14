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
