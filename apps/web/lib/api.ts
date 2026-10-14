import type { components } from "./api.generated";

export type Portfolio = components["schemas"]["Portfolio"];
export type AccountView = components["schemas"]["AccountView"];
export type ModelRun = components["schemas"]["ModelRun"];
export type ProviderStatus = components["schemas"]["ProviderStatus"];
export type AnalyzeRequest = components["schemas"]["AnalyzeRequest"];
export type SessionView = components["schemas"]["SessionView"];
export type PipelineRun = components["schemas"]["PipelineRun"];
export type PipelineRequest = components["schemas"]["PipelineRequest"];

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.method === "POST") headers.set("X-VitaAi-Request", "1");
  const response = await fetch(`/api/${path}`, { ...init, headers, cache: "no-store" });
  if (!response.ok) {
    if (response.status === 401 && path !== "auth/login") {
      window.dispatchEvent(new Event("vitaai-session-expired"));
    }
    if (path === "auth/login") throw new Error("Sign-in failed. Check credentials or retry later.");
    if (response.status === 403) throw new Error("Your role cannot perform this action.");
    throw new Error(response.status === 409
      ? "Account snapshot changed. Refresh and try again."
      : response.status === 503
        ? "API unavailable. Check the local API server."
        : `Request failed (${response.status}). Please retry.`);
  }
  return response.json() as Promise<T>;
}

export function currency(value: number, compact = false): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency", currency: "USD", maximumFractionDigits: compact ? 2 : 0,
    notation: compact ? "compact" : "standard",
  }).format(value);
}
