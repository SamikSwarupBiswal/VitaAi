import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const filename = fileURLToPath(new URL("../components/session-gate.tsx", import.meta.url));
const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
  compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

// Execute the real handlers with deferred transport and isolated hooks to control response order.
function harness(t) {
  let cursor = 0;
  const slots = [], effects = [], listeners = {}, requests = [];
  const hooks = {
    createContext: () => ({ Provider: "Provider" }), useContext: () => null,
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = initial;
      return [slots[index], value => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
    },
    useRef(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
    useEffect(callback) {
      const index = cursor++;
      if (!(index in slots)) { slots[index] = true; effects.push(callback); }
    },
  };
  const previous = { window: globalThis.window, FormData: globalThis.FormData };
  globalThis.window = { addEventListener: (name, callback) => { listeners[name] = callback; }, removeEventListener() {} };
  globalThis.FormData = class { get(name) { return name === "username" ? "fixture" : "fixture-password"; } };
  t.after(() => {
    if (previous.window === undefined) delete globalThis.window;
    else globalThis.window = previous.window;
    globalThis.FormData = previous.FormData;
  });
  const api = name => new Promise((resolve, reject) => requests.push({ path: name, resolve, reject }));
  const gateModule = new Module(filename);
  gateModule.filename = filename;
  gateModule.paths = Module._nodeModulePaths(path.dirname(filename));
  const normalRequire = gateModule.require.bind(gateModule);
  gateModule.require = name => name === "react" ? hooks : name === "@/lib/api" ? { api } : normalRequire(name);
  gateModule._compile(compiled, filename);
  const render = () => { cursor = 0; return gateModule.exports.SessionGate({ children: "Private mission" }); };
  const walk = (node, predicate) => {
    if (!node || typeof node !== "object") return undefined;
    if (predicate(node)) return node;
    for (const child of [node.props?.children].flat()) { const found = walk(child, predicate); if (found) return found; }
  };
  render(); effects.shift()();
  return { requests, actor: () => slots[0]?.actor, focus: () => listeners.focus(), expire: () => listeners["vitaai-session-expired"](),
    logout: () => walk(render(), node => node.type === "button" && node.props.children === "Sign out").props.onClick(),
    login: () => walk(render(), node => node.type === "form").props.onSubmit({ preventDefault() {}, currentTarget: { reset() {} } }),
  };
}
const active = { schema_version: "1", mode: "session", actor: { id: "actor-a", organization_id: "org-a", role: "reviewer", username: "Reviewer A" } };
const none = { schema_version: "1", mode: "session", actor: null };
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

test("focus and duplicate sign-out cannot issue reads or mutations during logout", async t => {
  const app = harness(t);
  app.requests.shift().resolve(active); await flush();
  const logout = app.logout();
  const mutation = app.requests.shift();
  assert.equal(mutation.path, "auth/logout");
  app.focus(); await app.logout();
  assert.equal(app.requests.length, 0);
  mutation.resolve(none); await logout;
  assert.equal(app.actor(), null);
});

test("late restore cannot remount an actor after successful sign-out", async t => {
  const app = harness(t);
  app.requests.shift().resolve(active); await flush();
  app.focus(); const stale = app.requests.shift();
  const logout = app.logout(); app.requests.shift().resolve(none); await logout;
  stale.resolve(active); await flush();
  assert.equal(app.actor(), null);
});

test("focus cannot replace a successful sign-in with an earlier anonymous session", async t => {
  const app = harness(t);
  app.requests.shift().resolve(none); await flush();
  app.focus(); const stale = app.requests.shift();
  const login = app.login(); const mutation = app.requests.shift();
  app.focus(); assert.equal(app.requests.length, 0);
  mutation.resolve(active); await login;
  stale.resolve(none); await flush();
  assert.equal(app.actor().id, "actor-a");
});

test("session expiration invalidates an in-flight focus response", async t => {
  const app = harness(t);
  app.requests.shift().resolve(active); await flush();
  app.focus(); const stale = app.requests.shift();
  app.expire(); stale.resolve(active); await flush();
  assert.equal(app.actor(), null);
});
