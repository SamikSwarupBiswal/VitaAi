import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url), ts = require("typescript");
const { renderToStaticMarkup } = require("react-dom/server");
const walk = (node, predicate) => Array.isArray(node) ? node.flatMap(item => walk(item, predicate))
  : !node || typeof node !== "object" ? [] : [...(predicate(node) ? [node] : []), ...walk(node.props?.children, predicate)];
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url));
  const compiled = ts.transpileModule(readFileSync(filename, "utf8"), {
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const target = new Module(filename); target.filename = filename; target.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = target.require.bind(target); target.require = name => name in mocks ? mocks[name] : normal(name);
  target._compile(compiled, filename); return target.exports;
}
const content = load("../lib/tester-guide.ts");
const pdfManifest = JSON.parse(readFileSync(new URL("../lib/guide-pdf.generated.json", import.meta.url), "utf8"));
const pdfBytes = readFileSync(new URL(`../public/guides/${content.guideVersion}.pdf`, import.meta.url));
function harness(t, copy = async () => {}, manifest = pdfManifest) {
  let cursor = 0, cleanup;
  const slots = [], copied = [];
  const hooks = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial;
      return [slots[i], value => { slots[i] = value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
    useEffect(callback) { const i = cursor++; if (!(i in slots)) { slots[i] = true; cleanup = callback(); } },
  };
  t.mock.getter(globalThis, "navigator", () => ({ clipboard: { writeText: value => { copied.push(value); return copy(); } } }));
  const component = load("../components/tester-guide-exports.tsx", { react: hooks, "@/lib/tester-guide": content,
    "@/lib/guide-pdf.generated.json": { default: manifest } }).TesterGuideExports;
  const render = () => { cursor = 0; return component(); };
  return { copied, render, unmount: () => cleanup?.(),
    button: label => walk(render(), node => node.type === "button" && node.props.children === label)[0],
    message: () => walk(render(), node => node.props?.role === "alert" || node.props?.role === "status")[0] };
}

test("public page and downloaded instructions share actual workflow guidance and explicit limits", () => {
  const page = load("../app/tester-guide/page.tsx", {
    "next/link": { __esModule: true, default: ({ href, children }) => require("react").createElement("a", { href }, children) },
    "@/components/tester-guide-exports": { TesterGuideExports: () => null }, "@/lib/tester-guide": content,
  }).default;
  const html = renderToStaticMarkup(page());
  assert.match(html, /operator-provided synthetic workspace/); assert.match(html, /Sample mode alone cannot run missions/);
  assert.match(html, /never change dates or facts just to pass/); assert.match(html, /rejected|Rejected/);
  assert.match(html, /no customer-action approval/); assert.match(html, /href="\/walkthrough"/);
  for (const step of content.guideSteps) {
    assert.ok(html.includes(step.title)); assert.ok(content.guideText.includes(step.action));
    assert.ok(content.guideText.includes(step.expected));
  }
  assert.ok(content.guideText.endsWith(content.feedbackTemplate));
  assert.match(content.feedbackTemplate, /blank template, not a test result/);
  assert.match(content.guideText, /does not prove external delivery/);
});

test("clipboard denial exposes manual fallback; duplicate clicks and unmounted completions are guarded", async t => {
  let reject;
  const app = harness(t, () => new Promise((_resolve, fail) => { reject = fail; }));
  const click = app.button("Copy feedback template").props.onClick;
  click(); click(); assert.deepEqual(app.copied, [content.feedbackTemplate]);
  assert.equal(app.button("Copy feedback template").props.disabled, true);
  reject(new Error("permission denied")); await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.message().props.role, "alert"); assert.match(app.message().props.children, /Select and copy/);
  assert.ok(renderToStaticMarkup(app.render()).includes(content.feedbackTemplate));
  app.unmount(); click(); assert.equal(app.copied.length, 1);
});

test("copy succeeds only after clipboard fulfillment and never submits feedback", async t => {
  const app = harness(t); app.button("Copy feedback template").props.onClick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.message().props.role, "status"); assert.match(app.message().props.children, /Nothing was submitted/);
  assert.deepEqual(app.copied, [content.feedbackTemplate]); app.unmount();
});

test("download builds exactly the public text, releases resources and discloses blocked saving", async t => {
  const app = harness(t), links = []; let blob, revoked = [];
  t.mock.method(URL, "createObjectURL", value => { blob = value; return "blob:synthetic"; });
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: {
    body: { appendChild(link) { links.push(link); } }, createElement: () => ({ click() {}, remove() { this.removed = true; } }),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; });
  app.button("Download guide (.txt)").props.onClick();
  assert.equal(await blob.text(), content.guideText); assert.equal(links[0].download, "VitaAi_Local_Simulation_Tester_Guide.txt");
  assert.equal(links[0].removed, true); assert.deepEqual(revoked, ["blob:synthetic"]);
  assert.match(app.message().props.children, /download requested/); assert.equal(app.copied.length, 0);
  URL.createObjectURL.mock.mockImplementation(() => { throw new Error("unavailable"); }); revoked = [];
  app.button("Download guide (.txt)").props.onClick();
  assert.equal(app.message().props.role, "alert"); assert.match(app.message().props.children, /no file save was confirmed/);
  assert.deepEqual(revoked, []); app.unmount();
});

test("public PDF manifest binds the exact shared guide and distributed artifact", () => {
  assert.equal(pdfManifest.guide_version, content.guideVersion);
  assert.equal(pdfManifest.content_sha256, createHash("sha256").update(content.guideText).digest("hex"));
  assert.equal(pdfManifest.pdf_sha256, createHash("sha256").update(pdfBytes).digest("hex"));
  assert.equal(pdfBytes.subarray(0, 5).toString(), "%PDF-");
});

test("PDF download reads only the public file, locks duplicates, verifies bytes and releases resources", async t => {
  const app = harness(t), requests = [], links = [], revoked = []; let resolve, blob;
  t.mock.method(globalThis, "fetch", (url, init) => new Promise(done => { requests.push({ url, init }); resolve = done; }));
  t.mock.getter(globalThis, "crypto", () => ({ subtle: { digest: async (_name, bytes) => new Uint8Array(createHash("sha256").update(Buffer.from(bytes)).digest()).buffer } }));
  t.mock.method(URL, "createObjectURL", value => { blob = value; return "blob:pdf"; });
  t.mock.method(URL, "revokeObjectURL", url => revoked.push(url));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", { configurable: true, value: { body: { appendChild: link => links.push(link) }, createElement: () => ({ click() {}, remove() { this.removed = true; } }) } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document; });
  const click = app.button("Download illustrated guide (.pdf)").props.onClick;
  click(); click(); assert.equal(requests.length, 1); assert.equal(requests[0].url, `/guides/${content.guideVersion}.pdf`);
  assert.equal(requests[0].init.credentials, "omit"); assert.equal(requests[0].init.cache, "no-store");
  assert.equal(app.button("Download illustrated guide (.pdf)").props.disabled, true);
  resolve({ ok: true, headers: new Headers({ "content-type": "application/pdf" }), arrayBuffer: async () => pdfBytes });
  await new Promise(done => setImmediate(done));
  assert.equal(blob.type, "application/pdf"); assert.equal(links[0].download, "VitaAi_Local_Simulation_Tester_Guide.pdf");
  assert.equal(links[0].removed, true); assert.deepEqual(revoked, ["blob:pdf"]);
  assert.match(app.message().props.children, /no file save was confirmed/); assert.equal(app.copied.length, 0);
  app.unmount(); click(); assert.equal(requests.length, 1);
});

test("PDF network, wrong content, stale version and unmount failures never claim a save", async t => {
  for (const mode of ["network", "missing", "wrong-mime", "wrong-bytes", "stale-version", "unmount"]) {
    await t.test(mode, async sub => {
      let resolve, calls = 0, creates = 0, signal;
      const app = harness(sub, async () => {}, mode === "stale-version" ? { ...pdfManifest, guide_version: "older" } : pdfManifest);
      sub.mock.method(globalThis, "fetch", (_url, init) => { calls++; signal = init.signal;
        if (mode === "network") return Promise.reject(new Error("offline"));
        return new Promise(done => { resolve = done; });
      });
      sub.mock.getter(globalThis, "crypto", () => ({ subtle: { digest: async () => new Uint8Array(32).buffer } }));
      sub.mock.method(URL, "createObjectURL", () => { creates++; return "blob:unexpected"; });
      app.button("Download illustrated guide (.pdf)").props.onClick();
      if (mode === "unmount") app.unmount();
      resolve?.({ ok: mode !== "missing", headers: new Headers({ "content-type": mode === "wrong-mime" ? "text/html" : "application/pdf" }), arrayBuffer: async () => pdfBytes });
      await new Promise(done => setImmediate(done));
      assert.equal(creates, 0); assert.equal(calls, mode === "stale-version" ? 0 : 1);
      if (mode === "unmount") { assert.equal(signal.aborted, true); assert.equal(app.message(), undefined); }
      else { assert.equal(app.message().props.role, "alert"); assert.match(app.message().props.children, /no file save was confirmed/); app.unmount(); }
    });
  }
});
