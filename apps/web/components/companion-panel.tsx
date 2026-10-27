"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import { accountCitationHref, accountCitationMatches, conversationScope, conversationHistory, navigationHref, type Conversation, type ConversationHistory, type Persona, type Turn } from "@/lib/companion";
import { useSession } from "./session-gate";
import { VoiceControls } from "./voice-controls";
import { AvatarControls } from "./avatar-controls";

export function CompanionPanel({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (!actor || session?.mode !== "session" || actor.organization_id !== view.account.organization_id) return <p>Sign in to use sourced conversation.</p>;
  return <ConversationPanel view={view} actor={actor.id} role={actor.role} key={JSON.stringify([actor.id, actor.role,
    actor.organization_id, view.account.id, view.account.revision, view.source?.id, view.assessment.snapshot_hash])} />;
}

function ConversationPanel({ view, actor, role }: { view: AccountView; actor: string; role: string }) {
  const [persona, setPersona] = useState<Persona>("companion"), [message, setMessage] = useState("");
  const [list, setList] = useState<Conversation[]>([]), [history, setHistory] = useState<ConversationHistory | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), pending = useRef(false);
  const current = useRef<ConversationHistory | null>(null), records = useRef<Conversation[]>([]), input = useRef("");
  const scope = [actor, view.account.organization_id, view.account.id] as const, base = `companion/accounts/${view.account.id}/sessions`;
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller; return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; current.current = null; records.current = [];
      setHistory(null); setList([]); setBusy(false); setError(null); };
    const events = ["focus", "vitaai-source-changed", "vitaai-workflow-changed", "vitaai-pipeline-history-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => events.forEach(name => window.removeEventListener(name, invalidate));
  }, []);
  const post = (body: unknown, signal: AbortSignal): RequestInit => ({ method: "POST", signal,
    headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  async function operate(work: (signal: AbortSignal, active: () => boolean) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && request === sequence.current;
    setBusy(true); setError(null);
    try { await work(signal, active); }
    catch { if (active()) { current.current = null; setHistory(null); setError("Conversation unavailable or changed. Inspect saved conversations before retrying; a response may already be saved."); } }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  async function inspectList() { await operate(async (signal, active) => {
    const values = await api<Conversation[]>(base, { signal });
    if (values.length > 20 || new Set(values.map(item => item.id)).size !== values.length) throw new Error("List changed");
    values.forEach(item => conversationScope(item, ...scope));
    if (active()) { records.current = values; setList(values); current.current = null; setHistory(null); }
  }); }
  async function open(item: Conversation) {
    if (!records.current.includes(item)) return;
    await operate(async (signal, active) => {
      const value = conversationHistory(await api<ConversationHistory>(`companion/sessions/${item.id}`, { signal }), ...scope, item.id);
      if (active()) { current.current = value; setHistory(value); }
    });
  }
  async function start() {
    if (role === "viewer") return;
    await operate(async (signal, active) => {
      const item = conversationScope(await api<Conversation>(base, post({ persona, expected_snapshot_hash: view.assessment.snapshot_hash }, signal)), ...scope);
      if (item.snapshot_hash !== view.assessment.snapshot_hash || item.persona !== persona || item.revision !== 1) throw new Error("Context changed");
      if (active()) { const value: ConversationHistory = { schema_version: "1", conversation: item, turns: [], limit: 30 };
        current.current = value; setHistory(value); }
    });
  }
  async function ask() {
    if (role === "viewer" || !history || history !== current.current || input.current !== message || !message.trim()
      || history.conversation.snapshot_hash !== view.assessment.snapshot_hash) return;
    const id = history.conversation.id;
    await operate(async (signal, active) => {
      const turn = await api<Turn>(`companion/sessions/${id}/turns`, post({ expected_revision: history.conversation.revision,
        expected_snapshot_hash: view.assessment.snapshot_hash, request_id: crypto.randomUUID(), message }, signal));
      const value = conversationHistory({ ...history, conversation: { ...history.conversation, revision: history.conversation.revision + 1 }, turns: [...history.turns, turn] }, ...scope, id);
      if (active()) { current.current = value; setHistory(value); input.current = ""; setMessage(""); }
    });
  }
  return <section aria-label="Sourced companion" style={{ overflowWrap: "anywhere" }}>
    <h3>Workspace companion</h3><p>Deterministic sourced answers. Persona changes presentation only. Chat cannot approve, send or execute.</p>
    <AvatarControls key={JSON.stringify([view.assessment.snapshot_hash, history?.conversation.id, history?.turns.at(-1)?.id, busy])} />
    <a href={`/companion?${new URLSearchParams({ account: view.account.id })}`}>Open companion workspace</a>
    <label>Advisor <select disabled={busy} value={persona} onChange={event => { if (!pending.current) setPersona(event.target.value as Persona); }}>
      <option value="companion">Account companion</option><option value="executive_advisor">Executive Advisor</option>
      <option value="mission_guide">Mission Guide</option><option value="sales_director">Sales Director</option><option value="operations_advisor">Operations Advisor</option>
    </select></label>
    <button disabled={busy || role === "viewer"} onClick={start}>Start sourced conversation</button>
    <button disabled={busy} onClick={inspectList}>Inspect my saved conversations</button>
    <p>At most20 conversations in stable ID order; changing advisor starts a separate conversation.</p>
    {list.map(item => <button key={item.id} disabled={busy} onClick={() => open(item)}>Resume {item.persona} · {item.created_at} · {item.id}</button>)}
    {busy && <p role="status">Reading or recording conversation…</p>}{error && <p role="alert">{error}</p>}
    {history && <div aria-live="polite"><p>Conversation {history.conversation.id} / {history.conversation.persona} / revision {history.conversation.revision}.</p>
      <p>Saved answers and citations retain original dates; later source corrections or memory invalidations may make them historical.</p>
      {history.conversation.snapshot_hash !== view.assessment.snapshot_hash && <p role="status">Historical snapshot. Start a new conversation for current evidence.</p>}
      <ol>{history.turns.map(turn => { const href = turn.navigation && navigationHref(turn.navigation, view.account.id);
        return <li key={turn.id}><p>You: {turn.message}</p><p>{turn.status} / {turn.mode} / {turn.created_at}</p><p>{turn.answer}</p>
          {turn.caveats.map(caveat => <p className="caveat" key={caveat}>{caveat}</p>)}
          <details><summary>Cited records</summary>{turn.citations.map((citation, index) => <p key={`${citation.kind}:${citation.id}:${index}`}>
            {citation.kind} {citation.id} / {citation.label} / original {citation.source_time ?? "Not recorded"}: {citation.text}
            {accountCitationHref(citation) && history.conversation.snapshot_hash === view.assessment.snapshot_hash
              && <a href={accountCitationHref(citation)!} onClick={async event => {
                event.preventDefault();
                if (pending.current || lifetime.current?.signal.aborted || current.current !== history) return;
                await operate(async (signal, active) => {
                  const target = await api<AccountView>(`accounts/${citation.id}`, { signal });
                  if (!accountCitationMatches(citation, target, view.account.organization_id)) throw new Error("Cited account snapshot changed");
                  if (active() && current.current === history) window.location.assign(accountCitationHref(citation)!);
                });
              }}>Open cited account (verify same snapshot)</a>}</p>)}</details>
          {href && history.conversation.snapshot_hash === view.assessment.snapshot_hash && <a href={href} onClick={event => {
            if (pending.current || lifetime.current?.signal.aborted || current.current !== history) event.preventDefault();
          }}>Open cited workspace</a>}</li>; })}</ol>
      <label>Question <textarea disabled={busy} value={message} maxLength={2000} onChange={event => {
        if (!pending.current) { input.current = event.target.value; setMessage(event.target.value); }
      }} /></label>
      <p>Choose a question to review, then press Ask:</p>
      {({ companion: ["Explain current risk and evidence", "Recall memory"],
        executive_advisor: ["Show portfolio priorities, source changes and alternatives", "Recall memory"],
        mission_guide: ["Resume mission and explain all seven steps and blockers", "Explain mission Approval", "Explain mission Outcome"],
        sales_director: ["Summarize team missions, outcomes and coaching reviews", "Recall memory"],
        operations_advisor: ["Show integration readiness, refresh, review queues and receipt remedies", "Recall memory"],
      } satisfies Record<Persona, string[]>)[history.conversation.persona].map(question => <button key={question}
        disabled={busy || role === "viewer" || history.conversation.snapshot_hash !== view.assessment.snapshot_hash}
        onClick={() => { if (!pending.current && current.current === history && !lifetime.current?.signal.aborted) {
          input.current = question; setMessage(question);
        } }}>{question}</button>)}
      <VoiceControls key={JSON.stringify([history.conversation.id, history.turns.at(-1)?.id, busy])}
        disabled={busy || role === "viewer" || history.conversation.snapshot_hash !== view.assessment.snapshot_hash}
        text={history.turns.length ? [history.turns.at(-1)!.status, history.turns.at(-1)!.answer, ...history.turns.at(-1)!.caveats].join(" ") : ""}
        onTranscript={text => { if (!pending.current && current.current === history && !lifetime.current?.signal.aborted) {
          input.current = text; setMessage(text);
        } }} />
      <button disabled={busy || role === "viewer" || !message.trim() || history.turns.length >= 30
        || history.conversation.snapshot_hash !== view.assessment.snapshot_hash} onClick={ask}>Ask from this context</button>
    </div>}
  </section>;
}
