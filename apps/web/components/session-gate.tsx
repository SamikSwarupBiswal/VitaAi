"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type SessionView } from "@/lib/api";

export function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    api<SessionView>("auth/session")
      .then(value => { if (active) setSession(value); })
      .catch(() => { if (active) setError("Unable to load session. Check the API, then reload."); });
    const expire = () => { setSession({ schema_version: "1", mode: "session", actor: null }); };
    window.addEventListener("vitaai-session-expired", expire);
    return () => { active = false; window.removeEventListener("vitaai-session-expired", expire); };
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    setBusy(true);
    setError(null);
    try {
      const value = await api<SessionView>("auth/login", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: values.get("username"), password: values.get("password") }),
      });
      form.reset();
      setSession(value);
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { setBusy(false); }
  }

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await api<SessionView>("auth/logout", { method: "POST" });
      setSession({ schema_version: "1", mode: "session", actor: null });
    } catch { setError("Sign-out failed. Retry to revoke this session."); }
    finally { setBusy(false); }
  }

  if (!session) return <main className="signin"><p role={error ? "alert" : "status"}>{error || "Loading session..."}</p></main>;
  if (session.mode === "sample") return children;
  if (session.actor) return <>
    <div className="session-bar"><span>{session.actor.username} · {session.actor.organization_id} · {session.actor.role}</span>
      <button onClick={logout} disabled={busy}>Sign out</button>{error && <span role="alert">{error}</span>}</div>
    {children}
  </>;
  return <main className="signin"><h1>VitaAi</h1><p>Sign in to your workspace.</p>
    <form onSubmit={login}>
      <label>Username<input name="username" autoComplete="username" required maxLength={80} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      {error && <p role="alert" className="error-banner">{error}</p>}
    </form>
  </main>;
}
