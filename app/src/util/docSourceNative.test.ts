import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { listSourceFolder, pickSourceFolder, readDocumentSource } from "./docSourceNative";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

beforeEach(() => vi.clearAllMocks());

describe("native document source folders", () => {
  it("returns a picked folder or cancellation", async () => {
    const folder = { kind: "uri", location: "content://documents/tree/primary%3ABooks", name: "Books" };
    vi.mocked(invoke).mockResolvedValueOnce(folder).mockResolvedValueOnce(null);
    expect(await pickSourceFolder()).toEqual(folder);
    expect(invoke).toHaveBeenLastCalledWith("pick_source_folder");
    expect(await pickSourceFolder()).toBeNull();
  });
  it("passes a folder's source kind and location to its listing command", async () => {
    const files = [{ kind: "path", location: "C:/Books/sub/notes.txt", name: "notes.txt", relative: "sub/notes.txt", size: 9, modified: 1 }];
    vi.mocked(invoke).mockResolvedValue(files);
    expect(await listSourceFolder("path", "C:/Books")).toEqual(files);
    expect(invoke).toHaveBeenCalledWith("list_source_folder", { kind: "path", location: "C:/Books" });
  });
  it("reads listed Android document URIs through the existing source command", async () => {
    vi.mocked(invoke).mockResolvedValue([1, 2, 3]);
    expect(new Uint8Array(await readDocumentSource("uri", "content://documents/tree/1/document/2"))).toEqual(new Uint8Array([1, 2, 3]));
    expect(invoke).toHaveBeenCalledWith("read_document_source", { kind: "uri", location: "content://documents/tree/1/document/2" });
  });
});
