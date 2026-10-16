import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { coverageComplete, mutationDecision, stopDecision, createdThreadId, checkProfiles, mergeRange, contextCheckpoint, shellWords, Workflow } from './agent-workflow.mjs';

test('document coverage requires every emitted range and the current hash', () => {
  const receipt = { hash: 'current', ranges: [[0, 3], [6, 9]] };
  assert.equal(coverageComplete(receipt, 'current', 9), false);
  receipt.ranges = mergeRange(receipt.ranges, [3, 6]);
  assert.equal(coverageComplete(receipt, 'current', 9), true);
  assert.equal(coverageComplete(receipt, 'changed', 9), false);
});

test('empty files still need a receipt', () => {
  assert.equal(coverageComplete(undefined, 'hash', 0), false);
  assert.equal(coverageComplete({ hash: 'hash', ranges: [[0, 0]] }, 'hash', 0), true);
});

test('first-touch retries cannot substitute for completed document reads', () => {
  const state = { phase: 'editing', files: ['src/a.js'], docsFresh: false };
  assert.match(mutationDecision(state, ['src/a.js']), /read/i);
  assert.match(mutationDecision(state, ['src/a.js']), /read/i);
});

test('editing is confined to the declared checkpoint', () => {
  const state = { phase: 'editing', files: ['src/a.js'], docsFresh: true };
  assert.equal(mutationDecision(state, ['src/a.js']), null);
  assert.match(mutationDecision(state, ['src/b.js']), /scope/i);
});

test('validated checkpoint cannot start more source edits without revision', () => {
  assert.match(mutationDecision({ phase: 'validated', files: ['a.js'], docsFresh: true }, ['a.js']), /revise|commit/i);
});

test('successful continuation dispatch blocks all further old-session mutations', () => {
  assert.match(mutationDecision({ phase: 'dispatched', files: ['a.js'], docsFresh: true }, ['a.js']), /stop/i);
});

test('a pending handoff cannot end without a creation receipt', () => {
  assert.match(stopDecision({ phase: 'handoff' }), /dispatch/i);
  assert.equal(stopDecision({ phase: 'dispatched' }), null);
  assert.equal(stopDecision({ phase: 'handoff-failed', blocker: 'Tool unavailable; manual prompt saved.' }), null);
});

test('unfinished checkpoints need a commit or an explicit recorded blocker', () => {
  assert.match(stopDecision({ phase: 'validated' }), /commit|checkpoint/i);
  assert.equal(stopDecision({ phase: 'committed' }), null);
  assert.equal(stopDecision({ phase: 'editing', blocker: 'Account limit prevented required check.' }), null);
});

test('an informational reply or explicit user pause need not complete implementation', () => {
  assert.equal(stopDecision({ phase: 'editing', informational: true }), null);
  assert.equal(stopDecision({ phase: 'editing', paused: true }), null);
});

test('only successful structured creation results count as dispatch', () => {
  const id = '01a14094-7fb4-7ae0-8a50-b7090235a2d4';
  assert.equal(createdThreadId({ threadId: id }), id);
  assert.equal(createdThreadId({ content: [{ type: 'text', text: JSON.stringify({ threadId: id }) }] }), id);
  assert.equal(createdThreadId({ isError: true, threadId: id }), null);
  assert.equal(createdThreadId({ clientThreadId: id }), null);
  assert.equal(createdThreadId({ status: 'failed', threadId: id }), null);
  assert.equal(createdThreadId({ output: 'Created thread ' + id }), null);
  assert.equal(createdThreadId({ threadId: id }, id), null);
});

test('checks follow the affected code instead of accepting an arbitrary success command', () => {
  assert.deepEqual(checkProfiles(['docs/PRD.md']), ['docs']);
  assert.deepEqual(checkProfiles(['apps/web/components/a.tsx']), ['docs', 'typecheck', 'lint', 'build', 'gateway']);
  assert.deepEqual(checkProfiles(['services/api/vita_api/a.py']), ['docs', 'backend', 'ruff']);
  assert.deepEqual(checkProfiles(['scripts/agent-workflow.mjs']), ['docs', 'guard']);
});

// Synthetic native events exercise the adapter; these are not Desktop event evidence.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vitaai-workflow-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = args => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Workflow test']);
  git(['config', 'user.email', 'workflow@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  const files = ['AGENTS.md', 'docs/IMPLEMENTATION_STATE.md', 'docs/PRD.md', 'docs/FEATURE_PARITY.md',
    'docs/ARCHITECTURE.md', 'docs/IMPLEMENTATION_PLAN.md', 'README.md', 'apps/web/AGENTS.md'];
  for (const file of files) { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); fs.writeFileSync(path.join(root, file), '# Fixture\n'); }
  git(['add', '--', ...files]); git(['commit', '-qm', 'fixture']);
  const workflow = new Workflow(root, path.join(root, '.receipts'), 'test-session');
  const event = (hook_event_name, tool_name, tool_input, tool_response) => workflow.hook({ hook_event_name, tool_name, tool_input, tool_response, cwd: root });
  const read = file => {
    const output = workflow.read(file);
    event('PostToolUse', 'exec_command', { cmd: `node scripts/agent-workflow.mjs read ${file}` }, { exit_code: 0, output });
  };
  return { root, workflow, git, files, event, read, readAll: () => files.forEach(read) };
}

test('read receipt requires complete observed output, not just running the reader', t => {
  const { workflow, event } = fixture(t);
  const output = workflow.read('README.md');
  assert.equal(workflow.fresh(['README.md']), false);
  event('PostToolUse', 'exec_command', {}, { exit_code: 0, output: output.slice(0, 20) });
  assert.equal(workflow.fresh(['README.md']), false);
  workflow.read('README.md');
  event('PostToolUse', 'exec_command', {}, { exit_code: 2, output });
  assert.equal(workflow.fresh(['README.md']), false);
  workflow.read('README.md');
  event('PostToolUse', 'exec_command', {}, { exit_code: 0, output });
  assert.equal(workflow.fresh(['README.md']), true);
});

test('file changes revoke a completed read and repeated blocked edits stay blocked', t => {
  const { root, workflow, event, readAll } = fixture(t);
  readAll(); workflow.begin('slice', ['src/a.js']);
  fs.appendFileSync(path.join(root, 'README.md'), 'Changed\n');
  const edit = '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** End Patch';
  for (let attempt = 0; attempt < 2; attempt++) assert.equal(event('PreToolUse', 'apply_patch', edit).hookSpecificOutput.permissionDecision, 'deny');
});

test('native result envelopes preserve failure and tolerate Windows line endings', t => {
  const { workflow, event } = fixture(t);
  const output = workflow.read('README.md');
  event('PostToolUse', 'exec_command', {}, { content: [{ type: 'text', text: JSON.stringify({ exit_code: 1, output }) }] });
  assert.equal(workflow.fresh(['README.md']), false);
  workflow.read('README.md');
  event('PostToolUse', 'exec_command', {}, { content: [{ type: 'text', text: JSON.stringify({ exit_code: 0, output: output.replaceAll('\n', '\r\n') }) }] });
  assert.equal(workflow.fresh(['README.md']), true);
});

test('renaming to an undeclared source path is blocked', t => {
  const { workflow, event, readAll } = fixture(t);
  readAll(); workflow.begin('slice', ['src/a.js']);
  const result = event('PreToolUse', 'apply_patch', '*** Begin Patch\n*** Update File: src/a.js\n*** Move to: src/b.js\n@@\n-a\n+b\n*** End Patch');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /scope/i);
});

test('secret and escaping paths cannot acquire workflow receipts', t => {
  const { workflow } = fixture(t);
  assert.throws(() => workflow.relative('../outside.md'), /outside/i);
  assert.throws(() => workflow.relative('services/api/.env'), /credential/i);
  assert.throws(() => workflow.relative('.git/config'), /outside/i);
});

test('a second slice is rejected before the current one is committed', t => {
  const { workflow, readAll } = fixture(t);
  readAll(); workflow.begin('slice', ['README.md']);
  assert.throws(() => workflow.begin('another', ['AGENTS.md']), /unfinished/i);
});

test('normal and whitespace reviews cover actual staged new files before a real commit', t => {
  const { root, workflow, git, readAll, read, event } = fixture(t);
  readAll(); workflow.begin('docs slice', ['README.md', 'docs/IMPLEMENTATION_STATE.md']);
  fs.appendFileSync(path.join(root, 'README.md'), 'Implemented docs\n');
  read('README.md'); workflow.validate();
  assert.throws(() => workflow.commit('docs: fixture'), /state/i);
  fs.appendFileSync(path.join(root, 'docs/IMPLEMENTATION_STATE.md'), 'Verified fixture; next action recorded\n');
  read('docs/IMPLEMENTATION_STATE.md');
  git(['add', '--', 'README.md', 'docs/IMPLEMENTATION_STATE.md']);
  assert.throws(() => workflow.commit('docs: fixture'), /review/i);
  for (const mode of ['normal', 'whitespace']) {
    const output = workflow.review(mode);
    event('PostToolUse', 'exec_command', {}, { exit_code: 0, output });
  }
  const commit = workflow.commit('docs: fixture');
  assert.equal(commit, git(['rev-parse', 'HEAD']).trim());
  assert.equal(workflow.state.phase, 'committed');
});

test('unrelated staged paths are rejected even after validation', t => {
  const { root, workflow, git, readAll, read } = fixture(t);
  readAll(); workflow.begin('slice', ['README.md', 'docs/IMPLEMENTATION_STATE.md']);
  workflow.validate(); fs.appendFileSync(path.join(root, 'docs/IMPLEMENTATION_STATE.md'), 'Checkpoint\n'); read('docs/IMPLEMENTATION_STATE.md');
  fs.writeFileSync(path.join(root, 'unrelated.txt'), 'Other work\n'); git(['add', '--', 'unrelated.txt']);
  assert.throws(() => workflow.commit('docs: bad'), /staged paths/i);
});

test('changed source cannot reuse a successful validation receipt', t => {
  const { root, workflow, readAll } = fixture(t);
  readAll(); workflow.begin('slice', ['src/a.js']);
  workflow.state.phase = 'validated'; workflow.state.validation = { hash: workflow.sourceHash() };
  fs.mkdirSync(path.join(root, 'src')); fs.writeFileSync(path.join(root, 'src/a.js'), 'changed');
  assert.throws(() => workflow.commit('fix: stale'), /validate current/i);
});

test('wrong continuation arguments and pending responses never unlock Stop', t => {
  const { workflow, event } = fixture(t);
  workflow.state.phase = 'handoff';
  workflow.state.handoff = { title: 'Stage 2 Workflow — Part 5', promptHash: 'unmatched', projectId: 'saved' };
  assert.equal(event('PreToolUse', 'mcp__codex_app__create_thread', { title: 'wrong' }).hookSpecificOutput.permissionDecision, 'deny');
  event('PostToolUse', 'mcp__codex_app__create_thread', { title: 'wrong' }, { threadId: '00000000-0000-0000-0000-000000000000' });
  assert.equal(event('Stop').decision, 'block');
});

test('all tools are blocked in the old chat after confirmed dispatch state', t => {
  const { workflow, event } = fixture(t);
  workflow.state.phase = 'dispatched';
  for (const tool of ['exec_command', 'apply_patch', 'mcp__codex_app__list_threads']) assert.equal(event('PreToolUse', tool, {}).hookSpecificOutput.permissionDecision, 'deny');
  assert.deepEqual(event('Stop'), {});
});

test('prepared handoff accepts only a ready matching native creation receipt', t => {
  const { root, workflow, readAll, event, git } = fixture(t);
  const title = 'Stage 2 Workflow — Part 5';
  const prompt = `Continue ${title}. Read C:\\projects\\VitaAi\\AGENTS.md and C:\\projects\\VitaAi\\docs\\IMPLEMENTATION_STATE.md completely. Preserve work and immediately continue the recorded next action.`;
  fs.appendFileSync(path.join(root, 'docs/IMPLEMENTATION_STATE.md'), `\n\x60\x60\x60text\n${prompt}\n\x60\x60\x60\n`);
  git(['add', '--', 'docs/IMPLEMENTATION_STATE.md']); git(['commit', '-qm', 'prepared prompt']);
  readAll(); workflow.state.phase = 'committed';
  const args = workflow.handoff(title, 'saved-project');
  assert.deepEqual(event('PreToolUse', 'mcp__codex_app__create_thread', args), {});
  event('PostToolUse', 'mcp__codex_app__create_thread', args, { clientThreadId: '00000000-0000-0000-0000-000000000001' });
  assert.equal(workflow.state.phase, 'handoff');
  event('PostToolUse', 'mcp__codex_app__create_thread', args, { isError: true, threadId: '00000000-0000-0000-0000-000000000001' });
  assert.equal(workflow.state.phase, 'handoff');
  event('PostToolUse', 'mcp__codex_app__create_thread', args, { content: [{ type: 'text', text: JSON.stringify({ threadId: '00000000-0000-0000-0000-000000000001' }) }] });
  assert.equal(workflow.state.phase, 'dispatched');
  assert.equal(event('PreToolUse', 'exec_command', { cmd: 'git status' }).hookSpecificOutput.permissionDecision, 'deny');
});

test('handoff can preserve a documentation checkpoint without reopening implementation', t => {
  const { workflow, readAll, event } = fixture(t);
  readAll(); workflow.state.phase = 'handoff'; workflow.state.checkpointPhase = 'idle';
  assert.throws(() => workflow.begin('new source', ['src/a.js']), /only a documentation/i);
  workflow.begin('preserve checkpoint', ['docs/IMPLEMENTATION_STATE.md']);
  workflow.validate();
  assert.equal(workflow.state.phase, 'handoff'); assert.equal(workflow.state.checkpointPhase, 'validated');
  assert.match(event('PreToolUse', 'apply_patch', '*** Begin Patch\n*** Add File: src/a.js\n+x\n*** End Patch').hookSpecificOutput.permissionDecisionReason, /handoff/i);
});

test('handoff prompt binding tolerates working-tree CRLF and committed LF', t => {
  const { root, workflow, readAll, git } = fixture(t);
  const title = 'Stage 2 Workflow — Part 6';
  const prompt = `Continue ${title}.\nRead C:\\projects\\VitaAi\\AGENTS.md and C:\\projects\\VitaAi\\docs\\IMPLEMENTATION_STATE.md completely.`;
  const file = path.join(root, 'docs/IMPLEMENTATION_STATE.md');
  fs.appendFileSync(file, `\n\x60\x60\x60text\n${prompt}\n\x60\x60\x60\n`);
  git(['add', '--', 'docs/IMPLEMENTATION_STATE.md']); git(['commit', '-qm', 'LF prompt']);
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replaceAll('\n', '\r\n'));
  readAll(); workflow.state.phase = 'committed';
  assert.equal(workflow.handoff(title, 'saved').prompt, prompt);
});

function runtimeRecords(session, readings) {
  return [{ type: 'session_meta', payload: { session_id: session } }, ...readings];
}
const occupancy = (used, at = '2026-10-16T00:00:00Z') => ({ type: 'event_msg', timestamp: at, payload: { type: 'token_count', info: { model_context_window: 475000, last_token_usage: { total_tokens: used }, total_token_usage: { total_tokens: 99000000 } } } });

test('context uses first confirmed post-compaction baseline, not billing or 75% occupancy', () => {
  const before = runtimeRecords('chat', [occupancy(400000)]);
  assert.equal(contextCheckpoint(before, 'chat').triggered, false);
  const records = [...before, { type: 'compacted' }, occupancy(60000), occupancy(178750)];
  const checkpoint = contextCheckpoint(records, 'chat');
  assert.equal(checkpoint.baseline, 60000); assert.equal(checkpoint.target, 178750); assert.equal(checkpoint.triggered, true);
  const restored = contextCheckpoint(runtimeRecords('chat', [occupancy(70000)]), 'chat', checkpoint);
  assert.equal(restored.baseline, 60000); assert.equal(restored.target, 178750); assert.equal(restored.triggered, true);
});

test('occupancy decrease is not compaction and a missing baseline is never zero', () => {
  assert.equal(contextCheckpoint(runtimeRecords('chat', [occupancy(400000), occupancy(10000)]), 'chat').compactions, 0);
  const missing = contextCheckpoint(runtimeRecords('chat', [{ type: 'compacted' }]), 'chat');
  assert.equal(missing.baseline, undefined); assert.equal(missing.target, undefined); assert.equal(missing.triggered, false);
});

test('second compaction forces handoff; setup chat alone stays exempt', () => {
  const events = [{ type: 'compacted' }, occupancy(60000), { type: 'compacted' }, occupancy(20000)];
  assert.equal(contextCheckpoint(runtimeRecords('chat', events), 'chat').triggered, true);
  const setup = '01a139fd-0fe3-7110-8e59-bdc58c4024a6';
  assert.equal(contextCheckpoint(runtimeRecords(setup, events), setup).triggered, false);
  assert.match(contextCheckpoint(runtimeRecords('other', events), 'chat').reliability, /mismatch/i);
});

test('literal command arguments do not admit shell substitutions or chained commands', () => {
  assert.deepEqual(shellWords("node scripts/agent-workflow.mjs permit 'python -c \"a; b\"' 'Required probe'"), ['node', 'scripts/agent-workflow.mjs', 'permit', 'python -c "a; b"', 'Required probe']);
  assert.equal(shellWords('node scripts/agent-workflow.mjs status; write-file x'), null);
  assert.equal(shellWords('node scripts/agent-workflow.mjs read $(Get-Secret)'), null);
  assert.equal(shellWords('node scripts/agent-workflow.mjs begin "$x"'), null);
  assert.equal(shellWords("node scripts/agent-workflow.mjs begin 'unfinished"), null);
});

test('CLI persists real checkpoint transitions and clears validation on revision', t => {
  const { root, git, files } = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  const module = path.join(root, 'scripts/agent-workflow.mjs');
  fs.copyFileSync(fileURLToPath(new URL('./agent-workflow.mjs', import.meta.url)), module);
  const environment = { ...process.env, CODEX_THREAD_ID: 'cli-fixture', LOCALAPPDATA: path.join(root, 'external-data') };
  const cli = (...args) => spawnSync(process.execPath, [module, ...args], { cwd: root, env: environment, encoding: 'utf8' });
  const successful = (...args) => { const result = cli(...args); assert.equal(result.status, 0, result.stderr); return result.stdout; };
  const directory = JSON.parse(successful('status')).directory;
  const acknowledge = output => new Workflow(root, directory, 'cli-fixture').hook({ hook_event_name: 'PostToolUse', tool_name: 'exec_command', cwd: root, tool_response: { exit_code: 0, output } });
  const read = file => acknowledge(successful('read', file));
  assert.notEqual(cli('begin', 'missing reads', 'README.md').status, 0);
  files.forEach(read);
  successful('begin', 'docs fixture', 'README.md', 'docs/IMPLEMENTATION_STATE.md');
  successful('permit', 'node --version', 'Required runtime probe');
  const permitted = new Workflow(root, directory, 'cli-fixture');
  const native = { hook_event_name: 'PreToolUse', tool_name: 'exec_command', cwd: root, tool_input: { cmd: 'node --version' } };
  assert.deepEqual(permitted.hook(native), {});
  assert.equal(permitted.hook(native).hookSpecificOutput.permissionDecision, 'deny');
  successful('validate'); successful('revise', 'Correct the same documentation slice');
  assert.equal(JSON.parse(successful('status')).validation, null);
  successful('validate');
  fs.appendFileSync(path.join(root, 'README.md'), 'Documented\n');
  fs.appendFileSync(path.join(root, 'docs/IMPLEMENTATION_STATE.md'), 'Fixture validation completed; next action recorded\n');
  read('README.md'); read('docs/IMPLEMENTATION_STATE.md');
  git(['add', '--', 'README.md', 'docs/IMPLEMENTATION_STATE.md']);
  for (const mode of ['normal', 'whitespace']) acknowledge(successful('review', mode));
  assert.match(successful('commit', 'docs: CLI fixture').trim(), /^[0-9a-f]{40}$/);
  assert.equal(JSON.parse(successful('status')).phase, 'committed');
  assert.notEqual(cli('not-a-command').status, 0);
  assert.notEqual(cli('handoff', 'invalid', 'project').status, 0);
});

test('CLI reports live session locks without overwriting another operation', t => {
  const { root } = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  const module = path.join(root, 'scripts/agent-workflow.mjs');
  fs.copyFileSync(fileURLToPath(new URL('./agent-workflow.mjs', import.meta.url)), module);
  const environment = { ...process.env, CODEX_THREAD_ID: 'lock-fixture', LOCALAPPDATA: path.join(root, 'external-data') };
  const cli = () => spawnSync(process.execPath, [module, 'status'], { cwd: root, env: environment, encoding: 'utf8' });
  const directory = JSON.parse(cli().stdout).directory;
  const lock = path.join(directory, 'lock-fixture.lock');
  fs.writeFileSync(lock, String(process.pid));
  const result = cli();
  assert.notEqual(result.status, 0); assert.match(result.stderr, /another tool/i);
  assert.equal(fs.readFileSync(lock, 'utf8'), String(process.pid));
});

test('native adapter persists a transcript-triggered handoff without moving its baseline', t => {
  const { root, workflow, readAll, event } = fixture(t);
  readAll(); workflow.begin('editing fixture', ['scripts/agent-workflow.mjs']);
  const transcript = path.join(root, 'runtime-fixture.jsonl');
  const records = runtimeRecords('test-session', [{ type: 'compacted' }, occupancy(60000), occupancy(178750)]);
  fs.writeFileSync(transcript, records.map(record => JSON.stringify(record)).join('\n'));
  const result = workflow.hook({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: root, transcript_path: transcript, tool_input: '*** Begin Patch\n*** Add File: scripts/agent-workflow.mjs\n+x\n*** End Patch' });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(workflow.state.phase, 'handoff'); assert.equal(workflow.state.context.target, 178750);
  fs.writeFileSync(transcript, runtimeRecords('test-session', [occupancy(70000)]).map(record => JSON.stringify(record)).join('\n'));
  workflow.hook({ hook_event_name: 'PostCompact', cwd: root, transcript_path: transcript });
  assert.equal(workflow.state.context.baseline, 60000); assert.equal(workflow.state.phase, 'handoff');
  assert.equal(event('Stop').decision, 'block');
  workflow.hook({ hook_event_name: 'PreToolUse', tool_name: 'exec_command', tool_input: { cmd: 'git status' }, cwd: root, transcript_path: path.join(root, 'unavailable.jsonl') });
  assert.match(workflow.state.context.reliability, /unavailable/i);
});

test('a failing fixed validation command cannot produce a successful checkpoint', t => {
  const { root, workflow, readAll } = fixture(t);
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'scripts/agent-workflow.test.mjs'), 'throw new Error("Intentional isolated fixture failure");\n');
  readAll(); workflow.begin('regression fixture', ['scripts/agent-workflow.test.mjs']);
  const write = process.stdout.write;
  process.stdout.write = () => true;
  try { assert.throws(() => workflow.validate(), /check guard failed/i); }
  finally { process.stdout.write = write; }
  assert.equal(workflow.state.phase, 'editing'); assert.equal(workflow.state.validation, null);
});
