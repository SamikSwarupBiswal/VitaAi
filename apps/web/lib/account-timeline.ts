import { api, type AccountView, type PipelineRun } from "./api";
import type { components } from "./api.generated";
import { sameAccount, validateActivity, validateDetections, type Detection } from "./account-history";
import { savedRunInstant } from "./pipeline-delta";
import { validatePipelineHistory, validateSavedPipelineRun, type PipelineHistory, type PipelineRunSummary } from "./pipeline-history";
import { readMission, type Action, type Mission, type MissionData, type Outcome } from "./workflow";

type Audit = components["schemas"]["AuditEvent"];
type Coaching = components["schemas"]["CoachingReview"];
export type Stream<T> = { status: "available"; value: T } | { status: "unavailable" };
export type MissionActivity = { mission: Mission; data: Stream<MissionData> };
export type Timeline = {
  sources: Stream<Detection[]>;
  recommendations: Stream<PipelineHistory>;
  missions: Stream<{ total: number; items: MissionActivity[] }>;
};
export type TimelineEvent = { key: string; at: string; instant: bigint | null } & (
  | { kind: "source"; record: Detection }
  | { kind: "recommendation"; record: PipelineRunSummary }
  | { kind: "audit"; record: Audit; mission: Mission }
  | { kind: "report"; record: Outcome; mission: Mission }
);

const unavailable = { status: "unavailable" } as const;
const available = <T>(value: T): Stream<T> => ({ status: "available", value });
function instant(at: string) { try { return savedRunInstant(at); } catch { return null; } }

export async function readAccountActivity(view: AccountView, selected: Mission, signal: AbortSignal): Promise<MissionData> {
  const id = encodeURIComponent(selected.id);
  const [value, reviews] = await Promise.all([readMission(selected.id, signal),
    api<Coaching[]>(`missions/${id}/coaching-reviews`, { signal })]);
  const histories = await Promise.all(value.actions.map(action =>
    api<Action[]>(`actions/${encodeURIComponent(action.id)}/history`, { signal })));
  const current = await api<Mission>(`missions/${id}`, { signal });
  validateActivity(value, reviews, histories, selected, current, view);
  return value;
}

export async function readAccountTimeline(view: AccountView, signal: AbortSignal): Promise<Timeline> {
  const account = encodeURIComponent(view.account.id);
  const results = await Promise.allSettled([
    api<Detection[]>(`integrations/hubspot/accounts/${account}/detections`, { signal })
      .then(saved => validateDetections(saved, view)),
    api<PipelineHistory>("pipeline/history", { signal }).then(saved => validatePipelineHistory(saved, view.account.organization_id)),
    (async () => {
      const saved = await api<Mission[]>("missions", { signal });
      if (!Array.isArray(saved) || new Set(saved.map(item => item.id)).size !== saved.length
        || saved.some(item => item.organization_id !== view.account.organization_id)) throw new Error("Mission list changed");
      const matching = saved.filter(item => item.account_id === view.account.id);
      // Server creation order, not last-activity order.
      const items = await Promise.all(matching.slice(0, 5).map(async mission => {
        try { return { mission, data: available(await readAccountActivity(view, mission, signal)) }; }
        catch { return { mission, data: unavailable }; }
      }));
      return { total: matching.length, items };
    })(),
  ]);
  // These independent GETs are not one transactional cross-stream snapshot.
  const [sources, recommendations, missions] = results;
  if (missions.status === "fulfilled") {
    await Promise.all(missions.value.items.map(async item => {
      if (item.data.status !== "available") return;
      try {
        const current = await api<Mission>(`missions/${encodeURIComponent(item.mission.id)}`, { signal });
        const saved = item.data.value;
        if (current.id !== saved.mission.id || current.organization_id !== view.account.organization_id
          || current.account_id !== view.account.id || current.revision !== saved.mission.revision
          || current.status !== saved.mission.status || current.owner_id !== saved.mission.owner_id) item.data = unavailable;
      } catch { item.data = unavailable; }
    }));
  }
  const fresh = await api<AccountView>(`accounts/${account}`, { signal });
  if (signal.aborted || !sameAccount(view, fresh)) throw new Error("Account snapshot changed");
  return { sources: sources.status === "fulfilled" ? available(sources.value) : unavailable,
    recommendations: recommendations.status === "fulfilled" ? available(recommendations.value) : unavailable,
    missions: missions.status === "fulfilled" ? available(missions.value) : unavailable };
}

export async function readTimelineRecommendation(view: AccountView, summary: PipelineRunSummary, signal: AbortSignal): Promise<PipelineRun> {
  const saved = validateSavedPipelineRun(await api<PipelineRun>(`pipeline/${summary.id}`, { signal }),
    view.account.organization_id, summary.id, summary, view.account.id);
  const fresh = await api<AccountView>(`accounts/${encodeURIComponent(view.account.id)}`, { signal });
  if (signal.aborted || !sameAccount(view, fresh)) throw new Error("Account snapshot changed");
  return saved;
}

export function timelineEvents(history: Timeline, accountId: string): { dated: TimelineEvent[]; undated: TimelineEvent[] } {
  const events: TimelineEvent[] = [];
  if (history.sources.status === "available") for (const record of history.sources.value) {
    events.push({ kind: "source", key: `source:${record.id}`, at: record.after.selected_at, instant: instant(record.after.selected_at), record });
  }
  if (history.recommendations.status === "available") for (const record of history.recommendations.value.items) {
    if (record.input_account_ids.includes(accountId)) events.push({ kind: "recommendation", key: `recommendation:${record.id}:${accountId}`,
      at: record.started_at, instant: instant(record.started_at), record });
  }
  if (history.missions.status === "available") for (const item of history.missions.value.items) {
    if (item.data.status !== "available") continue;
    for (const record of item.data.value.audit) events.push({ kind: "audit", key: `audit:${record.id}`,
      at: record.created_at, instant: instant(record.created_at), record, mission: item.mission });
    for (const record of item.data.value.outcomes) events.push({ kind: "report", key: `report:${record.id}`,
      at: record.observed_at, instant: instant(record.observed_at), record, mission: item.mission });
  }
  if (new Set(events.map(item => item.key)).size !== events.length) throw new Error("Duplicate timeline identity");
  const tie = (a: TimelineEvent, b: TimelineEvent) => a.kind === "audit" && b.kind === "audit"
    ? b.record.sequence - a.record.sequence : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  const dated = events.filter(item => item.instant !== null).sort((a, b) => a.instant === b.instant ? tie(a, b) : a.instant! > b.instant! ? -1 : 1);
  return { dated, undated: events.filter(item => item.instant === null).sort(tie) };
}
