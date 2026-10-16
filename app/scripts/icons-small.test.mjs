import { describe, expect, it } from "vitest";

import { readIco, withSmallEntries, writeIco } from "./icons-small.mjs";

const png = (marker) => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, marker]);

describe("icon.ico small entries", () => {
  const original = writeIco([
    { size: 256, planes: 1, bpp: 32, colors: 0, image: png(1) },
    { size: 16, planes: 1, bpp: 32, colors: 0, image: png(2) },
    { size: 64, planes: 1, bpp: 32, colors: 0, image: png(3) },
  ]);

  it("round-trips entries, 256 px included", () => {
    const entries = readIco(original);
    expect(entries.map((e) => e.size)).toEqual([16, 64, 256]);
    expect([...entries[2].image]).toEqual([...png(1)]);
  });

  it("swaps the small sizes and keeps the large ones", () => {
    const small = new Map([[16, png(9)], [32, png(8)]]);
    const entries = readIco(writeIco(withSmallEntries(readIco(original), small)));
    expect(entries.map((e) => e.size)).toEqual([16, 32, 64, 256]);
    expect([...entries[0].image]).toEqual([...png(9)]);
    expect([...entries[1].image]).toEqual([...png(8)]);
    expect([...entries[2].image]).toEqual([...png(3)]);
  });

  it("refuses a file that is not an icon", () => {
    expect(() => readIco(new Uint8Array(8).fill(7))).toThrow(/not an \.ico/);
  });
});
