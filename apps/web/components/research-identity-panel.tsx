"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { researchPending, type ResearchRun } from "@/lib/research";
import { useSession } from "./session-gate";

type Inspection = components["schemas"]["IdentityInspection"];
type Request = components["schemas"]["IdentityRequest"];
type Decision = components["schemas"]["IdentityDecision"];

export function ResearchIdentityPanel({ view, run }: { view: AccountView; run: ResearchRun }) {
  const actor = useSession()?.actor;
  return actor ? <IdentityControls view={view} run={run} reviewer={["admin", "reviewer"].includes(actor.role)}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.assessment.snapshot_hash}:${run.id}:${run.revision}`} /> : null;
}

function IdentityControls({ view, run, reviewer }: { view: AccountView; run: ResearchRun; reviewer: boolean }) {
  const [ready, setReady] = useState<Inspection | null>(null), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState({ index: 0, decision: "uncertain" as Request["decision"], subject: "", note: "",
    url: "", referenceSubject: "", excerpt: "", relation: "" });
  const state = useRef({ mounted: false, sequence: 0, busy: false, input, ready: null as Inspection | null });
  const life = useRef<AbortController | null>(null);
  const scope = view.account.organization_id, path = `integrations/research/runs/${run.id}/identity-decisions`;
  useEffect(() => {
    const active = state.current, controller = new AbortController(); active.mounted = true; life.current = controller;
    const invalidate = () => { active.sequence++; active.ready = null; setReady(null); };
    window.addEventListener("focus", invalidate); window.addEventListener("vitaai-source-changed", invalidate);
    return () => { active.mounted = false; active.sequence++; controller.abort();
      window.removeEventListener("focus", invalidate); window.removeEventListener("vitaai-source-changed", invalidate); };
  }, []);
  function check(value: Inspection) {
    const valid = (item: Decision) => item.run_id === run.id && item.run_revision === run.revision
      && item.organization_id === scope && item.account_id === view.account.id && item.basis === "reviewer_adjudication"
      && item.factual_confidence === "unverified" && item.external_execution === false
      && Number.isInteger(item.source_index) && item.source_index >= 0 && item.source_index < (run.sources ?? []).length
      && item.source.url === run.sources![item.source_index].url;
    if (value.organization_id !== scope || value.account_id !== view.account.id || value.run_id !== run.id
      || value.run_revision !== run.revision || value.account_revision !== view.account.revision
      || value.snapshot_hash !== view.assessment.snapshot_hash || !/^[a-f0-9]{64}$/.test(value.sources_hash)
      || !Array.isArray(value.decisions) || value.decisions.length > 5 || !value.decisions.every(valid)
      || new Set(value.decisions.map(item => item.source_index)).size !== value.decisions.length
      || !Array.isArray(value.history) || value.history.length > 20 || !value.history.every(valid)) throw new Error("Identity binding changed");
    return value;
  }
  async function inspect() {
    const active = state.current, signal = life.current?.signal;
    if (!active.mounted || !signal || signal.aborted || active.busy || researchPending.has(scope)) return;
    const sequence = ++active.sequence; active.ready = null; setReady(null); setNotice(null);
    try {
      const value = check(await api<Inspection>(path, { signal }));
      if (active.mounted && !signal.aborted && sequence === active.sequence) { active.ready = value; setReady(value); }
    } catch { if (active.mounted && sequence === active.sequence) setNotice("Identity records unavailable. Inspect again before recording a decision."); }
  }
  function edit(changes: Partial<typeof input>) { state.current.input = { ...state.current.input, ...changes }; setInput(state.current.input); }
  async function submit(event: FormEvent) {
    event.preventDefault(); const active = state.current, signal = life.current?.signal;
    if (!reviewer || !active.mounted || active.busy || researchPending.has(scope) || !signal || signal.aborted
      || active.input !== input || active.ready !== ready || !ready?.can_review || !input.note.trim() || !input.subject.trim()) return;
    const source = run.sources?.[input.index]; if (!source) return;
    const reference = { schema_version: "1" as const, url: input.url, subject: input.referenceSubject, excerpt: input.excerpt, relation: input.relation };
    if (input.decision === "corroborated" && [input.url, input.referenceSubject, input.excerpt, input.relation].some(value => !value.trim())) return;
    const body: Request = { schema_version: "1", expected_revision: ready.decisions?.find(item => item.source_index === input.index)?.revision ?? 0,
      expected_run_revision: ready.run_revision, expected_account_revision: ready.account_revision,
      expected_snapshot_hash: ready.snapshot_hash, expected_sources_hash: ready.sources_hash,
      source_index: input.index, source_url: source.url, decision: input.decision, source_subject: input.subject,
      note: input.note, references: input.url ? [reference] : [] };
    active.busy = true; researchPending.add(scope); active.ready = null; active.sequence++; setReady(null); setBusy(true); setNotice(null);
    window.dispatchEvent(new Event("vitaai-research-identity-changing"));
    try {
      const saved = await api<Decision>(path, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (saved.run_id !== run.id || saved.account_id !== view.account.id || saved.organization_id !== scope
        || saved.revision !== body.expected_revision + 1 || saved.source_index !== input.index || saved.source.url !== source.url
        || saved.sources_hash !== ready.sources_hash || saved.report.decision !== input.decision) throw new Error("Unconfirmed decision");
      if (active.mounted && !signal.aborted) setNotice(`Saved reviewer decision ${saved.id}. Inspect identity records and current context again.`);
    } catch { if (active.mounted && !signal.aborted) setNotice("Decision was not confirmed and may have persisted. Inspect history; no request was repeated."); }
    finally { active.busy = false; researchPending.delete(scope);
      if (active.mounted && !signal.aborted) setBusy(false);
      window.dispatchEvent(new Event("vitaai-research-identity-changed")); }
  }
  const corroborated = input.decision === "corroborated";
  return <details><summary>Review source identity</summary>
    <p>Broader name variants and acronyms are candidates until an authorized reviewer records subject-bound corroboration. Identity decisions affect source eligibility. Facts, confidence and action approvals remain unchanged.</p>
    <button disabled={busy} onClick={() => void inspect()}>Inspect identity records</button>
    {notice && <p role="status">{notice}</p>}
    {ready && <><p>{ready.caveat}</p><h4>Latest decision for each source</h4>
      {!ready.decisions?.length && <p>No identity decisions. Existing domain/name candidates remain unverified.</p>}
      <ul>{ready.decisions?.map(item => <li key={item.id}>Source {item.source_index + 1} · {item.report.decision} · revision {item.revision}
        <p>Reviewer {item.actor_id} · {item.created_at} · account revision {item.account_revision} · snapshot {item.snapshot_hash}.</p>
        <p>{item.report.source_subject}: {item.report.note}</p>
        <ul>{item.report.references?.map(reference => <li key={reference.url}>{reference.url} · {reference.subject}
          <p>{reference.excerpt}</p><p>{reference.relation}</p></li>)}</ul></li>)}</ul>
      <details><summary>Recent identity history (latest 20)</summary><ol>{ready.history?.map(item => <li key={item.id}>
        {item.id} · source {item.source_index + 1} · revision {item.revision} · {item.report.decision} · {item.created_at}
        <p>{item.report.note}</p></li>)}</ol></details>
      <form onSubmit={submit}><fieldset disabled={busy || !reviewer || !ready.can_review}>
        <label>Identity source<select value={input.index} onChange={event => edit({ index: Number(event.target.value), subject: "" })}>
          {(run.sources ?? []).map((source, index) => <option key={source.url} value={index}>{index + 1}. {source.title}</option>)}</select></label>
        <label>Identity decision<select value={input.decision} onChange={event => edit({ decision: event.target.value as Request["decision"] })}>
          <option value="uncertain">Uncertain</option><option value="conflicting">Conflicting identity evidence</option>
          <option value="namesake_or_unrelated">Namesake or unrelated</option><option value="corroborated">Corroborated by reviewer evidence</option></select></label>
        <label>Exact subject text from retained title or excerpt<input value={input.subject} required maxLength={500} onChange={event => edit({ subject: event.target.value })} /></label>
        <label>Identity rationale<textarea value={input.note} required maxLength={2000} onChange={event => edit({ note: event.target.value })} /></label>
        <p>Corroboration requires evidence tying this article’s subject to {run.target.company_name} / {run.target.domain}. A keyword, repeated wire report or website mention alone is insufficient. Supplied reference evidence remains a reviewer assertion.</p>
        <label>Identity reference HTTPS URL<input value={input.url} required={corroborated} maxLength={2048} onChange={event => edit({ url: event.target.value })} /></label>
        <label>Reference subject<input value={input.referenceSubject} required={corroborated || !!input.url} maxLength={160} onChange={event => edit({ referenceSubject: event.target.value })} /></label>
        <label>Reference identity excerpt<textarea value={input.excerpt} required={corroborated || !!input.url} maxLength={2000} onChange={event => edit({ excerpt: event.target.value })} /></label>
        <label>How the reference binds the source subject to this company<textarea value={input.relation} required={corroborated || !!input.url} maxLength={1000} onChange={event => edit({ relation: event.target.value })} /></label>
        <button disabled={!input.note.trim() || !input.subject.trim()}>Record source identity decision</button>
      </fieldset></form></>}
  </details>;
}
