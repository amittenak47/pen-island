/**
 * The one stored form of a book's agent (ChatBot) messages and footnotes.
 *
 * Every device writes the same content the same way, so two copies that hold
 * the same messages also hold the same bytes and the same sync fingerprint.
 * Before this, a merge appended the other device's new messages after its own
 * (each device kept its own order) and stamped `pending: false` on only some
 * of them, so identical transcripts read as edits on both sides and the book
 * came up as a sync conflict with nothing to choose between.
 *
 * - Agent messages are ordered by time (`at`); at the same moment a question
 *   before its answer (by role), then by id.
 * - A message's fields are written in name order.
 * - Empty is written, never left out: the on/off flags as `false`, the lists
 *   as `[]`, the optional text as `""`, inherited artifact footnotes as `null`.
 *   These are exactly the fields the sync fingerprint treats
 *   as "empty equals absent" (see syncContent.ts), so writing them changes no
 *   fingerprint. Values whose presence means something (a deletion time, a
 *   reply target) stay absent until they are set.
 */
import { FOOTNOTE_EMPTY_LIST_KEYS, MESSAGE_EMPTY_LIST_KEYS, MESSAGE_EMPTY_STRING_KEYS, MESSAGE_FALSE_DEFAULT_KEYS } from "./syncContent";

const isRow = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** A copy of `row` with each missing (or null) list set to `[]`, or `row` itself if none was. */
function withEmptyLists<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  let next: Record<string, unknown> | null = null;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) continue;
    next ??= { ...row };
    next[key] = [];
  }
  return (next ?? row) as T;
}

function withEmptyStrings<T extends Record<string, unknown>>(row: T, keys: readonly string[]): T {
  let next: Record<string, unknown> | null = null;
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null) continue;
    next ??= { ...row };
    next[key] = "";
  }
  return (next ?? row) as T;
}

/** Each object in `list`, passed through `fix`; the same array if nothing changed. */
function mapRows(list: unknown, fix: (row: Record<string, unknown>) => Record<string, unknown>): unknown {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map((item) => {
    if (!isRow(item)) return item;
    const fixed = fix(item);
    if (fixed !== item) changed = true;
    return fixed;
  });
  return changed ? next : list;
}

const ROLE_ORDER: Record<string, number> = { system: 0, user: 1, assistant: 2, app: 3 };

function atOf(value: unknown): number {
  const at = isRow(value) ? value.at : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : 0;
}

function roleOf(value: unknown): number {
  const role = isRow(value) ? value.role : undefined;
  return typeof role === "string" && role in ROLE_ORDER ? ROLE_ORDER[role]! : 4;
}

function idOf(value: unknown): string {
  const id = isRow(value) ? value.id : undefined;
  return typeof id === "string" ? id : "";
}

function canonicalMessage(message: Record<string, unknown>): Record<string, unknown> {
  let row = withEmptyStrings(withEmptyLists(message, MESSAGE_EMPTY_LIST_KEYS), MESSAGE_EMPTY_STRING_KEYS);
  if (row.artifactFootnoteIds === undefined) row = { ...row, artifactFootnoteIds: null };
  for (const flag of MESSAGE_FALSE_DEFAULT_KEYS) {
    if (typeof row[flag] === "boolean") continue;
    if (row === message) row = { ...message };
    row[flag] = false;
  }
  const drawing = row.drawing;
  if (isRow(drawing) && typeof drawing.redacted !== "boolean") {
    if (row === message) row = { ...message };
    row.drawing = { ...drawing, redacted: false };
  }
  const proposals = mapRows(row.artifactProposals, (proposal) => withEmptyLists(proposal, ["programs", "messages"]));
  if (proposals !== row.artifactProposals) {
    if (row === message) row = { ...message };
    row.artifactProposals = proposals;
  }
  // Fields in one order too, so the same message is the same bytes everywhere.
  return Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function canonicalAgentMessages<T = unknown>(messages: readonly T[]): T[] {
  const rows = messages.map((message) => (isRow(message) ? canonicalMessage(message) : message) as T);
  // A stable sort: rows with neither time nor id keep their relative order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => atOf(a.row) - atOf(b.row) || roleOf(a.row) - roleOf(b.row)
      || idOf(a.row).localeCompare(idOf(b.row)) || a.index - b.index)
    .map(({ row }) => row);
}

/** Legacy messages inherit the current attachments; an explicit list stays fixed. */
export function artifactFootnoteIdsForMessage(
  message: { artifactFootnoteIds?: string[] | null } | undefined,
  attachedFootnoteIds: string[],
): string[] {
  return message?.artifactFootnoteIds ?? attachedFootnoteIds;
}

/** Footnotes keep their order; empty lists and optional text are written explicitly. */
export function canonicalFootnotes<T = unknown>(footnotes: readonly T[]): T[] {
  return footnotes.map((footnote) => {
    if (!isRow(footnote)) return footnote;
    let row: Record<string, unknown> = withEmptyLists(footnote as Record<string, unknown>, FOOTNOTE_EMPTY_LIST_KEYS);
    row = withEmptyStrings(withEmptyLists(row, ["palette"]), ["title", "blockText", "query", "url", "excerpt", "color"]);
    const anchor = (row: Record<string, unknown>) => {
      if (!isRow(row.anchor) || row.anchor.kind === "region") return row;
      const fixed = withEmptyStrings(row.anchor, ["prefix", "suffix"]);
      return fixed === row.anchor ? row : { ...row, anchor: fixed };
    };
    row = anchor(row);
    const notes = mapRows(row.notes, (note) => withEmptyStrings(withEmptyLists(note, ["images"]), ["field", "by"]));
    const marks = mapRows(row.subMarks, (mark) => anchor(withEmptyStrings(withEmptyLists(mark, ["bands", "palette"]), ["color", "excerpt"])));
    if (notes !== row.notes || marks !== row.subMarks) row = { ...row, notes, subMarks: marks };
    for (const key of ["userLinks", "whiteboards"]) {
      const entries = mapRows(row[key], (entry) => withEmptyStrings(entry, ["title"]));
      if (entries !== row[key]) row = { ...row, [key]: entries };
    }
    return row as unknown as T;
  });
}
