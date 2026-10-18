import { useEffect, useRef } from "react";
import { BOOK_NOTICE_EVENT, type BookNoticeDetail } from "../util/bookNotices";

/** Closes this tab when another device deleted the book it shows (sync moved it to trash). */
export function useCloseOnDeletedElsewhere(
  openBook: () => { kind: "annotate" | "whiteboard"; id: string } | null,
  close: () => void,
): void {
  const latest = useRef({ openBook, close });
  latest.current = { openBook, close };
  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<BookNoticeDetail>).detail;
      if (detail?.notice !== "deleted_elsewhere") return;
      const open = latest.current.openBook();
      if (open && open.kind === detail.kind && open.id === detail.id) latest.current.close();
    };
    window.addEventListener(BOOK_NOTICE_EVENT, onNotice);
    return () => window.removeEventListener(BOOK_NOTICE_EVENT, onNotice);
  }, []);
}
