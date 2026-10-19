/**
 * The one stored form of a book's agent (ChatBot) messages.
 *
 * Every device writes the same transcript the same way, so two copies that
 * hold the same messages also hold the same bytes and the same sync
 * fingerprint. Before this, a merge appended the other device's new messages
 * after its own (each device kept its own order) and stamped `pending: false`
 * on only some of them, so identical transcripts read as edits on both sides
 * and the book came up as a sync conflict with nothing to choose between.
 *
 * - Ordered by time (`at`); at the same moment a question before its answer
 *   (by role), then by id.
 * - The on/off flags are always written: `false`, never missing.
 */
const FLAGS = ["pending", "queued", "bridgePending"] as const;

const isRow = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function atOf(value: unknown): number {
  const at = isRow(value) ? value.at : undefined;
  return typeof at === "number" && Number.isFinite(at) ? at : 0;
}

const ROLE_ORDER: Record<string, number> = { system: 0, user: 1, assistant: 2, app: 3 };

function roleOf(value: unknown): number {
  const role = isRow(value) ? value.role : undefined;
  return typeof role === "string" && role in ROLE_ORDER ? ROLE_ORDER[role]! : 4;
}

function idOf(value: unknown): string {
  const id = isRow(value) ? value.id : undefined;
  return typeof id === "string" ? id : "";
}

export function canonicalAgentMessages<T = unknown>(messages: readonly T[]): T[] {
  const rows = messages.map((message) => {
    if (!isRow(message)) return message;
    let row: Record<string, unknown> | null = null;
    for (const flag of FLAGS) {
      if (typeof message[flag] === "boolean") continue;
      row ??= { ...message };
      row[flag] = false;
    }
    return (row ?? message) as T;
  });
  // A stable sort: rows with neither time nor id keep their relative order.
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => atOf(a.row) - atOf(b.row) || roleOf(a.row) - roleOf(b.row)
      || idOf(a.row).localeCompare(idOf(b.row)) || a.index - b.index)
    .map(({ row }) => row);
}
