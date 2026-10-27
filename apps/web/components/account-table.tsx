import { ArrowDown, ArrowUp } from "lucide-react";
import type { KeyboardEvent } from "react";
import type { AccountView } from "@/lib/api";
import { currency } from "@/lib/api";

export type SortKey = "name" | "health" | "risk" | "opportunity" | "renewal" | "value";

export function AccountTable({ rows, selectedId, onSelect, sort, descending, onSort }: {
  rows: AccountView[]; selectedId?: string; onSelect: (id: string) => void;
  sort: SortKey; descending: boolean; onSort: (key: SortKey) => void;
}) {
  const columns: [SortKey, string][] = [
    ["name", "Account"], ["health", "Health"], ["risk", "Risk"],
    ["opportunity", "Opportunity"], ["renewal", "Renewal"], ["value", "Annual value"],
  ];
  function moveSelection(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
    event.preventDefault();
    const next = index + (event.key === "ArrowDown" ? 1 : -1);
    if (!rows[next]) return;
    const buttons = event.currentTarget.closest("tbody")?.querySelectorAll<HTMLButtonElement>("button.account-link");
    buttons?.[next]?.focus();
    onSelect(rows[next].account.id);
  }
  return <div className="table-scroll"><table className="account-table">
    <caption className="sr-only">Accounts ranked by attention</caption>
    <thead><tr>{columns.map(([key, label]) => <th key={key} scope="col"
      aria-sort={sort === key ? descending ? "descending" : "ascending" : "none"}>
      <button className="column-sort" onClick={() => onSort(key)}>{label}
        {sort === key && (descending ? <ArrowDown size={13} /> : <ArrowUp size={13} />)}
      </button></th>)}</tr></thead>
    <tbody>{rows.map((view, index) => <tr key={view.account.id} className={view.account.id === selectedId ? "selected" : ""}>
      <th scope="row"><button className="account-link" aria-pressed={view.account.id === selectedId}
        aria-keyshortcuts="ArrowUp ArrowDown" onKeyDown={event => moveSelection(event, index)}
        onClick={() => onSelect(view.account.id)}>{view.account.name}</button></th>
      <td>{view.assessment.health}</td>
      <td className={view.assessment.risk >= 45 ? "risk-text" : ""}>{view.assessment.risk}</td>
      <td className="growth-text">{view.assessment.opportunity}</td>
      <td className={view.renewal_days !== null && view.renewal_days <= 30 ? "risk-text" : ""}>{view.renewal_days === null ? "Unknown" : `${view.renewal_days} days`}</td>
      <td>{currency(view.account.annual_value)}</td>
    </tr>)}</tbody>
  </table>{rows.length === 0 && <p className="empty">No accounts match these filters.</p>}</div>;
}
