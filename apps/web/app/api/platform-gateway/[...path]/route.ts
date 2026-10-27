import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
function error(status: number, detail: string) {
  return NextResponse.json({ detail }, { status, headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const origin = process.env.VITAAI_WEB_ORIGIN;
  let configured: URL;
  try { configured = new URL(origin ?? ""); } catch { return error(503, "Platform web origin is not configured"); }
  if (configured.protocol !== "https:" || configured.origin !== origin || configured.username || configured.password
      || configured.port || request.headers.get("host") !== configured.host) return error(403, "Untrusted platform host");
  if (request.headers.get("origin") && request.headers.get("origin") !== configured.origin) return error(403, "Untrusted platform origin");
  const { path } = await context.params, joined = path.join("/");
  const allowed = request.method === "GET" ? new RegExp(`^context/${uuid}$`).test(joined)
    : request.method === "POST" && ["preparation", "teams/activity"].includes(joined);
  if (!allowed) return error(404, "Platform route not found");
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [A-Za-z0-9_.-]{1,16384}$/.test(authorization)) return error(401, "Platform token required");
  let body: string | undefined;
  if (request.method === "POST") {
    const reader = request.body?.getReader(), chunks: Uint8Array[] = []; let length = 0;
    if (!reader) return error(422, "Missing platform request");
    while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length;
      if (length > 16384) { await reader.cancel(); return error(413, "Platform request too large"); } chunks.push(part.value); }
    const buffer = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
    try { body = new TextDecoder("utf-8", { fatal: true }).decode(buffer); JSON.parse(body); }
    catch { return error(422, "Invalid platform request"); }
  }
  try {
    const response = await fetch(`http://127.0.0.1:8000/api/platform/${joined}`, {
      method: request.method, body, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
      headers: { Authorization: authorization, "Content-Type": "application/json" },
    });
    if (!response.ok) return error(response.status >= 500 ? 503 : response.status, "Platform request unavailable or changed");
    return NextResponse.json(await response.json(), { headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch { return error(503, "Platform API unavailable"); }
}
export { proxy as GET, proxy as POST };
export async function HEAD() { return error(405, "Method not allowed"); }
