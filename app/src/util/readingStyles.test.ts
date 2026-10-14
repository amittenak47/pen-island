import { describe, expect, it } from "vitest";
import { PRESETS, READING_KINDS, fieldsFor, readingStyleOf } from "./readingStyles";

describe("reading styles", () => {
  it("offers the shared fields for every kind, and keeps Looking ahead out of story presets", () => {
    for (const { kind } of READING_KINDS) {
      expect(fieldsFor(kind)).toEqual(expect.arrayContaining(["Helps with", "Think about it", "Looking ahead"]));
      expect(new Set(fieldsFor(kind)).size).toBe(fieldsFor(kind).length);
    }
    expect(PRESETS.story.flatMap((preset) => preset.fields)).not.toContain("Looking ahead");
  });

  it("sends nothing until a kind is chosen, and only the kind for free-form", () => {
    expect(readingStyleOf({ kind: null, notes: "free", fill: "best", custom: {} })).toBeNull();
    expect(readingStyleOf({ kind: "story", notes: "free", fill: "all", custom: {} })).toEqual({ kind: "story" });
    expect(readingStyleOf({ kind: "story", notes: "custom", fill: "best", custom: {} })).toBeNull();
    expect(readingStyleOf({ kind: "article", notes: "argument", fill: "all", custom: {} })).toEqual({
      kind: "article", preset: "Argument", fill: "all", fields: ["Claim", "Evidence", "Counterpoint", "Key term", "Helps with"],
    });
  });
});
