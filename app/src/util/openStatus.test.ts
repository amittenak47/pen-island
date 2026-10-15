import { afterEach, describe, expect, it, vi } from "vitest";
import { noteOpenStep, openStepText, peekOpenStatus, resetOpenStatus } from "./openStatus";
import { traceOpen } from "./messageOf";

afterEach(() => { resetOpenStatus(); vi.restoreAllMocks(); });

describe("open status", () => {
  it("says the steps a reader would recognise", () => {
    expect(openStepText("start")).toBe("Opening your document…");
    expect(openStepText("hashed")).toBe("Reading the file…");
    expect(openStepText("pdf: document parsed")).toBe("Laying out pages…");
    expect(openStepText("ink restored")).toBe("Restoring your ink…");
    expect(openStepText("view restored")).toBe("Returning to your page…");
    expect(openStepText("doodle idle")).toBe("Almost ready…");
  });

  it("keeps the last line through steps not worth saying, failures included", () => {
    noteOpenStep("pdf: document parsed");
    noteOpenStep("layout gate timed out with paper on screen");
    noteOpenStep("FAILED");
    expect(peekOpenStatus()).toBe("Laying out pages…");
  });

  it("is fed by traceOpen", () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    traceOpen("ink restored", { pages: 3 });
    expect(peekOpenStatus()).toBe("Restoring your ink…");
  });
});
