"use client";

import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { PipelineRun } from "@/lib/api";
import { researchContextUsable } from "@/lib/research";
import { readSavedResearchFusion, savedResearchId, type ResearchFusion } from "@/lib/research-fusion";
import { ResearchContextRecord } from "./research-panel";
import { useSession } from "./session-gate";

export function SavedResearchFusion({ current, accountId }: { current: PipelineRun; accountId: string }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== current.organization_id) return null;
  return <FusionInspector current={current} accountId={accountId}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${current.id}:${accountId}`} />;
}

function FusionInspector({ current, accountId }: { current: PipelineRun; accountId: string }) {
  const [input, setInput] = useState({ id: "" });
  const [result, setResult] = useState<ResearchFusion | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const binding = useRef({ mounted: false, input, sequence: 0, busy: false });
  const request = useRef<AbortController | null>(null), currentRun = useRef<PipelineRun | null>(current);
  useLayoutEffect(() => { currentRun.current = current;
    return () => { currentRun.current = null; request.current?.abort(); };
  }, [current]);
  useEffect(() => {
    const active = binding.current; active.mounted = true;
    const invalidate = () => {
      active.sequence++; active.busy = false; active.input = { id: active.input.id };
      request.current?.abort(); setInput(active.input); setResult(null); setBusy(false); setError(null);
    };
    const tick = () => setNow(Date.now());
    const timer = window.setInterval(tick, 1000);
    window.addEventListener("focus", invalidate); window.addEventListener("vitaai-source-changed", invalidate);
    window.addEventListener("vitaai-research-identity-changing", invalidate);
    window.addEventListener("vitaai-research-identity-changed", invalidate);
    return () => { active.mounted = false; active.sequence++; request.current?.abort(); window.clearInterval(timer);
      window.removeEventListener("focus", invalidate); window.removeEventListener("vitaai-source-changed", invalidate);
      window.removeEventListener("vitaai-research-identity-changing", invalidate);
      window.removeEventListener("vitaai-research-identity-changed", invalidate); };
  }, []);
  function edit(id: string) {
    const active = binding.current; active.input = { id }; active.sequence++; active.busy = false;
    request.current?.abort(); setInput(active.input); setResult(null); setBusy(false); setError(null);
  }
  async function inspect(event: FormEvent) {
    event.preventDefault(); const active = binding.current;
    if (!active.mounted || active.busy || active.input !== input || currentRun.current !== current || !savedResearchId.test(input.id)) return;
    const sequence = ++active.sequence; active.busy = true; setBusy(true); setError(null); setResult(null);
    const controller = new AbortController(); request.current = controller;
    const matches = () => active.mounted && active.sequence === sequence && active.input === input
      && currentRun.current === current && !controller.signal.aborted;
    try {
      const value = await readSavedResearchFusion(current, accountId, input.id, controller.signal);
      if (matches()) setResult(value);
    } catch { if (matches()) setError("Saved research is unavailable for this current recommendation. Check the ID and refresh the account or preparation."); }
    finally { if (matches()) { active.busy = false; setBusy(false); } }
  }
  const usable = !!result && researchContextUsable(result.research_context, now);
  return <details><summary>Pair saved research with this recommendation</summary>
    <p>Inspect an existing research run for this exact account and preparation snapshot. This reads saved records without searching, rerunning preparation or changing its recommendation.</p>
    <a href={`/?persona=seller&account=${encodeURIComponent(accountId)}#advisory-research`}>Inspect this account’s advisory research</a>
    <form onSubmit={inspect}><label>Saved research run ID<input value={input.id} required maxLength={36} onChange={event => edit(event.target.value)} /></label>
      <button disabled={busy || !savedResearchId.test(input.id)}>{busy ? "Reading saved research..." : "Inspect saved research pairing"}</button></form>
    {error && <p role="alert">{error}</p>}
    {result && <section aria-label="Selected research specialist"><h4>Selected research specialist</h4>
      <p>Saved preparation {result.pipeline_run_id} · {result.pipeline_started_at}. Original rank, action, scores, confidence and approval remain unchanged.</p>
      <p>{usable ? "Supporting public context for human verification" : "No currently usable public context"}. Factual confidence unverified.</p>
      {usable && <ul>{(result.research_specialist.findings ?? []).map((finding, index) => <li key={index}>
        {finding.question}<p>Internal evidence: {finding.evidence_ids.join(", ") || "None"}. Public sources: {finding.source_urls.join(", ")}.</p>
      </li>)}</ul>}
      <ResearchContextRecord context={result.research_context} now={now} />
    </section>}
  </details>;
}
