/**
 * Links inside a document: a table of contents, "see section 3", a footnote
 * reference. A `#name` link jumps to its target in the same document; any
 * other web link opens in the browser. Nothing navigates the app itself.
 */

/** Ids and names from a note's own HTML get this prefix (DOMPurify's `SANITIZE_NAMED_PROPS`), headings too. */
export const DOC_ID_PREFIX = "user-content-";

/**
 * A heading's slug, as GitHub makes them: lower case, punctuation dropped,
 * spaces to hyphens, and `-1`, `-2` on repeats. Most tables of contents in
 * markdown are written against these.
 */
export function headingSlug(text: string, seen: Map<string, number>): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc}\- ]/gu, "")
    .replace(/ /g, "-");
  const count = seen.get(base) ?? 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count}`;
}

/** A heading's raw markdown text, near enough to what a reader sees for a slug: link targets and math fences out. */
export function headingPlainText(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\$+/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_`~]/g, "");
}

/** Letters and digits only, lower case: for matching a link written by another tool's slug rules. */
function loose(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function decodeFragment(fragment: string): string {
  try {
    return decodeURIComponent(fragment);
  } catch {
    return fragment;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Where `#fragment` points inside `root`, or null.
 *
 * Looked up inside the document, never the page: a note can be open twice
 * (split panes, a footnote preview), and ids repeat. Tried in order: the id
 * or name as the note's HTML gave it (prefixed by the sanitiser), the bare
 * id, then a heading whose slug or text matches loosely, for tables of
 * contents made by tools with other slug rules (Pandoc, Typora, Word).
 */
export function findDocAnchor(root: ParentNode, fragment: string): Element | null {
  const name = decodeFragment(fragment.replace(/^#/, ""));
  if (!name) return null;
  for (const candidate of [DOC_ID_PREFIX + name, name]) {
    const value = escapeAttr(candidate);
    const hit = root.querySelector(`[id="${value}"], a[name="${value}"]`);
    if (hit) return hit;
  }
  const want = loose(name);
  if (!want) return null;
  const headings = [...root.querySelectorAll("h1, h2, h3, h4, h5, h6")];
  for (const heading of headings) {
    if (loose(heading.id.replace(DOC_ID_PREFIX, "")) === want) return heading;
  }
  for (const heading of headings) {
    if (loose(heading.textContent ?? "") === want) return heading;
  }
  return null;
}

export type DocLink =
  | { kind: "anchor"; fragment: string }
  | { kind: "external"; url: string }
  | { kind: "inert" };

/**
 * What a link in a document does. `#name` (or the note's own address with
 * `#name`) jumps inside it; an http(s) or mailto link leaves the app; any
 * other (a relative file, a `javascript:` link the sanitiser let by) does
 * nothing rather than navigate the app away.
 */
export function classifyDocLink(anchor: HTMLAnchorElement): DocLink {
  const raw = anchor.getAttribute("href")?.trim() ?? "";
  if (raw.startsWith("#")) return raw.length > 1 ? { kind: "anchor", fragment: raw.slice(1) } : { kind: "inert" };
  let url: URL;
  try {
    url = new URL(raw, window.location.href);
  } catch {
    return { kind: "inert" };
  }
  if (url.protocol === "http:" || url.protocol === "https:") {
    // The app's own address with a fragment: a jump, not a page.
    const here = new URL(window.location.href);
    if (url.origin === here.origin && url.pathname === here.pathname && url.hash.length > 1) {
      return { kind: "anchor", fragment: url.hash.slice(1) };
    }
    if (url.origin === here.origin) return { kind: "inert" };
    return { kind: "external", url: url.href };
  }
  return { kind: "inert" };
}

/**
 * `target`'s top inside `doc`, in the doc's own (scene) units, however the
 * board scales it. A target inside a block the reader has not drawn yet
 * (`content-visibility: hidden`) has no box of its own: its block's top
 * stands in.
 */
export function anchorDocY(doc: HTMLElement, target: Element): number {
  const docRect = doc.getBoundingClientRect();
  const scale = docRect.height > 0 && doc.offsetHeight > 0 ? doc.offsetHeight / docRect.height : 1;
  let box = target.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) {
    let block: Element | null = target;
    while (block && block.parentElement !== doc) block = block.parentElement;
    if (block) box = block.getBoundingClientRect();
  }
  return Math.max(0, (box.top - docRect.top) * scale);
}
