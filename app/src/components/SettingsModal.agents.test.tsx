/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsModal } from "./SettingsModal";
import type { LcClient } from "../api/client";
import { DEFAULT_ASSISTANT_RUNNER_CONFIG } from "../api/client";
import type { LcConfig } from "../api/types";

vi.mock("../util/devicePrefs", async importOriginal => ({
  ...await importOriginal<typeof import("../util/devicePrefs")>(),
  ensureDevicePrefs: vi.fn(async () => null), saveThisDevicePrefs: vi.fn(async () => null),
}));
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); localStorage.clear(); vi.unstubAllGlobals(); });
const modes = ["Background check", "Review and Ask", "Reveal", "Diagrams", "Planner"];
function client() {
  const endpoint = { base_url: "http://fixture", model: "test", vision: false, vision_model: "" };
  let config = { local: endpoint, ollama: endpoint, openai: endpoint, groq: endpoint,
    modes: { ambient: "local", review: "local", bridge: "local", viz: "local", planner: "local" },
    dataset_dirs: {}, workspace_dir: "test", serve_port: 7878, default_provider: "local" } as LcConfig;
  return {
    getConfig: vi.fn(async () => structuredClone(config)),
    putConfig: vi.fn(async value => { config = structuredClone(value); return config; }),
    modelCatalog: vi.fn(async () => ({ models: [], notes: [] })),
    lanBaseUrl: vi.fn(async () => "http://fixture"), llmStatus: vi.fn(async () => ({ running: false })),
    bootNotice: vi.fn(async () => null), datasets: vi.fn(async () => []), listDevices: vi.fn(async () => []),
    assistantRunnerConfig: vi.fn(async () => ({ ...DEFAULT_ASSISTANT_RUNNER_CONFIG })),
    assistantRunnerStatus: vi.fn(async () => ({ app: "codex", state: "idle" })),
  } as unknown as LcClient;
}
const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>("button")].find(node =>
  node.textContent?.trim() === text || node.querySelector(".lc-settings-fold-title")?.textContent === text)!;
const picker = (mode: string) => host.querySelector<HTMLSelectElement>(`[aria-label="${mode} provider"]`)!;
const image = () => [...host.querySelectorAll<HTMLButtonElement>('[role="switch"]')].find(node => node.textContent?.includes("Send the board image to agents"))!;
async function open(api: LcClient) {
  await act(async () => root.render(<SettingsModal open client={api} onClose={() => {}} initialTab="llm" />));
  await act(async () => button("AI model").click());
}
async function choose(mode: string, provider: string) {
  await act(async () => {
    const select = picker(mode);
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, provider);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
async function reopen(api: LcClient) {
  await act(async () => root.render(<SettingsModal open={false} client={api} onClose={() => {}} initialTab="llm" />));
  await open(api);
}
it.each(["app", "bot"])("shows, saves and reloads %s for every coach mode and the board image switch", async provider => {
  const api = client(); await open(api);
  expect(image().getAttribute("aria-checked")).toBe("true");
  expect(host.textContent).toContain("Uses the app chosen for ChatBot on this PC");
  expect(host.textContent).toContain("Answered by the assistant chosen for ChatBot; can take a few minutes");
  for (const mode of modes) {
    expect([...picker(mode).options].map(option => [option.value, option.textContent])).toContainEqual(["app", "AI application"]);
    expect([...picker(mode).options].map(option => [option.value, option.textContent])).toContainEqual(["bot", "AI assistant"]);
    await choose(mode, provider);
  }
  await act(async () => image().click());
  expect(api.putConfig).not.toHaveBeenCalled();
  await act(async () => button("Save").click());
  expect(api.putConfig).toHaveBeenCalledWith(expect.objectContaining({
    modes: { ambient: provider, review: provider, bridge: provider, viz: provider, planner: provider },
    coach: expect.objectContaining({ agent_send_board_image: false }),
  }), expect.any(Object));
  await reopen(api);
  for (const mode of modes) expect(picker(mode).value).toBe(provider);
  expect(image().getAttribute("aria-checked")).toBe("false");
  await act(async () => image().click());
  await act(async () => button("Save").click());
  await reopen(api);
  expect(image().getAttribute("aria-checked")).toBe("true");
});
it("resets and cancels agent drafts with the AI models section, and links to the existing ChatBot picker", async () => {
  const api = client(); await open(api);
  await choose("Review and Ask", "app"); await act(async () => image().click());
  expect(host.querySelector('.lc-settings-change-count')?.textContent).toBe("2 changes");
  await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset AI model"]')!.click());
  expect(picker("Review and Ask").value).toBe("local");
  expect(image().getAttribute("aria-checked")).toBe("true");
  await choose("Diagrams", "bot"); await act(async () => image().click());
  await act(async () => button("Cancel").click());
  await reopen(api);
  expect(picker("Diagrams").value).toBe("local");
  expect(image().getAttribute("aria-checked")).toBe("true");
  await act(async () => button("Choose application or assistant in ChatBot").click());
  expect(host.querySelector('.lc-settings-fold.is-expanded .lc-settings-fold-title')?.textContent).toBe("ChatBot");
  expect(host.querySelector('[aria-label="ChatBot answer mode"]')).not.toBeNull();
  expect(api.putConfig).not.toHaveBeenCalled();
});

it("keeps different providers independent across modes when saving and reloading", async () => {
  const api = client(); await open(api);
  await choose("Review and Ask", "app"); await choose("Diagrams", "bot");
  await act(async () => button("Save").click()); await reopen(api);
  expect(picker("Review and Ask").value).toBe("app");
  expect(picker("Diagrams").value).toBe("bot");
  for (const mode of ["Background check", "Reveal", "Planner"]) expect(picker(mode).value).toBe("local");
});
