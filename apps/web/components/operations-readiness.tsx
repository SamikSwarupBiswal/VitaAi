"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Schema = components["schemas"];
type Readiness = Schema["RefreshScheduleView"] | Schema["IngestionReadiness"] | Schema["ResearchReadiness"] | Schema["ComparisonReadiness"];
type Row = { label: string; target: string; detail: string };
const entries = [
  { label: "Scheduled HubSpot staging", target: "scheduled-staging", path: "integrations/hubspot/accounts/", suffix: "/refresh-schedule" },
  { label: "Associated HubSpot records", target: "associated-records", path: "integrations/hubspot/accounts/", suffix: "/ingestions/readiness" },
  { label: "Advisory research", target: "advisory-research", path: "integrations/research/accounts/", suffix: "/readiness" },
  { label: "Provider comparison", target: "provider-comparison", path: "provider-comparison/accounts/", suffix: "/readiness" },
];
const unavailable = "Read unavailable. Inspect the controls or refresh; eligibility is unknown.";

function describe(value: Readiness) {
  if ("authorization" in value) {
    const grant = value.authorization;
    return `${value.pending_occurrence_id ? `Pending occurrence ${value.pending_occurrence_id}. ` : "No pending occurrence reported. "}`
      + `${grant ? `Retained authorization ${grant.id}: ${grant.status}; original expiry ${grant.expires_at}. ` : "No retained authorization. "}`
      + `New authorization ${value.can_authorize ? "eligible" : "unavailable"} at this read. Worker ${value.worker_available ? "configured, unverified" : "unavailable"}.`;
  }
  const pending = value.pending_run_id ? `Pending run ${value.pending_run_id}. ` : "No pending run reported. ";
  if ("ingestion_enabled" in value) return pending + `Start ${value.can_start ? "eligible" : "unavailable"} at this read; ${value.reason.replaceAll("_", " ")}.`
    + (value.cooldown_until ? ` Retained cooldown until ${value.cooldown_until}.` : "");
  const configuration = "live_status" in value ? value.live_status === "configured_unverified" : value.configured;
  return pending + `Start ${value.can_start ? "eligible" : "unavailable"} at this read. ${configuration ? "Configured, unverified." : "Live service unconfigured."}`
    + (value.next_start_at ? ` Retained next-start boundary ${value.next_start_at}.` : "");
}

export async function readOperationsReadiness(view: AccountView, signal: AbortSignal): Promise<Row[]> {
  const [current, results] = await Promise.all([
    api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal }),
    Promise.allSettled(entries.map(entry => api<Readiness>(`${entry.path}${encodeURIComponent(view.account.id)}${entry.suffix}`, { signal }))),
  ]);
  if (signal.aborted || current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.assessment.snapshot_hash !== view.assessment.snapshot_hash
    || (current.source?.id ?? null) !== (view.source?.id ?? null)) throw new Error("Current account unavailable. Refresh portfolio.");
  return entries.map((entry, index) => {
    const result = results[index];
    const value = result.status === "fulfilled" ? result.value : null;
    const valid = value && value.account_id === view.account.id && value.organization_id === view.account.organization_id
      && value.account_revision === view.account.revision
      && (!("snapshot_hash" in value) || value.snapshot_hash === view.assessment.snapshot_hash);
    return { label: entry.label, target: entry.target, detail: valid ? describe(value) : unavailable };
  });
}

export function OperationsReadiness({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  const scoped = session?.mode === "session" && actor?.organization_id === view.account.organization_id;
  const scope = JSON.stringify([actor?.id, actor?.role, actor?.organization_id, view.account.id, view.account.revision,
    view.source?.id, view.assessment.snapshot_hash]);
  const [saved, setSaved] = useState<{ scope: string; rows: Row[]; readAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0);
  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!scoped || !signal || signal.aborted) return;
    const request = ++sequence.current; setSaved(null); setError(null);
    try {
      const rows = await readOperationsReadiness(view, signal);
      if (!signal.aborted && request === sequence.current) setSaved({ scope, rows, readAt: new Date().toISOString() });
    } catch { if (!signal.aborted && request === sequence.current) setError("Current readiness unavailable. Refresh portfolio or retry the local reads."); }
  }, [view, scope, scoped]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    const events = ["focus", "vitaai-refresh-changed", "vitaai-ingestion-changed", "vitaai-research-changed", "vitaai-comparison-changed"];
    events.forEach(name => window.addEventListener(name, reload));
    return () => { controller.abort(); events.forEach(name => window.removeEventListener(name, reload)); };
  }, [refresh]);
  const current = saved?.scope === scope ? saved : null;
  return <section aria-label="Integration readiness" className="exact-preview"><h2>Integration readiness · {view.account.name}</h2>
    <p>Local configuration and saved-work checks only. This is not provider connectivity, ongoing health or action approval. Refresh after using integration controls.</p>
    {!scoped ? <p>Sign in to inspect private integration readiness.</p> : <>
      <button onClick={() => refresh()}>Refresh integration readiness</button>
      {error ? <p role="alert">{error}</p> : !current ? <p role="status">Reading current account readiness...</p> : <>
        <p>Local read completed {current.readAt}. Account revision {view.account.revision}. No provider request was made.</p>
        <ul>{current.rows.map(row => <li key={row.target}><h3>{row.label}</h3><p>{row.detail}</p>
          <a href={`#${row.target}`}>Inspect {row.label} controls</a></li>)}</ul>
      </>}
    </>}
  </section>;
}
