import { invoke } from "@tauri-apps/api/core";
import type { DocSourceRef } from "./docSourceStore";

export type SourcePick = Pick<DocSourceRef, "kind" | "location" | "name" | "size" | "modified">;
export type SourceStat = Pick<DocSourceRef, "size" | "modified">;

export function nativeSourcePickerAvailable(): boolean {
  if (import.meta.env.MODE === "test" || typeof window === "undefined") return false;
  if (!("__TAURI_INTERNALS__" in window || "__TAURI__" in window)) return false;
  const ua = navigator.userAgent;
  return !/iphone|ipad|ipod/i.test(ua) && !(/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
}

export function pickDocumentSource(): Promise<SourcePick | null> {
  return invoke("pick_document_source");
}

export function statDocumentSource(kind: DocSourceRef["kind"], location: string): Promise<SourceStat | null> {
  return invoke("stat_document_source", { kind, location });
}

export async function readDocumentSource(kind: DocSourceRef["kind"], location: string): Promise<ArrayBuffer> {
  const bytes = await invoke<ArrayBuffer | number[]>("read_document_source", { kind, location });
  return bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes).buffer;
}
