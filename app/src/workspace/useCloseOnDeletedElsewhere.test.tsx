/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useCloseOnDeletedElsewhere } from "./useCloseOnDeletedElsewhere";
import { BOOK_NOTICE_EVENT } from "../util/bookNotices";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
function Probe({ open, onClose }: { open: { kind: "annotate" | "whiteboard"; id: string } | null; onClose: () => void }) {
  useCloseOnDeletedElsewhere(() => open, onClose);
  return null;
}
const notice = (kind: string, id: string, notice: string) =>
  act(() => { window.dispatchEvent(new CustomEvent(BOOK_NOTICE_EVENT, { detail: { kind, id, notice, title: id } })); });

it("closes the tab showing a book another device deleted, and only that one", () => {
  // Tab shows annotate book "a" → other device deletes "b", restores "a", then deletes "a".
  const host = document.createElement("div"), root = createRoot(host), onClose = vi.fn();
  act(() => root.render(<Probe open={{ kind: "annotate", id: "a" }} onClose={onClose} />));
  notice("annotate", "b", "deleted_elsewhere"); notice("whiteboard", "a", "deleted_elsewhere"); notice("annotate", "a", "restored_elsewhere");
  expect(onClose).not.toHaveBeenCalled();
  notice("annotate", "a", "deleted_elsewhere");
  expect(onClose).toHaveBeenCalledOnce();
  act(() => root.unmount());
  notice("annotate", "a", "deleted_elsewhere");
  expect(onClose).toHaveBeenCalledOnce();
});
