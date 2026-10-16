"use client";

import { createContext, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, type SessionView } from "@/lib/api";

const SessionContext = createContext<SessionView | null>(null);
export function useSession() { return useContext(SessionContext); }

export function SessionGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestSequence = useRef(0);
  const authMutation = useRef(false);

  useEffect(() => {
    let active = true;
    const restore = () => {
      if (authMutation.current) return;
      const sequence = ++requestSequence.current;
      api<SessionView>("auth/session")
        .then(value => { if (active && sequence === requestSequence.current) setSession(value); })
        .catch(() => { if (active && sequence === requestSequence.current) setError("Unable to load session. Check the API, then reload."); });
    };
    restore();
    const expire = () => { ++requestSequence.current; setSession({ schema_version: "1", mode: "session", actor: null }); };
    window.addEventListener("vitaai-session-expired", expire);
    window.addEventListener("focus", restore);
    return () => { active = false; window.removeEventListener("vitaai-session-expired", expire); window.removeEventListener("focus", restore); };
  }, []);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (authMutation.current) return;
    authMutation.current = true;
    ++requestSequence.current;
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
      ++requestSequence.current;
      setSession(value);
    } catch (error) { setError(error instanceof Error ? error.message : "Sign-in failed."); }
    finally { authMutation.current = false; setBusy(false); }
  }

  async function logout() {
    if (authMutation.current) return;
    authMutation.current = true;
    ++requestSequence.current;
    setBusy(true);
    setError(null);
    try {
      await api<SessionView>("auth/logout", { method: "POST" });
      ++requestSequence.current;
      setSession({ schema_version: "1", mode: "session", actor: null });
    } catch { setError("Sign-out failed. Retry to revoke this session."); }
    finally { authMutation.current = false; setBusy(false); }
  }

  if (!session) return <main className="signin"><p role={error ? "alert" : "status"}>{error || "Loading session..."}</p></main>;
  if (session.mode === "sample") return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
  if (session.actor) return <SessionContext.Provider value={session} key={`${session.actor.id}:${session.actor.organization_id}:${session.actor.role}`}>
    <div className="session-bar"><span>{session.actor.username} · {session.actor.organization_id} · {session.actor.role}</span>
      <button onClick={logout} disabled={busy}>Sign out</button>{error && <span role="alert">{error}</span>}</div>
    {children}
  </SessionContext.Provider>;
  return <main className="signin"><h1>VitaAi</h1><p>Sign in to your workspace.</p>
    <form onSubmit={login}>
      <label>Username<input name="username" autoComplete="username" required maxLength={80} /></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={256} /></label>
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Signing in..." : "Sign in"}</button>
      {error && <p role="alert" className="error-banner">{error}</p>}
    </form>
  </main>;
}
