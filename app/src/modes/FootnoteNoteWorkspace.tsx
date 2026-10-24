import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CloseNoteIcon, OpenDocumentIcon, PictureInPictureIcon } from "../components/NoteWindowIcons";
import { NO_CHROME, useShell } from "../shellContext";
import { ANNOTATE_LIBRARY_EVENT, getAnnotateDoc, type AnnotateDoc } from "../util/annotateStore";
import { noteById, numberFootnotes } from "../util/docFootnotes";
import { footnoteDisplayThemes } from "../util/inkPaletteHistory";
import { footnoteThemeVars } from "../util/footnoteTheme";
import { openExternalUrl } from "../util/openExternal";
import { newTabId, type AnnotateTab, type FootnoteNoteRef } from "../util/tabs";
import { FootnoteNoteBody } from "./FootnoteNoteBody";
import { requestMiniNoteRestore } from "../util/miniNoteWindows";

export function footnoteNoteTab(ref: FootnoteNoteRef, title: string): AnnotateTab {
  return {
    id: newTabId("annotate"), kind: "annotate", title, dirty: false, lastActive: Date.now(),
    docId: ref.docId, hash: null, source: null, docType: "markdown", indexed: "idle", footnoteNote: ref,
  };
}

/** A normal tab reading the original footnote, never a detached library copy. */
export function FootnoteNoteWorkspace({ tab, active, showing, splitRole }: {
  tab: AnnotateTab & { footnoteNote: FootnoteNoteRef };
  active: boolean;
  showing: boolean;
  splitRole?: "a" | "b" | null;
}) {
  const { setChrome, setWorkspaceApi, setShellLoadActive, takeUserLoad, setBrowseMotion,
    setHoldBrowseOverlay, openWorkspace, closeTab, patchTab, setError } = useShell();
  const ref = tab.footnoteNote;
  const [doc, setDoc] = useState<AnnotateDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setReadError] = useState<string | null>(null);
  const generation = useRef(0);
  const loadingRef = useRef(loading); loadingRef.current = loading;
  const reload = useCallback(async () => {
    const token = ++generation.current;
    try {
      const saved = await getAnnotateDoc(ref.docId);
      if (generation.current !== token) return;
      setDoc(saved); setReadError(null);
    } catch (cause) {
      if (generation.current === token) setReadError(String(cause));
    } finally {
      if (generation.current === token) setLoading(false);
    }
  }, [ref.docId]);
  useEffect(() => {
    takeUserLoad(tab.id);
    void reload();
    const refresh = () => { void reload(); };
    window.addEventListener(ANNOTATE_LIBRARY_EVENT, refresh);
    return () => { generation.current++; window.removeEventListener(ANNOTATE_LIBRARY_EVENT, refresh); };
  }, [reload, tab.id, takeUserLoad]);
  useEffect(() => {
    setWorkspaceApi(tab.id, {
      park: async () => {}, leave: async () => true,
      abortLoad: async () => { generation.current++; setLoading(false); },
      isLoadActive: () => loadingRef.current,
    });
    return () => setWorkspaceApi(tab.id, null);
  }, [tab.id, setWorkspaceApi]);
  useEffect(() => {
    if (!active) return;
    setChrome({ ...NO_CHROME, pad: true, loading });
    if (!loading) {
      setShellLoadActive(false); setHoldBrowseOverlay(false); setBrowseMotion("idle");
    }
  }, [active, loading, setChrome, setShellLoadActive, setHoldBrowseOverlay, setBrowseMotion]);
  const marks = doc?.footnotes ?? [];
  const numbers = useMemo(() => numberFootnotes(marks), [doc?.footnotes]);
  const themes = useMemo(() => footnoteDisplayThemes(marks.map(mark => ({
    ...mark, number: numbers.get(mark.id),
  }))), [doc?.footnotes, numbers]);
  const mark = marks.find(entry => entry.id === ref.footnoteId);
  const found = noteById(mark, ref.noteId);
  const note = found?.note;
  const noteNumber = found?.number ?? 0;
  const number = numbers.get(ref.footnoteId);
  const title = mark
    ? noteNumber ? `${mark.title?.trim() || `Note ${number ?? ""}`}.${noteNumber}` : `${mark.title?.trim() || `Footnote ${number ?? ""}`}: all notes`
    : tab.title;
  const theme = themes.get(ref.footnoteId);
  useEffect(() => {
    if (note) patchTab(tab.id, { title, dirty: false });
  }, [note, title, tab.id, patchTab]);
  const openParent = () => {
    if (!doc) return;
    return openWorkspace({
      id: newTabId("annotate"), kind: "annotate", title: doc.label || doc.name, dirty: false,
      lastActive: Date.now(), docId: doc.id, hash: doc.hash, source: null, docType: doc.docType, indexed: "idle",
    });
  };
  return <section
    className={["lc-canvas-wrap lc-footnote-note-workspace", !showing && "lc-canvas-parked",
      splitRole && `is-split-${splitRole}`, mark?.kind === "ai" && !mark.pending && "is-chatbot-complete"].filter(Boolean).join(" ")}
    data-lc-tab={tab.id} aria-label="Full note"
    style={theme ? footnoteThemeVars(theme.color, theme.palette) : undefined}>
    <header className="lc-footnote-note-head">
      <div><strong>{title}</strong><span className="lc-footnote-note-parent">{doc?.label || doc?.name}</span></div>
      {/* The mini note's header, one size of button: icons with tooltips. */}
      <div className="lc-footnote-note-actions">
        {doc && <button type="button" className="lc-footnote-mark-tool" aria-label="Open document"
          title={`Open ${doc.label || doc.name}`} onClick={openParent}><OpenDocumentIcon /></button>}
        {doc && note && <button type="button" className="lc-footnote-mark-tool lc-footnote-note-restore" aria-label="Restore mini note"
          title="Back to the document as a mini note (closes this tab)" onClick={() => {
            requestMiniNoteRestore(ref);
            openParent();
            closeTab(tab.id);
          }}><PictureInPictureIcon /></button>}
        <button type="button" className="lc-footnote-mark-tool" aria-label="Close note tab" title="Close note tab"
          onClick={() => closeTab(tab.id)}><CloseNoteIcon /></button>
      </div>
    </header>
    {loading ? <p role="status">Opening note...</p> : error ? <p role="alert">{error}</p> : note ?
      <FootnoteNoteBody note={note} onOpenExternal={url => {
        void openExternalUrl(url).catch(cause => setError(String(cause)));
      }} /> : <p>This note is no longer in its footnote. Its document tab is still available.</p>}
  </section>;
}
