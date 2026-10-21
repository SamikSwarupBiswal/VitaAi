"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CatalogEntry } from "@/lib/comparison";
import { probeScope, providerTestPending, readProbe, readTestCatalog, readTestHistory, readTestReadiness, startProbe,
  type ProbeReadiness, type ProbeRun, type ProviderId } from "@/lib/provider-tests";

export function ProviderTestPanel({ organization, actor, role }: { organization: string; actor: string; role: string }) {
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [provider, setProvider] = useState<ProviderId | "">("");
  const [ready, setReady] = useState<ProbeReadiness | null>(null);
  const [runs, setRuns] = useState<ProbeRun[]>([]);
  const [selected, setSelected] = useState<ProbeRun | null>(null);
  const [lookup, setLookup] = useState("");
  const [live, setLive] = useState(false), [key, setKey] = useState("");
  const [reading, setReading] = useState(true), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), detailSequence = useRef(0);
  const choice = useRef<ProviderId | "">(""), requestKey = useRef(""), locked = useRef(false);
  const epoch = useRef(0), renderedEpoch = epoch.current;
  const currentReady = useRef<ProbeReadiness | null>(null);

  const refresh = useCallback(async (next = choice.current) => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const current = ++sequence.current; ++detailSequence.current; ++epoch.current;
    choice.current = next; currentReady.current = null; requestKey.current = "";
    setProvider(next); setKey(""); setLive(false); setReading(true); setReady(null);
    setCatalog([]); setRuns([]); setSelected(null); setLookup(""); setError(null);
    try {
      const entries = await readTestCatalog(signal);
      if (signal.aborted || current !== sequence.current) return;
      setCatalog(entries);
      if (!next) return;
      const entry = entries.find(item => item.provider === next);
      if (!entry) throw new Error("Provider unavailable");
      const [readiness, history] = await Promise.allSettled([
        readTestReadiness(organization, entry, signal), readTestHistory(organization, next, signal),
      ]);
      if (signal.aborted || current !== sequence.current) return;
      if (history.status === "fulfilled") setRuns(history.value);
      if (readiness.status === "fulfilled" && history.status === "fulfilled") {
        currentReady.current = readiness.value; setReady(readiness.value);
      } else setError("Provider test readiness or history unavailable. Valid saved history remains inspectable; refresh before another test.");
    } catch {
      if (!signal.aborted && current === sequence.current) setError("Provider test records unavailable. Refresh before another test.");
    } finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }, [organization]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload); window.addEventListener("vitaai-provider-tests-changed", reload);
    return () => {
      controller.abort(); requestKey.current = ""; currentReady.current = null;
      window.removeEventListener("focus", reload); window.removeEventListener("vitaai-provider-tests-changed", reload);
    };
  }, [refresh]);

  async function inspect(id: string) {
    const signal = lifetime.current?.signal;
    if (!provider || choice.current !== provider || renderedEpoch !== epoch.current || !id || !signal || signal.aborted || locked.current || reading) return;
    const current = ++detailSequence.current;
    setSelected(null); setError(null);
    try {
      const run = await readProbe(organization, provider, id, signal);
      if (!signal.aborted && current === detailSequence.current) setSelected(run);
    } catch { if (!signal.aborted && current === detailSequence.current) setError("Saved provider test unavailable for this organization and provider."); }
  }

  async function testProvider() {
    const signal = lifetime.current?.signal, entry = catalog.find(item => item.provider === provider);
    const scope = probeScope(organization, provider);
    if (!signal || signal.aborted || renderedEpoch !== epoch.current || choice.current !== provider || !entry
      || locked.current || providerTestPending.has(scope) || reading || role !== "admin" || !ready?.can_start
      || currentReady.current !== ready || ready.pending_run_id
      || (ready.next_start_at && Date.now() < Date.parse(ready.next_start_at))
      || (live && !(ready.live_configured || ready.byok_allowed && requestKey.current))
      || (live && requestKey.current && (!ready.byok_allowed || !/^[A-Za-z0-9_.:/+=-]{16,512}$/.test(requestKey.current)))) return;
    const apiKey = live ? requestKey.current || undefined : undefined;
    const mode = live ? "live" : "mock";
    locked.current = true; providerTestPending.add(scope);
    const current = ++sequence.current; ++detailSequence.current; ++epoch.current;
    requestKey.current = ""; currentReady.current = null;
    setKey(""); setLive(false); setReady(null); setSelected(null); setBusy(true); setNotice(null); setError(null);
    try {
      const saved = await startProbe(organization, actor, entry, mode, signal, apiKey);
      if (!signal.aborted && current === sequence.current) setNotice(`Test ${saved.id}: ${saved.status}. Inspect the saved record for the original outcome.`);
    } catch {
      if (!signal.aborted && current === sequence.current) setNotice("Test response could not be confirmed and may have persisted or billed. Saved-record refresh never repeats the test.");
    } finally {
      locked.current = false; providerTestPending.delete(scope);
      if (!signal.aborted) setBusy(false);
      // All mounted panels re-read saved state, including after navigation/uncertainty.
      window.dispatchEvent(new Event("vitaai-provider-tests-changed"));
    }
  }

  const disabled = busy || reading || providerTestPending.has(probeScope(organization, provider));
  const entry = catalog.find(item => item.provider === provider);
  return <details className="pipeline-panel comparison-panel"><summary>Synthetic provider tests</summary>
    <p>Test credential/model compatibility separately from discovery and account comparisons. No account data is sent. Facts, primary analysis, rank and workflow authority stay unchanged.</p>
    <p>Choose a provider, then explicitly test. Mock is the default and makes no provider call or compatibility claim. Live requires authorized service access, the separate test gate and existing provider gates; configuration alone is unverified.</p>
    <label>Provider to test<select value={provider} disabled={busy} onChange={event => { void refresh(event.target.value as ProviderId | ""); }}>
      <option value="">Choose a provider</option>{catalog.map(item => <option value={item.provider} key={item.provider}>{item.provider}</option>)}
    </select></label>
    {entry && <p>{entry.status} · configuration {entry.configuration_revision} · requested model {entry.model || "Unconfigured"} · expected response model {entry.expected_response_model || "Unconfigured"}.</p>}
    {role !== "admin" && <p>Read only. Only current session administrators may test providers.</p>}
    <p role="status">{reading ? "Loading saved provider test records..." : ready?.can_start ? "Explicit test available; live success remains unverified." : "Testing unavailable: role, test gate, organization, pending run or cooldown may block starts."}</p>
    {ready?.pending_run_id && <p>Pending test {ready.pending_run_id} blocks new starts even after worker expiry. Inspect saved history; interrupted-test finalization is not available yet.</p>}
    {ready?.next_start_at && <p>60-second provider cooldown ends {ready.next_start_at}. Refresh records to check eligibility.</p>}
    <fieldset disabled={disabled || role !== "admin" || !ready}><legend>Next explicit provider test</legend>
      <label><input type="checkbox" checked={live} disabled={disabled || role !== "admin" || !ready || !live && !(ready.live_configured || ready.byok_allowed && key)}
        onChange={event => { ++epoch.current; setLive(event.target.checked); }} />Use live provider for this test (may incur a charge)</label>
      {ready?.byok_allowed && <>
        <p>Optional one-request key. Kept in panel memory, cleared before submit/refresh/focus and on unmount; no browser storage. Sent only to VitaAi and the fixed provider endpoint, with no server-key retry. Empty uses the server credential.</p>
        <label>Provider test key for one request<input type="password" autoComplete="off" spellCheck={false} maxLength={512} value={key}
          onChange={event => { ++epoch.current; requestKey.current = event.target.value; setKey(event.target.value); }} /></label>
        <button disabled={disabled || !key} onClick={() => { ++epoch.current; requestKey.current = ""; setKey(""); }}>Clear provider test key</button>
      </>}
      <button disabled={disabled || role !== "admin" || !ready?.can_start || !!ready.pending_run_id
        || live && !(ready.live_configured || ready.byok_allowed && key)} onClick={() => testProvider()}>Test selected provider</button>
    </fieldset>
    <button disabled={busy} onClick={() => refresh()}>Refresh provider test records</button>
    {busy && <p role="status">Test request in progress...</p>}{notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    <section aria-label="Provider test history"><h2>Provider test history</h2>
      <p>Latest 20 saved tests for this organization and provider. Reads preserve original dates and never test, retry or renew authority. Synthetic compatibility does not certify factual quality. Failure/timeout does not prove provider cancellation or prevent billing.</p>
      {!reading && provider && !runs.length && <p>No confirmed saved tests.</p>}
      <ul>{runs.map(run => <li key={run.id}><button disabled={disabled} onClick={() => inspect(run.id)}>Inspect test {run.id}</button> · {run.status} · {run.started_at}</li>)}</ul>
      {ready?.pending_run_id && <button disabled={disabled} onClick={() => inspect(ready.pending_run_id!)}>Inspect pending provider test</button>}
      <label>Saved provider test ID<input value={lookup} onChange={event => setLookup(event.target.value)} /></label>
      <button disabled={disabled || !provider || !lookup.trim()} onClick={() => inspect(lookup.trim())}>Inspect saved provider test ID</button>
      {selected && <ProviderTestRecord run={selected} configuration={entry?.configuration_revision} />}
    </section>
  </details>;
}

function ProviderTestRecord({ run, configuration }: { run: ProbeRun; configuration?: number }) {
  return <section aria-label="Saved provider test"><h3>Saved provider test</h3>
    <p>Test {run.id} · {run.provider} · {run.status} · revision {run.revision} · policy {run.policy_version} · original actor {run.actor_id}.</p>
    <p>Organization {run.organization_id}; original configuration {run.configuration_revision}. {run.configuration_revision !== configuration ? "Historical configuration differs from the current provider." : "Historical outcome grants no renewed authority."}</p>
    <p>Requested {run.requested_mode}; returned {run.mode}; validation {run.validation}.</p>
    <p>Requested model {run.model || "Unconfigured"}; expected response model {run.expected_response_model || "Unconfigured"}; actual response model {run.response_model || "Not returned"}.</p>
    <p>Credential source: {run.credential_source === "request" ? "one-request user key (not retained)" : "server configuration"}.</p>
    <p>Started {run.started_at}; worker deadline {run.worker_deadline_at}; finished {run.finished_at || "Pending"}.</p>
    <p>Measured latency {run.latency_ms ?? "Not supplied"} ms; request {run.request_id || "Not supplied"}; input tokens {run.input_tokens ?? "Not supplied"}; output tokens {run.output_tokens ?? "Not supplied"}.</p>
    {run.error_code && <p>Server result: {run.error_code}</p>}
    {run.status === "succeeded" && <p>Only synthetic credential/model compatibility was validated. No account analysis or factual-quality certification.</p>}
    {run.status === "pending" && <p>Unresolved pending intent blocks duplicates. Reading never unblocks or retries it.</p>}
  </section>;
}
