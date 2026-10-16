#!/usr/bin/env node
/**
 * Put the simplified "pi" mark into the small desktop icon sizes.
 *
 * `tauri icon` renders every size from one source, so the 16-48 px entries in
 * `icon.ico` (taskbar, title bar, Explorer lists) were the full mark shrunk to
 * mush. `docs/icons/icon-small.svg` is drawn for those sizes. This renders it
 * at 16, 24, 32 and 48 px into a temp folder and swaps those entries into
 * `icon.ico`, keeping the larger ones; it also replaces the 32 px PNG and the
 * web favicon. Run after `tauri icon` (`npm run icons:sync` does both).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SMALL_SVG = join(APP_DIR, "..", "docs", "icons", "icon-small.svg");
const ICONS = join(APP_DIR, "src-tauri", "icons");
export const SMALL_SIZES = [16, 24, 32, 48];

/**
 * Read an .ico file's entries.
 * @param {Uint8Array} data
 * @returns {{ size: number, planes: number, bpp: number, colors: number, image: Uint8Array }[]}
 */
export function readIco(data) {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) throw new Error("not an .ico file");
  const count = view.getUint16(4, true);
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const at = 6 + 16 * i;
    const size = view.getUint8(at) || 256;
    const length = view.getUint32(at + 8, true);
    const offset = view.getUint32(at + 12, true);
    entries.push({
      size,
      colors: view.getUint8(at + 2),
      planes: view.getUint16(at + 4, true),
      bpp: view.getUint16(at + 6, true),
      image: data.subarray(offset, offset + length),
    });
  }
  return entries;
}

/**
 * Write square .ico entries (PNG or BMP payloads), smallest first.
 * @param {{ size: number, planes: number, bpp: number, colors: number, image: Uint8Array }[]} entries
 * @returns {Uint8Array}
 */
export function writeIco(entries) {
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const header = 6 + 16 * sorted.length;
  const total = header + sorted.reduce((sum, entry) => sum + entry.image.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, sorted.length, true);
  let offset = header;
  sorted.forEach((entry, i) => {
    const at = 6 + 16 * i;
    view.setUint8(at, entry.size % 256);
    view.setUint8(at + 1, entry.size % 256);
    view.setUint8(at + 2, entry.colors);
    view.setUint16(at + 4, entry.planes, true);
    view.setUint16(at + 6, entry.bpp, true);
    view.setUint32(at + 8, entry.image.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(entry.image, offset);
    offset += entry.image.length;
  });
  return out;
}

/**
 * Replace (or add) the entries for each size in `pngs` with those PNGs.
 * @param {ReturnType<typeof readIco>} entries
 * @param {Map<number, Uint8Array>} pngs
 */
export function withSmallEntries(entries, pngs) {
  const kept = entries.filter((entry) => !pngs.has(entry.size));
  const added = [...pngs].map(([size, image]) => ({ size, planes: 1, bpp: 32, colors: 0, image }));
  return [...kept, ...added];
}

function main() {
  const out = mkdtempSync(join(tmpdir(), "pen-island-small-icons-"));
  try {
    const args = ["tauri", "icon", SMALL_SVG, "-o", out, ...SMALL_SIZES.flatMap((size) => ["-p", String(size)])];
    const result = spawnSync("npx", args, { cwd: APP_DIR, stdio: "inherit", shell: true, timeout: 120_000 });
    if ((result.status ?? 1) !== 0) throw new Error("tauri icon failed for the small icon");
    const pngs = new Map(SMALL_SIZES.map((size) => [size, readFileSync(join(out, `${size}x${size}.png`))]));
    const icoPath = join(ICONS, "icon.ico");
    writeFileSync(icoPath, writeIco(withSmallEntries(readIco(readFileSync(icoPath)), pngs)));
    copyFileSync(join(out, "32x32.png"), join(ICONS, "32x32.png"));
    copyFileSync(join(out, "32x32.png"), join(APP_DIR, "public", "favicon.png"));
    console.log("small icons: icon.ico 16-48 px, 32x32.png and favicon use icon-small.svg");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
