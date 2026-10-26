"use client";

import { useLayoutEffect, useRef, useState, type RefObject } from "react";

type Props = {
  root: RefObject<HTMLElement | null>;
  context: string;
  target: "perspective" | "evidence" | "missions" | "walkthrough";
};

export function GuideTarget({ root, context, target }: Props) {
  const [status, setStatus] = useState("");
  const [active, setActive] = useState(false);
  const controls = useRef<{ show: (button: HTMLButtonElement) => void; dismiss: (restore: boolean) => void } | null>(null);

  useLayoutEffect(() => {
    let selection: { element: HTMLElement; button: HTMLButtonElement; disclosure: HTMLDetailsElement | null } | null = null;
    function clear(restore: boolean) {
      const saved = selection;
      selection = null;
      if (!saved) return;
      saved.element.removeAttribute("data-guide-highlight");
      saved.disclosure?.removeEventListener("toggle", closed);
      if (restore && saved.button.isConnected && root.current?.dataset.guideContext === context) {
        saved.button.focus({ preventScroll: true });
        saved.button.scrollIntoView({ behavior: "instant", block: "center" });
      }
    }
    function dismiss(restore: boolean) { clear(restore); setActive(false); setStatus(""); }
    function closed(event: Event) { if (!(event.currentTarget as HTMLDetailsElement).open) dismiss(false); }
    function show(button: HTMLButtonElement) {
      if (!button.isConnected || !root.current?.contains(button) || root.current.dataset.guideContext !== context) return;
      clear(false);
      const element = root.current.querySelector<HTMLElement>(`[data-guide-target="${target}"]`);
      if (!element || !element.isConnected || !element.getClientRects().length || element.closest("[hidden], [inert]")) {
        setActive(false); setStatus("This step's target is unavailable in the current workspace. Use the displayed instructions and links."); return;
      }
      const disclosure = button.closest("details");
      selection = { element, button, disclosure };
      disclosure?.addEventListener("toggle", closed);
      try {
        element.setAttribute("data-guide-highlight", "true");
        element.focus({ preventScroll: true });
        element.scrollIntoView({ behavior: "instant", block: "center" });
        setActive(true); setStatus("Current step highlighted. Use Return to guide or Escape to dismiss. No action has been performed.");
      } catch {
        clear(false); setActive(false); setStatus("This target could not be focused. Use the displayed instructions and links.");
      }
    }
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape" && selection) dismiss(true); };
    const invalidate = () => dismiss(false);
    controls.current = { show, dismiss };
    window.addEventListener("keydown", escape);
    window.addEventListener("blur", invalidate);
    window.addEventListener("vitaai-source-changed", invalidate);
    window.addEventListener("vitaai-workflow-changed", invalidate);
    return () => {
      controls.current = null; clear(false);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("blur", invalidate);
      window.removeEventListener("vitaai-source-changed", invalidate);
      window.removeEventListener("vitaai-workflow-changed", invalidate);
    };
  }, [root, context, target]);

  return <div className="guide-target-controls">
    <button type="button" onClick={event => controls.current?.show(event.currentTarget)}>Show this step</button>{" "}
    <button type="button" disabled={!active} onClick={() => controls.current?.dismiss(true)}>Return to guide</button>
    <p role="status">{status}</p>
  </div>;
}
