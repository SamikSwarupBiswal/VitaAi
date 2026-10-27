"use client";

import { useEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { savedRunId } from "@/lib/pipeline-history";
import { useSession } from "./session-gate";

type S = components["schemas"];
const post = (body: unknown, signal: AbortSignal) => ({ method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export function AccountTools({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (!actor || session?.mode !== "session" || actor.organization_id !== view.account.organization_id) return null;
  return <Tools view={view} actor={actor.id} role={actor.role} key={JSON.stringify([actor.id, actor.role, actor.organization_id, view.account.id, view.assessment.snapshot_hash])} />;
}
function Tools({ view, actor, role }: { view: AccountView; actor: string; role: string }) {
  const [tick, setTick] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState(""), [writeBlocked, setWriteBlocked] = useState<"memory" | "handoff" | null>(null);
  const [kind, setKind] = useState<"mission" | "source_detection">("mission"), [sourceId, setSourceId] = useState("");
  const [preview, setPreview] = useState<S["SourceMemoryPreview"] | null>(null), [memories, setMemories] = useState<S["SourceMemoryEntry"][]>([]);
  const [selected, setSelected] = useState<S["SourceMemoryEntry"] | null>(null), [events, setEvents] = useState<S["SourceMemoryEvent"][]>([]);
  const [reason, setReason] = useState(""), [replacement, setReplacement] = useState(""), [query, setQuery] = useState("");
  const [recall, setRecall] = useState<S["SourceRecallResult"] | null>(null);
  const [missions, setMissions] = useState<S["Mission"][]>([]), [recipients, setRecipients] = useState<S["Recipient"][]>([]);
  const [handoffs, setHandoffs] = useState<S["Handoff"][]>([]), [detail, setDetail] = useState<S["HandoffHistory"] | null>(null);
  const [missionId, setMissionId] = useState(""), [recipient, setRecipient] = useState(""), [note, setNote] = useState("");
  const life = useRef({ alive: false, epoch: 0, pending: false, uncertain: null as "memory" | "handoff" | null, attempted: null as "memory" | "handoff" | null, controller: null as AbortController | null });
  const epoch = life.current.epoch, account = view.account.id, organization = view.account.organization_id;
  const valid = () => life.current.alive && epoch === life.current.epoch;
  const reset = () => { setPreview(null); setMemories([]); setSelected(null); setEvents([]); setRecall(null); setMissions([]); setRecipients([]); setHandoffs([]); setDetail(null); };
  useEffect(() => { const state = life.current; state.alive = true;
    const invalidate = () => { if (state.attempted) { state.uncertain = state.attempted; setWriteBlocked(state.attempted); } state.epoch++; state.controller?.abort(); state.pending = false; reset(); setBusy(false); setTick(x => x + 1); };
    const names = ["focus", "vitaai-source-changed", "vitaai-workflow-changed", "vitaai-session-expired"];
    names.forEach(name => window.addEventListener(name, invalidate));
    return () => { state.alive = false; state.epoch++; state.controller?.abort(); names.forEach(name => window.removeEventListener(name, invalidate)); };
  }, []);
  async function run(work: (signal: AbortSignal) => Promise<() => void>) { const state = life.current; if (!valid() || state.pending) return;
    state.pending = true; state.attempted = null; setBusy(true); setError(""); const controller = new AbortController(); state.controller = controller;
    try { const publish = await work(controller.signal); if (valid() && !controller.signal.aborted) {
      state.pending = false; state.attempted = null; setBusy(false); state.epoch++; setTick(x => x + 1); publish();
    } }
    catch { if (valid() && !controller.signal.aborted) { if (state.attempted) { state.uncertain = state.attempted; setWriteBlocked(state.attempted); } state.pending = false; state.attempted = null; setBusy(false); state.epoch++; setTick(x => x + 1); reset(); setError("Unavailable or changed. Inspect saved records before another write; a response may already be saved."); } }
    finally { if (valid() && state.controller === controller) { state.pending = false; setBusy(false); } }
  }
  function write<T>(path: string, body: unknown, signal: AbortSignal, domain: "memory" | "handoff") {
    const state = life.current;
    if (!valid() || !state.pending || state.uncertain || signal.aborted) throw new Error("Inspect saved records and rebind before another write");
    state.attempted = domain;
    return api<T>(path, post(body, signal));
  }
  function change(work: () => void) { if (life.current.pending || !valid()) return; life.current.epoch++; work(); setTick(x => x + 1); }
  function scope<T extends { organization_id: string; account_id: string }>(item: T): T { if (item.organization_id !== organization || item.account_id !== account) throw new Error("Scope changed"); return item; }
  function record<T extends { id: string; revision: number; organization_id: string; account_id: string }>(item: T): T {
    scope(item); if (!savedRunId.test(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("Record changed"); return item;
  }
  function nestedScope(value: unknown): boolean {
    if (Array.isArray(value)) return value.every(nestedScope);
    if (value && typeof value === "object") return Object.entries(value).every(([key, item]) =>
      (key !== "organization_id" || item === organization) && (key !== "account_id" || item === account) && nestedScope(item));
    return true;
  }
  function memory(item: S["SourceMemoryEntry"]): S["SourceMemoryEntry"] {
    record(item); scope(item.source);
    if (!savedRunId.test(item.source.source_id) || !/^[a-f0-9]{64}$/.test(item.source.content_hash)
      || !nestedScope(item.source.original) || !["mission", "source_detection"].includes(item.source.kind) || !["active", "archived", "invalidated", "superseded"].includes(item.state)) throw new Error("Source changed");
    return item;
  }
  function handoff(item: S["Handoff"]): S["Handoff"] {
    record(item);
    if (!savedRunId.test(item.mission_id) || ![item.sender_id, item.recipient_id].includes(actor)
      || !Number.isSafeInteger(item.mission_revision) || item.mission_revision < 1
      || !["pending", "accepted", "returned", "completed"].includes(item.status)) throw new Error("Handoff changed");
    return item;
  }
  const history = () => run(async signal => { const result = scope(await api<S["SourceMemoryHistory"]>(`memory/sources/accounts/${account}`, { signal })); result.items.forEach(memory);
    if (result.limit !== 20 || new Set(result.items.map(item => item.id)).size !== result.items.length || result.items.length > 20
      || !Number.isSafeInteger(result.total_count) || result.total_count < result.items.length || result.has_more !== (result.total_count > result.items.length)) throw new Error("History coverage changed");
    return () => { setMemories(result.items); setPreview(null); setSelected(null); setEvents([]);
      if (life.current.uncertain === "memory") { life.current.uncertain = null; setWriteBlocked(null); setSourceId(""); setReason(""); setReplacement(""); }
    }; });
  const inspect = () => run(async signal => { if (!savedRunId.test(sourceId)) throw new Error("Exact ID required"); const value = scope(await api<S["SourceMemoryPreview"]>(`memory/sources/accounts/${account}/preview/${kind}/${sourceId}`, { signal })); if (value.kind !== kind || value.source_id !== sourceId || !nestedScope(value.original) || !/^[a-f0-9]{64}$/.test(value.content_hash)) throw new Error("Source changed"); return () => setPreview(value); });
  const capture = () => run(async signal => { if (!preview || role === "viewer") throw new Error("Inspect first"); const value = memory(await write<S["SourceMemoryEntry"]>(`memory/sources/accounts/${account}`, { kind: preview.kind, source_id: preview.source_id, expected_content_hash: preview.content_hash }, signal, "memory")); if (value.source.content_hash !== preview.content_hash || value.source.kind !== preview.kind || value.source.source_id !== preview.source_id) throw new Error("Source changed"); return () => { setSelected(value); setPreview(null); setEvents([]); }; });
  const lifecycle = (state: S["SourceMemoryEntry"]["state"]) => run(async signal => { if (!selected || !["admin", "reviewer"].includes(role) || !reason.trim()) throw new Error("Review first"); const value = memory(await write<S["SourceMemoryEntry"]>(`memory/sources/${selected.id}/lifecycle`, { expected_revision: selected.revision, state, reason, replacement_id: state === "superseded" ? replacement : null }, signal, "memory")); if (value.id !== selected.id || value.revision !== selected.revision + 1 || value.state !== state || value.source.content_hash !== selected.source.content_hash || state === "superseded" && value.replaced_by_id !== replacement) throw new Error("Record changed"); return () => { setSelected(value); setMemories([]); setEvents([]); setReason(""); }; });
  const load = () => run(async signal => { const [saved, directory, list] = await Promise.all([api<S["Mission"][]>("missions", { signal }), api<S["RecipientList"]>("collaboration/recipients", { signal }), api<S["HandoffList"]>(`collaboration/accounts/${account}/handoffs`, { signal })]);
    if (saved.some(item => item.organization_id !== organization || !savedRunId.test(item.id)) || new Set(saved.map(item => item.id)).size !== saved.length
      || directory.limit !== 100 || directory.items.length > 100 || new Set(directory.items.map(item => item.id)).size !== directory.items.length
      || directory.items.some(item => !savedRunId.test(item.id) || item.id === actor || !["admin", "reviewer", "seller"].includes(item.role))
      || list.limit !== 50 || list.items.length > 50 || new Set(list.items.map(item => item.id)).size !== list.items.length) throw new Error("Directory scope changed");
    list.items.forEach(handoff); return () => { setMissions(saved.filter(item => item.account_id === account)); setRecipients(directory.items); setHandoffs(list.items); setDetail(null); setMissionId(""); setRecipient(""); setNote("");
      if (life.current.uncertain === "handoff") { life.current.uncertain = null; setWriteBlocked(null); }
    }; });
  const create = () => run(async signal => { const mission = missions.find(item => item.id === missionId); if (!mission || !recipients.some(item => item.id === recipient) || role === "viewer" || !note.trim()) throw new Error("Inspect bindings first"); const value = handoff(await write<S["Handoff"]>(`collaboration/accounts/${account}/handoffs`, { request_id: crypto.randomUUID(), mission_id: mission.id, expected_mission_revision: mission.revision, recipient_id: recipient, reason: note, evidence_ids: mission.evidence.evidence_ids }, signal, "handoff"));
    if (value.mission_id !== mission.id || value.mission_revision !== mission.revision || value.sender_id !== actor || value.recipient_id !== recipient
      || value.reason !== note || value.status !== "pending" || value.revision !== 1 || JSON.stringify(value.evidence_ids) !== JSON.stringify(mission.evidence.evidence_ids)) throw new Error("Handoff request changed");
    return () => { setHandoffs([value]); setNote(""); setMissions([]); setRecipients([]); }; });
  const transition = (status: S["HandoffTransition"]["status"]) => run(async signal => { if (!detail || role === "viewer" || !note.trim()) throw new Error("Inspect first"); const value = handoff(await write<S["Handoff"]>(`collaboration/handoffs/${detail.handoff.id}/transition`, { request_id: crypto.randomUUID(), expected_revision: detail.handoff.revision, expected_mission_revision: detail.current_mission_revision, status, note }, signal, "handoff"));
    if (value.id !== detail.handoff.id || value.revision !== detail.handoff.revision + 1 || value.status !== status || value.mission_id !== detail.handoff.mission_id
      || value.mission_revision !== detail.current_mission_revision || value.sender_id !== detail.handoff.sender_id || value.recipient_id !== detail.handoff.recipient_id) throw new Error("Handoff response changed");
    return () => { setHandoffs([value]); setDetail(null); setNote(""); }; });
  return <section aria-label="Account memory and collaboration" style={{ overflowWrap: "anywhere" }} data-generation={tick}>
    <h3>Source and mission memory</h3><p>Original dated history stays separate from current facts and approval. Memory history shows 20 records; recall inspects at most 100 and returns top 5.</p>
    <fieldset disabled={busy}><legend>Inspect exact saved source</legend>
      <label>Source kind <select value={kind} onChange={e => change(() => { setKind(e.target.value as typeof kind); setPreview(null); })}><option value="mission">Mission</option><option value="source_detection">Source detection</option></select></label>
      <label>Saved source ID <input value={sourceId} onChange={e => change(() => { setSourceId(e.target.value); setPreview(null); })} /></label>
      <button onClick={inspect}>Inspect original source</button><button onClick={history}>Inspect source memory</button>
      {preview && <><p>{preview.summary} Original {preview.source_time}; author {preview.source_actor_id}.</p><details><summary>Original source records</summary><pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(preview.original, null, 2)}</pre></details>{role !== "viewer" && <button disabled={!!writeBlocked} onClick={capture}>Capture inspected source memory</button>}</>}
      {memories.map(item => <button key={item.id} onClick={() => change(() => { setSelected(item); setEvents([]); setReason(""); setReplacement(""); })}>{item.source.kind} · {item.state} · {item.source.source_time}</button>)}
      {selected && <article><h4>{selected.source.summary}</h4><p>{selected.id} / revision {selected.revision} / {selected.state}. Original {selected.source.source_time}; captured {selected.created_at} by {selected.captured_by}.</p>
        <button onClick={() => run(async signal => { const result = await api<S["SourceMemoryEvent"][]>(`memory/sources/${selected.id}/events`, { signal }); if (result.length !== selected.revision || new Set(result.map(item => item.id)).size !== result.length || result.some((item, index) => item.memory_id !== selected.id || item.organization_id !== organization || item.revision !== index + 1) || result.at(-1)?.state !== selected.state) throw new Error("Events changed"); return () => setEvents(result); })}>Inspect source memory events</button>
        <ol>{events.map(item => <li key={item.id}>{item.revision}: {item.state} · {item.actor_id} · {item.created_at} · {item.reason}</li>)}</ol>
        {["admin", "reviewer"].includes(role) && !["invalidated", "superseded"].includes(selected.state) && <><label>Lifecycle reason <textarea maxLength={2000} value={reason} onChange={e => change(() => setReason(e.target.value))} /></label><button disabled={!!writeBlocked || !reason.trim()} onClick={() => lifecycle(selected.state === "archived" ? "active" : "archived")}>{selected.state === "archived" ? "Restore" : "Archive"} source memory</button><button disabled={!!writeBlocked || !reason.trim()} onClick={() => lifecycle("invalidated")}>Invalidate source memory</button><label>Replacement memory ID <input value={replacement} onChange={e => change(() => setReplacement(e.target.value))} /></label><button disabled={!!writeBlocked || !reason.trim() || !savedRunId.test(replacement)} onClick={() => lifecycle("superseded")}>Supersede source memory</button></>}
      </article>}
      <label>Recall query <input value={query} maxLength={500} onChange={e => change(() => { setQuery(e.target.value); setRecall(null); })} /></label>
      <button onClick={() => run(async signal => { const result = scope(await api<S["SourceRecallResult"]>(`memory/sources/accounts/${account}/recall`, post({ expected_snapshot_hash: view.assessment.snapshot_hash, query }, signal)));
        if (result.snapshot_hash !== view.assessment.snapshot_hash || result.items.length > 5 || result.inspected_count > 100 || result.inspected_count > result.total_count
          || new Set(result.items.map(item => item.memory.id)).size !== result.items.length) throw new Error("Recall changed");
        result.items.forEach(item => { memory(item.memory); if (item.memory.state !== "active" || !Number.isFinite(item.score)) throw new Error("Recall lifecycle changed"); });
        return () => setRecall(result); })}>Recall source and mission history</button>
      {recall && <><p>Inspected {recall.inspected_count}/{recall.total_count}; exclusions {JSON.stringify(recall.excluded)}.</p><ul>{recall.items.map(item => <li key={item.memory.id}>{item.memory.source.summary} Score {item.score}; {item.reasons.join(" ")}</li>)}</ul>{recall.caveats.map(text => <p key={text}>{text}</p>)}</>}
    </fieldset>
    <h3>Collaboration handoff</h3><p>Internal handoff completion does not complete a mission or notify anyone externally. Bounded to 50 participant handoffs and 100 current members.</p>
    <fieldset disabled={busy}><legend>Explicit human handoff</legend><button onClick={load}>Inspect handoffs and recipients</button>
      {role !== "viewer" && <><label>Saved mission <select value={missionId} onChange={e => change(() => setMissionId(e.target.value))}><option value="">Choose inspected mission</option>{missions.map(item => <option key={item.id} value={item.id}>{item.id} · {item.status} · revision {item.revision}</option>)}</select></label><label>Recipient <select value={recipient} onChange={e => change(() => setRecipient(e.target.value))}><option value="">Choose current member</option>{recipients.map(item => <option key={item.id} value={item.id}>{item.username} · {item.role}</option>)}</select></label><label>Handoff reason or transition note <textarea maxLength={2000} value={note} onChange={e => change(() => setNote(e.target.value))} /></label><button disabled={!!writeBlocked || !note.trim() || !missionId || !recipient} onClick={create}>Create exact mission handoff</button></>}
      {handoffs.map(item => <button key={item.id} onClick={() => run(async signal => { const value = await api<S["HandoffHistory"]>(`collaboration/handoffs/${item.id}`, { signal }); handoff(value.handoff);
        if (value.handoff.id !== item.id || value.events.length !== value.handoff.revision || new Set(value.events.map(event => event.id)).size !== value.events.length
          || value.events.some((event, index) => event.handoff_id !== value.handoff.id || event.organization_id !== organization || event.revision !== index + 1)
          || value.events.at(-1)?.status !== value.handoff.status || value.current_mission_revision < 1
          || value.refresh_required !== (value.current_mission_revision !== value.handoff.mission_revision)) throw new Error("Handoff changed");
        return () => { setDetail(value); setNote(""); }; })}>{item.status} · {item.reason} · {item.id}</button>)}
      {detail && <article><h4>{detail.handoff.status} handoff</h4><p>{detail.handoff.reason} Sender {detail.handoff.sender_id}; recipient {detail.handoff.recipient_id}; mission {detail.handoff.mission_id}, revision {detail.handoff.mission_revision}.</p>{detail.refresh_required && <p role="status">Mission changed. Return for sender refresh before accepting/completing.</p>}<ol>{detail.events.map(item => <li key={item.id}>{item.status} · {item.actor_id} · {item.created_at} · {item.note}</li>)}</ol><a href={`/missions?${new URLSearchParams({ account, mission: detail.handoff.mission_id, step: "Review" })}`} onClick={event => { if (!valid() || life.current.pending) event.preventDefault(); }}>Open exact mission for review</a>
        {actor === detail.handoff.recipient_id && ["pending", "accepted"].includes(detail.handoff.status) && <><button disabled={!!writeBlocked || !note.trim() || detail.refresh_required} onClick={() => transition(detail.handoff.status === "pending" ? "accepted" : "completed")}>{detail.handoff.status === "pending" ? "Accept" : "Complete"} internal handoff</button><button disabled={!!writeBlocked || !note.trim()} onClick={() => transition("returned")}>Return internal handoff</button></>}{actor === detail.handoff.sender_id && detail.handoff.status === "returned" && <button disabled={!!writeBlocked || !note.trim()} onClick={() => transition("pending")}>Refresh and resend internal handoff</button>}
      </article>}
    </fieldset><p><a href={`/intelligence?${new URLSearchParams({ account })}`}>Open Decision and Trend Intelligence</a></p>{busy && <p role="status">Reading or recording selected account tools…</p>}{error && <p role="alert">{error}</p>}
    {writeBlocked && <p role="alert">A {writeBlocked} write may already be saved. Writes are paused until you inspect {writeBlocked === "memory" ? "source memory" : "handoffs and recipients"} and rebind the exact inputs.</p>}
  </section>;
}
