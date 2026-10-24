import { useEffect, useId } from "react";
import { useIsPresent } from "motion/react";
import { DialogBackdrop } from "./DialogMotion";
import { DialogFrame } from "./DialogFrame";
import "./mediaPlayerDialog.css";

/**
 * A live page's video or audio, with its own controls.
 *
 * The page's frame takes no pointer (ink and panning go to the board), so the
 * player's controls inside it cannot be reached. A tap on it opens it here
 * instead, at the time it had got to.
 */
export function MediaPlayerDialog({ src, start, video, onClose }: {
  src: string;
  /** Seconds into the file. */
  start: number;
  video: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const present = useIsPresent();
  let name = src.split(/[?#]/)[0].split("/").pop() ?? "";
  try { name = decodeURIComponent(name); } catch { /* the encoded name still says which file */ }
  const title = name || (video ? "Video" : "Audio");
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && present) onClose();
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [onClose, present]);
  const seek = (media: HTMLMediaElement) => {
    if (start > 0 && Number.isFinite(start)) media.currentTime = start;
  };
  return <DialogBackdrop className="lc-modal-backdrop" role="presentation" onClick={event => {
    if (event.target === event.currentTarget && present) onClose();
  }}>
    <DialogFrame className="lc-modal lc-media-player" titleId={titleId} title={title} subtitle="" ariaLabel={title} shape="blocky" onClose={onClose}
      icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m10 9 5 3-5 3V9Z" /></svg>}>
      <div className="lc-dialog-body lc-media-player-body">
        {video
          ? <video src={src} controls autoPlay playsInline onLoadedMetadata={event => seek(event.currentTarget)} />
          : <audio src={src} controls autoPlay onLoadedMetadata={event => seek(event.currentTarget)} />}
      </div>
    </DialogFrame>
  </DialogBackdrop>;
}
