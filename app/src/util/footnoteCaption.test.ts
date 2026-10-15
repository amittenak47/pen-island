import { describe, expect, it } from "vitest";

import { CAPTION_MAX_WIDTH, footnoteCaptionRoom } from "./footnoteCaption";

describe("footnoteCaptionRoom", () => {
  it("fits the title into the margin beside the text column", () => {
    expect(footnoteCaptionRoom(700, 600)).toBe(94);
  });

  it("caps a wide margin so long titles are ellipsized", () => {
    expect(footnoteCaptionRoom(900, 300)).toBe(CAPTION_MAX_WIDTH);
  });

  it("leaves the title off when the margin is too narrow to read", () => {
    expect(footnoteCaptionRoom(700, 670)).toBe(0);
    expect(footnoteCaptionRoom(700, 720)).toBe(0);
  });
});
