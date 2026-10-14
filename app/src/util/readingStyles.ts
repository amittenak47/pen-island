/**
 * What the reader is reading, and the shape of the notes they want.
 *
 * Chosen on every ChatBot request and sent with it; nothing is stored on the
 * document. The sheet starts from the last choice, so a reader working through
 * one book taps Start, and the first request ever has no type until one is
 * picked. Presets are per kind of text; Custom picks fields from that kind's
 * list or names new ones; Free-form leaves the shape to the assistant.
 */

import type { ReadingStyleDto } from "../api/client";

export type ReadingKind = "textbook" | "story" | "article" | "paper" | "notes" | "code" | "other";
export type NotesFill = "best" | "all";

export const READING_KINDS: ReadonlyArray<{ kind: ReadingKind; label: string }> = [
  { kind: "textbook", label: "Textbook" },
  { kind: "story", label: "Story" },
  { kind: "article", label: "Article" },
  { kind: "paper", label: "Paper" },
  { kind: "notes", label: "Notes / homework" },
  { kind: "code", label: "Code" },
  { kind: "other", label: "Other" },
];

export interface NotesPreset { id: string; label: string; fields: readonly string[] }

/** Ready-made note shapes for each kind of text. */
export const PRESETS: Record<ReadingKind, readonly NotesPreset[]> = {
  textbook: [
    { id: "study", label: "Study", fields: ["Idea", "Example", "Common mistake", "Helps with", "Think about it"] },
    { id: "quick", label: "Quick", fields: ["Idea", "Helps with"] },
    { id: "exam", label: "Exam prep", fields: ["Idea", "Common mistake", "Helps with", "Think about it"] },
  ],
  story: [
    { id: "companion", label: "Reading companion", fields: ["Context", "Character", "Word or phrase", "Theme", "Think about it"] },
    { id: "light", label: "Light", fields: ["Context", "Word or phrase"] },
  ],
  article: [{ id: "argument", label: "Argument", fields: ["Claim", "Evidence", "Counterpoint", "Key term"] }],
  paper: [{ id: "paper", label: "Paper reading", fields: ["Contribution", "Method", "Assumption", "Limitation"] }],
  notes: [{ id: "review", label: "Review", fields: ["Idea", "Check this step", "Helps with"] }],
  code: [{ id: "code", label: "Code reading", fields: ["What it does", "Why", "Gotcha"] }],
  other: [{ id: "explain", label: "Explain", fields: ["Idea", "Example", "Think about it"] }],
};

/** Every field a kind's presets use, offered when building a Custom preset. */
export function fieldsFor(kind: ReadingKind): string[] {
  return [...new Set(PRESETS[kind].flatMap((preset) => preset.fields))];
}

export const MAX_NOTE_FIELDS = 8;

/** The sheet's choice: free-form, a preset by id, or custom fields. */
export interface ReadingChoice {
  kind: ReadingKind | null;
  notes: "free" | "custom" | string;
  fill: NotesFill;
  /** Custom fields per kind, kept between requests. */
  custom: Partial<Record<ReadingKind, string[]>>;
}

const KEY = "whiteboard.chatBotReading.v1";
const KINDS = new Set(READING_KINDS.map(({ kind }) => kind));

export function loadReadingChoice(): ReadingChoice {
  const empty: ReadingChoice = { kind: null, notes: "free", fill: "best", custom: {} };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!raw || typeof raw !== "object") return empty;
    const kind = KINDS.has(raw.kind) ? raw.kind as ReadingKind : null;
    const custom: ReadingChoice["custom"] = {};
    if (raw.custom && typeof raw.custom === "object") {
      for (const [key, value] of Object.entries(raw.custom)) {
        if (KINDS.has(key as ReadingKind) && Array.isArray(value)) {
          custom[key as ReadingKind] = value.filter((label): label is string => typeof label === "string" && label.trim().length > 0).slice(0, MAX_NOTE_FIELDS);
        }
      }
    }
    return { kind, notes: typeof raw.notes === "string" ? raw.notes : "free", fill: raw.fill === "all" ? "all" : "best", custom };
  } catch {
    return empty;
  }
}

export function saveReadingChoice(choice: ReadingChoice): void {
  try { localStorage.setItem(KEY, JSON.stringify(choice)); } catch { /* the sheet just starts blank */ }
}

/** The fields a choice resolves to for its kind; empty for free-form. */
export function choiceFields(choice: ReadingChoice): string[] {
  if (!choice.kind || choice.notes === "free") return [];
  if (choice.notes === "custom") return (choice.custom[choice.kind] ?? []).slice(0, MAX_NOTE_FIELDS);
  return [...(PRESETS[choice.kind].find((preset) => preset.id === choice.notes)?.fields ?? [])];
}

/** What a request carries, or null while no kind has been chosen. */
export function readingStyleOf(choice: ReadingChoice): ReadingStyleDto | null {
  if (!choice.kind) return null;
  const fields = choiceFields(choice);
  if (choice.notes !== "free" && fields.length === 0) return null;
  const preset = choice.notes === "custom" ? "Custom" : PRESETS[choice.kind].find((entry) => entry.id === choice.notes)?.label;
  return {
    kind: choice.kind,
    ...(fields.length ? { fields, fill: choice.fill, ...(preset ? { preset } : {}) } : {}),
  };
}
