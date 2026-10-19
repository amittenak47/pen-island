import { useIsPresent } from "motion/react";
import { DialogBackdrop, DialogPresence } from "../components/DialogMotion";
import {LibraryTrashRow} from "./LibraryTrashRow";
import { copyLine, useRetainedRows, VersionPicker, VersionShare } from "./RetainedRow";
import { exportVersionBackup, restoreVersion } from "./retainedActions";
import { deleteBookRetainedCopies, deleteRetainedCopies, formatBytes, trashRetainedCopy, versionBytes, type RetainedVersion } from "../util/retainedVersions";
import {useLibraryMorph} from "./useLibraryMorph";
/**
 * Scratchpad leave / entry menus — save, discard, load, or start blank.
 */

import { useEffect, useRef, useState } from "react";

import { LIBRARY_HOLD_MS } from "../util/gesture";
import { HoldButton } from "../components/HoldButton";
import { DocSyncLinkPair, type DocSyncLinkPairProps } from "../components/DocSyncLinkPair";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DialogFrame } from "../components/DialogFrame";
import { LibrarySearch } from "./LibrarySearch";
import { LibraryTimes } from "./LibraryTimes";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { DOUBLE_TAP_MS } from "../util/gesture";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import {
  deleteWhiteboardNotebook,
  WHITEBOARD_LIBRARY_EVENT,
  listWhiteboardNotebooks,
  listWhiteboardTrash,
  setWhiteboardNotebookLocked,
  type WhiteboardNotebookMeta,
} from "../util/whiteboardStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { PadNameField } from "./PadNameField";
import { TOMBSTONE_COPY, type DeletePadResult } from "../util/padSync";
import {
  listPadSnapshots,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshotMeta,
} from "../util/padSnapshotStore";
import "./whiteboardDialog.css";

export type ScratchLeaveChoice = "save" | "discard" | "load";
export type ScratchEntryChoice = "new" | "load" | "save" | "snapshot" | "import" | "export" | "export-png";

interface NotebookContextProps {
  notebookId?: string | null;
}

interface LeaveProps extends NotebookContextProps {
  mode: "leave";
  /**
   * Anything has been written since the notebook was opened or last saved.
   *
   * When nothing has, Discard has nothing to discard — see the button below.
   */
  dirty?: boolean;
  pending: boolean;
  exiting?: boolean;
  error: string | null;
  /** First explicit Save still needs a title. */
  needsName?: boolean;
  defaultName?: string;
  onChoose: (choice: ScratchLeaveChoice, notebookId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string, options?: { force?: boolean }) => void | DeletePadResult | Promise<void | DeletePadResult>;
}

interface EntryProps extends NotebookContextProps {
  /** The annotated export for a Load row: the current notebook (copyId null) or one retained copy. */
  onExportVersion?: (bookId: string, copyId: string | null) => void;
  /**
   * Before a copy of this book replaces it: save what is open, so the
   * version being replaced (kept as copy 1) includes the latest edits.
   */
  onPrepareRestore?: (bookId: string) => Promise<void>;
  /** A one-line notice outside the menu ("Saved …"). */
  onNotice?: (message: string) => void;
  /** [Sync] beside the open notebook's name: the tab's Sync. A notebook has no file to link. */
  syncPair?: DocSyncLinkPairProps | null;
  mode: "entry";
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When already inside a notebook, offer Save alongside New / Load. */
  allowSave?: boolean;
  dirty?: boolean;
  /** Notebook id — used to list rolling snapshots. */
  snapshotKey?: string | null;
  /** First explicit Save still needs a title. */
  needsName?: boolean;
  /** Prefill / placeholder for that first Save. */
  defaultName?: string;
  onChoose: (choice: ScratchEntryChoice, notebookId?: string, snapshotId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string, options?: { force?: boolean }) => void | DeletePadResult | Promise<void | DeletePadResult>;
  onRestoreTrash?: (id: string) => void | Promise<void>;
  onRename?: (id: string, title: string) => void | Promise<void>;
}

export type WhiteboardDialogProps = LeaveProps | EntryProps;

function NotebookIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M13 4H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-8M8 16l1-5L18 2a2 2 0 0 1 3 3l-9 9-4 2Z" />
  </svg>;
}

function MenuRowLabel({ label, description }: { label: string; description?: string }) {
  return <span className="lc-whiteboard-menu-label">
    {["New", "Open", "Pull", "Export", "Restore", "Save"].includes(label) && <svg className="lc-whiteboard-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {label === "New" ? <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 14h8M12 10v8" /> : label === "Open" ? <path d="M3 7V4h6l3 3h7v4M3 9h18l-3 11H3L1 9h2Z" /> : label === "Export" ? <path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5" /> : label === "Restore" ? <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" /> : label === "Save" ? <path d="M4 3h13l3 3v15H4V3Zm3 0v6h9V3M8 21v-8h8v8" /> : <path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5" />}
    </svg>}
    <span className="lc-whiteboard-row-copy"><strong>{label}</strong>{description && <span className="lc-muted">{description}</span>}</span>
  </span>;
}

function WhiteboardMenuRow({ label, description, disabled, onConfirm }: {
  label: string; description?: string; disabled?: boolean; onConfirm: () => void;
}) {
  return <HoldButton holdMs={LIBRARY_HOLD_MS} label={label} className="lc-hold-choice" disabled={disabled} onConfirm={onConfirm}>
    <MenuRowLabel label={label} description={description} />
  </HoldButton>;
}

export function WhiteboardDialog(props: WhiteboardDialogProps) {
  const present = useIsPresent();
  const [notebooks, setNotebooks] = useState<WhiteboardNotebookMeta[]>(() =>
    listWhiteboardNotebooks(),
  );
  const [trash, setTrash] = useState<WhiteboardNotebookMeta[]>(() => listWhiteboardTrash());
  const [section,setSection] = useState<"main"|"open"|"export">("main");
  const bodyRef = useRef<HTMLDivElement>(null);
  const [pickingLoad, setPickingLoad] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  /** A delete the hub refused because another device changed the notebook since the last sync. */
  const [staleId, setStaleId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [saveTitle, setSaveTitle] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [showTrash,setShowTrash] = useState(false);
  const [libraryQuery,setLibraryQuery] = useState("");
  const lastTapRef = useRef({ id: "", at: 0 });
  const backdropDown = useRef(false);
  const { tapArmed, arm } = useLibraryDeleteArm();
  /** A retained-copy action is running (restore, trash, export). */
  const [retainedBusy, setRetainedBusy] = useState(false);
  /** Restoring a copy the hub refused: another device changed the notebook. */
  const [restoreStale, setRestoreStale] = useState<{ bookId: string; version: RetainedVersion } | null>(null);

  useEffect(() => {
    const refresh = () => {
      setNotebooks(listWhiteboardNotebooks());
      setTrash(listWhiteboardTrash());
    };
    window.addEventListener(WHITEBOARD_LIBRARY_EVENT, refresh);
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(WHITEBOARD_LIBRARY_EVENT, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  useEffect(() => {
    setNotebooks(listWhiteboardNotebooks());
    setTrash(listWhiteboardTrash());
    setPickingLoad(false);
    setPickingSnapshots(false);
    setSaveTitle(null);
    setRenamingId(null);
    setLibraryQuery("");
  }, [props.mode]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && present && !props.pending && !props.exiting) props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, present]);

  const pending = Boolean(props.pending);
  const exiting = Boolean(props.exiting);
  const [storageError, setStorageError] = useState<string | null>(null);
  const error = storageError ?? props.error ?? null;
  const isLeave = props.mode === "leave";
  const allowSave = props.mode === "entry" && Boolean(props.allowSave);
  const snapshotKey = props.mode === "entry" ? props.snapshotKey ?? null : null;
  const locked = pending || exiting || !present || retainedBusy;
  const needsName = Boolean(props.needsName);
  const defaultName = props.defaultName?.trim() || "";
  const onRename = props.mode === "entry" ? props.onRename : undefined;
  const notebook = notebooks.find(row => row.id === (props.notebookId ?? snapshotKey));
  const contextTitle = isLeave || allowSave ? notebook?.title || defaultName : "";

  const matchesQuery = (entry: WhiteboardNotebookMeta) => entry.title.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase());

  const refreshList = () => {
    setNotebooks(listWhiteboardNotebooks());
    setTrash(listWhiteboardTrash());
  };

  const beginSave = () => {
    if (needsName && saveTitle === null) {
      setSaveTitle(defaultName);
      return;
    }
    if (!needsName) {
      props.onChoose("save");
      return;
    }
    const title = (saveTitle ?? defaultName).trim() || defaultName;
    props.onChoose("save", title || undefined);
  };

  const commitRename = async (id: string) => {
    const next = renameDraft.trim();
    setRenamingId(null);
    if (!next) return;
    await onRename?.(id, next);
    refreshList();
  };

  const tapLoadRow = (id: string, currentTitle: string) => {
    const now = Date.now();
    if (lastTapRef.current.id === id && now - lastTapRef.current.at < DOUBLE_TAP_MS) {
      lastTapRef.current = { id: "", at: 0 };
      setRenamingId(id);
      setRenameDraft(currentTitle);
      return;
    }
    lastTapRef.current = { id, at: now };
  };

  const openSnapshots = () => {
    setPickingSnapshots(true);
    if (!snapshotKey) {
      setSnapshots([]);
      return;
    }
    void listPadSnapshots("whiteboard", snapshotKey).then(setSnapshots);
  };

  const removeNotebook = (id: string) => {
    setRemoveError(null);
    setPendingId(id);
  };

  const confirmRemove = async (id: string, force = false) => {
    if (removing) return;
    setRemoving(true);
    try {
      if (props.onDelete) {
        const result = force ? await props.onDelete(id, { force: true }) : await props.onDelete(id);
        if (result?.status === "stale") {
          setPendingId(null);
          setStaleId(id);
          return;
        }
      }
      else await deleteWhiteboardNotebook(id);
      arm();
    } catch (cause) {
      setRemoveError(cause instanceof Error ? cause.message : "Could not remove this notebook. Try again.");
      return;
    } finally {
      setRemoving(false);
    }
    setPendingId(null);
    setStaleId(null);
    refreshList();
  };

  const morphRef = useLibraryMorph(`${section}:${pickingLoad}:${pickingSnapshots}:${saveTitle!==null}`);
  const archived = props.mode === "entry" ? trash : [];
  const retained = useRetainedRows("whiteboard", props.mode === "entry", notebooks, pickingLoad);
  const knownIds = new Set([...notebooks, ...trash].map(entry => entry.id));
  /* Copies whose notebook is gone wait in the trash as that notebook. */
  const orphans = [...retained.versions.entries()]
    .filter(([bookId]) => !knownIds.has(bookId))
    .map(([bookId, rows]) => ({ bookId, rows, newest: rows[0]! }))
    .filter(({ newest }) => newest.name.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()));
  const copiesDetail = (bookId: string) => {
    const rows = retained.versions.get(bookId) ?? [];
    const bytes = rows.reduce((sum, row) => sum + versionBytes(row, undefined), 0);
    const count = rows.length ? `${rows.length} retained ${rows.length === 1 ? "copy" : "copies"}` : "";
    return [count, bytes ? formatBytes(bytes) : ""].filter(Boolean).join(" · ") || undefined;
  };
  const retainedAction = async (work: () => Promise<void>) => {
    setRetainedBusy(true); setStorageError(null);
    try { await work(); }
    catch (cause) { setStorageError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRetainedBusy(false); retained.refresh(); }
  };
  /** Hold to load on a copy: it becomes the current version (the old current is kept as copy 1), then loads. */
  const openVersion = (bookId: string, version: RetainedVersion, force = false) => retainedAction(async () => {
    if (props.mode === "entry") await props.onPrepareRestore?.(bookId);
    if (await restoreVersion(version, force) === "stale") { setRestoreStale({ bookId, version }); return; }
    setRestoreStale(null); retained.pick(bookId, null); refreshList();
    if (props.mode === "entry") props.onChoose("load", bookId);
  });
  /** A copy's trash: the first hold marks it (!), the next deletes it for good. Its notebook is untouched. */
  const trashVersion = (bookId: string, version: RetainedVersion) => retainedAction(async () => {
    if (version.trashedAt) { await deleteRetainedCopies([version.id]); retained.pick(bookId, null); }
    else await trashRetainedCopy(version.id);
  });
  const backupVersion = (bookId: string, name: string, version: RetainedVersion | null) => retainedAction(async () => {
    const message = await exportVersionBackup("whiteboard", bookId, name, version);
    if (message && props.mode === "entry") props.onNotice?.(message);
  });

  return (
    <DialogBackdrop exiting={exiting}
      className={["lc-settings-backdrop"]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onPointerDownCapture={(event) => {
        // The menu can mount while its toolbar icon is still held. Releasing
        // that gesture onto the new backdrop must not count as dismissal.
        backdropDown.current = event.target === event.currentTarget;
      }}
      onPointerCancel={() => { backdropDown.current = false; }}
      onClick={(event) => {
        const startedOnBackdrop = backdropDown.current;
        backdropDown.current = false;
        if (!locked && shouldDismissBackdrop(startedOnBackdrop, event.target, event.currentTarget)) props.onCancel();
      }}
    >
      <DialogFrame ref={morphRef} exiting={exiting}
        className={`lc-attempt-modal lc-library-holds lc-library-menu lc-library-whiteboard lc-whiteboard-dialog`}
        ariaLabel={isLeave ? "Leave whiteboard?" : "Open whiteboard"}
        titleId="lc-whiteboard-dialog-title"
        title={isLeave ? "Leave whiteboard?" : pickingLoad ? "Load" : pickingSnapshots ? "Restore" : section === "open" ? "Open" : section === "export" ? "Export" : "Whiteboard"}
        subtitle="Notebooks"
        icon={<NotebookIcon />}
        mode="whiteboard"
        shape="blocky"
        onClose={props.onCancel}
        closeDisabled={locked}
      >
        {contextTitle && <div className="lc-dialog-context">
          <div className="lc-whiteboard-context">
            <NotebookIcon />
            <span className="lc-whiteboard-context-title" title={contextTitle}>{contextTitle}</span>
            {props.mode === "entry" && props.syncPair && <DocSyncLinkPair {...props.syncPair} link={null} disabled={locked || props.syncPair.disabled} />}
          </div>
        </div>}
        <div ref={bodyRef} className="lc-settings-body lc-dialog-body lc-scroll-pane">
          {pickingLoad && <LibrarySearch value={libraryQuery} onChange={setLibraryQuery} label="Search saved whiteboards" disabled={locked} showTrash={showTrash} onTrashChange={setShowTrash}/>}
          {pickingLoad && !(showTrash ? [] : notebooks).some(matchesQuery) && !archived.some(matchesQuery) && !orphans.length && <p className="lc-muted">No matching saved items.</p>}
          {error && <div className="lc-warning">{error}</div>}

          {saveTitle !== null ? (
            <div className="lc-settings-choice">
              <p className="lc-muted lc-whiteboard-name-hint">Hold to save.</p>
              <PadNameField
                value={saveTitle}
                placeholder={defaultName || "Untitled"}
                disabled={locked}
                autoFocus
                onChange={setSaveTitle}
                onSubmit={beginSave}
              />
              <HoldButton holdMs={LIBRARY_HOLD_MS}
                label="Save"
                className="lc-hold-choice"
                disabled={locked}
                onConfirm={beginSave}
                resetKey={error}
              >
                <strong>Save</strong>
                <span className="lc-muted">Keep this notebook in the library.</span>
              </HoldButton>
            </div>
          ) : pickingSnapshots ? (
            <div className="lc-settings-choice">
              {PAD_SNAPSHOT_TIERS.flatMap(tier => {
                const rows = snapshots.filter(snap => snap.tier === tier.id);
                return (rows.length ? rows : [undefined]).map(row => ({ tier, row }));
              }).map(({ tier, row }) => {
                return (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    key={row?.snapshotId ?? tier.id}
                    label={`Restore ${tier.label} snapshot`}
                    className="lc-hold-choice"
                    disabled={locked || !row}
                    onConfirm={() => {
                      if (props.mode !== "entry") return;
                      if (row?.snapshotId) props.onChoose("snapshot", tier.id, row.snapshotId);
                      else props.onChoose("snapshot", tier.id);
                    }}
                    resetKey={error}
                  >
                    <strong>{tier.label}</strong>
                    <span className="lc-muted">
                      {row
                        ? new Date(row.writtenAt).toLocaleString()
                        : "No snapshot yet — write on this notebook and wait for autosave."}
                    </span>
                  </HoldButton>
                );
              })}
            </div>
          ) : pickingLoad ? (
            <div className="lc-settings-choice">
              {notebooks.length === 0 && (
                <p className="lc-muted">No saved notebooks yet.</p>
              )}
              {/*
                The row *is* the entry: it carries the card's edge and fill,
                and the trash sits inside it rather than beside it. Two
                separate cards read as two separate things, and the one on the
                right had no label to say which notebook it would delete. A
                button cannot legally nest inside a button, so the entry's own
                surface is the row and the hold target fills what the trash
                leaves.
              */}
              {(showTrash ? [] : notebooks).filter(matchesQuery).map((entry) => {
                const copy = retained.pickedOf(entry.id);
                const size = copy ? versionBytes(copy, undefined) : retained.sizes[entry.id];
                return (
                <div key={entry.id} className={`lc-scratch-load-entry${copy ? " is-copy" : ""}${copy?.trashedAt ? " is-trashed-copy" : ""}`}>
                  {renamingId === entry.id ? (
                    <PadNameField
                      value={renameDraft}
                      disabled={locked}
                      autoFocus
                      onChange={setRenameDraft}
                      onSubmit={() => void commitRename(entry.id)}
                      onBlur={() => void commitRename(entry.id)}
                    />
                  ) : (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={copy ? `Restore copy ${copy.number} of ${entry.title}` : `Load ${entry.title}`}
                    className="lc-scratch-load-hold"
                    disabled={locked}
                    onTap={onRename && !copy ? () => tapLoadRow(entry.id, entry.title) : undefined}
                    onConfirm={() => copy ? void openVersion(entry.id, copy) : props.onChoose("load", entry.id)}
                    resetKey={error}
                  >
                    {/* Showing a copy: its own title, date and why it was kept. */}
                    <strong>{copy?.name || entry.title}</strong>
                    {copy
                      ? <span className="lc-muted lc-version-line">{copyLine(copy)}{copy.trashedAt ? " · in the trash (!)" : ""}</span>
                      : <>
                        <span className="lc-muted">
                          {entry.pageCount} page{entry.pageCount === 1 ? "" : "s"}
                        </span>
                        <LibraryTimes {...entry}/>
                      </>}
                    {size !== undefined && <span className="lc-muted lc-library-size">{formatBytes(size)}</span>}
                  </HoldButton>
                  )}
                  {renamingId !== entry.id && (
                  <>
                  <LibraryPadlock
                    name={entry.title}
                    locked={Boolean(entry.locked)}
                    disabled={locked}
                    onToggle={async () => {
                      try {
                        await setWhiteboardNotebookLocked(entry.id, !entry.locked);
                        refreshList();
                      } catch (cause) { setStorageError(cause instanceof Error ? cause.message : String(cause)); }
                    }}
                  />
                  <VersionPicker name={entry.title} versions={retained.versions.get(entry.id) ?? []} picked={copy}
                    currentBytes={retained.sizes[entry.id]} disabled={locked} onPick={id => retained.pick(entry.id, id)} />
                  <VersionShare name={copy ? `copy ${copy.number} of ${entry.title}` : entry.title} disabled={locked}
                    onAnnotated={() => { if (props.mode === "entry") props.onExportVersion?.(entry.id, copy?.id ?? null); }}
                    onBackup={() => void backupVersion(entry.id, entry.title, copy)} />
                  {!entry.locked && copy && (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={copy.trashedAt ? `Delete copy ${copy.number} of ${entry.title} for good` : `Move copy ${copy.number} of ${entry.title} to the trash`}
                    className={`lc-scratch-load-trash${copy.trashedAt ? " lc-hold-danger" : ""}`}
                    disabled={locked}
                    onConfirm={() => void trashVersion(entry.id, copy)}
                    resetKey={error}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="15"
                      height="15"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 6h16" />
                      <path d="M9 6V4h6v2" />
                      <path d="M6 6l1 14h10l1-14" />
                      <path d="M10 10v7M14 10v7" />
                    </svg>
                  </HoldButton>
                  )}
                  {!entry.locked && !copy && (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={`Delete ${entry.title}`}
                    className="lc-scratch-load-trash"
                    disabled={locked}
                    ariaLabel={
                      tapArmed
                        ? `Delete ${entry.title} — tap to delete`
                        : `Delete ${entry.title} — hold to delete`
                    }
                    onTap={tapArmed ? () => void confirmRemove(entry.id) : undefined}
                    onConfirm={() => {
                      if (tapArmed) void confirmRemove(entry.id);
                      else removeNotebook(entry.id);
                    }}
                    resetKey={error}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="15"
                      height="15"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.75"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M4 6h16" />
                      <path d="M9 6V4h6v2" />
                      <path d="M6 6l1 14h10l1-14" />
                      <path d="M10 10v7M14 10v7" />
                    </svg>
                  </HoldButton>
                  )}
                  </>
                  )}
                </div>
                );
              })}
              {(archived.some(matchesQuery) || orphans.length > 0) && (
                <section className="lc-library-trash-section" aria-label="Trash">
                  <h3>Trash</h3>
                  {/* A notebook in the trash has its copies with it; deleting it for good deletes them too. */}
                  {archived.filter(matchesQuery).map((entry) => (
                    <LibraryTrashRow key={`arch-${entry.id}`} name={entry.title} updatedAt={entry.updatedAt} disabled={locked}
                      detail={copiesDetail(entry.id)}
                      onRestore={async()=>{if(props.mode!=="entry")return;await props.onRestoreTrash?.(entry.id);refreshList();}}
                      onDelete={async()=>{await deleteWhiteboardNotebook(entry.id,true);await deleteBookRetainedCopies("whiteboard",entry.id);retained.refresh();refreshList();}}/>
                  ))}
                  {orphans.map(({ bookId, newest }) => (
                    <LibraryTrashRow key={`orphan-${bookId}`} name={newest.name || "Retained copy"} updatedAt={newest.editedAt} disabled={locked}
                      detail={`Only retained copies · ${copiesDetail(bookId)}`}
                      onRestore={async()=>{await openVersion(bookId, newest);}}
                      onDelete={async()=>{await deleteBookRetainedCopies("whiteboard",bookId);retained.refresh();}}/>
                  ))}
                </section>
              )}
            </div>
          ) : (
            <div className="lc-settings-choice">
              {isLeave ? (
                <div className="lc-document-menu">
                  <WhiteboardMenuRow label="Save" disabled={locked} onConfirm={beginSave} />
                  <WhiteboardMenuRow label="Discard" disabled={locked} onConfirm={() => props.onChoose("discard")} />
                </div>
              ) : (
                <>
                  {section === "main" && <>
                    <WhiteboardMenuRow label="New" description="Start a blank notebook" disabled={locked} onConfirm={() => props.onChoose("new")} />
                    <WhiteboardMenuRow label="Open" description="Pick a notebook from the library" disabled={locked} onConfirm={() => setSection("open")} />
                    {allowSave && <WhiteboardMenuRow label="Save" disabled={locked} onConfirm={beginSave} />}
                    <WhiteboardMenuRow label="Export" disabled={locked || !allowSave} onConfirm={() => setSection("export")} />
                    {allowSave && <WhiteboardMenuRow label="Restore" disabled={locked || !snapshotKey} onConfirm={openSnapshots} />}
                  </>}
                  {section === "open" && <>
                    <WhiteboardMenuRow label="Load" disabled={locked || (!notebooks.length && !archived.length && !orphans.length)} onConfirm={() => setPickingLoad(true)} />
                    <WhiteboardMenuRow label="Recents" disabled={locked || (!notebooks.length && !archived.length && !orphans.length)} onConfirm={() => setPickingLoad(true)} />
                    <WhiteboardMenuRow label="Import backup" disabled={locked} onConfirm={() => props.onChoose("import")} />
                  </>}
                  {section === "export" && <>
                    <WhiteboardMenuRow label="PNG image" disabled={locked} onConfirm={() => props.onChoose("export-png")} />
                    <WhiteboardMenuRow label="Whiteboard backup" disabled={locked} onConfirm={() => props.onChoose("export")} />
                  </>}
                </>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot lc-dialog-foot">
          <span className="lc-dialog-foot-spacer" aria-hidden="true" />
          {(section !== "main" || pickingLoad || pickingSnapshots || saveTitle !== null) && (
            <button
              type="button"
              className="lc-secondary lc-dialog-action"
              disabled={locked}
              onClick={() => {
                if (!pickingLoad && !pickingSnapshots && saveTitle === null) setSection("main");
                setPickingLoad(false);
                setPickingSnapshots(false);
                            setSaveTitle(null);
                setRenamingId(null);
              }}
            >
              Back
            </button>
          )}
          <button type="button" className="lc-secondary lc-dialog-action" disabled={locked} onClick={props.onCancel}>
            Cancel
          </button>
        </div>
      </DialogFrame>
      <DialogPresence>{pendingId && (
        <ConfirmDialog
          title="Remove this notebook?"
          message="It leaves the live library."
          detail={TOMBSTONE_COPY}
          confirmLabel="Delete"
          pending={removing}
          pendingLabel="Deleting…"
          error={removeError}
          onConfirm={() => void confirmRemove(pendingId)}
          onCancel={() => setPendingId(null)}
        />
      )}</DialogPresence>
      <DialogPresence>{staleId && (
        <ConfirmDialog
          title="Changed on another device"
          message="It changed since your last sync. Delete anyway?"
          confirmLabel="Delete anyway"
          pending={removing}
          pendingLabel="Deleting…"
          error={removeError}
          onConfirm={() => void confirmRemove(staleId, true)}
          onCancel={() => { setStaleId(null); setRemoveError(null); }}
        />
      )}</DialogPresence>
      <DialogPresence>{restoreStale && (
        <ConfirmDialog
          title="Changed on another device"
          message="It changed since your last sync. Restore this copy anyway? Their version is kept as a snapshot."
          confirmLabel="Restore anyway"
          pending={retainedBusy}
          pendingLabel="Restoring…"
          onConfirm={() => void openVersion(restoreStale.bookId, restoreStale.version, true)}
          onCancel={() => setRestoreStale(null)}
        />
      )}</DialogPresence>
    </DialogBackdrop>
  );
}
