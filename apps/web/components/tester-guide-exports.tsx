"use client";

import { useEffect, useRef, useState } from "react";
import { feedbackTemplate, guideText } from "@/lib/tester-guide";

export function TesterGuideExports() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [copying, setCopying] = useState(false);
  const locked = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function copyFeedback() {
    if (locked.current || !alive.current) return;
    locked.current = true;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(feedbackTemplate);
      if (alive.current) { setError(false); setMessage("Feedback template copied. Nothing was submitted."); }
    } catch {
      if (alive.current) { setError(true); setMessage("Clipboard unavailable. Select and copy the template below manually."); }
    } finally {
      locked.current = false;
      if (alive.current) setCopying(false);
    }
  }
  function downloadGuide() {
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      url = URL.createObjectURL(new Blob([guideText], { type: "text/plain;charset=utf-8" }));
      link = document.createElement("a");
      link.href = url;
      link.download = "VitaAi_Local_Simulation_Tester_Guide.txt";
      document.body.appendChild(link);
      link.click();
      setError(false);
      setMessage("Guide download requested. Check browser downloads; if blocked, use the instructions on this page.");
    } catch {
      setError(true);
      setMessage("Download unavailable. Read or copy the instructions on this page; no file save was confirmed.");
    } finally {
      link?.remove();
      if (url) URL.revokeObjectURL(url);
    }
  }
  return <section aria-label="Tester guide exports">
    <button type="button" onClick={downloadGuide}>Download guide (.txt)</button>{" "}
    <button type="button" disabled={copying} onClick={() => void copyFeedback()}>Copy feedback template</button>
    {message && <p role={error ? "alert" : "status"}>{message}</p>}
    <h2>Feedback template</h2><p>Copying stays local. Review and share separately; this page sends no feedback.</p>
    <pre>{feedbackTemplate}</pre>
  </section>;
}
