"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, type AccountView, type ModelRun, type Portfolio, type ProviderStatus } from "@/lib/api";
import { currentDecision, kindLabel, postWorkflow, readMission, steps, type Action, type Decision,
  type Mission, type MissionData, type OutcomeRequest, type Payload, type Plan, type PlanRequest, type Step } from "@/lib/workflow";
import { useSession } from "./session-gate";
import type { components } from "@/lib/api.generated";

function useOperation() {
  const controller = useRef<AbortController | null>(null);
  const locked = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const pending = new AbortController();
    controller.current = pending;
    return () => pending.abort();
  }, []);
  async function run(work: (signal: AbortSignal) => Promise<void>) {
    if (locked.current || !controller.current || error) return;
    const signal = controller.current.signal;
    locked.current = true;
    setBusy(true);
    try { await work(signal); }
    catch (error) {
      if (!signal.aborted) setError(`${error instanceof Error ? error.message : "Request failed."} Refresh current state before another write. A lost response may still have saved the request.`);
    } finally {
      locked.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }
  return { run, busy, error, blocked: busy || error !== null };
}

export function MissionWorkspace() {
  const session = useSession();
  if (session?.mode !== "session" || !session.actor) return <main className="entry">
    <Link href="/?persona=seller">← Workspace</Link><h1>Governed missions</h1>
    <p>Missions require a server configured for session identity. This sample workspace has no review authority.</p>
  </main>;
  return <MissionDirectory key={`${session.actor.id}:${session.actor.organization_id}:${session.actor.role}`} />;
}

type Directory = { portfolio: Portfolio; missions: Mission[]; provider: ProviderStatus; generation: number };
function MicrosoftConnection({ invalidate, changed, blocked = false }: { invalidate: () => void; changed: (message?: string) => void; blocked?: boolean }) {
  const actor = useSession()?.actor;
  const [status, setStatus] = useState<components["schemas"]["MicrosoftStatus"] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  const op = useOperation();
  useEffect(() => {
    const controller = new AbortController();
    api<components["schemas"]["MicrosoftStatus"]>("integrations/microsoft", { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setStatus(value); })
      .catch(() => { if (!controller.signal.aborted) setError("Microsoft status unavailable. Refresh current state."); });
    return () => controller.abort();
  }, []);
  const sameHost = !!status && status.connection_origin === window.location.origin;
  function change(action: "connect" | "signout" | "refresh") {
    if (started.current || blocked || op.blocked || !status || (action === "connect"
      && (!sameHost || !status.configured || actor?.role === "viewer"))) return;
    if (action === "refresh" && (!status.can_refresh || !status.refresh_binding_id || actor?.role === "viewer")) return;
    started.current = true;
    invalidate();
    void op.run(async signal => {
      let message: string | undefined;
      try {
        const result = await postWorkflow<components["schemas"]["MicrosoftStart"] | components["schemas"]["MicrosoftStatus"]>(
          `integrations/microsoft/${action}`, action === "refresh" ? { binding_id: status.refresh_binding_id } : {}, signal);
        if (!signal.aborted && action === "connect" && "authorization_url" in result) {
          const url = new URL(result.authorization_url);
          if (url.protocol !== "https:" || url.hostname !== "login.microsoftonline.com" || url.port || url.username || url.password) {
            throw new Error("Microsoft authorization URL is unavailable.");
          }
          window.location.assign(url.href);
        }
      } catch {
        message = "Microsoft connection request may have committed. Refresh current records before another operation.";
      } finally {
        if (!signal.aborted) changed(message);
        else window.dispatchEvent(new Event("vitaai-microsoft-changed"));
      }
    });
  }
  return <section aria-label="Microsoft connection" className="mission-step"><h2>Microsoft connection</h2>
    <p>Creates unsent Outlook drafts after exact approval. Email sending is unavailable. Connection status grants no execution authority.</p>
    {error && <p role="alert">{error}</p>}
    {!status ? <p role="status">Loading connection status...</p> : <>
      <p>{status.configured ? "Configured" : "Unconfigured"} · {status.connected ? "Connected" : "Disconnected or expired"} · Draft writes {status.write_configured ? "configured" : "disabled"}</p>
      {status.connected && <p>Mailbox {status.mailbox_id} · binding {status.binding_id} · expires {new Date(status.expires_at! * 1000).toISOString()}</p>}
      {!sameHost && <p>To connect, sign in at <a href={`${status.connection_origin}/missions`}>{status.connection_origin}</a> so the callback uses the same host.</p>}
      <p>Reconnect invalidates existing write previews. Prepare and review again before writing; same-mailbox reauthorization supports retained-ID readback only.</p>
      {status.refresh_binding_id && <>
        <p>Refresh renews this mailbox connection and invalidates old write previews. Prepare and review again before writes.</p>
        {status.refresh_pending && <p role="status">Refresh is pending. Refresh current records; if the worker was interrupted, reconnect explicitly.</p>}
        <button disabled={blocked || op.blocked || !status.can_refresh || actor?.role === "viewer"} onClick={() => change("refresh")}>Refresh Microsoft connection</button>
      </>}
      <button disabled={blocked || op.blocked || !status.configured || !sameHost || actor?.role === "viewer"} onClick={() => change("connect")}>{status.connected ? "Reconnect Microsoft" : "Connect Microsoft"}</button>
      <button disabled={blocked || op.blocked} onClick={() => change("signout")}>Sign out Microsoft</button>
    </>}
  </section>;
}

function MissionDirectory() {
  const params = useSearchParams();
  const router = useRouter();
  const [generation, setGeneration] = useState(0);
  const [loaded, setLoaded] = useState<Directory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connectionBusy, setConnectionBusy] = useState(false);
  useEffect(() => {
    const refresh = () => setGeneration(value => value + 1);
    const microsoftFinished = () => { setConnectionBusy(false); refresh(); };
    window.addEventListener("vitaai-source-changed", refresh);
    window.addEventListener("vitaai-workflow-changed", refresh);
    window.addEventListener("vitaai-microsoft-changed", microsoftFinished);
    window.addEventListener("focus", refresh);
    return () => { window.removeEventListener("vitaai-source-changed", refresh); window.removeEventListener("vitaai-workflow-changed", refresh); window.removeEventListener("vitaai-microsoft-changed", microsoftFinished); window.removeEventListener("focus", refresh); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api<Portfolio>("portfolio", { signal: controller.signal }),
      api<Mission[]>("missions", { signal: controller.signal }),
      api<ProviderStatus>("providers/nebius", { signal: controller.signal })])
      .then(([portfolio, missions, provider]) => {
        if (!controller.signal.aborted) { setLoaded({ portfolio, missions, provider, generation }); setError(null); }
      }).catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Missions unavailable."); });
    return () => controller.abort();
  }, [generation]);
  const selectedId = params.get("mission");
  const requestedAccount = params.get("account");
  const selected = loaded?.missions.find(item => item.id === selectedId);
  const accountId = requestedAccount || selected?.account_id || loaded?.portfolio.accounts[0]?.account.id;
  const account = loaded?.portfolio.accounts.find(item => item.account.id === accountId);
  const current = loaded?.generation === generation && !connectionBusy;
  function refresh(message?: string) { setError(null); setNotice(message || null); setGeneration(value => value + 1); }
  function select(accountId: string, mission?: string) {
    const next = new URLSearchParams({ account: accountId });
    if (mission) next.set("mission", mission);
    router.replace(`/missions?${next}`, { scroll: false });
  }
  return <main className="mission-shell">
    <header className="mission-heading"><div><Link href={`/?persona=seller${account ? `&account=${account.account.id}` : ""}`}>← Portfolio</Link>
      <h1>Governed missions</h1><p className="muted">Evidence → reviewed action → recorded follow-up</p></div>
      <button onClick={() => refresh()}>Refresh current state</button></header>
    <p className="mission-disclosure">Preparation defaults to simulation. Live work requires server configuration, explicit selection and exact authenticated approval. Outlook creates unsent drafts only. Provider creation does not establish a business outcome.</p>
    <MicrosoftConnection key={generation} blocked={connectionBusy} invalidate={() => setConnectionBusy(true)} changed={message => { setConnectionBusy(false); refresh(message); }} />
    {notice && <p role="status">{notice}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {!current ? <p role="status">Loading current missions...</p> : <div className="mission-layout">
      <aside className="mission-directory"><label>Account<select aria-label="Account" value={accountId || ""} onChange={event => select(event.target.value)}>
        {loaded.portfolio.accounts.map(item => <option key={item.account.id} value={item.account.id}>{item.account.name}</option>)}</select></label>
        {!account && <p role="alert">Account unavailable in this workspace.</p>}
        <h2>Resume work</h2><nav aria-label="Saved missions">
          {loaded.missions.filter(item => item.account_id === accountId && !["completed", "superseded"].includes(item.status)).map(item => <button key={item.id}
            aria-current={item.id === selectedId ? "page" : undefined} onClick={() => select(item.account_id, item.id)}>
            {item.template.replaceAll("account-", "")}<small>{item.status.replaceAll("_", " ")} · {item.id.slice(0, 8)}</small></button>)}
        </nav>
        {account && <button onClick={() => select(account.account.id)}>Plan a new mission</button>}
        <details><summary>Completed and replaced missions</summary><nav aria-label="Mission history">
          {loaded.missions.filter(item => item.account_id === accountId && ["completed", "superseded"].includes(item.status)).map(item => <button key={item.id}
            onClick={() => select(item.account_id, item.id)}>{item.template} · {item.status} · {item.id.slice(0, 8)}</button>)}
        </nav></details>
      </aside>
      <section className="mission-main" aria-label="Mission workspace">
        {selectedId ? (!selected || selected.account_id !== accountId ? <p role="alert">Mission unavailable for this account. Select a saved mission.</p>
          : <MissionLoader key={`${selected.id}:${generation}`} id={selected.id} configured={loaded.provider.configured} refresh={refresh} />)
          : account && <NewMission key={`${accountId}:${generation}`} account={account} configured={loaded.provider.configured}
            onCreated={mission => { select(mission.account_id, mission.id); refresh(); }} />}
      </section>
    </div>}
  </main>;
}

function NewMission({ account, configured, onCreated, replaces }: {
  account: AccountView; configured: boolean; onCreated: (mission: Mission) => void; replaces?: Mission;
}) {
  const actor = useSession()?.actor;
  const op = useOperation();
  const [intent, setIntent] = useState<PlanRequest["intent"]>("attention");
  const [kind, setKind] = useState<Payload["kind"]>(replaces?.allowed_kinds[0] || "hubspot_task_create");
  const [followUp, setFollowUp] = useState(replaces ? replaces.template === "account-follow-up-1" : true);
  const [model, setModel] = useState(false);
  const [plan, setPlan] = useState<Plan | null>(null);
  const [run, setRun] = useState<ModelRun | null>(null);
  const [alternative, setAlternative] = useState("");
  const writer = actor?.role !== "viewer";
  function createPlan(event: FormEvent) {
    event.preventDefault();
    void op.run(async signal => {
      const body: PlanRequest = { schema_version: "1", account_id: account.account.id,
        expected_revision: account.account.revision, expected_snapshot_hash: account.assessment.snapshot_hash,
        intent, action_kind: followUp ? "hubspot_task_create" : kind, strategy: followUp ? "follow_up" : "single_action" };
      if (model) {
        const generated = await postWorkflow<ModelRun>("plans/generate", body, signal);
        if (signal.aborted) return;
        setRun(generated);
        if (generated.status !== "succeeded" || !generated.planning) return;
        body.model_run_id = generated.id;
      }
      const proposal = await postWorkflow<Plan>("plans", body, signal);
      if (!signal.aborted) { setPlan(proposal); setAlternative(proposal.selected_alternative_id); }
    });
  }
  return <><h2>Plan for {account.account.name}</h2><p>Account revision {account.account.revision}. Templates use the current assessment; model proposals remain advisory.</p>
    {!writer && <p>Your viewer role can inspect missions. A seller, reviewer or admin must prepare work.</p>}
    <form onSubmit={createPlan} className="mission-form"><fieldset disabled={op.blocked || !!plan || !writer}>
      <label>Focus<select aria-label="Focus" value={intent} onChange={event => setIntent(event.target.value as PlanRequest["intent"])}>
        {["attention", "risk", "growth", "renewal", "manual_review", "monitor"].map(item => <option key={item}>{item}</option>)}</select></label>
      <label><input type="checkbox" checked={followUp} disabled={!!replaces} onChange={event => setFollowUp(event.target.checked)} /> Two-step follow-up alternatives</label>
      {!followUp && <label>Action<select aria-label="Action" value={kind} disabled={!!replaces} onChange={event => setKind(event.target.value as Payload["kind"])}>
        {(["hubspot_task_create", "hubspot_note_create", "outlook_draft_create"] as const).map(item => <option key={item} value={item}>{kindLabel(item)}</option>)}</select></label>}
      <label><input type="checkbox" checked={model} disabled={!configured} onChange={event => setModel(event.target.checked)} /> Use Nebius (one paid planning call)</label>
      <button type="submit">{op.busy ? "Planning..." : "Create plan"}</button>
    </fieldset></form>
    {op.error && <p role="alert" className="error-banner">{op.error}</p>}
    {run && <p role="status">Planning run {run.id}: {run.status} · {run.validation} {run.error_code || ""}</p>}
    {plan && <><p>Saved plan ID: {plan.id} · revision {plan.revision}.{!replaces && " Copy this ID to select a saved source event before starting a mission here."}</p>
      <p>Source: {plan.source} · validation: {plan.validation}</p><p>{plan.caveats.join(" ")}</p>
      <fieldset disabled={op.blocked}><legend>Select an alternative</legend>{plan.alternatives.map(item => <label className="mission-choice" key={item.id}>
        <input type="radio" name="alternative" checked={alternative === item.id} onChange={() => setAlternative(item.id)} />
        <span>{item.rationale}<small>{item.steps.map(step => kindLabel(step.kind)).join(" → ")}</small><small>{item.risks.join(" ")}</small></span>
      </label>)}</fieldset>
      <button disabled={op.blocked} onClick={() => void op.run(async signal => {
        const template = followUp ? "account-follow-up-1" : kind === "hubspot_note_create" ? "account-note-1"
          : kind === "outlook_draft_create" ? "account-outlook-draft-1" : "account-action-1";
        const mission = replaces
          ? await postWorkflow<Mission>(`missions/${replaces.id}/supersede`, { expected_revision: replaces.revision,
            plan_id: plan.id, expected_plan_revision: plan.revision, alternative_id: alternative }, signal)
          : await postWorkflow<Mission>("missions", { plan_id: plan.id, expected_revision: plan.revision,
            template, alternative_id: alternative }, signal);
        if (!signal.aborted) onCreated(mission);
      })}>{replaces ? "Replace stale mission with selected plan" : "Start selected mission"}</button></>}
  </>;
}

function MissionLoader({ id, configured, refresh }: { id: string; configured: boolean; refresh: (message?: string) => void }) {
  const [data, setData] = useState<MissionData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    readMission(id, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Mission unavailable."); });
    return () => controller.abort();
  }, [id]);
  if (error) return <p role="alert" className="error-banner">{error}</p>;
  if (!data) return <p role="status">Loading mission records...</p>;
  return <MissionPanels data={data} configured={configured} refresh={refresh} />;
}

function ExactPreview({ action }: { action: Action }) {
  const payload = action.payload;
  return <div className="exact-preview"><h4>Saved exact preview · revision {action.revision}</h4>
    {payload.kind === "hubspot_task_create" && <><pre>{payload.title}</pre><p>Due: {payload.due_at || "Not set"}</p><pre>{payload.body}</pre></>}
    {payload.kind === "hubspot_note_create" && <pre>{payload.body}</pre>}
    {payload.kind === "outlook_draft_create" && <><p>To: {payload.to.join(", ")}</p><pre>{payload.subject}</pre><pre>{payload.body_text}</pre></>}
    {action.provider_request && <details><summary>Exact provider request · {action.mode}</summary><pre>{action.provider_request}</pre></details>}
    <details><summary>Exact binding and destination</summary><dl><dt>Binding hash</dt><dd>{action.binding_hash}</dd>
      <dt>Payload hash</dt><dd>{action.payload_hash}</dd><dt>Mode / policy</dt><dd>{action.mode} / {action.policy_version}</dd>
      <dt>Destination</dt><dd><pre>{JSON.stringify(action.destination, null, 2)}</pre></dd>
      <dt>Mission content revision</dt><dd>{action.mission_revision}</dd></dl></details>
  </div>;
}

function MissionSourceProvenance({ selection, account }: { selection: NonNullable<MissionData["sourceSelection"]>; account: AccountView }) {
  const { detection, request } = selection;
  const matches = request.expected_account_revision === account.account.revision && request.expected_source_id === account.source?.id;
  return <details className="mission-step mission-provenance"><summary>Original saved source event</summary><h3>Historical source selection</h3>
    <p>Selection {selection.id}; original actor {selection.actor_id}; selected {selection.created_at}; policy {selection.policy_version}.</p>
    <p>{matches ? "Original source matches the displayed selection." : "Original source or account revision differs from the displayed current selection."} No renewed approval or execution authority. Readiness, review and execution use fresh server checks.</p>
    <p>Original plan {request.plan_id} revision {request.expected_revision}; template {request.template}; alternative {request.alternative_id || "original plan default"}.</p>
    <p>Detection {detection.id}; original detector {detection.actor_id}; detected {detection.detected_at}. Event {request.event_id}; fingerprint {detection.event?.fingerprint}.</p>
    {[detection.before, detection.after].map((snapshot, index) => snapshot && <section key={index} aria-label={`${index ? "After" : "Before"} original source`}>
      <h4>{index ? "After" : "Before"} original source</h4>
      <p>{snapshot.kind}; source {snapshot.source_version_id}; account revision {snapshot.account_revision}; selected {snapshot.selected_at}.</p>
      <p>Observation {snapshot.observation_id || "none"}; portal {snapshot.portal_id || "none"}; company {snapshot.company_id || "none"}; mapping {snapshot.mapping_hash || "none"}.</p>
      <p>Provider created {snapshot.provider_created_at || "Unknown"}; updated {snapshot.provider_updated_at || "Unknown"}; fetched {snapshot.fetched_at || "Unknown"}.</p>
    </section>)}
    <ul>{detection.event?.changes.map(change => <li key={change.field}>{change.field.replaceAll("_", " ")} · {change.kind.replaceAll("_", " ")}
      {[change.before, change.after].map((field, index) => <p key={index}>{index ? "After" : "Before"}: {field.value === null ? "Unknown" : String(field.value)} · {field.status} · {field.unit}; measured {field.observed_at || "Unknown"}; evidence {field.evidence_id || "none"}.</p>)}</li>)}</ul>
    <p>These retained changes do not establish a cause, risk direction or business outcome.</p>
  </details>;
}

function MissionPanels({ data, configured, refresh }: { data: MissionData; configured: boolean; refresh: (message?: string) => void }) {
  const { mission, plan, account, actions, decisions, executions, receipts, audit } = data;
  const params = useSearchParams();
  const router = useRouter();
  const actor = useSession()?.actor;
  const op = useOperation();
  const mutationStarted = useRef(false);
  const requestedStep = params.get("step");
  const step = steps.find(item => item === requestedStep) || mission.current_step;
  const choice = plan.alternatives.find(item => item.id === (mission.alternative_id || plan.selected_alternative_id))!;
  const stale = account.account.revision !== mission.evidence.account_revision || account.assessment.snapshot_hash !== mission.evidence.snapshot_hash;
  const writer = !!actor && actor.role !== "viewer";
  const reviewer = actor?.role === "admin" || actor?.role === "reviewer";
  const superseded = mission.status === "superseded";
  const frozen = executions.length > 0 || mission.status === "completed" || superseded;
  const disabled = op.blocked || !writer || stale || superseded;
  const readiness = data.readiness;
  const live = actions.some(action => action.mode === "live");
  const mixed = new Set(actions.map(action => action.mode)).size > 1;
  const destinationMatches = (action: Action) => !!readiness?.destination && Object.entries(action.destination)
    .every(([key, value]) => readiness.destination?.[key as keyof typeof readiness.destination] === value);
  const microsoftFor = (action: Action) => data.microsoft?.actions.find(record => record.action_id === action.id
    && record.action_revision === action.revision && record.binding_hash === action.binding_hash);
  const canWrite = (action: Action) => action.destination.provider === "microsoft" ? !!microsoftFor(action)?.can_write
    : !!readiness?.can_prepare && destinationMatches(action);
  const canReconcile = (action: Action) => action.destination.provider === "microsoft" ? !!microsoftFor(action)?.can_reconcile
    : !!readiness?.can_reconcile && destinationMatches(action);
  if (live && actions.some(action => action.mode === "live" && (!action.provider_request
    || (action.payload?.kind === "outlook_draft_create" ? action.destination?.connector_id !== "microsoft-live" || !data.microsoft
      : !readiness || action.destination?.connector_id !== "hubspot-live")))) return <section aria-label="Live mission read-only">
    <h2>{account.account.name} · live API mission</h2>
    {mission.source_detection_id && !data.sourceSelection && <p role="status">Original source provenance unavailable. Refresh records or check source access. Retained mission records remain subject to their separate authority checks.</p>}
    {data.sourceSelection && <MissionSourceProvenance selection={data.sourceSelection} account={account} />}
    <p>Live controls are unavailable for these records. Refresh current readiness or inspect the authenticated API; saved records remain authoritative.</p>
    <h3>Saved actions</h3>
    {actions.map(action => <ExactPreview key={action.id} action={action} />)}
    <details><summary>Recorded decisions, execution and history</summary>
      <pre>{JSON.stringify({ mission, decisions, executions, receipts, outcomes: data.outcomes, audit }, null, 2)}</pre>
    </details>
  </section>;
  async function mutate(path: string, body: object) {
    if (mutationStarted.current) return;
    mutationStarted.current = true; // Only a refreshed, remounted server snapshot may mutate again.
    await op.run(async signal => {
      let message: string | undefined;
      try { await postWorkflow(path, body, signal); }
      catch (error) { message = `${error instanceof Error ? error.message : "Request failed."} The request may have committed. Current authority must reload before another write.`; }
      finally {
        if (!signal.aborted) refresh(message);
        else window.dispatchEvent(new Event("vitaai-workflow-changed"));
      }
    });
  }
  const actionFor = (item: Step) => actions.find(action => action.step_id === item.id || (choice.steps.length === 1 && action.step_id == null));
  return <><div className="mission-heading"><div><h2>{account.account.name}</h2><p>{mission.status.replaceAll("_", " ")} · revision {mission.revision}</p></div>
    <span className="mission-id">{mission.id}</span></div>
    <p className="muted">Server step: {mission.current_step}. Viewing a step does not advance this mission.</p>
    {mission.source_detection_id && !data.sourceSelection && <p role="status">Original source provenance unavailable. Refresh records or check source access. Retained mission records remain subject to their separate authority checks.</p>}
    {data.sourceSelection && <MissionSourceProvenance selection={data.sourceSelection} account={account} />}
    <p>HubSpot writes: {readiness?.write_configured ? "Configured, unverified" : "Unavailable"}. Readback: {readiness?.readback_configured ? "Configured, unverified" : "Unavailable"}. Configuration is not connectivity or execution evidence.</p>
    {choice.steps.some(item => item.kind === "outlook_draft_create") && <p>Microsoft preparation: {data.microsoft?.can_prepare ? "Available for your connected mailbox" : "Unavailable; connect your mailbox or check server configuration"}. Saved drafts retain the original maker mailbox. Reconnect invalidates old write previews; same-mailbox reauthorization permits retained-ID readback only.</p>}
    {mixed && <p role="alert">Mixed simulation/live actions cannot execute together. Before any claim, save every selected step in the same mode and obtain fresh review.</p>}
    {mission.supersedes_id && <p>Replaces <Link href={`/missions?account=${mission.account_id}&mission=${mission.supersedes_id}`}>the previous mission</Link>. Prepare and review new actions before execution.</p>}
    {mission.superseded_by_id && <p>This mission is preserved as history. <Link href={`/missions?account=${mission.account_id}&mission=${mission.superseded_by_id}`}>Open its replacement</Link>.</p>}
    {stale && <p role="alert" className="error-banner">The account snapshot changed. This mission cannot use the old evidence for new actions.</p>}
    {stale && !superseded && mission.status !== "completed" && <details><summary>Recover stale mission</summary>
      {executions.length ? <p>Replacement is blocked because this mission has execution claims. Preserve its receipts and reconcile uncertain work; do not recreate executed steps.</p>
        : <><p>Choose a current plan to replace this mission. Old plans, drafts and decisions remain in history. New actions need preparation and fresh review; source dates are preserved.</p>
          <NewMission account={account} configured={configured} replaces={mission} onCreated={replacement => {
            router.replace(`/missions?${new URLSearchParams({ account: replacement.account_id, mission: replacement.id })}`, { scroll: false });
            refresh();
          }} /></>}
    </details>}
    <nav className="mission-steps" aria-label="Mission steps">{steps.map((item, index) => <button key={item} aria-current={step === item ? "step" : undefined}
      disabled={op.busy} onClick={() => { const next = new URLSearchParams(params); next.set("step", item); router.replace(`/missions?${next}`, { scroll: false }); }}>
      <span>{index + 1}</span>{item}</button>)}</nav>
    {op.error && <p role="alert" className="error-banner">{op.error}</p>}
    {op.busy && <p role="status">Saving server records...</p>}
    <section className="mission-step" aria-label={`${step} step`}><h3>{step}</h3>
      {step === "Review" && <><p>{choice.rationale}</p><p>Plan: {plan.source} · {plan.validation} · {plan.id}</p>
        {plan.model_run_id && <p>Model planning run: {plan.model_run_id}</p>}<p>{[...choice.risks, ...plan.caveats].join(" ")}</p>
        <ol>{choice.steps.map(item => <li key={item.id}><strong>{kindLabel(item.kind)}</strong><pre>{item.content}</pre>
          <p>Evidence: {item.evidence_ids.join(", ")}</p><p>Depends on: {item.dependencies?.map(id => kindLabel(choice.steps.find(s => s.id === id)!.kind)).join(", ") || "None"}</p></li>)}</ol></>}
      {step === "Evidence" && <><p>Bound assessment: {mission.evidence.as_of}. Account revision {mission.evidence.account_revision}.</p>
        <p className="mission-id">Snapshot: {mission.evidence.snapshot_hash}</p><ul className="mission-evidence">{mission.evidence.evidence_ids.map(id => {
          const evidence = account.evidence.find(item => item.id === id);
          return <li key={id}>{evidence ? <><strong>{evidence.fact}</strong><p>{evidence.source} / {evidence.source_record}</p>
            <p>Observed {evidence.observed_at} · {evidence.synthetic ? "Synthetic" : "Source observation"}</p></> : <p>Evidence {id} is no longer available in the current account snapshot.</p>}<small>{id}</small></li>;
        })}</ul></>}
      {(step === "Outreach" || step === "CRM Note") && <>
        <p>Save all selected steps before submitting. Saving an edit invalidates every related review. Unsaved input is local to this form.</p>
        {choice.steps.filter(item => step === "CRM Note" ? item.kind === "hubspot_note_create" : item.kind !== "hubspot_note_create")
          .map(item => <ActionEditor key={`${item.id}:${actionFor(item)?.revision || 0}`} item={item} action={actionFor(item)} disabled={disabled || frozen}
            liveAvailable={item.kind === "outlook_draft_create" ? !!data.microsoft?.can_prepare : !!readiness?.can_prepare} save={(payload, mode) => mutate(`missions/${mission.id}/prepare`, { expected_revision: mission.revision,
              alternative_id: choice.id, step_id: item.id, mode, connector_id: mode === "live" ? item.kind === "outlook_draft_create" ? "microsoft-live" : "hubspot-live"
                : item.kind === "outlook_draft_create" ? "simulation-microsoft" : "simulation-hubspot", payload })} />)}
        {!choice.steps.some(item => step === "CRM Note" ? item.kind === "hubspot_note_create" : item.kind !== "hubspot_note_create") && <p>This alternative has no action in this step.</p>}
        {frozen && <p>Content is frozen after the first execution claim or mission completion.</p>}
      </>}
      {step === "Approval" && <><p>Review applies only to the displayed saved revision and destination. Current authority and reviewer session are checked again at execution.</p>
        {actions.length !== choice.steps.length && <p>Prepare every selected action before submitting for review.</p>}
        {actions.map(action => {
          const decision = currentDecision(action, decisions);
          const reviewBlocked = mission.status === "completed" || executions.some(item => item.action_id === action.id)
            || executions.some(item => item.status !== "succeeded")
            || (action.mode === "live" && !canWrite(action));
          return <article className="mission-action" key={action.id}><h4>{kindLabel(action.payload.kind)} · {action.status}</h4><ExactPreview action={action} />
            {decision ? <p>Recorded {decision.decision.replaceAll("_", " ")} by {decision.reviewer_id}. Expires {decision.expires_at}. {decision.reason}</p>
              : action.status === "submitted" ? <ReviewForm disabled={disabled || !reviewer || reviewBlocked} submit={(decision, reason) => mutate(`actions/${action.id}/review`, {
                expected_revision: action.revision, binding_hash: action.binding_hash, decision, ...(reason ? { reason } : {}) })} />
                : <button disabled={disabled || frozen || reviewBlocked || actions.length !== choice.steps.length} onClick={() => void mutate(`actions/${action.id}/submit`, {
                  expected_revision: action.revision, binding_hash: action.binding_hash })}>Submit saved {kindLabel(action.payload.kind)} for review</button>}
            {decision?.decision === "approved" && !reviewBlocked && <>
              <p>Fresh review invalidates this approval and requires a new decision on the unchanged saved content. Use it after approval expiry or reviewer sign-out.</p>
              <button disabled={disabled} onClick={() => void mutate(`actions/${action.id}/renew-review`, {
                expected_revision: action.revision, binding_hash: action.binding_hash })}>Request fresh review for {kindLabel(action.payload.kind)}</button>
            </>}
            {!reviewer && <p>Only a current admin or reviewer can decide a submitted revision.</p>}
          </article>;
        })}
        <details><summary>All recorded review decisions</summary>{decisions.map(item => <p key={item.id}>
          Action {item.action_id} · revision {item.action_revision} · {item.decision} · {item.decided_at} · {item.reason || "No reason supplied"}</p>)}</details>
      </>}
      {step === "Execution" && <><p>Execution uses the saved mode, payload, destination and approval. Live execution creates a HubSpot record or unsent Outlook draft; simulation creates a local resource. Refreshing never dispatches.</p>
        {choice.steps.map(item => {
          const action = actionFor(item);
          if (!action) return <p key={item.id}>{kindLabel(item.kind)} has no saved action.</p>;
          const execution = executions.find(record => record.action_id === action.id);
          const decision = currentDecision(action, decisions);
          const dependenciesReady = (item.dependencies || []).every(id => {
            const predecessor = choice.steps.find(s => s.id === id)!;
            const predecessorAction = actionFor(predecessor);
            return receipts.some(record => record.action_id === predecessorAction?.id && record.mode === action.mode && record.result === "succeeded" && record.verification === "verified");
          });
          const allApproved = actions.length === choice.steps.length && actions.every(a => {
            const approval = currentDecision(a, decisions);
            return executions.some(e => e.action_id === a.id && e.status === "succeeded") || (approval?.decision === "approved" && Date.parse(approval.expires_at) > Date.now()
              && (a.mode !== "live" || canWrite(a)));
          });
          const dispatchBlocked = disabled || mixed || (action.mode === "live" && !canWrite(action));
          return <article className="mission-action" key={item.id}><h4>{kindLabel(item.kind)} · {action.mode}</h4><ExactPreview action={action} />
            {execution ? <><p>Execution {execution.id}: <strong>{execution.status}</strong> · attempt {execution.attempt}</p>
              {execution.status === "result_unknown" && <p role="status">Result unknown. The claim is retained; do not repeat this write.</p>}
              {!["succeeded", "failed"].includes(execution.status) && <button disabled={op.blocked || !reviewer || superseded || mission.status === "completed"
                || (action.mode === "live" && execution.status !== "claimed" && !canReconcile(action))}
                onClick={() => void mutate(`executions/${execution.id}/reconcile`, { expected_revision: execution.revision })}>Reconcile recorded execution</button>}
              {!["succeeded", "failed"].includes(execution.status) && !reviewer && <p>A current reviewer or admin must reconcile this result.</p>}
              {execution.status === "failed" && <button disabled={dispatchBlocked || mission.status === "completed" || !allApproved || !dependenciesReady}
                onClick={() => void mutate(`executions/${execution.id}/retry`, { expected_revision: execution.revision,
                  decision_id: execution.decision_id, idempotency_key: execution.idempotency_key })}>Retry definite failure with retained claim</button>}
            </> : <><button disabled={dispatchBlocked || mission.status === "completed" || !allApproved || !dependenciesReady || decision?.decision !== "approved"}
              onClick={() => void mutate(`actions/${action.id}/execute`, { expected_revision: action.revision, decision_id: decision!.id,
                idempotency_key: `mission-action:${action.id}` })}>Execute {action.mode === "live" ? "live" : "simulated"} {kindLabel(item.kind)}</button>
              {!dependenciesReady && <p>Waiting for a verified prerequisite receipt.</p>}</>}
            {receipts.filter(record => record.action_id === action.id).map(record => <details key={record.id} open><summary>Receipt · {record.result} · {record.verification}</summary>
              <dl><dt>Mode / resource</dt><dd>{record.mode} / {record.provider_resource_id || "No resource verified"}</dd>
                <dt>Readback</dt><dd>{record.readback_at || "Unavailable"} / {record.readback_hash || record.error_code || "Not verified"}</dd>
                <dt>Receipt ID</dt><dd>{record.id}</dd></dl></details>)}
          </article>;
        })}</>}
      {step === "Outcome" && <OutcomeForm data={data} disabled={op.blocked || !writer || superseded} save={body => mutate(`missions/${mission.id}/outcomes`, body)} />}
    </section>
    <details className="mission-audit"><summary>Audit trail · {audit.length} events</summary><ol>{audit.map(event => <li key={event.id}>
      {event.sequence}. {event.event_kind} · {event.previous_state || "Created"} → {event.new_state}<br /><small>{event.created_at} / actor {event.actor_id} / entity {event.entity_id}</small>
    </li>)}</ol></details>
    {mission.status === "completed" && <p>This mission has a recorded outcome. Choose another unfinished mission in Resume work, or plan a new mission.</p>}
  </>;
}

function ActionEditor({ item, action, disabled, liveAvailable, save }: {
  item: Step; action?: Action; disabled: boolean; liveAvailable: boolean; save: (payload: Payload, mode: Action["mode"]) => Promise<void>;
}) {
  const payload = action?.payload;
  const [mode, setMode] = useState<Action["mode"]>(action?.mode || "simulation");
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState(payload?.kind === "hubspot_task_create" ? payload.title : payload?.kind === "outlook_draft_create" ? payload.subject : "");
  const [body, setBody] = useState(payload?.kind === "outlook_draft_create" ? payload.body_text : payload?.body || item.content);
  const [to, setTo] = useState(payload?.kind === "outlook_draft_create" ? payload.to.join(", ") : "");
  const [due, setDue] = useState(payload?.kind === "hubspot_task_create" && payload.due_at ? new Date(payload.due_at).toISOString().slice(0, -1) : "");
  const [dueEdited, setDueEdited] = useState(false);
  function submit(event: FormEvent) {
    event.preventDefault();
    if (disabled || (mode === "live" && !liveAvailable)) return;
    if (mode === "live" && item.kind === "hubspot_task_create" && (!due || !Number.isFinite(Date.parse(`${due}Z`)))) {
      setError("Choose an explicit UTC due time for the live task."); return;
    }
    const next: Payload = item.kind === "outlook_draft_create" ? { schema_version: "1", kind: item.kind, to: to.split(",").map(value => value.trim()), subject: title, body_text: body }
      : item.kind === "hubspot_task_create" ? { schema_version: "1", kind: item.kind, title, body,
        due_at: dueEdited ? (due ? new Date(`${due}Z`).toISOString() : null) : (payload?.kind === "hubspot_task_create" ? payload.due_at : null) }
        : { schema_version: "1", kind: item.kind, body };
    setError(null);
    void save(next, mode);
  }
  return <article className="mission-action"><h4>{kindLabel(item.kind)}</h4><form onSubmit={submit} className="mission-form"><fieldset disabled={disabled}>
    <label>Preparation mode<select aria-label="Preparation mode" value={mode} onChange={event => { setMode(event.target.value as Action["mode"]); setError(null); }}>
      <option value="simulation">Simulation · local resource</option>
      <option value="live" disabled={!liveAvailable}>{item.kind === "outlook_draft_create" ? "Live Microsoft · unsent draft" : "Live HubSpot · external record"}</option>
    </select></label>
    {mode === "live" && <p>Saving creates an unapproved preview. Review the exact returned provider request, mode and destination before authorizing a live write.</p>}
    {item.kind === "outlook_draft_create" && <label>Recipients (comma separated, ordered)<input required value={to} maxLength={2010} onChange={event => setTo(event.target.value)} /></label>}
    {item.kind !== "hubspot_note_create" && <label>{item.kind === "outlook_draft_create" ? "Subject" : "Title"}<input required value={title} maxLength={255} onChange={event => setTitle(event.target.value)} /></label>}
    <label>Body<textarea aria-label="Body" required maxLength={20000} rows={8} value={body} onChange={event => setBody(event.target.value)} /></label>
    {item.kind === "hubspot_task_create" && <label>Due time (UTC{mode === "live" ? ", required" : ", optional"})<input type="datetime-local" required={mode === "live"} step="0.001" value={due} onChange={event => { setDue(event.target.value); setDueEdited(true); }} /></label>}
    <button type="submit" disabled={mode === "live" && !liveAvailable}>Save {mode} {kindLabel(item.kind)} preview</button>
  </fieldset></form>{error && <p role="alert">{error}</p>}{action && <ExactPreview action={action} />}</article>;
}

function ReviewForm({ disabled, submit }: { disabled: boolean; submit: (decision: Decision["decision"], reason: string) => Promise<void> }) {
  const [decision, setDecision] = useState<Decision["decision"]>("approved");
  const [reason, setReason] = useState("");
  return <form className="mission-form" onSubmit={event => { event.preventDefault(); void submit(decision, reason); }}><fieldset disabled={disabled}>
    <label>Review decision<select aria-label="Review decision" value={decision} onChange={event => setDecision(event.target.value as Decision["decision"])}>
      <option value="approved">Approve exact preview</option><option value="rejected">Reject</option><option value="revision_required">Request revision</option></select></label>
    <label>Review reason<textarea aria-label="Review reason" required={decision !== "approved"} maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
    <button type="submit">Record review decision</button></fieldset></form>;
}

function OutcomeForm({ data, disabled, save }: { data: MissionData; disabled: boolean; save: (body: OutcomeRequest) => Promise<void> }) {
  const { mission, actions, executions, receipts, outcomes } = data;
  const latest = outcomes.at(-1);
  const [manual, setManual] = useState(!receipts.length);
  const [reference, setReference] = useState("");
  const [receiptId, setReceiptId] = useState(receipts[0]?.id || "");
  const [kind, setKind] = useState<OutcomeRequest["kind"]>("follow_up_required");
  const [note, setNote] = useState("");
  const active = executions.some(item => !["succeeded", "failed"].includes(item.status));
  const partial = mission.template === "account-follow-up-1" && executions.some(item => item.status === "succeeded")
    && actions.some(action => !executions.some(item => item.action_id === action.id));
  const allowed = !active && ((manual && partial && mission.status === "approved")
    || (manual ? ["draft", "prepared", "executed", "execution_failed", "completed"] : ["executed", "execution_failed", "completed"]).includes(mission.status));
  const onlyFollowUp = !manual || partial || executions.some(item => item.status === "failed");
  return <><p>Adapter receipts do not establish a business result. Record an identified human report; corrections append to history.</p>
    {partial && !active && <p>To close remaining preparation, identify a manual action and record follow-up. Existing execution stays in history; remaining steps stay unexecuted.</p>}
    {!allowed && <p role="status">Outcome capture is unavailable until the current review/execution blockers are resolved.</p>}
    <form className="mission-form" onSubmit={event => { event.preventDefault(); void save({ schema_version: "1", expected_revision: mission.revision,
      supersedes_id: latest?.id || null, receipt_id: manual ? null : receiptId, manual_action_reference: manual ? reference : null,
      kind: onlyFollowUp ? "follow_up_required" : kind, basis: "manual_report", evidence_ids: mission.evidence.evidence_ids, note }); }}>
      <fieldset disabled={disabled}><label><input type="checkbox" checked={manual} onChange={event => setManual(event.target.checked)} /> Identify a manual action instead of an adapter receipt</label>
        {manual ? <label>Manual action reference<input required maxLength={200} value={reference} onChange={event => setReference(event.target.value)} /></label>
          : <label>Adapter receipt<select aria-label="Adapter receipt" required value={receiptId} onChange={event => setReceiptId(event.target.value)}>{receipts.map(item => <option key={item.id} value={item.id}>{item.mode} · {item.id} · {item.result}</option>)}</select></label>}
        <label>Reported result<select aria-label="Reported result" value={onlyFollowUp ? "follow_up_required" : kind} disabled={onlyFollowUp} onChange={event => setKind(event.target.value as OutcomeRequest["kind"])}>
          {["follow_up_required", "meeting_booked", "customer_contacted", "renewal_risk_reduced", "opportunity_created", "no_response"].map(item => <option key={item} value={item}>{item.replaceAll("_", " ")}</option>)}</select></label>
        <label>Human report<textarea aria-label="Human report" required maxLength={2000} value={note} onChange={event => setNote(event.target.value)} /></label>
        <button type="submit" disabled={!allowed}>{latest ? "Append outcome correction" : "Record outcome"}</button>
      </fieldset></form>
    <ol>{outcomes.map(item => <li key={item.id}><strong>Report {item.revision}: {item.report.kind.replaceAll("_", " ")}</strong>
      <pre>{item.report.note}</pre><p>{item.report.basis} by {item.observer_id} at {item.observed_at}</p>
      <p>{item.supersedes_id ? `Corrects ${item.supersedes_id}` : "Original report"} · {item.report.manual_action_reference || item.report.receipt_id}</p></li>)}</ol>
  </>;
}
