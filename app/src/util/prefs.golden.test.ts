/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as agentDisplayPrefs from "./agentDisplayPrefs";
import * as agentPrefs from "./agentPrefs";
import * as agentSheetLockPref from "./agentSheetLockPref";
import * as autosavePref from "./autosavePref";
import * as booktabsPref from "./booktabsPref";
import * as capturePrefs from "./capturePrefs";
import * as chromeWakePref from "./chromeWakePref";
import * as devicePrefs from "./devicePrefs";
import * as eraserPartialPref from "./eraserPartialPref";
import * as headerModesPref from "./headerModesPref";
import * as hubAutoSyncPref from "./hubAutoSyncPref";
import * as hubSyncWindowPillPref from "./hubSyncWindowPillPref";
import * as inkBoldnessPref from "./inkBoldnessPref";
import * as inkDisplayHzPref from "./inkDisplayHzPref";
import * as inkHighlightPref from "./inkHighlightPref";
import * as inkPerfOverlayPref from "./inkPerfOverlayPref";
import * as inkSmoothingPref from "./inkSmoothingPref";
import * as inkSpeedPref from "./inkSpeedPref";
import * as inkToolPrefs from "./inkToolPrefs";
import * as linedPaperPref from "./linedPaperPref";
import * as notesCombinedPref from "./notesCombinedPref";
import * as notificationCardsPref from "./notificationCardsPref";
import * as palettePref from "./palettePref";
import * as pdfReadingPref from "./pdfReadingPref";
import * as readingModePref from "./readingModePref";
import * as startupTabsPref from "./startupTabsPref";

type PrefModule = Record<string, unknown>;
type Entry = { name: string; module: PrefModule; keys: string[]; loads: [string, string][]; saves: [string, unknown[]][]; events: string[] };
const entries: Entry[] = [
  { name: "agentDisplayPrefs", module: agentDisplayPrefs, keys: ["whiteboard.agentDisplay"], loads: [["loadAgentDisplayPrefs", "{\"autoCollapseThinking\":true,\"collapseThinkingSteps\":true,\"colorThinkingSteps\":false}"]], saves: [["saveAgentDisplayPrefs", [{ autoCollapseThinking: true, collapseThinkingSteps: true, colorThinkingSteps: false }, {}, { autoCollapseThinking: "garbage" }]]], events: ["lc-agent-display"] },
  { name: "agentPrefs", module: agentPrefs, keys: ["whiteboard.agent.testForward.v1", "whiteboard.agent.forwardFailures.v1", "whiteboard.coach.forwardFailures.v1", "whiteboard.agent.reasoning.v1", "whiteboard.agent.reasoningLevel.v1"], loads: [["loadTestForwardMode", "per-case"], ["loadForwardFailures", "1"], ["loadAgentReasoning", "1"], ["loadAgentReasoningLevel", "high"]], saves: [["saveTestForwardMode", ["per-case", "garbage", "", "NaN", "-100", "1000000"]], ["saveForwardFailures", [true, false]], ["saveAgentReasoning", [true, false]], ["saveAgentReasoningLevel", ["high", "garbage", "", "NaN", "-100", "1000000"]]], events: [] },
  { name: "agentSheetLockPref", module: agentSheetLockPref, keys: ["whiteboard.agent.sheetLock.v1", "whiteboard.coach.sheetLock.v1"], loads: [["loadAgentSheetLock", "1"]], saves: [["saveAgentSheetLock", [true, false]]], events: ["lc-agent-sheet-lock"] },
  { name: "autosavePref", module: autosavePref, keys: ["whiteboard.autosave.ms", "whiteboard.autosave.banner"], loads: [["loadAutosaveInterval", "15000"], ["loadAutosaveBanner", "off"]], saves: [["saveAutosaveInterval", [0, 3000, 15000, 60000, -100, 1000000, NaN]], ["saveAutosaveBanner", ["off", "garbage", "", "NaN", "-100", "1000000"]]], events: ["lc-autosave-interval"] },
  { name: "booktabsPref", module: booktabsPref, keys: ["whiteboard.booktabs.show.v1", "whiteboard.booktabs.position.v1", "whiteboard.booktabs.footnotes.v1", "whiteboard.footnoteTitles.show.v1"], loads: [["loadShowBooktabs", "0"], ["loadBooktabPosition", "top"], ["loadBooktabFootnotes", "all"], ["loadShowFootnoteTitles", "0"]], saves: [["saveShowBooktabs", [true, false]], ["saveBooktabPosition", ["beside", "top", "bottom", "garbage"]], ["saveBooktabFootnotes", ["chatbot", "all", "garbage"]], ["saveShowFootnoteTitles", [true, false]]], events: ["lc-booktabs"] },
  { name: "capturePrefs", module: capturePrefs, keys: ["whiteboard.capture.autoSave", "whiteboard.capture.mode", "whiteboard.capture.destination", "whiteboard.capture.folder", "whiteboard.capture.countdown"], loads: [["loadCaptureMode", "board-save"], ["loadAutoSaveCaptures", "1"], ["loadCaptureDestination", "downloads"], ["loadCaptureFolder", "  folder/name  "], ["loadCaptureCountdown", "5"]], saves: [["saveCaptureMode", ["board-save", "garbage", "", "NaN", "-100", "1000000"]], ["saveAutoSaveCaptures", [true, false]], ["saveCaptureDestination", ["downloads", "garbage", "", "NaN", "-100", "1000000"]], ["saveCaptureFolder", ["  folder/name  ", "", "unicode: π & < >"]], ["saveCaptureCountdown", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]]], events: [] },
  { name: "chromeWakePref", module: chromeWakePref, keys: ["whiteboard.chromeWake.v1", "whiteboard.chromeWakeTint.v1"], loads: [["loadChromeWakeMarker", "pulse"], ["loadChromeWakeTint", "color"]], saves: [["saveChromeWakeMarker", ["pulse", "garbage", "", "NaN", "-100", "1000000"]], ["saveChromeWakeTint", ["color", "garbage", "", "NaN", "-100", "1000000"]]], events: ["lc-chrome-wake"] },
  { name: "devicePrefs", module: devicePrefs, keys: ["whiteboard.deviceId.v1", "whiteboard.devicePrefsCloned.v1"], loads: [["loadDeviceId", "fixed-existing-id"]], saves: [], events: [] },
  { name: "eraserPartialPref", module: eraserPartialPref, keys: ["whiteboard.eraser.partial"], loads: [["loadEraserPartial", "1"]], saves: [["saveEraserPartial", [true, false]]], events: ["lc-eraser-partial"] },
  { name: "headerModesPref", module: headerModesPref, keys: ["whiteboard.headerModes.v1"], loads: [["loadHeaderModes", "{\"annotate\":false,\"practice\":false}"]], saves: [["saveHeaderModes", [{ annotate: false, whiteboard: true, practice: false, web: true, explore: true }, {}, { annotate: "garbage" }]]], events: ["lc-header-modes"] },
  { name: "hubAutoSyncPref", module: hubAutoSyncPref, keys: ["whiteboard.hubAutoSync.v1"], loads: [["loadHubAutosyncPref", "on"], ["loadHubAutosync", "on"]], saves: [["saveHubAutosyncPref", ["on", "garbage", "", "NaN", "-100", "1000000"]]], events: ["lc-hub-autosync"] },
  { name: "hubSyncWindowPillPref", module: hubSyncWindowPillPref, keys: ["whiteboard.hubSyncWindowPill"], loads: [["loadHubSyncWindowPill", "1"]], saves: [["saveHubSyncWindowPill", [true, false]]], events: ["lc-hub-sync-window-pill"] },
  { name: "inkBoldnessPref", module: inkBoldnessPref, keys: ["whiteboard.inkBoldness"], loads: [["loadInkBoldness", "0.5"]], saves: [["saveInkBoldness", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]]], events: ["lc-ink-boldness"] },
  { name: "inkDisplayHzPref", module: inkDisplayHzPref, keys: ["whiteboard.inkDisplayHz", "whiteboard.inkMatchDisplay"], loads: [["loadInkDisplayHz", "90"], ["loadInkMatchDisplay", "1"]], saves: [["saveInkDisplayHz", ["auto", 60, 90, 120, -100, 1000000, NaN]], ["saveInkMatchDisplay", [true, false]]], events: ["lc-ink-display-hz"] },
  { name: "inkHighlightPref", module: inkHighlightPref, keys: ["whiteboard.inkHighlightTips"], loads: [["loadInkHighlightTips", "1"]], saves: [["saveInkHighlightTips", [true, false]]], events: ["lc-ink-highlight-tips"] },
  { name: "inkPerfOverlayPref", module: inkPerfOverlayPref, keys: ["whiteboard.inkPerfOverlay", "whiteboard.inkPerfBar"], loads: [["loadInkPerfOverlay", "1"], ["loadInkPerfBar", "1"]], saves: [["saveInkPerfOverlay", [true, false]], ["saveInkPerfBar", [true, false]]], events: ["lc-ink-perf-overlay"] },
  { name: "inkSmoothingPref", module: inkSmoothingPref, keys: ["whiteboard.inkSmoothing", "whiteboard.inkSmoothingMode", "whiteboard.inkClothoid", "whiteboard.inkCapillary"], loads: [["loadInkSmoothing", "0.5"], ["loadInkSmoothingMode", "live"], ["loadInkClothoid", "1"], ["loadInkCapillary", "1"]], saves: [["saveInkSmoothing", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]], ["saveInkSmoothingMode", ["live", "garbage", "", "NaN", "-100", "1000000"]], ["saveInkClothoid", [true, false]], ["saveInkCapillary", [true, false]]], events: [] },
  { name: "inkSpeedPref", module: inkSpeedPref, keys: ["whiteboard.inkSpeed", "whiteboard.inkSpeedBlotBlend", "whiteboard.inkSpeedFade", "whiteboard.inkGrain"], loads: [["loadInkSpeed", "0.5"], ["loadInkSpeedBlotBlend", "0.5"], ["loadInkSpeedFade", "0.5"], ["loadInkGrain", "0.5"]], saves: [["saveInkSpeed", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]], ["saveInkSpeedBlotBlend", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]], ["saveInkSpeedFade", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]], ["saveInkGrain", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]]], events: ["lc-ink-speed-blot-blend", "lc-ink-speed-fade", "lc-ink-grain"] },
  { name: "inkToolPrefs", module: inkToolPrefs, keys: ["whiteboard.inkToolPrefs.v1"], loads: [["loadInkToolPrefs", "{\"penWidth\":2,\"eraserWidth\":3,\"inkFullness\":0.5,\"pressureSensitive\":false,\"inkColor\":\"#123456\",\"straightInk\":true}"]], saves: [["saveInkToolPrefs", [{ penWidth: 2, eraserWidth: 3, inkFullness: 0.5, pressureSensitive: false, inkColor: "#123456", straightInk: true }, { penWidth: -100, eraserWidth: 1000000, inkFullness: 2, pressureSensitive: true, inkColor: null, straightInk: false }, {}]]], events: ["lc-ink-tool-prefs"] },
  { name: "linedPaperPref", module: linedPaperPref, keys: ["whiteboard.linedPaper.v1"], loads: [["loadLinedPaperMode", "college"]], saves: [["saveLinedPaperMode", ["college", "garbage", "", "NaN", "-100", "1000000"]]], events: [] },
  { name: "notesCombinedPref", module: notesCombinedPref, keys: ["whiteboard.footnoteNotesCombined.v1"], loads: [["loadNotesCombined", "1"]], saves: [["saveNotesCombined", [true, false]]], events: [] },
  { name: "notificationCardsPref", module: notificationCardsPref, keys: ["whiteboard.notificationCards"], loads: [["loadNotificationCards", "1"]], saves: [["saveNotificationCards", [true, false]]], events: [] },
  { name: "palettePref", module: palettePref, keys: ["whiteboard.palette.tag", "whiteboard.palette.v1"], loads: [["loadPaletteTag", "\"pastel\""], ["loadPalettePrefs", "{\"tags\":[\"pastel\",\"dark\"],\"matchAll\":true,\"mixColours\":true}"]], saves: [["savePaletteTag", ["pastel", "garbage", "", "NaN", "-100", "1000000"]], ["savePalettePrefs", [{ tags: ["pastel", "dark"], matchAll: true, mixColours: true }, { tags: ["garbage"], matchAll: false, mixColours: false }, {}]]], events: [] },
  { name: "pdfReadingPref", module: pdfReadingPref, keys: ["whiteboard.pdfFlickHud.v1", "whiteboard.pdfFlickMomentum.v1"], loads: [["loadPdfFlickHud", "1"], ["loadPdfFlickMomentum", "0.5"]], saves: [["savePdfFlickHud", [true, false]], ["savePdfFlickMomentum", [-100, -0, 0, 0.5, 1, 2, 1000000, NaN, Infinity, -Infinity]]], events: ["lc-pdf-reading"] },
  { name: "readingModePref", module: readingModePref, keys: ["whiteboard.readingMode.v1", "whiteboard.pageFit.v1", "whiteboard.textSpread.v1"], loads: [["loadReadingMode", "pages"], ["loadPageFit", "margin"], ["loadTextSpread", "1"]], saves: [["saveReadingMode", ["pages", "garbage", "", "NaN", "-100", "1000000"]], ["savePageFit", ["margin", "garbage", "", "NaN", "-100", "1000000"]], ["saveTextSpread", [true, false]]], events: ["lc-reading-mode"] },
  { name: "startupTabsPref", module: startupTabsPref, keys: ["whiteboard.startupTabs.v1"], loads: [["loadStartupTabs", "home"]], saves: [["saveStartupTabs", ["home", "garbage", "", "NaN", "-100", "1000000"]]], events: [] },

];

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function storageRow(entry: Entry, stored: string | null, failRead = false, failWrite = false) {
  const values = new Map(entry.keys.flatMap(key => stored === null ? [] : [[key, stored] as const]));
  const reads: string[] = [], writes: [string, string][] = [], events: [string, unknown][] = [];
  vi.stubGlobal("crypto", { randomUUID: () => "golden-device-id" });
  vi.stubGlobal("localStorage", {
    getItem(key: string) { reads.push(key); if (failRead) throw new Error("read denied"); return values.get(key) ?? null; },
    setItem(key: string, value: string) { writes.push([key, String(value)]); if (failWrite) throw new Error("write denied"); values.set(key, String(value)); },
    removeItem(key: string) { values.delete(key); },
  });
  const dispatch = vi.spyOn(window, "dispatchEvent").mockImplementation(event => {
    events.push([event.type, (event as CustomEvent).detail]); return true;
  });
  return { reads, writes, events, seed: (key: string, value: string) => values.set(key, value), finish: () => dispatch.mockRestore() };
}

describe("frozen preference storage table", () => {
  it("covers every current Pref/Prefs module", () => {
    const names = Object.keys(import.meta.glob(["./*Pref.ts", "./*Prefs.ts"]))
      .map(path => path.slice(2, -3)).sort();
    expect(names).toEqual(entries.map(entry => entry.name));
  });
  for (const entry of entries) {
    for (const [name, valid] of entry.loads) {
      it(`${entry.name}.${name}: exact reads, values and fallback`, () => {
        const rows = [["unset", null], ["valid", valid], ["garbage", "garbage"], ["low", "-100"], ["high", "1000000"], ["NaN", "NaN"], ["empty", ""], ["zero", "0"], ["one", "1"], ["Infinity", "Infinity"], ["-Infinity", "-Infinity"], ["structured low", '{"penWidth":-100,"eraserWidth":-100,"inkFullness":-100}'], ["structured high", '{"penWidth":1000000,"eraserWidth":1000000,"inkFullness":1000000}'], ["legacy only", null], ["read throws", null], ["write throws", null]] as const;
        const log = rows.map(([input, stored]) => {
          const row = storageRow(entry, stored, input === "read throws", input === "write throws");
          if (input === "legacy only") for (const key of entry.keys.slice(1)) row.seed(key, "1");
          const result = (entry.module[name] as () => unknown)();
          row.finish();
          return { input, stored, result, reads: row.reads, writes: row.writes, events: row.events };
        });
        expect(log).toMatchSnapshot();
      });
    }
    for (const [name, inputs] of entry.saves) {
      it(`${entry.name}.${name}: exact stored bytes and write failure`, () => {
        const log = inputs.flatMap(input => [false, true].map(failWrite => {
          const row = storageRow(entry, null, false, failWrite);
          expect(() => (entry.module[name] as (value: unknown) => void)(input)).not.toThrow();
          row.finish();
          return { input, failWrite, reads: row.reads, writes: row.writes, events: row.events };
        }));
        expect(log).toMatchSnapshot();
      });
    }
  }
  it("devicePrefs: clone marker reads and writes", async () => {
    const entry = entries.find(entry => entry.name === "devicePrefs")!;
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
    Object.defineProperty(window, "__TAURI_INTERNALS__", { value: {}, configurable: true });
    try {
      const log = [];
      for (const stored of [null, "1", "0", "garbage", "NaN"]) {
        const row = storageRow(entry, stored);
        const clone = vi.fn(async () => ({ prefs: {} }));
        const put = vi.fn(async () => ({ prefs: {} }));
        await devicePrefs.ensureDevicePrefs({ getDevicePrefs: async () => null, cloneDevicePrefs: clone, putDevicePrefs: put } as unknown as Parameters<typeof devicePrefs.ensureDevicePrefs>[0]);
        row.finish();
        log.push({ stored, reads: row.reads, writes: row.writes, events: row.events, cloneCalls: clone.mock.calls.length, putCalls: put.mock.calls.length });
      }
      expect(log).toMatchSnapshot();
    } finally {
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    }
  });
});
