/** @vitest-environment jsdom */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auditDocBytes, clearDocBytes, deleteDocBytes, hashBytes } from "./docBytes";
import { closeDbForTests, run, STORE_BYTES, STORE_SYNC_RECOVERY, withTransaction } from "./idb";
import { retainRecoveryCopy, type RecoveryCopy } from "./syncRecovery";

const GOOD = new Uint8Array(4096).fill(3).buffer;
const GOOD_HASH = hashBytes(GOOD);
const OTHER = new Uint8Array(128).fill(9).buffer;
const OTHER_HASH = hashBytes(OTHER);
/* A hub error body filed under a real document's key. */
const POISON = Uint8Array.from('{"error":"no bytes"}', (c) => c.charCodeAt(0))
  .buffer as ArrayBuffer;

beforeEach(async () => {
  await closeDbForTests();
  vi.stubGlobal("indexedDB", new IDBFactory());
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("ArrayBuffer", structuredClone(new ArrayBuffer(0)).constructor);
  localStorage.clear();
  await run(STORE_BYTES, "readwrite", store => store.put(GOOD, GOOD_HASH));
  await run(STORE_BYTES, "readwrite", store => store.put(POISON, OTHER_HASH));
});

afterEach(async () => {
  await closeDbForTests();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const count = () => run<number>(STORE_BYTES, "readonly", store => store.count());
const has = (hash: string) => run(STORE_BYTES, "readonly", store => store.getKey(hash));
const retained = (hash: string): RecoveryCopy => ({ id: `source-update:${hash}`, type: "record", kind: "annotate", bookId: "book",
  provenance: { source: "document-source-update" }, record: { meta: { kind: "annotate", id: "book", hash, docType: "pdf" }, payload: {} } });

describe("auditDocBytes", () => {
  it("counts the rows that no longer match their key", async () => {
    const audit = await auditDocBytes();
    expect(audit.rows).toBe(2);
    expect(audit.bad).toBe(1);
  });

  it("changes nothing without repair", async () => {
    await auditDocBytes();
    expect(await count()).toBe(2);
  });

  it("drops only the bad row when repairing", async () => {
    const audit = await auditDocBytes({ repair: true });
    expect(audit.removed).toBe(1);
    expect(await has(GOOD_HASH)).toBe(GOOD_HASH);
    expect(await has(OTHER_HASH)).toBeUndefined();
  });

  it("reports a clean store as clean", async () => {
    await run(STORE_BYTES, "readwrite", store => store.delete(OTHER_HASH));
    const audit = await auditDocBytes({ repair: true });
    expect(audit.bad).toBe(0);
    expect(audit.removed).toBe(0);
    expect(await count()).toBe(1);
  });

  it("totals the bytes it holds", async () => {
    const audit = await auditDocBytes();
    expect(audit.bytes).toBe(4096 + POISON.byteLength);
  });
});

describe("clearDocBytes", () => {
  it("empties the store and reports what it freed", async () => {
    const audit = await clearDocBytes();
    expect(audit.removed).toBe(2);
    expect(audit.freed).toBe(4096 + POISON.byteLength);
    expect(await count()).toBe(0);
  });

  it("keeps bytes pinned by a retained version and counts only deleted rows", async () => {
    await retainRecoveryCopy(retained(GOOD_HASH), GOOD_HASH);
    const audit = await clearDocBytes();
    expect(audit.removed).toBe(1);
    expect(audit.freed).toBe(POISON.byteLength);
    expect(await has(GOOD_HASH)).toBe(GOOD_HASH);
  });
});

describe("an empty store is not a healthy one", () => {
  it("reports zero rows rather than zero bad rows", async () => {
    await run(STORE_BYTES, "readwrite", store => store.clear());
    const audit = await auditDocBytes();
    expect(audit.rows).toBe(0);
    expect(audit.bad).toBe(0);
    // The caller has to tell these apart: `bad === 0` is true for a healthy
    // store and for a store that has never held anything.
    expect(audit.bytes).toBe(0);
  });
});

describe("retained byte pins", () => {
  it("refuses a retained book when its required source bytes are missing", async () => {
    await expect(retainRecoveryCopy(retained("missing"), "missing")).rejects.toThrow("complete backup cannot be kept");
    expect(await run(STORE_SYNC_RECOVERY, "readonly", store => store.get(retained("missing").id))).toBeUndefined();
  });

  it("preserves a retained source when deletion and retention overlap", async () => {
    await Promise.all([retainRecoveryCopy(retained(GOOD_HASH), GOOD_HASH), deleteDocBytes(GOOD_HASH)]);
    expect(await has(GOOD_HASH)).toBe(GOOD_HASH);
  });

  it("does not create a dangling retained copy if deletion wins the transaction", async () => {
    let queued!: () => void;
    const deleting = withTransaction<void>([STORE_BYTES, STORE_SYNC_RECOVERY], "readwrite", (tx, done) => {
      tx.objectStore(STORE_BYTES).delete(GOOD_HASH);
      queued();
      done(undefined);
    });
    const started = new Promise<void>(resolve => { queued = resolve; });
    await started;
    await expect(retainRecoveryCopy(retained(GOOD_HASH), GOOD_HASH)).rejects.toThrow("complete backup cannot be kept");
    await deleting;
    expect(await run(STORE_SYNC_RECOVERY, "readonly", store => store.get(retained(GOOD_HASH).id))).toBeUndefined();
  });

  it("does not repair away a retained source even when its bytes fail the audit", async () => {
    await retainRecoveryCopy(retained(OTHER_HASH), OTHER_HASH);
    const audit = await auditDocBytes({ repair: true });
    expect(audit.bad).toBe(1);
    expect(audit.removed).toBe(0);
    expect(await has(OTHER_HASH)).toBe(OTHER_HASH);
  });
});
