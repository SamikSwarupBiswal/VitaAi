"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type AccountView } from "@/lib/api";
import { savedRunId } from "@/lib/pipeline-history";
import { CompanionPanel } from "./companion-panel";
import { PlatformAdmin } from "./platform-admin";
import { useSession } from "./session-gate";

export function CompanionPage() {
  const account = useSearchParams().get("account"), actor = useSession()?.actor;
  if (!account || !savedRunId.test(account) || !actor) return <main><h1>Workspace companion</h1><p>Select an accessible account to begin.</p><a href="/accounts">Open accounts</a></main>;
  return <SelectedCompanion account={account} organization={actor.organization_id} key={JSON.stringify([actor.id, actor.role, actor.organization_id, account])} />;
}

function SelectedCompanion({ account, organization }: { account: string; organization: string }) {
  const [view, setView] = useState<AccountView | null>(null), [error, setError] = useState(false);
  useEffect(() => {
    let controller: AbortController | null = null;
    const read = () => {
      controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      setView(null); setError(false);
      api<AccountView>(`accounts/${account}`, { signal }).then(value => {
        if (signal.aborted) return;
        if (value.account.id !== account || value.account.organization_id !== organization) throw new Error("Scope changed");
        setView(value);
      }).catch(() => { if (!signal.aborted) setError(true); });
    };
    read(); const events = ["focus", "vitaai-source-changed", "vitaai-workflow-changed"];
    events.forEach(event => window.addEventListener(event, read));
    return () => { controller?.abort(); events.forEach(event => window.removeEventListener(event, read)); };
  }, [account, organization]);
  return <main><h1>Workspace companion</h1><a href={`/accounts?${new URLSearchParams({ account })}`}>Return to account workspace</a>
    {error ? <p role="alert">Account unavailable. Return to accounts and refresh.</p> : view ? <><h2>{view.account.name}</h2><CompanionPanel view={view} /><PlatformAdmin /></> : <p role="status">Reading selected account…</p>}</main>;
}
