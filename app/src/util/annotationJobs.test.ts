import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AnnotationJobItemDto, LcClient } from "../api/client";
import type { DocFootnote } from "./docFootnotes";

// The page as pdf.js hands it over: separate text pieces, which the text layer
// shows joined with nothing between them.
const PIECES = ["Chapter 3 ", "Decompositions of graphs", "Depth-first", " search is a surprisingly", "versatile procedure."];
const STREAM = PIECES.join("");

const pdf = vi.hoisted(() => ({ open: true, pieces: null as string[] | null,
  wait: null as Promise<void> | null, reads: 0 }));
vi.mock("../modes/pdfOpenDocs", () => ({
  borrowPdfDocument: () => pdf.open ? {
    numPages: 400,
    getPage: async () => {
      pdf.reads += 1;
      if (pdf.wait) await pdf.wait;
      return { getTextContent: async () => ({ items: (pdf.pieces ?? PIECES).map((str) => ({ str })) }) };
    },
  } : null,
}));

const store = vi.hoisted(() => ({ footnotes: [] as unknown[], files: {} as Record<string, string>, fail: false }));
vi.mock("./annotateStore", () => ({
  getAnnotateDoc: async (id: string) => id === "algo"
    ? { id, name: "Algorithms", hash: "h-algo", docType: "pdf", footnotes: store.footnotes }
    : id in store.files ? { id, name: `${id}.md`, docType: "markdown", source: store.files[id] } : null,
  saveAnnotateDoc: async () => {},
  mutateAnnotateFootnotes: async (_id: string, mutate: (footnotes: unknown[]) => unknown[]) => {
    if (store.fail) throw new Error("Storage unavailable");
    store.footnotes = [...mutate(store.footnotes)];
    return "saved";
  },
}));

const edges = vi.hoisted(() => [] as unknown[]);
vi.mock("./noteLinks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./noteLinks")>()),
  putEdge: async (edge: unknown) => { edges.push(edge); },
}));

import {
  findLoosely, footnoteFromItem, jobReferences, loadChatBotAttachments, placeAnnotationJobItems,
  preparedJobAttachments, referenceChars, referencesSizeError, REFERENCES_TOTAL_CHARS,
  saveChatBotAttachments, undoAnnotationJob, type ChatBotAttachment,
} from "./annotationJobs";
import { registerOpenAnnotateFootnotes } from "./footnoteRequests";

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

const storage = new Map<string, string>();
beforeEach(() => {
  store.fail = false;
  store.footnotes = [];
  store.files = { hw: "# 3.1 Run DFS on the graph." };
  edges.length = 0;
  pdf.open = true;
  pdf.pieces = null;
  pdf.wait = null;
  pdf.reads = 0;
  storage.clear();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("builds job marks with explicit empty lists and image lists", () => {
  const empty = footnoteFromItem(item({ result: { notes: [] } }), STREAM, [], 50)!;
  expect(empty).toMatchObject({ notes: [], threads: [], bands: [], subMarks: [], userLinks: [], whiteboards: [], artifacts: [] });
  const filled = footnoteFromItem(item(), STREAM, [], 50)!;
  expect(filled.notes![0].images).toEqual([]);
  expect(filled.subMarks![0].bands).toEqual([]);
});

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

  it("adds a later run's notes to an earlier run's footnote on the same sentence, and Undo takes them back out", async () => {
    await placeAnnotationJobItems(client([item()]).client);
    expect(store.footnotes).toHaveLength(1);
    const later = item({ item_id: 7, job_id: "aj-2", result: { notes: ["Linear time: each edge is scanned twice."], title: "Other title" } });
    expect(await placeAnnotationJobItems(client([later]).client)).toEqual({ placed: 1, unplaced: 0, waiting: 0 });
    expect(store.footnotes).toHaveLength(1);
    const merged = store.footnotes[0] as DocFootnote;
    expect(merged!.title).toBe("DFS");
    expect(merged!.notes!.map((note) => note.text)).toEqual(["Explores as deep as possible before backtracking.", "Linear time: each edge is scanned twice."]);
    expect(merged!.notes![1]).toMatchObject({ jobId: "aj-2", by: "ai" });
    // A redelivery of the later run adds nothing.
    await placeAnnotationJobItems(client([later]).client);
    expect((store.footnotes[0] as DocFootnote).notes).toHaveLength(2);
    expect(await undoAnnotationJob("algo", "aj-2")).toBe(1);
    expect(store.footnotes).toHaveLength(1);
    expect((store.footnotes[0] as DocFootnote).notes!.map((note) => note.text)).toEqual(["Explores as deep as possible before backtracking."]);
  });

  it("leaves items on the hub while their PDF is not open on this device", async () => {
    pdf.open = false;
    const { client: c, acked } = client([item()]);
    expect(await placeAnnotationJobItems(c)).toEqual({ placed: 0, unplaced: 0, waiting: 1 });
    expect(acked).toEqual([]);
    expect(store.footnotes).toHaveLength(0);
  });

  it("gathers generic PDF page ranges and library files in their chosen order", async () => {
    const refs = await jobReferences({ hash: "h-algo", attachments: [
      { kind: "pages", from: 104, to: 105 },
      { kind: "file", docId: "hw", title: "dpv_ch3.md" },
      { kind: "pages", from: 110, to: 110 },
    ] });
    expect(refs.map((ref) => [ref.kind, ref.title])).toEqual([["pages", "Pages 104–105"], ["file", "dpv_ch3.md"], ["pages", "Page 110"]]);
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
    const retried = client([item()]);
    expect(await placeAnnotationJobItems(retried.client)).toEqual({ placed: 0, unplaced: 0, waiting: 0 });
    expect(retried.acked).toEqual([[1]]);
    expect(store.footnotes).toEqual([mine]);
  });

  it("undo stops a poll already reading the PDF without creating links", async () => {
    await placeAnnotationJobItems(client([item()]).client);
    let release!: () => void;
    pdf.wait = new Promise<void>((resolve) => { release = resolve; });
    const retried = client([item({ item_id: 2, result: { ...item().result,
      workspace_links: [{ id: "whiteboard:late", kind: "whiteboard", title: "Late link" }] } })]);
    const placing = placeAnnotationJobItems(retried.client);
    await vi.waitFor(() => { expect(pdf.reads).toBe(2); });
    expect(await undoAnnotationJob("algo", "aj-1")).toBe(1);
    release();
    expect(await placing).toEqual({ placed: 0, unplaced: 0, waiting: 0 });
    expect(retried.acked).toEqual([[2]]);
    expect(store.footnotes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("reports an undo save failure without claiming the run was removed", async () => {
    await placeAnnotationJobItems(client([item()]).client);
    store.fail = true;
    await expect(undoAnnotationJob("algo", "aj-1")).rejects.toThrow("Couldn't save");
    expect(store.footnotes).toHaveLength(1);
    store.fail = false;
    const retried = client([item()]);
    expect((await placeAnnotationJobItems(retried.client)).placed).toBe(1);
    expect(retried.acked).toEqual([[1]]);
    expect(store.footnotes).toHaveLength(1);
  });

  it("keeps queued items when an Undo save fails while a poll is waiting", async () => {
    await placeAnnotationJobItems(client([item()]).client);
    let release!: () => void;
    const saving = new Promise<void>((resolve) => { release = resolve; });
    const unregister = registerOpenAnnotateFootnotes({
      docId: () => "algo",
      write: async () => { await saving; return "failed"; },
    });
    try {
      const undo = undoAnnotationJob("algo", "aj-1");
      const failedUndo = expect(undo).rejects.toThrow("Couldn't save");
      const retried = client([item({ item_id: 2 })]);
      const placing = placeAnnotationJobItems(retried.client);
      await Promise.resolve();
      expect(retried.acked).toEqual([]);
      release();
      await failedUndo;
      expect(await placing).toEqual({ placed: 0, unplaced: 0, waiting: 1 });
      expect(retried.acked).toEqual([]);
      expect(store.footnotes).toHaveLength(1);
    } finally { unregister(); release(); }
  });
});

describe("ChatBot attachments", () => {
  it("accepts more than three files and retains long attachments without truncation", async () => {
    const attachments: ChatBotAttachment[] = Array.from({ length: 8 }, (_, index) => {
      const docId = `file-${index}`;
      store.files[docId] = index === 0 ? "x".repeat(160_000) : `Content ${index}`;
      return { kind: "file", docId, title: `${docId}.md` };
    });
    const references = await jobReferences({ hash: "h-algo", attachments });
    expect(references).toHaveLength(8);
    expect(references[0]!.text).toHaveLength(160_000);
    const [prepared] = await preparedJobAttachments({ hash: "h-algo", attachments: attachments.slice(0, 1) });
    expect(prepared!.chars).toBe(160_000);
    expect(prepared!.error).toBeNull();
  });

  it("reads a PDF attachment beyond the text limit used for job pages", async () => {
    pdf.pieces = ["x".repeat(15_000), " trailing words"];
    const [reference] = await jobReferences({ hash: "h-algo", attachments: [{ kind: "pages", from: 1, to: 1 }] });
    expect(reference!.text.length).toBeGreaterThan(15_000);
    expect(reference!.text).toContain("trailing words");
  });

  it("reports each unreadable or empty attachment instead of silently omitting it", async () => {
    store.files.empty = "   ";
    const attachments: ChatBotAttachment[] = [
      { kind: "file", docId: "hw", title: "Homework.md" },
      { kind: "file", docId: "missing", title: "Missing.md" },
      { kind: "file", docId: "empty", title: "Empty.md" },
    ];
    const prepared = await preparedJobAttachments({ hash: "h-algo", attachments });
    expect(prepared).toHaveLength(3);
    expect(prepared[0]).toMatchObject({ chars: store.files.hw!.length, error: null });
    expect(prepared[1]).toMatchObject({ reference: null, chars: 0 });
    expect(prepared[1]!.error).toContain("Missing.md");
    expect(prepared[2]!.error).toContain("no text");
    await expect(jobReferences({ hash: "h-algo", attachments })).rejects.toThrow("Missing.md");
  });

  it("enforces only the combined character cap and counts Unicode as the hub does", async () => {
    store.files.large = "x".repeat(REFERENCES_TOTAL_CHARS);
    const large: ChatBotAttachment = { kind: "file", docId: "large", title: "Large.md" };
    const references = await jobReferences({ hash: "h-algo", attachments: [large] });
    expect(referencesSizeError(references)).toBeNull();
    const attachments: ChatBotAttachment[] = [large, { kind: "file", docId: "hw", title: "Homework.md" }];
    const prepared = await preparedJobAttachments({ hash: "h-algo", attachments });
    expect(prepared.every((entry) => entry.error === null)).toBe(true);
    expect(referencesSizeError(prepared.map((entry) => entry.reference!))).toContain("600,000");
    await expect(jobReferences({ hash: "h-algo", attachments })).rejects.toThrow("remove an attachment");
    expect(referenceChars("A😀B")).toBe(3);
    expect(referencesSizeError([{ kind: "file", title: "Unicode.md", text: "😀".repeat(REFERENCES_TOTAL_CHARS) }])).toBeNull();
  });

  it("reports PDF attachments without readable text or outside the document", async () => {
    pdf.pieces = [];
    const [empty, outside] = await preparedJobAttachments({ hash: "h-algo", attachments: [
      { kind: "pages", from: 1, to: 2 }, { kind: "pages", from: 399, to: 401 },
    ] });
    expect(empty).toMatchObject({ reference: null, chars: 0 });
    expect(empty!.error).toContain("no text");
    expect(outside!.error).toContain("outside this document");
  });

  it("remembers multiple page ranges and files independently for each document", () => {
    const attachments: ChatBotAttachment[] = [
      { kind: "pages", from: 106, to: 114 },
      { kind: "file", docId: "hw", title: "Homework.md" },
      { kind: "pages", from: 120, to: 124, title: "Chapter notes" },
    ];
    saveChatBotAttachments("algo", attachments);
    expect(loadChatBotAttachments("algo")).toEqual(attachments);
    expect(loadChatBotAttachments("other")).toEqual([]);
  });

  it("migrates old problem pages and all remembered library files", () => {
    storage.set("whiteboard.chatBotPages.refs.v1:algo", JSON.stringify({
      problemFrom: " 104 ", problemTo: "105", files: ["hw", "notes", "a", "b", "hw", 7],
    }));
    expect(loadChatBotAttachments("algo")).toEqual([
      { kind: "pages", from: 104, to: 105 },
      ...["hw", "notes", "a", "b"].map((docId) => ({ kind: "file", docId, title: docId })),
    ]);
    saveChatBotAttachments("algo", []);
    expect(loadChatBotAttachments("algo")).toEqual([]);
  });

  it("ignores malformed remembered descriptors", () => {
    storage.set("whiteboard.chatBotPages.attachments.v2:algo", JSON.stringify([
      null, { kind: "file", docId: 7 }, { kind: "pages", from: 5, to: 2 },
      { kind: "pages", from: 0, to: 2 }, { kind: "pages", from: 2, to: 3 },
    ]));
    expect(loadChatBotAttachments("algo")).toEqual([{ kind: "pages", from: 2, to: 3 }]);
  });
});
