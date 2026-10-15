import { beforeEach, describe, expect, it, vi } from "vitest";

const recovery = new Map<string, unknown>();
const reads: string[] = [];

vi.mock("./idb", () => ({
  STORE_BYTES: "bytes",
  STORE_SYNC_RECOVERY: "sync_recovery",
  abortTransaction: () => {},
  run: async (store: string, _mode: string, work: (s: unknown) => { result: unknown }) => {
    if (store === "bytes") return undefined;
    return work({
      getAll: () => { reads.push("*"); return { result: [...recovery.values()] }; },
      getAllKeys: () => ({ result: [...recovery.keys()] }),
    }).result;
  },
  withTransaction: async (_stores: string[], _mode: string, work: (tx: unknown, done: (value: unknown) => void) => void) =>
    new Promise(done => work({ objectStore: () => ({ get: (key: string) => {
      reads.push(key);
      const request: { result: unknown; onsuccess: null | (() => void) } = { result: recovery.get(key), onsuccess: null };
      queueMicrotask(() => request.onsuccess?.());
      return request;
    } }) }, done)),
}));

const { recoveryId } = await import("./queueMigration");
const { readRetainedByteCopies } = await import("./syncRecovery");

describe("retained byte copies", () => {
  beforeEach(() => { recovery.clear(); reads.length = 0; });

  it("reads only the copies whose keys can claim this hash, not every retained book", async () => {
    for (let i = 0; i < 300; i += 1) {
      const id = recoveryId("legacy", "annotate_books", `book-${i}`);
      recovery.set(id, { id, type: "record", provenance: {} });
    }
    const mine = recoveryId("legacy", "bytes", "abc", "abc");
    const other = recoveryId("legacy", "bytes", "def", "def");
    recovery.set(mine, { id: mine, type: "bytes", claimedHash: "abc", provenance: {} });
    recovery.set(other, { id: other, type: "bytes", claimedHash: "def", provenance: {} });
    const { alternatives } = await readRetainedByteCopies("abc");
    expect(alternatives.map(copy => copy.id)).toEqual([mine]);
    expect(reads).toEqual([mine]);
  });

  it("still reads and checks copies whose keys are in any other shape", async () => {
    recovery.set("collision", { id: "collision", type: "bytes", claimedHash: "abc", provenance: {} });
    recovery.set("legacy-slot:x", { id: "legacy-slot:x", type: "record", provenance: {} });
    const { alternatives } = await readRetainedByteCopies("abc");
    expect(alternatives.map(copy => copy.id)).toEqual(["collision"]);
    expect(reads.sort()).toEqual(["collision", "legacy-slot:x"]);
  });
});
