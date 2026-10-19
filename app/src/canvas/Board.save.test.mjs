import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// Exercise the real save closure without mounting the canvas and its workers.
const source = readFileSync(new URL("./Board.tsx", import.meta.url), "utf8");
const start = source.indexOf("saveBoard: (opts) => {") + "saveBoard: ".length;
const closure = source.slice(start, source.indexOf("      restoreBoard:", start)).trim().replace(/,$/, "");
const compiled = ts.transpileModule(`(${closure})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
function save(pageIds, rawFiles = {}) {
  const refs = {
    apiRef: { current: { getAppState: () => ({}), getFiles: () => rawFiles } },
    rasterInkRef: { current: pageIds === undefined ? null : { inkPageIds: () => pageIds } },
    elements: () => [], isCoachElement: () => false,
    linedPaperRef: { current: "off" }, linedPitchRef: { current: 0 },
    linedPitchPairRef: { current: null }, linedRuleRef: { current: null }, pdfDocumentRef: { current: null },
    inkPaletteHistoryRef: { current: { items: [], index: 0 } },
  };
  return new Function(...Object.keys(refs), `return ${compiled}`)(...Object.values(refs))({ assembleInk: false });
}

describe("Board save", () => {
  it("writes empty files and a manifest for a known-empty page inventory", () => {
    expect(save([])).toMatchObject({ files: {}, inkPages: { v: 1, pageIds: [] } });
  });
  it("keeps an unknown inventory absent and preserves known pages and files", () => {
    expect(save(undefined)).not.toHaveProperty("inkPages");
    const file = { id: "image", mimeType: "image/png", dataURL: "data:image/png;base64,AA==", created: 1 };
    expect(save([2], { image: file })).toMatchObject({ inkPages: { v: 1, pageIds: [2] }, files: { image: file } });
  });
});
