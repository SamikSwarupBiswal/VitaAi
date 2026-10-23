import type { PipelineRun } from "@/lib/api";

export function SellerPriorities({ run, onSelect }: { run: PipelineRun; onSelect: (id: string) => void }) {
  return <section className="portfolio-brief" aria-label="Saved recommendation priorities">
    <h2>Now / Next / Later</h2>
    <p>Suggested review order from saved run {run.id}, prepared {run.started_at}, assessed {run.as_of}.
      Server recommendation order is unchanged. These are proposals, not scheduled or completed missions.</p>
    <p>Inspect existing missions before preparing more work. Effort and business outcomes have not been estimated.</p>
    {!run.recommendations.length ? <p>No recommendations selected by this run. No mission is created automatically.</p>
      : <ol>{run.recommendations.map((item, index) => {
        const context = run.contexts.find(value => value.account.id === item.account_id);
        return <li key={item.account_id}>
          <h3>{index === 0 ? "Now" : index === 1 ? "Next" : "Later"} · rank {item.rank} · {context?.account.name ?? "Unknown account"}</h3>
          <p>Proposed action: {item.action.kind.replaceAll("_", " ")}. {item.action.rationale}</p>
          <p>{item.governance.status === "review_required" ? "Evidence review required before preparation."
            : "Preparation still requires current evidence and fresh exact approval before execution."}
            {" "}Communication: {item.communication.status.replaceAll("_", " ")}. No external action follows this recommendation.</p>
          <p>Account revision {context?.account.revision ?? "Unknown"} · annual value {context?.account.annual_value ?? "Unknown"}
            {" "}· renewal {context?.account.renewal_date ?? "Unknown"} · assessment {item.assessment.as_of}</p>
          <p className="caveat">{item.assessment.caveats.join(" ")} {item.governance.caveats.join(" ")}</p>
          <details><summary>Priority evidence and snapshot</summary>
            <p>{item.assessment.snapshot_hash} · {item.assessment.policy_version}</p>
            {context?.evidence.length ? <ul>{context.evidence.map(fact => <li key={fact.id}>
              {fact.fact}<br />{fact.id} · {fact.source} / {fact.source_record} · observed {fact.observed_at}
              {" "}· ingested {fact.ingested_at} · {fact.synthetic ? "Synthetic" : "Selected source observation"}
              {!item.action.evidence_ids.includes(fact.id) && " · Context only; not cited by this action"}
            </li>)}</ul> : <p>No retained evidence. Missing data does not establish safety or opportunity.</p>}
          </details>
          {context && <p><button onClick={() => onSelect(item.account_id)}>Inspect evidence for {context.account.name}</button>
            {" "}<a href={`/missions?${new URLSearchParams({ account: item.account_id })}`}>Inspect saved missions for {context.account.name}</a></p>}
        </li>;
      })}</ol>}
  </section>;
}
