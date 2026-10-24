"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import type { ResearchRun } from "@/lib/research";
import { useSession } from "./session-gate";

type Inspection = components["schemas"]["QualityInspection"];
type Report = components["schemas"]["QualityRequest"];
type Review = components["schemas"]["QualityReview"];
const locks = new Set<string>();

export function ResearchQualityPanel({ view, run }: { view: AccountView; run: ResearchRun }) {
  const actor = useSession()?.actor;
  return actor ? <QualityControls view={view} run={run} reviewer={["admin", "reviewer"].includes(actor.role)}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.assessment.snapshot_hash}:${run.id}:${run.revision}`} /> : null;
}

function QualityControls({ view, run, reviewer }: { view: AccountView; run: ResearchRun; reviewer: boolean }) {
  const sources = run.sources ?? [];
  const [ready, setReady] = useState<Inspection | null>(null), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [input, setInput] = useState({ index: 0, identity: "uncertain" as Report["identity"],
    factual: "uncertain" as Report["factual_support"], citation: "uncertain" as Report["citation_support"], note: "", references: "" });
  const state = useRef({ mounted: false, sequence: 0, busy: false, input, ready: null as Inspection | null });
  const life = useRef<AbortController | null>(null);
  const key = `${view.account.organization_id}:${run.id}`, path = `integrations/research/runs/${run.id}/quality-reviews`;
  useEffect(() => {
    const active = state.current, controller = new AbortController(); active.mounted = true; life.current = controller;
    const invalidate = () => { active.sequence++; active.ready = null; setReady(null); };
    window.addEventListener("focus", invalidate); window.addEventListener("vitaai-source-changed", invalidate);
    return () => { active.mounted = false; active.sequence++; controller.abort();
      window.removeEventListener("focus", invalidate); window.removeEventListener("vitaai-source-changed", invalidate); };
  }, []);
  function check(value: Inspection) {
    if (value.organization_id !== view.account.organization_id || value.account_id !== view.account.id
      || value.run_id !== run.id || value.run_revision !== run.revision || value.account_revision !== view.account.revision
      || value.snapshot_hash !== view.assessment.snapshot_hash || !/^[a-f0-9]{64}$/.test(value.sources_hash)
      || !Array.isArray(value.reviews) || value.reviews.length > 20 || value.reviews.some(item => item.run_id !== run.id
        || item.organization_id !== view.account.organization_id || item.account_id !== view.account.id
        || item.basis !== "manual_report" || item.factual_confidence !== "unverified" || item.external_execution !== false)) {
      throw new Error("Quality binding changed");
    }
    return value;
  }
  async function inspect() {
    const active = state.current, signal = life.current?.signal;
    if (!active.mounted || !signal || signal.aborted || active.busy || locks.has(key)) return;
    const sequence = ++active.sequence; active.ready = null; setReady(null); setNotice(null);
    try {
      const value = check(await api<Inspection>(path, { signal }));
      if (active.mounted && !signal.aborted && sequence === active.sequence) { active.ready = value; setReady(value); }
    } catch { if (active.mounted && sequence === active.sequence) setNotice("Source-quality records unavailable. Inspect again before recording a report."); }
  }
  function edit(changes: Partial<typeof input>) { state.current.input = { ...state.current.input, ...changes }; setInput(state.current.input); }
  async function submit(event: FormEvent) {
    event.preventDefault(); const active = state.current, signal = life.current?.signal;
    if (!reviewer || !active.mounted || active.busy || locks.has(key) || !signal || signal.aborted
      || active.input !== input || active.ready !== ready || !ready?.can_review || !input.note.trim()) return;
    const source = sources[input.index]; if (!source) return;
    const body: Report = { schema_version: "1", expected_revision: ready.latest_revision, expected_run_revision: ready.run_revision,
      expected_account_revision: ready.account_revision, expected_snapshot_hash: ready.snapshot_hash,
      expected_sources_hash: ready.sources_hash, source_index: input.index, source_url: source.url,
      identity: input.identity, factual_support: input.factual, citation_support: input.citation, note: input.note,
      references: input.references.split(/\r?\n/).map(value => value.trim()).filter(Boolean) };
    active.busy = true; locks.add(key); active.ready = null; active.sequence++; setReady(null); setBusy(true); setNotice(null);
    try {
      const saved = await api<Review>(path, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (saved.run_id !== run.id || saved.revision !== body.expected_revision + 1 || saved.sources_hash !== body.expected_sources_hash) throw new Error("Unconfirmed review");
      if (active.mounted && !signal.aborted) setNotice(`Saved human report ${saved.id}. Inspect history before another report.`);
    } catch { if (active.mounted && !signal.aborted) setNotice("Report was not confirmed and may have persisted. Inspect history; no request was repeated."); }
    finally { active.busy = false; locks.delete(key); if (active.mounted && !signal.aborted) setBusy(false); }
  }
  return <details><summary>Human source-quality review</summary>
    <p>Record a human assessment of one retained source. These reports do not certify facts or change scores, source eligibility, approval or execution.</p>
    <button disabled={busy} onClick={() => void inspect()}>Inspect source-quality records</button>
    {notice && <p role="status">{notice}</p>}
    {ready && <><p>{ready.caveat} Latest report revision {ready.latest_revision}.</p>
      <ol>{(ready.reviews ?? []).map(item => <li key={item.id}>Revision {item.revision} · {item.created_at} · reviewer {item.actor_id}
        <p>Source {item.source.url}; identity {item.report.identity}; factual support {item.report.factual_support}; citation support {item.report.citation_support}.</p>
        <p>{item.report.note}</p><p>Human references: {(item.report.references ?? []).join(", ") || "None"}. Original account revision {item.account_revision}; snapshot {item.snapshot_hash}.</p></li>)}</ol>
      <form onSubmit={submit}><fieldset disabled={busy || !reviewer || !ready.can_review}>
        <label>Retained source<select value={input.index} onChange={event => edit({ index: Number(event.target.value) })}>
          {sources.map((source, index) => <option key={source.url} value={index}>{index + 1}. {source.title}</option>)}</select></label>
        <label>Identity assessment<select value={input.identity} onChange={event => edit({ identity: event.target.value as Report["identity"] })}>
          <option value="uncertain">Uncertain</option><option value="consistent">Consistent with intended company</option><option value="namesake_or_unrelated">Namesake or unrelated</option></select></label>
        <label>Factual support<select value={input.factual} onChange={event => edit({ factual: event.target.value as Report["factual_support"] })}>
          <option value="uncertain">Uncertain</option><option value="supported">Supported by reviewer references</option><option value="contradicted">Contradicted by reviewer references</option></select></label>
        <label>Citation support<select value={input.citation} onChange={event => edit({ citation: event.target.value as Report["citation_support"] })}>
          <option value="uncertain">Uncertain</option><option value="supports_excerpt">Supports retained excerpt</option><option value="does_not_support">Does not support retained excerpt</option></select></label>
        <label>Human review note<textarea value={input.note} maxLength={2000} required onChange={event => edit({ note: event.target.value })} /></label>
        <label>Reference HTTPS URLs, one per line (up to five)<textarea value={input.references} maxLength={10000} onChange={event => edit({ references: event.target.value })} /></label>
        <button disabled={!input.note.trim()}>Record human source-quality report</button>
      </fieldset></form></>}
  </details>;
}
