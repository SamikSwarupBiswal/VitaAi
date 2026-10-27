"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Schema = components["schemas"];
type Readiness = Schema["RefreshScheduleView"] | Schema["IngestionReadiness"] | Schema["ResearchReadiness"] | Schema["ComparisonReadiness"] | Schema["HubSpotExecutionReadiness"];
type Row = { label: string; target: string; detail: string; href?: string };
const entries = [
  { label: "Scheduled HubSpot staging", target: "scheduled-staging", path: "integrations/hubspot/accounts/", suffix: "/refresh-schedule" },
  { label: "Associated HubSpot records", target: "associated-records", path: "integrations/hubspot/accounts/", suffix: "/ingestions/readiness" },
  { label: "Advisory research", target: "advisory-research", path: "integrations/research/accounts/", suffix: "/readiness" },
  { label: "Provider comparison", target: "provider-comparison", path: "provider-comparison/accounts/", suffix: "/readiness" },
  { label: "HubSpot execution", target: "hubspot-execution", path: "integrations/hubspot/accounts/", suffix: "/execution-readiness" },
];
const unavailable = "Read unavailable. Inspect the controls or refresh; eligibility is unknown.";

function describe(value: Readiness) {
  if ("write_configured" in value) {
    return `Writes ${value.write_configured ? "configured, unverified" : "unavailable"}; retained-ID readback ${value.readback_configured ? "configured, unverified" : "unavailable"}. `
      + `Preparation role capability ${value.can_prepare ? "eligible" : "unavailable"}; reviewer readback role capability ${value.can_reconcile ? "eligible" : "unavailable"} at this read. `
      + "Configuration and role eligibility do not authorize execution or reconciliation.";
  }
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

function describeMicrosoft(value: Schema["MicrosoftStatus"]) {
  if ([value.configured, value.connected, value.write_configured, value.refresh_pending].some(item => typeof item !== "boolean")
    || (value.expires_at != null && (!Number.isSafeInteger(value.expires_at) || value.expires_at < 0 || value.expires_at > 8640000000000))
    || (value.connected && (!value.configured || value.refresh_pending || !value.binding_id || !value.mailbox_id || value.expires_at == null))
    || (value.write_configured && !value.configured)) throw new Error("Connection status unavailable");
  const connected = value.connected && !value.refresh_pending && value.expires_at! > Date.now() / 1000;
  return `Current signed-in actor: ${value.configured ? "configured, unverified" : "unconfigured"}; `
    + `${value.refresh_pending ? "refresh pending; connection unavailable" : connected ? "connected at this read" : "disconnected or expired"}. `
    + `Draft writes ${value.write_configured ? "configured, unverified" : "disabled"}. `
    + `Retained connection expiry ${value.expires_at == null ? "not reported" : new Date(value.expires_at * 1000).toISOString()}. `
    + "This is not the saved action maker's mailbox readiness or approval. Inspect the exact mission before recovery.";
}

export async function readOperationsReadiness(view: AccountView, signal: AbortSignal, actor: Schema["Actor"]): Promise<Row[]> {
  if (signal.aborted || actor.organization_id !== view.account.organization_id) throw new Error("Current session unavailable");
  const [current, results] = await Promise.all([
    api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal }),
    Promise.allSettled([
      ...entries.map(entry => api<Readiness>(`${entry.path}${encodeURIComponent(view.account.id)}${entry.suffix}`, { signal })),
      api<Schema["MicrosoftStatus"]>("integrations/microsoft", { signal }),
    ]),
  ]);
  if (signal.aborted || current.account.id !== view.account.id || current.account.organization_id !== view.account.organization_id
    || current.account.revision !== view.account.revision || current.assessment.snapshot_hash !== view.assessment.snapshot_hash
    || current.assessment.as_of !== view.assessment.as_of
    || (current.source?.id ?? null) !== (view.source?.id ?? null)) throw new Error("Current account unavailable. Refresh portfolio.");
  // Microsoft status is actor-wide and has no actor fields. Recheck the authenticated scope before publishing it.
  const session = await api<Schema["SessionView"]>("auth/session", { signal });
  if (signal.aborted || session.mode !== "session" || session.actor?.id !== actor.id
    || session.actor.organization_id !== actor.organization_id || session.actor.role !== actor.role) throw new Error("Current session unavailable");
  const missionHref = `/missions?${new URLSearchParams({ account: view.account.id })}`;
  const rows: Row[] = entries.map((entry, index) => {
    const result = results[index];
    const value = result.status === "fulfilled" && result.value && typeof result.value === "object" && "account_id" in result.value ? result.value : null;
    const valid = value && value.account_id === view.account.id && value.organization_id === view.account.organization_id
      && value.account_revision === view.account.revision
      && (!("snapshot_hash" in value) || value.snapshot_hash === view.assessment.snapshot_hash)
      && (!("destination" in value) || !value.destination || (value.destination.provider === "hubspot" && value.destination.target_account_id === view.account.id))
      && (entry.target !== "hubspot-execution" || ("write_configured" in value
        && [value.write_configured, value.readback_configured, value.can_prepare, value.can_reconcile].every(item => typeof item === "boolean")
        && (!value.readback_configured || !!value.destination) && (!value.write_configured || value.readback_configured)
        && (!value.can_prepare || (value.write_configured && actor.role !== "viewer"))
        && (!value.can_reconcile || (value.readback_configured && ["admin", "reviewer"].includes(actor.role)))));
    let detail = unavailable;
    if (valid) { try { detail = describe(value); } catch { /* One malformed row does not hide independent saved readiness. */ } }
    return { label: entry.label, target: entry.target, detail,
      ...(entry.target === "hubspot-execution" ? { href: missionHref } : {}) };
  });
  const microsoft = results.at(-1)!;
  let detail = unavailable;
  if (microsoft.status === "fulfilled" && microsoft.value && typeof microsoft.value === "object" && "connected" in microsoft.value) {
    try { detail = describeMicrosoft(microsoft.value); } catch { /* Preserve independent integration rows when this status is malformed. */ }
  }
  rows.push({ label: "Microsoft connection", target: "microsoft-connection", href: missionHref, detail });
  return rows;
}

export function OperationsReadiness({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  const scoped = session?.mode === "session" && actor?.organization_id === view.account.organization_id;
  const scope = JSON.stringify([actor?.id, actor?.role, actor?.organization_id, view.account.id, view.account.organization_id, view.account.revision,
    view.source?.id, view.assessment.as_of, view.assessment.snapshot_hash]);
  const [saved, setSaved] = useState<{ scope: string; rows: Row[]; readAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), currentScope = useRef<string | null>(scope);
  useLayoutEffect(() => {
    currentScope.current = scope;
    return () => { currentScope.current = null; lifetime.current?.abort(); };
  }, [scope]);
  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!scoped || !actor || !signal || signal.aborted || currentScope.current !== scope) return;
    const request = ++sequence.current; setSaved(null); setError(null);
    try {
      const rows = await readOperationsReadiness(view, signal, actor);
      if (!signal.aborted && currentScope.current === scope && request === sequence.current) setSaved({ scope, rows, readAt: new Date().toISOString() });
    } catch { if (!signal.aborted && currentScope.current === scope && request === sequence.current) setError("Current readiness unavailable. Refresh portfolio or retry the local reads."); }
  }, [view, scope, scoped, actor]);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    const events = ["focus", "vitaai-refresh-changed", "vitaai-ingestion-changed", "vitaai-research-changed", "vitaai-comparison-changed",
      "vitaai-source-changed", "vitaai-microsoft-changed", "vitaai-workflow-changed"];
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
          <a href={row.href ?? `#${row.target}`}>Inspect {row.label} controls</a></li>)}</ul>
      </>}
    </>}
  </section>;
}
