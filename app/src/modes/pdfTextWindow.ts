import { pdfPaintHole } from "./pdfPaintWindow";

export const PDF_TEXT_PAGE_CAP = 3;

/** Only the paint hole owns selectable spans; rest neighbours use geometry. */
export function pdfSelectablePages(current: number, intersecting: readonly number[]): number[] {
  const hole = pdfPaintHole(current, intersecting);
  if (hole.length <= PDF_TEXT_PAGE_CAP) return hole;
  return hole.sort((a, b) => Math.abs(a - current) - Math.abs(b - current)).slice(0, PDF_TEXT_PAGE_CAP);
}

/** Bounds both retained layers and builds in flight, including quote fills. */
export class PdfTextWindow {
  private wanted = new Set<number>();
  private readonly entries = new Map<number, { abort: AbortController; promise: Promise<boolean> }>();

  constructor(private readonly drop: (page: number) => void) {}

  retain(pages: readonly number[]): void {
    this.wanted = new Set(pages.slice(0, PDF_TEXT_PAGE_CAP));
    for (const page of this.entries.keys()) if (!this.wanted.has(page)) this.remove(page);
  }

  has(page: number): boolean { return this.entries.has(page); }
  wants(page: number): boolean { return this.wanted.has(page); }
  pages(): readonly number[] { return [...this.wanted]; }

  private remove(page: number): void {
    const entry = this.entries.get(page);
    this.entries.delete(page);
    entry?.abort.abort();
    this.drop(page);
  }

  clear(): void {
    for (const page of this.entries.keys()) this.remove(page);
  }

  ensure(page: number, fill: (signal: AbortSignal) => Promise<boolean>, onDemand = false): Promise<boolean> {
    if (onDemand) this.wanted = new Set([page, ...this.wanted].slice(0, PDF_TEXT_PAGE_CAP));
    const existing = this.entries.get(page);
    if (existing) return existing.promise;
    if (!onDemand && !this.wants(page)) return Promise.resolve(false);
    // A quote can arrive before the viewport publisher catches up. It gets a
    // slot immediately, while the next hole publication still owns eviction.
    while (this.entries.size >= PDF_TEXT_PAGE_CAP) this.remove(
      [...this.entries.keys()].find(n => !this.wants(n)) ?? this.entries.keys().next().value!,
    );
    const abort = new AbortController();
    const entry = { abort, promise: Promise.resolve(false) };
    this.entries.set(page, entry);
    entry.promise = Promise.resolve().then(async () => {
      let ok = false;
      try {
        if (!abort.signal.aborted) ok = await fill(abort.signal);
        return ok && !abort.signal.aborted;
      } finally {
        if ((!ok || abort.signal.aborted) && this.entries.get(page) === entry) this.remove(page);
      }
    });
    return entry.promise;
  }
}
