export type AvatarFrame = { time: number; jawOpen: number; eyeBlinkLeft: number; eyeBlinkRight: number; smile: number };
export const neutralFrame: AvatarFrame = { time: 0, jawOpen: 0, eyeBlinkLeft: 0, eyeBlinkRight: 0, smile: 0 };

export function validateAvatarWav(buffer: ArrayBuffer): { duration: number; sampleRate: number } {
  if (buffer.byteLength < 44 || buffer.byteLength > 6 * 1024 * 1024) throw new Error("Use a WAV of at most6MiB.");
  const view = new DataView(buffer), tag = (n: number) => String.fromCharCode(...new Uint8Array(buffer, n, 4));
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE" || view.getUint32(4, true) + 8 !== buffer.byteLength) throw new Error("Invalid RIFF/WAVE length or signature.");
  let position = 12, rate = 0, dataSize = 0, format = false, data = false, chunks = 0;
  while (position + 8 <= buffer.byteLength) {
    if (++chunks > 1000) throw new Error("Too many WAV chunks.");
    const kind = tag(position), size = view.getUint32(position + 4, true), start = position + 8;
    if (start + size > buffer.byteLength) throw new Error("Truncated WAV chunk.");
    if (kind === "fmt ") {
      if (format || size < 16 || view.getUint16(start, true) !== 1 || view.getUint16(start + 2, true) !== 1
        || view.getUint16(start + 14, true) !== 16 || view.getUint16(start + 12, true) !== 2) throw new Error("Use mono16-bit PCM WAV.");
      rate = view.getUint32(start + 4, true);
      if (![8000, 16000, 22050, 24000, 44100, 48000].includes(rate) || view.getUint32(start + 8, true) !== rate * 2) throw new Error("Unsupported WAV sample rate.");
      format = true;
    }
    if (kind === "data") { if (data || !size || size % 2) throw new Error("Invalid PCM data chunk."); data = true; dataSize = size; }
    position = start + size + size % 2;
  }
  const duration = dataSize / (rate * 2);
  if (!format || !data || position !== buffer.byteLength || !Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error("Use complete PCM WAV of at most60 seconds.");
  return { duration, sampleRate: rate };
}

export function parseAvatarCsv(text: string, duration: number): AvatarFrame[] {
  if (text.length > 2 * 1024 * 1024 || new TextEncoder().encode(text).length > 2 * 1024 * 1024
    || !Number.isFinite(duration) || duration <= 0 || duration > 60) throw new Error("Animation exceeds supported bounds.");
  const lines = text.replace(/^\uFEFF/, "").trim().split(/\r?\n/);
  if (lines.length < 3 || lines.length > 3602) throw new Error("Use2–3601 animation frames.");
  const header = lines[0].split(",").map(name => name.trim().toLowerCase());
  if (new Set(header).size !== header.length || header.length < 4 || header.length > 100
    || header.some(name => !/^[a-z][a-z0-9_]*$/.test(name))) throw new Error("Invalid or duplicate animation columns.");
  const time = header.findIndex(name => ["timecode", "time_code"].includes(name));
  const jaw = header.indexOf("jawopen"), left = header.indexOf("eyeblinkleft"), right = header.indexOf("eyeblinkright");
  const smileLeft = header.indexOf("mouthsmileleft"), smileRight = header.indexOf("mouthsmileright");
  if ([time, jaw, left, right].some(index => index < 0)) throw new Error("Required TimeCode/jawOpen/eyeBlinkLeft/eyeBlinkRight columns missing.");
  const frames: AvatarFrame[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(",").map(value => value.trim());
    if (cells.length !== header.length || cells.some(value => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))) throw new Error("Invalid animation row.");
    const values = cells.map(Number), stamp = values[time], prior = frames.at(-1);
    if (values.some((value, index) => !Number.isFinite(value) || (index !== time && (value < 0 || value > 1)))
      || stamp < 0 || stamp > duration + 0.1 || (prior && (stamp <= prior.time || stamp - prior.time > 0.25))) throw new Error("Animation time or blendshape weights outside supported bounds.");
    frames.push({ time: stamp, jawOpen: values[jaw], eyeBlinkLeft: values[left], eyeBlinkRight: values[right],
      smile: Math.max(smileLeft < 0 ? 0 : values[smileLeft], smileRight < 0 ? 0 : values[smileRight]) });
  }
  if (frames[0].time > 0.1 || duration - frames.at(-1)!.time > 0.25) throw new Error("Animation does not cover the supplied audio duration.");
  return frames;
}

export function avatarFrameAt(frames: AvatarFrame[], time: number): AvatarFrame {
  if (!frames.length || !Number.isFinite(time) || time < frames[0].time) return neutralFrame;
  let low = 0, high = frames.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (frames[middle].time <= time) low = middle; else high = middle - 1; }
  return frames[low];
}

export async function avatarHash(buffer: ArrayBuffer): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", buffer))].map(value => value.toString(16).padStart(2, "0")).join("");
}
