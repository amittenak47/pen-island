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

describe("item chips", () => {
  it("say a few well-chosen words", async () => {
    const { chipTitle } = await import("../util/docFootnotes");
    expect(chipTitle("**Helps with:** Exercise 3.3(c), Exercise 3.3(d)")).toBe("Helps with 3.3(c), 3.3(d)");
    expect(chipTitle("**Helps with:** Exercise 3.1, Exercise 3.2, Exercise 3.3, Exercise 3.12")).toBe("Helps with 3.1, 3.2, 3.3, 3.12");
    expect(chipTitle("**Helps with:** Exercise 3.1, 3.2, 3.3, 3.12, 3.16(a), HW 2(b)")).toBe("Helps with");
    expect(chipTitle("**Think about it:** Which tasks could swap places?")).toBe("Which tasks could swap places?");
    expect(chipTitle("**Think about it:** Which tasks could exchange places without breaking any precedence constraint?")).toBe("Which tasks could exchange places…?");
    expect(chipTitle("**Looking ahead:** Pre and post numbers come next.")).toBe("Ahead: Pre and post numbers come next");
    expect(chipTitle("Finish times run opposite to the arrows.")).toBe("Finish times run opposite to the arrows");
    expect(chipTitle("A topological order, which respects every arrow, puts prerequisites first.")).toBe("A topological order");
    expect(chipTitle("Think of a single clock ticking through the whole search")).toBe("Think of a single clock…");
    expect(chipTitle("Edges point opposite to the order in which DFS finishes them")).toBe("Edges point opposite…");
    expect(chipTitle("Short.")).toBe("Short");
    const { fieldChip } = await import("../util/docFootnotes");
    expect(fieldChip({ text: "**Idea:** Finish times run opposite to the arrows." })).toBeNull();
    expect(fieldChip({ text: "**Idea:** Finish times run opposite to the arrows.", field: "Idea" }))
      .toEqual({ tag: "Idea", text: "Finish times run opposite to the arrows" });
    expect(fieldChip({ text: "**Helps with:** Exercise 3.3(c), Exercise 3.3(d).", field: "Helps with" }))
      .toEqual({ tag: "Helps with", text: "3.3(c), 3.3(d)" });
  });
});
