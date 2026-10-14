import { afterEach, expect, it, vi } from "vitest";
import { createAndroidWebview } from "./androidLiveWebview";

const invoke = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
afterEach(() => vi.unstubAllGlobals());

it("invokes the Android command without requiring a runtime marker", async () => {
  vi.stubGlobal("window", undefined);
  await createAndroidWebview("test-pane", "https://example.com/", {
    x: 1.6, y: -2.6, width: 0.2, height: 20.6,
  }, { behind: true, userAgent: "test-agent" });
  expect(invoke.mock.calls).toEqual([["live_webview_create", {
    label: "test-pane", url: "https://example.com/",
    rect: { x: 2, y: -3, width: 1, height: 21 },
    density: 1, userAgent: "test-agent", behind: true,
  }]]);
});
