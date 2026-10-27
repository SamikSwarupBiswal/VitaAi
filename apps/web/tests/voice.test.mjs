import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), ts = require("typescript");
const filename = fileURLToPath(new URL("../lib/voice.ts", import.meta.url)), compiled = new Module(filename);
compiled.filename = filename; compiled.paths = Module._nodeModulePaths(path.dirname(filename));
compiled._compile(ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { LocalVoice, normalizeTranscript } = compiled.exports;
function environment() {
  const states = [], transcripts = [], timers = new Map(), calls = { start: 0, abort: 0, stop: 0, cancel: 0, speak: [] };
  let number = 0;
  const recognition = { processLocally: false, start() { calls.start++; }, abort() { calls.abort++; }, stop() { calls.stop++; } };
  const env = { recognition: () => recognition, synthesis: { getVoices: () => [{ localService: false, lang: "en-US", name: "Remote" }, { localService: true, lang: "en-US", name: "Local" }],
    speak(value) { calls.speak.push(value); }, cancel() { calls.cancel++; } }, utterance: text => ({ text }),
    timer(fn, delay) { timers.set(++number, { fn, delay }); return number; }, clearTimer(id) { timers.delete(id); } };
  return { env, recognition, calls, states, transcripts, timers, voice: new LocalVoice(env, (state, detail) => states.push({ state, detail }), value => transcripts.push(value)) };
}
test("transcript normalization keeps words/Unicode while rejecting empty, oversized and control-bearing text", () => {
  assert.equal(normalizeTranscript("  cafe\u0301\n risk  "), "café risk");
  for (const value of [" ", "x".repeat(2001), "bad\0text", "bad\u202etext"]) assert.throws(() => normalizeTranscript(value));
});
test("recognition requires consent and on-device capability; it never falls back to a remote service", () => {
  const app = environment(); app.voice.listen(false); assert.equal(app.calls.start, 0); assert.equal(app.states.at(-1).state, "permission_denied");
  delete app.recognition.processLocally; app.voice.listen(true); assert.equal(app.calls.start, 0); assert.equal(app.states.at(-1).state, "unsupported");
});
test("a final normalized transcript edits the draft once and duplicate/cancelled callbacks are inert", () => {
  const app = environment(); app.voice.listen(true); app.voice.listen(true); assert.equal(app.calls.start, 1);
  assert.equal(app.recognition.processLocally, true); const callback = app.recognition.onresult;
  callback({ results: [{ isFinal: true, 0: { transcript: " Explain   risk " } }] });
  assert.deepEqual(app.transcripts, ["Explain risk"]); assert.equal(app.calls.abort, 1); assert.equal(app.timers.size, 0);
  callback({ results: [{ isFinal: true, 0: { transcript: "Late result" } }] }); assert.deepEqual(app.transcripts, ["Explain risk"]);
});
test("permission, capture, oversized transcript and duration failures stay explicit and retryable", () => {
  const app = environment(); app.voice.listen(true); app.recognition.onerror({ error: "not-allowed" });
  assert.equal(app.states.at(-1).state, "permission_denied"); app.voice.listen(true);
  app.recognition.onresult({ results: [{ isFinal: true, 0: { transcript: "x".repeat(2001) } }] }); assert.equal(app.states.at(-1).state, "failed");
  app.voice.listen(true); const timer = [...app.timers.values()][0]; assert.equal(timer.delay, 30000); timer.fn(); assert.equal(app.states.at(-1).state, "failed");
  assert.deepEqual(app.transcripts, []); app.voice.listen(true); app.voice.finish(); assert.equal(app.calls.stop, 1);
  app.voice.dispose(); app.voice.listen(true); assert.equal(app.calls.start, 4); assert.equal(app.timers.size, 0);
});
test("playback uses only a local voice and exact transcript, with cancellation and late-event fencing", () => {
  const app = environment(); app.voice.speak("Original answer. Unknown outcome."); app.voice.speak("Duplicate");
  assert.equal(app.calls.speak.length, 1); const spoken = app.calls.speak[0]; assert.equal(spoken.voice.name, "Local");
  assert.equal(spoken.text, "Original answer. Unknown outcome."); const late = spoken.onend;
  app.voice.cancel(); assert.equal(app.calls.cancel, 1); assert.equal(app.timers.size, 0); late(); assert.equal(app.states.at(-1).state, "cancelled");
  app.voice.speak("Retry"); app.calls.speak[1].onend(); assert.equal(app.states.at(-1).state, "idle");
  app.env.synthesis.getVoices = () => [{ localService: false, lang: "en-US" }]; app.voice.speak("No remote fallback");
  assert.equal(app.states.at(-1).state, "unsupported"); assert.equal(app.calls.speak.length, 2);
});
test("voice constructor/start/synthesis failures and playback limits never cause a submission", () => {
  const app = environment(); app.recognition.start = () => { throw new Error("private"); }; app.voice.listen(true);
  assert.equal(app.states.at(-1).state, "failed"); assert.equal(app.timers.size, 0);
  app.voice.speak("x".repeat(6001)); assert.equal(app.calls.speak.length, 0);
  app.env.synthesis.speak = () => { throw new Error("private"); }; app.voice.speak("Answer"); assert.equal(app.states.at(-1).state, "failed");
  assert.equal(app.timers.size, 0); assert.deepEqual(app.transcripts, []); assert.ok(app.states.every(item => !item.detail.includes("private")));
});
