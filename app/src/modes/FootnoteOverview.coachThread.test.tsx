/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act, type ComponentProps } from "react";

import { FootnoteOverview } from "./FootnoteOverview";
import type { DocFootnote } from "../util/docFootnotes";

const MARK: DocFootnote = {
  id: "same",
  kind: "coach",
  anchor: { kind: "text", start: 0, end: 4, scope: "p6" },
  excerpt: "Contents",
  createdAt: 1,
  threads: [{ rootId: "thread-1", title: "How they align SNOWY", createdAt: 1 }],
};

function mount(onOpenCoachThread?: (rootId: string) => void, props: Partial<ComponentProps<typeof FootnoteOverview>> = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() =>
    root.render(
      <FootnoteOverview
        footnote={MARK}
        onChange={() => {}}
        onClose={() => {}}
        threadMessages={() => []}
        onSendCoach={() => {}}
        onOpenExternal={() => {}}
        onOpenCoachThread={onOpenCoachThread}
        subMarkMode={null}
        onSubMarkModeChange={() => {}}
        {...props}
      />,
    ),
  );
  return { root };
}

afterEach(() => {
  document.body.textContent = "";
});

describe("FootnoteOverview threads", () => {
  it("allows linking an existing conversation without altering its messages", () => {
    const change = vi.fn();
    const {root} = mount(undefined, {onChange: change, availableThreads: [{rootId: "other", title: "Other thread"}]});
    // The Threads section's own +, like every other section's.
    const add = document.querySelector<HTMLButtonElement>('[aria-label="Threads"] .lc-footnote-overview-add')!;
    expect(add.getAttribute("aria-label")).toBe("Link a saved thread");
    act(() => add.click());
    const option = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="Link an existing thread"] button'))
      .find(button => button.textContent?.includes("Other thread"))!;
    act(() => option.click());
    expect(document.querySelector('[role="menu"][aria-label="Link an existing thread"]')).toBeNull();
    // + unfolded the section, so the linked thread is in view.
    expect(document.querySelector('[aria-label="Threads"] .lc-footnote-overview-section-fold')?.hasAttribute("data-open")).toBe(true);
    expect(change).toHaveBeenCalledWith(expect.objectContaining({threads: [MARK.threads![0], expect.objectContaining({rootId: "other"})]}));
    expect(document.querySelector('[aria-label="Forget thread"]')).toBeNull();
    const unlink = document.querySelector<HTMLButtonElement>('[aria-label*="Tap to open, hold to unlink"]')!;
    const count = change.mock.calls.length;
    act(() => unlink.click());
    expect(change).toHaveBeenCalledTimes(count);
    act(() => root.unmount());
  });
  it("hands a saved thread to the agent sheet instead of opening the mini chat", () => {
    const onOpenCoachThread = vi.fn();
    mount(onOpenCoachThread);
    const row = Array.from(document.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes("How they align SNOWY"),
    );
    expect(row).toBeTruthy();
    act(() => {
      row!.click();
    });
    expect(onOpenCoachThread).toHaveBeenCalledWith("thread-1");
    expect(document.querySelector(".lc-footnote-overview-task-thread")).toBeNull();
  });
});
