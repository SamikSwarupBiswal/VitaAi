import { Suspense } from "react";
import { IntelligencePage } from "@/components/intelligence-page";
import { SessionGate } from "@/components/session-gate";

export default function Page() {
  return <Suspense fallback={<p role="status">Loading intelligence…</p>}><SessionGate><IntelligencePage /></SessionGate></Suspense>;
}
