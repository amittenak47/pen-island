import { useCallback, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { ProblemDetail } from "../api/types";
import { isTauriRuntime } from "../api/nativeHttp";
import type { ShellValue } from "../shellContext";
import { getAnnotateDoc, type DocType } from "../util/annotateStore";
import type { DocFootnote } from "../util/docFootnotes";
import { messageOf } from "../util/messageOf";
import { canStepWeb, currentEntry, needsFetch, pushWeb, stepWeb, type WebPadEntry } from "../util/webPadSession";
import { activeTab as activeTabOf, newTabId, webTabTitle, type TabRecord, type WebTab } from "../util/tabs";
import { fetchWebPage, hostLabelFromUrl, type WebHtmlSource } from "../util/webPage";
import { loadWebRenderMode, type WebRenderMode } from "../util/webRenderMode";
import { addCapture, captureKeptSummary, neededCaptures, newCaptureId, type WebCapture, type WebPadKind } from "../util/webCaptures";

type Setter<T> = Dispatch<SetStateAction<T>>;

type WebCaptureArgs = Pick<ShellValue,
  "openWorkspace" | "setBrowseMotion" | "setHoldBrowseOverlay" | "setShellLoadActive" |
  "setError" | "setNotice" | "tabsRef" | "webPush" | "webStep"
> & {
  tab: TabRecord;
  problem: ProblemDetail | null;
  busy: string | null;
  busyRef: RefObject<string | null>;
  setBusy: Setter<string | null>;
  beginPadOpen: () => void;
  endPadOpen: () => void;
  beginWorkspaceLoad: () => { gen: number; signal: AbortSignal };
  workspaceLoadGenRef: RefObject<number>;
  setWorkspaceLoadActive: Setter<boolean>;
  setBoardPreparing: Setter<boolean>;
  annotateFootnotesRef: RefObject<DocFootnote[]>;
  annotateDocIdRef: RefObject<string | null>;
  webUrlRef: RefObject<string>;
  setWebHtmlSource: Setter<WebHtmlSource | null>;
  setWebHtmlNote: Setter<string | null>;
  loadAnnotate: (input: {
    name: string;
    docType?: DocType;
    text?: string;
    tabId: string;
    userLoad?: boolean;
  }) => Promise<void>;
};

/**
 * Web fetch/history and live-page freezing. Shared document loading, saving
 * and cancellation stay in Workspace, along with their effect ordering.
 */
export function useWebCapture({
  tab, problem, busy, busyRef, setBusy, beginPadOpen, endPadOpen,
  beginWorkspaceLoad, workspaceLoadGenRef, setWorkspaceLoadActive,
  setBoardPreparing, annotateFootnotesRef, annotateDocIdRef, webUrlRef,
  setWebHtmlSource, setWebHtmlNote, loadAnnotate, openWorkspace,
  setBrowseMotion, setHoldBrowseOverlay, setShellLoadActive, setError,
  setNotice, tabsRef, webPush, webStep,
}: WebCaptureArgs) {
  /*
   * Browsing or annotating — a web tab is one or the other, never both.
   *
   * Live is a native webview over the pane: the real page, its own JavaScript,
   * its own CSS. Nothing of ours can be drawn on top of a native surface and
   * nothing can reach into it for a text range, so ink and marks are impossible
   * while it is showing. Freezing serialises it into a document, which is what
   * makes those possible and what costs the fidelity. Keeping them as two
   * states is the only honest way to have both.
   *
   * Both platforms, now. Android has no *wry* child webview, which is not the
   * same as having no child web view — the `livewebview` plugin is one, and
   * `webPageCapture` picks between them. A tablet browses and freezes like a
   * desktop does.
   */
  const [webLive, setWebLive] = useState(false);
  /**
   * The capture a new mark belongs to (§1m).
   *
   * A web pad's body can be replaced under its marks, so a mark that does not
   * say which capture it was made against cannot be read in context afterwards
   * — only quoted. Null on every other document kind, where there is one body
   * and nothing to disambiguate.
   */
  const captureIdRef = useRef<string | null>(null);
  /**
   * What the freeze worked out, waiting for the reload that will save it.
   *
   * `loadAnnotate` writes the pad, so the capture list has to survive from the
   * freeze into that write. Cleared as soon as it is used.
   */
  const capturePendingRef = useRef<{
    id: string;
    captures: WebCapture[];
    kind?: WebPadKind;
    marks: DocFootnote[];
  } | null>(null);
  /** Asked once per pad, at the freeze. Null while nothing is being asked. */
  const [freezeAsk, setFreezeAsk] = useState<string | null>(null);
  /** Older captures still under a mark. Drives nothing but the save. */
  const [webCaptures, setWebCaptures] = useState<WebCapture[]>([]);
  /** The reader's page-or-feed answer for this pad, once they have given one. */
  const [webPadKind, setWebPadKind] = useState<WebPadKind | null>(null);
  /** Carried into the first save after a freeze, then dropped. */
  const pendingCaptureWriteRef = useRef<{
    captures: WebCapture[];
    kind?: WebPadKind;
  } | null>(null);
  /**
   * Reader or whole page — the reader's standing choice, not the fetch's guess.
   *
   * Held here and passed into every fetch for this pad, so switching it re-opens
   * the address you are on in the other rendering rather than the next one you
   * happen to type.
   */
  const [webRenderMode, setWebRenderMode] = useState<WebRenderMode>(loadWebRenderMode);
  const webRenderModeRef = useRef(webRenderMode);
  webRenderModeRef.current = webRenderMode;
  /** Globe / address-bar opens only. Library snapshots stay annotate tabs. */
  const webTabRecord = useCallback(
    (entry: WebPadEntry): WebTab => ({
      id: newTabId("web"),
      kind: "web",
      title: webTabTitle(entry),
      dirty: false,
      lastActive: 0,
      indexed: "idle",
      entries: [entry],
      index: 0,
      docId: null,
    }),
    [],
  );


  const showWebEntry = useCallback(
    async (tab: WebTab, userLoad = false) => {
      const entry = currentEntry(tab);
      if (!entry || busyRef.current !== null) return;
      /*
       * A place without a snapshot — fetch it, then keep it.
       *
       * Live browsing records where it went and nothing else: the page is in a
       * native view the app cannot read. Stepping back onto one of those
       * entries has to go and get the page. The result replaces the
       * placeholder at the same address rather than joining it, so walking the
       * history twice does not grow it.
       *
       * Only this path fetches. An entry that already carries its HTML is
       * replayed as-is, which is what makes Back instant on anything you
       * arrived at frozen, and what keeps its marks attached to the capture
       * they were made against.
       */
      if (needsFetch(entry)) {
        setBusy("loading page…");
        try {
          const page = await fetchWebPage(entry.url, { mode: webRenderModeRef.current });
          const filled = {
            url: page.url,
            title: page.title || hostLabelFromUrl(page.url),
            html: page.html,
          };
          setWebHtmlSource(page.source);
          setWebHtmlNote(page.note ?? null);
          webPush(tab.id, filled);
          setBusy(null);
          await loadAnnotate({
            name: filled.url,
            docType: "web",
            text: filled.html,
            tabId: tab.id,
            userLoad,
          });
        } catch (cause) {
          setBusy(null);
          setError(messageOf(cause));
        }
        return;
      }
      await loadAnnotate({
        name: entry.url,
        docType: "web",
        text: entry.html,
        tabId: tab.id,
        userLoad,
      });
    },
    [loadAnnotate, webPush],
  );

  /**
   * Stop browsing and keep what is on screen.
   *
   * Reads the live view's own DOM rather than fetching the address again: you
   * may have clicked three links, filled a form, or expanded something, and the
   * page you are looking at is the one you meant to write on. A re-fetch would
   * freeze a different page and call it the same one.
   */
  const freezeLivePage = useCallback(async (padKind?: WebPadKind) => {
    if (!isTauriRuntime()) return;
    setBusy("Freezing this page…");
    try {
      const { liveWebviewLabel, serializeLiveWebview } = await import(
        "../util/webPageCapture"
      );
      const live = await serializeLiveWebview(liveWebviewLabel(tab.id));
      const { pageFromCapturedHtml } = await import("../util/webPage");
      const page = await pageFromCapturedHtml(live.html, live.url || webUrlRef.current, {
        mode: webRenderModeRef.current,
      });
      /*
       * Would this capture strand anything the reader already marked?
       *
       * A web pad's identity is its address, so this capture arrives under the
       * same hash and replaces the last one. For an article that is right — the
       * page was edited and the words are still there. For a feed it is
       * destruction: today holds none of yesterday's posts, so replacing would
       * leave every mark showing an excerpt and pointing at nothing.
       *
       * Nothing guesses which kind of page this is. It is asked of the capture
       * itself, and only a *loss* is worth interrupting for.
       */
      const existing = annotateFootnotesRef.current;
      const docId = annotateDocIdRef.current;
      const prior = docId ? await getAnnotateDoc(docId) : null;
      const kind = padKind ?? prior?.padKind;
      const now = Date.now();
      const freshId = newCaptureId(now);
      let stranded: string[] = [];
      if (existing.length > 0) {
        const { captureFit } = await import("../util/captureFit");
        const { htmlToText } = await import("../util/docExtract");
        stranded = captureFit(existing, htmlToText(page.html)).stranded;
      }
      /*
       * A capture that strands a mark is kept, not refused.
       *
       * Refusing was the safe half and it left the pad frozen on one old copy
       * for good — you could never move a feed forward. Keeping both is what
       * §1m is for: the new capture becomes the body, the old one stays under
       * the marks that cannot move into it, and each of those marks can still
       * be read in context rather than reduced to a naked quote.
       */
      const carried = prior?.captures ?? [];
      const priorBody = prior?.source ?? "";
      const priorId =
        carried[0]?.html === priorBody
          ? carried[0]?.id
          : priorBody
            ? newCaptureId(now - 1)
            : undefined;
      const seed =
        priorId && !carried.some((row) => row.id === priorId)
          ? [{ id: priorId, capturedAt: (prior?.updatedAt ?? now) - 1, html: priorBody }]
          : carried;
      const stampedMarks = existing.map((mark) =>
        mark.captureId
          ? mark
          : { ...mark, ...(priorId ? { captureId: priorId } : {}) },
      );
      const captures = addCapture({
        existing: seed,
        html: page.html,
        now,
        id: freshId,
        needed: neededCaptures(stampedMarks, new Set(stranded)),
        kind,
      });
      capturePendingRef.current = { id: freshId, captures, kind, marks: stampedMarks };
      setWebHtmlSource(page.source);
      setWebHtmlNote(page.note ?? null);
      setWebLive(false);
      setBusy(null);
      if (stranded.length > 0) {
        setNotice(captureKeptSummary(stranded.length, existing.length));
      }
      await loadAnnotate({
        name: page.url,
        docType: "web",
        text: page.html,
        tabId: tab.id,
        userLoad: true,
      });
    } catch (cause) {
      setBusy(null);
      setError(messageOf(cause));
    }
  }, [loadAnnotate, setNotice, tab.id]);

  /**
   * Fetch a page, sanitise it, then open it as a web tab (globe / address bar).
   *
   * Library files that happen to be captured HTML stay annotate tabs.
   * `loadAnnotate` bails while `busy` is set, so in-place navigation clears
   * that flag first. A new tab loads on mount — this instance must not.
   */
  const openWebPage = useCallback(
    async (raw: string, opts?: { newTab?: boolean }) => {
      /*
       * A new address replaces whatever was loading. Enter-while-busy used to
       * no-op, then the in-flight Google capture painted over the typed URL.
       * Bumping the gen makes that fetch see a mismatch and bail.
       */
      beginPadOpen();
      const { gen: loadGen } = beginWorkspaceLoad();
      const fromBrowse = !problem;
      setShellLoadActive(true);
      setWorkspaceLoadActive(true);
      if (fromBrowse) {
        setHoldBrowseOverlay(true);
        setBrowseMotion("busy");
        setBoardPreparing(true);
      }
      setBusy("loading page…");
      setError(null);
      let handedOff = false;
      let sameWorkspace = false;
      try {
        const page = await fetchWebPage(raw, { mode: webRenderModeRef.current });
        if (workspaceLoadGenRef.current !== loadGen) return;
        setWebHtmlSource(page.source);
        setWebHtmlNote(page.note ?? null);
        const entry = {
          url: page.url,
          title: page.title || hostLabelFromUrl(page.url),
          html: page.html,
        };
        /*
         * A page navigated to from the one on screen extends that tab's
         * history; anything else — the globe, the strip's `+`, a link opened
         * deliberately in a new tab — is a new tab, and the reducer holds the
         * cap of two.
         *
         * The new workspace loads on mount. Do not loadAnnotate here: this
         * instance is Home (or the previous pad) and would double-open.
         */
        /*
         * This pane's tab, not whichever tab has focus.
         *
         * `activeTabOf` is the wrong question in a split: each pane is its own
         * workspace, and Reload belongs to the pane whose button was pressed.
         * Asking the shell instead meant that with the *other* pane focused,
         * this one's Reload found no web tab to reuse and opened a third.
         */
        const own = tabsRef.current.tabs.find((entry) => entry.id === tab.id) ?? null;
        const current = own?.kind === "web" ? own : activeTabOf(tabsRef.current);
        const inPlace = opts?.newTab !== true && current.kind === "web" ? current : null;
        if (inPlace) {
          sameWorkspace = true;
          busyRef.current = null;
          setBusy(null);
          /*
           * `webPush` is a React dispatch — tabsRef still holds the old
           * snapshot until the next render. Show the pushed tab, not `inPlace`,
           * or loadAnnotate paints Google and setWebUrl overwrites the omnibox.
           */
          const nextTab = pushWeb(inPlace, entry);
          webPush(inPlace.id, entry);
          handedOff = true;
          await showWebEntry(nextTab, true);
        } else {
          openWorkspace(webTabRecord(entry));
          handedOff = true;
        }
      } catch (cause) {
        if (workspaceLoadGenRef.current !== loadGen) return;
        setError(messageOf(cause));
      } finally {
        endPadOpen();
        if (workspaceLoadGenRef.current !== loadGen) return;
        if (!handedOff) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setShellLoadActive(false);
          if (fromBrowse) {
            setHoldBrowseOverlay(false);
            setBrowseMotion("idle");
            setBoardPreparing(false);
          }
        } else if (!sameWorkspace) {
          setBusy(null);
          setWorkspaceLoadActive(false);
          setBoardPreparing(false);
        }
      }
    },
    [
      beginPadOpen,
      beginWorkspaceLoad,
      endPadOpen,
      openWorkspace,
      problem,
      setBrowseMotion,
      setHoldBrowseOverlay,
      setShellLoadActive,
      showWebEntry,
      webPush,
      webTabRecord,
    ],
  );

  const stepWebTab = useCallback(
    (delta: number) => {
      const tab = activeTabOf(tabsRef.current);
      if (tab.kind !== "web" || !canStepWeb(tab, delta) || busy !== null) return;
      webStep(tab.id, delta);
      void showWebEntry(stepWeb(tab, delta));
    },
    [busy, showWebEntry],
  );

  return {
    showWebEntry, freezeLivePage, openWebPage, stepWebTab,
    webLive, setWebLive, captureIdRef, capturePendingRef, freezeAsk, setFreezeAsk,
    webCaptures, setWebCaptures, webPadKind, setWebPadKind, pendingCaptureWriteRef,
    webRenderMode, setWebRenderMode, webRenderModeRef,
  };
}
