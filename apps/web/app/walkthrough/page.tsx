import Link from "next/link";

export const metadata = { title: "VitaAi | Walkthrough" };

const stages = [
  ["Review", "Read the account recommendation, snapshot and caveats. Use a deterministic plan for a simulation; model planning requires a separate explicit paid-call choice. Select the saved alternative deliberately."],
  ["Evidence", "Inspect original sources and observation dates. Unknown or changed evidence stays visible and may block preparation. This guide never refreshes facts."],
  ["Outreach", "Prepare the selected task or unsent Outlook draft. Keep Simulation selected for the local demo. Saving content is preparation, not approval or customer contact."],
  ["CRM Note", "Prepare a note only when the selected plan includes one. Save all selected steps before submitting; editing invalidates related reviews."],
  ["Approval", "Submit the exact saved content and destination. A current admin or reviewer must decide that revision. Rejection, expiry or changed bindings cannot be bypassed by this guide."],
  ["Execution", "Explicitly execute only after current approval and dependencies permit it. Inspect the saved receipt and readback. An unknown result needs reviewer reconciliation, never a repeated write."],
  ["Outcome", "Record an identified human report separately from the receipt. Provider creation is not a business outcome. Completed work stays in history; use Open next unfinished mission for another saved record."],
] as const;

export default async function WalkthroughPage({ searchParams }: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = await searchParams;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const account = typeof query.account === "string" && uuid.test(query.account) ? query.account : null;
  const mission = account && typeof query.mission === "string" && uuid.test(query.mission) ? query.mission : null;
  const context = new URLSearchParams();
  if (account) context.set("account", account);
  if (mission) context.set("mission", mission);
  const missionHref = `/missions${context.size ? `?${context}` : ""}`;
  const sellerQuery = new URLSearchParams({ persona: "seller" });
  if (account) sellerQuery.set("account", account);
  return <main className="entry">
    <Link href="/" className="brand">VitaAi</Link>
    <h1>From evidence to recorded follow-up</h1>
    <p>This walkthrough explains the working local journey. Reading or following a link does not create a plan, approve an action, execute work or mark a mission complete.</p>
    <p className="caveat">The default portfolio is synthetic. Missions require session identity. Preparation defaults to simulation; live integrations need separate configuration, authorized service access and exact approval. Live and hosted acceptance remain open.</p>
    {(query.account || query.mission) && !account && <p role="status">Account context is invalid or missing. Choose an account in the workspace; no replacement account was selected by this guide.</p>}
    {account && query.mission && !mission && <p role="status">Mission context is invalid. Open the account queue and choose a saved mission.</p>}
    <section className="portfolio-brief" aria-label="Start the walkthrough">
      <h2>Start with the current brief</h2>
      <p>Open the seller brief, inspect an account and its sources, then choose Inspect saved missions. In the queue, Now/Next/Later shows saved unfinished work in newest-first order. If none exists, Plan a new mission is a separate choice.</p>
      <Link href={`/?${sellerQuery}`}>Open seller brief</Link>{" · "}
      <Link href={missionHref}>{mission ? "Resume selected mission" : account ? "Inspect this account’s saved missions" : "Choose an account in Missions"}</Link>
      <p className="caveat">Links retain supplied IDs only; the destination checks access and current records. This page does not verify that an account or mission exists.</p>
    </section>
    <ol aria-label="Seven mission steps">{stages.map(([title, text]) => <li key={title} className="portfolio-brief">
      <h2>{title}</h2><p>{text}</p>
      {mission && <Link href={`${missionHref}&step=${encodeURIComponent(title)}`}>Inspect {title} in selected mission</Link>}
    </li>)}</ol>
    <details><summary>If the journey stops</summary>
      <p>Refresh current state after an uncertain response. Inspect stale evidence recovery in Review, review decisions in Approval, and claims or reconciliation in Execution. Refresh failure keeps work paused. A viewer can inspect records but cannot prepare or execute; seller presentation never grants reviewer authority.</p>
    </details>
    <p><Link href="/tester-guide">Local simulation tester guide and feedback template</Link></p>
    <Link href={`/?${sellerQuery}`}>Return to seller workspace</Link>
  </main>;
}
