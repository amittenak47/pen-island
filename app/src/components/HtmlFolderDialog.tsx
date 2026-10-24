import { useEffect, useId } from "react";
import { useIsPresent } from "motion/react";
import { DialogBackdrop } from "./DialogMotion";
import { DialogFrame } from "./DialogFrame";

/**
 * Android: a linked HTML page whose folder the app cannot read yet.
 *
 * A file picked on its own comes with permission for that file only, so the
 * videos and pictures beside it stay out of reach until its folder is chosen.
 * Not now keeps the page as it is.
 */
export function HtmlFolderDialog({ fileName, folder, pending = false, error, onAllow, onCancel }: {
  fileName: string;
  folder: string | null;
  pending?: boolean;
  error?: string | null;
  onAllow: () => void;
  onCancel: () => void;
}) {
  const titleId = useId();
  const present = useIsPresent();
  const title = "Load this page's videos and pictures?";
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
      icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" /></svg>}>
      <div className="lc-dialog-body">
        <p>{`“${fileName}” loads files from the folder it sits in${folder ? `, “${folder}”` : ""}. The app can open the page but not that folder yet.`}</p>
        <p className="lc-muted">Choose the folder to let the page play its videos and show its pictures.</p>
        {error && <p className="lc-warning">{error}</p>}
      </div>
      <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
        <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={onCancel}>Not now</button>
        <button type="button" className="lc-primary lc-dialog-action" disabled={pending} onClick={onAllow}>Choose folder…</button>
      </div>
    </DialogFrame>
  </DialogBackdrop>;
}
