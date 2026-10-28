import { GuardrailsLab } from "@/components/guardrails-lab";
import { SessionGate } from "@/components/session-gate";

export default function Page() {
  return <SessionGate><GuardrailsLab /></SessionGate>;
}
