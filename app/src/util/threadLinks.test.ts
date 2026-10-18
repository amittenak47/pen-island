import { expect, it } from "vitest";
import { pruneDeletedThreadLinks } from "./threadLinks";
import type { DocFootnote } from "./docFootnotes";

it("saves [] when deleting the only legacy thread link", () => {
  const mark: DocFootnote = { id: "f", kind: "coach", anchor: { kind: "text", start: 0, end: 4 }, excerpt: "words", createdAt: 1, threadRootId: "turn" };
  const [saved] = pruneDeletedThreadLinks([mark], [{ id: "turn", deletedAt: 2 }]);
  expect(saved.threads).toEqual([]);
  expect(saved.threadRootId).toBeUndefined();
  expect(mark).not.toHaveProperty("threads");
});
