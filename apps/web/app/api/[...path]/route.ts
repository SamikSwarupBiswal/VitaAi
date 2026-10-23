import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const host = request.headers.get("host");
  if (!host || !/^(localhost|127\.0\.0\.1)(:[0-9]{1,5})?$/.test(host)) {
    return NextResponse.json({ detail: "This foundation is available only on localhost" }, { status: 403 });
  }
  const origin = request.headers.get("origin");
  if (request.method === "POST" && origin && origin !== `${request.nextUrl.protocol}//${host}`) {
    return NextResponse.json({ detail: "Untrusted request origin" }, { status: 403 });
  }
  const { path } = await context.params;
  const joined = path.join("/");
  const accountPath = /^accounts\/[a-f0-9-]{36}$/;
  const analyzePath = /^accounts\/[a-f0-9-]{36}\/analyze$/;
  const pipelinePath = /^pipeline\/[a-f0-9-]{36}$/;
  const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
  const workflowRead = new RegExp(`^(?:plans/${uuid}|plans/runs/${uuid}|missions(?:/${uuid}(?:/(?:audit|actions|outcomes))?)?|actions/${uuid}(?:/(?:history|decisions|executions))?|executions/${uuid}|receipts/${uuid})$`);
  const workflowWrite = new RegExp(`^(?:plans(?:/generate)?|missions(?:/${uuid}/(?:prepare|supersede|outcomes))?|actions/${uuid}/(?:submit|review|renew-review|execute)|executions/${uuid}/(?:reconcile|retry))$`);
  const workflowPath = request.method === "GET" ? workflowRead.test(joined) : workflowWrite.test(joined);
  const hubspotPath = request.method === "GET"
    ? new RegExp(`^integrations/hubspot(?:/(?:runs|observations|sources|detections)/${uuid}|/refresh-occurrences/${uuid}(?:/recovery-readiness)?|/ingestions/${uuid}(?:/recovery-readiness)?|/detections/${uuid}/mission|/accounts/${uuid}/(?:preview|connection-readiness|execution-readiness|detections|refresh-schedule|refresh-occurrences|ingestions(?:/readiness)?))?$`).test(joined)
    : request.method === "POST" && new RegExp(`^integrations/hubspot/(?:accounts/${uuid}/(?:sync|probe|seed-preview|promote|restore-sample|detect-changes|refresh-schedule(?:/revoke)?|ingestions)|refresh-occurrences/${uuid}/recover|ingestions/${uuid}/recover|detections/${uuid}/mission)$`).test(joined);
  // Callback stays on the fixed API redirect; codes/state never enter the Next proxy.
  const microsoftPath = request.method === "GET"
    ? new RegExp(`^integrations/microsoft(?:/missions/${uuid}/execution-readiness)?$`).test(joined)
    : request.method === "POST" && /^integrations\/microsoft\/(?:connect|signout|refresh)$/.test(joined);
  const researchPath = request.method === "GET"
    ? new RegExp(`^integrations/research(?:/runs/${uuid}(?:/recovery-readiness|/context|/narrative-readiness|/narratives)?|/narratives/${uuid}(?:/recovery-readiness)?|/accounts/${uuid}/(?:runs|readiness))?$`).test(joined)
    : request.method === "POST" && new RegExp(`^integrations/research/(?:accounts/${uuid}/search|runs/${uuid}/(?:recover|narratives)|narratives/${uuid}/recover)$`).test(joined);
  const comparisonPath = request.method === "GET"
    ? new RegExp(`^provider-comparison/(?:catalog|runs/${uuid}(?:/recovery-readiness)?|accounts/${uuid}/(?:runs|readiness)|providers/(?:nebius|openai|anthropic|nvidia|foundry)/(?:test-readiness|tests)|tests/${uuid}(?:/recovery-readiness)?)$`).test(joined)
    : request.method === "POST" && new RegExp(`^provider-comparison/(?:providers/(?:nebius|openai|anthropic|nvidia|foundry)/(?:discover|test)|accounts/${uuid}/compare|(?:runs|tests)/${uuid}/recover)$`).test(joined);
  const allowed = request.method === "GET"
    ? workflowPath || hubspotPath || microsoftPath || researchPath || comparisonPath || joined === "portfolio" || joined === "providers/nebius" || joined === "auth/session" || accountPath.test(joined) || pipelinePath.test(joined)
    : workflowPath || hubspotPath || microsoftPath || researchPath || comparisonPath || joined === "providers/nebius/discover" || joined === "auth/login" || joined === "auth/logout" || joined === "pipeline" || analyzePath.test(joined);
  if (!allowed) return NextResponse.json({ detail: "Route not found" }, { status: 404 });
  try {
    const body = request.method === "POST" ? await request.text() : undefined;
    if (body && body.length > (workflowPath ? 262144 : 4096)) {
      return NextResponse.json({ detail: "Request too large" }, { status: 413 });
    }
    const upstream = await fetch(`http://127.0.0.1:8000/api/${joined}`, {
      method: request.method, body, cache: "no-store",
      headers: {
        "Content-Type": "application/json", ...(origin ? { Origin: origin }
          : microsoftPath && request.method === "POST" ? { Origin: `${request.nextUrl.protocol}//${host}` } : {}),
        ...(request.headers.get("x-vitaai-request") === "1" ? { "X-VitaAi-Request": "1" } : {}),
        ...(request.cookies.get("vitaai_session") ? { Cookie: `vitaai_session=${encodeURIComponent(request.cookies.get("vitaai_session")!.value)}` } : {}),
      },
      signal: AbortSignal.timeout(70000),
    });
    if (upstream.status >= 500) {
      return NextResponse.json({ detail: "API failed to complete the request" }, { status: 502 });
    }
    const response = NextResponse.json(await upstream.json(), { status: upstream.status });
    response.headers.set("Cache-Control", "no-store");
    if (microsoftPath) response.headers.set("Referrer-Policy", "no-referrer");
    for (const cookie of upstream.headers.getSetCookie()) {
      if (cookie.startsWith("vitaai_session=") || (request.method === "POST"
        && /^integrations\/microsoft\/(?:connect|signout)$/.test(joined)
        && cookie.startsWith("vitaai_microsoft_flow="))) response.headers.append("Set-Cookie", cookie);
    }
    return response;
  } catch {
    return NextResponse.json({ detail: "API unavailable. Check the local API server." }, { status: 503 });
  }
}

export { proxy as GET, proxy as POST };
