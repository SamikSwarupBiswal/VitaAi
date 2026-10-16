import { Suspense } from "react";
import { MissionWorkspace } from "@/components/mission-workspace";
import { SessionGate } from "@/components/session-gate";

export default function MissionsPage() {
  return <Suspense fallback={<p role="status">Loading missions...</p>}>
    <SessionGate><MissionWorkspace /></SessionGate>
  </Suspense>;
}
