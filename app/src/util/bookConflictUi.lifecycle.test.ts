import { expect, it, vi } from "vitest";
import { askBookConflict } from "./bookConflictUi";
import type { BookConflict } from "./bookSync";
import type { ConflictUiLifecycle } from "./conflictUiWait";

const capture = (lifecycle: unknown) => ({ kind: "whiteboard", id: "book", metadata: { title: "Test" },
  record: { id: "book", title: "Test", agent: [] }, pages: [], state: { lifecycle } });
const ask = async (conflict: unknown, pick: "local" | "server") => {
  const show = vi.fn(async (_shown: unknown) => ({ pick }));
  const result = await askBookConflict(conflict as BookConflict, {} as ConflictUiLifecycle, show);
  return { shown: show.mock.calls[0]![0] as unknown as { lifecycleChoice?: string }, result };
};

it("tags a book deleted elsewhere with edits here, and maps Keep mine / Delete to the lifecycle", async () => {
  // Other device deletes → this device has edits → its sync asks Keep mine or Delete.
  const conflict = { capture: capture(null), remote: { state: "gone", record: null }, record: false, lifecycle: true, pages: [] };
  const keep = await ask(conflict, "local");
  expect(keep.shown.lifecycleChoice).toBe("deleted_elsewhere"); expect(keep.result.lifecycle).toBe("local");
  expect((await ask(conflict, "server")).result.lifecycle).toBe("server");
});

it("tags a queued delete that meets a newer hub version", async () => {
  const conflict = { capture: capture({ action: "delete", seq: 2 }), remote: { state: "live", record: { title: "Newer" } }, record: false, lifecycle: true, pages: [] };
  const { shown, result } = await ask(conflict, "server");
  expect(shown.lifecycleChoice).toBe("stale_delete"); expect(result.lifecycle).toBe("server");
});

it("tags a restore that meets a newer hub version and applies the whole side", async () => {
  const pages = [{ key: "book", page_id: 1, rev: 3, hash: "h" }];
  const conflict = { capture: capture({ action: "restore", seq: 2 }), remote: { state: "live", record: { title: "Theirs" } }, record: true, lifecycle: false, pages };
  const theirs = await ask(conflict, "server");
  expect(theirs.shown.lifecycleChoice).toBe("stale_restore");
  expect(theirs.result).toMatchObject({ record: "server", pages: [{ key: "book", pageId: 1, choice: "server" }] });
  expect((await ask(conflict, "local")).result).toMatchObject({ record: "local", pages: [{ key: "book", pageId: 1, choice: "local" }] });
});

it("leaves ordinary content conflicts untagged", async () => {
  const conflict = { capture: capture(null), remote: { state: "live", record: { title: "Hub" } }, record: true, lifecycle: false, pages: [] };
  expect((await ask(conflict, "local")).shown.lifecycleChoice).toBeUndefined();
});
