import { useSyncExternalStore } from "react";

/**
 * What an open is doing right now, in words, for the loading overlays.
 *
 * Fed by `traceOpen`, which already marks each step of an open for the
 * console; this turns the steps a reader would recognise into a line above
 * the spinner. Steps that are not worth saying keep the last line.
 */
const STEP_TEXT: ReadonlyArray<readonly [RegExp, string]> = [
  [/^start$/, "Opening your document…"],
  [/^(picker: file (chosen|read)|hashed|saving bytes|bytes |saving picked bytes|picked bytes saved|no bytes to save)/, "Reading the file…"],
  [/^pdf: (mounted|pdf\.js loaded)/, "Starting the PDF reader…"],
  [/^(pdf: document parsed|template|markdown (rendered|from render cache|layout record))/, "Laying out pages…"],
  [/^whiteboard: mounting/, "Opening the board…"],
  [/^(ink restored|ink snap primed)/, "Restoring your ink…"],
  [/^(fit settled|view restored|session PDF camera jumped)/, "Returning to your page…"],
  [/^doodle idle/, "Almost ready…"],
];

let current: string | null = null;
const listeners = new Set<() => void>();

export function openStepText(step: string): string | null {
  for (const [pattern, text] of STEP_TEXT) if (pattern.test(step)) return text;
  return null;
}

export function noteOpenStep(step: string): void {
  const text = openStepText(step);
  if (!text || text === current) return;
  current = text;
  for (const listener of [...listeners]) listener();
}

export function peekOpenStatus(): string | null {
  return current;
}

export function resetOpenStatus(): void {
  if (current == null) return;
  current = null;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenStatus(): string | null {
  return useSyncExternalStore(subscribe, peekOpenStatus, peekOpenStatus);
}
