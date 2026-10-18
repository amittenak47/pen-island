/**
 * Quote-time PDF text fill: one-shot, keyed by film scope.
 *
 * Only an interaction that needs selectable spans asks here. The caller waits
 * for the shared fill before resolving its caret/range or confirming a quote.
 * PdfDocument registers the filler for its scope; paint only fetches geometry.
 */

const fills = new Map<string, (page: number) => Promise<boolean>>();

export function registerPdfQuoteTextFill(
  scope: string,
  fill: (page: number) => Promise<boolean>,
): () => void {
  fills.set(scope, fill);
  return () => {
    if (fills.get(scope) === fill) fills.delete(scope);
  };
}

export async function fillPdfQuoteText(scope: string, page: number): Promise<boolean> {
  if (!scope || !(page >= 1)) return false;
  const fill = fills.get(scope);
  if (!fill) return false;
  return fill(page);
}
