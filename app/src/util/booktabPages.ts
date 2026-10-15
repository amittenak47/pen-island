/** Board-owned text page cuts, in the document body's coordinates. */
import { useSyncExternalStore } from "react";
import type { BooktabRect } from "./aiBookTabs";
export type BooktabPage = { rect: BooktabRect; contentBottom: number; visible?: boolean };
const empty: readonly BooktabPage[] = [];
const pages = new Map<string, readonly BooktabPage[]>();
const listeners = new Map<string, Set<() => void>>();
export function publishBooktabPages(scope: string, next: readonly BooktabPage[]): void {
  if (JSON.stringify(pages.get(scope) ?? empty) === JSON.stringify(next)) return;
  if (next.length) pages.set(scope, next); else pages.delete(scope);
  listeners.get(scope)?.forEach(listener => listener());
}
export function useBooktabPages(scope: string): readonly BooktabPage[] {
  return useSyncExternalStore(listener => {
    let group = listeners.get(scope);
    if (!group) { group = new Set(); listeners.set(scope, group); }
    group.add(listener);
    return () => { group.delete(listener); if (!group.size) listeners.delete(scope); };
  }, () => pages.get(scope) ?? empty);
}
