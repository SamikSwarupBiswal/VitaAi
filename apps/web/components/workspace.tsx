"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Building2, Code2, Moon, PieChart, RefreshCw, Search, Settings, Sun } from "lucide-react";
import { api, currency, type AnalyzeRequest, type ModelRun, type Portfolio, type ProviderStatus } from "@/lib/api";
import { AccountDetail } from "./account-detail";
import { AccountTable, type SortKey } from "./account-table";
import { PipelinePanel } from "./pipeline-panel";
import { SessionGate } from "./session-gate";
import { HubSpotPanel } from "./hubspot-panel";
import { ResearchPanel } from "./research-panel";
import { ComparisonPanel } from "./comparison-panel";
import { SourceDetectionPanel } from "./source-detection-panel";
import { HubSpotIngestionPanel } from "./hubspot-ingestion-panel";
import { HubSpotRefreshPanel } from "./hubspot-refresh-panel";

export function Workspace({ accountDirectory = false }: { accountDirectory?: boolean }) {
  const params = useSearchParams();
  const requested = params.get("persona");
  const persona = requested === "executive" || requested === "seller" || requested === "operations" ? requested : null;
  if (!accountDirectory && ((!persona && !params.has("account")) || (requested !== null && !persona))) return <Entry />;
  return <SessionGate><WorkspaceContent accountDirectory={accountDirectory} persona={persona || "executive"} /></SessionGate>;
}

type Persona = "executive" | "seller" | "operations";

function PortfolioBriefing({ portfolio, persona, provider, runs, unavailable, onSelect }: {
  portfolio: Portfolio; persona: Persona; provider: ProviderStatus | null;
  runs: Record<string, ModelRun>; unavailable: boolean; onSelect: (id: string) => void;
}) {
  return <section className="portfolio-brief" aria-label={`${persona === "seller" ? "Seller" : "Executive"} briefing`}>
    <h2>{persona === "seller" ? "Your work brief" : "Portfolio briefing"}</h2>
    <p className="muted">Assessment date {portfolio.as_of}. Priorities follow server risk order across all accounts.</p>
    <p className="caveat">{portfolio.mode === "local_sample" ? "Synthetic sample" : portfolio.mode === "mixed" ? "Mixed synthetic and HubSpot sources" : "HubSpot sources"}. Recommendations are proposals; review evidence before acting.</p>
    {unavailable ? <p role="status">Briefing paused while portfolio data is refreshing or unavailable. Refresh successfully to inspect current priorities.</p>
      : <>{!provider?.configured && <p className="caveat">Model unavailable or unconfigured. This brief uses deterministic assessments.</p>}
        {provider?.status === "failed" && <p className="caveat">Provider reported a failure. No generated briefing is shown.</p>}
        {!portfolio.accounts.length && <p>No accounts available. No priorities can be established.</p>}
        <ol>{portfolio.accounts.slice(0, 5).map(view => {
          const { account, assessment } = view;
          const run = runs[account.id] || view.latest_run;
          const evidence = view.evidence.filter(item => item.account_id === account.id && item.organization_id === portfolio.organization_id);
          return <li key={account.id}>
            <button className="account-link" onClick={() => onSelect(account.id)}>{account.name} — inspect account evidence</button>
            {persona === "seller" && <p><Link href={`/missions?${new URLSearchParams({ account: account.id })}`}>Inspect saved missions for {account.name}</Link></p>}
            <p>{assessment.recommendation}</p>
            <p className="caveat">Risk {assessment.risk} / opportunity {assessment.opportunity} / confidence {assessment.confidence}%. {assessment.requires_review ? "Evidence review required." : "Deterministic assessment; human review required."}</p>
            <p className="caveat">{view.source?.kind === "hubspot" ? "HubSpot" : account.synthetic ? "Synthetic sample" : "Source unavailable"} / account revision {account.revision} / assessment {assessment.as_of}</p>
            {account.annual_value === null && <p className="caveat">Annual value unknown.</p>}
            {account.renewal_date === null && <p className="caveat">Renewal date unknown.</p>}
            {assessment.caveats.map(caveat => <p className="caveat" key={caveat}>{caveat}</p>)}
            <details><summary>Assessment sources and snapshot</summary>
              <p className="caveat">Snapshot {assessment.snapshot_hash}</p>
              {!evidence.length && <p>No account evidence available.</p>}
              <ul>{evidence.map(item => <li key={item.id}>{item.fact}<p className="caveat">{item.source} / record {item.source_record} / observed {item.observed_at} / evidence {item.id}{assessment.factors.some(factor => factor.evidence_id === item.id) ? " / used by assessment" : " / not used by assessment"}</p></li>)}</ul>
            </details>
            {run && <p className="caveat">Latest analysis: {run.status.replaceAll("_", " ")}{run.snapshot_hash !== assessment.snapshot_hash ? " / older snapshot; excluded from brief" : " / advisory; not used to rank priorities"}.</p>}
          </li>;
        })}</ol>
        {portfolio.accounts.length > 5 && <p className="caveat">Showing the first 5 of {portfolio.accounts.length} accounts. The table contains the full portfolio.</p>}
      </>}
  </section>;
}

const perspectives = [
  { id: "executive", label: "Executive", description: "Review portfolio priorities, score factors and source evidence." },
  { id: "seller", label: "Seller", description: "Prepare account conversations from the six-role intelligence pipeline." },
  { id: "operations", label: "Operations", description: "Inspect evidence freshness, model readiness and preparation traces." },
] as const;

function Entry() {
  const [previous, setPrevious] = useState<Persona | null>(null);
  useEffect(() => {
    let value: string | null = null;
    try {
      value = localStorage.getItem("vitaai-persona");
      document.documentElement.dataset.theme = localStorage.getItem("vitaai-theme") === "dark" ? "dark" : "light";
    } catch { /* Preference storage is optional. */ }
    if (value === "executive" || value === "seller" || value === "operations") {
      const persona = value;
      queueMicrotask(() => setPrevious(persona));
    }
  }, []);
  return <main className="entry"><Link href="/" className="brand">VitaAi</Link>
    <p className="muted">Account intelligence / local foundation</p>
    <h1>Find the next conversation in your customer signals.</h1>
    <p>Review evidence, understand deterministic priorities, and prepare your next step with NVIDIA Nemotron on Nebius.</p>
    <Link href="/walkthrough">Read the product walkthrough</Link>
    <nav aria-label="Choose a workspace perspective" className="persona-entry">
      {perspectives.map(item => <Link key={item.id} href={`/?persona=${item.id}`}><strong>{item.label}</strong><span>{item.description}</span><span>Open {item.label.toLowerCase()} workspace →</span></Link>)}
    </nav>
    {previous && <Link href={`/?persona=${previous}`}>Resume {previous} workspace</Link>}
    <p className="caveat">Account evidence identifies its source; the default portfolio is synthetic. Analysis and drafts are advisory. Governed missions require session identity and use simulation; external actions remain unavailable.</p>
  </main>;
}

function WorkspaceContent({ accountDirectory, persona }: { accountDirectory: boolean; persona: Persona }) {
  const router = useRouter();
  const params = useSearchParams();
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [provider, setProvider] = useState<ProviderStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<SortKey>("risk");
  const [descending, setDescending] = useState(true);
  const [dark, setDark] = useState(false);
  const [busyAccount, setBusyAccount] = useState<string | null>(null);
  const [runs, setRuns] = useState<Record<string, ModelRun>>({});
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [authorityBlocked, setAuthorityBlocked] = useState(false);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [sourceGeneration, setSourceGeneration] = useState(0);
  const [sourcePending, setSourcePending] = useState(false);
  const readController = useRef<AbortController | null>(null);
  const analysisController = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const selectedId = params.get("account");

  useEffect(() => {
    try { localStorage.setItem("vitaai-persona", persona); } catch { /* Preference storage is optional. */ }
  }, [persona]);

  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    try {
      const [data, status] = await Promise.all([api<Portfolio>("portfolio", { signal: controller.signal }),
        api<ProviderStatus>("providers/nebius", { signal: controller.signal })]);
      if (controller.signal.aborted) return;
      setPortfolio(data);
      setProvider(status);
      setAuthorityBlocked(false);
      setSourceGeneration(value => value + 1);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to load workspace.");
    } finally { if (!controller.signal.aborted) setLoading(false); }
  }, []);

  const invalidateAuthority = useCallback(() => {
    readController.current?.abort();
    analysisController.current?.abort();
    setBusyAccount(null); setRuns({}); setAnalysisError(null); setAuthorityBlocked(true);
  }, []);

  async function refreshSource(message: string) {
    if (!mounted.current) return;
    setSourcePending(false); setLoading(true); setError(null);
    setSourceNotice(message);
    await refresh();
  }

  useEffect(() => {
    let active = true;
    mounted.current = true;
    const controller = new AbortController();
    readController.current = controller;
    Promise.all([api<Portfolio>("portfolio", { signal: controller.signal }),
      api<ProviderStatus>("providers/nebius", { signal: controller.signal })])
      .then(([data, status]) => { if (!controller.signal.aborted) { setPortfolio(data); setProvider(status); } })
      .catch(error => { if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Unable to load workspace."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    const sourceChanged = () => { invalidateAuthority(); setLoading(true); setError(null); void refresh(); };
    window.addEventListener("vitaai-source-changed", sourceChanged);
    let theme = false;
    try { theme = localStorage.getItem("vitaai-theme") === "dark"; } catch { /* Preference storage is optional. */ }
    document.documentElement.dataset.theme = theme ? "dark" : "light";
    // External theme state is applied after hydration.
    queueMicrotask(() => { if (active) setDark(theme); });
    return () => { active = false; mounted.current = false; readController.current?.abort(); analysisController.current?.abort();
      window.removeEventListener("vitaai-source-changed", sourceChanged); };
  }, [refresh, invalidateAuthority]);

  const rows = useMemo(() => {
    const items = (portfolio?.accounts || []).filter(view =>
      view.account.name.toLowerCase().includes(query.toLowerCase()) &&
      (filter !== "attention" || view.assessment.needs_attention) &&
      (filter !== "growth" || view.assessment.growth_signal));
    return items.sort((a, b) => {
      const value = (view: typeof a) => sort === "name" ? view.account.name
        : sort === "value" ? view.account.annual_value
          : sort === "renewal" ? view.renewal_days : view.assessment[sort];
      const left = value(a), right = value(b);
      if (left === null) return right === null ? a.account.id.localeCompare(b.account.id) : 1;
      if (right === null) return -1;
      const comparison = typeof left === "string" && typeof right === "string"
        ? left.localeCompare(right) : Number(left) - Number(right);
      return (descending ? -comparison : comparison) || a.account.id.localeCompare(b.account.id);
    });
  }, [portfolio, query, filter, sort, descending]);
  const selected = rows.find(view => view.account.id === selectedId) || rows[0];
  const title = accountDirectory ? "Accounts" : persona === "seller" ? "Seller preparation" : persona === "operations" ? "Operations" : "Portfolio";
  const selectedQuery = `?persona=${persona}${selected ? `&account=${encodeURIComponent(selected.account.id)}` : ""}`;

  function selectAccount(id: string) {
    setAnalysisError(null);
    router.replace(`${accountDirectory ? "/accounts" : "/"}?persona=${persona}&account=${encodeURIComponent(id)}`, { scroll: false });
  }

  function openBriefAccount(id: string) {
    if (loading || error || authorityBlocked || !portfolio?.accounts.some(view => view.account.id === id)) return;
    setQuery(""); setFilter("all"); selectAccount(id);
  }

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    try { localStorage.setItem("vitaai-theme", next ? "dark" : "light"); } catch { /* Preference storage is optional. */ }
    document.documentElement.dataset.theme = next ? "dark" : "light";
  }

  async function analyze() {
    if (!selected || busyAccount || authorityBlocked) return;
    const view = selected;
    const controller = new AbortController();
    analysisController.current = controller;
    setBusyAccount(view.account.id);
    setAnalysisError(null);
    const body: AnalyzeRequest = {
      schema_version: "1", expected_revision: view.account.revision, expected_snapshot_hash: view.assessment.snapshot_hash,
    };
    try {
      const run = await api<ModelRun>(`accounts/${view.account.id}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: controller.signal,
      });
      if (!controller.signal.aborted) setRuns(previous => ({ ...previous, [view.account.id]: run }));
    } catch (error) { if (!controller.signal.aborted) setAnalysisError(error instanceof Error ? error.message : "Analysis failed."); }
    finally { if (!controller.signal.aborted) setBusyAccount(null); }
  }

  return <div className="workspace">
    <a href="#main" className="skip-link">Skip to accounts</a>
    <aside className="sidebar"><Link href="/" className="brand">VitaAi</Link>
      <span className="nav-label">Workspace</span><nav aria-label="Workspace">
        <Link href={`/${selectedQuery}`} className={!accountDirectory ? "active" : ""} aria-current={!accountDirectory ? "page" : undefined}><PieChart size={20} />Portfolio</Link>
        <Link href={`/accounts${selectedQuery}`} className={accountDirectory ? "active" : ""} aria-current={accountDirectory ? "page" : undefined}><Building2 size={20} />Accounts</Link>
        <Link href={`/missions${selected ? `?account=${encodeURIComponent(selected.account.id)}` : ""}`}>Missions</Link>
        <Link href={`/walkthrough${selected ? `?account=${encodeURIComponent(selected.account.id)}` : ""}`}>Walkthrough</Link>
      </nav><footer><p><Settings size={18} />Local workspace</p><p><Code2 size={18} />Local development</p></footer>
    </aside>
    <div className="workspace-body"><header className="topbar"><span>Workspace <span className="slash">/</span> <strong>{title}</strong></span>
      <label>Perspective <select aria-label="Workspace perspective" value={persona} onChange={event => router.replace(`${accountDirectory ? "/accounts" : "/"}?persona=${event.target.value}${selected ? `&account=${encodeURIComponent(selected.account.id)}` : ""}`, { scroll: false })}>
        {perspectives.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <button className="icon-button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>{dark ? <Moon size={22} /> : <Sun size={22} />}</button></header>
      <main id="main" className="main-grid"><div className="portfolio-main">
        <div className="page-heading"><div><h1>{title}</h1><p>{accountDirectory ? "Customer accounts and source evidence." : "Customer signals, ranked by attention."}</p></div>
          <button className="icon-button refresh" disabled={loading || sourcePending} aria-label="Refresh portfolio" title="Refresh portfolio" onClick={() => { setLoading(true); setError(null); void refresh(); }}><RefreshCw size={20} className={loading ? "spinning" : ""} /></button></div>
        {portfolio && <dl className="kpi-band"><div><dt>{portfolio.annual_value_missing_count ? "Known portfolio value" : "Portfolio value"}</dt><dd>{currency(portfolio.annual_value, true)}</dd></div>
          <div><dt>Accounts</dt><dd>{portfolio.accounts.length}</dd></div>
          <div><dt>Need attention</dt><dd className="risk-text">{portfolio.attention_count}</dd></div>
          <div><dt>Growth signals</dt><dd className="growth-text">{portfolio.growth_count}</dd></div></dl>}
        {!!portfolio?.annual_value_missing_count && <p className="caveat">{portfolio.annual_value_missing_count} account{portfolio.annual_value_missing_count === 1 ? " is" : "s are"} missing annual value. The total includes known values only.</p>}
        {portfolio && !accountDirectory && persona !== "operations" && <PortfolioBriefing portfolio={portfolio} persona={persona}
          provider={provider} runs={runs} unavailable={loading || !!error || authorityBlocked} onSelect={openBriefAccount} />}
        <div className="table-toolbar"><div className="filters" role="group" aria-label="Account filters">
          {[["all", "All accounts"], ["attention", "Needs attention"], ["growth", "Growth"]].map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? "active" : ""}
            onClick={() => { setFilter(key); setAnalysisError(null); }}>{label}</button>)}</div>
          <label className="search"><Search size={17} /><input aria-label="Search accounts" placeholder="Search accounts" value={query} onChange={event => { setQuery(event.target.value); setAnalysisError(null); }} /></label></div>
        {error && <p role="alert" className="error-banner">{error}</p>}
        {sourceNotice && <p role="status" className="caveat">{sourceNotice}</p>}
        {authorityBlocked && <p role="status">Source state is changing or needs refresh. Current account analysis and preparation are paused. Refresh portfolio if loading fails.</p>}
        {loading && !portfolio ? <p role="status" className="loading">Loading accounts...</p>
          : <AccountTable rows={rows} selectedId={selected?.account.id} onSelect={selectAccount} sort={sort} descending={descending} onSort={key => { setDescending(sort === key ? !descending : key !== "name"); setSort(key); }} />}
        {portfolio && <p className="data-stamp">{portfolio.mode === "mixed" ? "Mixed HubSpot and synthetic sources" : portfolio.mode === "hubspot" ? "HubSpot source" : "Sample CRM"} / assessment {portfolio.as_of}</p>}
        {portfolio && persona === "operations" && <p className="data-stamp">Model: {provider?.configured ? "Configured; inspect individual runs for validation." : "Unconfigured."} Evidence assessment: {portfolio.as_of}. External execution unavailable.</p>}
        {selected && <HubSpotPanel view={selected} key={`${selected.account.id}:${selected.account.revision}:${sourceGeneration}`}
          blocked={authorityBlocked} onInvalidate={() => { setSourcePending(true); invalidateAuthority(); }} onRefresh={refreshSource} />}
        {selected && !authorityBlocked && <ComparisonPanel view={selected} key={`${selected.account.id}:${selected.account.revision}:${sourceGeneration}`} />}
        {selected && !authorityBlocked && <ResearchPanel view={selected} key={`${selected.account.id}:${selected.account.revision}:${sourceGeneration}`} />}
        {selected && !authorityBlocked && <SourceDetectionPanel view={selected} key={`${selected.account.id}:${selected.account.revision}:${sourceGeneration}`} />}
        {selected && !authorityBlocked && <HubSpotRefreshPanel view={selected} key={`${selected.account.id}:${selected.account.revision}:${sourceGeneration}`} />}
        {selected && !authorityBlocked && <HubSpotIngestionPanel view={selected} key={`${selected.account.id}:${selected.account.revision}:${sourceGeneration}`} />}
        {portfolio && !authorityBlocked && <PipelinePanel onSelect={selectAccount} organizationId={portfolio.organization_id}
          snapshots={Object.fromEntries(portfolio.accounts.map(view => [view.account.id, view.assessment.snapshot_hash]))}
          configured={provider?.configured || false} key={persona} expanded={persona === "seller"} />}
      </div>
      {selected && !authorityBlocked && <AccountDetail view={selected} provider={provider} busy={busyAccount !== null} onAnalyze={analyze}
        run={runs[selected.account.id] || null} error={analysisError} />}
      </main>
    </div>
  </div>;
}
