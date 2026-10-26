"use client";

import Link from "next/link";
import { useState, type RefObject } from "react";
import type { AccountView, Portfolio } from "@/lib/api";
import { useSession } from "./session-gate";
import { GuideTarget } from "./guide-target";

type Props = { portfolio: Portfolio; selected: AccountView | null; persona: "executive" | "seller" | "operations";
  root: RefObject<HTMLElement | null>; context: string };
export function WorkspaceGuide(props: Props) {
  const session = useSession(), actor = session?.actor;
  if (!session || (session.mode === "session" && (!actor || actor.organization_id !== props.portfolio.organization_id))) return null;
  const { selected, portfolio, persona } = props;
  if (selected && (selected.account.organization_id !== portfolio.organization_id || !portfolio.accounts.includes(selected))) return null;
  return <Guide {...props} role={actor?.role ?? null} key={JSON.stringify([session.mode, actor?.id, actor?.organization_id, actor?.role,
    props.context, persona, portfolio.organization_id, portfolio.as_of, selected?.account.id, selected?.account.revision, selected?.source?.id, selected?.assessment.snapshot_hash])} />;
}

function Guide({ portfolio, selected, persona, role, root, context }: Props & { role: string | null }) {
  const [step, setStep] = useState(0);
  const query = new URLSearchParams({ persona });
  if (selected) query.set("account", selected.account.id);
  const accountQuery = selected ? `?${new URLSearchParams({ account: selected.account.id })}` : "";
  const titles = ["Understand this perspective", "Inspect this account's evidence", "Use the governed mission flow", "Continue with the walkthrough"];
  return <details className="portfolio-brief"><summary>Guide this workspace</summary>
    <p>This opt-in guide uses the displayed workspace. Next and Back change these instructions only; they do not create work, authorize actions or mark missions complete.</p>
    <section aria-label="Workspace guide step" aria-live="polite">
      <h2>Step {step + 1} of 4: {titles[step]}</h2>
      {step === 0 && <>
        <p>{persona === "executive" ? "Executive: inspect server-ranked priorities and the saved-source change brief."
          : persona === "seller" ? "Seller: inspect saved recommendations, then choose the account's unfinished mission queue."
            : "Operations: inspect saved mission attention, owner coaching and integration readiness."}</p>
        <p>Perspective changes presentation. {role ? `Your current session role is ${role}; the server checks every operation.` : "Sample mode has no mission review authority. Sign in through Missions to inspect private work."}</p>
        <p>Assessment {portfolio.as_of} · {portfolio.mode === "local_sample" ? "Synthetic sample" : portfolio.mode === "mixed" ? "Mixed synthetic and HubSpot sources" : "HubSpot sources"}. Source labels do not certify facts or connector health.</p>
      </>}
      {step === 1 && (selected ? <>
        <p>Selected account {selected.account.name} · revision {selected.account.revision} · assessment {selected.assessment.as_of}.</p>
        <p>Annual value {selected.account.annual_value ?? "Unknown"} · renewal {selected.account.renewal_date ?? "Unknown"}. {selected.assessment.requires_review ? "Evidence review is required before preparation." : "Inspect evidence and caveats before preparing work."}</p>
        <p>In Account details, expand Evidence for original observation dates and source records. Combined saved history is a bounded historical inspection, not current approval.</p>
        <Link href={`/accounts?${query}`}>Inspect this account and its evidence</Link>
      </> : <p>No account is selected in this workspace. Choose an available account before inspecting evidence; no replacement account is supplied by the guide.</p>)}
      {step === 2 && <>
        <p>Review → Evidence → Outreach → CRM Note → Approval → Execution → Outcome. Preparation defaults to simulation. Exact saved review and destination checks remain required; an unknown execution result needs reconciliation.</p>
        <p>{role === "viewer" ? "Viewers can inspect saved work but cannot prepare, review or execute it."
          : role === "seller" ? "Sellers can prepare permitted work; a current admin or reviewer must make the exact review decision."
            : "Presentation and guide navigation grant no approval or execution authority."} A receipt and a separately recorded human outcome have different meanings.</p>
        {selected ? <Link data-guide-target="missions" href={`/missions${accountQuery}`}>Inspect this account&apos;s saved missions</Link> : <p>Select an account first to retain its mission context.</p>}
      </>}
      {step === 3 && <>
        <p>End of workspace guide. Continue with the seven-step walkthrough or the local simulation tester guide. This does not establish onboarding, mission or business completion.</p>
        <Link data-guide-target="walkthrough" href={`/walkthrough${accountQuery}`}>Open the contextual walkthrough</Link>{" · "}<Link href="/tester-guide">Open the local simulation tester guide</Link>
      </>}
    </section>
    <GuideTarget key={step} root={root} context={context} target={(["perspective", "evidence", "missions", "walkthrough"] as const)[step]} />
    <nav aria-label="Workspace guide controls">
      <button type="button" disabled={step === 0} onClick={() => setStep(value => Math.max(0, value - 1))}>Back</button>{" "}
      {step < 3 ? <button type="button" onClick={() => setStep(value => Math.min(3, value + 1))}>Next</button>
        : <button type="button" onClick={() => setStep(0)}>Restart guide</button>}
    </nav>
  </details>;
}
