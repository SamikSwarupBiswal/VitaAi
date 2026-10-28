"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type Catalog = Required<components["schemas"]["GuardrailCatalog"]>;
type Result = Required<components["schemas"]["GuardrailEvaluation"]>;
type Mode = NonNullable<components["schemas"]["GuardrailRequest"]["classifier_mode"]>;
const ids = ["evidence-summary", "instruction-override", "approval-shortcut", "external-action", "evidence-change", "secret-extraction", "scope-swap"];
const rules = ["instruction_override", "approval_bypass", "external_action", "record_manipulation", "secret_request", "identity_substitution"];
const boundedText = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 2000;

export function checkCatalog(value: Catalog) {
  if (!value || value.schema_version !== "1" || value.policy_version !== "request-constraints-1" || value.dataset_version !== "guardrail-lab-1"
    || !Array.isArray(value.scenarios) || value.scenarios.length !== ids.length
    || value.scenarios.some((item, index) => !item || item.id !== ids[index] || !boundedText(item.title) || !boundedText(item.text))) throw new Error("Guardrail catalog unavailable or incompatible");
}

export function checkResult(value: Result, catalog: Catalog, scenario: string, mode: Mode, actor: string, organization: string) {
  const selected = catalog.scenarios.find(item => item.id === scenario), classifier = value?.classifier;
  if (!value || value.schema_version !== "1" || value.policy_version !== catalog.policy_version || value.dataset_version !== catalog.dataset_version
    || value.scope !== "curated_read_only_lab" || value.actor_id !== actor || value.organization_id !== organization
    || !selected || value.scenario?.id !== selected.id || value.scenario.title !== selected.title || value.scenario.text !== selected.text
    || !Array.isArray(value.findings) || value.findings.length !== rules.length
    || value.findings.some((item, index) => !item || item.rule_id !== rules[index] || typeof item.triggered !== "boolean" || !boundedText(item.description))
    || value.deterministic_decision !== (value.findings.some(item => item.triggered) ? "blocked" : "explanation_only")
    || value.final_decision !== value.deterministic_decision || classifier?.mode !== mode
    || (mode === "disabled" ? classifier.status !== "disabled" || classifier.evidence_tier !== "not_run" || classifier.advisory_flag != null || classifier.error_code != null
      : classifier.evidence_tier !== "synthetic" || (classifier.status === "mock"
        ? mode !== "mock" || typeof classifier.advisory_flag !== "boolean" || classifier.error_code != null
        : classifier.status !== "failed" || classifier.advisory_flag != null || classifier.error_code !== (mode === "simulated_failure" ? "simulated_failure" : "classifier_unavailable")))
    || typeof value.evaluated_at !== "string" || !Number.isFinite(Date.parse(value.evaluated_at))
    || !Array.isArray(value.caveats) || !value.caveats.length || value.caveats.length > 12 || value.caveats.some(item => !boundedText(item))) throw new Error("Guardrail result binding changed");
}

export function GuardrailsLab() {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor) return <main className="entry"><h1>Guardrails lab</h1><p>Sign in with a workspace identity to inspect the lab.</p><Link href="/">Open workspace</Link></main>;
  return <GuardrailWorkspace actor={actor.id} organization={actor.organization_id} key={JSON.stringify([actor.id, actor.organization_id, actor.role])} />;
}

export function GuardrailWorkspace({ actor, organization }: { actor: string; organization: string }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null), [scenario, setScenario] = useState("");
  const [mode, setMode] = useState<Mode>("disabled"), [result, setResult] = useState<Result | null>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState("");
  const [, render] = useState(0), life = useRef({ alive: false, epoch: 0, pending: false, controller: null as AbortController | null });
  const epoch = life.current.epoch;
  useEffect(() => {
    const state = life.current; state.alive = true;
    const clear = () => { state.controller?.abort(); state.epoch++; state.pending = false; setCatalog(null); setResult(null); setScenario(""); setError(""); setPending(false); render(value => value + 1); };
    window.addEventListener("focus", clear);
    return () => { state.alive = false; state.controller?.abort(); state.pending = false; window.removeEventListener("focus", clear); };
  }, [actor, organization]);
  const valid = () => life.current.alive && life.current.epoch === epoch;
  const run = async (read: (signal: AbortSignal) => Promise<() => void>) => {
    const state = life.current;
    if (!valid() || state.pending) return;
    const controller = new AbortController(); state.controller = controller; state.pending = true;
    setPending(true); setError(""); setResult(null);
    try { const publish = await read(controller.signal); if (valid() && !controller.signal.aborted) publish(); }
    catch { if (valid() && !controller.signal.aborted) setError("Inspection unavailable. Load the catalog and try again."); }
    finally { if (valid() && state.controller === controller) { state.pending = false; state.epoch++; setPending(false); render(value => value + 1); } }
  };
  const load = () => run(async signal => {
    setCatalog(null); setScenario("");
    const value = await api<Catalog>("guardrails/scenarios", { signal }); checkCatalog(value);
    return () => setCatalog(value);
  });
  const classify = () => run(async signal => {
    if (!catalog || !ids.includes(scenario)) throw new Error("Select a scenario");
    const value = await api<Result>("guardrails/classify", { signal, method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenario_id: scenario, classifier_mode: mode }) });
    checkResult(value, catalog, scenario, mode, actor, organization);
    return () => setResult(value);
  });
  const change = (update: () => void) => { if (!valid() || life.current.pending) return; life.current.epoch++; setResult(null); setError(""); update(); render(value => value + 1); };
  return <main className="entry"><Link href="/">VitaAi workspace</Link><h1>Guardrails lab</h1>
    <p>Inspect curated requests against deterministic policy. Explanation-only permits a response in this lab; it grants no approval or execution authority.</p>
    <p>No live classifier is connected. Mock flags and simulated failures are synthetic evidence. This lab does not certify general prompt-injection safety.</p>
    <button onClick={load} disabled={pending}>Load scenario catalog</button>
    {pending && <p role="status">Inspecting…</p>}{error && <p role="alert">{error}</p>}
    {catalog && <><p>Policy {catalog.policy_version} · Dataset {catalog.dataset_version}</p>
      <label>Curated scenario<select value={scenario} disabled={pending} onChange={event => change(() => setScenario(event.target.value))}>
        <option value="">Choose a scenario</option>{catalog.scenarios.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
      </select></label>
      <label>Classifier demonstration<select value={mode} disabled={pending} onChange={event => change(() => setMode(event.target.value as Mode))}>
        <option value="disabled">Disabled — deterministic policy only</option><option value="mock">Mock — synthetic advisory flag</option><option value="simulated_failure">Simulated classifier failure</option>
      </select></label>
      {scenario && <blockquote>{catalog.scenarios.find(item => item.id === scenario)?.text}</blockquote>}
      <button onClick={classify} disabled={pending || !scenario}>Inspect deterministic decision</button>
    </>}
    {result && <section aria-label="Guardrail result"><h2>{result.final_decision === "blocked" ? "Blocked by lab policy" : "Explanation only"}</h2>
      <p>Deterministic decision: {result.deterministic_decision} · Final decision: {result.final_decision}</p>
      <p>Evaluated {result.evaluated_at}</p><p>Classifier: {result.classifier.status} · Evidence: {result.classifier.evidence_tier}</p>
      {result.classifier.status === "mock" && <p>Synthetic advisory flag: {String(result.classifier.advisory_flag)}. This is not a probability or safety rating.</p>}
      {result.classifier.error_code && <p>Classifier unavailable: {result.classifier.error_code}. Deterministic policy still applies.</p>}
      <ul>{result.findings.map(item => <li key={item.rule_id}>{item.description}: {item.triggered ? "triggered" : "not triggered"}</li>)}</ul>
      {result.caveats.map(item => <p key={item}>{item}</p>)}
    </section>}
  </main>;
}
