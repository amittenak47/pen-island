/**
 * Landing screen — Practice, Whiteboard, Annotate, Browse, Explore.
 *
 * There is no longer a "What do you want to do?" banner over the cards.
 * The four cards answer that question by existing.
 *
 * Large entry cards above a wide Whiteboard and two compact secondary cards.
 * Recently opened work is independent of the currently open tab strip.
 *
 * Practice, Whiteboard and Annotate play hover-in / hover-out scenes. Browse
 * and Explore keep a quiet loop. Marks and doodles are real SVG, not a
 * wallpaper that fades in all at once.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { motion, useReducedMotion } from "motion/react";

import { FEATURE_LEETCODE } from "../featureFlags";
import { LIBRARY_HOLD_MS } from "../util/gesture";
import { ANNOTATE_LIBRARY_EVENT } from "../util/annotateStore";
import { WHITEBOARD_LIBRARY_EVENT } from "../util/whiteboardStore";
import { createWhiteboardTracer, type WhiteboardTracer } from "./whiteboardTracer";
import { createPracticeBraces, type PracticeBraces } from "./practiceBraces";
import { RECENT_WORKSPACES_EVENT, forgetRecentWorkspace, loadRecentWorkspaces, recentWorkspaceKey, visibleRecentWorkspaces } from "../util/recentWorkspaces";
import type { TabRecord, TabState } from "../util/tabs";
import "./homeChooser.css";

export interface HomeChooserProps {
  onPractice: () => void;
  onWhiteboard: () => void;
  onAnnotate: () => void;
  /** Opens google.com as a snapshot pad — same entry as the header globe. */
  onBrowse: () => void;
  /** The notes graph — one tab, see `EXPLORE_TAB_LIMIT`. */
  onExplore: () => void;
  /** Something is already opening; the cards stop taking taps. */
  busy?: boolean;
  active?: boolean;
  /** An entry dialog covers Home; restore its tiles when that dialog closes. */
  covered?: boolean;
  tabsRef?: MutableRefObject<TabState>;
  onOpenRecent?: (tab: TabRecord) => void;
}

/**
 * Start, in tiers: the two main tiles, then LeetCode alone, then the two
 * work-in-progress ones. Each tier is the same shape a size smaller.
 */
const HOME_ORDER = ["annotate", "whiteboard", "practice", "browse", "explore"];
const HOME_TIER: Record<string, number> = { annotate: 1, whiteboard: 1, practice: 2, browse: 3, explore: 3 };

interface HomeMode {
  id: string;
  kicker: string;
  blurb: string;
  icon: ReactNode;
  live?: ReactNode;
  /** In-progress surface — a quiet corner mark, not a disabled card. */
  wip?: boolean;
  onOpen: () => void;
}

type IconScene = "rest" | "in" | "out";

const HOVER_SCENES = new Set(["practice", "whiteboard", "annotate"]);
// Whiteboard has no fixed leave time: its tracer returns to rest when the
// pencil has erased the page, redrawn the resting sketch and parked.
const LEAVE_MS: Record<string, number> = { practice: 1500, annotate: 360 };

/** Same folded page for Whiteboard and Annotate so the icons read as one size. */
/** A flat sheet: no folded corner, so nothing is drawn across a dog-ear. */
const PAGE_PATH = "M6 2h12a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z";

/** Effects use the live tile bounds; the central glyph keeps its own square viewBox. */
function useLiveFrame() {
  const ref = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 52, height: 52 });
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    const measure = () => {
      const box = root.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) return;
      const width = Math.round(box.width), height = Math.round(box.height);
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return { ref, ...size };
}

function webNetRoutes(width: number, height: number): string[] {
  const x = width / 2, y = height / 2;
  return [
    `M0 ${y}C${x * .6} 0 ${x * 1.4} 0 ${width} ${y}`,
    `M0 ${y}C${x * .6} ${height} ${x * 1.4} ${height} ${width} ${y}`,
    `M0 0C${x * .7} ${y * .2} ${x * 1.3} ${y * 1.8} ${width} ${height}`,
    `M${width} 0C${x * 1.3} ${y * .2} ${x * .7} ${y * 1.8} 0 ${height}`,
    `M${x - 12} ${y - 10}C${x * .6} ${y * .5} ${x * .2} 0 0 0`,
    `M${x + 12} ${y - 10}C${x * 1.4} ${y * .5} ${x * 1.8} 0 ${width} 0`,
    `M${x - 12} ${y + 10}C${x * .6} ${y * 1.5} ${x * .2} ${height} 0 ${height}`,
    `M${x + 12} ${y + 10}C${x * 1.4} ${y * 1.5} ${x * 1.8} ${height} ${width} ${height}`,
    `M${x - 14} ${y}C${x * .6} ${y * .7} ${x * .2} ${y * .4} 0 ${y * .4}`,
    `M${x + 14} ${y}C${x * 1.4} ${y * 1.3} ${x * 1.8} ${y * 1.6} ${width} ${y * 1.6}`,
  ];
}

/**
 * Columns for the middle tier, where cards are still full but two abreast.
 *
 * An even count halves cleanly (4 → 2×2). An odd one does not, so it keeps its
 * full width and skips this tier — 3 → 2 would put one card alone underneath,
 * which is the exact asymmetry the tier exists to avoid.
 */
export function homeModeColumns(count: number): number {
  if (count <= 1) return 1;
  return count % 2 === 0 ? count / 2 : count;
}

/** Shared geometry for the card glyphs — one stroke weight across all four. */
function Glyph({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

function typeLine(text: string): ReactNode {
  return (
    <span
      className="lc-home-fn-line"
      style={{ "--lc-ch": `${Math.max(text.length, 1)}ch` } as CSSProperties}
    >
      {text}
    </span>
  );
}

/** Four-line, PEP 8-formatted snippets; each line fits the icon's 20 columns. */
const PRACTICE_SNIPPETS: readonly (readonly string[])[] = [
  ["def two_sum(a, t):", "    seen = {}", "    for i, x in a:", "        seen[x] = i"],
  ["def is_even(n):", "    if n % 2:", "        return False", "    return True"],
  ["def bfs(g, s):", "    q = deque([s])", "    seen = {s}", "    return seen"],
  ["def last(xs):", "    if not xs:", "        return None", "    return xs[-1]"],
  ["def clamp(x):", "    x = max(x, 0)", "    x = min(x, 9)", "    return x"],
  ["def rev(s):", "    r = s[::-1]", "    print(r)", "    return r"],
  ["def count(xs, v):", "    n = 0", "    for x in xs:", "        n += x == v"],
];

function randomSnippet(avoid: number[]): number {
  const choices = PRACTICE_SNIPPETS.map((_, i) => i).filter(i => !avoid.includes(i));
  return choices[Math.floor(Math.random() * choices.length)] ?? 0;
}

function PracticeLive() {
  const ref = useRef<HTMLSpanElement>(null);
  const [slots, setSlots] = useState(() => {
    const a = randomSnippet([]);
    return { a, b: randomSnippet([a]) };
  });
  useEffect(() => {
    const code = ref.current;
    const card = code?.closest(".lc-home-card");
    if (!code || !card) return;
    // Every hover starts on slot A; give it a fresh snippet before typing begins.
    let visible: "a" | "b" = "a";
    const enter = () => {
      visible = "a";
      setSlots(current => ({ ...current, a: randomSnippet([current.a, current.b]) }));
    };
    // Each 8s clear hands the page to the other slot, which is empty at that
    // moment. Swap a new snippet into it, never repeating the one just shown.
    const iteration = (event: AnimationEvent) => {
      if (event.animationName !== "lc-home-code-clear" || !(event.target as Element).classList.contains("lc-home-fn-a")) return;
      const next = visible === "a" ? "b" : "a";
      setSlots(current => ({ ...current, [next]: randomSnippet([current.a, current.b]) }));
      visible = next;
    };
    card.addEventListener("mouseenter", enter);
    code.addEventListener("animationiteration", iteration);
    return () => {
      card.removeEventListener("mouseenter", enter);
      code.removeEventListener("animationiteration", iteration);
    };
  }, []);
  const lines = (index: number) => PRACTICE_SNIPPETS[index]!.map((text, i) => <Fragment key={i}>{typeLine(text)}</Fragment>);
  return (
    <span ref={ref} className="lc-home-live lc-home-live-code">
      <span className="lc-home-fn lc-home-fn-a">{lines(slots.a)}</span>
      <span className="lc-home-fn lc-home-fn-b">{lines(slots.b)}</span>
    </span>
  );
}

/** Earth keeps a round outline while longitude lines turn around its tilted axis. */
function BrowseGlyph() {
  return (
    <Glyph className="lc-home-earth">
      <ellipse className="lc-home-earth-orbit" cx="12" cy="12" rx="11" ry="3.6" />
      <circle className="lc-home-earth-glow" cx="12" cy="12" r="9.2" fill="currentColor" stroke="none" />
      <circle className="lc-home-earth-outline" cx="12" cy="12" r="9.5" />
      <g className="lc-home-earth-tilt" transform="rotate(23.4 12 12)">
        <path className="lc-home-earth-equator" d="M2.5 12h19" />
        {[0, 1, 2].map(index => (
          <path key={index} className="lc-home-earth-meridian" d="M12 2.5a9.5 9.5 0 0 1 0 19"
            style={{ animationDelay: `${-index * 14 / 3}s` }} />
        ))}
      </g>
      <circle className="lc-home-earth-orbiter" cx="12" cy="12" r=".65" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

function BrowseLive() {
  const { ref, width, height } = useLiveFrame();
  const routes = webNetRoutes(width, height);
  return (
    <span className="lc-home-live">
      <svg ref={ref} viewBox={`0 0 ${width} ${height}`} className="lc-home-live-svg" aria-hidden="true">
        {routes.slice(0, 4).map((d, i) => (
          <path key={`mesh-${i}`} className="lc-home-net-mesh" d={d} />
        ))}
        {routes.map((d, i) => (
          <path
            key={`flow-${i}`}
            className={`lc-home-net-flow lc-home-net-flow-${i + 1}`}
            d={d}
            pathLength={100}
          />
        ))}
        <g className="lc-home-net-boost">
          {routes.map((d, i) => (
            <path key={`stream-${i}`} className="lc-home-net-stream" d={d} pathLength={100}
              style={{ animationDuration: `${2.1 + (i % 4) * .18}s`, animationDelay: `${-i * .27}s` }} />
          ))}
          {routes.map((d, i) => (
            <path key={`burst-${i}`} className="lc-home-net-burst" d={d} pathLength={100}
              style={{ animationDuration: `${.46 + (i % 5) * .085}s`, animationDelay: `${-i * .11}s` }} />
          ))}
        </g>
      </svg>
    </span>
  );
}

function ExploreLive() {
  const { ref: svgRef, width, height } = useLiveFrame();
  useEffect(() => {
    const root = svgRef.current;
    if (!root) return;
    const motionPreference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motionPreference.matches) return;
    const card = root.closest<HTMLButtonElement>(".lc-home-card");

    const NS = "http://www.w3.org/2000/svg";
    const W = width;
    const H = height;
    const speed = Math.max(1, Math.min(W, H) / 52);
    const pad = 5;
    const layer = document.createElementNS(NS, "g");
    layer.setAttribute("class", "lc-home-graph");
    root.appendChild(layer);

    type GraphNode = {
      id: number;
      x: number;
      y: number;
      vx: number;
      vy: number;
      group: number | null;
      exiting: boolean;
      /** Radius with no links, and the radius currently drawn. */
      base: number;
      r: number;
      el: SVGCircleElement;
    };
    type GraphEdge = {
      a: GraphNode;
      b: GraphNode;
      born: number;
      life: number;
      retiringAt: number | null;
      retiringDraw: number;
      /** Draw-in and retract times; hover links snap in and out faster. */
      drawMs: number;
      retractMs: number;
      el: SVGLineElement;
    };
    type PendingLink = { a: GraphNode; b: GraphNode };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const pendingLinks: PendingLink[] = [];
    let retiringLinks: GraphEdge[] = [];
    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    let nextNodeId = 0;
    let nextGroupId = 0;

    function spawnNode(fromEdge: boolean, inside = false): GraphNode {
      const el = document.createElementNS(NS, "circle");
      el.setAttribute("class", "lc-home-graph-node");
      const base = rand(1.5, 2.1);
      el.setAttribute("r", base.toFixed(2));
      el.setAttribute("fill", "currentColor");
      el.setAttribute("stroke", "none");
      layer.appendChild(el);
      const side = Math.floor(Math.random() * 4);
      const rim = 11;
      let x = rand(pad, W - pad);
      let y = rand(pad, H - pad);
      let vx = rand(-8, 8);
      let vy = rand(-8, 8);
      // Hover fills the interior directly (fading in), so the extra density
      // sits among the existing nodes instead of arriving only from the rim.
      if (inside) {
        // Hover fills the interior directly (fading in), so the extra density
        // sits among the existing nodes instead of arriving only from the rim.
      } else if (side === 0) {
        x = fromEdge ? -3 : rand(pad, W - pad);
        y = fromEdge ? rand(pad, H - pad) : rand(pad, rim);
        vx = fromEdge ? rand(10, 18) : rand(-10, 10);
        vy = fromEdge ? rand(-6, 6) : rand(2, 10);
      } else if (side === 1) {
        x = fromEdge ? W + 3 : rand(pad, W - pad);
        y = fromEdge ? rand(pad, H - pad) : rand(H - rim, H - pad);
        vx = fromEdge ? -rand(10, 18) : rand(-10, 10);
        vy = fromEdge ? rand(-6, 6) : -rand(2, 10);
      } else if (side === 2) {
        x = fromEdge ? rand(pad, W - pad) : rand(pad, rim);
        y = fromEdge ? -3 : rand(pad, H - pad);
        vx = fromEdge ? rand(-6, 6) : rand(2, 10);
        vy = fromEdge ? rand(10, 18) : rand(-10, 10);
      } else {
        x = fromEdge ? rand(pad, W - pad) : rand(W - rim, W - pad);
        y = fromEdge ? H + 3 : rand(pad, H - pad);
        vx = fromEdge ? rand(-6, 6) : -rand(2, 10);
        vy = fromEdge ? -rand(10, 18) : rand(-10, 10);
      }
      const id = ++nextNodeId;
      el.setAttribute("data-node-id", String(id));
      const node: GraphNode = { id, x, y, vx: vx * speed, vy: vy * speed, group: null, exiting: false, base, r: base, el };
      nodes.push(node);
      return node;
    }

    // Counts follow the tile's area: a small, cramped tile (narrow window or
    // phone) gets slightly fewer vertices, and so fewer links, than a roomy one.
    const nodeCount = Math.min(18, Math.max(4, Math.round(W * H / 4000)));
    const MAX_NODES = 40;
    const MAX_EDGES = 96;
    const boostedNodeCount = Math.min(35, Math.max(8, Math.round(nodeCount * 2.25)));
    const side = Math.min(W, H);
    // Typical gap between hover vertices. Wide, short tiles space vertices by
    // area, not by their short side, so link reach follows this spacing.
    const spacing = Math.sqrt(W * H / boostedNodeCount);
    const maxLink = Math.max(side * .6, spacing * 2.2);
    for (let i = 0; i < nodeCount; i++) spawnNode(false);

    // RAF follows the screen's refresh cadence. Advance by elapsed visible time,
    // not a frame count, so 60/120/144 Hz keep the same animation speed.
    let last: number | null = null;
    let elapsed = 0;
    let nextEdge = 280;
    let nextExit = 3200;
    let nextBreak = 2200;
    let nextLink = 0;
    let nextUnlink = 0;
    let nextNode = 0;
    let boost = 0;
    let wasBoosted = false;
    let raf = 0;
    let disposed = false;

    function removeEdge(edge: GraphEdge) {
      edge.el.remove();
      const i = edges.indexOf(edge);
      if (i >= 0) edges.splice(i, 1);
    }

    function retireEdge(edge: GraphEdge, now: number) {
      if (edge.retiringAt != null || !edges.includes(edge)) return;
      edge.retiringAt = now;
      edge.retiringDraw = Math.min(1, Math.max(0, (now - edge.born) / edge.drawMs));
    }

    function linked(a: GraphNode, b: GraphNode) {
      return edges.some((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    }

    function connect(a: GraphNode, b: GraphNode, now: number, boosted: boolean) {
      const limit = boosted ? Math.min(MAX_EDGES, nodes.length * 3) : nodeCount + 3;
      if (edges.length >= limit || a === b || a.exiting || b.exiting || linked(a, b)) return;
      if (a.group !== b.group) return;
      // Boosted links stay local; vertices that drifted apart while queued don't link.
      if (boosted && Math.hypot(a.x - b.x, a.y - b.y) > maxLink) return;
      const el = document.createElementNS(NS, "line");
      el.setAttribute("class", "lc-home-graph-edge");
      el.setAttribute("data-node-a", String(a.id));
      el.setAttribute("data-node-b", String(b.id));
      el.setAttribute("stroke", "currentColor");
      el.setAttribute("stroke-width", "0.9");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("fill", "none");
      el.setAttribute("opacity", "0");
      el.setAttribute("pathLength", "1");
      el.setAttribute("stroke-dasharray", "1");
      el.setAttribute("stroke-dashoffset", "1");
      layer.insertBefore(el, layer.firstChild);
      edges.push({ a, b, born: now, life: boosted ? rand(4200, 6600) : rand(1400, 2600),
        retiringAt: null, retiringDraw: 0, drawMs: boosted ? 150 : 280, retractMs: boosted ? 220 : 380, el });
    }

    function addEdge(now: number) {
      const available = nodes.filter(n => !n.exiting);
      if (edges.length >= nodeCount + 3 || available.length < 2) return;
      const a = available[Math.floor(Math.random() * available.length)]!;
      let best: GraphNode | undefined;
      let bestD = Math.max(30, Math.min(W, H) * .9);
      for (const b of available) {
        if (b === a || a.group !== b.group || linked(a, b)) continue;
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        if (d < bestD) {
          bestD = d;
          best = b;
        }
      }
      if (!best) return;
      connect(a, best, now, false);
    }

    function queueCluster(now: number) {
      const available = nodes.filter(n => !n.exiting);
      if (available.length < 3 || pendingLinks.length > 24) return;
      // Each neighbourhood gets its own reach: some are tight with short links,
      // others a little looser, but none spans the whole tile.
      const reach = Math.max(side * rand(.3, .55), spacing * rand(1.2, 2));
      const near = (from: GraphNode) => (n: GraphNode) => Math.hypot(n.x - from.x, n.y - from.y) <= reach;
      // A neighbourhood grows one link at a time: a chain, then a triangle,
      // then nearby vertices. Its remaining links arrive on later frames.
      const degree = (n: GraphNode) => edges.reduce((total, e) => total + Number(e.a === n || e.b === n), 0) +
        pendingLinks.reduce((total, e) => total + Number(e.a === n || e.b === n), 0);
      const ungrouped = available.filter(n => n.group == null);
      let group: GraphNode[];
      if (ungrouped.length >= 3) {
        const anchor = ungrouped[Math.floor(Math.random() * ungrouped.length)]!;
        const neighbours = ungrouped.filter(n => n !== anchor && near(anchor)(n));
        if (neighbours.length < 2) return;
        const size = Math.min(neighbours.length + 1, Math.floor(rand(3, 6)));
        group = [anchor, ...neighbours.sort((a, b) =>
          Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y)).slice(0, size - 1)];
        const id = ++nextGroupId;
        for (const n of group) n.group = id;
      } else {
        const grouped = available.filter(n => n.group != null &&
          available.filter(candidate => candidate.group === n.group).length + ungrouped.length >= 3);
        if (!grouped.length) return;
        const anchor = grouped.reduce((best, n) => degree(n) < degree(best) ? n : best);
        group = grouped.filter(n => n.group === anchor.group);
        const joining = ungrouped.filter(near(anchor)).sort((a, b) =>
          Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y)).slice(0, Math.max(0, 5 - group.length));
        for (const n of joining) n.group = anchor.group;
        group.push(...joining);
        // Too few vertices within reach to make a triangle this time.
        if (group.length < 3) return;
        group.sort((a, b) => degree(a) - degree(b));
      }
      // Cohorts keep distinct identities, so hover cannot join the whole tile
      // into one permanent component. Existing quiet links detach gradually.
      let boundary = 0;
      for (const edge of edges) {
        if (edge.a.group !== edge.b.group) retireEdge(edge, now + Math.min(420, boundary++ * 70));
      }
      const queue = (a: GraphNode, b: GraphNode) => {
        if (pendingLinks.length >= 40 || linked(a, b) || pendingLinks.some(e =>
          (e.a === a && e.b === b) || (e.a === b && e.b === a))) return;
        pendingLinks.push({ a, b });
      };
      queue(group[0]!, group[1]!); queue(group[1]!, group[2]!); queue(group[2]!, group[0]!);
      for (let i = 3; i < group.length; i++) {
        queue(group[i - 1]!, group[i]!); queue(group[i]!, group[0]!);
        if (i >= 3) queue(group[i]!, group[i - 2]!);
      }
    }

    function departNodes(group: GraphNode[], now: number) {
      const centre = group.reduce((point, n) => ({ x: point.x + n.x / group.length, y: point.y + n.y / group.length }), { x: 0, y: 0 });
      const distances = [centre.x, W - centre.x, centre.y, H - centre.y];
      const side = distances.indexOf(Math.min(...distances));
      const velocity = rand(13, 19) * speed;
      for (const n of group) {
        n.exiting = true;
        n.vx = (side === 0 ? -velocity : side === 1 ? velocity : rand(-3, 3) * speed);
        n.vy = (side === 2 ? -velocity : side === 3 ? velocity : rand(-3, 3) * speed);
      }
      // The connected group travels together. Its boundary links retract in
      // sequence while its internal links keep following the drifting vertices.
      let boundary = 0;
      for (const edge of edges) {
        if (group.includes(edge.a) !== group.includes(edge.b)) retireEdge(edge, now + Math.min(420, boundary++ * 70));
      }
    }

    function departComponent(now: number) {
      const available = nodes.filter(n => !n.exiting);
      if (available.length < 3) return;
      const seed = available[Math.floor(Math.random() * available.length)]!;
      const group = [seed], queue = [seed];
      while (queue.length && group.length < 5) {
        const current = queue.shift()!;
        for (const edge of edges) {
          if (edge.retiringAt != null) continue;
          const neighbour = edge.a === current ? edge.b : edge.b === current ? edge.a : null;
          if (neighbour && !neighbour.exiting && !group.includes(neighbour)) {
            group.push(neighbour); queue.push(neighbour);
            if (group.length === 5) break;
          }
        }
      }
      departNodes(group, now);
    }

    function tick(timestamp: number) {
      raf = 0;
      if (disposed || document.hidden || motionPreference.matches) return;
      const dt = last == null ? 0 : Math.max(0, Math.min(0.05, (timestamp - last) / 1000));
      last = timestamp;
      elapsed += dt * 1000;
      const now = elapsed;
      const boosted = card?.dataset.boosted === "true";
      const boostTarget = boosted ? 1 : 0, decay = Math.exp(-dt * 7);
      boost = boostTarget + (boost - boostTarget) * decay;
      // Hover changes the links, not how fast the vertices drift.
      const movementTime = dt;
      const targetNodes = boosted ? boostedNodeCount : nodeCount;
      if (boosted !== wasBoosted) {
        if (boosted) {
          nextEdge = now; nextLink = now + 90; retiringLinks = [];
        } else {
          pendingLinks.length = 0;
          retiringLinks = edges.filter(e => e.retiringAt == null).slice(nodeCount + 3);
          nextUnlink = now + 120;
        }
        wasBoosted = boosted;
      }
      if (now >= nextNode) {
        const present = nodes.filter(n => !n.exiting).length;
        if (nodes.length < MAX_NODES && present < targetNodes) spawnNode(true, boosted && Math.random() < .6);
        if (present > targetNodes) {
          // Shed a few at a time so a dense hover graph settles in a few seconds.
          const extra = [...nodes].reverse().filter(n => !n.exiting).slice(0, Math.ceil((present - targetNodes) / 8));
          for (const n of extra) departNodes([n], now);
        }
        nextNode = now + (boosted ? 60 : 250);
      }

      if (now >= nextEdge) {
        if (boosted) queueCluster(now); else addEdge(now);
        nextEdge = now + (boosted ? rand(240, 460) : rand(320, 860));
      }
      if (boosted && now >= nextLink && pendingLinks.length) {
        const link = pendingLinks.shift()!;
        connect(link.a, link.b, now, true);
        nextLink = now + rand(45, 80);
      }
      if (!boosted && now >= nextUnlink && retiringLinks.length) {
        retireEdge(retiringLinks.shift()!, now);
        // Still one at a time, but paced so even a dense graph unlinks in ~1.2s.
        nextUnlink = now + Math.max(25, Math.min(130, 1200 / (retiringLinks.length + 1)));
      }
      if (now >= nextBreak && edges.length) {
        const alive = edges.filter(e => e.retiringAt == null);
        if (alive.length) retireEdge(alive[Math.floor(Math.random() * alive.length)]!, now);
        nextBreak = now + (boosted ? rand(620, 1100) : rand(900, 1800));
      }
      if (now >= nextExit && nodes.length) {
        if (boosted) departComponent(now);
        else {
          const available = nodes.filter(n => !n.exiting);
          if (available.length) departNodes([available[Math.floor(Math.random() * available.length)]!], now);
        }
        nextExit = now + (boosted ? rand(2600, 4000) : rand(1800, 3200));
      }

      for (const n of nodes) {
        n.x += n.vx * movementTime;
        n.y += n.vy * movementTime;
        if (!n.exiting) {
          if (n.x < pad || n.x > W - pad) n.vx *= -1;
          if (n.y < pad || n.y > H - pad) n.vy *= -1;
          n.x = Math.min(W - pad, Math.max(pad, n.x));
          n.y = Math.min(H - pad, Math.max(pad, n.y));
          n.vx += rand(-5, 5) * dt;
          n.vy += rand(-5, 5) * dt;
          const sp = Math.hypot(n.vx, n.vy);
          if (sp > 15 * speed) {
            n.vx *= 15 * speed / sp;
            n.vy *= 15 * speed / sp;
          }
          if (sp < 3.2) {
            n.vx *= 1.5;
            n.vy *= 1.5;
          }
        }
        n.el.setAttribute("cx", n.x.toFixed(2));
        n.el.setAttribute("cy", n.y.toFixed(2));
      }

      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i]!;
        if (!n.exiting) continue;
        if (n.x < -7 || n.x > W + 7 || n.y < -7 || n.y > H + 7) {
          for (let j = edges.length - 1; j >= 0; j--) {
            const e = edges[j]!;
            if (e.a === n || e.b === n) removeEdge(e);
          }
          n.el.remove();
          nodes.splice(i, 1);
          if (nodes.length < MAX_NODES && nodes.filter(candidate => !candidate.exiting).length < targetNodes) spawnNode(true);
        }
      }

      for (let i = edges.length - 1; i >= 0; i--) {
        const e = edges[i]!;
        const age = now - e.born;
        // Links that stretch as their vertices drift apart break, sooner on hover.
        if (age > e.life || (age > 700 && Math.hypot(e.a.x - e.b.x, e.a.y - e.b.y) > (boosted ? maxLink * 1.2 : Math.max(38, side * 1.1)))) {
          retireEdge(e, now);
        }
        if (e.retiringAt != null && now >= e.retiringAt + e.retractMs) {
          removeEdge(e);
          continue;
        }
        const retiring = e.retiringAt != null && now >= e.retiringAt;
        const draw = retiring ? e.retiringDraw * Math.max(0, 1 - (now - e.retiringAt!) / e.retractMs) : Math.min(1, age / e.drawMs);
        e.el.setAttribute("x1", e.a.x.toFixed(2));
        e.el.setAttribute("y1", e.a.y.toFixed(2));
        e.el.setAttribute("x2", e.b.x.toFixed(2));
        e.el.setAttribute("y2", e.b.y.toFixed(2));
        e.el.setAttribute("stroke-dashoffset", (1 - draw).toFixed(3));
        e.el.setAttribute("opacity", ((0.78 + boost * .2) * draw).toFixed(3));
      }

      // Better-connected vertices are bigger: each live link adds to the radius,
      // and sizes ease toward their target as links form and break.
      const degree = new Map<GraphNode, number>();
      for (const e of edges) {
        if (e.retiringAt != null && now >= e.retiringAt) continue;
        degree.set(e.a, (degree.get(e.a) ?? 0) + 1);
        degree.set(e.b, (degree.get(e.b) ?? 0) + 1);
      }
      const ease = 1 - Math.exp(-dt * 8);
      for (const n of nodes) {
        const target = n.base + Math.min(2.6, 0.6 * (degree.get(n) ?? 0));
        if (Math.abs(target - n.r) < 0.005) continue;
        n.r += (target - n.r) * ease;
        n.el.setAttribute("r", n.r.toFixed(2));
      }

      raf = requestAnimationFrame(tick);
    }

    function visibilityChanged() {
      cancelAnimationFrame(raf);
      raf = 0;
      // Preserve the graph but don't age edges or move nodes across a pause.
      last = null;
      if (!document.hidden && !disposed && !motionPreference.matches) raf = requestAnimationFrame(tick);
    }
    document.addEventListener("visibilitychange", visibilityChanged);
    motionPreference.addEventListener("change", visibilityChanged);
    visibilityChanged();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", visibilityChanged);
      motionPreference.removeEventListener("change", visibilityChanged);
      cancelAnimationFrame(raf);
      layer.remove();
    };
  }, [width, height]);

  return (
    <span className="lc-home-live">
      <svg ref={svgRef} viewBox={`0 0 ${width} ${height}`} className="lc-home-live-svg" aria-hidden="true" />
    </span>
  );
}

export function HomeChooser({
  onPractice,
  onWhiteboard,
  onAnnotate,
  onBrowse,
  onExplore,
  busy = false,
  active = true,
  covered = false,
  tabsRef,
  onOpenRecent,
}: HomeChooserProps) {
  const [recent, setRecent] = useState<TabRecord[]>([]);
  const [recentsOpen, setRecentsOpen] = useState(loadRecentsOpen);
  const [pageVisible, setPageVisible] = useState(() => !document.hidden);
  useEffect(() => {
    const refresh = () => setPageVisible(!document.hidden);
    document.addEventListener("visibilitychange", refresh);
    refresh();
    return () => document.removeEventListener("visibilitychange", refresh);
  }, []);
  // Hold a recent item to edit the list: items shake and show an x that only
  // takes them off Recently opened.
  const [editing, setEditing] = useState(false);
  const recentsRef = useRef<HTMLElement>(null);
  const holdTimer = useRef<number | null>(null);
  const holdFrom = useRef<{ x: number; y: number } | null>(null);
  const holdFired = useRef(false);
  const clearHold = () => {
    if (holdTimer.current != null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  };
  const reduced = useReducedMotion();
  const visible = active && !covered;
  useEffect(() => {
    if (!active || !onOpenRecent) return;
    const refresh = () => setRecent(visibleRecentWorkspaces(loadRecentWorkspaces(),tabsRef?.current.tabs ?? [])
      .filter(tab=>FEATURE_LEETCODE || tab.kind !== "practice"));
    refresh();
    const events = [RECENT_WORKSPACES_EVENT,ANNOTATE_LIBRARY_EVENT,WHITEBOARD_LIBRARY_EVENT];
    events.forEach(event=>window.addEventListener(event,refresh));
    return () => events.forEach(event=>window.removeEventListener(event,refresh));
  }, [active,tabsRef,onOpenRecent]);
  useEffect(() => {
    if (recent.length === 0 || !visible || !recentsOpen || busy) setEditing(false);
  }, [recent.length, visible, recentsOpen, busy]);
  useEffect(() => {
    if (!editing) return;
    const outside = (event: PointerEvent) => {
      if (!recentsRef.current?.contains(event.target as Node)) setEditing(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setEditing(false); };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape);
    };
  }, [editing]);
  useEffect(() => clearHold, []);
  const modes: HomeMode[] = [
    ...(FEATURE_LEETCODE
      ? [
          {
            id: "practice",
            kicker: "Practice",
            blurb: "Browse problems and run tests in this app.",
            live: <PracticeLive />,
            icon: (
              <Glyph>
                <path className="lc-home-bra-l" d="m9 8-3.5 4L9 16" />
                <path className="lc-home-bra-r" d="m15 8 3.5 4L15 16" />
                <path className="lc-home-slash" d="M13.4 5.5 10.6 18.5" />
              </Glyph>
            ),
            onOpen: onPractice,
          } satisfies HomeMode,
        ]
      : []),
    {
      id: "annotate",
      kicker: "Annotate",
      blurb: "Mark up PDFs, docs, code, and web pages.",
      icon: (
        <Glyph className="lc-home-glyph-sheet">
          <defs>
            <clipPath id="lc-home-ann-clip" clipPathUnits="userSpaceOnUse">
              <path d={PAGE_PATH} />
            </clipPath>
            {/* Everything on the near side of the fold line x + y = 42. The line
                slides toward the middle as the corner curls, so the folded corner
                is removed from the sheet itself rather than covered. */}
            <clipPath id="lc-home-ann-peel-clip" clipPathUnits="userSpaceOnUse">
              <path className="lc-home-ann-peel" d="M-10-10H34V8L8 34H-10z" />
            </clipPath>
          </defs>
          <path d={PAGE_PATH} />
          {/* The next page waits underneath and only shows while the top sheet
              curls and turns away over its left edge. */}
          <g className="lc-home-ann-under" clipPath="url(#lc-home-ann-clip)">
            <path d="M6.6 9.3h10.4M6.6 11.3h9.2M6.6 13.3h10.4M6.6 15.3h8.6M6.6 17.3h10.4M6.6 19.3h7.4" />
          </g>
          {/* The top sheet turns; inside it the text scrolls, carrying the
              first marks with it. The second marks sit on the scrolled rows. */}
          <g className="lc-home-ann-page">
            <g clipPath="url(#lc-home-ann-peel-clip)">
            <path className="lc-home-ann-sheet" d={PAGE_PATH} />
            <g clipPath="url(#lc-home-ann-clip)">
              <g className="lc-home-ann-scroll">
                <path className="lc-home-mark lc-home-mark-a-hl" d="M6.6 11.3h9.2" stroke="#eab308" strokeWidth="2.35" pathLength={1} />
                <path className="lc-home-rule" d="M6.6 9.3h10.4" />
                <path className="lc-home-rule" d="M6.6 11.3h9.2" />
                <path className="lc-home-rule" d="M6.6 13.3h10.4" />
                <path className="lc-home-rule" d="M6.6 15.3h8.6" />
                <path className="lc-home-rule" d="M6.6 17.3h10.4" />
                <path className="lc-home-rule" d="M6.6 19.3h7.4" />
                <path className="lc-home-rule" d="M6.6 21.3h9.6" />
                <path className="lc-home-rule" d="M6.6 23.3h10.4" />
                <path className="lc-home-rule" d="M6.6 25.3h6.8" />
                <path className="lc-home-mark lc-home-mark-a-ul" d="M6.6 13.95h8.1" stroke="#3b82f6" strokeWidth="1.05" pathLength={1} />
                <rect className="lc-home-box lc-home-box-a" x="14.4" y="8.35" width="3.2" height="2.15" rx="0.35" fill="#fbbf24" stroke="none" />
                <rect className="lc-home-box lc-home-box-a2" x="7" y="16.15" width="2.9" height="2" rx="0.35" fill="#60a5fa" stroke="none" />
              </g>
              <path className="lc-home-mark lc-home-mark-b-ul" d="M6.6 11.95h7.6" stroke="#22c55e" strokeWidth="1.05" pathLength={1} />
              <path className="lc-home-mark lc-home-mark-b-strike" d="M6.8 17.3h7.8" stroke="#f43f5e" strokeWidth="1.05" pathLength={1} />
              <rect className="lc-home-box lc-home-box-b" x="14.6" y="14.35" width="3.1" height="2.1" rx="0.35" fill="#f9a8d4" stroke="none" />
              <rect className="lc-home-box lc-home-box-b2" x="7.1" y="8.4" width="2.8" height="1.95" rx="0.35" fill="#c4b5fd" stroke="none" />
            </g>
            </g>
            {/* The lifted corner: the flap is the corner reflected over its fold. */}
            <path className="lc-home-ann-curl" d="M20 16.5 14.5 22V16.5z" />
          </g>
        </Glyph>
      ),
      onOpen: onAnnotate,
    },
    {
      id: "whiteboard",
      kicker: "Whiteboard",
      blurb: "Freeform pages for sketches, notes, and diagrams.",
      icon: (
        <Glyph className="lc-home-glyph-sheet">
          <defs>
            <clipPath id="lc-home-wb-clip" clipPathUnits="userSpaceOnUse">
              <path d={PAGE_PATH} />
            </clipPath>
          </defs>
          <path d={PAGE_PATH} />
          <g clipPath="url(#lc-home-wb-clip)">
            {/* Resting sketches, in rotation: each leave draws the next one.
                The blank page has no strokes; the pencil just parks. */}
            <g className="lc-home-wb-rest">
              <g className="lc-home-wb-sketch" data-sketch="diagram">
                <path className="lc-home-trace" d="M6.5 6.5h4v3.5h-4z" pathLength={1} />
                <path className="lc-home-trace" d="M10.5 8.25h4" pathLength={1} />
                <path className="lc-home-trace" d="M13.1 6.9l1.4 1.35-1.4 1.35" pathLength={1} />
                <path className="lc-home-trace" d="M16.5 6.35a1.9 1.9 0 1 1 0 3.8a1.9 1.9 0 1 1 0-3.8" pathLength={1} />
                <path className="lc-home-trace" d="M8.5 10v4.5h8" pathLength={1} />
              </g>
              <g className="lc-home-wb-sketch" data-sketch="note">
                <path className="lc-home-trace" d="M6.5 8c1-.8 2 .8 3 0s2 .8 3 0 2 .8 3 0 1.5.6 2.5 0" pathLength={1} />
                <path className="lc-home-trace" d="M6.5 12c1-.8 2 .8 3 0s2 .8 3 0 2 .8 3 0" pathLength={1} />
                <path className="lc-home-trace" d="M6.5 16c1-.8 2 .8 3 0s2 .8 3 0" pathLength={1} />
              </g>
              <g className="lc-home-wb-sketch" data-sketch="blank" />
            </g>
            <g className="lc-home-wb-scroll">
              <g className="lc-home-wb-draw-a">
                <circle className="lc-home-draw" cx="8.2" cy="13.6" r="1.05" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 14.7v3.1" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 15.8 6.8 17" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 15.8 9.7 16.9" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 17.8 7 19.8" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 17.8 9.5 19.8" pathLength={1} />
                <path
                  className="lc-home-draw"
                  d="M13.4 9.2c1.1-1.4 2.6.7 3.8-.3 1.1 1.3 2.1-.5 3.3.9"
                  pathLength={1}
                />
              </g>
              <g className="lc-home-wb-draw-b">
                <path className="lc-home-draw" d="M7.1 10.2h5.8v4.4H7.1z" pathLength={1} />
                <path className="lc-home-draw" d="M8 16.8h9.6" pathLength={1} />
                <path className="lc-home-draw" d="M8.2 16.8 11 12.8 13.3 14.9 17 10.4" pathLength={1} />
                <path className="lc-home-draw" d="M16.3 10.4h1.5v1.5" pathLength={1} />
              </g>
            </g>
          </g>
          <g className="lc-home-nib-arm">
            <path
              className="lc-home-nib"
              d="m20.4 10.8-6.4 6.4-2.7.8.8-2.7 6.4-6.4z"
              transform="translate(-11.3 -18)"
            />
          </g>
        </Glyph>
      ),
      onOpen: onWhiteboard,
    },
    {
      id: "browse",
      kicker: "Web",
      blurb: "Open a page, then write straight onto the snapshot.",
      wip: true,
      live: <BrowseLive />,
      icon: <BrowseGlyph />,
      onOpen: onBrowse,
    },
    {
      id: "explore",
      kicker: "Explore",
      blurb: "See how files, notebooks, and problems connect.",
      wip: true,
      live: <ExploreLive />,
      icon: (
        <Glyph>
          <circle cx="12" cy="12" r="2.6" />
          <circle cx="5" cy="6.5" r="1.5" />
          <circle cx="19.2" cy="7.5" r="1.5" />
          <circle cx="6.5" cy="18.5" r="1.5" />
          <circle cx="18" cy="17.5" r="1.5" />
          <path d="M6.2 7.5 10 10.6" />
          <path d="M18 8.6 14.2 10.9" />
          <path d="M7.6 17.4 10.4 13.9" />
          <path d="M16.9 16.5 13.9 13.6" />
        </Glyph>
      ),
      onOpen: onExplore,
    },
  ];

  return (
    <nav className="lc-home-chooser lc-home-redesign" aria-label="Choose a workspace" data-home-active={active} data-page-visible={pageVisible} data-covered={covered || undefined} data-recents={recent.length === 0 ? "none" : recentsOpen ? "open" : "collapsed"}>
      {recent.length > 0 && <section ref={recentsRef} className="lc-home-recents" aria-labelledby="lc-home-recents-title" data-editing={editing || undefined}>
        <div className="lc-home-recents-head">
          <h2 id="lc-home-recents-title" className="lc-home-section-title lc-home-recents-heading">
            <button type="button" className="lc-home-recents-toggle" aria-expanded={recentsOpen} aria-controls={recentsOpen ? "lc-home-recents-window" : undefined} disabled={busy}
              onClick={()=>{const next=!recentsOpen;setRecentsOpen(next);saveRecentsOpen(next);}}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
              Recently opened<span className="lc-home-recents-count">{recent.length}</span>
            </button>
          </h2>
          {editing && <button type="button" className="lc-home-recents-done" onClick={()=>setEditing(false)}>Done</button>}
        </div>
        {recentsOpen && <div id="lc-home-recents-window" className="lc-home-recents-window lc-scroll-pane">
          {recent.map((tab,index)=>{ const key = recentWorkspaceKey(tab) ?? String(index); return <motion.div key={key} className="lc-home-recent-item"
            {...homeTileMotion(visible, !!reduced, Math.min(index,5)*.025, !busy && !editing)}>
            <button type="button" className="lc-home-recent" data-mode={tab.kind === "web" ? "browse" : tab.kind}
              disabled={busy} title={tab.title}
              aria-keyshortcuts="Delete"
              onPointerDown={(event)=>{
                if (busy || editing) return;
                clearHold();
                holdFired.current = false;
                holdFrom.current = {x:event.clientX, y:event.clientY};
                holdTimer.current = window.setTimeout(()=>{
                  holdTimer.current = null;
                  holdFired.current = true;
                  setEditing(true);
                  navigator.vibrate?.(12);
                }, RECENT_HOLD_MS);
              }}
              onPointerMove={(event)=>{
                const from = holdFrom.current;
                // A drag is a scroll of the list, not a hold.
                if (from && Math.hypot(event.clientX-from.x, event.clientY-from.y) > RECENT_HOLD_SLOP_PX) clearHold();
              }}
              onPointerUp={clearHold}
              onPointerCancel={clearHold}
              onPointerLeave={clearHold}
              onContextMenu={(event)=>event.preventDefault()}
              onKeyDown={(event)=>{ if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); setEditing(true); } }}
              onClick={()=>{
                // The release that ends a hold is not a tap, and editing never opens.
                if (holdFired.current) { holdFired.current = false; return; }
                if (editing) return;
                onOpenRecent?.(tab);
              }}>
              {editing && <svg className="lc-home-recent-trace" aria-hidden="true" style={{"--lc-trace-delay":`${-index*0.37}s`} as CSSProperties}>
                {/* pathLength 100 makes the dash travel at one speed around the whole edge. */}
                <rect x="1" y="1" pathLength="100" />
              </svg>}
              <span className="lc-home-recent-preview" aria-hidden="true"><svg viewBox="0 0 40 52" fill="none"><path d="M8 8h24M8 17h24M8 26h24M8 35h24M8 44h18"/><path className="lc-home-recent-mark" d={tab.kind === "whiteboard" ? "M8 31q6-15 12 0t12 0" : "M8 17h18"}/></svg></span>
              <span className="lc-home-recent-text"><strong>{tab.title}</strong><span>{tab.kind === "practice" ? "Practice" : tab.kind === "whiteboard" ? "Whiteboard" : tab.kind === "web" ? "Web" : `Annotate · ${tab.kind === "annotate" ? tab.docType === "markdown" ? "Markdown" : tab.docType.toUpperCase() : ""}`}</span></span>
            </button>
            {editing && <button type="button" className="lc-home-recent-remove" aria-label={`Remove ${tab.title} from Recently opened`}
              onClick={()=>forgetRecentWorkspace(tab)}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><path d="M7 7l10 10M17 7 7 17"/></svg>
            </button>}
          </motion.div>; })}
        </div>}
      </section>}
      {/* "Start" only separates the tiles from Recently opened; alone it is noise. */}
      {recent.length > 0 && <h2 className="lc-home-section-title">Start</h2>}
      <div className="lc-home-chooser-grid">
        {[...modes].sort((a,b) => HOME_ORDER.indexOf(a.id) - HOME_ORDER.indexOf(b.id)).map((mode,index) => (
          <HomeCard key={mode.id} mode={mode} busy={busy} active={visible} delay={index*.035}/>
        ))}
      </div>
    </nav>
  );
}

const RECENTS_OPEN_KEY = "whiteboard.homeRecentsOpen";
/** The app's "hold for more" duration (as the Whiteboard button's library hold), so a tap still opens. */
const RECENT_HOLD_MS = LIBRARY_HOLD_MS;
/** Travel before a press counts as scrolling the list instead. */
const RECENT_HOLD_SLOP_PX = 10;

/** Recently opened starts unfolded; folding it is remembered across launches. */
function loadRecentsOpen(): boolean {
  try { return localStorage.getItem(RECENTS_OPEN_KEY) !== "0"; } catch { return true; }
}

function saveRecentsOpen(open: boolean): void {
  try { localStorage.setItem(RECENTS_OPEN_KEY, open ? "1" : "0"); } catch { /* private browsing */ }
}

/** Springs, not a tween: tiles overshoot slightly on the way in and push back when pressed. */
const TILE_SPRING = {type: "spring" as const, stiffness: 430, damping: 17, mass: 0.85};
const TILE_GESTURE_SPRING = {type: "spring" as const, stiffness: 520, damping: 15, mass: 0.7};

/*
 * Whole `transform` strings, not separate y and scale: Motion hands opacity and
 * transform to the browser's own animations, which the compositor runs, and
 * turns the spring into the matching easing curve. Separate values are worked
 * out on the page's thread each frame, and coming Home that thread is still
 * busy with the tab just left, so the tiles arrived in uneven steps.
 */
/**
 * `hoverScale`: a full-width tile grows by fewer percent, so its lift stays in
 * Home's side padding instead of being clipped by the scrolling container.
 */
function homeTileMotion(visible: boolean, reduced: boolean, delay: number, interactive = true, hoverScale = 1.035) {
  return {
    initial: reduced ? false as const : {opacity:0,transform:"translateY(44px) scale(0.8)"},
    animate: visible
      ? {opacity:1,transform:"translateY(0px) scale(1)"}
      : {opacity:0,transform:"translateY(10px) scale(0.94)"},
    transition: reduced ? {duration:0} : visible
      ? {default:{...TILE_SPRING,delay}, opacity:{duration:.14,delay}}
      : {duration:.12},
    // Gestures only run on a visible, motion-enabled Home whose tiles take taps.
    whileHover: reduced || !visible || !interactive ? undefined : {transform:`translateY(-3px) scale(${hoverScale})`,transition:TILE_GESTURE_SPRING},
    whileTap: reduced || !visible || !interactive ? undefined : {transform:"translateY(0px) scale(0.94)",transition:TILE_GESTURE_SPRING},
  };
}

/**
 * Hover scenes: rest loop, `in` on enter, `out` on leave, then rest after LEAVE_MS.
 * Re-enter during `out` clears that timer and goes back to `in` (drawings stay paused
 * on leave via CSS, then resume if the animation name is unchanged).
 * Whiteboard `rest` → `in` freezes the nib wherever it is, walks it onto the blank
 * page, then starts the draw loop (ink is delayed to match).
 */
function HomeCard({ mode, busy, active, delay }: { mode: HomeMode; busy: boolean; active: boolean; delay: number }) {
  const reduced = useReducedMotion();
  const [scene, setScene] = useState<IconScene>("rest");
  const cardRef = useRef<HTMLButtonElement>(null);
  const leaveTimer = useRef(0);
  const tracer = useRef<WhiteboardTracer | null>(null);
  const braces = useRef<PracticeBraces | null>(null);
  /** When the braces finish opening, so a leave knows whether code was typed. */
  const codeStartsAt = useRef(0);
  const hoverable = HOVER_SCENES.has(mode.id);
  const boostable = mode.id === "browse" || mode.id === "explore";
  const [pointerOver, setPointerOver] = useState(false);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  const previousScene = useRef(scene);
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);
  useEffect(() => {
    if (mode.id !== "whiteboard" || !cardRef.current) return;
    tracer.current = createWhiteboardTracer(cardRef.current);
    return () => { tracer.current?.dispose(); tracer.current = null; };
  }, [mode.id]);
  useEffect(() => {
    if (mode.id !== "practice" || !cardRef.current) return;
    braces.current = createPracticeBraces(cardRef.current);
    return () => { braces.current?.release(); braces.current = null; };
  }, [mode.id]);
  useLayoutEffect(() => {
    if (mode.id === "practice" && scene === "in" && previousScene.current === "out") {
      // A rapid re-entry starts typing into the newly opened brackets, instead
      // of reviving the fully written block frozen during its deletion scene.
      const code = cardRef.current?.querySelector<HTMLElement>(".lc-home-live-code");
      for (const animation of code?.getAnimations?.({ subtree: true }) ?? []) animation.currentTime = 0;
    }
    previousScene.current = scene;
  }, [mode.id, scene]);
  return (
    <motion.span className="lc-home-cell" data-mode={mode.id} data-tier={HOME_TIER[mode.id] ?? 3}
      {...homeTileMotion(active, !!reduced, delay, !busy, HOME_TIER[mode.id] === 2 ? 1.012 : 1.035)}>
      <button
        ref={cardRef}
        type="button"
        className="lc-home-card"
        data-mode={mode.id}
        data-scene={hoverable ? scene : undefined}
        data-boosted={boostable ? active && !busy && (pointerOver || focused || pressed) : undefined}
        aria-label={`${mode.kicker} — ${mode.blurb}${mode.wip ? " (work in progress)" : ""}`}
        disabled={busy}
        onClick={mode.onOpen}
        onPointerEnter={boostable ? e => { if (e.pointerType !== "touch") setPointerOver(true); } : undefined}
        onPointerLeave={boostable ? () => { setPointerOver(false); setPressed(false); } : undefined}
        onPointerDown={boostable ? () => setPressed(true) : undefined}
        onPointerUp={boostable ? () => setPressed(false) : undefined}
        onPointerCancel={boostable ? () => setPressed(false) : undefined}
        onFocus={boostable ? () => setFocused(true) : undefined}
        onBlur={boostable ? () => setFocused(false) : undefined}
        onMouseEnter={hoverable ? () => {
          window.clearTimeout(leaveTimer.current);
          tracer.current?.enter();
          if (braces.current && cardRef.current) {
            // Typing starts the moment the braces finish opening from wherever they were.
            const ms = braces.current.open();
            cardRef.current.style.setProperty("--lc-home-code-start", `${ms}ms`);
            codeStartsAt.current = performance.now() + ms;
          }
          setScene("in");
        } : undefined}
        onMouseLeave={hoverable ? () => {
          setScene("out");
          window.clearTimeout(leaveTimer.current);
          if (tracer.current) {
            tracer.current.leave(() => setScene("rest"));
            return;
          }
          if (braces.current) {
            const ms = braces.current.close(performance.now() >= codeStartsAt.current);
            leaveTimer.current = window.setTimeout(() => {
              braces.current?.release();
              setScene("rest");
            }, ms + 60);
            return;
          }
          leaveTimer.current = window.setTimeout(
            () => setScene("rest"),
            LEAVE_MS[mode.id] ?? 400,
          );
        } : undefined}
      >
        {mode.wip ? <span className="lc-home-wip">(WIP)</span> : null}
        <span className="lc-home-card-sweep" aria-hidden />
        <span className="lc-home-card-icon" aria-hidden>
          {active && mode.live}
          {mode.icon}
        </span>
        <span className="lc-home-card-text">
          <span className="lc-home-card-kicker">{mode.kicker}</span>
          <span className="lc-home-card-blurb">{mode.blurb}</span>
        </span>
      </button>
    </motion.span>
  );
}
