import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnnotationJobItemDto, LcClient } from "../api/client";
import type { DocFootnote } from "./docFootnotes";

// The page as pdf.js hands it over: separate text pieces, which the text layer
// shows joined with nothing between them.
const PIECES = ["Chapter 3 ", "Decompositions of graphs", "Depth-first", " search is a surprisingly", "versatile procedure."];
const STREAM = PIECES.join("");

const pdf = vi.hoisted(() => ({ open: true }));
vi.mock("../modes/pdfOpenDocs", () => ({
  borrowPdfDocument: () => pdf.open ? {
    numPages: 400,
    getPage: async () => ({ getTextContent: async () => ({ items: PIECES.map((str) => ({ str })) }) }),
  } : null,
}));

const store = vi.hoisted(() => ({ footnotes: [] as unknown[] }));
vi.mock("./annotateStore", () => ({
  getAnnotateDoc: async (id: string) => id === "hw"
    ? { id, name: "dpv_ch3.md", hash: "h-hw", docType: "markdown", source: "# 3.1 Run DFS on the graph." }
    : { id, name: "Algorithms", hash: "h-algo", docType: "pdf", footnotes: store.footnotes },
  saveAnnotateDoc: async () => {},
  mutateAnnotateFootnotes: async (_id: string, mutate: (footnotes: unknown[]) => unknown[]) => {
    store.footnotes = [...mutate(store.footnotes)];
    return "saved";
  },
}));

const edges = vi.hoisted(() => [] as unknown[]);
vi.mock("./noteLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./noteLinks")>()),
  putEdge: async (edge: unknown) => { edges.push(edge); },
}));

import { findLoosely, footnoteFromItem, jobReferences, placeAnnotationJobItems, undoAnnotationJob } from "./annotationJobs";

const PALETTE = ["#60a5fa", "#f472b6", "#facc15", "#34d399"];

function item(patch: Partial<AnnotationJobItemDto> = {}): AnnotationJobItemDto {
  return {
    item_id: 1,
    job_id: "aj-1",
    doc_id: "algo",
    page: 91,
    scope: "p91",
    palette: PALETTE,
    doc_kind: "annotate",
    // Extracted text: the same words with spaces between the pieces.
    quote: "Depth-first search is a surprisingly versatile procedure.",
    result: {
      notes: ["Explores as deep as possible before backtracking."],
      title: "DFS",
      color: 2,
      marks: [{ kind: "highlight", quote: "depth-first search", color: 3 }],
    },
    ...patch,
  };
}

function client(items: AnnotationJobItemDto[]) {
  const acked: number[][] = [];
  return {
    acked,
    client: {
      annotationJobItems: async () => items,
      ackAnnotationJobItems: async (ids: readonly number[]) => { acked.push([...ids]); },
    } as unknown as LcClient,
  };
}

beforeEach(() => { store.footnotes = []; edges.length = 0; pdf.open = true; });
afterEach(() => vi.restoreAllMocks());

describe("page-range footnotes", () => {
  it("finds a quote whatever the spacing between the PDF's text pieces", () => {
    const at = findLoosely(STREAM, "Depth-first search is a surprisingly versatile procedure.")!;
    expect(STREAM.slice(at.start, at.end)).toBe("Depth-first search is a surprisinglyversatile procedure.");
    expect(findLoosely(STREAM, "breadth-first search")).toBeNull();
  });

  it("anchors on the page's own characters and fills title, color and marks", () => {
    const footnote = footnoteFromItem(item(), STREAM, [], 50)!;
    const anchor = footnote.anchor as { start: number; end: number; scope: string; exact: string };
    expect(anchor.scope).toBe("p91");
    expect(STREAM.slice(anchor.start, anchor.end)).toBe(anchor.exact);
    expect(anchor.exact.startsWith("Depth-first")).toBe(true);
    expect(footnote).toMatchObject({ kind: "ai", jobId: "aj-1", title: "DFS", color: "#f472b6", palette: PALETTE });
    expect(footnote.pending).toBeUndefined();
    expect(footnote.notes?.[0]?.text).toContain("backtracking");
    const mark = footnote.subMarks![0]!;
    expect(mark).toMatchObject({ kind: "highlight", color: "#facc15" });
    expect(footnote.blockText!.slice(mark.start, mark.end)).toBe("Depth-first search");
  });

  it("places a mark whose words the page runs together", () => {
    const footnote = footnoteFromItem(item({
      result: { notes: ["Linear time."], marks: [{ kind: "underline", quote: "surprisingly versatile" }] },
    }), STREAM, [], 50)!;
    const mark = footnote.subMarks![0]!;
    expect(footnote.blockText!.slice(mark.start, mark.end)).toBe("surprisinglyversatile");
  });

  it("places delivered items, links library items, and does not duplicate a retry", async () => {
    const delivered = [
      item({ result: { ...item().result, workspace_links: [{ id: "whiteboard:wb-1", kind: "whiteboard", title: "Graph notes" }] } }),
      item({ item_id: 2, quote: "not on this page at all" }),
    ];
    const first = client(delivered);
    expect(await placeAnnotationJobItems(first.client)).toEqual({ placed: 1, unplaced: 1, waiting: 0 });
    expect(first.acked).toEqual([[1, 2]]);
    expect(store.footnotes).toHaveLength(1);
    expect(edges).toHaveLength(1);
    // The same item delivered again (say the ack was lost) adds nothing.
    await placeAnnotationJobItems(client([delivered[0]!]).client);
    expect(store.footnotes).toHaveLength(1);
  });

  it("leaves items on the hub while their PDF is not open on this device", async () => {
    pdf.open = false;
    const { client: c, acked } = client([item()]);
    expect(await placeAnnotationJobItems(c)).toEqual({ placed: 0, unplaced: 0, waiting: 1 });
    expect(acked).toEqual([]);
    expect(store.footnotes).toHaveLength(0);
  });

  it("gathers the problem pages and homework files a run is read against", async () => {
    const refs = await jobReferences({ hash: "h-algo", problems: { from: 104, to: 105 }, files: [{ docId: "hw", title: "dpv_ch3.md" }] });
    expect(refs.map((ref) => [ref.kind, ref.title])).toEqual([["exercises", "Problems, pages 104–105"], ["homework", "dpv_ch3.md"]]);
    expect(refs[0]!.text).toContain("[Page 104]");
    expect(refs[1]!.text).toContain("Run DFS");
  });

  it("undo removes only the run's footnotes", async () => {
    const mine: DocFootnote = { id: "fn-mine", kind: "note", anchor: { kind: "text", start: 0, end: 5, scope: "p91" }, excerpt: "Chapt", createdAt: 1 };
    store.footnotes = [mine];
    await placeAnnotationJobItems(client([item()]).client);
    expect(store.footnotes).toHaveLength(2);
    expect(await undoAnnotationJob("algo", "aj-1")).toBe(1);
    expect(store.footnotes).toEqual([mine]);
  });
});
