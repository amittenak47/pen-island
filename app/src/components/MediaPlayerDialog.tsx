import { useEffect, useId, useRef, useState } from "react";
import { useIsPresent } from "motion/react";
import { DialogBackdrop } from "./DialogMotion";
import { DialogFrame } from "./DialogFrame";
import { requestVideoOpen } from "../modes/VideoWorkspace";
import "./mediaPlayerDialog.css";

/**
 * A live page's video or audio, with its own controls.
 *
 * The page's frame takes no pointer (ink and panning go to the board), so the
 * player's controls inside it cannot be reached. A tap on it opens it here
 * instead, at the time it had got to.
 *
 * A video can go on to a Video tab from here. The page's file is copied into
 * the app rather than linked: its address belongs to this snapshot's folder and
 * would not survive the page being closed.
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [handing, setHanding] = useState(false);
  const [handError, setHandError] = useState<string | null>(null);
  const markUp = async () => {
    const at = videoRef.current?.currentTime ?? start;
    videoRef.current?.pause();
    setHanding(true);
    setHandError(null);
    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error(String(response.status));
      requestVideoOpen({ blob: await response.blob(), name, title, start: at });
      onClose();
    } catch {
      setHandError("This video couldn't be copied into a Video tab.");
      setHanding(false);
    }
  };
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
          ? <video ref={videoRef} src={src} controls autoPlay playsInline onLoadedMetadata={event => seek(event.currentTarget)} />
          : <audio src={src} controls autoPlay onLoadedMetadata={event => seek(event.currentTarget)} />}
      </div>
      {video && <div className="lc-modal-actions lc-dialog-foot lc-media-player-foot">
        {handError && <span className="lc-media-player-error" role="alert">{handError}</span>}
        <button type="button" className="lc-secondary lc-dialog-action" disabled={handing} onClick={() => void markUp()}>
          {handing ? "Copying…" : "Mark up in Video"}
        </button>
      </div>}
    </DialogFrame>
  </DialogBackdrop>;
}
