/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";

import { renderMarkdown } from "../modes/AnnotateDocument";
import { classifyDocLink, findDocAnchor, headingSlug } from "./docLinks";

function doc(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  return root;
}

function link(href: string): HTMLAnchorElement {
  const a = document.createElement("a");
  a.setAttribute("href", href);
  return a;
}

describe("headingSlug", () => {
  it("makes GitHub's slugs, numbering repeats", () => {
    const seen = new Map<string, number>();
    expect(headingSlug("Chapter 8: Graphs & Trees!", seen)).toBe("chapter-8-graphs--trees");
    expect(headingSlug("Intro", seen)).toBe("intro");
    expect(headingSlug("Intro", seen)).toBe("intro-1");
    expect(headingSlug("Älgebra", seen)).toBe("älgebra");
  });
});

describe("renderMarkdown heading ids", () => {
  it("gives each heading an id a table of contents can reach", () => {
    const root = doc(renderMarkdown("[Go](#the-graphs)\n\n# Intro\n\n## The $G$ graphs\n\n# Intro\n"));
    const ids = [...root.querySelectorAll("h1, h2")].map((h) => h.id);
    expect(ids).toEqual(["user-content-intro", "user-content-the-g-graphs", "user-content-intro-1"]);
    expect(findDocAnchor(root, "the-g-graphs")?.tagName).toBe("H2");
    expect(findDocAnchor(root, "intro-1")).toBe(root.querySelectorAll("h1")[1]);
  });

  it("starts the numbering over for each note", () => {
    renderMarkdown("# Intro\n");
    expect(doc(renderMarkdown("# Intro\n")).querySelector("h1")!.id).toBe("user-content-intro");
  });

  it("keeps the note's own anchors, prefixed, so a name like `forms` can't shadow the page", () => {
    const root = doc(renderMarkdown('<a id="forms"></a>\n\nText <span id="sec2">here</span>\n'));
    expect(root.querySelector("a")!.id).toBe("user-content-forms");
    expect(findDocAnchor(root, "forms")).toBe(root.querySelector("a"));
    expect(findDocAnchor(root, "sec2")?.textContent).toBe("here");
  });
});

describe("findDocAnchor", () => {
  it("matches a link written with another tool's slug rules", () => {
    const root = doc('<h2 id="user-content-1-introduction">1. Introduction</h2><h2>Big-O Notation</h2>');
    expect(findDocAnchor(root, "1introduction")?.textContent).toBe("1. Introduction");
    expect(findDocAnchor(root, "big-o%20notation")?.textContent).toBe("Big-O Notation");
    expect(findDocAnchor(root, "nowhere")).toBeNull();
  });

  it("finds an anchor by its name", () => {
    const root = doc('<p><a name="user-content-ref1"></a>Ref</p>');
    expect(findDocAnchor(root, "#ref1")).toBe(root.querySelector("a"));
  });
});

describe("classifyDocLink", () => {
  it("jumps for a fragment, leaves for the web, and does nothing for anything else", () => {
    expect(classifyDocLink(link("#intro"))).toEqual({ kind: "anchor", fragment: "intro" });
    expect(classifyDocLink(link("#"))).toEqual({ kind: "inert" });
    expect(classifyDocLink(link(`${window.location.origin}${window.location.pathname}#sec`))).toEqual({ kind: "anchor", fragment: "sec" });
    expect(classifyDocLink(link("https://example.com/a"))).toEqual({ kind: "external", url: "https://example.com/a" });
    expect(classifyDocLink(link("chapter2.md"))).toEqual({ kind: "inert" });
    expect(classifyDocLink(link("javascript:alert(1)"))).toEqual({ kind: "inert" });
  });
});
