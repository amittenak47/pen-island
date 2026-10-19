/** What the Recents rows do with a version: restore it, or export its backup file. */
import { captureBook } from "../util/bookSnapshot";
import { chooseRetainedFallbackBranch } from "../util/localBookStore";
import { recoveryExportValue, restoreRetainedRecord } from "../util/recoveryRestore";
import type { RetainedKind, RetainedVersion } from "../util/retainedVersions";
import { saveDocumentExport } from "../util/saveDocumentExport";
import { exportRecoveryCopy } from "../util/syncRecovery";

/**
 * Make a copy the current version. The version it replaces is kept as a new
 * copy (so it becomes 1 and the rest shift forward). "stale": the hub has a
 * newer version from another device; ask, then call again with `force`.
 */
export async function restoreVersion(version: RetainedVersion, force = false): Promise<"restored" | "stale"> {
  if (version.restore === "branch") { await chooseRetainedFallbackBranch(version.id); return "restored"; }
  const result = force ? await restoreRetainedRecord(version.id, { force: true }) : await restoreRetainedRecord(version.id);
  return result.status === "stale" ? "stale" : "restored";
}

function fileName(name: string, version: RetainedVersion | null): string {
  const base = (name || "book").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-z0-9._ -]/gi, "_").trim() || "book";
  return `${base}${version ? `-copy-${version.number}` : ""}-backup.json`;
}

/**
 * The backup file for what a row shows: the whole copy, or the current book
 * as stored here. Binary parts are written out, not dropped. Returns what the
 * save said ("Saved to …"), or null when the reader cancelled.
 */
export async function exportVersionBackup(kind: RetainedKind, bookId: string, name: string, version: RetainedVersion | null): Promise<string | null> {
  const value = version ? await exportRecoveryCopy(version.id) : await captureBook({ kind, id: bookId });
  const json = JSON.stringify(await recoveryExportValue(value), null, 2) + "\n";
  const message = await saveDocumentExport({ name: fileName(name, version), blob: new Blob([json], { type: "application/json" }) },
    new AbortController().signal, () => {});
  return message ?? null;
}
