/**
 * Whether this device pushes itself to the hub on its own.
 *
 * Off is the default. Autosave answers "does this board write itself down";
 * this answers "does what it wrote travel". With it off nothing pings, pulls,
 * flushes, or kicks on a timer, and the autosave tick keeps its writes local —
 * IndexedDB always lands; only the pad PUT waits. Nothing here blocks an
 * explicit action: a manual sync walks its stages regardless of this switch.
 */

import { enumPref } from "./prefStore";
const KEY = "whiteboard.hubAutoSync.v1";

export type HubAutoSyncPref = "off" | "on";

export const HUB_AUTOSYNC_DEFAULT: HubAutoSyncPref = "off";

export const HUB_AUTOSYNC_CHOICES: ReadonlyArray<[HubAutoSyncPref, string, string]> = [
  [
    "off",
    "Off",
    "Nothing syncs until you tap Sync.",
  ],
  [
    "on",
    "On",
    "Syncs every 15 seconds, and when you open or save a document.",
  ],
];

export const HUB_AUTOSYNC_EVENT = "lc-hub-autosync";

const autosyncPref = enumPref<HubAutoSyncPref>({ key: KEY, values: ["off", "on"], fallback: HUB_AUTOSYNC_DEFAULT });

export function loadHubAutosyncPref(): HubAutoSyncPref {
  return autosyncPref.load();
}

/** Convenience for gates: true only when background hub traffic may run. */
export function loadHubAutosync(): boolean {
  return loadHubAutosyncPref() === "on";
}

export function saveHubAutosyncPref(value: HubAutoSyncPref): void {
  autosyncPref.save(value);
}
