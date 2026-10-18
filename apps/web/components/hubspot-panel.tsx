"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, currency, type AccountView } from "@/lib/api";
import { accountPath, postHubSpot, readPreview, readSource, type AccountSource, type HubSpotStatus,
  type HubSpotSyncRun, type SourceVersion } from "@/lib/hubspot";
import { useSession } from "./session-gate";

type Props = { view: AccountView; blocked?: boolean; onInvalidate: () => void; onRefresh: (message: string) => Promise<void> };
type PreviewData = NonNullable<Awaited<ReturnType<typeof readPreview>>>;

export function HubSpotPanel(props: Props) {
  const session = useSession();
  const actor = session?.actor;
  if (session?.mode !== "session" || !actor) return <details className="pipeline-panel"><summary>HubSpot source</summary>
    <p>Source controls require session identity. The sample workspace has no source-selection authority.</p></details>;
  return <HubSpotAccount {...props} admin={actor.role === "admin"}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${props.view.account.id}:${props.view.account.revision}`} />;
}

function HubSpotAccount({ view, admin, blocked = false, onInvalidate, onRefresh }: Props & { admin: boolean }) {
  const [status, setStatus] = useState<HubSpotStatus | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [history, setHistory] = useState<SourceVersion | null>(null);
  const [sourceId, setSourceId] = useState(view.source?.id || "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [settled, setSettled] = useState(false);
  const lifetime = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const historySequence = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    api<HubSpotStatus>("integrations/hubspot", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError("HubSpot status unavailable. Refresh current state."); });
    const sequence = ++historySequence.current;
    if (view.source?.id) readSource(view, view.source.id, controller.signal)
      .then(value => { if (!controller.signal.aborted && sequence === historySequence.current) setHistory(value); })
      .catch(() => { if (!controller.signal.aborted && sequence === historySequence.current) setError("Current source history unavailable for this account."); });
    return () => controller.abort();
    // The parent keys this component by session, account and revision.
  }, [view]);

  async function load(kind: "preview" | "history") {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || locked.current || settled || blocked) return;
    locked.current = true; setBusy(true); setError(null);
    if (kind === "history") ++historySequence.current;
    if (kind === "preview") setPreview(null); else setHistory(null);
    try {
      if (kind === "preview") {
        const value = await readPreview(view, signal);
        if (!signal.aborted) setPreview(value);
      } else {
        const value = await readSource(view, sourceId, signal);
        if (!signal.aborted) setHistory(value);
      }
    } catch (error) { if (!signal.aborted) setError(error instanceof Error ? error.message : "Source records unavailable."); }
    finally { locked.current = false; if (!signal.aborted) setBusy(false); }
  }

  async function mutate(kind: "sync" | "promote" | "restore-sample") {
    const signal = lifetime.current?.signal;
    if (!admin || !signal || signal.aborted || locked.current || settled || blocked || (kind !== "restore-sample" && !status?.configured)) return;
    if (kind === "promote" && (!preview || preview.preview.expected_account_revision !== view.account.revision)) return;
    if (kind === "restore-sample" && view.source?.kind !== "hubspot") return;
    locked.current = true; setBusy(true); setError(null); onInvalidate();
    let message: string;
    try {
      const body = kind === "promote" ? { schema_version: "1" as const, expected_account_revision: preview!.preview.expected_account_revision,
        observation_id: preview!.preview.observation_id, preview_hash: preview!.preview.preview_hash }
        : { schema_version: "1" as const, expected_account_revision: view.account.revision };
      if (kind === "sync") {
        const run = await postHubSpot<HubSpotSyncRun>(`${accountPath(view.account.id)}/sync`, body, signal);
        message = `Sync run ${run.id}: ${run.status} / ${run.disposition || run.error_code || "no observation"}. Staging does not select facts.`;
      } else {
        const source = await postHubSpot<AccountSource>(`${accountPath(view.account.id)}/${kind}`, body, signal);
        message = kind === "promote" ? `HubSpot selection recorded at revision ${source.account_revision}.`
          : `Restored original synthetic facts at revision ${source.account_revision}, retaining their original dates.`;
      }
    } catch {
      message = "Source request could not be confirmed and may have persisted. Current state must refresh before another write; inspect source history and do not assume it failed.";
    } finally {
      locked.current = false;
      if (!signal.aborted) { setPreview(null); setSettled(true); setBusy(false); }
    }
    // Aborting browser transport does not prove the server rolled back.
    if (signal.aborted) window.dispatchEvent(new Event("vitaai-source-changed"));
    await onRefresh(message);
  }

  function lookup(event: FormEvent) { event.preventDefault(); void load("history"); }
  const disabled = busy || settled || blocked;
  return <details className="pipeline-panel hubspot-panel"><summary>HubSpot source · {view.account.name}</summary>
    <p>Current source: {view.source?.kind === "hubspot" ? "HubSpot" : "Synthetic sample"} · account revision {view.account.revision}.</p>
    <p role="status">{status ? status.configured ? "Configured; provider connectivity is unverified. Inspect sync runs for observed results."
      : "Unconfigured for this organization. Ask your operator to configure an authorized test portal." : "Loading HubSpot status..."}</p>
    {!admin && <p className="caveat">Read only. An administrator must request sync or select source facts.</p>}
    <p className="caveat">Sync reads only the server-mapped company. Source selection replaces local account facts, changes its revision and invalidates old workflow authority. No HubSpot write or customer action occurs.</p>
    <div className="source-actions"><button disabled={disabled || !admin || !status?.configured} onClick={() => mutate("sync")}>Sync mapped company (read only)</button>
      <button disabled={disabled || !status?.configured} onClick={() => load("preview")}>Load normalization preview</button></div>
    {busy && <p role="status">Loading source records...</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {preview && <section aria-label="Normalization preview"><h2>Exact normalization preview</h2>
      <p>Replaces revision {preview.preview.expected_account_revision}. Annual contract value: {currency(preview.preview.account.annual_value)}; renewal: {preview.preview.account.renewal_date || "Unknown"}.</p>
      <ul>{Object.entries(preview.preview.field_status).map(([field, value]) => <li key={field}>{field.replaceAll("_", " ")}: {value}</li>)}</ul>
      {!preview.preview.evidence.length && <p>No normalized metric evidence. Missing values do not inherit sample facts.</p>}
      <p>Portal {preview.observation.portal_id} / company {preview.observation.company_id}. Provider updated {preview.observation.provider_updated_at}; fetched {preview.observation.fetched_at}.</p>
      <p>Observation: {preview.preview.observation_id}. Preview hash: {preview.preview.preview_hash}</p>
      <details open><summary>Exact replacement facts, evidence and binding</summary><pre>{JSON.stringify(preview.preview, null, 2)}</pre></details>
      <details><summary>Retained raw observation and property mapping</summary><pre>{JSON.stringify(preview.observation, null, 2)}</pre></details>
      <button disabled={disabled || !admin} onClick={() => mutate("promote")}>Use displayed HubSpot preview</button>
    </section>}
    {view.source?.kind === "hubspot" && <section aria-label="Restore synthetic source"><p>Restore the original saved synthetic facts and dates under a new revision. This does not make old evidence fresh or restore old approvals.</p>
      <button disabled={disabled || !admin} onClick={() => mutate("restore-sample")}>Restore original synthetic facts</button></section>}
    <section aria-label="Source history"><h2>Source history</h2>
      <p>Inspect an immutable before/after source version for this account. The current version loads automatically; earlier versions require their saved ID.</p>
      <form onSubmit={lookup}><label>Source version ID<input value={sourceId} required maxLength={36} onChange={event => setSourceId(event.target.value)} /></label>
        <button disabled={disabled}>Load source version</button></form>
      {history && <details open><summary>{history.selection.kind} · revision {history.selection.account_revision} · {history.selection.selected_at}</summary>
        <p>Selected by {history.selection.actor_id}; version {history.selection.id}. This is historical state, not current execution authority.</p>
        <pre>{JSON.stringify(history, null, 2)}</pre></details>}
    </section>
  </details>;
}
