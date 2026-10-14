import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LcClient } from "../api/client";
import type { DocFootnote } from "./docFootnotes";
import { applyFootnotePing, applyFootnoteResult, buildFootnoteRequest } from "./footnoteRequests";

beforeEach(() => vi.stubGlobal("indexedDB", new IDBFactory()));
afterEach(() => vi.unstubAllGlobals());

const edges = vi.hoisted(() => [] as { from: unknown; to: unknown; kind: string }[]);
vi.mock("./noteLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./noteLinks")>()),
  putEdge: async (edge: { from: unknown; to: unknown; kind: string }) => { edges.push(edge); },
}));

const store = vi.hoisted(() => ({ doc: null as null | { id: string; name: string; footnotes: unknown[] } }));
vi.mock("./annotateStore", () => ({
  getAnnotateDoc: async () => store.doc,
  saveAnnotateDoc: async () => {},
  mutateAnnotateFootnotes: async (id: string, mutate: (footnotes: unknown[]) => unknown[]) => {
    if (!store.doc || store.doc.id !== id) return "gone";
    store.doc = { ...store.doc, footnotes: [...mutate(store.doc.footnotes)] };
    return "saved";
  },
}));

const PALETTE = ["#60a5fa", "#f472b6", "#facc15", "#34d399"];
const TEXT = "We now explore  depth-first search\non directed graphs.";

function mark(patch: Partial<DocFootnote> = {}): DocFootnote {
  return {
    id: "fn-1",
    kind: "ai",
    anchor: { kind: "text", start: 100, end: 100 + TEXT.length },
    excerpt: TEXT,
    blockText: TEXT,
    palette: PALETTE,
    createdAt: 1,
    pending: "fr-1",
    ...patch,
  };
}

describe("rich ChatBot answers", () => {
  it("sets an empty title and color from the mark's palette, and places marks on the quoted words", () => {
    const [next] = applyFootnoteResult([mark()], {
      id: "fr-1",
      notes: ["Explores deep first."],
      title: "DFS",
      color: 3,
      marks: [
        { kind: "highlight", quote: "Depth-First Search", color: 1 },
        { kind: "underline", quote: "directed graphs" },
      ],
    }, 50);
    expect(next!.title).toBe("DFS");
    expect(next!.color).toBe("#facc15");
    const [highlight, underline] = next!.subMarks!;
    expect(highlight).toMatchObject({ kind: "highlight", excerpt: "depth-first search", color: "#60a5fa" });
    expect(TEXT.slice(highlight!.start, highlight!.end)).toBe("depth-first search");
    expect(underline).toMatchObject({ kind: "underline", excerpt: "directed graphs" });
    expect(underline!.color).toBeUndefined();
    expect(next!.updatedAt).toBe(50);
  });

  it("never replaces what the reader set, and skips quotes it cannot find or already has", () => {
    const own = { id: "sm-own", kind: "underline" as const, excerpt: "directed graphs", start: 38, end: 53 };
    const [next] = applyFootnoteResult([mark({ title: "Mine", color: "#123456", subMarks: [own] })], {
      id: "fr-1",
      notes: ["n"],
      title: "DFS",
      color: 2,
      marks: [
        { kind: "underline", quote: "directed  graphs" },
        { kind: "highlight", quote: "breadth-first" },
      ],
    });
    expect(next!.title).toBe("Mine");
    expect(next!.color).toBe("#123456");
    expect(next!.subMarks).toEqual([own]);
  });

  it("adds no marks to a region mark, which has no text offsets to place them", () => {
    const region = mark({ anchor: { kind: "region", page: 1, rect: { x: 0, y: 0, w: 1, h: 1 } } as unknown as DocFootnote["anchor"] });
    const [next] = applyFootnoteResult([region], { id: "fr-1", notes: ["n"], marks: [{ kind: "highlight", quote: "depth-first" }] });
    expect(next!.subMarks).toBeUndefined();
    expect(next!.pending).toBeUndefined();
  });

  it("sends the palette, the marked text and the library items with a request", () => {
    const request = buildFootnoteRequest({
      id: "fr-1", deviceId: "dev", docId: "doc-1", docName: "Algorithms",
      anchor: { kind: "text", start: 0, end: 4 }, excerpt: "depth-first search",
      pageText: null, pages: null, viewerPage: null, footnotes: [], exceptId: "fn-1",
      palette: [...PALETTE, "not-a-color"], markText: TEXT,
      workspaceItems: [{ id: "whiteboard:wb-1", kind: "whiteboard", title: "DFS notes" }],
      docKind: "annotate",
    });
    expect(request.extras).toEqual({
      palette: PALETTE,
      mark_text: TEXT,
      workspace_items: [{ id: "whiteboard:wb-1", kind: "whiteboard", title: "DFS notes" }],
      doc_kind: "annotate",
    });
    const bare = buildFootnoteRequest({
      id: "fr-2", deviceId: "dev", docId: "doc-1", docName: "Algorithms",
      anchor: { kind: "text", start: 0, end: 4 }, excerpt: "x",
      pageText: null, pages: null, viewerPage: null, footnotes: [], exceptId: "fn-1",
    });
    expect(bare.extras).toBeUndefined();
  });

  it("carries the sheet's focus, density and generic attachments on a selection request", () => {
    const references = [
      { kind: "file" as const, title: "Homework.md", text: "A solved problem." },
      { kind: "pages" as const, title: "Pages 106–114", text: "Chapter problems." },
    ];
    const request = buildFootnoteRequest({
      id: "fr-selection", deviceId: "dev", docId: "doc-1", docName: "Algorithms",
      anchor: { kind: "text", start: 0, end: 4, scope: "p91" }, excerpt: "DFS",
      pageText: "DFS explores deep first.", pages: null, viewerPage: 91, footnotes: [], exceptId: "fn-1",
      focus: "  Preview the next chapter's problems.  ", perPage: 8, references,
    });
    expect(request.page).toBe(91);
    expect(request.extras).toEqual({
      focus: "Preview the next chapter's problems.", per_page: 8, references,
    });
    expect(request.extras!.references![0]).not.toBe(references[0]);
    expect(request.prompt).toBeNull();
  });

  it("keeps selection settings within the limits accepted by the hub", () => {
    const input = {
      id: "fr-selection", deviceId: "dev", docId: "doc-1", docName: "Algorithms",
      anchor: { kind: "text" as const, start: 0, end: 4 }, excerpt: "DFS",
      pageText: null, pages: null, viewerPage: null, footnotes: [], exceptId: "fn-1",
    };
    expect(buildFootnoteRequest({ ...input, focus: "x".repeat(1100), perPage: 4 }).extras).toEqual({
      focus: "x".repeat(1000), per_page: 4,
    });
    expect(buildFootnoteRequest({ ...input, focus: "  ", perPage: 0, references: [] }).extras).toBeUndefined();
    expect(buildFootnoteRequest({ ...input, perPage: 8.5 }).extras).toBeUndefined();
  });

  it("links the document to each chosen library item once the answer is saved", async () => {
    edges.length = 0;
    store.doc = { id: "doc-1", name: "Doc", footnotes: [mark()] };
    const client = { postFootnoteRequest: async () => {}, ackFootnoteRequest: async () => {} } as unknown as LcClient;
    await applyFootnotePing(client, {
      footnote_results: [{
        id: "fr-1", doc_id: "doc-1",
        result: {
          notes: ["answer"],
          workspace_links: [
            { id: "whiteboard:wb-1", kind: "whiteboard", title: "DFS notes" },
            { id: "thread:nope", kind: "thread", title: "not linkable" },
          ],
          link_from: "web",
        },
      }],
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      kind: "chatbot",
      from: { type: "web", id: "doc-1" },
      to: { type: "whiteboard", id: "wb-1", title: "DFS notes" },
    });
  });
});
