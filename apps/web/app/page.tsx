import { Suspense } from "react";
import { Workspace } from "@/components/workspace";

export default function Page() {
  return <Suspense fallback={<p className="loading">Loading workspace...</p>}><Workspace /></Suspense>;
}
