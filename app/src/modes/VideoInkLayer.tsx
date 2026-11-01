/**
 * The ink over a video pad's picture.
 *
 * Sized and placed exactly over the picture (not the letterbox around it), and
 * drawn in a viewBox one unit wide, so stroke points and widths are fractions
 * of the frame. The stroke in progress is written straight to one path's `d`
 * attribute on each move: no React render per pointer event.
 */

import { useRef, type CSSProperties } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { VideoMark, VideoStroke, VideoTool } from "../util/videoStore";

export type VideoInkTool = VideoTool | "eraser" | null;

/** Pen and highlighter weights, as a fraction of the frame's width. */
export const PEN_WIDTH = 0.0045;
export const HIGHLIGHT_WIDTH = 0.022;
const ERASER_RADIUS = 0.018;

/** Smooth a polyline through its midpoints. Points are x,y pairs in viewBox units. */
export function strokePath(points: number[], yScale: number): string {
  if (points.length < 2) return "";
  const x = (i: number) => points[i * 2];
  const y = (i: number) => points[i * 2 + 1] * yScale;
  const count = points.length / 2;
  const f = (n: number) => n.toFixed(5);
  if (count === 1) return `M${f(x(0))} ${f(y(0))}l0.0001 0`;
  let d = `M${f(x(0))} ${f(y(0))}`;
  for (let i = 1; i < count - 1; i += 1) {
    const mx = (x(i) + x(i + 1)) / 2;
    const my = (y(i) + y(i + 1)) / 2;
    d += `Q${f(x(i))} ${f(y(i))} ${f(mx)} ${f(my)}`;
  }
  d += `L${f(x(count - 1))} ${f(y(count - 1))}`;
  return d;
}

function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / length));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Whether a frame-space point (y already scaled) touches a stroke. */
export function strokeHit(stroke: VideoStroke, x: number, y: number, yScale: number, radius = ERASER_RADIUS): boolean {
  const p = stroke.points;
  const reach = radius + stroke.width / 2;
  if (p.length === 2) return Math.hypot(x - p[0], y - p[1] * yScale) <= reach;
  for (let i = 2; i < p.length; i += 2) {
    if (distanceToSegment(x, y, p[i - 2], p[i - 1] * yScale, p[i], p[i + 1] * yScale) <= reach) return true;
  }
  return false;
}

function StrokeShape({ stroke, yScale }: { stroke: VideoStroke; yScale: number }) {
  return <path d={strokePath(stroke.points, yScale)} stroke={stroke.color} strokeWidth={stroke.width}
    className={stroke.tool === "highlight" ? "lc-video-ink-highlight" : undefined} />;
}

export function VideoInkLayer({ marks, box, aspect, tool, color, onBegin, onStroke, onErase }: {
  /** Marks showing at this moment. */
  marks: VideoMark[];
  /** Where the picture sits inside the stage, in px. */
  box: { left: number; top: number; width: number; height: number };
  /** Picture width over height. */
  aspect: number;
  tool: VideoInkTool;
  color: string;
  /** Pen down: the pad pauses the video before ink lands. */
  onBegin: () => void;
  onStroke: (stroke: VideoStroke) => void;
  onErase: (markId: string, strokeIndex: number) => void;
}) {
  const reduced = useReducedMotion();
  const svgRef = useRef<SVGSVGElement>(null);
  const liveRef = useRef<SVGPathElement>(null);
  const live = useRef<{ id: number; points: number[] } | null>(null);
  const yScale = 1 / aspect;

  const toFrame = (event: { clientX: number; clientY: number }): [number, number] | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return null;
    return [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  };

  const eraseAt = (x: number, y: number) => {
    for (const mark of marks) {
      for (let i = mark.strokes.length - 1; i >= 0; i -= 1) {
        if (strokeHit(mark.strokes[i], x, y * yScale, yScale)) { onErase(mark.id, i); return; }
      }
    }
  };

  const paintLive = () => {
    const path = liveRef.current;
    const stroke = live.current;
    if (!path || !stroke) return;
    path.setAttribute("d", strokePath(stroke.points, yScale));
  };

  const style: CSSProperties = { left: box.left, top: box.top, width: box.width, height: box.height };
  const width = tool === "highlight" ? HIGHLIGHT_WIDTH : PEN_WIDTH;

  return (
    <svg
      ref={svgRef}
      className="lc-video-ink"
      data-tool={tool ?? "none"}
      style={style}
      viewBox={`0 0 1 ${yScale}`}
      preserveAspectRatio="none"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      onPointerDown={(event) => {
        if (!tool || (event.pointerType === "mouse" && event.button !== 0)) return;
        const point = toFrame(event);
        if (!point) return;
        event.preventDefault();
        try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* a pointer the browser no longer tracks */ }
        onBegin();
        if (tool === "eraser") { eraseAt(point[0], point[1]); live.current = { id: event.pointerId, points: [] }; return; }
        live.current = { id: event.pointerId, points: [point[0], point[1]] };
        paintLive();
      }}
      onPointerMove={(event) => {
        const stroke = live.current;
        if (!stroke || stroke.id !== event.pointerId) return;
        const samples = event.nativeEvent.getCoalescedEvents?.() ?? [event.nativeEvent];
        for (const sample of samples.length ? samples : [event.nativeEvent]) {
          const point = toFrame(sample);
          if (!point) continue;
          if (tool === "eraser") { eraseAt(point[0], point[1]); continue; }
          const n = stroke.points.length;
          // Drop sub-pixel steps; they only add path length.
          if (n >= 2 && Math.hypot(point[0] - stroke.points[n - 2], (point[1] - stroke.points[n - 1]) * yScale) < 0.0015) continue;
          stroke.points.push(point[0], point[1]);
        }
        if (tool !== "eraser") paintLive();
      }}
      onPointerUp={(event) => {
        const stroke = live.current;
        if (!stroke || stroke.id !== event.pointerId) return;
        live.current = null;
        liveRef.current?.setAttribute("d", "");
        if (tool === "pen" || tool === "highlight") {
          const points = stroke.points.map(n => Math.round(n * 100000) / 100000);
          if (points.length >= 2) onStroke({ tool, color, width, points });
        }
      }}
      onPointerCancel={() => {
        live.current = null;
        liveRef.current?.setAttribute("d", "");
      }}
    >
      <AnimatePresence initial={false}>
        {marks.map(mark => (
          <motion.g key={mark.id}
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0 }}
            transition={{ duration: 0.16 }}>
            {mark.strokes.map((stroke, index) => <StrokeShape key={index} stroke={stroke} yScale={yScale} />)}
          </motion.g>
        ))}
      </AnimatePresence>
      <path ref={liveRef} stroke={color} strokeWidth={width}
        className={tool === "highlight" ? "lc-video-ink-highlight" : undefined} />
    </svg>
  );
}
