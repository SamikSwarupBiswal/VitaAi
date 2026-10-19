"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { AccountView } from "@/lib/api";
import type { SourceDetection } from "@/lib/hubspot";
import type { Plan } from "@/lib/workflow";
import { compatibleChoices, currentEvent, readSourceContext, readSourcePlan, selectSourceMission,
  sourceSelectionPending, type SourceSelection } from "@/lib/source-missions";
import { useSession } from "./session-gate";

export function SourceMissionPanel({ view, record }: { view: AccountView; record: SourceDetection }) {
  const actor = useSession()?.actor;
  const [ready, setReady] = useState(false);
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [planId, setPlanId] = useState("");
  const [plan, setPlan] = useState<Plan | null>(null);
  const [alternative, setAlternative] = useState("");
  const [selection, setSelection] = useState<SourceSelection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null);
  const sequence = useRef(0), locked = useRef(false), eligible = useRef(false);
  const proposal = useRef<Plan | null>(null), chosen = useRef("");
  const writer = !!actor && actor.organization_id === view.account.organization_id && actor.role !== "viewer";

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const current = ++sequence.current; eligible.current = false; proposal.current = null; chosen.current = "";
    setReady(false); setReading(true); setPlan(null); setAlternative(""); setSelection(null); setError(null);
    try {
      const context = await readSourceContext(view, record, signal);
      if (!signal.aborted && current === sequence.current) {
        setSelection(context.selection); setReady(true); eligible.current = !context.selection;
      }
    } catch { if (!signal.aborted && current === sequence.current) setError("Selection records unavailable or account changed. Refresh records or portfolio before selection."); }
    finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }, [view, record]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload); window.addEventListener("vitaai-source-missions-changed", reload);
    return () => { controller.abort(); eligible.current = false;
      window.removeEventListener("focus", reload); window.removeEventListener("vitaai-source-missions-changed", reload); };
  }, [refresh]);

  function changePlan(value: string) {
    ++sequence.current; proposal.current = null; chosen.current = "";
    setPlanId(value); setPlan(null); setAlternative(""); setReading(false); setError(null);
  }

  async function loadPlan(event: FormEvent) {
    event.preventDefault(); const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || !writer || !eligible.current || locked.current || sourceSelectionPending(view)) return;
    const current = ++sequence.current; proposal.current = null; chosen.current = "";
    setPlan(null); setAlternative(""); setReading(true); setError(null);
    try {
      const value = await readSourcePlan(view, record, planId, signal);
      if (!signal.aborted && current === sequence.current) { proposal.current = value; setPlan(value); }
    } catch { if (!signal.aborted && current === sequence.current) setError("Saved plan is unavailable, used, stale or incompatible. Load a fresh unused plan for this account/event."); }
    finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }

  async function select() {
    const signal = lifetime.current?.signal, saved = proposal.current, choice = chosen.current;
    if (!signal || signal.aborted || !writer || !eligible.current || locked.current || sourceSelectionPending(view)
      || !currentEvent(view, record) || !saved || !choice) return;
    locked.current = true; eligible.current = false; ++sequence.current;
    setBusy(true); setReady(false); setError(null); setNotice(null);
    try {
      const result = await selectSourceMission(view, record, saved, choice, signal);
      if (!signal.aborted) setNotice(result.status === "mission_created"
        ? "Created one unprepared draft. Prepare actions and obtain fresh exact review in Missions."
        : "Historical mission_exists replay. Original selection retained; no new work or renewed authority.");
    } catch { if (!signal.aborted) setNotice("Selection response could not be confirmed and may have persisted. Refresh reads saved records without repeating POST; an aborted request does not prove rollback."); }
    finally {
      locked.current = false;
      if (!signal.aborted) { setBusy(false); await refresh(); }
      else window.dispatchEvent(new Event("vitaai-source-missions-changed"));
      window.dispatchEvent(new Event("vitaai-workflow-changed"));
    }
  }

  const pending = busy || sourceSelectionPending(view), compatible = currentEvent(view, record);
  return <section aria-label="Event mission selection"><h4>Mission from saved event</h4>
    <p>Only a cited valid metric value change can propose work. Selection creates an unprepared draft; actions require separate preparation and fresh exact approval.</p>
    {!writer && <p>Read only. A seller, reviewer or admin must select a plan.</p>}
    {!compatible && <p>This saved event differs from the current selection or has no supported valid metric value change. New selection is blocked.</p>}
    <p role="status">{reading ? "Loading saved selection..." : ready ? "Saved selection records loaded. The server rechecks all planning and source gates on submission." : "Selection not verified; writes blocked."}</p>
    <button disabled={pending} onClick={() => refresh()}>Refresh selection records</button>
    {notice && <p role="status">{notice}</p>}{error && <p role="alert" className="error-banner">{error}</p>}
    {selection ? <SelectionRecord selection={selection} view={view} /> : <>
      <p>Create a plan explicitly in <a href={`/missions?account=${encodeURIComponent(view.account.id)}`}>Missions</a>, copy its saved ID before starting a mission, then load it here. Loading never creates a plan or calls a model.</p>
      <form onSubmit={loadPlan}><label>Saved plan ID<input value={planId} required maxLength={36} disabled={pending || !writer || !compatible || !ready}
        onChange={event => changePlan(event.target.value)} /></label>
        <button disabled={pending || reading || !writer || !compatible || !ready}>Load saved plan</button></form>
      {plan && <><p>Plan {plan.id} · revision {plan.revision} · {plan.source} / {plan.validation}. Account revision {plan.evidence.account_revision}; as of {plan.evidence.as_of}.</p>
        <fieldset disabled={pending || reading || !ready || !writer}><legend>Choose a cited compatible alternative</legend>
          {compatibleChoices(record, plan).map(({ alternative: choice, template }) => <label className="mission-choice" key={choice.id}>
            <input type="radio" name={`source-alternative-${record.id}`} checked={alternative === choice.id}
              onChange={() => { chosen.current = choice.id; setAlternative(choice.id); }} />
            <span>{choice.rationale}<small>{template} · {choice.id}</small><small>{choice.risks.join(" ")}</small></span>
          </label>)}
        </fieldset></>}
      <button disabled={pending || reading || !ready || !writer || !compatible || !plan || !alternative} onClick={select}>Create draft from selected event and plan</button>
    </>}
  </section>;
}

function SelectionRecord({ selection, view }: { selection: SourceSelection; view: AccountView }) {
  const request = selection.request;
  return <div className="exact-preview"><p>Historical selection {selection.id}; original actor {selection.actor_id}; selected {selection.created_at}; policy {selection.policy_version}.</p>
    <p>{request.expected_account_revision === view.account.revision && request.expected_source_id === view.source?.id
      ? "Original source matches the displayed selection." : "Original source or account revision differs from the displayed current selection."} No renewed approval or execution authority.</p>
    <p>Detection {selection.detection.id}; event {request.event_id}; source {request.expected_source_id}; original account revision {request.expected_account_revision}.</p>
    <p>Plan {request.plan_id} revision {request.expected_revision}; alternative {request.alternative_id || "original plan default"}; template {request.template}.</p>
    <a href={`/missions?account=${encodeURIComponent(view.account.id)}&mission=${encodeURIComponent(selection.mission_id)}`}>Open saved mission {selection.mission_id}</a>
  </div>;
}
