import type { PipelineRun } from "@/lib/api";

const reviewProposals: Record<PipelineRun["recommendations"][number]["action"]["kind"], { effort: string; outcome: string }> = {
  manual_review: {
    effort: "Scope unknown until evidence gaps are reviewed.",
    outcome: "Identify the missing or contradictory evidence before deciding whether preparation is appropriate.",
  },
  support_escalation: {
    effort: "Extended review: inspect support evidence and prepare escalation questions.",
    outcome: "Identify unresolved support questions for a possible support-led next step.",
  },
  renewal_prep: {
    effort: "Focused review: inspect renewal evidence and prepare discussion points.",
    outcome: "Prepare renewal evidence and open questions for a possible value discussion.",
  },
  optimization_review: {
    effort: "Extended review: compare usage and growth evidence before preparing questions.",
    outcome: "Explore usage and growth signals together before proposing an adoption review.",
  },
  reactivation: {
    effort: "Focused review: inspect usage evidence and prepare re-engagement questions.",
    outcome: "Prepare questions about declining usage before considering a re-engagement conversation.",
  },
  follow_up: {
    effort: "Focused review: inspect growth evidence and prepare follow-up questions.",
    outcome: "Assess whether growth evidence supports a follow-up conversation.",
  },
  monitor: {
    effort: "Brief review: inspect retained signals only.",
    outcome: "Review retained signals without preparing outreach or scheduling a reminder.",
  },
};

export function SellerPriorities({ run, onSelect }: { run: PipelineRun; onSelect: (id: string) => void }) {
  return <section className="portfolio-brief" aria-label="Saved recommendation priorities">
    <h2>Now / Next / Later</h2>
    <p>Suggested review order from saved run {run.id}, prepared {run.started_at}, assessed {run.as_of}.
      Server recommendation order is unchanged. These are proposals, not scheduled or completed missions.</p>
    <p>Inspect existing missions before preparing more work. Review effort and intended outcomes are proposals based on
      the saved action type. Actual time and customer impact are unknown.</p>
    {!run.recommendations.length ? <p>No recommendations selected by this run. No mission is created automatically.</p>
      : <ol>{run.recommendations.map((item, index) => {
        const context = run.contexts.find(value => value.account.id === item.account_id);
        const proposal = !context?.evidence.length
          ? { effort: "Scope unknown. Retained account evidence is unavailable.", outcome: "Inspect evidence availability before proposing further work." }
          : reviewProposals[item.governance.status === "review_required" ? "manual_review" : item.action.kind];
        return <li key={item.account_id}>
          <h3>{index === 0 ? "Now" : index === 1 ? "Next" : "Later"} · rank {item.rank} · {context?.account.name ?? "Unknown account"}</h3>
          <p>Proposed action: {item.action.kind.replaceAll("_", " ")}. {item.action.rationale}</p>
          <p>Proposed review effort: {proposal.effort}</p>
          <p>Intended outcome (proposal): {proposal.outcome}</p>
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
