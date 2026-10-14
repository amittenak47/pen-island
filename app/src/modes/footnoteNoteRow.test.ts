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

describe("row titles", () => {
  it("lead with a label, a heading or the first sentence, never a long excerpt", async () => {
    const { summaryTitle } = await import("../util/docFootnotes");
    expect(summaryTitle("**Helps with:** Exercise 3.1, Exercise 3.2")).toEqual({ title: "Helps with", detail: "Exercise 3.1, Exercise 3.2" });
    expect(summaryTitle("## Tree edges\nEdges DFS walked.")).toEqual({ title: "Tree edges", detail: "Edges DFS walked." });
    expect(summaryTitle("DFS backs up at dead ends. Then it tries the next edge.")).toEqual({ title: "DFS backs up at dead ends.", detail: "Then it tries the next edge." });
    const long = summaryTitle("Think of a single clock ticking through the whole search and every vertex");
    expect(long.title).toBe("Think of a single clock ticking through the…");
    expect(long.detail).toBe("…whole search and every vertex");
    expect(summaryTitle("   ")).toEqual({ title: "", detail: "" });
  });
});
