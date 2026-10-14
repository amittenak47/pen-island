import type { AnnotationJobDto } from "../api/client";

export type ChatBotRun = Omit<AnnotationJobDto, "request_type"> & { request_type?: "selection" | "page" | "pages" };
const key = (docId: string) => `whiteboard.chatBotSelectionRuns.v1:${docId}`;

/** Page runs live on the hub; selection runs keep settings on the asking device. */
export function loadSelectionRuns(docId: string): ChatBotRun[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(docId)) ?? "[]");
    return Array.isArray(value) ? value.filter((run): run is ChatBotRun => run?.request_type === "selection" && typeof run.id === "string" && run.doc_id === docId) : [];
  } catch { return []; }
}
export function rememberSelectionRun(docId: string, run: ChatBotRun): void {
  try { localStorage.setItem(key(docId), JSON.stringify([...loadSelectionRuns(docId).filter((entry) => entry.id !== run.id), run])); }
  catch { /* The durable request is already queued. */ }
}
export function updateSelectionRun(docId: string, id: string, patch: Partial<ChatBotRun>): void {
  const run = loadSelectionRuns(docId).find((entry) => entry.id === id);
  if (run) rememberSelectionRun(docId, { ...run, ...patch });
}
