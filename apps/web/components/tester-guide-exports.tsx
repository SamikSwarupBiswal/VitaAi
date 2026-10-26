"use client";

import { useEffect, useRef, useState } from "react";
import { feedbackTemplate, guideText, guideVersion } from "@/lib/tester-guide";
import guidePdf from "@/lib/guide-pdf.generated.json";

export function TesterGuideExports() {
  const [message, setMessage] = useState("");
  const [error, setError] = useState(false);
  const [copying, setCopying] = useState(false);
  const locked = useRef(false);
  const alive = useRef(false);
  const pdfRequest = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; pdfRequest.current?.abort(); }; }, []);
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
  async function downloadPdf() {
    if (!alive.current || pdfRequest.current) return;
    const controller = new AbortController();
    pdfRequest.current = controller; setDownloading(true);
    let url: string | undefined;
    let link: HTMLAnchorElement | undefined;
    try {
      if (guidePdf.guide_version !== guideVersion) throw new Error("Guide version mismatch");
      const response = await fetch(`/guides/${guideVersion}.pdf`, { credentials: "omit", cache: "no-store", signal: controller.signal });
      if (!response.ok || response.headers.get("content-type")?.split(";")[0] !== "application/pdf") throw new Error("PDF unavailable");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength === 0 || bytes.byteLength > 2 * 1024 * 1024) throw new Error("PDF size invalid");
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      if (hash !== guidePdf.pdf_sha256) throw new Error("PDF content mismatch");
      if (!alive.current || controller.signal.aborted) return;
      url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      link = document.createElement("a"); link.href = url; link.download = "VitaAi_Local_Simulation_Tester_Guide.pdf";
      document.body.appendChild(link); link.click();
      setError(false); setMessage("PDF download requested. Check browser downloads; no file save was confirmed. The diagram is an illustration, not test evidence.");
    } catch {
      if (alive.current && !controller.signal.aborted) {
        setError(true); setMessage("PDF unavailable or does not match this guide. Read the page or download the text guide; no file save was confirmed.");
      }
    } finally {
      link?.remove(); if (url) URL.revokeObjectURL(url);
      pdfRequest.current = null;
      if (alive.current) setDownloading(false);
    }
  }
  return <section aria-label="Tester guide exports">
    <button type="button" onClick={downloadGuide}>Download guide (.txt)</button>{" "}
    <button type="button" disabled={downloading} onClick={() => void downloadPdf()}>Download illustrated guide (.pdf)</button>{" "}
    <p>The PDF contains the same public instructions and a conceptual workflow diagram. Downloading reads one public file; it does not inspect private records or run the test.</p>
    <button type="button" disabled={copying} onClick={() => void copyFeedback()}>Copy feedback template</button>
    {message && <p role={error ? "alert" : "status"}>{message}</p>}
    <h2>Feedback template</h2><p>Copying stays local. Review and share separately; this page sends no feedback.</p>
    <pre>{feedbackTemplate}</pre>
  </section>;
}
