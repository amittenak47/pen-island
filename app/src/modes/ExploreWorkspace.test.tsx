/** @vitest-environment jsdom */
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { NodeRef } from "../util/noteLinks";
import { CLUSTERS } from "./exploreLayout";
import { APP_THEMES } from "../theme/appThemes";
import { ExploreWorkspace, type ExploreWorkspaceProps } from "./ExploreWorkspace";

const shell = vi.hoisted(() => ({ headerSlots: { boardChrome: null as HTMLElement | null } }));
vi.mock("../shellContext", () => ({ useShell: () => shell }));
vi.mock("../util/noteLinks", async (importOriginal) => ({
  ...await importOriginal<typeof import("../util/noteLinks")>(),
  listEdges: vi.fn(async () => []),
}));

const NODES: NodeRef[] = [
  { type: "annotate", id: "a", title: "Alpha" },
  { type: "whiteboard", id: "b", title: "Beta" },
];

let root: Root;
let host: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  shell.headerSlots.boardChrome = null;
  let id = 0;
  frames = new Map();
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => frames.delete(key));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  document.body.textContent = "";
  vi.unstubAllGlobals();
});

function render(showing: boolean, props: Partial<ExploreWorkspaceProps> = {}) {
  act(() => root.render(
    <ExploreWorkspace nodes={NODES} themeId="paper" onThemePick={() => {}} onOpen={() => {}}
      onOpenInNewTab={() => {}} canOpenInNewTab={() => true} active={showing} showing={showing} {...props} />,
  ));
}

/** Run every pending frame once; the loop asks for its next one as it goes. */
function frame(at: number) {
  const batch = [...frames.values()];
  frames.clear();
  act(() => { for (const cb of batch) cb(at); });
}

it("runs no drift loop while parked behind another tab, and picks it up on return", async () => {
  render(false);
  await act(async () => {}); // the edges arrive
  expect(frames.size).toBe(0);
  render(true);
  expect(frames.size).toBe(1);
  frame(performance.now() + 16);
  expect(frames.size).toBe(1);
  render(false);
  expect(frames.size).toBe(0);
  render(true);
  expect(frames.size).toBe(1);
});

it("does not re-render while the nodes only drift", async () => {
  const commits = vi.fn();
  act(() => root.render(
    <Profiler id="explore" onRender={commits}>
      <ExploreWorkspace nodes={NODES} themeId="paper" onThemePick={() => {}} onOpen={() => {}}
        onOpenInNewTab={() => {}} canOpenInNewTab={() => true} active showing />
    </Profiler>,
  ));
  await act(async () => {});
  const before = commits.mock.calls.length;
  let at = performance.now();
  for (let i = 0; i < 90; i++) frame((at += 16));
  expect(commits.mock.calls.length).toBe(before);
});

/** jsdom has no PointerEvent; the loop only reads `pointerId`. */
function pointer(type: string, pointerId: number) {
  const event = new MouseEvent(type, { bubbles: true });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

it("slows to an idle rate once only drifting, and a press brings it back at once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    render(true);
    await act(async () => {});
    let at = performance.now();
    let ticks = 0;
    while (frames.size > 0 && ticks < 600) {
      frame((at += 16));
      ticks += 1;
    }
    expect(frames.size).toBe(0);
    expect(vi.getTimerCount()).toBe(1);

    act(() => vi.advanceTimersByTime(40));
    expect(frames.size).toBe(1);
    frame((at += 50));
    expect(frames.size).toBe(0);

    const stage = host.querySelector(".lc-explore-stage")!;
    act(() => { stage.dispatchEvent(pointer("pointerdown", 3)); });
    expect(frames.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    for (let i = 0; i < 120; i++) frame((at += 16));
    expect(frames.size).toBe(1);

    act(() => { window.dispatchEvent(pointer("pointerup", 3)); });
    for (let i = 0; i < 120; i++) frame((at += 16));
    expect(frames.size).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

function kindButton(type: NodeRef["type"]) {
  const label = CLUSTERS.find((cluster) => cluster.type === type)!.label;
  return host.querySelector<HTMLButtonElement>(`.lc-explore-legend-kind[aria-label="${label}"]`)!;
}

function liveNodeKeys() {
  return [...host.querySelectorAll(".lc-explore-node:not(.is-leaving)")]
    .map((node) => node.getAttribute("data-node-key"));
}

function searchFor(value: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  act(() => {
    // Use the native setter so React sees the input event as a user edit.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input;
}

it("keeps the legend and title search available without rendering a tray or Find toggle", async () => {
  shell.headerSlots.boardChrome = document.createElement("div");
  document.body.append(shell.headerSlots.boardChrome);
  render(true);
  await act(async () => {});
  expect(host.querySelector(".lc-explore-legend-caption")!.textContent).toBe("Key \u00b7 click to filter");
  const input = host.querySelector<HTMLInputElement>('input[placeholder="Search catalog"]')!;
  expect(input.tabIndex).toBe(0);
  expect(input.closest("form")!.className).toBe("lc-explore-find");
  expect(document.querySelector(".lc-map-controls")).toBeNull();
  expect(document.querySelector(".lc-map-chrome-stack")).toBeNull();
  expect(document.querySelector('button[aria-label="Find a workspace"]')).toBeNull();
  expect(shell.headerSlots.boardChrome.children.length).toBe(0);
});

it("filters by legend kinds and restores all nodes when the final kind is toggled off", async () => {
  render(true);
  await act(async () => {});
  expect(CLUSTERS.every(({ type }) => kindButton(type).getAttribute("aria-pressed") === "false")).toBe(true);
  expect(liveNodeKeys()).toEqual(["annotate:a", "whiteboard:b"]);
  act(() => kindButton("annotate").click());
  expect(kindButton("annotate").getAttribute("aria-pressed")).toBe("true");
  expect(liveNodeKeys()).toEqual(["annotate:a"]);
  act(() => kindButton("whiteboard").click());
  expect(liveNodeKeys()).toEqual(["annotate:a", "whiteboard:b"]);
  act(() => kindButton("annotate").click());
  expect(kindButton("annotate").getAttribute("aria-pressed")).toBe("false");
  expect(liveNodeKeys()).toEqual(["whiteboard:b"]);
  act(() => kindButton("whiteboard").click());
  expect(liveNodeKeys()).toEqual(["annotate:a", "whiteboard:b"]);
});

it("counts every catalog kind, including zero, and updates without changing counts on filtering", async () => {
  const nodes: NodeRef[] = [...NODES, { type: "annotate", id: "c", title: "Another note" },
    { type: "practice", id: "p" }, { type: "web", id: "w" }, { type: "thread", id: "t" }];
  render(true, { nodes });
  await act(async () => {});
  const counts = () => CLUSTERS.map(({ type }) => kindButton(type).querySelector(".lc-explore-legend-count")!.textContent);
  expect(counts()).toEqual(["2", "1", "1", "1", "1"]);
  act(() => kindButton("web").click());
  searchFor("missing");
  expect(counts()).toEqual(["2", "1", "1", "1", "1"]);
  render(true, { nodes: [...nodes, { type: "annotate" as const, id: "d" }].filter((node) => node.type !== "thread") });
  expect(counts()).toEqual(["3", "1", "1", "1", "0"]);
});

it("switches grouping on and off", async () => {
  render(true);
  await act(async () => {});
  const group = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(group.textContent).toContain("Cluster");
  expect(group.getAttribute("aria-checked")).toBe("false");
  act(() => group.click());
  expect(group.getAttribute("aria-checked")).toBe("true");
  act(() => group.click());
  expect(group.getAttribute("aria-checked")).toBe("false");
});

it("searches titles immediately and clears with the button or Escape", async () => {
  render(true);
  await act(async () => {});
  const clear = host.querySelector<HTMLButtonElement>('[aria-label="Clear the search"]')!;
  expect(clear.disabled).toBe(true);
  expect(clear.getAttribute("aria-hidden")).toBe("true");
  const input = searchFor("aLpH");
  expect(liveNodeKeys()).toEqual(["annotate:a"]);
  expect(clear.disabled).toBe(false);
  expect(clear.classList.contains("is-visible")).toBe(true);
  act(() => clear.click());
  expect(input.value).toBe("");
  expect(document.activeElement).toBe(input);
  expect(liveNodeKeys()).toEqual(["annotate:a", "whiteboard:b"]);
  searchFor("Beta");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(input.value).toBe("");
  expect(document.activeElement).not.toBe(input);
  expect(liveNodeKeys()).toEqual(["annotate:a", "whiteboard:b"]);
  expect(clear.classList.contains("is-visible")).toBe(false);
});

it("opens every background from one swatch, keeps it open while picking, and closes on Escape", async () => {
  const onThemePick = vi.fn();
  render(true, { onThemePick, themeId: APP_THEMES[0].id });
  await act(async () => {});
  const trigger = host.querySelector<HTMLButtonElement>(".lc-palette-swatch-trigger")!;
  expect(trigger.getAttribute("aria-label")).toBe(`Background: ${APP_THEMES[0].label}`);
  expect(document.querySelector('[role="listbox"][aria-label="Background"]')).toBeNull();
  act(() => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const palette = document.querySelector('[role="listbox"][aria-label="Background"]')!;
  const swatches = palette.querySelectorAll<HTMLButtonElement>(".lc-swatch");
  expect(swatches.length).toBe(APP_THEMES.length);
  expect(palette.querySelector('[aria-selected="true"]')?.getAttribute("aria-label")).toBe(`${APP_THEMES[0].label} background`);
  const second = [...swatches].find((swatch) => swatch.getAttribute("aria-label") === `${APP_THEMES[1].label} background`)!;
  act(() => second.click());
  expect(onThemePick).toHaveBeenCalledWith(APP_THEMES[1].id);
  expect(document.querySelector('[role="listbox"][aria-label="Background"]')).not.toBeNull();
  act(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(document.querySelector('[role="listbox"][aria-label="Background"]')).toBeNull();
});

it("keeps a compact Cluster control in the board stack and removes its portal while parked", async () => {
  const boardChrome = document.createElement("div");
  const slot = document.createElement("div");
  slot.setAttribute("data-lc-explore-chrome", "");
  boardChrome.append(slot);
  document.body.append(boardChrome);
  shell.headerSlots.boardChrome = boardChrome;
  render(true, { embedInBoardTray: true });
  await act(async () => {});
  const cluster = slot.querySelector<HTMLButtonElement>('button[aria-label="Gather nodes by kind"]')!;
  expect(cluster).not.toBeNull();
  act(() => cluster.click());
  expect(cluster.getAttribute("aria-pressed")).toBe("true");
  const group = host.querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(group.getAttribute("aria-checked")).toBe("true");
  act(() => group.click());
  expect(cluster.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('input[placeholder="Search catalog"]')).not.toBeNull();
  expect(host.querySelectorAll(".lc-explore-legend-kind").length).toBe(5);
  render(false, { embedInBoardTray: true });
  expect(slot.children.length).toBe(0);
});
