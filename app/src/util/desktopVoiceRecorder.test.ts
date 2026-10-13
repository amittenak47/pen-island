/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { cancelDesktopRecording, startDesktopRecording, stopDesktopRecording, voiceWav, MAX_VOICE_SAMPLES } from "./desktopVoiceRecorder";

let recordingId: string | null = null;
afterEach(() => { if (recordingId) cancelDesktopRecording(recordingId); recordingId = null; vi.useRealTimers(); vi.unstubAllGlobals(); });
it("produces bounded 16kHz mono PCM WAV with signed little-endian samples", () => {
  const bytes = voiceWav([new Int16Array([-32768, 0, 32767])], 3);
  const view = new DataView(bytes.buffer);
  expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe("RIFF");
  expect(view.getUint16(22, true)).toBe(1);
  expect(view.getUint32(24, true)).toBe(16000);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(48, true)).toBe(32767);
  expect(() => voiceWav([], MAX_VOICE_SAMPLES + 1)).toThrow("length");
  expect(() => voiceWav([], 1)).toThrow("mismatch");
});
it("closes the mic if permission is granted after cancellation, without starting capture", async () => {
  let allow!: (stream: MediaStream) => void;
  const stop = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: () => new Promise<MediaStream>(resolve => { allow = resolve; }) } });
  recordingId = "permission-late";
  const recording = startDesktopRecording(recordingId, vi.fn());
  cancelDesktopRecording(recordingId);
  allow({ getTracks: () => [{ stop }] } as unknown as MediaStream);
  await recording;
  expect(stop).toHaveBeenCalledTimes(1);
  expect(stopDesktopRecording(recordingId)).toBeNull();
});
it("never asks for the microphone when cancellation precedes a delayed native start", async () => {
  const getUserMedia = vi.fn();
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia } });
  cancelDesktopRecording("cancel-before-start");
  await expect(startDesktopRecording("cancel-before-start", vi.fn())).resolves.toBe(false);
  expect(getUserMedia).not.toHaveBeenCalled();
});
it("stops microphone capture at 15 minutes, leaving the bounded clip available to Stop", async () => {
  vi.useFakeTimers();
  const stop = vi.fn(), onLimit = vi.fn();
  const processor = { connect: vi.fn(), disconnect: vi.fn(), onaudioprocess: null };
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) } });
  vi.stubGlobal("AudioContext", class {
    sampleRate = 16000; destination = {};
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { return processor; }
    async resume() {} async close() {}
  });
  recordingId = "limit";
  await startDesktopRecording(recordingId, onLimit);
  await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(onLimit).toHaveBeenCalledTimes(1);
  expect(stopDesktopRecording(recordingId)).not.toBeNull();
});
