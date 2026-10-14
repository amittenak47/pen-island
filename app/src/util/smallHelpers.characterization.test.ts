import { afterEach, describe, expect, it, vi } from "vitest";
import { escapeHtml as codeEscape } from "./escapeHtml";
import { escapeHtml as mathEscape } from "./escapeHtml";
import { escapeHtml as readerEscape } from "./webReader";
import { prefersReducedMotion as appMotion } from "./reducedMotion";
import { prefersReducedMotion as radialMotion } from "./reducedMotion";
import { prefersReducedMotion as morphMotion } from "./reducedMotion";
import { prefersReducedMotion as exploreMotion } from "./reducedMotion";
import workspaceSource from "../Workspace.tsx?raw";

function motionCopy(source: string): () => boolean {
  const body = source.match(/function prefersReducedMotion\(\): boolean \{([\s\S]*?)\n\}/)![1];
  return new Function(body) as () => boolean;
}
const workspaceMotion = motionCopy(workspaceSource);
afterEach(() => vi.unstubAllGlobals());

describe("frozen HTML escaping table", () => {
  const rows = [
    ["& < > \" '", "&amp; &lt; &gt; &quot; &#39;", "&amp; &lt; &gt; &quot; '"],
    ["&amp;&lt;&#39;", "&amp;amp;&amp;lt;&amp;#39;", "&amp;amp;&amp;lt;&amp;#39;"],
    ["", "", ""],
    ["π 中文 🏝️", "π 中文 🏝️", "π 中文 🏝️"],
    ["a\n\tb", "a\n\tb", "a\n\tb"],
  ];
  for (const [name, escape, column] of [["CodeDocument", codeEscape, 1], ["mdMath", mathEscape, 1], ["webReader", readerEscape, 2]] as const) {
    it(name, () => { for (const row of rows) expect(escape(row[0])).toBe(row[column]); });
  }
});

describe("reduced motion copies", () => {
  for (const [name, motion] of [["App", appMotion], ["ColorRadial", radialMotion], ["MorphBar", morphMotion], ["ExploreWorkspace", exploreMotion]] as const) {
    it(`${name}: missing window, missing API and both preferences`, () => {
      vi.stubGlobal("window", undefined);
      expect(motion()).toBe(false);
      vi.stubGlobal("window", {});
      expect(motion()).toBe(false);
      for (const matches of [false, true]) {
        const matchMedia = vi.fn(() => ({ matches }));
        vi.stubGlobal("window", { matchMedia });
        expect(motion()).toBe(matches);
        expect(matchMedia).toHaveBeenCalledTimes(1);
        expect(matchMedia).toHaveBeenCalledWith("(prefers-reduced-motion: reduce)");
      }
    });
  }
  it("Workspace retains its unguarded matchMedia access", () => {
    vi.stubGlobal("window", undefined);
    expect(workspaceMotion()).toBe(false);
    vi.stubGlobal("window", {});
    expect(() => workspaceMotion()).toThrow(TypeError);
    for (const matches of [false, true]) {
      vi.stubGlobal("window", { matchMedia: () => ({ matches }) });
      expect(workspaceMotion()).toBe(matches);
    }
  });
});
