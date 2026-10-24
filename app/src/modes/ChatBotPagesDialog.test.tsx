/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnnotationJobDto, AssistantRunnerStatus, LcClient, NewAnnotationJobDto, ReadingStyleDto } from "../api/client";
import { saveChatBotAnswerMode } from "../util/chatBotClient";
import type { DocFootnote } from "../util/docFootnotes";
import { loadSelectionRuns, rememberSelectionRun, type ChatBotRun } from "../util/chatBotHistory";
import { loadReadingChoice, saveReadingChoice } from "../util/readingStyles";

const fixture = vi.hoisted(() => ({
  jobs: [] as AnnotationJobDto[],
  sources: {} as Record<string, string>,
  create: vi.fn(), cancel: vi.fn(), undo: vi.fn(),
  runner: null as AssistantRunnerStatus | null,
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
      assistantRunnerStatus: async () => fixture.runner,
    } as unknown as LcClient,
    docId: "algorithms", docName: "Algorithms", hash: "pdf-hash", currentPage: 7, pageCount: 300,
    palette: ["#60a5fa"], workspaceItems: files, onClose: vi.fn(), ...overrides,
  };
  await act(async () => { root!.render(<ChatBotPagesDialog {...props} />); });
}
function labelOf(node: Element): string { return (node.querySelector("[data-label]") ?? node).textContent?.trim() ?? ""; }
function button(label: string, scope: ParentNode = host): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find((node) => labelOf(node) === label);
  expect(found, `Missing button: ${label}`).toBeTruthy(); return found!;
}
async function click(label: string, scope: ParentNode = host) {
  await act(async () => { button(label, scope).click(); });
}
/** Lets exit animations (folding reveals, slides) finish. */
async function settle(ms = 500) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function tab(index: number) {
  await act(async () => { host.querySelectorAll<HTMLButtonElement>('[role="tab"]')[index]!.click(); });
}
function pane(index: number): HTMLElement { return host.querySelector<HTMLElement>(`#lc-chatbot-pane-${index}`)!; }
/** A radio group's chosen option, or a dropdown's shown value. */
function current(group: string): string {
  const radios = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  if (radios) return labelOf(radios.querySelector('[aria-checked="true"]')!);
  return host.querySelector(`button[aria-label^="${group}: "]`)!.textContent!.trim();
}
/** Picks from either presentation: a sliding group by its radio, a dropdown by opening it. */
async function pick(group: string, option: string) {
  const radios = host.querySelector(`[role="radiogroup"][aria-label="${group}"]`);
  if (radios) { await click(option, radios); return; }
  await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label^="${group}: "]`)!.click(); });
  const found = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((node) => node.textContent === option);
  expect(found, `Missing option: ${option}`).toBeTruthy();
  await act(async () => { found!.click(); });
  await settle(350);
}
async function choose(label: string) { await pick("Request type", label); }
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

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.scrollTo = () => {}; // Motion measures keyframes with it; jsdom does not implement it.
});
beforeEach(() => {
  localStorage.clear(); fixture.jobs = [];
  // Most tests are about other choices: start them from a remembered type.
  saveReadingChoice({ kind: "textbook", notes: "free", fill: "best", custom: {} });
  fixture.runner = null;
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
  it("needs a type on the first request, then starts from the last one", async () => {
    localStorage.clear(); await mount();
    await tab(3);
    expect(button("Start").disabled).toBe(true);
    expect(host.querySelector('[aria-label^="Notes"]')).toBeNull();
    await tab(1); await pick("Kind of text", "Story");
    await tab(3); expect(button("Start").disabled).toBe(false);
    await tab(1); expect(current("Notes")).toBe("Free-form");
    await pick("Notes", "Reading companion");
    expect(host.textContent).toContain("Context · Character · Word or phrase · Theme · Think about it · Helps with");
    await click("All fields"); await tab(3); await click("Start");
    expect(fixture.create.mock.calls[0]![0]).toMatchObject({ reading: {
      kind: "story", preset: "Reading companion", fill: "all",
      fields: ["Context", "Character", "Word or phrase", "Theme", "Think about it", "Helps with"],
    } });
    expect(loadReadingChoice()).toMatchObject({ kind: "story", notes: "companion", fill: "all" });
    await act(async () => root!.unmount()); host.remove(); await mount();
    expect(current("Kind of text")).toBe("Story");
    expect(current("Notes")).toBe("Reading companion");
    // Still changeable: another kind keeps Free-form and Custom, and moves off a preset it lacks.
    await pick("Kind of text", "Code");
    expect(current("Notes")).toBe("Code reading");
  });

  it("builds a custom preset from the kind's fields and the reader's own", async () => {
    const onSelectionRequest = vi.fn(async (_settings: SelectionRequestSettings) => ({ id: "fr-selected", page: 7 }));
    await mount({ selection, onSelectionRequest });
    await tab(1); await pick("Notes", "Custom");
    await tab(3); expect(button("Start").disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Pick at least one field");
    await tab(1); await click("Common mistake");
    const own = host.querySelector<HTMLInputElement>('input[aria-label="Name your own field"]')!;
    await fill(own, "Proof sketch"); await click("Add");
    expect(button("Proof sketch").getAttribute("aria-pressed")).toBe("true");
    await tab(3); await click("Start");
    expect(onSelectionRequest.mock.calls[0]![0].reading).toEqual({
      kind: "textbook", preset: "Custom", fill: "best", fields: ["Common mistake", "Proof sketch"],
    });
    expect(loadReadingChoice().custom.textbook).toEqual(["Common mistake", "Proof sketch"]);
  });

  it("sends a free-form request with only its kind", async () => {
    await mount(); await tab(3); await click("Start");
    expect(fixture.create.mock.calls[0]![0]).toMatchObject({ reading: { kind: "textbook" } });
    expect((fixture.create.mock.calls[0]![0] as NewAnnotationJobDto).reading).toEqual({ kind: "textbook" });
  });

  it("sends the selected answer mode on page jobs and explains the single-footnote model limit", async () => {
    saveChatBotAnswerMode("app"); await mount(); await tab(3); await click("Start");
    expect(fixture.create.mock.calls[0]![0]).toMatchObject({ answer_mode: "app" });
    expect(host.textContent).not.toContain("Your AI model answers single footnotes");
    saveChatBotAnswerMode("llm");
    await act(async () => root!.render(<ChatBotPagesDialog {...props} />));
    expect(host.textContent).toContain("Your AI model answers single footnotes; page runs need an assistant.");
    await click("Start"); expect(fixture.create.mock.calls[1]![0]).toMatchObject({ answer_mode: "llm" });
  });
  it("offers Selection only while nonempty text is selected", async () => {
    const onSelectionRequest = vi.fn(async () => ({ id: "fr-selected", page: 7 }));
    await mount({ onSelectionRequest });
    const labels = () => [...host.querySelectorAll('[aria-label="Request type"] button')].map(labelOf);
    expect(labels()).toEqual(["This page", "Page range"]);
    await act(async () => { root!.render(<ChatBotPagesDialog {...props} selection={{ ...selection, text: "  " }} />); });
    expect(labels()).toEqual(["This page", "Page range"]);
    await act(async () => { root!.render(<ChatBotPagesDialog {...props} selection={selection} />); });
    expect(labels()).toEqual(["Selection", "This page", "Page range"]);
    await choose("Selection");
    expect(host.textContent).toContain(selection.text);
    await act(async () => { root!.render(<ChatBotPagesDialog {...props} selection={null} />); });
    expect(labels()).toEqual(["This page", "Page range"]);
    expect(button("This page").getAttribute("aria-checked")).toBe("true");
  });

  it("sends This page as one job page without exposing range inputs", async () => {
    await mount();
    expect(pane(0).querySelector('input[type="number"]')).toBeNull();
    expect(button("This page").getAttribute("aria-checked")).toBe("true");
    await tab(3); await click("Start");
    const body = fixture.create.mock.calls[0]![0] as NewAnnotationJobDto;
    expect(body).toMatchObject({ request_type: "page", per_page: 4, doc_id: "algorithms", device_id: "device-test" });
    expect(body.pages).toEqual([{ page: 7, scope: "p7", text: "The text of page 7." }]);
    expect(host.querySelector('[role="status"]')!.textContent).toContain("Sent to ChatBot");
  });

  it("shows the Page range only for that request and enforces its 40-page limit", async () => {
    await mount(); await choose("Page range");
    await fill(input("From page"), "20"); await fill(input("To page"), "60");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("Up to 40 pages");
    await tab(3); expect(button("Start").disabled).toBe(true);
    await tab(0); await fill(input("To page"), "59");
    await tab(3); expect(button("Start").disabled).toBe(false);
    await click("Start");
    const body = fixture.create.mock.calls[0]![0] as NewAnnotationJobDto;
    expect(body.request_type).toBe("pages"); expect(body.pages).toHaveLength(40);
    expect(body.pages[0]!.page).toBe(20); expect(body.pages[39]!.page).toBe(59);
    await tab(0); await choose("This page"); await settle(); expect(pane(0).querySelector('input[type="number"]')).toBeNull();
  });

  it("forwards focus, density and file/page attachments through the selection path", async () => {
    const onSelectionRequest = vi.fn(async (_settings: SelectionRequestSettings) => ({ id: "fr-selected", page: 7 }));
    await mount({ selection, onSelectionRequest });
    expect(button("Selection").getAttribute("aria-checked")).toBe("true");
    await fill(host.querySelector("textarea")!, "  Proof intuition  "); await click("Thorough");
    await tab(2); await click("Notes 1.md");
    await fill(input("Attach from page"), "106"); await fill(input("Attach to page"), "107");
    await click("Add pages"); await tab(3); await click("Start");
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
    await tab(2);
    for (let index = 1; index <= 4; index++) await click(`Notes ${index}.md`);
    const entries = [...host.querySelectorAll('[aria-label="Attachments"] li')];
    expect(entries).toHaveLength(4);
    for (let index = 0; index < entries.length; index++) {
      expect(entries[index]!.querySelector("strong")!.textContent).toBe(`Notes ${index + 1}.md`);
      expect(entries[index]!.querySelector("small")!.textContent).toBe("6 characters");
    }
    expect(button("Notes 5.md").disabled).toBe(false); await tab(3); await click("Start");
    expect((fixture.create.mock.calls[0]![0] as NewAnnotationJobDto).references).toHaveLength(4);
    expect(host.textContent).toContain("24 characters / 600,000 total");
  });

  it("blocks an attachment set over the total cap and recovers when one is removed", async () => {
    fixture.sources["file-0"] = "x".repeat(600_000); fixture.sources["file-1"] = "y";
    await mount(); await tab(2); await click("Notes 1.md");
    await tab(3); expect(button("Start").disabled).toBe(false);
    expect(host.querySelector('[aria-label="Attachments"] small')!.textContent).toBe("600,000 characters");
    await tab(2); await click("Notes 2.md");
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("600,001 characters");
    await tab(3); expect(button("Start").disabled).toBe(true);
    expect(fixture.create).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Remove attachment 2"]')!.click(); });
    for (let tries = 0; tries < 40 && host.querySelector('[role="alert"]'); tries++) await settle(100);
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
    await tab(3); await click("Start");
    expect((fixture.create.mock.calls[0]![0] as NewAnnotationJobDto).references).toEqual([
      { kind: "file", title: "Notes 1.md", text: "Text 0" },
    ]);
  });

  it("allows a PDF attachment longer than the 40-page request limit", async () => {
    await mount(); await tab(2);
    await fill(input("Attach from page"), "106"); await fill(input("Attach to page"), "160");
    expect(button("Add pages").disabled).toBe(false);
    expect(host.textContent).not.toContain("Up to 40 pages");
    await click("Add pages");
    expect(host.querySelector('[aria-label="Attachments"] strong')!.textContent).toBe("Pages 106–160");
    await tab(3); expect(button("Start").disabled).toBe(false); await click("Start");
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
    expect(document.activeElement).toBe(button("Page range")); expect(input("From page")).toBeTruthy();
    await key(button("Page range"), "Home");
    expect(document.activeElement).toBe(button("Selection")); await settle(); expect(pane(0).querySelector('input[type="number"]')).toBeNull();
    await key(button("Normal"), "ArrowRight");
    expect(document.activeElement).toBe(button("Thorough"));
    expect(button("Thorough").getAttribute("aria-checked")).toBe("true");
    await tab(3); await click("Start");
    expect(onSelectionRequest.mock.calls[0]![0].perPage).toBe(8);
  });

  it("keeps the sheet open on content clicks and closes on its backdrop or close control", async () => {
    const onClose = vi.fn(); await mount({ onClose });
    await act(async () => { host.querySelector<HTMLElement>(".lc-chatbot-pages h2")!.click(); });
    await tab(2); await click("Notes 1.md");
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => { host.querySelector<HTMLElement>(".lc-chatbot-pages-scrim")!.click(); });
    expect(onClose).toHaveBeenCalledOnce(); onClose.mockClear();
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Close ChatBot"]')!.click(); });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ChatBot steps", () => {
  const tabs = () => [...host.querySelectorAll<HTMLElement>('[role="tab"]')];
  const selected = () => tabs().findIndex((node) => node.getAttribute("aria-selected") === "true");
  const panes = () => [0, 1, 2, 3].map((index) => pane(index).getAttribute("data-pos"));
  const skip = () => host.querySelector<HTMLButtonElement>(".lc-chatbot-skip-link")!;

  it("walks Request, Reading, Attach and Review with Next and Back, sliding each pane", async () => {
    await mount();
    expect(tabs().map((node) => node.textContent?.replace(/^[\d✓]+/, ""))).toEqual(["Request", "Reading", "Attach", "Review"]);
    expect(selected()).toBe(0); expect(panes()).toEqual(["current", "after", "after", "after"]);
    expect(host.querySelector(".lc-chatbot-back-slot")!.hasAttribute("data-open")).toBe(false);
    await click("Next"); expect(selected()).toBe(1); expect(panes()).toEqual(["before", "current", "after", "after"]);
    expect(host.querySelector(".lc-chatbot-back-slot")!.hasAttribute("data-open")).toBe(true);
    await click("Next"); await click("Next");
    expect(selected()).toBe(3); expect(panes()).toEqual(["before", "before", "before", "current"]);
    expect(() => button("Next")).toThrow(); expect(button("Start")).toBeTruthy();
    await click("Back"); expect(selected()).toBe(2); expect(panes()).toEqual(["before", "before", "current", "after"]);
  });

  it("jumps by tab and by keyboard, and marks visited steps", async () => {
    await mount();
    await tab(2); expect(selected()).toBe(2);
    expect(tabs()[0]!.hasAttribute("data-done")).toBe(true); expect(tabs()[1]!.hasAttribute("data-done")).toBe(false);
    await act(async () => { tabs()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(selected()).toBe(1);
  });

  it("folds Skip away on Review and sends Skip to Review with what is set", async () => {
    await mount();
    expect(host.querySelector(".lc-chatbot-skip")!.hasAttribute("data-open")).toBe(true);
    await act(async () => { skip().click(); });
    expect(selected()).toBe(3); expect(host.querySelector(".lc-chatbot-skip")!.hasAttribute("data-open")).toBe(false);
    expect(skip().disabled).toBe(true); expect(skip().tabIndex).toBe(-1);
  });

  it("holds Next and Skip until a first request has a document kind", async () => {
    localStorage.clear(); await mount();
    expect(skip().disabled).toBe(false); await act(async () => { skip().click(); });
    expect(selected()).toBe(1); expect(button("Next").disabled).toBe(true); expect(skip().disabled).toBe(true);
    expect(tabs()[1]!.querySelector(".lc-chatbot-step-dot")).toBeNull();
    await tab(0); expect(tabs()[1]!.querySelector(".lc-chatbot-step-dot")).toBeTruthy();
    await tab(1); await pick("Kind of text", "Paper");
    expect(button("Next").disabled).toBe(false);
  });

  it("recaps the request on Review and lets each row jump back", async () => {
    await mount(); await fill(host.querySelector("textarea")!, "Key definitions");
    await click("Thorough"); await pick("Notes", "Study");
    await tab(2); await click("Notes 2.md"); await tab(3);
    const text = host.querySelector(".lc-chatbot-review-note")!.textContent!;
    expect(text).toContain("Your assistant will annotate page 7, focusing on Key definitions.");
    expect(text).toContain("The bot will limit notes to 8 per page.");
    expect(text).toContain("It will read the text as a textbook and try to fill in the Idea, Example, Common mistake, Helps with and Think about it fields");
    expect(text).toContain("It will use Notes 2.md as context.");
    expect(host.querySelector(".lc-chatbot-review")!.textContent).toContain("Thorough · about 8 per page");
    await act(async () => { host.querySelector<HTMLButtonElement>('[aria-label="Edit Document"]')!.click(); });
    expect(selected()).toBe(1);
  });

  it("uses a dropdown for more than three options and a sliding group for three or fewer", async () => {
    await mount(); await tab(1);
    expect(host.querySelector('button[aria-label^="Kind of text: "]')).toBeTruthy();
    expect(host.querySelector('[role="radiogroup"][aria-label="Kind of text"]')).toBeNull();
    expect(host.querySelector('button[aria-label^="Notes: "]')).toBeTruthy();
    await pick("Kind of text", "Article");
    expect(host.querySelector('[role="radiogroup"][aria-label="Notes"]')).toBeTruthy();
    expect(host.querySelector('button[aria-label^="Notes: "]')).toBeNull();
    expect(host.querySelector('[role="radiogroup"][aria-label="Request type"]')!.querySelectorAll(".lc-sliding-seg-thumb")).toHaveLength(1);
  });

  it("opens past requests in place of the steps and returns on its toggle", async () => {
    fixture.jobs = [job() as AnnotationJobDto]; await mount();
    const link = () => host.querySelector<HTMLButtonElement>(".lc-chatbot-history-link")!;
    const layers = () => [...host.querySelectorAll(".lc-chatbot-layer")].map((node) => node.getAttribute("data-pos"));
    expect(layers()).toEqual(["current", "after"]); expect(link().textContent).toBe("History");
    await act(async () => { link().click(); });
    expect(layers()).toEqual(["before", "current"]); expect(link().textContent).toBe("New request");
    await act(async () => { link().click(); });
    expect(layers()).toEqual(["current", "after"]);
  });

  it("leaves out the history toggle until there are past requests", async () => {
    await mount(); expect(host.querySelector(".lc-chatbot-history-link")).toBeNull();
  });
});

describe("ChatBot history", () => {
  it("shows the app runner's progress and failure on its matching page-run row", async () => {
    fixture.jobs = [job({ status: "open", answer_mode: "app" }) as AnnotationJobDto];
    fixture.runner = { app: "codex", state: "running", job_id: "aj-history", started_at: 1, finished_at: null };
    await mount(); expect(host.querySelector(".lc-chatbot-history-row")!.textContent).toContain("Codex is writing…");
    fixture.runner = { ...fixture.runner, state: "failed", finished_at: 2, error: "private process output" };
    await act(async () => { window.dispatchEvent(new Event("lc-annotation-jobs")); });
    expect(host.querySelector(".lc-chatbot-history-row")!.textContent).toContain("Codex couldn't finish. Open Settings → ChatBot → Test.");
    expect(host.textContent).not.toContain("private process output");
  });
  it("keeps an older failed runner from marking a newer app selection as failed", async () => {
    const run = job({ id: "fr-new-app", request_type: "selection", answer_mode: "app", status: "open", created_at: 100 });
    rememberSelectionRun("algorithms", run);
    fixture.runner = { app: "codex", state: "failed", job_id: null, started_at: 50, finished_at: 60 };
    await mount({ footnotes: [mark("pending-new", 7, "New request", { jobId: run.id, pending: run.id })] });
    expect(host.querySelector(".lc-chatbot-history-row")!.textContent).toContain("In progress");
    expect(host.textContent).not.toContain("couldn't finish");
  });
  it("shows configuration and footnote titles in a popup, and jumps to a listed page", async () => {
    fixture.jobs = [job() as AnnotationJobDto]; const onJumpToPage = vi.fn(); const onClose = vi.fn();
    await mount({ onJumpToPage, onClose, footnotes: [
      mark("dfs", 7, "Depth-first search"), mark("traversal", 7, "Traversal order"), mark("backtrack", 8, "Backtracking"),
      mark("other", 20, "Other run", { jobId: "aj-other" }),
    ] });
    expect(host.querySelector('[aria-label="History"]')!.textContent).toContain("Pages 7–8 · 3 footnotes · Finished");
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

  it("shows a page run's stored preset after the sheet's choice changes", async () => {
    fixture.jobs = [job({ reading: { kind: "story", preset: "Reading companion", fields: ["Context"], fill: "best" } }) as AnnotationJobDto];
    await mount(); await openHistory();
    expect(popup().textContent).toContain("Story · Reading companion");
    await act(async () => { host.querySelector<HTMLElement>(".lc-chatbot-run-scrim")!.click(); });
    await tab(1); await pick("Kind of text", "Article"); await click("Argument"); await openHistory();
    expect(popup().textContent).toContain("Story · Reading companion");
    expect(popup().textContent).not.toContain("Article · Argument");
  });

  it("remembers a selection request's custom style and keeps it when the sheet changes", async () => {
    const onSelectionRequest = vi.fn(async (_settings: SelectionRequestSettings) => ({ id: "fr-reading", page: 7 }));
    await mount({ selection, onSelectionRequest });
    await tab(1); await pick("Notes", "Custom"); await click("Idea"); await tab(3); await click("Start");
    expect(loadSelectionRuns("algorithms")[0]!.reading).toEqual(onSelectionRequest.mock.calls[0]![0].reading);
    await tab(1); await pick("Kind of text", "Article"); await click("Free-form");
    await act(async () => root!.unmount()); host.remove(); await mount();
    await openHistory();
    expect(popup().textContent).toContain("Textbook · Custom");
    expect(popup().textContent).not.toContain("Article · Free-form");
  });

  it.each([
    { reading: { kind: "article" as const }, label: "Article · Free-form" },
    { reading: { kind: "textbook" as const, fields: ["Idea"], fill: "best" as const }, label: "Textbook · Custom" },
  ])("labels historical styles as $label", async ({ label, reading }) => {
    fixture.jobs = [job({ reading }) as AnnotationJobDto]; await mount(); await openHistory();
    expect(popup().textContent).toContain(label);
  });

  it.each([
    { request_type: "pages" as const, reading: undefined },
    { request_type: "pages" as const, reading: {} as ReadingStyleDto },
    { request_type: "selection" as const, reading: undefined },
    { request_type: "selection" as const, reading: {} as ReadingStyleDto },
  ])("opens old $request_type runs without a recorded style ($reading)", async (patch) => {
    const run = job(patch);
    if (run.request_type === "selection") rememberSelectionRun("algorithms", run);
    else fixture.jobs = [run as AnnotationJobDto];
    await mount(); await openHistory();
    expect(popup().textContent).toContain("Reading style not recorded");
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
