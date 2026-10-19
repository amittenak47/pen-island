import { describe, expect, it } from "vitest";
import { requestExportOnOpen, takePendingExport } from "./pendingExport";

describe("export once the book is open", () => {
  it("is taken once, by the workspace that has that book open", () => {
    requestExportOnOpen("annotate", "book", 1_000);
    expect(takePendingExport("whiteboard", "book", 1_001)).toBe(false);
    expect(takePendingExport("annotate", "other", 1_001)).toBe(false);
    expect(takePendingExport("annotate", null, 1_001)).toBe(false);
    expect(takePendingExport("annotate", "book", 1_002)).toBe(true);
    expect(takePendingExport("annotate", "book", 1_003)).toBe(false);
  });

  it("forgets a request nobody took within a minute", () => {
    requestExportOnOpen("whiteboard", "nb", 0);
    expect(takePendingExport("whiteboard", "nb", 60_001)).toBe(false);
    expect(takePendingExport("whiteboard", "nb", 60_002)).toBe(false);
  });

  it("keeps only the latest request", () => {
    requestExportOnOpen("annotate", "first", 0);
    requestExportOnOpen("annotate", "second", 1);
    expect(takePendingExport("annotate", "first", 2)).toBe(false);
    expect(takePendingExport("annotate", "second", 2)).toBe(true);
  });
});
