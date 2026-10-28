"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { components } from "@/lib/api.generated";
import { useSession } from "./session-gate";

type View = components["schemas"]["AssuranceView"];
const text = (value: unknown) => typeof value === "string" && value.trim().length > 0 && value.length <= 2000;
const hash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const count = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const decision = (value: unknown) => value === "blocked" || value === "explanation_only";
const classifierStatus = (value: unknown) => ["disabled", "mock", "failed"].includes(value as string);
const flag = (value: unknown) => value === null || typeof value === "boolean";
const errorCode = (value: unknown) => value === null || value === "simulated_failure" || value === "classifier_unavailable";

export function checkAssurance(value: View, actor: string, organization: string) {
  const report = value?.report;
  if (!value || value.schema_version !== "1" || value.actor_id !== actor || value.organization_id !== organization || !report
    || report.evidence_tier !== "synthetic" || !text(report.rubric) || !text(report.dataset_id) || !text(report.dataset_version)
    || report.policy_version !== "request-constraints-1" || !text(report.evaluator_version) || !text(report.run_id)
    || !text(report.generated_at) || !Number.isFinite(Date.parse(report.generated_at))
    || !hash(report.artifact_sha256) || !hash(report.dataset_sha256) || !hash(report.policy_source_sha256) || !hash(report.evaluator_source_sha256)
    || !Array.isArray(report.cases) || report.cases.length !== 21 || !Array.isArray(report.caveats) || !report.caveats.length
    || report.caveats.length > 12 || report.caveats.some(item => !text(item))) throw new Error("Assurance report unavailable or incompatible");
  const pairs = new Set<string>(), identities = new Set<string>();
  for (const row of report.cases) {
    if (!row || !text(row.case_id) || identities.has(row.case_id) || !text(row.scenario_id) || !text(row.scenario_title) || !hash(row.text_sha256)
      || !["disabled", "mock", "simulated_failure"].includes(row.classifier_mode) || pairs.has(`${row.scenario_id}:${row.classifier_mode}`)
      || !decision(row.expected_decision) || !decision(row.actual_decision) || !decision(row.final_decision)
      || !classifierStatus(row.expected_classifier_status) || !classifierStatus(row.actual_classifier_status)
      || !flag(row.expected_advisory_flag) || !flag(row.actual_advisory_flag) || !errorCode(row.expected_error_code) || !errorCode(row.actual_error_code)
      || !Array.isArray(row.failures)) throw new Error("Assurance case bindings changed");
    const failures = [
      ...(row.expected_decision !== row.actual_decision ? ["decision_mismatch"] : []),
      ...(row.final_decision !== row.actual_decision ? ["final_decision_mismatch"] : []),
      ...(row.expected_classifier_status !== row.actual_classifier_status ? ["classifier_status_mismatch"] : []),
      ...(row.expected_advisory_flag !== row.actual_advisory_flag ? ["classifier_flag_mismatch"] : []),
      ...(row.expected_error_code !== row.actual_error_code ? ["classifier_error_mismatch"] : []),
    ];
    if (JSON.stringify(row.failures) !== JSON.stringify(failures)) throw new Error("Assurance case failures changed");
    pairs.add(`${row.scenario_id}:${row.classifier_mode}`); identities.add(row.case_id);
  }
  const failed = report.cases.filter(row => row.failures.length > 0).length;
  if (![report.total_cases, report.passed_cases, report.failed_cases, report.classifier_failed_cases].every(count)
    || report.total_cases !== report.cases.length || report.failed_cases !== failed || report.passed_cases !== report.cases.length - failed
    || report.classifier_failed_cases !== report.cases.filter(row => row.actual_classifier_status === "failed").length
    || report.meets_rubric !== (failed === 0)) throw new Error("Assurance counts changed");
}

export function AssurancePage() {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor) return <main className="entry"><h1>AI assurance</h1><p>Sign in to inspect evaluation evidence.</p><Link href="/">Open workspace</Link></main>;
  return <AssuranceWorkspace actor={actor.id} organization={actor.organization_id} key={JSON.stringify([actor.id, actor.organization_id, actor.role])} />;
}

export function AssuranceWorkspace({ actor, organization }: { actor: string; organization: string }) {
  const [view, setView] = useState<View | null>(null), [pending, setPending] = useState(false), [error, setError] = useState("");
  const [, render] = useState(0), life = useRef({ alive: false, epoch: 0, pending: false, controller: null as AbortController | null });
  const epoch = life.current.epoch;
  useEffect(() => {
    const state = life.current; state.alive = true;
    const clear = () => { state.controller?.abort(); state.epoch++; state.pending = false; setPending(false); setView(null); setError(""); render(value => value + 1); };
    window.addEventListener("focus", clear);
    return () => { state.alive = false; state.controller?.abort(); state.pending = false; window.removeEventListener("focus", clear); };
  }, [actor, organization]);
  const inspect = async () => {
    const state = life.current;
    if (!state.alive || state.epoch !== epoch || state.pending) return;
    const controller = new AbortController(); state.controller = controller; state.pending = true; setPending(true); setView(null); setError("");
    const valid = () => state.alive && state.epoch === epoch && !controller.signal.aborted;
    try { const value = await api<View>("assurance/guardrails", { signal: controller.signal }); checkAssurance(value, actor, organization); if (valid()) setView(value); }
    catch { if (valid()) setError("Report unavailable. Check the packaged evaluation artifact, then inspect again."); }
    finally { if (valid()) { state.pending = false; state.epoch++; setPending(false); render(value => value + 1); } }
  };
  const report = view?.report;
  return <main className="entry"><Link href="/">VitaAi workspace</Link><h1>AI assurance</h1>
    <p>Measured offline results for the curated guardrail lab. Synthetic cases do not establish live classifier quality, general injection safety or release readiness.</p>
    <p>This inspection reads the packaged report. It makes no model call and grants no workflow authority.</p>
    <button onClick={inspect} disabled={pending}>Inspect evaluation report</button>{pending && <p role="status">Inspecting report…</p>}{error && <p role="alert">{error}</p>}
    {report && <section aria-label="Guardrail evaluation report"><h2>{report.meets_rubric ? "PASS — synthetic rubric" : "FAIL — synthetic rubric"}</h2>
      <p>Dataset {report.dataset_id} · Version {report.dataset_version} · Rubric {report.rubric}</p>
      <p>Policy {report.policy_version} · Evaluator {report.evaluator_version} · Evidence tier {report.evidence_tier}</p>
      <p>Run {report.run_id} · Generated {report.generated_at}</p>
      <p>{report.passed_cases} passed · {report.failed_cases} failed · {report.total_cases} measured cases. Classifier failures: {report.classifier_failed_cases}; expected failures may pass the rubric.</p>
      <details><summary>Artifact provenance</summary><p>Artifact SHA256: {report.artifact_sha256}</p><p>Dataset SHA256: {report.dataset_sha256}</p><p>Policy source SHA256: {report.policy_source_sha256}</p><p>Evaluator source SHA256: {report.evaluator_source_sha256}</p></details>
      <div className="table-scroll"><table><caption>Expected and observed decisions; classifier telemetry remains advisory</caption><thead><tr><th scope="col">Scenario</th><th scope="col">Classifier mode</th><th scope="col">Expected / actual / final</th><th scope="col">Classifier expected / actual</th><th scope="col">Result</th></tr></thead>
        <tbody>{report.cases.map(row => <tr key={row.case_id}><th scope="row">{row.scenario_title}</th><td>{row.classifier_mode}</td><td>{row.expected_decision} / {row.actual_decision} / {row.final_decision}</td><td>{row.expected_classifier_status} / {row.actual_classifier_status}</td><td>{row.failures.length ? row.failures.join(", ") : "pass"}</td></tr>)}</tbody></table></div>
      {report.caveats.map(item => <p key={item}>{item}</p>)}<Link href="/guardrails">Inspect individual lab scenarios</Link>
    </section>}
  </main>;
}
