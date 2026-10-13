/** Desktop WebView microphone capture. Nothing is uploaded until Stop. */
const RATE = 16_000;
export const MAX_VOICE_SAMPLES = RATE * 15 * 60;
type Recording = {
  id: string; stream?: MediaStream; context?: AudioContext;
  source?: MediaStreamAudioSourceNode; processor?: ScriptProcessorNode;
  timer?: ReturnType<typeof setTimeout>; chunks: Int16Array[]; count: number;
};
let current: Recording | null = null;
const cancelled = new Set<string>();

function dispose(recording: Recording): void {
  clearTimeout(recording.timer);
  recording.processor?.disconnect();
  recording.source?.disconnect();
  recording.stream?.getTracks().forEach(track => track.stop());
  if (recording.context) void recording.context.close().catch(() => {});
}
export function cancelDesktopRecording(id: string): void {
  cancelled.add(id);
  if (cancelled.size > 64) cancelled.delete(cancelled.values().next().value!);
  if (current?.id !== id) return;
  const recording = current;
  current = null;
  dispose(recording);
}

export async function startDesktopRecording(id: string, onLimit: () => void): Promise<boolean> {
  if (cancelled.has(id)) return false;
  if (current) throw new Error("Another dictation recording is already active");
  const recording: Recording = { id, chunks: [], count: 0 };
  current = recording;
  try {
    recording.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: RATE }, video: false });
    // A session can be cancelled while the permission dialog is open.
    if (current !== recording) { dispose(recording); return false; }
    recording.context = new AudioContext({ sampleRate: RATE });
    if (recording.context.sampleRate !== RATE) throw new Error("The microphone cannot record at 16 kHz");
    recording.source = recording.context.createMediaStreamSource(recording.stream);
    recording.processor = recording.context.createScriptProcessor(4096, 1, 1);
    let limited = false;
    const limit = () => {
      if (current !== recording || limited) return;
      limited = true;
      dispose(recording); // Stop the microphone at the cap, before transcription.
      onLimit();
    };
    recording.processor.onaudioprocess = event => {
      if (current !== recording || limited) return;
      const input = event.inputBuffer.getChannelData(0);
      const length = Math.min(input.length, MAX_VOICE_SAMPLES - recording.count);
      const pcm = new Int16Array(length);
      for (let i = 0; i < length; i++) {
        const value = Math.max(-1, Math.min(1, input[i]));
        pcm[i] = Math.round(value * (value < 0 ? 32768 : 32767));
      }
      recording.chunks.push(pcm);
      recording.count += length;
      if (recording.count >= MAX_VOICE_SAMPLES) limit();
    };
    recording.source.connect(recording.processor);
    recording.processor.connect(recording.context.destination);
    await recording.context.resume();
    if (current !== recording) { dispose(recording); return false; }
    recording.timer = setTimeout(limit, 15 * 60 * 1000);
    return true;
  } catch (error) {
    if (current === recording) current = null;
    dispose(recording);
    if (error instanceof Error && error.name === "NotAllowedError") throw new Error("Microphone permission was denied. Allow microphone access and retry dictation.");
    if (error instanceof Error && error.name === "NotFoundError") throw new Error("No microphone was found. Connect a microphone and retry dictation.");
    throw error;
  }
}

/** Encode bounded mono PCM as WAV, matching the Android recorder's format. */
export function voiceWav(chunks: Int16Array[], count: number): Uint8Array {
  if (!Number.isInteger(count) || count < 0 || count > MAX_VOICE_SAMPLES) throw new Error("Invalid dictation clip length");
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); };
  text(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true); view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  text(36, "data"); view.setUint32(40, count * 2, true);
  let offset = 44;
  for (const chunk of chunks) for (const sample of chunk) {
    if (offset >= bytes.length) throw new Error("Dictation clip length mismatch");
    view.setInt16(offset, sample, true); offset += 2;
  }
  if (offset !== bytes.length) throw new Error("Dictation clip length mismatch");
  return bytes;
}
export function stopDesktopRecording(id: string): string | null {
  if (current?.id !== id) return null;
  const recording = current;
  current = null;
  dispose(recording);
  const bytes = voiceWav(recording.chunks, recording.count);
  // Avoid spreading the entire clip onto the JS call stack.
  const parts: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 8192) parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192)));
  return btoa(parts.join(""));
}
