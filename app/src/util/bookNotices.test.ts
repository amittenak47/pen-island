/** @vitest-environment jsdom */
import { afterEach, expect, it, vi } from "vitest";
import { announceBookNotices, BOOK_NOTICE_EVENT, type BookNoticeDetail } from "./bookNotices";
import type { BookResult } from "./bookSync";

const notifications = vi.hoisted(() => ({ show: vi.fn() }));
vi.mock("./notifications", () => ({ showNotification: notifications.show }));
afterEach(() => { vi.clearAllMocks(); });

const result = (id: string, notice?: BookResult["notice"]): BookResult => ({ kind: "annotate", id, status: "synced", committed: false,
  display: { title: `Book ${id}`, scratchTitles: {} }, ...(notice ? { notice } : {}) });

it("announces each followed delete and restore once, with an event other views act on", () => {
  // A pass returns two books with notices and one without.
  const seen: BookNoticeDetail[] = [];
  const listen = (event: Event) => seen.push((event as CustomEvent<BookNoticeDetail>).detail);
  window.addEventListener(BOOK_NOTICE_EVENT, listen);
  try { announceBookNotices([result("a", "deleted_elsewhere"), result("b"), result("c", "restored_elsewhere")]); }
  finally { window.removeEventListener(BOOK_NOTICE_EVENT, listen); }
  expect(seen).toEqual([{ kind: "annotate", id: "a", notice: "deleted_elsewhere", title: "Book a" },
    { kind: "annotate", id: "c", notice: "restored_elsewhere", title: "Book c" }]);
  expect(notifications.show.mock.calls.map(call => call[0])).toEqual(["Book a was deleted on another device. Moved to trash.",
    "Book c was restored on another device."]);
});

it("announces nothing for a pass without notices", () => {
  announceBookNotices([result("a"), result("b")]);
  expect(notifications.show).not.toHaveBeenCalled();
});
