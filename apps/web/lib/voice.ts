export type VoiceState = "idle" | "listening" | "speaking" | "unsupported" | "permission_denied" | "failed" | "cancelled";
type RecognitionEvent = { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> };
export type Recognition = {
  processLocally?: boolean; continuous: boolean; interimResults: boolean; maxAlternatives: number; lang: string;
  onresult: ((event: RecognitionEvent) => void) | null; onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null; start(): void; stop(): void; abort(): void;
};
type Utterance = { text: string; voice: SpeechSynthesisVoice | null; lang: string; onend: (() => void) | null; onerror: (() => void) | null };
export type VoiceEnvironment = {
  recognition?: () => Recognition;
  utterance?: (text: string) => Utterance;
  synthesis?: { getVoices(): SpeechSynthesisVoice[]; speak(utterance: Utterance): void; cancel(): void };
  timer: (fn: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer: (id: ReturnType<typeof setTimeout>) => void;
};

export function normalizeTranscript(value: string): string {
  if (typeof value !== "string" || value.length > 8000 || /[\0\u202a-\u202e\u2066-\u2069]/.test(value)) throw new Error("Transcript invalid");
  const text = value.normalize("NFC").replace(/\s+/g, " ").trim();
  if (!text || text.length > 2000) throw new Error("Transcript unavailable or too long");
  return text;
}

export class LocalVoice {
  private generation = 0;
  private recognition: Recognition | null = null;
  private utterance: Utterance | null = null;
  private timeout: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  constructor(private env: VoiceEnvironment, private status: (state: VoiceState, detail: string) => void,
    private transcript: (text: string) => void) {}
  private clear() { if (this.timeout !== null) this.env.clearTimer(this.timeout); this.timeout = null; }
  cancel(announce = true) {
    ++this.generation; this.clear();
    const recognition = this.recognition, utterance = this.utterance;
    this.recognition = null; this.utterance = null;
    if (recognition) { recognition.onresult = null; recognition.onerror = null; recognition.onend = null; try { recognition.abort(); } catch { /* Already stopped. */ } }
    if (utterance) { utterance.onend = null; utterance.onerror = null; this.env.synthesis?.cancel(); }
    if (announce && !this.closed) this.status("cancelled", "Speech stopped. No question was submitted.");
  }
  listen(consent: boolean) {
    if (this.closed || this.recognition || this.utterance) return;
    if (!consent) { this.status("permission_denied", "Enable on-device microphone input first."); return; }
    if (!this.env.recognition) { this.status("unsupported", "On-device speech recognition unavailable. Type your question."); return; }
    let recognition: Recognition;
    try { recognition = this.env.recognition(); }
    catch { this.status("failed", "Browser recognition could not be initialized."); return; }
    if (!("processLocally" in recognition)) { this.status("unsupported", "This browser cannot guarantee on-device recognition. Type your question."); return; }
    this.recognition = recognition; const token = ++this.generation;
    const active = () => !this.closed && token === this.generation && this.recognition === recognition;
    recognition.processLocally = true; recognition.continuous = false; recognition.interimResults = false;
    recognition.maxAlternatives = 1; recognition.lang = "en-US";
    recognition.onresult = event => {
      if (!active()) return;
      try {
        const values = Array.from(event.results).filter(result => result.isFinal).map(result => result[0].transcript);
        const text = normalizeTranscript(values.join(" "));
        this.cancel(false); this.transcript(text); this.status("idle", "Transcript ready. Review it, then explicitly ask.");
      } catch { this.cancel(false); this.status("failed", "Transcript empty, invalid or over2000 characters. Type or record again."); }
    };
    recognition.onerror = event => { if (!active()) return; this.cancel(false);
      this.status(event.error === "not-allowed" || event.error === "service-not-allowed" ? "permission_denied" : "failed",
        event.error === "not-allowed" ? "Microphone permission denied." : event.error === "audio-capture" ? "Microphone capture unavailable." : "On-device recognition failed or its language pack is unavailable. Type or retry."); };
    recognition.onend = () => { if (active()) { this.cancel(false); this.status("idle", "Recording ended without a final transcript. Type or retry."); } };
    try { this.status("listening", "Listening on device; maximum30 seconds.");
      this.timeout = this.env.timer(() => { if (active()) { this.cancel(false); this.status("failed", "Recording limit reached. Record a shorter question."); } }, 30000);
      recognition.start();
    } catch { this.cancel(false); this.status("failed", "Recognition could not start. Check browser support and microphone permission."); }
  }
  finish() { try { this.recognition?.stop(); } catch { this.cancel(); } }
  speak(text: string) {
    if (this.closed || this.recognition || this.utterance) return;
    if (!text.trim() || text.length > 6000 || text.includes("\0")) { this.status("failed", "Playback text empty, invalid or too long."); return; }
    let voice: SpeechSynthesisVoice | undefined;
    try { voice = this.env.synthesis?.getVoices().find(value => value.localService && value.lang.startsWith("en")); }
    catch { this.status("failed", "Browser voices could not be read. Read the transcript or retry."); return; }
    if (!voice || !this.env.utterance || !this.env.synthesis) { this.status("unsupported", "A local English playback voice is unavailable. Read the transcript or retry after browser voices load."); return; }
    let utterance: Utterance;
    try { utterance = this.env.utterance(text); }
    catch { this.status("failed", "Browser playback could not be initialized."); return; }
    utterance.voice = voice; utterance.lang = voice.lang;
    this.utterance = utterance; const token = ++this.generation;
    const active = () => !this.closed && this.generation === token && this.utterance === utterance;
    utterance.onend = () => { if (active()) { this.utterance = null; this.clear(); this.status("idle", "Playback finished."); } };
    utterance.onerror = () => { if (active()) { this.cancel(false); this.status("failed", "Local playback failed. Read the transcript or retry."); } };
    try { this.status("speaking", "Playing the displayed transcript using a local browser voice.");
      this.timeout = this.env.timer(() => { if (active()) { this.cancel(false); this.status("failed", "Playback time limit reached. Read the remaining transcript."); } }, 90000);
      this.env.synthesis.speak(utterance);
    } catch { this.cancel(false); this.status("failed", "Local playback could not start. Read the transcript or retry."); }
  }
  dispose() { this.cancel(false); this.closed = true; }
}

export function browserVoiceEnvironment(): VoiceEnvironment {
  const host = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
  const RecognitionClass = host.SpeechRecognition ?? host.webkitSpeechRecognition;
  return { recognition: RecognitionClass ? () => new RecognitionClass() : undefined,
    synthesis: "speechSynthesis" in window ? { getVoices: () => window.speechSynthesis.getVoices(), cancel: () => window.speechSynthesis.cancel(),
      speak: value => window.speechSynthesis.speak(value as SpeechSynthesisUtterance) } : undefined,
    utterance: "SpeechSynthesisUtterance" in window ? text => new SpeechSynthesisUtterance(text) as unknown as Utterance : undefined,
    timer: (fn, delay) => setTimeout(fn, delay), clearTimer: id => clearTimeout(id) };
}
