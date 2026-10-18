import { useEffect, useState } from "react";
import { listRecoveryCopies, exportRecoveryCopy, type RecoveryCopy } from "../util/syncRecovery";
import { listAllPadSnapshots, getPadSnapshot, type PadSnapshotMeta } from "../util/padSnapshotStore";
import { restoreRetainedRecord, recoveryExportValue } from "../util/recoveryRestore";
import { restorePadSnapshotLocally } from "../util/artifactSnapshotRestore";
import { chooseRetainedFallbackBranch } from "../util/localBookStore";

/** The existing library's backup flow includes removed parents and recovered copies. */
export function RetainedCopies({ kind, onRestored }: { kind: "annotate" | "whiteboard"; onRestored: () => void }) {
  const [copies, setCopies] = useState<RecoveryCopy[]>([]);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    void Promise.all([listRecoveryCopies(), listAllPadSnapshots()]).then(([rows, backups]) => {
      if (!disposed) { setCopies(rows); setSnapshots(backups.filter(row => row.kind === kind)); }
    }).catch(cause => { if (!disposed) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [kind]);
  const perform = async (work: () => Promise<void>) => {
    setPending(true); setError(null);
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setPending(false); }
  };
  const exportValue = async (name: string, value: unknown) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(await recoveryExportValue(value), null, 2)], { type: "application/json" }));
    try { const link = document.createElement("a"); link.href = url; link.download = `${name.replace(/[^a-z0-9._-]/gi, "_")}-backup.json`; link.click(); }
    finally { URL.revokeObjectURL(url); }
  };
  return <>
    <p className="lc-muted">Retained copies stay on this device after restoration. Restoring keeps the current book as another retained copy.</p>
    <div className="lc-settings-choice lc-retained-copies">
    {copies.map(copy => <div className="lc-scratch-load-entry lc-library-entry" key={copy.id}>
      {(() => { const name = String(copy.record?.meta.label ?? copy.record?.meta.title ?? copy.record?.meta.name ?? "Retained local copy"); return <strong className="lc-library-subtitle" title={name}>{name}</strong>; })()}
      <span className="lc-retained-actions">
      <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={() => void perform(async () => exportValue(copy.bookId ?? "retained", await exportRecoveryCopy(copy.id)))}>Export copy</button>
      {(copy.type === "record" || copy.type === "conflict" && !!(copy.content as { metadata?: unknown; payload?: unknown } | undefined)?.metadata
        && !!(copy.content as { payload?: unknown }).payload) && <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={() => {
        if (selected !== copy.id) { setSelected(copy.id); return; }
        void perform(async () => { const result = await restoreRetainedRecord(copy.id);
          if (result.status === "stale") throw new Error("Changed on another device since your last sync. Sync first.");
          onRestored(); setNotice("The book was restored."); setSelected(null); });
      }}>{selected === copy.id ? "Confirm restore" : "Restore locally"}</button>}
      {copy.provenance?.source === "fallback-branch" && <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={() => {
        if (selected !== copy.id) { setSelected(copy.id); return; }
        void perform(async () => { await chooseRetainedFallbackBranch(copy.id); onRestored(); setNotice("The saved branch was chosen locally. Other copies are retained."); setSelected(null); });
      }}>{selected === copy.id ? "Confirm saved branch" : "Choose saved branch"}</button>}
      </span>
    </div>)}
    {snapshots.map(snapshot => <div className="lc-scratch-load-entry lc-library-entry" key={snapshot.snapshotId ?? `${snapshot.kind}:${snapshot.key}:${snapshot.tier}`}>
      <div className="lc-library-subtitle"><strong title={snapshot.name}>{snapshot.name}</strong><span className="lc-muted">{snapshot.tier} · {new Date(snapshot.writtenAt).toLocaleString()}</span></div>
      <span className="lc-retained-actions">
      <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={() => void perform(async () => {
        const row = await getPadSnapshot(snapshot.kind, snapshot.key, snapshot.tier, snapshot.snapshotId);
        if (!row) throw new Error("This backup cannot be read. Its stored copy was kept.");
        await exportValue(snapshot.name, row);
      })}>Export snapshot</button>
      <button type="button" className="lc-secondary lc-dialog-action" disabled={pending} onClick={() => {
        const id = snapshot.snapshotId ?? `${snapshot.kind}:${snapshot.key}:${snapshot.tier}`;
        if (selected !== id) { setSelected(id); return; }
        void perform(async () => {
          const row = await getPadSnapshot(snapshot.kind, snapshot.key, snapshot.tier, snapshot.snapshotId);
          if (!row) throw new Error("This backup cannot be read. Its stored copy was kept.");
          const result = await restorePadSnapshotLocally({ kind: snapshot.kind, id: snapshot.key }, row, row.artifactBundle);
          if (result.status === "stale") throw new Error("Changed on another device since your last sync. Sync first.");
          if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("lc-pad-hub", { detail: { kind: snapshot.kind, id: snapshot.key, op: "reload" } }));
          onRestored(); setNotice("The book was restored."); setSelected(null);
        });
      }}>{selected === (snapshot.snapshotId ?? `${snapshot.kind}:${snapshot.key}:${snapshot.tier}`) ? "Confirm restore" : "Restore locally"}</button>
      </span>
    </div>)}
    </div>
    {!copies.length && !snapshots.length && !error && <p className="lc-muted">No retained copies on this device.</p>}
    {error && <p className="lc-warning" role="alert">{error}</p>}{notice && <p className="lc-muted" role="status">{notice}</p>}
  </>;
}
