"use client";

import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AccountView, PipelineRun } from "@/lib/api";
import { readAccountTimeline, readTimelineRecommendation, timelineEvents, type Timeline, type TimelineEvent } from "@/lib/account-timeline";
import type { PipelineRunSummary } from "@/lib/pipeline-history";
import { SourceSnapshot } from "./account-chronology";
import { SavedRunComparison } from "./pipeline-panel";
import { useSession } from "./session-gate";

export function AccountTimeline({ view }: { view: AccountView }) {
  const session = useSession(), actor = session?.actor;
  if (session?.mode !== "session" || !actor || actor.organization_id !== view.account.organization_id) {
    return <section><h3>Combined saved history</h3><p>Session identity in this organization is required to inspect combined history.</p></section>;
  }
  return <TimelineInspection view={view} key={JSON.stringify([actor.id, actor.organization_id, actor.role,
    view.account.id, view.account.revision, view.source?.id, view.assessment.as_of, view.assessment.snapshot_hash])} />;
}

function TimelineInspection({ view }: { view: AccountView }) {
  const [history, setHistory] = useState<Timeline | null>(null), [detail, setDetail] = useState<PipelineRun | null>(null);
  const [events, setEvents] = useState<ReturnType<typeof timelineEvents> | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const lifetime = useRef<AbortController | null>(null), sequence = useRef(0), pending = useRef(false);
  const historyRef = useRef<Timeline | null>(null);
  useLayoutEffect(() => { const controller = new AbortController(); lifetime.current = controller;
    return () => controller.abort(); }, []);
  useEffect(() => {
    const invalidate = () => { ++sequence.current; pending.current = false; historyRef.current = null;
      setHistory(null); setEvents(null); setDetail(null); setError(null); setBusy(false); };
    const names = ["focus", "vitaai-source-changed", "vitaai-source-history-changed", "vitaai-detections-changed",
      "vitaai-workflow-changed", "vitaai-pipeline-history-changed"];
    names.forEach(name => window.addEventListener(name, invalidate));
    return () => names.forEach(name => window.removeEventListener(name, invalidate));
  }, []);

  async function inspect(summary?: PipelineRunSummary) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || pending.current || (summary && (historyRef.current?.recommendations.status !== "available"
      || !historyRef.current.recommendations.value.items.includes(summary) || !summary.input_account_ids.includes(view.account.id)))) return;
    pending.current = true; const request = ++sequence.current;
    const active = () => !signal.aborted && sequence.current === request;
    setBusy(true); setDetail(null); setError(null);
    if (!summary) { historyRef.current = null; setHistory(null); setEvents(null); }
    try {
      if (summary) {
        const value = await readTimelineRecommendation(view, summary, signal);
        if (active()) setDetail(value);
      } else {
        const value = await readAccountTimeline(view, signal);
        if (!active()) return;
        const rows = timelineEvents(value, view.account.id);
        historyRef.current = value; setHistory(value); setEvents(rows);
      }
    } catch { if (active()) { historyRef.current = null; setHistory(null); setEvents(null);
      setError("Combined history unavailable or changed. Refresh the account and inspect again."); } }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  const recommendations = history?.recommendations.status === "available" ? history.recommendations.value : null;
  const context = detail?.contexts.find(item => item.account.id === view.account.id);
  const recommendation = detail?.recommendations.find(item => item.account_id === view.account.id) ?? null;
  const renderEvent = (event: TimelineEvent) => <li key={event.key}><details>
    <summary>{event.kind === "source" ? "Source selected" : event.kind === "recommendation" ? "Recommendation run started"
      : event.kind === "audit" ? `Mission activity: ${event.record.event_kind}` : "Human report observed"} · {event.at || "Unknown date"}</summary>
    <p>Record identity {event.key}.</p>
    {event.kind === "source" ? <>
      <p>{event.record.status} · {event.record.reason} · detected {event.record.detected_at} · actor {event.record.actor_id}.</p>
      <p>Source event {event.record.event?.id || "none"}. Selection, detection and measurement dates have different meanings.</p>
      <SourceSnapshot label="Before" snapshot={event.record.before} /><SourceSnapshot label="After" snapshot={event.record.after} />
      <details><summary>Exact saved source detection and changes</summary><pre>{JSON.stringify(event.record, null, 2)}</pre></details>
    </> : event.kind === "recommendation" ? <>
      <p>Run {event.record.id} · assessment {event.record.as_of} · actor {event.record.actor_id ?? "Not recorded"} · {event.record.status}.</p>
      <p>Account retained in input · {event.record.selected_account_ids.includes(view.account.id) ? "Selected result" : "Outside selected result"}.</p>
      <button type="button" disabled={busy} onClick={() => inspect(event.record)}>Inspect recommendation {event.record.id}</button>
    </> : <>
      <p>Mission {event.mission.id} · retained revision {event.mission.revision} · source detection {event.mission.source_detection_id || "none"} · plan {event.mission.plan_id}.</p>
      {event.kind === "audit" ? <p>Audit sequence {event.record.sequence} · entity {event.record.entity_id} revision {event.record.entity_revision} · correlation {event.record.correlation_id}.</p>
        : <p>Manual report revision {event.record.revision} · corrects {event.record.supersedes_id || "none"} · correlation {event.record.correlation_id}. A report and its audit describe related saved records, not two business actions.</p>}
      <details><summary>Exact saved {event.kind === "audit" ? "audit event" : "human report"}</summary><pre>{JSON.stringify(event.record, null, 2)}</pre></details>
      <Link href={`/missions?${new URLSearchParams({ account: view.account.id, mission: event.mission.id, step: event.kind === "report" ? "Outcome" : event.mission.current_step })}`}>Open exact saved mission</Link>
    </>}
  </details></li>;

  return <section aria-label="Combined account history" style={{ overflowWrap: "anywhere" }}>
    <h3>Combined saved history</h3>
    <p>Account {view.account.id} · revision {view.account.revision}. Inspect retained source selections, recommendation starts and mission activity together.</p>
    <button type="button" disabled={busy} onClick={() => inspect()}>Inspect combined history</button>
    {busy && <p role="status">Reading saved account history...</p>}{error && <p role="alert">{error}</p>}
    {history && events && <div aria-live="polite">
      <h4>Independent coverage</h4>
      {history.sources.status === "unavailable" ? <p>Source history unavailable. Other streams remain independent.</p> : <>
        <p>Sources: {history.sources.value.length} saved detections, at most latest 20 by source revision. Older records may exist; older and undated totals are unknown.</p>
        {view.source?.id && history.sources.value[0]?.after.source_version_id !== view.source.id && <p>Detections do not cover the displayed source selection. Inspection does not run detection.</p>}
      </>}
      {recommendations ? <>
        <p>Recommendations: {recommendations.items.filter(item => item.input_account_ids.includes(view.account.id)).length} matching readable runs in this organization&apos;s latest {recommendations.window_count} dated records; {recommendations.total_count} total organization runs.</p>
        <p>{recommendations.undated_count} unorderable organization runs; {recommendations.unavailable_count} unreadable in the dated window. {recommendations.has_more ? "Older dated organization runs exist." : "No older dated organization runs outside the window."} Account membership of omitted records is unknown.</p>
      </> : <p>Recommendation history unavailable. Other streams remain independent.</p>}
      {history.missions.status === "unavailable" ? <p>Mission history unavailable. Other streams remain independent.</p> : <>
        <p>Missions: newest {history.missions.value.items.length} of {history.missions.value.total} account missions by server creation order, at most five; {history.missions.value.total - history.missions.value.items.length} older missions excluded. This is not newest activity across all missions.</p>
        {history.missions.value.items.map(item => <p key={item.mission.id}>Mission {item.mission.id}: {item.data.status === "available" ? "saved audit and reports inspected" : "activity unavailable or changed"}.</p>)}
      </>}
      <p>Newest original instant first, preserving UTC microseconds. Equal-time audits use their organization sequence; other ties use record identity only. Ties do not establish cause. Audit sequence gaps are valid.</p>
      <p>These independent reads are not one transactional snapshot or complete account history. No cross-stream cause, trend, current approval, execution or business outcome is inferred.</p>
      {!events.dated.length && <p>No dated events in the inspected coverage. This does not establish an empty or unchanged account history.</p>}
      <ol>{events.dated.map(renderEvent)}</ol>
      <h4>Undated records in inspected coverage</h4><p>{events.undated.length} records cannot be chronologically ordered; no date or timezone is reconstructed.</p>
      <ul>{events.undated.map(renderEvent)}</ul>
    </div>}
    {detail && context && <div aria-live="polite">
      <h4>Saved recommendation {detail.id}</h4>
      <p>Original start {detail.started_at} · assessment {detail.as_of} · account {context.account.id} revision {context.account.revision}.</p>
      <p>Annual value {context.account.annual_value ?? "Unknown"} · renewal {context.account.renewal_date ?? "Unknown"}.</p>
      <p>{recommendation ? `Saved rank ${recommendation.rank} · ${recommendation.action.kind}` : "Outside selected result; no missing recommendation or score is inferred."}</p>
      <details><summary>Original account, evidence and recommendation</summary><pre>{JSON.stringify({ context, recommendation }, null, 2)}</pre></details>
      <SavedRunComparison key={detail.id} current={detail} accountId={view.account.id}
        baselines={recommendations?.items.filter(item => item.input_account_ids.includes(view.account.id)) || []} />
      <p>Saved proposals grant no current workflow authority.</p>
    </div>}
  </section>;
}
