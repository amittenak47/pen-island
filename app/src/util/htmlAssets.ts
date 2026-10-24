import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { DocSourceRef } from "./docSourceStore";

/**
 * Files beside a local HTML document, for its live page (html_assets.rs).
 *
 * The page's file is linked to a place on this device; its folder is served
 * under a token the app makes up, so a page that plays `3.7.mp4` or shows
 * `official/p-1.png` finds them where they sit. Nothing above that folder.
 */
export const HTML_ASSET_SCHEME = "lcasset";

export type HtmlFolderAccess =
  | { status: "ready"; token: string }
  /** Android: only the file was granted. Picking its folder allows the rest. */
  | { status: "needsAccess"; folder: string | null }
  /** Android: the folder picked for the grant does not hold the file. */
  | { status: "wrongFolder" }
  | { status: "unavailable" };

export function openHtmlFolder(kind: DocSourceRef["kind"], location: string): Promise<HtmlFolderAccess> {
  return invoke("open_html_folder", { kind, location });
}

export function grantHtmlFolder(location: string): Promise<HtmlFolderAccess> {
  return invoke("grant_html_folder", { location });
}

/** The address relative names resolve against: `http://lcasset.localhost/<token>/` on Windows and Android. */
export function htmlAssetBase(token: string): string {
  return `${convertFileSrc("", HTML_ASSET_SCHEME)}${token}/`;
}
