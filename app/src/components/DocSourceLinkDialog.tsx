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
  const title = missing ? "Linked file not found" : "This file is different";
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
          : `“${fileName}” doesn't match the app's copy of “${documentName}”.`}</p>
        {!missing && <p className="lc-muted lc-reveal-hold-hint" role={pending ? "status" : undefined}>{pending ? "Updating…" : "Hold Update to this file briefly to confirm."}</p>}
        {error && <p className="lc-warning">{error}</p>}
      </div>
      <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
        <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onCancel}>{missing ? "Not now" : "Cancel"}</button>
        {missing ? <button type="button" className="lc-primary lc-dialog-action" disabled={pending} onClick={onFind}>Find the file…</button> : <>
          <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onJustLink}>Just link</button>
          <HoldButton label="Update to this file" className="lc-hold-danger lc-dialog-action" disabled={pending} onConfirm={() => onUpdate?.()} resetKey={error} />
        </>}
      </div>
    </DialogFrame>
  </DialogBackdrop>;
}
