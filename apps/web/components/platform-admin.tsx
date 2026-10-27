"use client";

import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { savedRunId } from "@/lib/pipeline-history";
import { useSession } from "./session-gate";

type Schemas = components["schemas"];
type Link = Schemas["IdentityLink"];
type Ready = Schemas["PlatformReadiness"];
type Recipient = Schemas["Recipient"];

export function PlatformAdmin() {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.role !== "admin") return null;
  return <Admin organization={actor.organization_id} self={{ schema_version: "1", id: actor.id, username: actor.username, role: "admin" }}
    key={JSON.stringify([actor.id, actor.organization_id, actor.role])} />;
}

function Admin({ organization, self }: { organization: string; self: Recipient }) {
  const [ready, setReady] = useState<Ready | null>(null), [links, setLinks] = useState<Link[]>([]);
  const [directory, setDirectory] = useState<Recipient[]>([]), [selected, setSelected] = useState<Link | null>(null);
  const [tenant, setTenant] = useState(""), [object, setObject] = useState(""), [member, setMember] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [needsReadback, setNeedsReadback] = useState(false);
  const [, renderEpoch] = useState(0);
  const life = useRef({ alive: false, epoch: 0, pending: false, uncertain: false, controller: null as AbortController | null });
  const epoch = life.current.epoch, current = () => life.current.alive && epoch === life.current.epoch;
  function clear() { setReady(null); setLinks([]); setDirectory([]); setSelected(null); }
  useEffect(() => {
    const state = life.current; state.alive = true;
    const invalidate = () => { state.epoch++; state.controller?.abort(); state.pending = false; clear(); setBusy(false); renderEpoch(value => value + 1); };
    const names = ["focus", "vitaai-session-expired", "vitaai-source-changed", "vitaai-workflow-changed"];
    names.forEach(name => window.addEventListener(name, invalidate));
    return () => { state.alive = false; state.epoch++; state.controller?.abort(); names.forEach(name => window.removeEventListener(name, invalidate)); };
  }, []);
  function validLink(value: Link) {
    if (value.organization_id !== organization || !savedRunId.test(value.user_id) || !savedRunId.test(value.tenant_id)
      || !savedRunId.test(value.object_id) || !Number.isSafeInteger(value.revision) || value.revision < 1
      || typeof value.enabled !== "boolean") throw new Error("Identity scope changed");
    return value;
  }
  async function inspect() {
    const state = life.current; if (!current() || state.pending) return;
    state.pending = true; const controller = new AbortController(); state.controller = controller; setBusy(true); setError(""); clear();
    try {
      const [readiness, mappings, members] = await Promise.all([
        api<Ready>("platform/readiness", { signal: controller.signal }), api<Link[]>("platform/identities", { signal: controller.signal }),
        api<Schemas["RecipientList"]>("collaboration/recipients", { signal: controller.signal }),
      ]);
      if (readiness.live_verified !== false || typeof readiness.configured !== "boolean" || mappings.length > 100
        || new Set(mappings.map(value => `${value.tenant_id}/${value.object_id}`)).size !== mappings.length
        || members.items.some(value => !savedRunId.test(value.id) || !["seller", "reviewer", "admin"].includes(value.role))) throw new Error("Readback changed");
      mappings.forEach(validLink);
      if (!current() || controller.signal.aborted) return;
      setReady(readiness); setLinks(mappings); setDirectory([self, ...members.items.filter(value => value.id !== self.id)]);
      setTenant(readiness.tenant_id ?? ""); setObject(""); setMember(""); state.uncertain = false; setNeedsReadback(false);
    } catch { if (current() && !controller.signal.aborted) setError("Readback unavailable. Refresh identity mappings before making a change."); }
    finally {
      if (current() && state.controller === controller) {
        state.pending = false; state.epoch++; setBusy(false); renderEpoch(value => value + 1);
      }
    }
  }
  function change(update: () => void) { if (!current() || life.current.pending) return; life.current.epoch++; update(); renderEpoch(value => value + 1); }
  async function save(enabled: boolean) {
    const state = life.current;
    if (!current() || state.pending || state.uncertain || !ready || !savedRunId.test(tenant) || !savedRunId.test(object)
      || !savedRunId.test(member) || (selected && (selected.tenant_id !== tenant || selected.object_id !== object || selected.user_id !== member))) return;
    if (enabled && (!ready.configured || ready.tenant_id !== tenant || !directory.some(value => value.id === member))) return;
    if (!enabled && !selected) return;
    state.pending = true; state.uncertain = true; setNeedsReadback(true); setBusy(true); setError("");
    const controller = new AbortController(); state.controller = controller;
    try {
      const result = validLink(await api<Link>("platform/identities", { method: "POST", signal: controller.signal,
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tenant_id: tenant, object_id: object, user_id: member,
          expected_revision: selected?.revision ?? 0, enabled }),
      }));
      if (result.tenant_id !== tenant || result.object_id !== object || result.user_id !== member || result.enabled !== enabled
        || result.revision !== (selected?.revision ?? 0) + 1) throw new Error("Mapping changed");
      if (current() && !controller.signal.aborted) { clear(); setError("Change recorded. Inspect readiness and mappings before another change."); }
    } catch { if (current() && !controller.signal.aborted) { clear(); setError("Response unavailable or changed. The change may already be recorded; inspect mappings without replaying it."); } }
    finally { if (current() && state.controller === controller) { state.pending = false; setBusy(false); } }
  }
  return <section aria-label="Microsoft identity administration" style={{ overflowWrap: "anywhere" }}><h2>Microsoft identity access</h2>
    <p>Map exact Entra tenant/object IDs to existing VitaAi members. Configuration and mapping do not establish live Teams or Copilot validation.</p>
    <button disabled={busy} onClick={inspect}>Inspect Microsoft readiness and mappings</button>
    {busy && <p role="status">Reading or recording Microsoft identity access…</p>}{error && <p role="status">{error}</p>}
    {needsReadback && <p role="alert">An identity change needs explicit readback before another write.</p>}
    {ready && <><p>{ready.configured ? "Configured; real tenant unverified." : "Not configured; existing mappings can still be revoked."} Scope: {ready.delegated_scope}</p>
      <ul>{ready.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      <fieldset disabled={busy || needsReadback}><legend>Exact identity binding</legend>
        <label>Tenant ID <input value={tenant} readOnly={Boolean(selected)} onChange={event => change(() => setTenant(event.target.value))} /></label>
        <label>Entra object ID <input value={object} readOnly={Boolean(selected)} onChange={event => change(() => setObject(event.target.value))} /></label>
        {selected ? <p>VitaAi member {selected.user_id}; mapping revision {selected.revision}; {selected.enabled ? "enabled" : "disabled"}.</p>
          : <label>VitaAi member <select value={member} onChange={event => change(() => setMember(event.target.value))}><option value="">Select current member</option>
            {directory.map(value => <option key={value.id} value={value.id}>{value.username} · {value.role} · {value.id}</option>)}</select></label>}
        <button disabled={!ready.configured || !savedRunId.test(tenant) || !savedRunId.test(object) || !savedRunId.test(member)
          || !directory.some(value => value.id === member)} onClick={() => save(true)}>{selected ? "Enable exact mapping" : "Link exact Microsoft identity"}</button>
        {selected && <button onClick={() => save(false)}>Revoke exact mapping</button>}
        <button onClick={() => change(() => { setSelected(null); setTenant(ready.tenant_id ?? ""); setObject(""); setMember(""); })}>New identity binding</button>
      </fieldset>
      <h3>Saved mappings</h3><ul>{links.map(value => <li key={`${value.tenant_id}/${value.object_id}`}><button disabled={busy || needsReadback}
        onClick={() => change(() => { setSelected(value); setTenant(value.tenant_id); setObject(value.object_id); setMember(value.user_id); })}>
        {value.tenant_id} / {value.object_id} → {value.user_id} · revision {value.revision} · {value.enabled ? "enabled" : "disabled"}</button> · recorded {value.updated_at} by {value.linked_by}</li>)}</ul>
    </>}
  </section>;
}
