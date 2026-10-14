/**
 * Device-local: show the stacked notification cards (top-left notices such
 * as "Linked …" or "Desktop app is offline …"). On by default. Turning it off
 * silences the cards only; in-place status (the Sync overlay, dialogs, error
 * banners) still shows.
 */

import { boolPref } from "./prefStore";
const KEY = "whiteboard.notificationCards";

const cardsPref = boolPref({ key: KEY, fallback: true });

export function loadNotificationCards(): boolean {
  return cardsPref.load();
}

export function saveNotificationCards(on: boolean): void {
  cardsPref.save(on);
}
