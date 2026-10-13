/**
 * Whether this device pushes itself to the hub on its own.
 *
 * Off is the default. Autosave answers "does this board write itself down";
 * this answers "does what it wrote travel". With it off nothing pings, pulls,
 * flushes, or kicks on a timer, and the autosave tick keeps its writes local —
 * IndexedDB always lands; only the pad PUT waits. Nothing here blocks an
 * explicit action: a manual sync walks its stages regardless of this switch.
 */

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

function isPref(value: unknown): value is HubAutoSyncPref {
  return value === "off" || value === "on";
}

export function loadHubAutosyncPref(): HubAutoSyncPref {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return HUB_AUTOSYNC_DEFAULT;
    return isPref(raw) ? raw : HUB_AUTOSYNC_DEFAULT;
  } catch {
    return HUB_AUTOSYNC_DEFAULT;
  }
}

/** Convenience for gates: true only when background hub traffic may run. */
export function loadHubAutosync(): boolean {
  return loadHubAutosyncPref() === "on";
}

export function saveHubAutosyncPref(value: HubAutoSyncPref): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    /* private browsing */
  }
}
