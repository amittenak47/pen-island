/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import { DEFAULT_COACH_FLAGS, type LcConfig } from "../api/types";
import { DEFAULT_ASSISTANT_RUNNER_CONFIG, type LcClient } from "../api/client";
import { loadChatBotAnswerMode } from "../util/chatBotClient";

vi.mock("../util/devicePrefs", async importOriginal => ({
  ...await importOriginal<typeof import("../util/devicePrefs")>(),
  ensureDevicePrefs: vi.fn(async () => null), saveThisDevicePrefs: vi.fn(async () => null),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
function client() {
  const endpoint = { base_url: "http://fixture", model: "test", vision: false, vision_model: "" };
  const config = { local: endpoint, ollama: endpoint, openai: endpoint, groq: endpoint, coach: { ...DEFAULT_COACH_FLAGS },
    modes: { ambient: "local", review: "local", bridge: "local", viz: "local", planner: "local" },
    dataset_dirs: {}, workspace_dir: "test", serve_port: 7878, default_provider: "local" } as LcConfig;
  return {
    getConfig: vi.fn(async () => config), putConfig: vi.fn(async () => config), lanBaseUrl: vi.fn(async () => "http://fixture"),
    llmStatus: vi.fn(async () => ({ running: false })), bootNotice: vi.fn(async () => null), datasets: vi.fn(async () => []), listDevices: vi.fn(async () => []),
    assistantRunnerConfig: vi.fn(async () => ({ ...DEFAULT_ASSISTANT_RUNNER_CONFIG, model: "desktop-model" })),
    putAssistantRunnerConfig: vi.fn(async value => value),
    assistantRunnerStatus: vi.fn(async () => ({ app: "codex", state: "idle", started_at: null, finished_at: null })),
    testAssistantRunner: vi.fn(async () => ({ app: "codex", state: "done", started_at: 1, finished_at: 2 })),
  } as unknown as LcClient;
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent?.trim() === text || node.querySelector(".lc-settings-fold-title")?.textContent === text)!;
async function change(label: string, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
    Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}
async function open(api: LcClient) {
  await act(async () => root.render(<SettingsModal open client={api} onClose={() => {}} initialTab="llm" />));
  await act(async () => button("ChatBot").click());
}
it("shows three modes and saves app mode with settings on the desktop", async () => {
  const api = client(); await open(api);
  const select = host.querySelector<HTMLSelectElement>('[aria-label="ChatBot answer mode"]')!;
  expect([...select.options].map(option => [option.value, option.textContent])).toEqual([
    ["llm", "Your AI model"], ["bot", "An assistant bot"], ["app", "An assistant app on this PC"],
  ]);
  await change("ChatBot answer mode", "app");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Assistant app model"]')!.value).toBe("desktop-model");
  await change("Assistant app model", "my-model");
  expect(loadChatBotAnswerMode()).toBe("bot");
  await act(async () => button("Save").click());
  expect(loadChatBotAnswerMode()).toBe("app");
  expect(api.putAssistantRunnerConfig).toHaveBeenCalledWith({ app: "codex", model: "my-model", effort: "high", allow_bots: false });
  expect(api.putConfig).not.toHaveBeenCalled();
  expect([...Object.keys(localStorage)].some(key => localStorage.getItem(key)?.includes("my-model"))).toBe(false);
});
it("tests the unsaved draft without saving or enabling app mode", async () => {
  const api = client(); await open(api); await change("ChatBot answer mode", "app");
  await change("Assistant app", "claude"); await change("Assistant app model", "test-model");
  expect(host.querySelector('[aria-label="Assistant app effort"]')).toBeNull();
  await act(async () => button("Test").click());
  expect(api.testAssistantRunner).toHaveBeenCalledWith({ app: "claude", model: "test-model", effort: "high", allow_bots: false });
  expect(api.putAssistantRunnerConfig).not.toHaveBeenCalled();
  expect(loadChatBotAnswerMode()).toBe("bot");
  expect(host.textContent).toContain("Codex finished.");
});
it("keeps app mode unsaved when desktop settings cannot be written", async () => {
  const api = client(); await open(api); await change("ChatBot answer mode", "app"); await change("Assistant app model", "retry");
  vi.mocked(api.putAssistantRunnerConfig).mockRejectedValueOnce(new Error("Desktop unavailable"));
  await act(async () => button("Save").click());
  expect(loadChatBotAnswerMode()).toBe("bot"); expect(host.textContent).toContain("Desktop unavailable");
  await act(async () => button("Save").click()); expect(loadChatBotAnswerMode()).toBe("app");
});
