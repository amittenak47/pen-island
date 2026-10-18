/** Books another device deleted or restored, announced once per sync pass. */
import type { BookResult } from "./bookSync";
import { showNotification } from "./notifications";

export const BOOK_NOTICE_EVENT = "lc-book-notice";
export interface BookNoticeDetail {
  kind: BookResult["kind"];
  id: string;
  notice: NonNullable<BookResult["notice"]>;
  title: string;
}

export function bookNoticeText(notice: BookNoticeDetail["notice"], title: string): string {
  return notice === "deleted_elsewhere" ? `${title} was deleted on another device. Moved to trash.` : `${title} was restored on another device.`;
}

/** Notifies once per book and tells open tabs, which close a book deleted elsewhere. */
export function announceBookNotices(books: readonly BookResult[]): void {
  for (const book of books) {
    if (!book.notice) continue;
    const detail: BookNoticeDetail = { kind: book.kind, id: book.id, notice: book.notice, title: book.display?.title ?? "Book" };
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(BOOK_NOTICE_EVENT, { detail }));
    showNotification(bookNoticeText(detail.notice, detail.title));
  }
}
