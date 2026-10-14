import { describe, expect, it } from "vitest";

import { plainPreview } from "./FootnoteOverview";
import { noteIsAi } from "../util/docFootnotes";

describe("note rows", () => {
  it("preview plain words, not markdown", () => {
    expect(plainPreview("**Helps with:** Exercise 3.1, `pre[v]` and [DFS](https://x.y)")).toBe("Helps with: Exercise 3.1, pre[v] and DFS");
    expect(plainPreview("snake_case_name stays")).toBe("snake_case_name stays");
  });

  it("know who wrote a note", () => {
    const note = { id: "n", text: "t", createdAt: 1, updatedAt: 1 };
    expect(noteIsAi(note, { kind: "ai" })).toBe(true);
    expect(noteIsAi({ ...note, by: "reader" }, { kind: "ai" })).toBe(false);
    expect(noteIsAi({ ...note, by: "ai" }, { kind: "note" })).toBe(true);
    expect(noteIsAi(note, { kind: "note" })).toBe(false);
  });
});
