"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";
import { avatarFrameAt, avatarHash, neutralFrame, parseAvatarCsv, validateAvatarWav, type AvatarFrame } from "@/lib/avatar";

export function CompanionAvatar({ pose = neutralFrame }: { pose?: AvatarFrame }) {
  return <svg viewBox="0 0 160 150" width="160" height="150" role="img" aria-label="Vita original local avatar; presentation only" style={{ maxWidth: "100%" }}>
    <rect x="5" y="5" width="150" height="140" rx="34" fill="#263f5a" />
    <path d="M38 122 Q80 89 122 122 L125 140 L35 140 Z" fill="#43a3a0" />
    <ellipse cx="80" cy="69" rx="39" ry="47" fill="#e5bfa1" />
    <path d="M42 59 Q34 15 79 17 Q127 16 118 57 Q92 49 77 32 Q65 52 42 59" fill="#26302f" />
    <ellipse cx="65" cy="68" rx="4" ry={Math.max(0.5, 4 * (1 - pose.eyeBlinkLeft))} fill="#26302f" />
    <ellipse cx="95" cy="68" rx="4" ry={Math.max(0.5, 4 * (1 - pose.eyeBlinkRight))} fill="#26302f" />
    <path d="M80 73 L76 86 L83 86" stroke="#b87d66" strokeWidth="2" fill="none" />
    <ellipse cx="80" cy={97 - pose.smile * 2} rx={11 + pose.smile * 3} ry={1.5 + pose.jawOpen * 11} fill="#7a3c43" />
    <circle cx="139" cy="24" r="5" fill="#90dbc2" />
  </svg>;
}

type Asset = { url: string; frames: AvatarFrame[]; duration: number; audioHash: string; animationHash: string };

export function AvatarControls() {
  const [wav, setWav] = useState<File | null>(null), [csv, setCsv] = useState<File | null>(null);
  const [asset, setAsset] = useState<Asset | null>(null), [pose, setPose] = useState(neutralFrame);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null), current = useRef<Asset | null>(null), sequence = useRef(0);
  const choice = useRef<{ wav: File | null; csv: File | null }>({ wav: null, csv: null });
  const animation = useRef<number | null>(null), lifetime = useRef<AbortController | null>(null), pending = useRef(false);
  const stop = useCallback((publish = true) => {
    audio.current?.pause(); if (animation.current !== null) cancelAnimationFrame(animation.current); animation.current = null;
    if (publish) setPose(neutralFrame);
  }, []);
  const clear = useCallback((publish = true) => {
    ++sequence.current; pending.current = false; stop(publish);
    if (current.current) URL.revokeObjectURL(current.current.url); current.current = null;
    if (publish) { setAsset(null); setBusy(false); }
  }, [stop]);
  useLayoutEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    const invalidate = () => clear();
    const events = ["blur", "vitaai-source-changed", "vitaai-session-expired", "vitaai-workflow-changed"];
    events.forEach(name => window.addEventListener(name, invalidate));
    return () => { controller.abort(); clear(false); events.forEach(name => window.removeEventListener(name, invalidate)); };
  }, [clear]);
  async function load() {
    const signal = lifetime.current?.signal;
    if (!wav || !csv || choice.current.wav !== wav || choice.current.csv !== csv || !signal || signal.aborted || pending.current) return;
    clear(); pending.current = true; setBusy(true); setError(null); const request = ++sequence.current;
    const active = () => !signal.aborted && sequence.current === request;
    try {
      if (wav.size > 6 * 1024 * 1024 || csv.size > 2 * 1024 * 1024) throw new Error("Files exceed supported bounds.");
      const [bytes, animationBytes] = await Promise.all([wav.arrayBuffer(), csv.arrayBuffer()]);
      if (!active()) return;
      if (animationBytes.byteLength > 2 * 1024 * 1024) throw new Error("Animation exceeds supported bounds.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(animationBytes);
      const metadata = validateAvatarWav(bytes), frames = parseAvatarCsv(text, metadata.duration);
      const [audioHash, animationHash] = await Promise.all([avatarHash(bytes), avatarHash(animationBytes)]);
      if (!active()) return;
      const value = { url: URL.createObjectURL(new Blob([bytes], { type: "audio/wav" })), frames, duration: metadata.duration, audioHash, animationHash };
      current.current = value; setAsset(value);
    } catch { if (active()) setError("Avatar files unavailable or invalid. Use a complete mono16-bit PCM WAV (at most60 seconds/6MiB) and matching bounded Audio2Face-style CSV."); }
    finally { if (active()) { pending.current = false; setBusy(false); } }
  }
  function play() {
    const item = asset, element = audio.current, signal = lifetime.current?.signal;
    if (!item || current.current !== item || !element || !signal || signal.aborted) { element?.pause(); return; }
    if (animation.current !== null) cancelAnimationFrame(animation.current);
    const draw = () => {
      if (signal.aborted || current.current !== item || element.paused || element.ended) { stop(); return; }
      setPose(avatarFrameAt(item.frames, element.currentTime)); animation.current = requestAnimationFrame(draw);
    };
    draw();
  }
  return <section aria-label="Local avatar presentation" style={{ overflowWrap: "anywhere" }}><h4>Vita avatar</h4>
    <CompanionAvatar pose={pose} /><p>Original local avatar. Presentation only; no identity, confidence or action authority.</p>
    <details><summary>Play imported Audio2Face output</summary>
      <p>Choose matching out.wav and animation_frames.csv exported by an Audio2Face workflow. Files stay in this browser. Provider origin and speech/transcript alignment are unverified. No inference service is called.</p>
      <p>This original four-channel face renders jawOpen, eyeBlinkLeft, eyeBlinkRight and combined mouthSmile; other numeric blendshapes are ignored. TimeCode must be strictly increasing, cover the WAV and have no gaps over0.25seconds. The player makes no claim of a complete3D rig.</p>
      <label>Avatar PCM WAV <input type="file" accept="audio/wav,.wav" disabled={busy} onChange={event => { clear(); const value = event.target.files?.[0] ?? null; choice.current.wav = value; setWav(value); setError(null); }} /></label>
      <label>Avatar animation CSV <input type="file" accept="text/csv,.csv" disabled={busy} onChange={event => { clear(); const value = event.target.files?.[0] ?? null; choice.current.csv = value; setCsv(value); setError(null); }} /></label>
      <button disabled={busy || !wav || !csv} onClick={load}>Load local avatar files</button><button onClick={() => clear()}>Clear avatar playback</button>
      {busy && <p role="status">Validating local audio and frames…</p>}{error && <p role="alert">{error}</p>}
      {asset && <div><p>Validated local pair: {asset.duration} seconds / {asset.frames.length} frames.</p>
        <p>Audio SHA256 {asset.audioHash} / animation SHA256 {asset.animationHash}. Imported output, never live inference evidence.</p>
        <audio ref={audio} src={asset.url} controls onPlay={play} onPause={() => stop()} onEnded={() => stop()}
          onError={() => { stop(); setError("This browser could not play the validated WAV. Clear and load again."); }} />
        <button onClick={() => stop()}>Stop avatar audio</button>
      </div>}
    </details>
  </section>;
}
