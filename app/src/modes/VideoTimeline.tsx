/**
 * The scrubber with a video pad's marks laid along it.
 *
 * A frame mark is a tick; a range mark is a band. The selected range grows a
 * handle at each end that drags its start or end, never past the other end and
 * never shorter than one frame.
 */

import { useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { formatVideoTime, frameDuration, type VideoMark } from "../util/videoStore";

type Drag = { kind: "seek" } | { kind: "start" | "end"; markId: string };

export function VideoTimeline({ duration, time, marks, selectedId, frameRate, onSeek, onScrub, onSelect, onRange }: {
  duration: number;
  time: number;
  marks: VideoMark[];
  selectedId: string | null;
  frameRate: number | null;
  onSeek: (time: number) => void;
  /** True while the pointer drags the playhead, so the pad can hold playback. */
  onScrub: (scrubbing: boolean) => void;
  onSelect: (markId: string) => void;
  onRange: (markId: string, start: number, end: number) => void;
}) {
  const reduced = useReducedMotion();
  const trackRef = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const known = Number.isFinite(duration) && duration > 0;
  const pct = (t: number) => (known ? `${Math.min(100, Math.max(0, (t / duration) * 100))}%` : "0%");

  const timeAt = (clientX: number) => {
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || !known) return 0;
    return Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration));
  };

  const apply = (clientX: number) => {
    const current = drag.current;
    if (!current) return;
    const at = timeAt(clientX);
    if (current.kind === "seek") { onSeek(at); return; }
    const mark = marks.find(m => m.id === current.markId);
    if (!mark) return;
    const minimum = frameDuration(frameRate);
    if (current.kind === "start") onRange(mark.id, Math.min(at, mark.end - minimum), mark.end);
    else onRange(mark.id, mark.start, Math.max(at, mark.start + minimum));
  };

  const end = () => {
    if (drag.current?.kind === "seek") onScrub(false);
    drag.current = null;
  };

  return (
    <div className="lc-video-timeline">
      <div
        ref={trackRef}
        className="lc-video-track"
        role="slider"
        tabIndex={-1}
        aria-label="Playhead"
        aria-valuemin={0}
        aria-valuemax={known ? Math.round(duration) : 0}
        aria-valuenow={Math.round(time)}
        aria-valuetext={formatVideoTime(time)}
        onPointerDown={(event) => {
          if (!known || (event.pointerType === "mouse" && event.button !== 0)) return;
          const target = event.target as HTMLElement;
          const handle = target.closest<HTMLElement>("[data-handle]");
          const markEl = target.closest<HTMLElement>("[data-mark-id]");
          event.currentTarget.setPointerCapture(event.pointerId);
          if (handle?.dataset.markId) {
            drag.current = { kind: handle.dataset.handle as "start" | "end", markId: handle.dataset.markId };
            return;
          }
          if (markEl?.dataset.markId) {
            onSelect(markEl.dataset.markId);
            return;
          }
          drag.current = { kind: "seek" };
          onScrub(true);
          apply(event.clientX);
        }}
        onPointerMove={(event) => apply(event.clientX)}
        onPointerUp={end}
        onPointerCancel={end}
      >
        <div className="lc-video-track-rail" />
        <div className="lc-video-track-done" style={{ width: pct(time) }} />
        <AnimatePresence initial={false}>
          {marks.map(mark => {
            const selected = mark.id === selectedId;
            return (
              <motion.div
                key={mark.id}
                className={mark.frame ? "lc-video-tick" : "lc-video-band"}
                data-mark-id={mark.id}
                data-selected={selected || undefined}
                title={mark.note || (mark.frame ? `Frame at ${formatVideoTime(mark.start)}` : `${formatVideoTime(mark.start)} to ${formatVideoTime(mark.end)}`)}
                style={mark.frame ? { left: pct(mark.start) } : { left: pct(mark.start), width: known ? `${Math.max(0.4, ((mark.end - mark.start) / duration) * 100)}%` : 0 }}
                initial={reduced ? false : { opacity: 0, scaleY: 0.2 }}
                animate={{ opacity: 1, scaleY: 1 }}
                exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, scaleY: 0.2 }}
                transition={{ duration: 0.18 }}
              >
                {!mark.frame && selected && <>
                  <span className="lc-video-band-handle" data-handle="start" data-mark-id={mark.id} aria-label="Drag the start" />
                  <span className="lc-video-band-handle is-end" data-handle="end" data-mark-id={mark.id} aria-label="Drag the end" />
                </>}
              </motion.div>
            );
          })}
        </AnimatePresence>
        <div className="lc-video-playhead" style={{ left: pct(time) }} />
      </div>
    </div>
  );
}
