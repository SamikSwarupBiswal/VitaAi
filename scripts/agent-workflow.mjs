import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE = 'docs/IMPLEMENTATION_STATE.md';
const REQUIRED = ['AGENTS.md', STATE, 'docs/PRD.md', 'docs/FEATURE_PARITY.md',
  'docs/ARCHITECTURE.md', 'docs/IMPLEMENTATION_PLAN.md', 'README.md', 'apps/web/AGENTS.md'];
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const need = (condition, message) => { if (!condition) throw new Error(message); };
const SETUP_CHAT = '01a139fd-0fe3-7110-8e59-bdc58c4024a6';

// Occupancy comes from an observed runtime record, never accumulated billing.
export function contextCheckpoint(records, session, previous = {}) {
  const identity = records.find(record => record.type === 'session_meta')?.payload;
  if ((identity?.session_id ?? identity?.id) !== session) return { ...previous, reliability: 'transcript identity mismatch' };
  const compactions = records.filter(record => record.type === 'compacted');
  let afterFirst = false, firstReading;
  let latest;
  for (const record of records) {
    if (record === compactions[0]) afterFirst = true;
    const info = record.type === 'event_msg' && record.payload?.type === 'token_count' ? record.payload.info : null;
    if (!Number.isSafeInteger(info?.last_token_usage?.total_tokens) || !Number.isSafeInteger(info?.model_context_window)) continue;
    const reading = { used: info.last_token_usage.total_tokens, capacity: info.model_context_window, at: record.timestamp };
    if (reading.capacity <= 0 || reading.used < 0) continue;
    latest = reading;
    if (afterFirst && !firstReading) firstReading = reading;
  }
  const capacity = previous.capacity ?? firstReading?.capacity ?? latest?.capacity;
  const baseline = previous.baseline ?? firstReading?.used;
  const target = previous.target ?? (baseline !== undefined && capacity ? baseline + 0.25 * capacity : undefined);
  const count = Math.max(previous.compactions ?? 0, compactions.length);
  return { ...previous, capacity, baseline, target, compactions: count,
    baselineAt: previous.baselineAt ?? firstReading?.at, latest,
    reliability: latest ? 'runtime last_token_usage occupancy; compaction-based estimate' : 'runtime occupancy unavailable',
    triggered: previous.triggered || (session !== SETUP_CHAT && (count >= 2 || (count >= 1 && target !== undefined && latest?.used >= target))) };
}

export function mergeRange(ranges, next) {
  const merged = [];
  for (const range of [...ranges, next].sort((a, b) => a[0] - b[0])) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

export function coverageComplete(receipt, hash, length) {
  return Boolean(receipt && receipt.hash === hash && receipt.ranges?.some(([a, b]) => a === 0 && b === length));
}

export function mutationDecision(state, targets) {
  if (state.phase === 'dispatched') return 'Stop: continuation already dispatched; no more tools in this chat.';
  if (!state.docsFresh) return 'Read all required Markdown with the read command; hashes/ranges are incomplete or stale.';
  if (targets.every(file => file.endsWith('.md'))) return null;
  if (state.phase === 'handoff' || state.phase === 'handoff-failed') return 'Handoff triggered: preserve documentation and dispatch; no implementation.';
  if (state.phase !== 'editing') return 'Begin a slice, or revise the validated slice before editing; otherwise commit its checkpoint.';
  if (targets.some(file => !state.files.includes(file))) return 'Edit outside declared scope; revise the scope with an explicit reason first.';
  return null;
}

export function stopDecision(state) {
  if (state.paused || state.informational) return null;
  if (state.phase === 'handoff') return 'Handoff pending: dispatch the prepared continuation or record the actual creation failure.';
  if (state.phase === 'dispatched' || state.phase === 'committed' || state.phase === 'idle') return null;
  if (state.blocker) return null;
  return 'Unfinished checkpoint: validate, update state, review and commit, or record a concrete blocker with next action.';
}

export function createdThreadId(result, oldId) {
  if (!result || typeof result !== 'object' || result.isError || result.error || /fail|error|pending|queued/i.test(result.status ?? '')) return null;
  if (typeof result.threadId === 'string' && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(result.threadId) && result.threadId !== oldId) return result.threadId;
  if (result.structuredContent) return createdThreadId(result.structuredContent, oldId);
  for (const item of result.content ?? []) {
    if (item.type !== 'text') continue;
    let parsed;
    try { parsed = JSON.parse(item.text); } catch { continue; }
    const id = createdThreadId(parsed, oldId);
    if (id) return id;
  }
  return null;
}

export function checkProfiles(files) {
  need(files.every(file => file.endsWith('.md') || /^(apps\/web\/|services\/api\/|scripts\/agent-workflow(?:\.test)?\.mjs$)/.test(file)), 'No fixed validation profile for an affected path; add a justified check profile before claiming validation.');
  const profiles = ['docs'];
  if (files.some(file => file.startsWith('apps/web/') && !file.endsWith('.md'))) profiles.push('typecheck', 'lint', 'build', 'gateway');
  if (files.some(file => file.startsWith('services/api/') && !file.endsWith('.md'))) profiles.push('backend', 'ruff');
  if (files.some(file => file.startsWith('scripts/') && !file.endsWith('.md'))) profiles.push('guard');
  return profiles;
}

// A narrow literal-argument subset of PowerShell, not a general shell parser.
export function shellWords(command) {
  const words = []; let word = '', quoted = null, started = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (quoted) {
      if (char === quoted) {
        if (quoted === "'" && command[i + 1] === "'") { word += "'"; i++; }
        else quoted = null;
      } else {
        if (quoted === '"' && /[$`]/.test(char)) return null;
        word += char;
      }
    } else if (char === "'" || char === '"') { quoted = char; started = true; }
    else if (/[;\r\n|&`$(){}<>]/.test(char)) return null;
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += char; started = true; }
  }
  if (quoted) return null;
  if (started) words.push(word);
  return words;
}

export class Workflow {
  constructor(root, directory, session) {
    need(typeof session === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(session), 'Missing/invalid native session identity.');
    this.root = fs.realpathSync(root);
    this.directory = directory;
    fs.mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, `${session}.json`);
    this.session = session;
    this.state = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : { phase: 'idle', reads: {}, files: [] };
  }

  save() {
    const temporary = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(this.state, null, 2), { flag: 'wx' });
    fs.renameSync(temporary, this.file);
  }

  relative(file) {
    const absolute = path.resolve(this.root, file);
    const relative = path.relative(this.root, absolute).replaceAll('\\', '/');
    need(relative && !relative.startsWith('../') && !path.isAbsolute(relative) && !relative.split('/').some(part => ['.git', 'node_modules', '.venv', '.local'].includes(part)), 'Path outside project-owned source.');
    need(!/(^|\/)\.env(?:\.|$)/i.test(relative) || relative.endsWith('/.env.example'), 'Credential path excluded.');
    let ancestor = absolute;
    while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
    const real = path.relative(this.root, fs.realpathSync(ancestor));
    need(!real.startsWith('..') && !path.isAbsolute(real), 'Symlink escapes workspace.');
    return relative;
  }

  hash(file) {
    const relative = this.relative(file);
    return fs.existsSync(path.join(this.root, relative)) ? digest(fs.readFileSync(path.join(this.root, relative))) : 'absent';
  }

  git(args) {
    const result = spawnSync('git', args, { cwd: this.root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    need(!result.error && result.status === 0, `Git failed: ${result.stderr || result.error?.message || result.status}`);
    return result.stdout;
  }

  markdown() {
    return [...new Set([...REQUIRED, ...this.git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0')
      .filter(file => file.endsWith('.md') && !/^(vendor|reference)\//.test(file))])].filter(file => fs.existsSync(path.join(this.root, file)));
  }

  fresh(files = REQUIRED) {
    return files.every(file => {
      const content = fs.readFileSync(path.join(this.root, file), 'utf8');
      return coverageComplete(this.state.reads[file], digest(content), content.length);
    });
  }

  read(file, offset = 0) {
    file = this.relative(file);
    need(file.endsWith('.md'), 'Read receipts are only for Markdown.');
    const content = fs.readFileSync(path.join(this.root, file), 'utf8');
    need(Number.isSafeInteger(offset) && offset >= 0 && offset <= content.length, 'Invalid read offset.');
    const end = Math.min(content.length, offset + 12000);
    const hash = digest(content);
    const text = `${file} [${offset},${end})/${content.length} sha256=${hash}\n${content.slice(offset, end)}\nNEXT=${end < content.length ? end : 'complete'}`;
    this.state.pendingRead = { file, hash, range: [offset, end], text };
    this.save();
    return text;
  }

  begin(title, files) {
    const handoff = this.state.phase === 'handoff';
    need(['idle', 'committed'].includes(this.state.checkpointPhase ?? this.state.phase), 'Previous slice is unfinished; commit it or record a blocker.');
    need(!handoff || files.every(file => file.endsWith('.md')), 'After the handoff trigger only a documentation checkpoint can begin.');
    need(this.fresh(), 'Required document reads are missing/stale.');
    need(title?.trim() && files.length, 'Supply a slice title and exact files.');
    this.state = { ...this.state, phase: handoff ? 'handoff' : 'editing', checkpointPhase: handoff ? 'editing' : undefined, title, files: [...new Set(files.map(file => this.relative(file)))],
      started: new Date().toISOString(), startStateHash: this.hash(STATE), blocker: null, validation: null, reviews: {}, informational: false, paused: false };
    this.save();
  }

  sourceHash() {
    return digest(JSON.stringify(this.state.files.filter(file => !file.endsWith('.md')).map(file => [file, this.hash(file)])));
  }

  validate() {
    need((this.state.checkpointPhase ?? this.state.phase) === 'editing', 'Validation requires an editing slice.');
    need(this.fresh(), 'Required document reads are missing/stale.');
    const before = this.sourceHash();
    const profiles = checkProfiles(this.state.files);
    for (const profile of profiles) {
      if (profile === 'docs') {
        for (const file of this.markdown()) {
          const content = fs.readFileSync(path.join(this.root, file), 'utf8');
          need((content.match(/^```/gm)?.length ?? 0) % 2 === 0, `Unclosed Markdown fence: ${file}`);
        }
        continue;
      }
      let command = process.execPath, args, cwd = this.root;
      if (['typecheck', 'lint', 'build'].includes(profile)) {
        const npm = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
        need(fs.existsSync(npm), 'npm CLI not found beside Node; validation unavailable.');
        args = [npm, 'run', profile];
      } else if (profile === 'gateway') args = ['--test', 'apps/web/tests/gateway.test.mjs', ...this.git(['ls-files', '--cached', '--others', '--exclude-standard', 'apps/web/tests/*.test.mjs']).trim().split('\n').filter(file => file && !file.endsWith('/gateway.test.mjs'))];
      else if (profile === 'guard') args = ['--test', 'scripts/agent-workflow.test.mjs'];
      else {
        command = path.join(this.root, '.venv', 'Scripts', 'python.exe');
        cwd = path.join(this.root, 'services/api');
        args = profile === 'backend' ? ['-m', 'unittest', 'discover', '-s', 'tests', '-v'] : ['-m', 'ruff', 'check', 'vita_api', 'tests', 'migrations'];
      }
      const environment = { ...process.env };
      delete environment.NODE_TEST_CONTEXT; // An inherited test worker context can suppress a nested --test run.
      const result = spawnSync(command, args, { cwd, env: environment, encoding: 'utf8', timeout: 300000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      process.stdout.write(`[${profile}]\n${result.stdout ?? ''}${result.stderr ?? ''}`);
      need(!result.error && result.status === 0, `Check ${profile} failed; ${result.error?.message ?? result.status}.`);
    }
    need(before === this.sourceHash(), 'Source changed during validation; rerun checks.');
    if (this.state.phase === 'handoff') this.state.checkpointPhase = 'validated';
    else this.state.phase = 'validated';
    this.state.validation = { hash: before, profiles, at: new Date().toISOString() };
    this.state.blocker = null;
    this.state.reviews = {};
    this.save();
  }

  review(mode, offset = 0) {
    need(['normal', 'whitespace'].includes(mode), 'Review mode must be normal or whitespace.');
    const diff = this.git(['diff', '--cached', ...(mode === 'whitespace' ? ['-w'] : []), '--no-ext-diff', '--no-textconv']);
    need(diff.length > 0, 'No staged diff to review. Stage only your identified files/hunks.');
    need(Number.isSafeInteger(offset) && offset >= 0 && offset < diff.length, 'Invalid diff offset.');
    const hash = digest(diff), end = Math.min(diff.length, offset + 12000);
    this.state.pendingReview = { mode, hash, range: [offset, end], text: `${mode} [${offset},${end})/${diff.length}\n${diff.slice(offset, end)}\nNEXT=${end < diff.length ? end : 'complete'}` };
    this.save();
    return this.state.pendingReview.text;
  }

  commit(message) {
    need((this.state.checkpointPhase ?? this.state.phase) === 'validated' && this.state.validation?.hash === this.sourceHash(), 'Validate current source before committing.');
    need(this.fresh(), 'Reread changed required documents before committing.');
    need(this.hash(STATE) !== this.state.startStateHash, 'Update implementation state with actual results before committing.');
    const staged = this.git(['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean);
    need(staged.length && staged.every(file => this.state.files.includes(file)), 'Staged paths differ from declared slice; preserve other work unstaged.');
    need(staged.includes(STATE), 'Include your implementation-state checkpoint hunk in the commit.');
    for (const file of staged) {
      if (file.endsWith('.md')) continue; // Shared docs may contain another chat's unstaged hunks.
      const working = this.hash(file);
      const stagedContent = spawnSync('git', ['show', `:${file}`], { cwd: this.root, maxBuffer: 16 * 1024 * 1024 });
      need(working === 'absent' ? stagedContent.status !== 0 : stagedContent.status === 0 && digest(stagedContent.stdout) === working, `Staged bytes differ from validated working file: ${file}`);
    }
    for (const mode of ['normal', 'whitespace']) {
      const diff = this.git(['diff', '--cached', ...(mode === 'whitespace' ? ['-w'] : []), '--no-ext-diff', '--no-textconv']);
      need(coverageComplete(this.state.reviews?.[mode], digest(diff), diff.length), `Complete ${mode} staged diff review required.`);
    }
    this.git(['diff', '--cached', '--check']);
    need(message?.trim() && !message.startsWith('-'), 'Supply a commit message.');
    this.git(['commit', '-m', message]);
    if (this.state.phase === 'handoff') this.state.checkpointPhase = 'committed';
    else this.state.phase = 'committed';
    this.state.commit = this.git(['rev-parse', 'HEAD']).trim();
    this.save();
    return this.state.commit;
  }

  handoff(title, projectId) {
    need((this.state.checkpointPhase ?? this.state.phase) === 'committed' || this.state.blocker, 'Preserve the validated checkpoint/commit before handoff.');
    need(this.fresh(this.markdown()), 'Read/reconcile every project Markdown before preparing handoff.');
    need(/^Stage \d+ .{1,45} — Part \d+$/.test(title), 'Use Stage N Short title — Part P.');
    const record = fs.readFileSync(path.join(this.root, STATE), 'utf8');
    const prompts = [...record.matchAll(/^```text\r?\n([\s\S]*?)^```/gm)];
    const prompt = prompts.at(-1)?.[1].trim().replaceAll('\r\n', '\n');
    need(prompt?.includes(title) && prompt.includes('C:\\projects\\VitaAi\\AGENTS.md') && prompt.includes('C:\\projects\\VitaAi\\docs\\IMPLEMENTATION_STATE.md') && projectId, 'Save the complete current resume prompt as the last text block in implementation state, then supply its title and saved project id.');
    need(this.state.blocker || this.git(['show', `HEAD:${STATE}`]).replaceAll('\r\n', '\n').includes(prompt), 'Commit the prepared resume prompt before dispatch.');
    this.state.phase = 'handoff';
    this.state.handoff = { title, promptHash: digest(prompt), projectId, at: new Date().toISOString() };
    this.save();
    return { title, prompt, target: { type: 'project', projectId, environment: { type: 'local' } } };
  }

  hook(event) {
    const name = event.hook_event_name, tool = event.tool_name ?? '';
    const input = event.tool_input ?? {};
    let reason = null;
    if (event.transcript_path) {
      try {
        const transcript = fs.readFileSync(event.transcript_path, 'utf8');
        const records = transcript.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
        this.state.context = contextCheckpoint(records, this.session, this.state.context);
        if (this.state.context.triggered && !['handoff', 'handoff-failed', 'dispatched'].includes(this.state.phase)) {
          this.state.checkpointPhase = this.state.phase;
          this.state.phase = 'handoff';
        }
        this.save();
      } catch { this.state.context = { ...this.state.context, reliability: 'native transcript unavailable; no invented counter' }; this.save(); }
    }
    if (name === 'UserPromptSubmit') {
      const prompt = event.prompt ?? event.user_prompt ?? '';
      this.state.paused = /^(stop|pause|cancel)\b/i.test(prompt.trim());
      this.state.informational = /^(why|what|how|explain|tell me)\b/i.test(prompt.trim()) && !/\b(implement|fix|edit|create|continue)\b/i.test(prompt);
      this.save();
    } else if (name === 'PreToolUse') {
      if (this.state.phase === 'dispatched') reason = 'Stop now: continuation dispatched; deliver the prepared prompt without further tools.';
      else if (/(?:^|__)apply_patch$|^(Write|Edit|MultiEdit)$/.test(tool)) {
        const patch = typeof input === 'string' ? input : input.command ?? '';
        const targets = [...patch.matchAll(/^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm)].map(match => this.relative(path.resolve(event.cwd, match[1].trim())));
        if (input.file_path) targets.push(this.relative(input.file_path));
        reason = targets.length ? mutationDecision({ ...this.state, docsFresh: this.fresh() }, targets) : 'Unrecognized mutation; use scoped apply_patch.';
      } else if (/^(?:mcp__codex_app__|mcp__codex_apps__).*create_thread$/.test(tool)) {
        const expected = this.state.handoff;
        if (this.state.phase === 'handoff' && !expected || expected && (this.state.phase !== 'handoff' || input.title !== expected.title || digest(input.prompt ?? '') !== expected.promptHash || input.target?.projectId !== expected.projectId || input.target?.environment?.type !== 'local')) reason = 'Continuation must match the prepared title, prompt, saved project and local workspace.';
        else if (expected && !this.fresh(this.markdown())) reason = 'Project Markdown changed after handoff preparation; reconcile and reread it before dispatch.';
      } else if (/^(exec_command|Bash|PowerShell)$/.test(tool)) {
        const cmd = input.cmd ?? input.command ?? '';
        const words = shellWords(cmd);
        const helper = words?.[0] === 'node' && /^scripts[\\/]agent-workflow\.mjs$/.test(words[1] ?? '') && ['read', 'status', 'begin', 'revise', 'validate', 'review', 'commit', 'handoff', 'blocker', 'permit'].includes(words[2]);
        const reading = words && (words[0] === 'rg' || /^Get-(Content|Item|ChildItem)$/i.test(words[0]) || words[0] === 'git' && ['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files'].includes(words[1])) && !words.some(word => /^--(?:pre|output|ext-diff|textconv|config-env)(?:=|$)/.test(word) || word === '-c');
        const staging = words?.[0] === 'git' && words[1] === 'add' && (words[2] === '--' || words[2] === '-p' && words[3] === '--') && (this.state.checkpointPhase ?? this.state.phase) === 'validated';
        const authorized = this.state.commandPermit?.hash === digest(cmd) && this.state.phase === 'editing' && this.fresh();
        if (authorized) { delete this.state.commandPermit; this.save(); }
        if (!helper && !reading && !staging && !authorized) reason = 'Use the workflow helper for checks/commit and apply_patch for scoped edits. For a necessary unsupported command, authorize its exact text and reason with permit first; this is an audited workflow exception, not validation.';
      }
    } else if (name === 'PostToolUse' && /^(?:mcp__codex_app__|mcp__codex_apps__).*create_thread$/.test(tool) && this.state.phase === 'handoff') {
      const expected = this.state.handoff;
      if (expected && input.title === expected.title && digest(input.prompt ?? '') === expected.promptHash && input.target?.projectId === expected.projectId && input.target?.environment?.type === 'local') {
        const id = createdThreadId(event.tool_response, this.session);
        if (id) { this.state.phase = 'dispatched'; this.state.continuation = id; this.save(); }
      }
    } else if (name === 'PostToolUse' && /^(exec_command|Bash|PowerShell)$/.test(tool) && (this.state.pendingRead || this.state.pendingReview)) {
      const pending = this.state.pendingRead ?? this.state.pendingReview;
      const response = event.tool_response;
      const strings = [];
      let failed = false;
      const collect = value => {
        if (typeof value === 'string') { strings.push(value); try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object') collect(parsed); } catch { /* Plain output. */ } }
        else if (Array.isArray(value)) value.forEach(collect);
        else if (value && typeof value === 'object') {
          failed ||= value.isError === true || Boolean(value.error) || Number.isInteger(value.exit_code) && value.exit_code !== 0;
          Object.values(value).forEach(collect);
        }
      };
      collect(response);
      if (!failed && strings.some(text => text.replaceAll('\r\n', '\n').includes(pending.text.replaceAll('\r\n', '\n')))) {
        if (pending.file && this.hash(pending.file) === pending.hash) {
          const old = this.state.reads[pending.file];
          this.state.reads[pending.file] = { hash: pending.hash, ranges: mergeRange(old?.hash === pending.hash ? old.ranges : [], pending.range) };
        } else if (pending.mode) {
          const diff = this.git(['diff', '--cached', ...(pending.mode === 'whitespace' ? ['-w'] : []), '--no-ext-diff', '--no-textconv']);
          if (digest(diff) === pending.hash) {
            this.state.reviews ??= {};
            const old = this.state.reviews[pending.mode];
            this.state.reviews[pending.mode] = { hash: pending.hash, ranges: mergeRange(old?.hash === pending.hash ? old.ranges : [], pending.range) };
          }
        }
      }
      delete this.state.pendingRead;
      delete this.state.pendingReview;
      this.save();
    } else if (name === 'Stop') reason = stopDecision(this.state);
    fs.appendFileSync(path.join(this.directory, 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), session: this.session, event: name, tool, phase: this.state.phase, decision: reason ? 'block' : 'allow' }) + '\n');
    if (!reason) return ['SessionStart', 'UserPromptSubmit', 'PostCompact'].includes(name) ? { hookSpecificOutput: { hookEventName: name, additionalContext: 'VitaAi workflow guard: run node scripts/agent-workflow.mjs status from C:/projects/VitaAi. Required reads use the paged read command; declare a slice before source edits; validate, update state, review both staged diffs and commit before starting another slice. If handoff is pending, preserve its checkpoint and dispatch the prepared continuation, then stop all tools. Consult AGENTS.md for commands and limits.' } } : {};
    return name === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: name, permissionDecision: 'deny', permissionDecisionReason: reason } } : { decision: 'block', reason };
  }
}

function runtime(session) {
  const directory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'VitaAi', 'agent-workflow', digest(ROOT.toLowerCase()).slice(0, 16));
  return new Workflow(ROOT, directory, session);
}

function lockedRuntime(session, action) {
  need(/^[a-zA-Z0-9_-]{1,100}$/.test(session ?? ''), 'Missing/invalid native session identity.');
  const directory = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'VitaAi', 'agent-workflow', digest(ROOT.toLowerCase()).slice(0, 16));
  fs.mkdirSync(directory, { recursive: true });
  const lock = path.join(directory, `${session}.lock`);
  let descriptor;
  try { descriptor = fs.openSync(lock, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(lock, 'utf8'));
    let alive = true;
    try { process.kill(pid, 0); } catch (probe) { if (probe.code === 'ESRCH') alive = false; }
    need(!alive, 'Another tool/check batch owns this chat receipt; wait for it to finish, then retry.');
    fs.unlinkSync(lock);
    descriptor = fs.openSync(lock, 'wx');
  }
  try { fs.writeFileSync(descriptor, String(process.pid)); return action(runtime(session)); }
  finally { fs.closeSync(descriptor); fs.unlinkSync(lock); }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'hook') {
    let raw = '';
    for await (const chunk of process.stdin) { raw += chunk; need(raw.length <= 2 * 1024 * 1024, 'Oversized hook event.'); }
    const event = JSON.parse(raw);
    const cwd = path.resolve(event.cwd ?? '');
    if (cwd.toLowerCase() !== ROOT.toLowerCase() && !cwd.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) return;
    try { process.stdout.write(JSON.stringify(lockedRuntime(event.session_id, workflow => workflow.hook(event)))); }
    catch (error) { process.stdout.write(JSON.stringify(event.hook_event_name === 'PreToolUse' ? { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Workflow guard error: ${error.message}` } } : { decision: 'block', reason: `Workflow guard error: ${error.message}` })); }
    return;
  }
  return lockedRuntime(process.env.CODEX_THREAD_ID, workflow => {
  need(workflow.state.phase !== 'dispatched', 'Stop: this chat has already dispatched its continuation.');
  let output;
  if (command === 'read') output = workflow.read(args[0], Number(args[1] ?? 0));
  else if (command === 'status') output = { ...workflow.state, pendingRead: workflow.state.pendingRead ? { file: workflow.state.pendingRead.file, range: workflow.state.pendingRead.range } : undefined, pendingReview: workflow.state.pendingReview ? { mode: workflow.state.pendingReview.mode, range: workflow.state.pendingReview.range } : undefined, docsFresh: workflow.fresh(), directory: workflow.directory };
  else if (command === 'begin') workflow.begin(args[0], args.slice(1));
  else if (command === 'revise') {
    need(workflow.state.phase === 'editing' || workflow.state.phase === 'validated', 'Only the current slice can be revised.');
    need(args[0]?.trim(), 'Supply the necessary correction/scope-change reason.');
    workflow.state.phase = 'editing'; workflow.state.validation = null; workflow.state.reviews = {};
    workflow.state.blocker = null;
    workflow.state.revisionReason = args[0];
    workflow.state.files = [...new Set([...workflow.state.files, ...args.slice(1).map(file => workflow.relative(file))])];
    workflow.save();
  } else if (command === 'validate') workflow.validate();
  else if (command === 'permit') {
    need(workflow.state.phase === 'editing' && workflow.fresh(), 'Permit requires current documents and an editing slice.');
    need(args[0]?.trim() && args[1]?.trim(), 'Supply exact command and necessary scope reason.');
    workflow.state.commandPermit = { hash: digest(args[0]), reason: args[1], at: new Date().toISOString() };
    workflow.save();
  }
  else if (command === 'review') output = workflow.review(args[0], Number(args[1] ?? 0));
  else if (command === 'commit') output = workflow.commit(args[0]);
  else if (command === 'handoff') output = workflow.handoff(...args);
  else if (command === 'blocker') {
    need(args[0]?.trim() && args[1]?.trim(), 'Supply the concrete blocker and next action.');
    need(workflow.hash(STATE) !== workflow.state.startStateHash, 'Record blocker/next action in implementation state first.');
    workflow.state.blocker = `${args[0]} Next: ${args[1]}`;
    if (workflow.state.phase === 'handoff') workflow.state.phase = 'handoff-failed';
    workflow.save();
  } else throw new Error('Commands: read FILE [OFFSET]; status; begin TITLE FILE...; revise REASON [FILE...]; validate; review normal|whitespace [OFFSET]; commit MESSAGE; handoff TITLE PROJECT_ID; permit EXACT_COMMAND REASON; blocker REASON NEXT_ACTION.');
  if (output !== undefined) process.stdout.write(typeof output === 'string' ? output + '\n' : JSON.stringify(output, null, 2) + '\n');
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`Workflow guard: ${error.message}\n`); process.exitCode = 1; });
}
