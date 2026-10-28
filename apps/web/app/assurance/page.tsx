import { AssurancePage } from "@/components/assurance-page";
import { SessionGate } from "@/components/session-gate";

export default function Page() {
  return <SessionGate><AssurancePage /></SessionGate>;
}
