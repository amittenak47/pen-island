/**
 * Retained copies and book sizes for the Recents rows, off the main thread.
 * See `retainedRead.ts` for why; `retainedVersions.ts` is the page's side.
 */
import { readBookData, readSummaries } from "./retainedRead";
import type { RetainedKind, Summary } from "./retainedSummary";

export type RetainedSizesRequest =
  | { id: number; op: "summaries"; keys: IDBValidKey[] }
  | { id: number; op: "book"; kind: RetainedKind; bookId: string };

export type RetainedSizesReply =
  | { id: number; summaries: Summary[] }
  | { id: number; bytes: number }
  | { id: number; error: string };

self.onmessage = (event: MessageEvent<RetainedSizesRequest>) => {
  const request = event.data;
  const work: Promise<RetainedSizesReply> = request.op === "summaries"
    ? readSummaries(request.keys).then((summaries) => ({ id: request.id, summaries }))
    : readBookData(request.kind, request.bookId).then((bytes) => ({ id: request.id, bytes }));
  void work.then(
    (reply) => self.postMessage(reply),
    (cause: unknown) => self.postMessage({ id: request.id, error: cause instanceof Error ? cause.message : String(cause) }),
  );
};
