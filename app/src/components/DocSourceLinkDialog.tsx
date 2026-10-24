import { useEffect, useId } from "react";
import { useIsPresent } from "motion/react";
import { HoldButton } from "./HoldButton";
import { DialogBackdrop } from "./DialogMotion";
import { DialogFrame } from "./DialogFrame";

export function DocSourceLinkDialog({ mode, fileName, documentName, pending = false, error, onCancel, onFind, onJustLink, onUpdate }: {
  mode: "missing" | "differs";
  fileName: string;
  documentName?: string;
  pending?: boolean;
  error?: string | null;
  onCancel: () => void;
  onFind?: () => void;
  onJustLink?: () => void;
  onUpdate?: () => void;
}) {
  const titleId = useId();
  const present = useIsPresent();
  const missing = mode === "missing";
  const title = missing ? "Linked file not found" : "Update from this file?";
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !pending && present) onCancel();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onCancel, pending, present]);
  return <DialogBackdrop className="lc-modal-backdrop" role="presentation" onClick={event => {
    if (event.target === event.currentTarget && !pending && present) onCancel();
  }}>
    <DialogFrame className="lc-modal lc-confirm-dialog" titleId={titleId} title={title} subtitle="" ariaLabel={title} shape="blocky"
      icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="m9 15 6-6M9 6l2-2a5 5 0 0 1 7 7l-2 2M15 18l-2 2a5 5 0 0 1-7-7l2-2" /></svg>}>
      <div className="lc-dialog-body">
        <p>{missing ? `“${fileName}” isn't where it was. Find it to keep this document up to date.`
          : `“${fileName}” has different text from the app's copy of “${documentName}”.`}</p>
        {!missing && <>
          <p className="lc-muted">Keep current version links the file but leaves this document as it is. You can update from the file later.</p>
          <p className="lc-muted">Update from file replaces this document's text with the file's. Annotations that can't be placed stay in the old version (Recents → retained copies).</p>
          <p className="lc-muted lc-reveal-hold-hint" role={pending ? "status" : undefined}>{pending ? "Updating…" : "Hold Update from file to confirm."}</p>
        </>}
        {error && <p className="lc-warning">{error}</p>}
      </div>
      <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
        <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onCancel}>{missing ? "Not now" : "Cancel"}</button>
        {missing ? <button type="button" className="lc-primary lc-dialog-action" disabled={pending} onClick={onFind}>Find the file…</button> : <>
          <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onJustLink}>Keep current version</button>
          <HoldButton label="Update from file" className="lc-hold-danger lc-dialog-action" disabled={pending} onConfirm={() => onUpdate?.()} resetKey={error} />
        </>}
      </div>
    </DialogFrame>
  </DialogBackdrop>;
}
