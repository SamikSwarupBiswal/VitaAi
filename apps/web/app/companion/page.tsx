import { Suspense } from "react";
import { CompanionPage } from "@/components/companion-page";
import { SessionGate } from "@/components/session-gate";

export default function Page() {
  return <Suspense fallback={<p role="status">Loading companion…</p>}><SessionGate><CompanionPage /></SessionGate></Suspense>;
}
