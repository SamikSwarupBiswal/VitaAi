import type { components } from "./api.generated";
import { savedRunId } from "./pipeline-history";
export type Conversation = components["schemas"]["Conversation"];
export type ConversationHistory = components["schemas"]["ConversationHistory"];
export type Turn = components["schemas"]["Turn"];
export type Navigation = components["schemas"]["Navigation"];
export type Persona = Conversation["persona"];

export function conversationScope(item: Conversation, actor: string, org: string, account: string): Conversation {
  if (item.actor_id !== actor || item.organization_id !== org || item.account_id !== account
    || !savedRunId.test(item.id) || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("Conversation scope changed");
  return item;
}

export function navigationHref(value: Navigation, account: string): string | null {
  if (value.account_id !== account || !savedRunId.test(account)) return null;
  if (value.target === "account" || value.target === "evidence") {
    return value.mission_id || value.step ? null : `/accounts?${new URLSearchParams({ account })}`;
  }
  if (value.target !== "mission" || !value.mission_id || !savedRunId.test(value.mission_id) || !value.step
    || !["Review", "Evidence", "Outreach", "CRM Note", "Approval", "Execution", "Outcome"].includes(value.step)) return null;
  return `/missions?${new URLSearchParams({ account, mission: value.mission_id, step: value.step })}`;
}

export function conversationHistory(value: ConversationHistory, actor: string, org: string, account: string, id: string): ConversationHistory {
  const item = conversationScope(value.conversation, actor, org, account);
  if (item.id !== id || value.limit !== 30 || value.turns.length !== item.revision - 1 || value.turns.length > 30
    || new Set(value.turns.map(turn => turn.id)).size !== value.turns.length
    || value.turns.some((turn, index) => turn.organization_id !== org || turn.session_id !== id || turn.number !== index + 1
      || turn.mode !== "deterministic_sourced" || (turn.navigation && !navigationHref(turn.navigation, account)))) throw new Error("Conversation history changed");
  return value;
}
