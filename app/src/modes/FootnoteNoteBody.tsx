import { useMemo } from "react";
import type { DocFootnoteNote } from "../util/docFootnotes";
import { renderMarkdown } from "./AnnotateDocument";

export function FootnoteNoteBody({ note, onOpenExternal }: {
  note: DocFootnoteNote;
  onOpenExternal: (url: string) => void;
}) {
  const html = useMemo(() => renderMarkdown(note.text), [note.text]);
  return <div className="lc-footnote-note-body lc-scroll-pane" tabIndex={0}>
    <div className="lc-footnote-note-text" dangerouslySetInnerHTML={{ __html: html }}
      onClick={event => {
        const link = event.target instanceof Element ? event.target.closest("a") : null;
        if (!link) return;
        event.preventDefault();
        const url = link.getAttribute("href");
        if (url) onOpenExternal(url);
      }} />
    {note.images?.length ? <div className="lc-footnote-note-images">
      {note.images.map((image, i) => <img key={i} src={`data:image/png;base64,${image}`} alt={`Note image ${i + 1}`} />)}
    </div> : null}
  </div>;
}
