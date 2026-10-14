import { ChartNoAxesColumn, LoaderCircle } from "lucide-react";
import type { AccountView, ModelRun, ProviderStatus } from "@/lib/api";

export function AccountDetail({ view, provider, busy, onAnalyze, run, error }: {
  view: AccountView; provider: ProviderStatus | null; busy: boolean;
  onAnalyze: () => void; run: ModelRun | null; error: string | null;
}) {
  const { account, assessment } = view;
  const currentRun = run || view.latest_run;
  const staleRun = currentRun && currentRun.snapshot_hash !== assessment.snapshot_hash;
  return <aside className="detail-rail" aria-label="Account details">
    <h2>{account.name}</h2><p className="industry">{account.industry}</p>
    <section><h3>Health and signals</h3>
      <div className="health"><div><span className="muted">Health</span><strong>{assessment.health}</strong></div>
        <meter min="0" max="100" value={assessment.health} low={45} high={70} optimum={100}
          aria-label={`${account.name} health`} /></div>
      <dl className="signal-stats"><div><dt>Risk</dt><dd className="risk-text">{assessment.risk}</dd></div>
        <div><dt>Opportunity</dt><dd className="growth-text">{assessment.opportunity}</dd></div>
        <div><dt>Renewal</dt><dd>{view.renewal_days} days</dd></div></dl>
    </section>
    <section><h3>Evidence</h3><div className="evidence-list">
      {view.evidence.map(item => <details key={item.id} id={`evidence-${item.id}`}>
        <summary><span>{item.fact}</span><small>{item.source}</small></summary>
        <dl><div><dt>Observed</dt><dd>{new Date(item.observed_at).toLocaleString()}</dd></div>
          <div><dt>Source record</dt><dd>{item.source_record}</dd></div>
          <div><dt>Polarity</dt><dd>{item.polarity}</dd></div></dl>
      </details>)}
    </div></section>
    <section><h3>Assessment</h3><p>{assessment.recommendation}</p>
      <p className="muted">Confidence {assessment.confidence}%</p>
      {assessment.caveats.map(caveat => <p className="caveat" key={caveat}>{caveat}</p>)}
      <details className="score-details"><summary>Score factors</summary>
        <dl>{assessment.factors.map(factor => <div key={factor.metric}><dt>{factor.metric.replaceAll("_", " ")}</dt>
          <dd>Risk +{factor.risk_contribution}; opportunity +{factor.opportunity_contribution}</dd></div>)}</dl>
        <p className="caveat">Policy {assessment.policy_version} / revision {account.revision}</p>
      </details>
      <button className="primary analyze" disabled={busy || !provider?.configured} onClick={onAnalyze}>
        {busy ? <LoaderCircle size={18} className="spinning" /> : <ChartNoAxesColumn size={18} />}
        {busy ? "Analyzing..." : "Analyze with Nebius"}
      </button>
      <p className="caveat">{provider?.configured ? `${provider.model} / ${provider.status.replaceAll("_", " ")}` : "Nebius not configured."}</p>
      {error && <p role="alert" className="risk-text">{error}</p>}
    </section>
    {currentRun && <section className="analysis-result" aria-live="polite"><h3>Nebius analysis</h3>
      <p className="caveat">{currentRun.status.replaceAll("_", " ")} / {currentRun.validation.replaceAll("_", " ")}</p>
      {staleRun && <p className="risk-text">This analysis belongs to an older snapshot.</p>}
      {currentRun.error_code && <p className="risk-text">{currentRun.error_code.replaceAll("_", " ")}</p>}
      {currentRun.analysis && <>
        <h4>Findings</h4>{currentRun.analysis.findings.map((finding, index) => <div key={index}><p>{finding.text}</p>
          <div className="citations">{finding.evidence_ids.map(id => <a key={id} href={`#evidence-${id}`} onClick={() => {
            document.getElementById(`evidence-${id}`)?.setAttribute("open", "");
          }}>Source {view.evidence.findIndex(item => item.id === id) + 1}</a>)}</div></div>)}
        <h4>Proposed next steps</h4>{currentRun.analysis.next_steps.map((finding, index) => <p key={index}>{finding.text}</p>)}
        {currentRun.analysis.caveats.map(caveat => <p key={caveat} className="caveat">{caveat}</p>)}
        <p className="caveat">Advisory output. References checked; factual claims require review.</p>
      </>}
      <p className="caveat">{currentRun.latency_ms} ms / {new Date(currentRun.started_at).toLocaleString()}</p>
    </section>}
  </aside>;
}
