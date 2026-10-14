import { Suspense } from "react";
import { Workspace } from "@/components/workspace";

export default function AccountsPage() {
  return <Suspense fallback={<p className="loading">Loading accounts...</p>}><Workspace accountDirectory /></Suspense>;
}
