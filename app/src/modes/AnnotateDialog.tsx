import { motion, useIsPresent, useReducedMotion } from "motion/react";
import { DialogBackdrop, DialogPresence } from "../components/DialogMotion";
import {LibraryTrashRow} from "./LibraryTrashRow";
import { copyLine, useRetainedRows, VersionFace, VersionPicker, VersionShare } from "./RetainedRow";
import { exportVersionBackup, restoreVersion } from "./retainedActions";
import { deleteBookRetainedCopies, deleteRetainedCopies, formatBytes, trashRetainedCopy, versionBytes, type RetainedVersion } from "../util/retainedVersions";
import {useLibraryMorph} from "./useLibraryMorph";
/**
 * Markdown Ink entry / leave menus.
 *
 * Deliberately the same dialog as {@link WhiteboardDialog} down to the class
 * names: the two modes are the same shape of thing — a local surface with a
 * library, saved or discarded on the way out — and a writer who has learned one
 * should not have to learn the other. What differs is only the nouns: documents
 * rather than notebooks, and Open rather than New.
 */

import { useEffect, useId, useRef, useState } from "react";

import { LIBRARY_HOLD_MS } from "../util/gesture";
import { HoldButton } from "../components/HoldButton";
import { DocSyncLinkPair, LinkIcon, type DocSyncLinkPairProps } from "../components/DocSyncLinkPair";
import { DialogFrame } from "../components/DialogFrame";
import "./annotateDialog.css";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { listDocSources } from "../util/docSourceStore";
import { checkDocSource, linkDocSource, justLinkDocSource, updateDocFromSource, DOC_SOURCE_CHECKED_EVENT } from "../util/docSourceUpdate";
import { nativeSourcePickerAvailable, pickSourceFolder, listSourceFolder } from "../util/docSourceNative";
import { matchDocSourceFolder, type FolderSourceMatch } from "../util/docSourceFolder";
import { useLibraryDeleteArm } from "../util/armedDelete";
import { DOUBLE_TAP_MS } from "../util/gesture";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import {
  annotateDocLabel,
  ANNOTATE_LIBRARY_EVENT,
  trashAnnotateDoc,
  deleteAnnotateDoc,
  listAnnotateDocs,
  listAnnotateTrash,
  setAnnotateDocLocked,
  type AnnotateDocMeta,
} from "../util/annotateStore";
import { LibraryPadlock } from "./LibraryPadlock";
import { PadNameField } from "./PadNameField";
import { LibraryMenuRow, LibrarySearch } from "./LibrarySearch";
import { LibraryTimes } from "./LibraryTimes";
import { TOMBSTONE_COPY, type DeletePadResult } from "../util/padSync";
import {
  listPadSnapshots,
  PAD_SNAPSHOT_TIERS,
  type PadSnapshotMeta,
} from "../util/padSnapshotStore";

export type MdInkLeaveChoice = "save" | "discard";
export type MdInkEntryChoice =
  | "open"
  | "recent"
  | "save"
  | "export"
  | "export-document"
  | "export-pdf"
  | "import"
  | "snapshot"
  /** Start a second set of annotations on the file already open. */
  | "fork"
  /** Write a new markdown note in the app, rather than opening one. */
  | "new"
  /** Open a blank web pad — the globe's own "new". */
  | "page";

/**
 * Which library the reader is standing in.
 *
 * Web pads are annotate documents — same store, same marks, same Save, Recent,
 * Export and Import — so this is one dialog, not two. What differs is every
 * word in it: holding the globe used to offer "Pick a .md, source file, .pdf or
 * .epub to annotate", which is true of the machinery and useless to someone who
 * pressed the browser button.
 */
export type AnnotateDialogKind = "document" | "web";

interface LeaveProps {
  mode: "leave";
  /**
   * Anything has been annotated since the document was opened or last saved.
   *
   * When nothing has, Discard has nothing to discard — see the button below.
   */
  dirty?: boolean;
  /** Name of the document being annotated, for the prompt. */
  docName: string;
  docId?: string | null;
  pending: boolean;
  exiting?: boolean;
  error: string | null;
  needsName?: boolean;
  defaultName?: string;
  onChoose: (choice: MdInkLeaveChoice, name?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string, options?: { force?: boolean }) => void | DeletePadResult | Promise<void | DeletePadResult>;
  /** Same as the entry dialog — web leave still offers the first-Save name step. */
  kind?: AnnotateDialogKind;
}

interface EntryProps {
  /** [Sync | Link] beside the open document's name: the tab's Sync and its linked file. */
  syncPair?: DocSyncLinkPairProps | null;
  /**
   * The annotated document for a Recents row: the current version (copyId
   * null) or one retained copy, exported without changing the library.
   */
  onExportVersion?: (bookId: string, copyId: string | null) => void;
  /**
   * Before a copy of this book replaces it: save what is open, so the
   * version being replaced (kept as copy 1) includes the latest edits.
   */
  onPrepareRestore?: (bookId: string) => Promise<void>;
  onNotice?: (message: string) => void;
  mode: "entry";
  /** Wording and choices. Defaults to the document library. */
  kind?: AnnotateDialogKind;
  pending?: boolean;
  exiting?: boolean;
  error?: string | null;
  /** When a document is already open, offer Save alongside Open / Recent. */
  allowSave?: boolean;
  docName?: string;
  dirty?: boolean;
  /** Pad id of the open document — used to list rolling snapshots. */
  snapshotKey?: string | null;
  docType?: string;
  needsName?: boolean;
  defaultName?: string;
  onChoose: (choice: MdInkEntryChoice, docId?: string, snapshotId?: string) => void;
  onCancel: () => void;
  onDelete?: (id: string, options?: { force?: boolean }) => void | DeletePadResult | Promise<void | DeletePadResult>;
  onRestoreTrash?: (id: string) => void | Promise<void>;
  onRename?: (id: string, title: string) => void | Promise<void>;
}

export type AnnotateDialogProps = LeaveProps | EntryProps;

type SourceUpdateCandidate = {
  doc: AnnotateDocMeta;
  content: Awaited<ReturnType<typeof checkDocSource>>;
};

function DocumentIcon({ web = false }: { web?: boolean }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {web ? <><circle cx="12" cy="12" r="9" /><ellipse cx="12" cy="12" rx="4" ry="9" /><path d="M3 12h18" /></> : <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h7M8 16h5" />}
  </svg>;
}

function MenuRowLabel({ label, description }: { label: string; description?: string }) {
  return <span className="lc-annotate-menu-label">
    <svg className="lc-annotate-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {label === "Save" ? <path d="M4 3h13l3 3v15H4V3Zm3 0v6h9V3M8 21v-8h8v8" /> : label === "Open" ? <path d="M3 7V4h6l3 3h7v4M3 9h18l-3 11H3L1 9h2Z" /> : label === "Pull" ? <path d="M12 3v13m-5-5 5 5 5-5M3 16v5h18v-5" /> : label === "Export" ? <path d="M12 16V3m-5 5 5-5 5 5M3 16v5h18v-5" /> : label === "New" ? <path d="M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 14h8M12 10v8" /> : <path d="M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2" />}
    </svg>
    <span className="lc-annotate-row-copy"><strong>{label}</strong>{description && <span className="lc-muted">{description}</span>}</span>
  </span>;
}

function MainMenuRow({ label, description, disabled, onConfirm }: {
  label: string; description?: string; disabled?: boolean; onConfirm: () => void;
}) {
  return <HoldButton holdMs={LIBRARY_HOLD_MS} label={label} className="lc-hold-choice" disabled={disabled} onConfirm={onConfirm}>
    <MenuRowLabel label={label} description={description} />
  </HoldButton>;
}

export function AnnotateDialog(props: AnnotateDialogProps) {
  const present = useIsPresent();
  const reducedMotion = useReducedMotion();
  const sourceTitleId = useId();
  const folderTitleId = useId();
  const [docs, setDocs] = useState<AnnotateDocMeta[]>(() => listAnnotateDocs());
  const [trash, setTrash] = useState<AnnotateDocMeta[]>(() => listAnnotateTrash());
  const [pickingRecent, setPickingRecent] = useState(false);
  const [pickingSnapshots, setPickingSnapshots] = useState(false);
  const [section, setSection] = useState<"main" | "open" | "new" | "sets" | "export">("main");
  const bodyRef = useRef<HTMLDivElement>(null);
  const backdropDown = useRef(false);
  /** Naming a new note. Null when the dialog is not on that step. */
  const [newTitle, setNewTitle] = useState<string | null>(null);
  const [saveTitle, setSaveTitle] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<PadSnapshotMeta[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  /** A delete the hub refused because another device changed the book since the last sync. */
  const [staleId, setStaleId] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const removingRef = useRef<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [libraryFilters,setLibraryFilters] = useState<string[]>([]);
  const [showTrash,setShowTrash] = useState(false);
  const [libraryQuery,setLibraryQuery] = useState("");
  const [sourceCandidates, setSourceCandidates] = useState<SourceUpdateCandidate[] | null>(null);
  const [sourceSelected, setSourceSelected] = useState<string[]>([]);
  const [sourceChecking, setSourceChecking] = useState(false);
  const [sourceUpdating, setSourceUpdating] = useState(false);
  const [sourceProgress, setSourceProgress] = useState("");
  const [sourceFailures, setSourceFailures] = useState<string[]>([]);
  const [sourceNotice, setSourceNotice] = useState<string | null>(null);
  const [folderMatches, setFolderMatches] = useState<FolderSourceMatch[] | null>(null);
  const [folderSelected, setFolderSelected] = useState<string[]>([]);
  const [folderDuplicates, setFolderDuplicates] = useState(0);
  const [folderLinked, setFolderLinked] = useState<number | null>(null);
  const sourceRunning = useRef(false);
  const sourceBusy = sourceChecking || sourceUpdating;
  const lastTapRef = useRef({ id: "", at: 0 });
  const { tapArmed, arm } = useLibraryDeleteArm();
  /** A retained-copy action is running (restore, trash, export). */
  const [retainedBusy, setRetainedBusy] = useState(false);
  /** Restoring a copy the hub refused: another device changed the book. */
  const [restoreStale, setRestoreStale] = useState<{ bookId: string; version: RetainedVersion } | null>(null);

  useEffect(() => {
    const refresh = () => {
      const live = listAnnotateDocs();
      setDocs(live);
      setTrash(listAnnotateTrash());
      if (removingRef.current && !live.some((row) => row.id === removingRef.current)) {
        removingRef.current = null;
        setRemoving(false);
        arm();
      }
      // The local index commits before hub sync finishes.
      setPendingId((id) => id && live.some((row) => row.id === id) ? id : null);
    };
    window.addEventListener(ANNOTATE_LIBRARY_EVENT, refresh);
    return () => window.removeEventListener(ANNOTATE_LIBRARY_EVENT, refresh);
  }, [arm]);

  useEffect(() => {
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
    setPickingRecent(false);
    setPickingSnapshots(false);
    setSection("main");
    setSaveTitle(null);
    setRenamingId(null);
    setLibraryQuery("");
    setSourceCandidates(null);
    setFolderMatches(null);
    setFolderLinked(null);
    setSourceFailures([]);
    setSourceNotice(null);
  }, [props.mode]);

  const snapshotKey = props.mode === "entry" ? props.snapshotKey ?? null : null;

  const openSnapshots = () => {
    setPickingSnapshots(true);
    if (!snapshotKey) {
      setSnapshots([]);
      return;
    }
    void listPadSnapshots("annotate", snapshotKey).then(setSnapshots);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !present || props.pending || props.exiting || sourceBusy) return;
      if (sourceCandidates !== null) closeSourceCandidates();
      else if (folderMatches !== null) setFolderMatches(null);
      else props.onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [props, present, sourceBusy, sourceCandidates, folderMatches, folderLinked]);

  const pending = Boolean(props.pending);
  const exiting = Boolean(props.exiting);
  const [storageError, setStorageError] = useState<string | null>(null);
  const error = storageError ?? props.error ?? null;
  const isLeave = props.mode === "leave";
  // Only the entry dialog lists documents — leaving one is a save/discard
  // decision about the ink in hand, not a moment to go opening another.
  const entry = props.mode === "entry" ? props : null;
  const allowSave = Boolean(entry?.allowSave);
  const isWeb = props.kind === "web";
  const locked = pending || exiting || !present || sourceBusy || retainedBusy || sourceCandidates !== null || folderMatches !== null;
  const needsName = Boolean(props.needsName);
  const defaultName = props.defaultName?.trim() || "";
  const onRename = entry?.onRename;

  const currentDoc = docs.find((doc) => doc.id === snapshotKey);
  const contextCandidate = isLeave ? docs.find((doc) => doc.id === props.docId) : currentDoc;
  const contextDoc = contextCandidate && (contextCandidate.docType === "web") === isWeb ? contextCandidate : undefined;
  const hasContext = isLeave || (allowSave && ((entry?.docType ?? contextDoc?.docType) === "web") === isWeb);
  const contextName = hasContext ? props.docName?.trim() || contextDoc?.name || "" : "";
  const visibleDocs = docs.filter((doc) =>
    (isWeb ? doc.docType === "web" : doc.docType !== "web") &&
    (section !== "sets" || (currentDoc && doc.hash === currentDoc.hash)),
  );
  const visibleTrash = (props.mode === "entry" ? trash : []).filter((doc) =>
    (isWeb ? doc.docType === "web" : doc.docType !== "web") &&
    (section !== "sets" || (currentDoc && doc.hash === currentDoc.hash)),
  );
  const sources = listDocSources();
  const sourceDocs = docs.filter(doc => sources[doc.id]);

  const toggleFilter = (kind: string) => setLibraryFilters(current => current.includes(kind) ? current.filter(item => item !== kind) : [...current, kind]);
  const matchesQuery = (doc: AnnotateDocMeta) => (libraryFilters.length === 0 || libraryFilters.includes(doc.docType)) && `${doc.name} ${doc.label ?? ""}`.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase());

  const refreshList = () => {
    setDocs(listAnnotateDocs());
    setTrash(listAnnotateTrash());
  };

  const announceSource = (message: string) => {
    if (entry?.onNotice) entry.onNotice(message);
    else setSourceNotice(message);
  };

  const announceFolder = (linked: number, updated = 0, unplaced = 0, failures = 0) => announceSource([
    linked ? `Linked ${linked} ${linked === 1 ? "document" : "documents"}.` : "",
    updated ? `${updated} ${updated === 1 ? "was" : "were"} updated.` : "",
    unplaced ? `${unplaced} ${unplaced === 1 ? "annotation couldn't" : "annotations couldn't"} be placed and ${unplaced === 1 ? "stays" : "stay"} in the previous version (Recents → retained copies).` : "",
    failures ? `${failures} ${failures === 1 ? "file couldn't" : "files couldn't"} be linked.` : "",
  ].filter(Boolean).join(" "));

  const pickFolderSources = async () => {
    if (sourceRunning.current) return;
    sourceRunning.current = true;
    setSourceChecking(true);
    setSourceNotice(null);
    setSourceFailures([]);
    setSourceProgress("Finding matching files…");
    try {
      const folder = await pickSourceFolder();
      if (!folder) return;
      const entries = await listSourceFolder(folder.kind, folder.location);
      const result = await matchDocSourceFolder(listAnnotateDocs(), entries);
      setSourceFailures(result.failures);
      setFolderDuplicates(result.duplicateNames);
      if (!result.matches.length) {
        announceSource("No documents in this folder match your library.");
        return;
      }
      setFolderMatches(result.matches);
      setFolderSelected(result.matches.map(row => row.doc.id));
    } catch (cause) {
      announceSource(cause instanceof Error ? cause.message : String(cause));
    } finally {
      sourceRunning.current = false;
      setSourceChecking(false);
      setSourceProgress("");
    }
  };

  const linkFolderSources = async () => {
    if (sourceRunning.current || !folderMatches) return;
    const selected = folderMatches.filter(row => folderSelected.includes(row.doc.id));
    if (!selected.length) return;
    sourceRunning.current = true;
    setSourceUpdating(true);
    let linked = 0;
    const differs: SourceUpdateCandidate[] = [];
    const failures: string[] = [];
    try {
      for (const [index, row] of selected.entries()) {
        setSourceProgress(`Linking ${index + 1} of ${selected.length}: ${row.doc.name}`);
        try {
          const result = await linkDocSource(row.doc.id, row.entry);
          if (result.status === "linked") {
            linked++;
            window.dispatchEvent(new CustomEvent(DOC_SOURCE_CHECKED_EVENT, { detail: { id: row.doc.id, newer: false } }));
          } else differs.push({ doc: row.doc, content: result.content });
        } catch (cause) {
          failures.push(`${row.doc.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      setFolderMatches(null);
      setSourceFailures([...sourceFailures, ...failures]);
      if (differs.length) {
        setFolderLinked(linked);
        setSourceCandidates(differs);
        setSourceSelected(differs.map(row => row.doc.id));
      } else announceFolder(linked, 0, 0, sourceFailures.length + failures.length);
    } finally {
      sourceRunning.current = false;
      setSourceUpdating(false);
      setSourceProgress("");
    }
  };

  function closeSourceCandidates() {
    if (sourceRunning.current) return;
    if (folderLinked !== null && (folderLinked || sourceFailures.length)) announceFolder(folderLinked, 0, 0, sourceFailures.length);
    setSourceCandidates(null);
    setFolderLinked(null);
  }

  const checkSources = async () => {
    if (sourceRunning.current) return;
    sourceRunning.current = true;
    setSourceChecking(true);
    setSourceNotice(null);
    setSourceFailures([]);
    setFolderLinked(null);
    setSourceProgress(`Checking 0 of ${sourceDocs.length} files…`);
    const found: (SourceUpdateCandidate | undefined)[] = new Array(sourceDocs.length);
    const failures: string[] = [];
    let next = 0;
    let completed = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(3, sourceDocs.length) }, async () => {
        while (next < sourceDocs.length) {
          const index = next++;
          const doc = sourceDocs[index]!;
          try {
            const content = await checkDocSource(doc.id);
            window.dispatchEvent(new CustomEvent(DOC_SOURCE_CHECKED_EVENT, { detail: { id: doc.id, newer: content.status === "newer" } }));
            if (content.status === "newer") found[index] = { doc, content };
          } catch (cause) {
            failures.push(`${doc.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
          } finally {
            setSourceProgress(`Checking ${++completed} of ${sourceDocs.length} files…`);
          }
        }
      }));
      const newer = found.filter((row): row is SourceUpdateCandidate => Boolean(row));
      setSourceFailures(failures);
      if (newer.length) {
        setSourceCandidates(newer);
        setSourceSelected(newer.map(row => row.doc.id));
      } else announceSource(failures.length ? `${failures.length} files couldn't be checked.` : "Everything is up to date");
    } finally {
      sourceRunning.current = false;
      setSourceChecking(false);
      setSourceProgress("");
    }
  };

  const updateSources = async () => {
    if (sourceRunning.current || !sourceCandidates) return;
    const selected = sourceCandidates.filter(row => sourceSelected.includes(row.doc.id));
    if (!selected.length && folderLinked === null) return;
    sourceRunning.current = true;
    setSourceUpdating(true);
    let updated = 0;
    let unplaced = 0;
    let linked = folderLinked ?? 0;
    const failures: string[] = [];
    try {
      if (folderLinked !== null) {
        for (const row of sourceCandidates.filter(row => !sourceSelected.includes(row.doc.id))) {
          try {
            justLinkDocSource(row.doc.id, row.content.ref!);
            linked++;
            window.dispatchEvent(new CustomEvent(DOC_SOURCE_CHECKED_EVENT, { detail: { id: row.doc.id, newer: true } }));
          } catch (cause) {
            failures.push(`${row.doc.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
          }
        }
      }
      for (const [index, row] of selected.entries()) {
        setSourceProgress(`Updating ${index + 1} of ${selected.length}: ${row.doc.name}`);
        try {
          const result = await updateDocFromSource(row.doc.id, row.content);
          updated++;
          if (folderLinked !== null) linked++;
          unplaced += result.unplaced.length;
          window.dispatchEvent(new CustomEvent(DOC_SOURCE_CHECKED_EVENT, { detail: { id: row.doc.id, newer: false } }));
        } catch (cause) {
          failures.push(`${row.doc.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
      }
      setSourceCandidates(null);
      setFolderLinked(null);
      setSourceFailures([...sourceFailures, ...failures]);
      refreshList();
      // Only what happened: "0 updates failed" reads like a problem.
      if (folderLinked !== null) announceFolder(linked, updated, unplaced, sourceFailures.length + failures.length);
      else announceSource([
        `Updated ${updated} ${updated === 1 ? "document" : "documents"}.`,
        unplaced ? `${unplaced} ${unplaced === 1 ? "annotation couldn't" : "annotations couldn't"} be placed and ${unplaced === 1 ? "stays" : "stay"} in the previous version (Recents → retained copies).` : "",
        failures.length ? `${failures.length} ${failures.length === 1 ? "update failed" : "updates failed"}.` : "",
        sourceFailures.length ? `${sourceFailures.length} ${sourceFailures.length === 1 ? "file couldn't" : "files couldn't"} be checked.` : "",
      ].filter(Boolean).join(" "));
    } finally {
      sourceRunning.current = false;
      setSourceUpdating(false);
      setSourceProgress("");
    }
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

  const removeDoc = (id: string) => {
    setRemoveError(null);
    setPendingId(id);
  };

  const confirmRemove = async (id: string, force = false) => {
    if (removingRef.current) return;
    removingRef.current = id;
    setRemoving(true);
    setRemoveError(null);
    try {
      if (props.onDelete) {
        const result = force ? await props.onDelete(id, { force: true }) : await props.onDelete(id);
        if (result?.status === "stale") {
          setPendingId((pending) => pending === id ? null : pending);
          setStaleId(id);
          return;
        }
      }
      else await trashAnnotateDoc(id);
      if (listAnnotateDocs().some((row) => row.id === id)) {
        throw new Error("This document could not be removed. It may be locked.");
      }
      arm();
      setPendingId((pending) => pending === id ? null : pending);
      setStaleId((stale) => stale === id ? null : stale);
    } catch (cause) {
      if (removingRef.current === id) {
        setRemoveError(cause instanceof Error ? cause.message : "Could not remove this document. Try again.");
      }
    } finally {
      if (removingRef.current === id) {
        removingRef.current = null;
        setRemoving(false);
      }
      refreshList();
    }
  };

  const morphRef = useLibraryMorph(`${section}:${pickingRecent}:${pickingSnapshots}:${newTitle!==null}:${saveTitle!==null}`);
  const archived = visibleTrash;
  const retained = useRetainedRows("annotate", props.mode === "entry", visibleDocs, pickingRecent);
  const knownIds = new Set([...docs, ...trash].map(doc => doc.id));
  /*
   * Copies whose book is gone (deleted for good earlier, or never opened
   * here): they wait in the trash as that book, to restore or delete.
   */
  const orphans = [...retained.versions.entries()]
    .filter(([bookId, rows]) => !knownIds.has(bookId) && (rows[0]!.docType === "web") === isWeb)
    .map(([bookId, rows]) => ({ bookId, rows, newest: rows[0]! }))
    .filter(({ newest }) => `${newest.name} ${newest.label}`.toLocaleLowerCase().includes(libraryQuery.trim().toLocaleLowerCase()));
  const copiesDetail = (bookId: string, hash?: string) => {
    const rows = retained.versions.get(bookId) ?? [];
    const bytes = rows.reduce((sum, row) => sum + versionBytes(row, hash), 0);
    const count = rows.length ? `${rows.length} retained ${rows.length === 1 ? "copy" : "copies"}` : "";
    return [count, bytes ? formatBytes(bytes) : ""].filter(Boolean).join(" · ") || undefined;
  };
  const retainedAction = async (work: () => Promise<void>) => {
    setRetainedBusy(true); setStorageError(null);
    try { await work(); }
    catch (cause) { setStorageError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setRetainedBusy(false); retained.refresh(); }
  };
  /** Hold to open on a copy: it becomes the current version (the old current is kept as copy 1), then opens. */
  const openVersion = (bookId: string, version: RetainedVersion, force = false) => retainedAction(async () => {
    await entry?.onPrepareRestore?.(bookId);
    if (await restoreVersion(version, force) === "stale") { setRestoreStale({ bookId, version }); return; }
    setRestoreStale(null); retained.pick(bookId, null); refreshList();
    entry?.onChoose("recent", bookId);
  });
  /** A copy's trash: the first hold marks it (!), the next deletes it for good. Its book is untouched. */
  const trashVersion = (bookId: string, version: RetainedVersion) => retainedAction(async () => {
    if (version.trashedAt) { await deleteRetainedCopies([version.id]); retained.pick(bookId, null); }
    else await trashRetainedCopy(version.id);
  });
  const backupVersion = (bookId: string, name: string, version: RetainedVersion | null) => retainedAction(async () => {
    const message = await exportVersionBackup("annotate", bookId, name, version);
    if (message) announceSource(message);
  });

  return (
    <DialogBackdrop exiting={exiting}
      className={["lc-settings-backdrop"]
        .filter(Boolean)
        .join(" ")}
      role="presentation"
      onPointerDownCapture={(event) => { backdropDown.current = event.target === event.currentTarget; }}
      onPointerCancel={() => { backdropDown.current = false; }}
      onClick={(event) => {
        const started = backdropDown.current;
        backdropDown.current = false;
        if (!locked && shouldDismissBackdrop(started, event.target, event.currentTarget)) props.onCancel();
      }}
    >
      <DialogFrame ref={morphRef} exiting={exiting}
        inert={sourceCandidates !== null || folderMatches !== null}
        className={`lc-attempt-modal lc-library-holds lc-library-menu lc-annotate-dialog ${isWeb ? "lc-library-web" : "lc-library-annotate"}`}
        titleId="lc-annotate-dialog-title"
        title={isLeave ? "Leave document?" : section === "open" && !pickingRecent ? "Open" : section === "new" ? "New" : section === "export" ? "Export" : section === "sets" ? "Annotations" : pickingRecent ? "Recents" : isWeb ? "Web" : "Annotate"}
        subtitle={isWeb ? "Write onto a page snapshot" : "Ink for this document"}
        icon={<DocumentIcon web={isWeb} />}
        mode={isWeb ? "browse" : "annotate"}
        shape="blocky"
        ariaLabel={isLeave ? "Leave document?" : isWeb ? "Web pad" : "Document pad"}
        onClose={props.onCancel}
        closeDisabled={locked}
      >
        {contextName && <div className="lc-dialog-context"><div className="lc-annotate-context">
          <DocumentIcon web={isWeb} /><span className="lc-annotate-context-title" title={contextName}>{contextName}</span>
          {entry?.syncPair && <DocSyncLinkPair {...entry.syncPair} disabled={locked || entry.syncPair.disabled} />}
        </div></div>}
        <div ref={bodyRef} className="lc-settings-body lc-dialog-body lc-scroll-pane">
          {(saveTitle !== null || newTitle !== null) && <p className="lc-muted">
            {saveTitle !== null
              ? "Name this pad. Hold Save to keep the suggested name."
              : "Name the note. It lives in this app — there is no file on disk until you export it."}
          </p>}
          {pickingRecent && <LibrarySearch value={libraryQuery} onChange={setLibraryQuery} label={isWeb ? "Search saved pages" : "Search saved documents"} disabled={locked} filters={libraryFilters} onToggleFilter={toggleFilter} kinds={isWeb ? [] : ["pdf","markdown","epub"]} showTrash={showTrash} onTrashChange={setShowTrash}/>}
          {pickingRecent && !(showTrash ? [] : visibleDocs).some(matchesQuery) && !archived.some(matchesQuery) && !orphans.length && <p className="lc-muted">No matching saved items.</p>}
          {error && <div className="lc-warning">{error}</div>}
          <DialogPresence>{(sourceChecking || sourceNotice) && <motion.p key="source-notice" className="lc-muted lc-doc-source-notice" role="status"
            initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
            {sourceChecking ? sourceProgress : sourceNotice}
          </motion.p>}</DialogPresence>
          <DialogPresence>{!sourceCandidates && sourceFailures.length > 0 && <motion.ul key="source-failures" className="lc-warning lc-doc-source-failures"
            initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
            {sourceFailures.map((failure, index) => <li key={index}>{failure}</li>)}
          </motion.ul>}</DialogPresence>

          {saveTitle !== null ? (
            <div className="lc-settings-choice">
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
                <span className="lc-muted">
                  {isWeb ? "Keep these marks." : "Keep these annotations."}
                </span>
              </HoldButton>
            </div>
          ) : newTitle !== null && entry ? (
            <div className="lc-settings-choice">
              <PadNameField
                value={newTitle}
                placeholder="Untitled"
                disabled={locked}
                autoFocus
                onChange={setNewTitle}
                onSubmit={() => entry.onChoose("new", newTitle.trim() || "Untitled")}
              />
              <HoldButton holdMs={LIBRARY_HOLD_MS}
                label="Create note"
                className="lc-hold-choice"
                disabled={locked}
                onConfirm={() => entry.onChoose("new", newTitle.trim() || "Untitled")}
                resetKey={error}
              >
                <strong>Create</strong>
                <span className="lc-muted">
                  Opens a blank note you can edit, annotate, and link to.
                </span>
              </HoldButton>
            </div>
          ) : pickingSnapshots && entry ? (
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
                    onConfirm={() => row?.snapshotId ? entry.onChoose("snapshot", tier.id, row.snapshotId) : entry.onChoose("snapshot", tier.id)}
                    resetKey={error}
                  >
                    <strong>{tier.label}</strong>
                    <span className="lc-muted">
                      {row
                        ? new Date(row.writtenAt).toLocaleString()
                        : "No snapshot yet — write on this file and wait for autosave."}
                    </span>
                  </HoldButton>
                );
              })}
            </div>
          ) : pickingRecent && entry ? (
            <div className="lc-settings-choice">
              {(showTrash ? [] : visibleDocs).filter(matchesQuery).map((doc) => {
                const title = annotateDocLabel(doc);
                const copy = retained.pickedOf(doc.id);
                const size = copy ? versionBytes(copy, doc.hash) : retained.sizes[doc.id];
                return (
                <div key={doc.id} className={`lc-scratch-load-entry${copy ? " is-copy" : ""}${copy?.trashedAt ? " is-trashed-copy" : ""}`}>
                  {renamingId === doc.id ? (
                    <PadNameField
                      value={renameDraft}
                      disabled={locked}
                      autoFocus
                      onChange={setRenameDraft}
                      onSubmit={() => void commitRename(doc.id)}
                      onBlur={() => void commitRename(doc.id)}
                    />
                  ) : (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={copy ? `Restore copy ${copy.number} of ${title}` : `Open ${title}`}
                    className="lc-scratch-load-hold"
                    disabled={locked}
                    onTap={onRename && !copy ? () => tapLoadRow(doc.id, title) : undefined}
                    onConfirm={() => copy ? void openVersion(doc.id, copy) : entry.onChoose("recent", doc.id)}
                    resetKey={error}
                  >
                    {/* Showing a copy: its own name, label, date and why it was kept. */}
                    <VersionFace swapKey={copy?.id ?? "now"}>
                    <strong title={copy?.name || doc.name}>{copy?.name || doc.name}</strong>
                    {(() => { const label = (copy ? copy.label : doc.label)?.trim(); const name = (copy?.name || doc.name).trim();
                      return label && label !== name ? <span className="lc-muted lc-library-subtitle" title={label}>{label}</span> : null; })()}
                    {copy
                      ? <span className="lc-muted lc-version-line">{copyLine(copy)}{copy.trashedAt ? " · in the trash (!)" : ""}</span>
                      : <LibraryTimes {...doc}/>}
                    {size !== undefined && <span className="lc-muted lc-library-size">{formatBytes(size)}</span>}
                    </VersionFace>
                  </HoldButton>
                  )}
                  {renamingId !== doc.id && (
                  <>
                  <LibraryPadlock
                    name={title}
                    locked={Boolean(doc.locked)}
                    disabled={locked}
                    onToggle={async () => {
                      try {
                        await setAnnotateDocLocked(doc.id, !doc.locked);
                        refreshList();
                      } catch (cause) { setStorageError(cause instanceof Error ? cause.message : String(cause)); }
                    }}
                  />
                  <VersionPicker name={title} versions={retained.versions.get(doc.id) ?? []} picked={copy}
                    currentBytes={retained.sizes[doc.id]} currentHash={doc.hash} disabled={locked} onPick={id => retained.pick(doc.id, id)} />
                  <VersionShare name={copy ? `copy ${copy.number} of ${title}` : title} disabled={locked}
                    onAnnotated={() => entry.onExportVersion?.(doc.id, copy?.id ?? null)}
                    onBackup={() => void backupVersion(doc.id, doc.name, copy)} />
                  {/* One trash for the book or the copy shown: it stays put and changes colour. */}
                  {!doc.locked && (
                  <HoldButton holdMs={LIBRARY_HOLD_MS}
                    label={copy
                      ? copy.trashedAt ? `Delete copy ${copy.number} of ${title} for good` : `Move copy ${copy.number} of ${title} to the trash`
                      : `Delete annotations for ${title}`}
                    className={`lc-scratch-load-trash${copy?.trashedAt ? " lc-hold-danger" : ""}`}
                    disabled={locked}
                    ariaLabel={copy ? undefined
                      : tapArmed
                        ? `Delete annotations for ${title} — tap to delete`
                        : `Delete annotations for ${title} — hold to delete`
                    }
                    onTap={!copy && tapArmed ? () => void confirmRemove(doc.id) : undefined}
                    onConfirm={() => {
                      if (copy) { void trashVersion(doc.id, copy); return; }
                      if (tapArmed) void confirmRemove(doc.id);
                      else removeDoc(doc.id);
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
                  {/* A book in the trash has its copies with it; deleting it for good deletes them too. */}
                  {archived.filter(matchesQuery).map((doc) => (
                    <LibraryTrashRow key={`arch-${doc.id}`} name={annotateDocLabel(doc)} updatedAt={doc.updatedAt} disabled={locked}
                      detail={copiesDetail(doc.id, doc.hash)}
                      onRestore={async()=>{if(props.mode!=="entry")return;await props.onRestoreTrash?.(doc.id);refreshList();}}
                      onDelete={async()=>{await deleteAnnotateDoc(doc.id,true);await deleteBookRetainedCopies("annotate",doc.id);retained.refresh();refreshList();}}/>
                  ))}
                  {orphans.map(({ bookId, newest }) => (
                    <LibraryTrashRow key={`orphan-${bookId}`} name={newest.label || newest.name || "Retained copy"} updatedAt={newest.editedAt} disabled={locked}
                      detail={`Only retained copies · ${copiesDetail(bookId, newest.hash)}`}
                      onRestore={async()=>{await openVersion(bookId, newest);}}
                      onDelete={async()=>{await deleteBookRetainedCopies("annotate",bookId);retained.refresh();}}/>
                  ))}
                </section>
              )}
            </div>
          ) : (
            <div className="lc-settings-choice">
              {isLeave ? (
                <div className="lc-document-menu">
                  <LibraryMenuRow label="Save" disabled={locked} onConfirm={beginSave} />
                  <LibraryMenuRow label="Discard" disabled={locked} onConfirm={() => props.onChoose("discard")} />
                </div>
              ) : (
                <div className="lc-document-menu">
                  {section === "main" && <>
                    {allowSave && <MainMenuRow label="Save" description={isWeb ? undefined : "Save ink to the annotation library"} disabled={locked} onConfirm={beginSave} />}
                    {isWeb && <MainMenuRow label="New" description="Start a blank page" disabled={locked} onConfirm={() => props.onChoose("page")} />}
                    {!allowSave && !isWeb && <MainMenuRow label="New" disabled={locked} onConfirm={() => setSection("new")} />}
                    {isWeb
                      ? <MainMenuRow label="Recent" description="Reopen a page you were on" disabled={locked || (!visibleDocs.length && !archived.length && !orphans.length)} onConfirm={() => setPickingRecent(true)} />
                      : <MainMenuRow label="Open" description="Load ink from a saved file" disabled={locked} onConfirm={() => setSection("open")} />}
                    {allowSave && !isWeb && <>
                      <MainMenuRow label="Export" description="Share the document with your ink on it" disabled={locked} onConfirm={() => setSection("export")} />
                      <MainMenuRow label="Restore" description="Bring back ink from an earlier save" disabled={locked || !snapshotKey} onConfirm={openSnapshots} />
                    </>}
                  </>}
                  {section === "open" && <>
                    <LibraryMenuRow label="Load" disabled={locked} onConfirm={() => props.onChoose("open")} />
                    <LibraryMenuRow label="Recents" disabled={locked || (!visibleDocs.length && !archived.length && !orphans.length)} onConfirm={() => setPickingRecent(true)} />
                    {allowSave && <LibraryMenuRow label="Annotations" disabled={locked} onConfirm={() => setSection("sets")} />}
                  </>}
                  {section === "new" && <LibraryMenuRow label="Markdown file" disabled={locked} onConfirm={() => setNewTitle("")} />}
                  {section === "sets" && allowSave && <>
                    <LibraryMenuRow label="New" disabled={locked} onConfirm={() => props.onChoose("fork")} />
                    <LibraryMenuRow label="Saved" disabled={locked} onConfirm={() => setPickingRecent(true)} />
                    <LibraryMenuRow label="Import" disabled={locked} onConfirm={() => props.onChoose("import")} />
                  </>}
                  {section === "export" && <>
                    <LibraryMenuRow label="PDF" disabled={locked} onConfirm={() => props.onChoose("export-pdf")} />
                    <LibraryMenuRow label="Annotation backup" disabled={locked} onConfirm={() => props.onChoose("export")} />
                    {entry?.docType !== "pdf" && <LibraryMenuRow label={entry?.docType === "epub" ? "EPUB" : "Markdown + images (ZIP)"} disabled={locked} onConfirm={() => props.onChoose("export-document")} />}
                  </>}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="lc-settings-foot lc-dialog-foot">
          <DialogPresence>{pickingRecent && sourceDocs.length > 0 && <motion.button key="check-sources" type="button"
            className="lc-secondary lc-dialog-action lc-doc-source-bulk" disabled={locked} onClick={() => void checkSources()}
            initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
            Check for newer versions
          </motion.button>}</DialogPresence>
          <DialogPresence>{pickingRecent && nativeSourcePickerAvailable() && <motion.button key="link-folder" type="button"
            className="lc-secondary lc-dialog-action lc-doc-source-bulk lc-doc-source-folder" disabled={locked} onClick={() => void pickFolderSources()}
            // The chain, as on Link: the words are its label and tooltip.
            aria-label="Link files from a folder…" title="Link files from a folder: match unlinked documents by file name"
            initial={reducedMotion ? false : { opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
            <LinkIcon />
          </motion.button>}</DialogPresence>
          <span className="lc-dialog-foot-spacer" aria-hidden="true" />
          {(section !== "main" || pickingRecent || pickingSnapshots || newTitle !== null || saveTitle !== null) && (
            <button
              type="button"
              className="lc-secondary lc-dialog-action"
              disabled={locked}
              onClick={() => {
                if (!pickingRecent && !pickingSnapshots && newTitle === null && saveTitle === null) setSection(section === "sets" ? "open" : "main");
                setPickingRecent(false);
                setPickingSnapshots(false);
                            setNewTitle(null);
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
      <DialogPresence>{folderMatches !== null && <DialogBackdrop className="lc-modal-backdrop" key="source-folder" role="presentation"
        onClick={event => { if (event.target === event.currentTarget && !sourceUpdating) setFolderMatches(null); }}>
        <DialogFrame className="lc-modal lc-doc-source-updates" titleId={folderTitleId} title="Link files" subtitle="Choose the documents to link"
          ariaLabel="Link files" shape="blocky" icon={<DocumentIcon />} onClose={() => setFolderMatches(null)} closeDisabled={sourceUpdating}>
          <div className="lc-dialog-body lc-scroll-pane">
            {folderDuplicates > 0 && <p className="lc-muted">{folderDuplicates} {folderDuplicates === 1 ? "name appears" : "names appear"} more than once and {folderDuplicates === 1 ? "was" : "were"} skipped</p>}
            <div className="lc-doc-source-update-list">
              {folderMatches.map(row => <label className="lc-doc-source-update-row" key={row.doc.id}>
                <input type="checkbox" checked={folderSelected.includes(row.doc.id)} disabled={sourceUpdating}
                  onChange={event => setFolderSelected(current => event.target.checked ? [...current, row.doc.id] : current.filter(id => id !== row.doc.id))} />
                <span className="lc-doc-source-folder-copy"><span>{annotateDocLabel(row.doc)}</span><span className="lc-muted">{row.entry.relative}</span></span>
              </label>)}
            </div>
            <DialogPresence>{sourceUpdating && <motion.p key="source-link-progress" className="lc-muted" role="status"
              initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>{sourceProgress}</motion.p>}</DialogPresence>
            {sourceFailures.length > 0 && <ul className="lc-warning">{sourceFailures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>}
          </div>
          <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
            <button type="button" className="lc-secondary lc-dialog-action" disabled={sourceUpdating} onClick={() => setFolderMatches(null)}>Cancel</button>
            <button type="button" className="lc-secondary lc-dialog-action" disabled={sourceUpdating || !folderSelected.length} onClick={() => void linkFolderSources()}>Link selected</button>
          </div>
        </DialogFrame>
      </DialogBackdrop>}</DialogPresence>
      <DialogPresence>{sourceCandidates !== null && <DialogBackdrop className="lc-modal-backdrop" key="source-updates" role="presentation"
        onClick={event => { if (event.target === event.currentTarget && !sourceUpdating) closeSourceCandidates(); }}>
        <DialogFrame className="lc-modal lc-doc-source-updates" titleId={sourceTitleId} title="Newer versions available" subtitle="Choose the documents to update"
          ariaLabel="Newer versions available" shape="blocky" icon={<DocumentIcon />} onClose={closeSourceCandidates} closeDisabled={sourceUpdating}>
          <div className="lc-dialog-body lc-scroll-pane">
            <div className="lc-doc-source-update-list">
              {sourceCandidates.map(row => <label className="lc-doc-source-update-row" key={row.doc.id}>
                <input type="checkbox" checked={sourceSelected.includes(row.doc.id)} disabled={sourceUpdating}
                  onChange={event => setSourceSelected(current => event.target.checked ? [...current, row.doc.id] : current.filter(id => id !== row.doc.id))} />
                <span>{annotateDocLabel(row.doc)}</span>
              </label>)}
            </div>
            <DialogPresence>{sourceUpdating && <motion.p key="source-update-progress" className="lc-muted" role="status"
              initial={reducedMotion ? false : { opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>{sourceProgress}</motion.p>}</DialogPresence>
            {sourceFailures.length > 0 && <ul className="lc-warning">{sourceFailures.map((failure, index) => <li key={index}>{failure}</li>)}</ul>}
          </div>
          <div className="lc-modal-actions lc-settings-foot lc-dialog-foot">
            <button type="button" className="lc-secondary lc-dialog-action" disabled={sourceUpdating} onClick={closeSourceCandidates}>Cancel</button>
            <button type="button" className="lc-secondary lc-dialog-action" disabled={sourceUpdating || (!sourceSelected.length && folderLinked === null)} onClick={() => void updateSources()}>Update selected</button>
          </div>
        </DialogFrame>
      </DialogBackdrop>}</DialogPresence>
      <DialogPresence>{pendingId && (
        <ConfirmDialog
          title="Remove this document?"
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
