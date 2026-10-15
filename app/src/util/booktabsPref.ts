/** Device-local display choices; saves refresh every open document. */
import { useEffect, useState } from "react";
import { boolPref, enumPref } from "./prefStore";

export type BooktabPosition = "beside" | "top" | "bottom";
export type BooktabFootnotes = "chatbot" | "all";
export const BOOKTABS_EVENT = "lc-booktabs";
const shown = boolPref({ key: "whiteboard.booktabs.show.v1", fallback: true });
const position = enumPref<BooktabPosition>({ key: "whiteboard.booktabs.position.v1", values: ["beside", "top", "bottom"], fallback: "beside" });
const footnotes = enumPref<BooktabFootnotes>({ key: "whiteboard.booktabs.footnotes.v1", values: ["chatbot", "all"], fallback: "chatbot" });
/** A footnote's title beside its square on the page; the panel always has it. */
const titles = boolPref({ key: "whiteboard.footnoteTitles.show.v1", fallback: true });

function emit(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(BOOKTABS_EVENT));
}
export function loadShowBooktabs(): boolean { return shown.load(); }
export function saveShowBooktabs(value: boolean): void { shown.save(value); emit(); }
export function loadBooktabPosition(): BooktabPosition { return position.load(); }
export function saveBooktabPosition(value: BooktabPosition): void { position.save(value); emit(); }
export function loadBooktabFootnotes(): BooktabFootnotes { return footnotes.load(); }
export function saveBooktabFootnotes(value: BooktabFootnotes): void { footnotes.save(value); emit(); }
export function loadShowFootnoteTitles(): boolean { return titles.load(); }
export function saveShowFootnoteTitles(value: boolean): void { titles.save(value); emit(); }

function loadBooktabs() {
  return { show: loadShowBooktabs(), position: loadBooktabPosition(), footnotes: loadBooktabFootnotes(), titles: loadShowFootnoteTitles() };
}
export function useBooktabs() {
  const [prefs, setPrefs] = useState(loadBooktabs);
  useEffect(() => {
    const refresh = () => setPrefs(loadBooktabs());
    window.addEventListener(BOOKTABS_EVENT, refresh);
    window.addEventListener("storage", refresh);
    refresh();
    return () => {
      window.removeEventListener(BOOKTABS_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);
  return prefs;
}
