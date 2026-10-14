/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationJobDto, LcClient, NewAnnotationJobDto } from "../api/client";
import type { DocFootnote } from "../util/docFootnotes";
import { loadSelectionRuns, rememberSelectionRun, type ChatBotRun } from "../util/chatBotHistory";

const fixture = vi.hoisted(() => ({
  jobs: [] as AnnotationJobDto[],
  sources: {} as Record<string, string>,
  create: vi.fn(), cancel: vi.fn(), undo: vi.fn(),
}));
vi.mock("../modes/pdfOpenDocs", () => ({
  borrowPdfDocument: () => ({
    numPages: 300,
    getPage: async (page: number) => ({
      getTextContent: async () => ({ items: [{ str: `The text of page ${page}.` }] }),
    }),
  }),
}));
vi.mock("../util/annotateStore", () => ({
  getAnnotateDocMeta: (id: string) => id in fixture.sources ? { docType: "markdown" } : null,
  getAnnotateDoc: async (id: string) => id in fixture.sources ? { source: fixture.sources[id] } : null,
}));
vi.mock("../util/devicePrefs", () => ({ loadDeviceId: () => "device-test" }));
vi.mock("../util/annotationJobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../util/annotationJobs")>()),
  undoAnnotationJob: fixture.undo,
}));

import { ChatBotPagesDialog, type ChatBotPagesDialogProps, type SelectionRequestSettings } from "./ChatBotPagesDialog";

const selection = {
  text: "Depth-first search", excerpt: "Depth-first search",
  anchor: { kind: "text" as const, start: 0, end: 18, scope: "p7" }, hitRects: [],
};
const files = Array.from({ length: 5 }, (_, index) => ({
  id: `annotate:file-${index}`, kind: "annotate", title: `Notes ${index + 1}.md`,
}));
function job(patch: Partial<ChatBotRun> = {}): ChatBotRun {
  return {
    id: "aj-history", doc_id: "algorithms", doc_name: "Algorithms", request_type: "pages",
    page_from: 7, page_to: 8, focus: "Graph traversal", per_page: 4,
    pages_total: 2, pages_done: 2, footnotes: 3, status: "done", created_at: 1,
    references: [{ kind: "file", title: "Chapter notes.md" }, { kind: "pages", title: "Pages 106–114" }],
    summary: "Explained the key ideas.", ...patch,
  };
}
function mark(id: string, page: number, title: string, patch: Partial<DocFootnote> = {}): DocFootnote {
  return { id, kind: "ai", anchor: { kind: "text", start: 0, end: 4, scope: `p${page}` },
    excerpt: "Text", title, createdAt: 1, jobId: "aj-history", ...patch };
}
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement;
let props: ChatBotPagesDialogProps;
async function mount(overrides: Partial<ChatBotPagesDialogProps> = {}) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  props = {
    client: {
      annotationJobs: async () => fixture.jobs,
      createAnnotationJob: fixture.create, cancelAnnotationJob: fixture.cancel,
    } as unknown as LcClient,
    docId: "algorithms", docName: "Algorithms", hash: "pdf-hash", currentPage: 7, pageCount: 300,
    palette: ["#60a5fa"], workspaceItems: files, onClose: vi.fn(), ...overrides,
  };
  await act(async () => { root!.render(<ChatBotPagesDialog {...props} />); });
}
function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent?.trim() === label);
  expect(found, `Missing button: ${label}`).toBeTruthy(); return found!;
}
async function click(label: string, scope: ParentNode = host) {
  await act(async () => { button(label, scope).click(); });
}
async function choose(label: string) {
  await click(label, host.querySelector('[aria-label="Request type"]')!);
}
function input(label: string): HTMLInputElement {
  const found = [...host.querySelectorAll("label")].find((node) => node.firstChild?.textContent === label)?.querySelector("input");
  expect(found, `Missing input: ${label}`).toBeTruthy(); return found!;
}
async function fill(node: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function popup(): HTMLElement { return host.querySelector('[aria-label="Run details"]')!; }
async function openHistory() {
  await act(async () => { host.querySelector<HTMLButtonElement>(".lc-chatbot-history-row")!.click(); });
  expect(popup()).toBeTruthy();
}

beforeAll(() => { (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });
beforeEach(() => {
  localStorage.clear(); fixture.jobs = [];
  fixture.sources = Object.fromEntries(files.map((_, index) => [`file-${index}`, `Text ${index}`]));
  fixture.create.mockReset().mockImplementation(async (_body: NewAnnotationJobDto) => undefined);
  fixture.cancel.mockReset().mockImplementation(async (id: string) => {
    fixture.jobs = fixture.jobs.map((entry) => entry.id === id ? { ...entry, status: "cancelled" } : entry);
  });
  fixture.undo.mockReset().mockResolvedValue(3);
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined; document.body.textContent = ""; vi.restoreAllMocks();
});

describe("ChatBot requests", () => {
  it("offers Selection only while nonempty text is selected", async () => {
    const onSelectionRequest = vi.fn(async () => ({ id: "fr-selected", page: 7 }));
    await mount({ onSelectionRequest });
    const labels = () => [...host.querySelectorAll('[aria-label="Request type"] button')].map((node) => node.textContent);
    expect(labels()).toEqual(["This page", "Pages"]);
    await act(async () => { root!.render(<ChatBotPagesDialog {...props} selection={{ ...selection, text: "  " }} />); });
    expect(labels()).toEqual(["This page", "Pages"]);
    await act(async () => { root!.render(<ChatBotPagesDialog {...props} selection={selection} />); });
    expect(labels()).toEqual(["Selection", "This page", "Pages"]);
    await choose("Selection");
    expect(host.textContent).toContain(selection.text);
    await act(async () => { root!.render(<ChatBotPagesDialog {...props} selection={null} />); });
    expect(labels()).toEqual(["This page", "Pages"]);
    expect(button("This page").getAttribute("aria-checked")).toBe("true");
  });

  it("sends This page as one job page without exposing range inputs", async () => {
    await mount();
    expect(host.querySelector('input[type="number"]')).toBeNull();
    expect(button("This page").getAttribute("aria-checked")).toBe("true");
    await click("Start");
    const body = fixture.create.mock.calls[0]![0] as NewAnnotationJobDto;
    expect(body).toMatchObject({ request_type: "page", per_page: 4, doc_id: "algorithms", device_id: "device-test" });
    expect(body.pages).toEqual([{ page: 7, scope: "p7", text: "The text of page 7." }]);
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Sent to ChatBot");
  });

  it("shows the Pages range only for that request and enforces its 40-page limit", async () => {
    await mount(); await choose("Pages");
    await fill(input("From page"), "20"); await fill(input("To page"), "60");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Up to 40 pages");
    expect(button("Start").disabled).toBe(true);
    await fill(input("To page"), "59");
    expect(button("Start").disabled).toBe(false);
    await click("Start");
    const body = fixture.create.mock.calls[0]![0] as NewAnnotationJobDto;
    expect(body.request_type).toBe("pages"); expect(body.pages).toHaveLength(40);
    expect(body.pages[0]!.page).toBe(20); expect(body.pages[39]!.page).toBe(59);
    await choose("This page"); expect(host.querySelector('input[type="number"]')).toBeNull();
  });

  it("forwards focus, density and file/page attachments through the selection path", async () => {
    const onSelectionRequest = vi.fn(async (_settings: SelectionRequestSettings) => ({ id: "fr-selected", page: 7 }));
    await mount({ selection, onSelectionRequest });
    expect(button("Selection").getAttribute("aria-checked")).toBe("true");
    await fill(host.querySelector("textarea")!, "  Proof intuition  "); await click("Thorough");
    await click("Attach"); await click("Notes 1.md");
    await fill(input("Attach from page"), "106"); await fill(input("Attach to page"), "107");
    await click("Attach pages"); await click("Start");
    expect(fixture.create).not.toHaveBeenCalled(); expect(onSelectionRequest).toHaveBeenCalledOnce();
    expect(onSelectionRequest.mock.calls[0]![0]).toMatchObject({
      focus: "Proof intuition", perPage: 8, references: [
        { kind: "file", title: "Notes 1.md", text: "Text 0" },
        { kind: "pages", title: "Pages 106–107" },
      ],
    });
    expect(loadSelectionRuns("algorithms")[0]).toMatchObject({ id: "fr-selected", request_type: "selection", focus: "Proof intuition", per_page: 8 });
    expect(host.querySelector('[role="status"]')!.textContent).toBe("Selection sent to ChatBot.");
  });

  it("attaches more than three files and shows the size of each", async () => {
    await mount(); expect(host.querySelector('[aria-label="Attachments"]')).toBeNull();
    await click("Attach");
    for (let index = 1; index <= 4; index++) await click(`Notes ${index}.md`);
    const entries = [...host.querySelectorAll('[aria-label="Attachments"] li')];
    expect(entries).toHaveLength(4);
    for (let index = 0; index < entries.length; index++) {
      expect(entries[index]!.querySelector("strong")!.textContent).toBe(`Notes ${index + 1}.md`);
      expect(entries[index]!.querySelector("small")!.textContent).toBe("6 characters");
    }
    expect(button("Notes 5.md").disabled).toBe(false); await click("Start");
    expect((fixture.create.mock.calls[0]![0] as NewAnnotationJobDto).references).toHaveLength(4);
    expect(host.textContent).toContain("24 characters / 600,000 total");
  });

  it("blocks an attachment set over the total cap and recovers when one is removed", async () => {
    fixture.sources["file-0"] = "x".repeat(600_000); fixture.sources["file-1"] = "y";
    await mount(); await click("Attach"); await click("Notes 1.md");
    expect(button("Start").disabled).toBe(false);
    expect(host.querySelector('[aria-label="Attachments"] small')!.textContent).toBe("600,000 characters");
    await click("Notes 2.md");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("600,001 characters");
    expect(button("Start").disabled).toBe(true);
    expect(fixture.create).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Remove attachment 2"]')!.click(); });
    expect(host.querySelector('[role="alert"]')).toBeNull(); expect(button("Start").disabled).toBe(false);
  });

  it("restores old remembered file IDs with their current library titles", async () => {
    localStorage.setItem("whiteboard.chatBotPages.refs.v1:algorithms", JSON.stringify({
      problemFrom: "", problemTo: "", files: ["file-0"],
    }));
    await mount();
    const attachments = host.querySelector('[aria-label="Attachments"]')!;
    expect(attachments.querySelector("strong")!.textContent).toBe("Notes 1.md");
    expect(attachments.querySelector("small")!.textContent).toBe("6 characters");
    await click("Start");
    expect((fixture.create.mock.calls[0]![0] as NewAnnotationJobDto).references).toEqual([
      { kind: "file", title: "Notes 1.md", text: "Text 0" },
    ]);
  });

  it("allows a PDF attachment longer than the 40-page request limit", async () => {
    await mount(); await click("Attach");
    await fill(input("Attach from page"), "106"); await fill(input("Attach to page"), "160");
    expect(button("Attach pages").disabled).toBe(false);
    expect(host.textContent).not.toContain("Up to 40 pages");
    await click("Attach pages");
    expect(host.querySelector('[aria-label="Attachments"] strong')!.textContent).toBe("Pages 106–160");
    expect(button("Start").disabled).toBe(false); await click("Start");
    const body = fixture.create.mock.calls[0]![0] as NewAnnotationJobDto;
    expect(body.pages).toHaveLength(1); expect(body.request_type).toBe("page");
    expect(body.references).toHaveLength(1);
    expect(body.references![0]).toMatchObject({ kind: "pages", title: "Pages 106–160" });
    expect(body.references![0]!.text.match(/\[Page \d+\]/g)).toHaveLength(55);
    expect(body.references![0]!.text).toContain("The text of page 160.");
  });

  it("uses Settings' keyboard navigation for request and density choices", async () => {
    const onSelectionRequest = vi.fn(async (_settings: SelectionRequestSettings) => ({ id: "fr-keyboard", page: 7 }));
    await mount({ selection, onSelectionRequest });
    const key = async (node: HTMLButtonElement, name: string) => {
      await act(async () => { node.focus(); node.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true })); });
    };
    expect(button("Selection").tabIndex).toBe(0); expect(button("This page").tabIndex).toBe(-1);
    await key(button("Selection"), "ArrowRight");
    expect(document.activeElement).toBe(button("This page"));
    expect(button("This page").getAttribute("aria-checked")).toBe("true");
    await key(button("This page"), "End");
    expect(document.activeElement).toBe(button("Pages")); expect(input("From page")).toBeTruthy();
    await key(button("Pages"), "Home");
    expect(document.activeElement).toBe(button("Selection")); expect(host.querySelector('input[type="number"]')).toBeNull();
    await key(button("Normal"), "ArrowRight");
    expect(document.activeElement).toBe(button("Thorough"));
    expect(button("Thorough").getAttribute("aria-checked")).toBe("true");
    await click("Start");
    expect(onSelectionRequest.mock.calls[0]![0].perPage).toBe(8);
  });

  it("keeps the sheet open on content clicks and closes on its backdrop or close control", async () => {
    const onClose = vi.fn(); await mount({ onClose });
    await act(async () => { host.querySelector<HTMLElement>(".lc-chatbot-pages h2")!.click(); });
    await click("Attach"); await click("Notes 1.md");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLElement>(".lc-chatbot-pages-scrim")!.click(); });
    expect(onClose).toHaveBeenCalledOnce(); onClose.mockClear();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Close ChatBot"]')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ChatBot history", () => {
  it("shows configuration and footnote titles in a popup, and jumps to a listed page", async () => {
    fixture.jobs = [job() as AnnotationJobDto]; const onJumpToPage = vi.fn(); const onClose = vi.fn();
    await mount({ onJumpToPage, onClose, footnotes: [
      mark("dfs", 7, "Depth-first search"), mark("traversal", 7, "Traversal order"), mark("backtrack", 8, "Backtracking"),
      mark("other", 20, "Other run", { jobId: "aj-other" }),
    ] });
    expect(host.querySelector('[aria-label="History"]')!.textContent).toContain("Pages · Pages 7–8 · 3 footnotes · Finished");
    expect([...host.querySelectorAll("button")].some((node) => node.textContent === "Undo" || node.textContent === "Cancel")).toBe(false);
    expect(host.textContent).not.toContain("Graph traversal"); await openHistory();
    expect(popup().textContent).toContain("Pages 7–8 · Normal · Finished");
    expect(popup().textContent).toContain("Focus: Graph traversal");
    expect(popup().textContent).toContain("Chapter notes.md"); expect(popup().textContent).toContain("Pages 106–114");
    expect(popup().textContent).toContain("Explained the key ideas.");
    const pageButtons = [...popup().querySelectorAll<HTMLButtonElement>("button")].filter((node) => node.querySelector("strong"));
    expect(pageButtons.map((node) => node.textContent)).toEqual(["Page 7Depth-first search · Traversal order", "Page 8Backtracking"]);
    expect(popup().textContent).not.toContain("Other run");
    await act(async () => { pageButtons[1]!.click(); });
    expect(onJumpToPage).toHaveBeenCalledWith(8); expect(onClose).toHaveBeenCalledOnce();
  });

  it("cancels an open page run from its popup", async () => {
    fixture.jobs = [job({ status: "open", pages_done: 0 }) as AnnotationJobDto]; await mount();
    expect(host.querySelector(".lc-chatbot-run-popup")).toBeNull(); await openHistory();
    await click("Cancel", popup()); expect(fixture.cancel).toHaveBeenCalledWith("aj-history");
    expect(popup().textContent).toContain("Cancelled");
    expect([...popup().querySelectorAll("button")].some((node) => node.textContent === "Cancel")).toBe(false);
    expect(fixture.undo).not.toHaveBeenCalled();
  });

  it("stops an open run before undoing its footnotes, with both actions confined to the popup", async () => {
    fixture.jobs = [job({ status: "open", pages_done: 0 }) as AnnotationJobDto]; await mount();
    expect([...host.querySelectorAll("button")].some((node) => node.textContent === "Undo" || node.textContent === "Cancel")).toBe(false);
    await openHistory(); expect(button("Cancel", popup())).toBeTruthy(); await click("Undo", popup());
    expect(fixture.cancel).toHaveBeenCalledWith("aj-history"); expect(fixture.undo).toHaveBeenCalledWith("algorithms", "aj-history");
    expect(fixture.cancel.mock.invocationCallOrder[0]!).toBeLessThan(fixture.undo.mock.invocationCallOrder[0]!);
    expect(popup().querySelector('[role="status"]')!.textContent).toBe("Removed 3 footnotes.");
  });

  it("cancels a selection run through the existing selection request path", async () => {
    const run = job({ id: "fr-selection-history", request_type: "selection", page_to: 7, status: "open", pages_done: 0, footnotes: 1 });
    rememberSelectionRun("algorithms", run); const onCancelSelectionRequest = vi.fn(async () => {});
    await mount({ onCancelSelectionRequest, footnotes: [
      mark("pending-selection", 7, "Selection idea", { jobId: run.id, pending: run.id }),
    ] });
    expect(host.querySelector(".lc-chatbot-history-row")!.textContent).toContain("Selection · Page 7 · 1 footnote · In progress");
    await openHistory(); await click("Cancel", popup());
    expect(onCancelSelectionRequest).toHaveBeenCalledWith(run.id); expect(fixture.cancel).not.toHaveBeenCalled();
    expect(loadSelectionRuns("algorithms")[0]!.status).toBe("cancelled"); expect(popup().textContent).toContain("Cancelled");
  });

  it("closes only the popup on its backdrop or close control, preserving the sheet", async () => {
    fixture.jobs = [job() as AnnotationJobDto]; const onClose = vi.fn(); await mount({ onClose });
    await openHistory();
    expect(popup().closest(".lc-chatbot-pages")).toBeNull();
    await act(async () => { popup().querySelector<HTMLElement>("h2")!.click(); });
    expect(popup()).toBeTruthy(); expect(onClose).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLElement>(".lc-chatbot-run-scrim")!.click(); });
    expect(popup()).toBeNull(); expect(host.querySelector('[aria-label="ChatBot"]')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    await openHistory();
    await act(async () => { popup().querySelector<HTMLButtonElement>('[aria-label="Close Pages"]')!.click(); });
    expect(popup()).toBeNull(); expect(onClose).not.toHaveBeenCalled();
  });
});
