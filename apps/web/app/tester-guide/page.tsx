import Link from "next/link";
import { TesterGuideExports } from "@/components/tester-guide-exports";
import { guideIntro, guidePrerequisites, guideSteps, guideVersion } from "@/lib/tester-guide";

export const metadata = { title: "VitaAi | Local simulation tester guide" };

export default function TesterGuidePage() {
  return <main className="entry">
    <Link href="/" className="brand">VitaAi</Link>
    <h1>Local simulation tester guide</h1><p>Guide version: {guideVersion}</p>
    <p>{guideIntro}</p>
    <section className="portfolio-brief" aria-label="Before testing"><h2>Before testing</h2><p>{guidePrerequisites}</p></section>
    <p><Link href="/?persona=seller">Open seller workspace</Link>{" · "}<Link href="/walkthrough">Open mission walkthrough</Link></p>
    <ol aria-label="Local simulation test steps">{guideSteps.map(step => <li key={step.title} className="portfolio-brief">
      <h2>{step.title}</h2><p>{step.action}</p><p><strong>Expected observation: </strong>{step.expected}</p>
    </li>)}</ol>
    <TesterGuideExports />
  </main>;
}
