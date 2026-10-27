import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, mocks = {}) {
  const filename = fileURLToPath(new URL(relative, import.meta.url)), compiled = new Module(filename);
  compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
  const normal = compiled.require.bind(compiled); compiled.require = name => mocks[name] ?? normal(name);
  compiled._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return compiled.exports;
}
const lib = load("../lib/avatar.ts");
function wav(duration = 1) {
  const rate = 16000, size = rate * 2 * duration, buffer = new ArrayBuffer(44 + size), view = new DataView(buffer);
  const text = (offset, value) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, buffer.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, size, true); return buffer;
}
const csv = () => "TimeCode,jawOpen,eyeBlinkLeft,eyeBlinkRight,mouthSmileLeft\n" + Array.from({ length: 11 }, (_, index) => `${index / 10},${index % 2},0,0,0.2`).join("\n");
test("WAV validation checks actual bytes, format, full chunk lengths and duration", () => {
  assert.deepEqual(lib.validateAvatarWav(wav()), { duration: 1, sampleRate: 16000 });
  for (const mutate of [v => v.setUint8(0, 0), v => v.setUint32(4, 1, true), v => v.setUint16(22, 2, true),
    v => v.setUint16(34, 8, true), v => v.setUint32(24, 1, true), v => v.setUint32(40, 999999, true)]) {
    const bytes = wav(); mutate(new DataView(bytes)); assert.throws(() => lib.validateAvatarWav(bytes));
  }
  assert.throws(() => lib.validateAvatarWav(wav(61))); assert.throws(() => lib.validateAvatarWav(new ArrayBuffer(4)));
});
test("CSV enforces numeric bounded weights, strict time, coverage and paired-audio duration", () => {
  const frames = lib.parseAvatarCsv(csv(), 1); assert.equal(frames.length, 11); assert.equal(lib.avatarFrameAt(frames, 0.15).jawOpen, 1);
  assert.equal(lib.avatarFrameAt(frames, NaN), lib.neutralFrame);
  for (const value of [csv().replace("0.1,1", "0,1"), csv().replace("0.1,1", "0.1,2"), csv().replace("0.1,1", "0.1,NaN"),
    csv().replace("eyeBlinkRight", "eyeBlinkLeft"), csv().replace("TimeCode", "URL"),
    csv().split("\n").slice(0, 5).join("\n"), "x".repeat(2 * 1024 * 1024 + 1)]) {
    assert.throws(() => lib.parseAvatarCsv(value, 1));
  }
  assert.equal(lib.parseAvatarCsv(csv().replace("0.1,1,0,0,0.2\n", ""), 1).length, 10);
  assert.throws(() => lib.parseAvatarCsv(csv().split("\n").filter((_, i) => i < 3 || i > 7).join("\n"), 1));
  assert.throws(() => lib.parseAvatarCsv(csv(), 2));
});
test("original avatar renders only local numeric geometry with honest presentation labeling", () => {
  const { CompanionAvatar } = load("../components/avatar-controls.tsx", { "@/lib/avatar": lib });
  const html = renderToStaticMarkup(CompanionAvatar({ pose: lib.parseAvatarCsv(csv(), 1)[1] }));
  assert.match(html, /Vita original local avatar; presentation only/); assert.match(html, /<svg/); assert.doesNotMatch(html, /iframe|https:|script/);
});
test("avatar file selection, duplicate loads, invalid input and unmount cancel all retained assets", async t => {
  const slots = [], cleanups = [], requests = [], events = new Map(); let cursor = 0, effects = [], revoked = [], created = [];
  const previous = globalThis.window; globalThis.window = { addEventListener(n, fn) { events.set(n, fn); }, removeEventListener(n) { events.delete(n); } };
  t.mock.method(URL, "createObjectURL", () => { created.push("blob:synthetic"); return "blob:synthetic"; });
  t.mock.method(URL, "revokeObjectURL", value => revoked.push(value));
  const hooks = { ...React, useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], value => { slots[i] = value; }]; },
    useRef(initial) { const i = cursor++; return slots[i] ??= { current: initial }; },
    useCallback(fn) { const i = cursor++; return slots[i] ??= fn; }, useLayoutEffect(fn, deps) { const i = cursor++; if (!(i in slots)) { slots[i] = deps; effects.push(() => { cleanups[i] = fn(); }); } } };
  const { AvatarControls } = load("../components/avatar-controls.tsx", { react: hooks, "@/lib/avatar": lib });
  const walk = node => Array.isArray(node) ? node.flatMap(walk) : node && typeof node === "object" ? [node, ...walk(node.props?.children)] : [];
  const render = () => { cursor = 0; const value = AvatarControls(); const pending = effects; effects = []; pending.forEach(fn => fn()); return value; };
  const button = name => walk(render()).find(node => node.type === "button" && node.props.children === name);
  const inputs = () => walk(render()).filter(node => node.type === "input");
  t.after(() => { cleanups.forEach(fn => fn?.()); globalThis.window = previous; });
  inputs()[0].props.onChange({ target: { files: [{ size: 32044, arrayBuffer: () => new Promise(resolve => requests.push(resolve)) }] } });
  const animationBytes = new TextEncoder().encode("\uFEFF" + csv()).buffer;
  inputs()[1].props.onChange({ target: { files: [{ size: animationBytes.byteLength, arrayBuffer: async () => animationBytes }] } });
  const captured = button("Load local avatar files"), pending = captured.props.onClick(); await captured.props.onClick(); assert.equal(requests.length, 1);
  requests.shift()(wav()); await pending; assert.equal(created.length, 1); assert.match(renderToStaticMarkup(render()), /Validated local pair/);
  assert.ok(renderToStaticMarkup(render()).includes(await lib.avatarHash(animationBytes)));
  button("Clear avatar playback").props.onClick(); assert.deepEqual(revoked, ["blob:synthetic"]);
  const late = button("Load local avatar files").props.onClick(); cleanups.forEach(fn => fn?.()); requests.shift()(wav()); await late;
  assert.equal(created.length, 1); assert.equal(events.size, 0);
});
