"use client";

import { useEffect, useRef, useState } from "react";
import { app, authentication } from "@microsoft/teams-js";
import type { components } from "@/lib/api.generated";
import { savedRunId } from "@/lib/pipeline-history";

type Context = components["schemas"]["PlatformContext"];
type Proposal = components["schemas"]["PreparationProposal"];

export function TeamsPage({ initialAccount = "" }: { initialAccount?: string } = {}) {
  const [account, setAccount] = useState(savedRunId.test(initialAccount) ? initialAccount : ""), [result, setResult] = useState<Context | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [, refresh] = useState(0);
  const life = useRef({ alive: false, generation: 0, pending: false, controller: null as AbortController | null });
  const generation = life.current.generation;
  const current = () => life.current.alive && generation === life.current.generation;
  useEffect(() => {
    const state = life.current; state.alive = true;
    const clear = () => { state.generation++; state.controller?.abort(); state.pending = false; setResult(null); setProposal(null); setBusy(false); refresh(value => value + 1); };
    window.addEventListener("blur", clear);
    return () => { state.alive = false; clear(); window.removeEventListener("blur", clear); };
  }, []);
  async function request(prepare: boolean) {
    const state = life.current;
    if (!current() || state.pending || !savedRunId.test(account) || (prepare && !result)) return;
    state.pending = true; setBusy(true); setError(""); setProposal(null);
    const controller = new AbortController(); state.controller = controller;
    try {
      await app.initialize();
      if (!current() || controller.signal.aborted) return;
      const identity = await app.getContext();
      if (!current() || controller.signal.aborted) return;
      const tenant = identity.user?.tenant?.id, object = identity.user?.id;
      if (!tenant || !object || !savedRunId.test(tenant) || !savedRunId.test(object)) throw new Error("Identity unavailable");
      const token = await authentication.getAuthToken();
      if (!current() || controller.signal.aborted) return;
      const body = prepare ? { account_id: account, expected_snapshot_hash: result!.account.assessment.snapshot_hash,
        expected_account_revision: result!.account.account.revision }
        : { activity_id: crypto.randomUUID(), timestamp: new Date().toISOString(), tenant_id: tenant, object_id: object,
          account_id: account, type: "message", command: "context", conversation_type: "personal" };
      const response = await fetch(`/api/platform-gateway/${prepare ? "preparation" : "teams/activity"}`, {
        method: "POST", credentials: "omit", cache: "no-store", signal: controller.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("Platform unavailable");
      const value = await response.json();
      const context: Context = value.context;
      if (context.account.account.id !== account || context.approval_available !== false || context.execution_available !== false
        || context.workspace_url !== `${window.location.origin}/accounts?account=${account}`
        || (prepare && value.preparation_url !== `${window.location.origin}/missions?account=${account}`)
        || context.account.evidence.some(fact => fact.account_id !== account
          || fact.organization_id !== context.account.account.organization_id)) throw new Error("Context changed");
      if (!current() || controller.signal.aborted) return;
      setResult(context); if (prepare) setProposal(value);
    } catch { if (current() && !controller.signal.aborted) { setResult(null); setProposal(null);
      setError("Teams sign-in or mapped account access is unavailable. Ask your VitaAi administrator to check tenant configuration and membership, then retry."); } }
    finally { if (current() && state.controller === controller) { state.pending = false; setBusy(false); } }
  }
  return <main style={{ padding: 24, overflowWrap: "anywhere" }}><h1>VitaAi in Teams</h1>
    <p>Read sourced account status and review preparation proposals. Exact action approval takes place in VitaAi.</p>
    <label>Accessible VitaAi account ID <input value={account} disabled={busy} onChange={event => {
      if (life.current.pending || !current()) return;
      life.current.generation++; life.current.controller?.abort(); setAccount(event.target.value); setResult(null); setProposal(null); setError("");
    }} /></label>
    <button disabled={busy || !savedRunId.test(account)} onClick={() => request(false)}>Sign in and inspect account</button>
    {busy && <p role="status">Reading authorized Teams account context…</p>}{error && <p role="alert">{error}</p>}
    {result && <section aria-label="Sourced account status"><h2>{result.account.account.name}</h2>
      <p>Risk {result.account.assessment.risk}/100 · Opportunity {result.account.assessment.opportunity}/100 · Assessment {result.account.assessment.as_of}</p>
      <p>Snapshot {result.account.assessment.snapshot_hash}</p><ul>{result.account.evidence.map(fact => <li key={fact.id}>
        {fact.fact} · {fact.source} · {fact.observed_at} · evidence {fact.id}{fact.synthetic && " · Synthetic"}</li>)}</ul>
      <ul>{[...result.caveats, ...result.account.assessment.caveats].map((caveat, index) => <li key={index}>{caveat}</li>)}</ul>
      <button disabled={busy} onClick={() => request(true)}>Inspect preparation proposal</button>
      <a href={result.workspace_url} target="_blank" rel="noopener noreferrer" onClick={event => { if (!current()) event.preventDefault(); }}>Open exact account in VitaAi</a>
    </section>}
    {proposal && <section aria-label="Preparation proposal"><h2>{proposal.action_kind}</h2><p>{proposal.rationale}</p>
      <p>{proposal.allowed ? "Preparation can be reviewed in VitaAi." : "Review evidence or continue monitoring before outreach."}</p>
      <ul>{proposal.caveats.map((value, index) => <li key={index}>{value}</li>)}</ul>
      <a href={proposal.preparation_url} target="_blank" rel="noopener noreferrer" onClick={event => { if (!current()) event.preventDefault(); }}>Open governed preparation</a></section>}
  </main>;
}
