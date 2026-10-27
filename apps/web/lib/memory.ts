import type { components } from "./api.generated";
import { savedRunId } from "./pipeline-history";

export type MemoryEntry = components["schemas"]["MemoryEntry"];
export type MemoryHistory = components["schemas"]["MemoryHistory"];
export type MemoryEvent = components["schemas"]["MemoryEvent"];
export type RecallResult = components["schemas"]["RecallResult"];

export function validateMemory(item: MemoryEntry, organizationId: string, accountId: string): MemoryEntry {
  const context = item.context;
  if (item.organization_id !== organizationId || item.account_id !== accountId || !savedRunId.test(item.id)
    || !Number.isSafeInteger(item.revision) || item.revision < 1 || item.visibility !== "organization"
    || !["active", "archived", "invalidated"].includes(item.state) || context.account.id !== accountId
    || context.account.organization_id !== organizationId || item.recommendation.account_id !== accountId
    || new Set(context.evidence.map(fact => fact.id)).size !== context.evidence.length
    || context.evidence.some(fact => fact.account_id !== accountId || fact.organization_id !== organizationId)
    || !savedRunId.test(item.source.pipeline_id) || !Number.isFinite(Date.parse(item.source.started_at))) {
    throw new Error("Memory scope changed");
  }
  return item;
}

export function validateMemoryHistory(value: MemoryHistory, organizationId: string, accountId: string): MemoryHistory {
  if (value.organization_id !== organizationId || value.account_id !== accountId || value.limit !== 20
    || !Number.isSafeInteger(value.total_count) || value.total_count < 0 || value.items.length !== Math.min(20, value.total_count)
    || value.has_more !== (value.total_count > value.items.length)
    || new Set(value.items.map(item => item.id)).size !== value.items.length) throw new Error("Memory coverage changed");
  value.items.forEach(item => validateMemory(item, organizationId, accountId));
  return value;
}

export function validateRecall(value: RecallResult, organizationId: string, accountId: string, hash: string): RecallResult {
  if (value.organization_id !== organizationId || value.account_id !== accountId || value.snapshot_hash !== hash
    || value.policy !== "memory-recall-1" || value.items.length > 5 || value.inspected_count > 100
    || value.total_count < value.inspected_count || value.has_more !== (value.total_count > value.inspected_count)
    || new Set(value.items.map(item => item.memory.id)).size !== value.items.length) throw new Error("Recall scope changed");
  value.items.forEach(item => { validateMemory(item.memory, organizationId, accountId);
    if (item.memory.state !== "active" || item.score !== item.relevance + item.significance + item.confidence - item.decay_penalty) throw new Error("Recall changed"); });
  return value;
}
