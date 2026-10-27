"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { LocalVoice, browserVoiceEnvironment, type VoiceState } from "@/lib/voice";

export function VoiceControls({ text, onTranscript, disabled }: { text: string; onTranscript: (text: string) => void; disabled: boolean }) {
  const [consent, setConsent] = useState(false), [state, setState] = useState<VoiceState>("idle"), [detail, setDetail] = useState("");
  const voice = useRef<LocalVoice | null>(null), draft = useRef(onTranscript);
  useLayoutEffect(() => { draft.current = onTranscript; });
  useLayoutEffect(() => {
    const controller = new LocalVoice(browserVoiceEnvironment(), (value, note) => { setState(value); setDetail(note); }, value => draft.current(value));
    voice.current = controller;
    const cancel = () => controller.cancel();
    ["blur", "vitaai-source-changed", "vitaai-session-expired", "vitaai-workflow-changed"].forEach(name => window.addEventListener(name, cancel));
    return () => { controller.dispose(); voice.current = null;
      ["blur", "vitaai-source-changed", "vitaai-session-expired", "vitaai-workflow-changed"].forEach(name => window.removeEventListener(name, cancel)); };
  }, []);
  const active = state === "listening" || state === "speaking";
  return <section aria-label="Local voice controls"><h4>Voice</h4>
    <p>On-device browser speech only. Unsupported recognition or missing local voices stays unavailable; no external speech service is used.</p>
    <label><input type="checkbox" checked={consent} disabled={disabled || active} onChange={event => setConsent(event.target.checked)} />Enable on-device microphone input</label>
    <button disabled={disabled || active || !consent} onClick={() => { if (!disabled && consent) voice.current?.listen(true); }}>Record question</button>
    <button disabled={disabled || state !== "listening"} onClick={() => voice.current?.finish()}>Finish recording</button>
    <button disabled={disabled || active || !text} onClick={() => { if (!disabled) voice.current?.speak(text); }}>Play displayed answer</button>
    <button disabled={!active} onClick={() => voice.current?.cancel()}>Stop speech</button>
    <p role="status">{state}: {detail}</p>
    <details><summary>Playback transcript</summary><p>{text || "Ask a sourced question to prepare playback."}</p></details>
    <p>Transcription edits the question only. Review it and explicitly ask; speech cannot approve or navigate.</p>
  </section>;
}
