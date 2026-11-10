/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LcClient, SearchOptions } from "../api/client";
import type { ProblemSummary } from "../api/types";
import { saveBrowsePosition } from "../util/browsePosition";
import { ProblemBrowser, searchKey, startsSearch } from "./ProblemBrowser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function row(task_id: string): ProblemSummary {
  return {
    key: `leetcode/${task_id}`,
    task_id,
    question_id: null,
    difficulty: "Easy",
    tags: [],
    test_count: 1,
  } as unknown as ProblemSummary;
}

/** Every query gets its own results, so a stale row is easy to tell apart. */
const RESULTS: Record<string, string[]> = {
  "": ["two-sum", "add-two-numbers", "longest-substring", "median-of-two-arrays", "minimum-remove-to-make-valid-parentheses"],
  "valid parentheses": [
    "valid-parentheses",
    "check-if-there-is-a-valid-parentheses-string-path",
    "longest-valid-parentheses",
    "minimum-remove-to-make-valid-parentheses",
  ],
};

function fakeClient() {
  const searchProblems = vi.fn(async (opts: SearchOptions & { limit?: number; offset?: number }) => {
    const ids = RESULTS[opts.q ?? ""] ?? [];
    return { items: ids.map(row), total: ids.length };
  });
  return {
    client: {
      searchProblems,
      tags: vi.fn(async () => []),
      datasets: vi.fn(async () => []),
    } as unknown as LcClient,
    searchProblems,
  };
}

let host: HTMLDivElement;
let root: Root;

async function flush(ms = 0) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function mount(onPick = vi.fn(), extra: { onRandomSession?: () => void } = {}) {
  const { client } = fakeClient();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <ProblemBrowser
        client={client}
        onPick={onPick}
        busy={false}
        themeId="blue"
        onThemePick={() => {}}
        onStartSession={() => {}}
        onRandomSession={extra.onRandomSession}
      />,
    );
  });
  await flush();
  return { onPick, search: () => host.querySelector<HTMLInputElement>('input[aria-label="Search problems"]')! };
}

function setQuery(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(target: EventTarget, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  // jsdom lays nothing out; the browser keeps the highlighted row in view.
  Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
});

describe("library search and Enter", () => {
  it("opens the top match of a new search, not the remembered row index", async () => {
    // The last visit left the highlight on row 4.
    saveBrowsePosition({ dataset: "leetcode", query: "", difficulty: "", tag: "", sort: "task_id", page: 0, selected: 3 });
    const { onPick, search } = await mount();
    expect(host.querySelector(".lc-row-selected")?.textContent).toContain("Median Of Two Arrays");

    setQuery(search(), "valid parentheses");
    await flush(300);
    press(search(), "Enter");

    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe("valid-parentheses");
  });

  it("waits for a search still in flight, then opens its top match", async () => {
    const { onPick, search } = await mount();
    setQuery(search(), "valid parentheses");
    // Enter straight after the last keystroke, inside the search debounce.
    press(search(), "Enter");
    expect(onPick).not.toHaveBeenCalled();

    await flush(300);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick.mock.calls[0][0]).toBe("valid-parentheses");
    expect(onPick.mock.calls[0][1]).toMatchObject({ q: "valid parentheses" });
  });

  it("moves the highlight with the arrow keys while the box has focus", async () => {
    const { onPick, search } = await mount();
    setQuery(search(), "valid parentheses");
    await flush(300);
    press(search(), "ArrowDown");
    press(search(), "Enter");
    expect(onPick.mock.calls[0][0]).toBe("check-if-there-is-a-valid-parentheses-string-path");
  });
});

describe("typing with the search box unfocused", () => {
  it("sends a letter with no shortcut into the box instead of dropping it", async () => {
    const { search } = await mount();
    search().blur();
    press(document.body, "v");
    expect(document.activeElement).toBe(search());
  });

  it("keeps the shortcut letters as shortcuts", async () => {
    const onRandomSession = vi.fn();
    const { search } = await mount(vi.fn(), { onRandomSession });
    search().blur();
    press(document.body, "r");
    expect(onRandomSession).toHaveBeenCalledTimes(1);
    expect(document.activeElement).not.toBe(search());
  });

  it("does not run shortcuts while typing in the box", async () => {
    const onRandomSession = vi.fn();
    const { search } = await mount(vi.fn(), { onRandomSession });
    search().focus();
    press(search(), "r");
    press(search(), " ");
    expect(onRandomSession).not.toHaveBeenCalled();
    expect(host.querySelector(".lc-browser-foot-stats")?.textContent).toBe("no session queue");
  });

  it("keeps the query when Esc leaves the box", async () => {
    const { search } = await mount();
    setQuery(search(), "valid parentheses");
    search().focus();
    const esc = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    act(() => {
      search().dispatchEvent(esc);
    });
    expect(esc.defaultPrevented).toBe(true);
    expect(document.activeElement).not.toBe(search());
    expect(search().value).toBe("valid parentheses");
  });
});

describe("focus on open", () => {
  it("puts the caret in the search box when the main pointer is a mouse", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === "(pointer: fine)", media: query, addEventListener() {}, removeEventListener() {} }));
    try {
      const { search } = await mount();
      expect(document.activeElement).toBe(search());
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves it alone on a touch screen, where focus pops the keyboard", async () => {
    vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} }));
    try {
      const { search } = await mount();
      expect(document.activeElement).not.toBe(search());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("startsSearch", () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

  it("claims letters and digits that have no shortcut", () => {
    expect(startsSearch(key("v"))).toBe(true);
    expect(startsSearch(key("P"))).toBe(true);
    expect(startsSearch(key("2"))).toBe(true);
  });

  it("leaves shortcut letters, modified keys and non-characters alone", () => {
    for (const k of ["w", "a", "s", "d", "t", "e", "o", "g", "r", "m", "x", "R"]) {
      expect(startsSearch(key(k))).toBe(false);
    }
    expect(startsSearch(key("v", { ctrlKey: true }))).toBe(false);
    expect(startsSearch(key(" "))).toBe(false);
    expect(startsSearch(key("Enter"))).toBe(false);
    expect(startsSearch(key("/"))).toBe(false);
  });
});

describe("searchKey", () => {
  it("changes with every filter", () => {
    const base = searchKey("leetcode", "two", "", "", "task_id");
    expect(searchKey("kodcode", "two", "", "", "task_id")).not.toBe(base);
    expect(searchKey("leetcode", "two sum", "", "", "task_id")).not.toBe(base);
    expect(searchKey("leetcode", "two", "Easy", "", "task_id")).not.toBe(base);
    expect(searchKey("leetcode", "two", "", "Array", "task_id")).not.toBe(base);
    expect(searchKey("leetcode", "two", "", "", "difficulty")).not.toBe(base);
  });
});
