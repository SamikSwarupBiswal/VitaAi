"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Building2, Code2, Moon, PieChart, RefreshCw, Search, Settings, Sun } from "lucide-react";
import { api, currency, type AnalyzeRequest, type ModelRun, type Portfolio, type ProviderStatus } from "@/lib/api";
import { AccountDetail } from "./account-detail";
import { AccountTable, type SortKey } from "./account-table";
import { PipelinePanel } from "./pipeline-panel";
import { SessionGate } from "./session-gate";

export function Workspace({ accountDirectory = false }: { accountDirectory?: boolean }) {
  const params = useSearchParams();
  const requested = params.get("persona");
  const persona = requested === "executive" || requested === "seller" || requested === "operations" ? requested : null;
  if (!accountDirectory && ((!persona && !params.has("account")) || (requested !== null && !persona))) return <Entry />;
  return <SessionGate><WorkspaceContent accountDirectory={accountDirectory} persona={persona || "executive"} /></SessionGate>;
}

type Persona = "executive" | "seller" | "operations";
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
    <nav aria-label="Choose a workspace perspective" className="persona-entry">
      {perspectives.map(item => <Link key={item.id} href={`/?persona=${item.id}`}><strong>{item.label}</strong><span>{item.description}</span><span>Open {item.label.toLowerCase()} workspace →</span></Link>)}
    </nav>
    {previous && <Link href={`/?persona=${previous}`}>Resume {previous} workspace</Link>}
    <p className="caveat">This build uses synthetic account evidence. Analysis and drafts are advisory. Governed missions require session identity and use simulation; external actions remain unavailable.</p>
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
  const selectedId = params.get("account");

  useEffect(() => {
    try { localStorage.setItem("vitaai-persona", persona); } catch { /* Preference storage is optional. */ }
  }, [persona]);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [data, status] = await Promise.all([api<Portfolio>("portfolio"), api<ProviderStatus>("providers/nebius")]);
      setPortfolio(data);
      setProvider(status);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Unable to load workspace.");
    } finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    Promise.all([api<Portfolio>("portfolio"), api<ProviderStatus>("providers/nebius")])
      .then(([data, status]) => { if (active) { setPortfolio(data); setProvider(status); } })
      .catch(error => { if (active) setError(error instanceof Error ? error.message : "Unable to load workspace."); })
      .finally(() => { if (active) setLoading(false); });
    let theme = false;
    try { theme = localStorage.getItem("vitaai-theme") === "dark"; } catch { /* Preference storage is optional. */ }
    document.documentElement.dataset.theme = theme ? "dark" : "light";
    // External theme state is applied after hydration.
    queueMicrotask(() => { if (active) setDark(theme); });
    return () => { active = false; };
  }, []);

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

  function toggleTheme() {
    const next = !dark;
    setDark(next);
    try { localStorage.setItem("vitaai-theme", next ? "dark" : "light"); } catch { /* Preference storage is optional. */ }
    document.documentElement.dataset.theme = next ? "dark" : "light";
  }

  async function analyze() {
    if (!selected || busyAccount) return;
    const view = selected;
    setBusyAccount(view.account.id);
    setAnalysisError(null);
    const body: AnalyzeRequest = {
      schema_version: "1", expected_revision: view.account.revision, expected_snapshot_hash: view.assessment.snapshot_hash,
    };
    try {
      const run = await api<ModelRun>(`accounts/${view.account.id}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      setRuns(previous => ({ ...previous, [view.account.id]: run }));
    } catch (error) { setAnalysisError(error instanceof Error ? error.message : "Analysis failed."); }
    finally { setBusyAccount(null); }
  }

  return <div className="workspace">
    <a href="#main" className="skip-link">Skip to accounts</a>
    <aside className="sidebar"><Link href="/" className="brand">VitaAi</Link>
      <span className="nav-label">Workspace</span><nav aria-label="Workspace">
        <Link href={`/${selectedQuery}`} className={!accountDirectory ? "active" : ""} aria-current={!accountDirectory ? "page" : undefined}><PieChart size={20} />Portfolio</Link>
        <Link href={`/accounts${selectedQuery}`} className={accountDirectory ? "active" : ""} aria-current={accountDirectory ? "page" : undefined}><Building2 size={20} />Accounts</Link>
        <Link href={`/missions${selected ? `?account=${encodeURIComponent(selected.account.id)}` : ""}`}>Missions</Link>
      </nav><footer><p><Settings size={18} />Sample workspace</p><p><Code2 size={18} />Local development</p></footer>
    </aside>
    <div className="workspace-body"><header className="topbar"><span>Workspace <span className="slash">/</span> <strong>{title}</strong></span>
      <label>Perspective <select aria-label="Workspace perspective" value={persona} onChange={event => router.replace(`${accountDirectory ? "/accounts" : "/"}?persona=${event.target.value}${selected ? `&account=${encodeURIComponent(selected.account.id)}` : ""}`, { scroll: false })}>
        {perspectives.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
      </select></label>
      <button className="icon-button" aria-label={dark ? "Switch to light theme" : "Switch to dark theme"} title={dark ? "Light theme" : "Dark theme"} onClick={toggleTheme}>{dark ? <Moon size={22} /> : <Sun size={22} />}</button></header>
      <main id="main" className="main-grid"><div className="portfolio-main">
        <div className="page-heading"><div><h1>{title}</h1><p>{accountDirectory ? "Customer accounts and source evidence." : "Customer signals, ranked by attention."}</p></div>
          <button className="icon-button refresh" disabled={loading} aria-label="Refresh portfolio" title="Refresh portfolio" onClick={refresh}><RefreshCw size={20} className={loading ? "spinning" : ""} /></button></div>
        {portfolio && <dl className="kpi-band"><div><dt>{portfolio.annual_value_missing_count ? "Known portfolio value" : "Portfolio value"}</dt><dd>{currency(portfolio.annual_value, true)}</dd></div>
          <div><dt>Accounts</dt><dd>{portfolio.accounts.length}</dd></div>
          <div><dt>Need attention</dt><dd className="risk-text">{portfolio.attention_count}</dd></div>
          <div><dt>Growth signals</dt><dd className="growth-text">{portfolio.growth_count}</dd></div></dl>}
        {!!portfolio?.annual_value_missing_count && <p className="caveat">{portfolio.annual_value_missing_count} account{portfolio.annual_value_missing_count === 1 ? " is" : "s are"} missing annual value. The total includes known values only.</p>}
        <div className="table-toolbar"><div className="filters" role="group" aria-label="Account filters">
          {[["all", "All accounts"], ["attention", "Needs attention"], ["growth", "Growth"]].map(([key, label]) => <button key={key} aria-pressed={filter === key} className={filter === key ? "active" : ""}
            onClick={() => { setFilter(key); setAnalysisError(null); }}>{label}</button>)}</div>
          <label className="search"><Search size={17} /><input aria-label="Search accounts" placeholder="Search accounts" value={query} onChange={event => { setQuery(event.target.value); setAnalysisError(null); }} /></label></div>
        {error && <p role="alert" className="error-banner">{error}</p>}
        {loading && !portfolio ? <p role="status" className="loading">Loading accounts...</p>
          : <AccountTable rows={rows} selectedId={selected?.account.id} onSelect={selectAccount} sort={sort} descending={descending} onSort={key => { setDescending(sort === key ? !descending : key !== "name"); setSort(key); }} />}
        {portfolio && <p className="data-stamp">Sample CRM / assessment {portfolio.as_of}</p>}
        {portfolio && persona === "operations" && <p className="data-stamp">Model: {provider?.configured ? "Configured; inspect individual runs for validation." : "Unconfigured."} Evidence assessment: {portfolio.as_of}. External execution unavailable.</p>}
        {portfolio && <PipelinePanel onSelect={selectAccount} organizationId={portfolio.organization_id} configured={provider?.configured || false} key={persona} expanded={persona === "seller"} />}
      </div>
      {selected && <AccountDetail view={selected} provider={provider} busy={busyAccount !== null} onAnalyze={analyze}
        run={runs[selected.account.id] || null} error={analysisError} />}
      </main>
    </div>
  </div>;
}
