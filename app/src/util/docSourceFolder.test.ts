import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotateDocMeta } from "./annotateStore";
import type { FolderEntry } from "./docSourceNative";

const mocks = vi.hoisted(() => ({ source: vi.fn(), stat: vi.fn() }));
vi.mock("./docSourceStore", () => ({ getDocSource: mocks.source }));
vi.mock("./docSourceNative", () => ({ statDocumentSource: mocks.stat }));
import { matchDocSourceFolder } from "./docSourceFolder";

const doc = (id: string, name: string, docType: AnnotateDocMeta["docType"] = "markdown"): AnnotateDocMeta => ({ id, name, docType, hash: id, updatedAt: 1 });
const file = (name: string, relative = name): FolderEntry => ({ kind: "path", location: `C:/files/${relative}`, name, relative, size: 10, modified: 1 });

beforeEach(() => { mocks.source.mockReset().mockReturnValue(null); mocks.stat.mockReset(); });

describe("folder source matching", () => {
  it("matches exact case-insensitive names and all annotation sets on that file", async () => {
    const result = await matchDocSourceFolder([
      doc("one", "Notes.md"), doc("two", "NOTES.MD"), doc("partial", "notes"), doc("wrong", "Notes.md", "code"),
    ], [file("notes.md", "course/notes.md")]);
    expect(result.matches.map(row => row.doc.id)).toEqual(["one", "two"]);
    expect(result.matches[0].entry.relative).toBe("course/notes.md");
    expect(result.duplicateNames).toBe(0);
  });

  it("skips duplicate file names and counts names rather than files", async () => {
    const result = await matchDocSourceFolder([doc("one", "Notes.md"), doc("two", "Other.md")], [
      file("Notes.md", "a/Notes.md"), file("NOTES.MD", "b/NOTES.MD"), file("Other.md", "a/Other.md"), file("Other.md", "b/Other.md"), file("Other.md", "c/Other.md"),
    ]);
    expect(result.matches).toEqual([]);
    expect(result.duplicateNames).toBe(2);
  });

  it("includes missing sources and excludes reachable sources and trash", async () => {
    mocks.source.mockImplementation((id: string) => id === "unlinked" ? null : { kind: "path", location: id });
    mocks.stat.mockImplementation(async (_kind: string, location: string) => location === "missing" ? null : { size: 10, modified: 1 });
    const result = await matchDocSourceFolder([
      doc("unlinked", "Notes.md"), doc("missing", "Notes.md"), doc("reachable", "Notes.md"), { ...doc("trash", "Notes.md"), deletedAt: 1 },
    ], [file("Notes.md")]);
    expect(result.matches.map(row => row.doc.id)).toEqual(["unlinked", "missing"]);
    expect(mocks.stat).toHaveBeenCalledTimes(2);
  });

  it("keeps a source whose availability could not be determined", async () => {
    mocks.source.mockReturnValue({ kind: "uri", location: "content://file" });
    mocks.stat.mockRejectedValue(new Error("Provider unavailable"));
    const result = await matchDocSourceFolder([doc("one", "Notes.md")], [file("Notes.md")]);
    expect(result.matches).toEqual([]);
    expect(result.failures).toEqual(["Notes.md: Provider unavailable"]);
  });
});
