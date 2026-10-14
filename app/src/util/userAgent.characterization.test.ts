import { afterEach, describe, expect, it, vi } from "vitest";
import { deviceRole } from "./devicePrefs";
import { DOCUMENT_ACCEPT, documentPickerAccept, folderPickSupported } from "./annotateFs";
import { liveWebviewTransport } from "./liveWebviewSupport";
import { isHandheldDevice } from "./mobile";

const androidTablet = "Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const androidPhone = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
const androidWebview = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.6261.105 Mobile Safari/537.36";
const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const rows = [
  ["Android tablet browser", androidTablet, false, 5, "android", "*/*", "none", true, false],
  ["Android phone browser", androidPhone, false, 5, "android", "*/*", "none", true, false],
  ["Android WebView shell", androidWebview, true, 5, "android", "*/*", "android", true, false],
  ["Android tablet shell", androidTablet, true, 5, "android", "*/*", "android", true, false],
  ["iPad Safari", "Mozilla/5.0 (iPad; CPU OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1", false, 5, "browser", DOCUMENT_ACCEPT, "none", true, true],
  ["iPadOS Mac UA", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15", false, 5, "browser", DOCUMENT_ACCEPT, "none", true, true],
  ["iPhone Safari", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1", false, 5, "browser", DOCUMENT_ACCEPT, "none", true, true],
  ["Desktop Chrome", chrome, false, 0, "browser", DOCUMENT_ACCEPT, "none", false, true],
  ["Desktop Edge", chrome + " Edg/122.0.2365.52", false, 0, "browser", DOCUMENT_ACCEPT, "none", false, true],
  ["Desktop Firefox", "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0", false, 0, "browser", DOCUMENT_ACCEPT, "none", false, true],
  ["Tauri desktop", chrome, true, 0, "desktop", DOCUMENT_ACCEPT, "wry", false, true],
  ["Empty browser UA", "", false, 0, "browser", DOCUMENT_ACCEPT, "none", false, true],
] as const;

afterEach(() => vi.unstubAllGlobals());
describe("frozen user-agent investigation", () => {
  for (const [name, ua, shell, points, role, accept, transport, handheld, folders] of rows) {
    it(name, () => {
      vi.stubGlobal("window", shell ? { __TAURI_INTERNALS__: {} } : {});
      vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints: points });
      vi.stubGlobal("document", { createElement: () => ({ webkitdirectory: false }) });
      expect(deviceRole()).toBe(role);
      expect(documentPickerAccept()).toBe(accept);
      expect(liveWebviewTransport()).toBe(transport);
      expect(isHandheldDevice()).toBe(handheld);
      expect(folderPickSupported()).toBe(folders);
    });
  }
  it("records substring versus word-boundary detection separately", () => {
    const ua = "AndroidStudio/2025.1";
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent: ua, maxTouchPoints: 0 });
    vi.stubGlobal("document", { createElement: () => ({ webkitdirectory: false }) });
    expect(deviceRole()).toBe("android");
    expect(documentPickerAccept()).toBe(DOCUMENT_ACCEPT);
    expect(liveWebviewTransport()).toBe("wry");
    expect(isHandheldDevice()).toBe(false);
    expect(folderPickSupported()).toBe(false);
  });
});
