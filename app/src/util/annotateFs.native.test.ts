/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickDocumentFile } from "./annotateFs";
import { docIdentityHash } from "./annotateStore";
import * as native from "./docSourceNative";

vi.mock("./docSourceNative", () => ({ nativeSourcePickerAvailable: vi.fn(() => true), pickDocumentSource: vi.fn(), readDocumentSource: vi.fn() }));
beforeEach(() => { vi.clearAllMocks(); vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); document.querySelectorAll("input[type=file]").forEach(node => node.remove()); });
describe("native document picking", () => {
  it("returns the same document plus its device source and identity hash", async () => {
    const bytes = Uint8Array.from([37, 80, 68, 70, 45]).buffer;
    const pick = { kind: "path" as const, location: "C:/private/book.pdf", name: "book.pdf", size: 5, modified: 12 };
    vi.mocked(native.pickDocumentSource).mockResolvedValue(pick);
    vi.mocked(native.readDocumentSource).mockResolvedValue(bytes);
    const result = await pickDocumentFile();
    expect(result).toMatchObject({ docType: "pdf", bytes, source: { ...pick, hash: docIdentityHash({ docType: "pdf", name: pick.name, bytes }), checkedAt: expect.any(Number) } });
    expect(document.querySelector("input")).toBeNull();
  });
  it("decodes a text source before hashing", async () => {
    const text = "# notes";
    vi.mocked(native.pickDocumentSource).mockResolvedValue({ kind: "uri", location: "content://notes", name: "notes.md", size: 7, modified: null });
    vi.mocked(native.readDocumentSource).mockResolvedValue(Uint8Array.from(text, c => c.charCodeAt(0)).buffer);
    expect(await pickDocumentFile()).toMatchObject({ text, source: { hash: docIdentityHash({ docType: "markdown", name: "notes.md", text }) } });
  });
  it("falls back once when the native picker fails", async () => {
    vi.mocked(native.pickDocumentSource).mockRejectedValue(new Error("picker unavailable"));
    const result = pickDocumentFile();
    await vi.waitFor(() => expect(document.querySelector("input[type=file]")).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>("input[type=file]")!;
    const file = new File(["new notes"], "notes.md");
    Object.defineProperty(input, "files", { value: [file] });
    input.dispatchEvent(new Event("change"));
    expect(await result).toMatchObject({ text: "new notes", docType: "markdown" });
    expect(native.pickDocumentSource).toHaveBeenCalledTimes(1);
  });
  it("asks for HTML only for the Web pad and opens a picked page as a web document", async () => {
    const html = "<p>study hub</p>";
    vi.mocked(native.pickDocumentSource).mockResolvedValue({ kind: "path", location: "C:/hub/black_box_tracer.html", name: "black_box_tracer.html", size: 16, modified: 1 });
    vi.mocked(native.readDocumentSource).mockResolvedValue(Uint8Array.from(html, c => c.charCodeAt(0)).buffer);
    expect(await pickDocumentFile("web")).toMatchObject({ docType: "web", name: "black_box_tracer.html", localFileHash: expect.any(String), source: { location: "C:/hub/black_box_tracer.html" } });
    expect(native.pickDocumentSource).toHaveBeenCalledWith("web");
  });
  it("refuses a file that is not HTML from the Web pad's Load without falling back", async () => {
    vi.mocked(native.pickDocumentSource).mockResolvedValue({ kind: "uri", location: "content://notes", name: "notes.md", size: 7, modified: null });
    vi.mocked(native.readDocumentSource).mockResolvedValue(Uint8Array.from("# notes", c => c.charCodeAt(0)).buffer);
    await expect(pickDocumentFile("web")).rejects.toThrow("“notes.md” is not an HTML page. Pick a .html or .htm file.");
    expect(document.querySelector("input")).toBeNull();
  });
  it("treats native cancellation as cancellation", async () => {
    vi.mocked(native.pickDocumentSource).mockResolvedValue(null);
    expect(await pickDocumentFile()).toBeNull(); expect(document.querySelector("input")).toBeNull();
  });
});
