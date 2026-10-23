export const guideVersion = "local-simulation-guide-1";
export const guideIntro = "Test only an operator-provided synthetic workspace. This guide describes expected observations, not completed tests. Reading, copying or downloading it makes no private API, model or provider request and grants no approval.";
export const guidePrerequisites = "Follow README local setup first. An operator must provide session identity, authorized seller and reviewer/admin access, and a synthetic account with current complete evidence. Sample mode alone cannot run missions. If evidence is missing or stale, record the blocker; never change dates or facts just to pass. Keep live modes and paid Nebius planning off for this test.";
export const guideSteps = [
  { title: "Inspect the seller brief", action: "Open the Seller perspective, inspect a synthetic account and expand its sources. Choose Inspect saved missions for that exact account.", expected: "Account identity, source dates, revision and caveats remain consistent. Unknown values remain Unknown; navigation grants no action authority." },
  { title: "Create a deterministic task plan", action: "In Missions choose Plan a new mission. Select a supported focus such as risk and Action CRM task. Leave Two-step follow-up alternatives and Use Nebius unchecked. Create plan, select its saved alternative, then Start selected mission.", expected: "A saved deterministic plan and draft mission appear. Missing/stale evidence or monitor/manual-review focus may block planning; record the blocker instead of bypassing it." },
  { title: "Check Review and Evidence", action: "Read the mission recommendation and original evidence. Record the displayed mission/account revisions for your own test notes.", expected: "The selected account and evidence agree. Stale evidence is disclosed and can prevent new preparation; viewing a step never advances lifecycle." },
  { title: "Prepare the simulation preview", action: "In Outreach keep Simulation selected, enter an explicitly synthetic title/body, and choose Save simulation CRM task preview. Inspect the exact saved text. CRM Note needs no preparation for this single-task plan.", expected: "Saved content, destination, mode and binding hash are visible. Editing saved content invalidates previous review. No customer or CRM is contacted." },
  { title: "Submit and review the exact action", action: "In Approval choose Submit saved CRM task for review. Sign in using the operator-provided reviewer/admin identity, reopen the same mission, inspect its exact preview, select Approve exact preview and choose Record review decision.", expected: "The authenticated decision binds that saved revision/hash. Seller presentation cannot grant reviewer authority. Rejected, revision-required, expired or changed submissions cannot execute." },
  { title: "Execute the simulation once", action: "In Execution choose Execute simulated CRM task only after the current approval permits it. Inspect its claim, receipt and independent simulation readback. Refresh the page after completion.", expected: "The saved simulation receipt/readback remains visible after reload without another dispatch. It does not prove external delivery. If a result is unknown, stop and inspect reviewer reconciliation; never repeat a write blindly." },
  { title: "Record an explicit human follow-up", action: "In Outcome select the saved simulation receipt, choose follow up required, enter a clearly synthetic human report, and choose Record outcome. Inspect history, then reload.", expected: "A separately labeled manual_report and completed mission persist. Simulation cannot prove customer contact or revenue change. The mission leaves unfinished work while remaining in history." },
  { title: "Review coaching without customer authority", action: "As reviewer/admin, record a human coaching note with Reviewed or Revision required. Append a coaching revision. If testing an outcome correction, keep its original report and review the corrected report explicitly.", expected: "Coaching history preserves original actor/date/mission/report revisions; earlier report reviews stay historical. Seller/viewer can read but cannot review. Coaching grants no customer-action approval, assignment or notification." },
  { title: "Check rejection in separate work", action: "If the operator authorizes another synthetic mission, repeat preparation/submission and record Reject or Request revision with a reason instead of approval. Inspect Execution without dispatching.", expected: "Execution stays blocked. Editing requires fresh exact review; a guide, role label or generated phrase cannot manufacture approval, receipt or completion." },
  { title: "Report actual observations", action: "Copy the feedback template below or select its text manually. Record only what you actually observed, including failures and the local simulation evidence tier. Share it separately only with an intended recipient.", expected: "Copy/download does not send feedback. Remove credentials, customer text and private records before sharing. Live integrations, model factual quality, hosted behavior and full-product acceptance require separate evidence." },
] as const;

export const feedbackTemplate = `VitaAi tester feedback (${guideVersion})
Date/time and timezone:
Build/commit tested:
Browser/device:
Evidence tier (local simulation / other, specify):
Step and route (omit private IDs if sharing):
Action taken:
Expected result:
Actual result or blocker:
Observed mode and record revisions:
Reload result:
Screenshot filename (review/redact before sharing):
Severity and impact:
No secrets or customer text included:

This is a blank template, not a test result. Copying does not submit feedback.`;

export const guideText = ["VitaAi local simulation tester guide", guideVersion, guideIntro, guidePrerequisites,
  ...guideSteps.map((step, index) => `${index + 1}. ${step.title}\nAction: ${step.action}\nExpected: ${step.expected}`),
  feedbackTemplate].join("\n\n");
