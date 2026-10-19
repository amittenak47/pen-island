import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { storedLinedPitch } from "../util/linedPaperPref";

// Exercise the real save closure without mounting the canvas and its workers.
const source = readFileSync(new URL("./Board.tsx", import.meta.url), "utf8");
const start = source.indexOf("saveBoard: (opts) => {") + "saveBoard: ".length;
const closure = source.slice(start, source.indexOf("      restoreBoard:", start)).trim().replace(/,$/, "");
const compiled = ts.transpileModule(`(${closure})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function save(pageIds, rawFiles = {}, authored = false, overrides = {}) {
  const refs = {
    apiRef: { current: { getAppState: () => ({}), getFiles: () => rawFiles } },
    rasterInkRef: { current: pageIds === undefined ? null : { inkPageIds: () => pageIds, hasInk: () => false } },
    elements: () => [], isCoachElement: () => false,
    linedPaperRef: { current: "off" }, linedPitchRef: { current: 0 },
    linedPitchPairRef: { current: null }, linedRuleRef: { current: null }, pdfDocumentRef: { current: null },
    inkPaletteHistoryRef: { current: { items: [], index: 0 } },
    inkPaletteAuthoredRef: { current: authored }, linedPaperAuthoredRef: { current: authored }, linedRuleAuthoredRef: { current: authored },
    linedStoredPitchRef: { current: false }, linedSavedPitchesRef: { current: { linedPitch: null, linedPitchWide: null, linedPitchCollege: null } },
    storedLinedPitch,
    ...overrides,
  };
  return new Function(...Object.keys(refs), `return ${compiled}`)(...Object.values(refs))({ assembleInk: false });
}

describe("Board save", () => {
  it("writes null for unset ruling fields and inherited palette history", () => {
    expect(save([])).toMatchObject({ appState: { scrollX: 0, scrollY: 0, zoom: 1,
      linedPaperMode: null, linedPitch: null, linedPitchWide: null, linedPitchCollege: null, linedRule: null }, inkPalettes: null });
    expect(save([], {}, true)).toMatchObject({ appState: { linedPaperMode: "off" }, inkPalettes: { items: [], index: 0 } });
  });
  it("writes empty files and a manifest for a known-empty page inventory", () => {
    expect(save([])).toMatchObject({ files: {}, inkPages: { v: 1, pageIds: [] } });
  });
  it("keeps device theme and fitted ruling defaults unauthored until selected or written to", () => {
    const defaults = { linedPaperRef: { current: "college" }, linedRuleRef: { current: "college" },
      linedPitchRef: { current: 28 }, linedPitchPairRef: { current: { wide: 36, college: 28 } },
      inkPaletteHistoryRef: { current: { items: [["#123456", "#abcdef"]], index: 0 } } };
    expect(save([], {}, false, defaults)).toMatchObject({ appState: {
      linedPaperMode: null, linedRule: null, linedPitch: null, linedPitchWide: null, linedPitchCollege: null }, inkPalettes: null });
    expect(save([], {}, true, defaults)).toMatchObject({ appState: {
      linedPaperMode: "college", linedRule: "college", linedPitch: 28, linedPitchWide: 36, linedPitchCollege: 28 },
      inkPalettes: { items: [["#123456", "#abcdef"]], index: 0 } });
  });
  it("preserves a legacy pitch without authoring its derived device defaults", () => {
    expect(save([], {}, false, {
      linedStoredPitchRef: { current: true }, linedSavedPitchesRef: { current: { linedPitch: 36, linedPitchWide: null, linedPitchCollege: null } },
      linedPitchRef: { current: 28 }, linedPitchPairRef: { current: { wide: 36, college: 28 } },
    })).toMatchObject({ appState: { linedPitch: 36, linedPitchWide: null, linedPitchCollege: null, linedRule: null } });
  });
  it("keeps an unknown inventory absent and preserves known pages and files", () => {
    expect(save(undefined)).not.toHaveProperty("inkPages");
    const file = { id: "image", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 };
    expect(save([2], { image: file })).toMatchObject({ inkPages: { v: 1, pageIds: [2] }, files: { image: file } });
  });
});
