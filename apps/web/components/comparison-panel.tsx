"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AccountView } from "@/lib/api";
import { checkComparisonRun, comparisonPending, discoverComparisonProvider, readComparisons, readComparisonRun,
  startComparison, type CatalogEntry, type ComparisonReadiness, type ComparisonRun, type DiscoveryResult } from "@/lib/comparison";
import { useSession } from "./session-gate";

export function ComparisonPanel({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor) return <details className="pipeline-panel"><summary>Provider comparison</summary>
    <p>Comparison controls require session identity.</p></details>;
  return <ComparisonAccount view={view} role={actor.role}
    key={`${actor.id}:${actor.organization_id}:${actor.role}:${view.account.id}:${view.account.revision}:${view.assessment.snapshot_hash}`} />;
}

function ComparisonAccount({ view, role }: { view: AccountView; role: string }) {
  const [ready, setReady] = useState<ComparisonReadiness | null>(null);
  const [catalog, setCatalog] = useState<CatalogEntry[]>([]);
  const [runs, setRuns] = useState<ComparisonRun[]>([]);
  const [selected, setSelected] = useState<ComparisonRun | null>(null);
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [live, setLive] = useState<Record<string, boolean>>({});
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [lookup, setLookup] = useState("");
  const [reading, setReading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), locked = useRef(false);
  const scope = view.account.organization_id;

  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted) return;
    const current = ++sequence.current;
    setReading(true); setReady(null); setCatalog([]); setRuns([]); setSelected(null); setDiscovery(null);
    setChoices({}); setLive({}); setError(null);
    try {
      const value = await readComparisons(view, signal);
      if (!signal.aborted && current === sequence.current) {
        setReady(value.readiness); setCatalog(value.catalog); setRuns(value.runs);
        return value;
      }
    } catch { if (!signal.aborted && current === sequence.current) setError("Comparison records unavailable. Refresh records or portfolio before another request."); }
    finally { if (!signal.aborted && current === sequence.current) setReading(false); }
  }, [view]);

  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    queueMicrotask(() => { if (!controller.signal.aborted) void refresh(); });
    const reload = () => { void refresh(); };
    window.addEventListener("focus", reload); window.addEventListener("vitaai-comparison-changed", reload);
    return () => { controller.abort(); window.removeEventListener("focus", reload);
      window.removeEventListener("vitaai-comparison-changed", reload); };
  }, [refresh]);

  async function mutate(entry?: CatalogEntry) {
    const signal = lifetime.current?.signal;
    const providers = catalog.filter(item => choices[item.provider]).map(item => ({ schema_version: "1" as const,
      provider: item.provider, mode: live[item.provider] ? "live" as const : "mock" as const,
      expected_configuration_revision: item.configuration_revision }));
    if (!signal || signal.aborted || locked.current || comparisonPending.has(scope) || reading || !ready
      || (entry ? role !== "admin" : role === "viewer" || !ready.can_start || !providers.length)
      || (entry ? live[entry.provider] && !entry.live_configured
        : providers.some(choice => choice.mode === "live" && !catalog.find(item => item.provider === choice.provider)?.live_configured))) return;
    locked.current = true; comparisonPending.add(scope); ++sequence.current;
    setBusy(true); setReady(null); setSelected(null); setDiscovery(null); setError(null); setNotice(null);
    let found: DiscoveryResult | null = null;
    try {
      if (entry) found = await discoverComparisonProvider(entry, live[entry.provider] ? "live" : "mock", signal);
      else {
        const run = checkComparisonRun(view, await startComparison(view, providers, signal));
        if (run.account_revision !== view.account.revision || run.snapshot_hash !== view.assessment.snapshot_hash
          || run.results.length !== providers.length || run.results.some((result, index) => result.provider !== providers[index].provider
            || result.requested_mode !== providers[index].mode || result.configuration_revision !== providers[index].expected_configuration_revision)) {
          throw new Error("Comparison context changed");
        }
        if (!signal.aborted) setNotice(`Run ${run.id}: ${run.status}. Processing completion does not mean every provider succeeded. Inspect saved records.`);
      }
    } catch {
      if (!signal.aborted) setNotice("Response could not be confirmed and may have persisted. Refresh only reads records; it never repeats the request. Pending comparisons require operator investigation.");
    } finally {
      locked.current = false; comparisonPending.delete(scope);
      if (!signal.aborted) {
        setBusy(false); setLive({}); setChoices({});
        const fresh = await refresh();
        const discovered = found;
        if (!signal.aborted && discovered && fresh?.catalog.some(item => item.provider === discovered.provider
          && item.configuration_revision === discovered.configuration_revision)) setDiscovery(discovered);
      } else window.dispatchEvent(new Event("vitaai-comparison-changed"));
    }
  }

  async function inspect(id: string) {
    const signal = lifetime.current?.signal;
    if (!id || !signal || signal.aborted || locked.current || reading) return;
    const current = ++sequence.current; setSelected(null); setError(null);
    try {
      const run = await readComparisonRun(view, id, signal);
      if (!signal.aborted && current === sequence.current) setSelected(run);
    } catch { if (!signal.aborted && current === sequence.current) setError("Saved comparison unavailable for this account."); }
  }

  const disabled = busy || reading || comparisonPending.has(scope);
  return <details className="pipeline-panel comparison-panel"><summary>Provider comparison · {view.account.name}</summary>
    <p>Compare independent advisory results against one retained deterministic snapshot. Facts, primary analysis, ranks and workflow authority stay unchanged.</p>
    <p role="status">{reading ? "Loading comparison records..." : ready?.configured ? "Comparison configured; provider success and live authorization remain unverified." : "Comparison unavailable or unconfigured."}</p>
    <p>Current revision {view.account.revision}; snapshot {view.assessment.snapshot_hash}.</p>
    {ready?.pending_run_id && <p>Pending run {ready.pending_run_id} blocks new starts, including after worker loss. No recovery or retry operation is available.</p>}
    {ready?.next_start_at && <p>60-second account cooldown ends {ready.next_start_at}. Refresh records to check eligibility.</p>}
    {role === "viewer" && <p>Read only. Your current role cannot compare or discover providers.</p>}
    <p>Choose providers deliberately. Every mode defaults to mock; mock/disabled/unconfigured returns no model analysis. Live requires authorized service access and independent server gates. Models and credentials are managed on the server.</p>
    {catalog.map(entry => <fieldset key={entry.provider} disabled={disabled}><legend>{entry.provider}</legend>
      <p>{entry.status} · configuration revision {entry.configuration_revision} · requested model {entry.model || "Unconfigured"} · expected response model {entry.expected_response_model || "Unconfigured"}.</p>
      <label><input type="checkbox" checked={!!choices[entry.provider]} disabled={disabled || role === "viewer"}
        onChange={event => setChoices({ ...choices, [entry.provider]: event.target.checked })} />Include {entry.provider} in comparison</label>
      <label><input type="checkbox" checked={!!live[entry.provider]} disabled={disabled || role === "viewer" || !entry.live_configured}
        onChange={event => setLive({ ...live, [entry.provider]: event.target.checked })} />Use live {entry.provider} for the next explicit request</label>
      <button disabled={disabled || role !== "admin"} onClick={() => mutate(entry)}>Discover {entry.provider} models</button>
    </fieldset>)}
    <div className="source-actions"><button disabled={disabled || role === "viewer" || !ready?.can_start || !Object.values(choices).some(Boolean)}
      onClick={() => mutate()}>Compare selected providers</button><button disabled={busy} onClick={() => refresh()}>Refresh comparison records</button></div>
    {busy && <p role="status">Request in progress...</p>}{notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {discovery && <section aria-label="Model discovery"><h2>Model discovery</h2>
      <p>{discovery.provider} · requested {discovery.requested_mode} · returned {discovery.mode} · source {discovery.source} · configuration {discovery.configuration_revision} · observed {discovery.observed_at}.</p>
      <p>At most 100 IDs; {discovery.has_more ? "more models may exist; pagination was not followed" : "no further page reported"}. Discovery is separate from inference and compatibility validation.</p>
      {discovery.error_code && <p>{discovery.error_code}</p>}<ul>{discovery.models?.map(model => <li key={model}>{model}</li>)}</ul>
    </section>}
    <section aria-label="Comparison history"><h2>Comparison history</h2><p>Latest 20 saved runs. Reading never dispatches inference or renews dates or authority.</p>
      {!reading && !runs.length && <p>No saved comparisons.</p>}
      <ul>{runs.map(run => <li key={run.id}><button disabled={disabled} onClick={() => inspect(run.id)}>Inspect {run.id}</button>
        <span> · {run.status} · revision {run.account_revision} · {run.started_at}</span></li>)}</ul>
      <label>Older comparison run ID<input value={lookup} onChange={event => setLookup(event.target.value)} /></label>
      <button disabled={disabled || !lookup.trim()} onClick={() => inspect(lookup.trim())}>Inspect saved comparison ID</button>
      {selected && <ComparisonRecord run={selected} view={view} />}
    </section>
  </details>;
}

function ComparisonRecord({ run, view }: { run: ComparisonRun; view: AccountView }) {
  const baseline = run.snapshot.assessment;
  return <section aria-label="Saved comparison"><h3>Saved comparison</h3>
    <p>Run {run.id} · {run.status} · policy {run.policy_version} · original actor {run.actor_id}.</p>
    <p>Original revision {run.account_revision}; snapshot {run.snapshot_hash}. {run.account_revision !== view.account.revision
      || run.snapshot_hash !== view.assessment.snapshot_hash ? "Historical snapshot; differs from the current account." : "Snapshot matches the displayed account; this grants no renewed authority."}</p>
    <p>Started {run.started_at}; finished {run.finished_at || "Pending"}. Completed means processing finished; inspect every independent result.</p>
    {run.status === "pending" && <p>Pending is unresolved and blocks new starts. Viewing cannot recover or retry this run.</p>}
    {run.status === "discarded" && <p>Context or authority changed. Unpublished output was discarded.</p>}
    <h4>Retained deterministic baseline</h4>
    <p>{run.snapshot.account.name} · assessment as of {baseline.as_of} · health {baseline.health} · risk {baseline.risk} · opportunity {baseline.opportunity} · confidence {baseline.confidence}%.</p>
    <ul>{baseline.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul>
    <details><summary>Original facts, factors and evidence dates</summary><pre>{JSON.stringify({ account: run.snapshot.account, assessment: baseline, evidence: run.snapshot.evidence }, null, 2)}</pre></details>
    {run.results.map(result => <section key={result.id} aria-label={`${result.provider} result`}><h4>{result.provider}</h4>
      <p>Result {result.id} · requested {result.requested_mode} · returned {result.mode} / {result.status} · configuration {result.configuration_revision}.</p>
      <p>Requested model {result.model || "Unconfigured"}; expected response model {result.expected_response_model || "Unconfigured"}; actual response model {result.response_model || "Not returned"}.</p>
      <p>Validation {result.validation}; factual confidence {result.factual_confidence}. Schema and evidence-reference checks do not certify factual truth.</p>
      <p>Started {result.started_at || "Not started"}; finished {result.finished_at || "Pending"}; latency {result.latency_ms ?? "Not supplied"} ms; request {result.request_id || "Not supplied"}; input tokens {result.input_tokens ?? "Not supplied"}; output tokens {result.output_tokens ?? "Not supplied"}.</p>
      {result.error_code && <p>Server result: {result.error_code}</p>}
      {result.analysis ? <><h5>Advisory findings</h5><ul>{result.analysis.findings.map((finding, index) => <li key={index}>{finding.text} · evidence {finding.evidence_ids.join(", ")}</li>)}</ul>
        <h5>Proposed next steps</h5><ul>{result.analysis.next_steps.map((step, index) => <li key={index}>{step.text} · evidence {step.evidence_ids.join(", ")}</li>)}</ul>
        <ul>{result.analysis.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul></> : <p>No model analysis from this result.</p>}
    </section>)}
  </section>;
}
