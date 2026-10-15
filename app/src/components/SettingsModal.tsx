/**
 * Settings modal — edits the shared `config.toml` via the in-process router.
 * Backdrop blurs the board the same way problem-load transitions do.
 */

import { Children, isValidElement, createContext, useCallback, useContext, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";

import { checkPadHub, type PadHubCheck, type AssistantRunnerConfig, type AssistantRunnerStatus } from "../api/client";
import type { DevicePrefsDto, DlcStatus, LcClient } from "../api/client";
import {dlcProgressLabel, mergeDlcStatus} from "../util/dlcProgress";
import type {
  CoachFlags,
  DatasetInfo,
  LcConfig,
  LcConfigPut,
  LlmStatus,
  ModelCatalog,
  ModelEntry,
  ProviderConfig,
  VoiceConfig,
} from "../api/types";
import { CHATBOT_CLIENTS, assistantRunnerMessage, loadChatBotClient, saveChatBotClient, loadChatBotAnswerMode, saveChatBotAnswerMode, type ChatBotClient, type ChatBotAnswerMode } from "../util/chatBotClient";
import { DEFAULT_COACH_FLAGS, DEFAULT_VOICE_CONFIG } from "../api/types";
import { shouldDismissBackdrop } from "../util/backdropDismiss";
import { DialogFrame } from "./DialogFrame";
import { DialogBackdrop, DialogPresence } from "./DialogMotion";
import { AnimatedDisclosure } from "./AnimatedDisclosure";
import { countSettingsChanges } from "../util/settingsChanges";
import "./settingsDialog.css";
import { SettingsSlider } from "./SettingsSlider";
import { SettingsChoices } from "./SettingsChoices";
import { loadShowBooktabs, saveShowBooktabs, loadShowFootnoteTitles, saveShowFootnoteTitles, loadBooktabPosition, saveBooktabPosition, loadBooktabFootnotes, saveBooktabFootnotes, type BooktabPosition, type BooktabFootnotes } from "../util/booktabsPref";
import { HoldButton } from "./HoldButton";
import { HEADER_MODES, loadHeaderModes, saveHeaderModes, type HeaderModes } from "../util/headerModesPref";
import { loadTestForwardMode, saveTestForwardMode, type TestForwardMode } from "../util/agentPrefs";
import { loadInkHandedness, saveInkHandedness, type InkHandedness } from "../util/inkHandedness";
import { loadInkToolPresets, saveInkToolPresets } from "../util/inkToolPresets";
import {
  loadInkPressureClip,
  saveInkPressureClip,
} from "../util/inkPressureClip";
import {
  loadInkSmoothing,
  loadInkSmoothingMode,
  saveInkSmoothing,
  saveInkSmoothingMode,
  type InkSmoothingMode,
} from "../util/inkSmoothingPref";
import {
  AUTOSAVE_BANNER_CHOICES,
  AUTOSAVE_CHOICES,
  AUTOSAVE_EVENT,
  loadAutosaveBanner,
  loadAutosaveInterval,
  saveAutosaveBanner,
  saveAutosaveInterval,
  type AutosaveBanner,
  type AutosaveInterval,
} from "../util/autosavePref";
import {
  HUB_AUTOSYNC_CHOICES,
  HUB_AUTOSYNC_EVENT,
  loadHubAutosyncPref,
  saveHubAutosyncPref,
  type HubAutoSyncPref,
} from "../util/hubAutoSyncPref";
import {
  ERASER_PARTIAL_EVENT,
  loadEraserPartial,
  saveEraserPartial,
} from "../util/eraserPartialPref";
import {
  CHROME_WAKE_EVENT,
  loadChromeWakeMarker,
  loadChromeWakeTint,
  saveChromeWakeMarker,
  saveChromeWakeTint,
  type ChromeWakeMarker,
  type ChromeWakeTint,
} from "../util/chromeWakePref";
import {
  loadInkGrain,
  loadInkSpeed,
  loadInkSpeedBlotBlend,
  loadInkSpeedFade,
  saveInkGrain,
  saveInkSpeed,
  saveInkSpeedBlotBlend,
  saveInkSpeedFade,
  INK_GRAIN_EVENT,
  INK_SPEED_BLOT_BLEND_EVENT,
  INK_SPEED_FADE_EVENT,
} from "../util/inkSpeedPref";
import {
  loadInkBoldness,
  saveInkBoldness,
  INK_BOLDNESS_EVENT,
} from "../util/inkBoldnessPref";
import {
  captureWritesFile,
  loadCaptureMode,
  CAPTURE_COUNTDOWN_CHOICES,
  loadCaptureCountdown,
  loadCaptureDestination,
  loadCaptureFolder,
  pickCaptureFolder,
  saveCaptureCountdown,
  saveCaptureFolder,
  saveCaptureMode,
  saveCaptureDestination,
  type CaptureDestination,
  type CaptureMode,
} from "../util/capturePrefs";
import {
  loadPalettePrefs,
  paletteTagLabel,
  savePalettePrefs,
  togglePaletteTag,
  PALETTE_TAGS,
  type PalettePrefs,
} from "../util/palettePref";
import {
  loadOfflineMergePolicy,
  saveOfflineMergePolicy,
  type OfflineMergePolicy,
} from "../util/offlineMerge";
import {
  loadInkPerfOverlay,
  saveInkPerfOverlay,
  loadInkPerfBar,
  saveInkPerfBar,
} from "../util/inkPerfOverlayPref";
import {
  loadHubSyncWindowPill,
  saveHubSyncWindowPill,
} from "../util/hubSyncWindowPillPref";
import { loadNotificationCards, saveNotificationCards } from "../util/notificationCardsPref";
import {
  INK_DISPLAY_HZ,
  loadInkDisplayHz,
  saveInkDisplayHz,
  loadInkMatchDisplay,
  saveInkMatchDisplay,
  type InkDisplayHzPref,
} from "../util/inkDisplayHzPref";
import {
  loadPdfFlickHud,
  loadPdfFlickMomentum,
  savePdfFlickHud,
  savePdfFlickMomentum,
  PDF_READING_EVENT,
} from "../util/pdfReadingPref";
import { useIsMobile } from "../util/mobile";
import { estimateStorage, formatBytes, type StorageUsage } from "../util/storageQuota";
import { auditDocBytes, clearDocBytes, docStoreFacts, inspectDocStore } from "../util/docBytes";
import {
  deviceRole,
  ensureDevicePrefs,
  loadDeviceId,
  saveThisDevicePrefs,
} from "../util/devicePrefs";
import { FEATURE_LEETCODE } from "../featureFlags";
import { loadUiHandedness, saveUiHandedness, type UiHandedness } from "../util/uiHandedness";
import { loadUiCorners, saveUiCorners, type UiCorners } from "../util/uiCorners";
import { loadStartupTabs, saveStartupTabs, type StartupTabs } from "../util/startupTabsPref";
import { clearDebugLog, debugLogCount, debugLogEnabled, exportDebugLog, setDebugLogEnabled } from "../util/debugLog";
import { loadPageFit, loadReadingMode, savePageFit, saveReadingMode, type PageFitPref, type ReadingMode } from "../util/readingModePref";
import { loadAgentDisplayPrefs, saveAgentDisplayPrefs, type AgentDisplayPrefs } from "../util/agentDisplayPrefs";
import { PAD_HUB_EVENT, loadSavedPadHub, savePadHub } from "../util/padHub";
import { compareIndexFacts, indexFacts } from "../util/indexReport";
import type { SettingsFact } from "../util/settingsFacts";
import { SettingsFacts, factsFromMessage } from "./SettingsFacts";
import { auditInkDuplicates } from "../util/inkDuplicates";
import { VOCABULARY_PRESETS, vocabularyPresetId } from "../util/voiceVocabulary";

type TabId = "workspace" | "personalise" | "ai" | "llm";

const TABS: { id: TabId; label: string }[] = [
  { id: "personalise", label: "Personalize" },
  ...(FEATURE_LEETCODE ? [{ id: "ai" as const, label: "Practice" }] : []),
  ...(FEATURE_LEETCODE ? [{ id: "workspace" as const, label: "Workspace" }] : []),
  { id: "llm", label: "AI" },
];

const SettingsPageCtx = createContext<{
  page: string; open: (id: string) => void; query: string; summaries: Record<string, string>;
  changes: Record<string, number>; reset: (id: string) => void; saving: boolean;
}>({ page: "root", open: () => {}, query: "", summaries: {}, changes: {}, reset: () => {}, saving: false });

function SettingsIcon({id}: {id: string}) {
  const paths: Record<string,string> = {
    writing:"M4 17 16 5l3 3L7 20H4v-3Z", reading:"M8 3h8v18H8V3Zm4 3v5",
    storage:"M4 5h16v14H4V5Zm0 5h16m-12 5h8", ui:"M3 4h18v16H3V4Zm0 5h18M9 9v11",
    diagnostics:"M4 18V6m5 12V3m6 15V9m5 9V5", paths:"M3 6h7l2 3h9v11H3V6Z",
    datasets:"M4 4h16v16H4V4Zm0 6h16m-10 0v10", llm:"M4 4h16v13H9l-5 4V4Zm4 5h8m-8 4h5",
    voice:"M9 3h6v11H9V3Zm-4 8a7 7 0 0 0 14 0M12 18v3",
    "ink-tools":"M4 18a8 8 0 1 1 16-6c0 4-4 1-5 4s-4 5-7 2Zm4-10h.01M12 6h.01M16 9h.01",
    check:"m4 12 5 5L20 6", diagnose:"M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6",
    repair:"m4 20 9-9m-3-7a6 6 0 0 0 8 8l-4-4 2-2 4 4a6 6 0 0 0-8-8",
    delete:"M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
    export:"M12 15V3m-4 4 4-4 4 4M4 14v7h16v-7", reset:"M4 10a8 8 0 1 1 0 5M4 4v6h6",
    licenses:"M6 3h9l3 3v15H6V3Zm3 6h6m-6 4h6m-6 4h3",
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[id] ?? "M5 4h14v16H5V4Zm4 5h6m-6 5h6"}/></svg>;
}

/** Search existing labels without mounting the settings controls. */
function settingsText(children: ReactNode): string {
  return Children.toArray(children).map(child => {
    if (typeof child === "string" || typeof child === "number") return String(child);
    if (!isValidElement<{children?:ReactNode; label?:string; title?:string; "aria-label"?:string}>(child)) return "";
    return [child.props.label, child.props.title, child.props["aria-label"], settingsText(child.props.children)].filter(Boolean).join(" ");
  }).join(" ");
}

function SettingsFold({id,title,children}: {id:string;title:string;children:ReactNode}) {
  const {page,open,query,summaries,changes,reset,saving}=useContext(SettingsPageCtx);
  const terms=query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length) {
    const text=`${title} ${id === "diagnostics" ? "Activity log Debug log Export log Clear log" : ""} ${settingsText(children)}`.toLocaleLowerCase();
    if (terms.some(term=>!text.includes(term))) return null;
  }
  const expanded=page===id;
  const changed=changes[id] ?? 0;
  return <section className={`lc-settings-fold${expanded ? " is-expanded" : ""}`}>
    <div className="lc-settings-fold-header" data-changed={changed > 0}>
    <button type="button" className="lc-settings-fold-summary" aria-expanded={expanded} aria-controls={`lc-settings-group-${id}`} onClick={()=>open(expanded ? "root" : id)}>
      <span className="lc-settings-group-icon"><SettingsIcon id={id}/></span>
      <span className="lc-settings-fold-title">{title}</span>
      <span className="lc-settings-fold-value">{summaries[id]}</span>
      {changed > 0 && <span className="lc-settings-group-changes">{changed} changed</span>}
      <span className="lc-settings-fold-chevron" aria-hidden/>
    </button>
    {changed > 0 && <button type="button" className="lc-settings-group-reset" aria-label={`Reset ${title}`} title={`Reset ${title}`} disabled={saving} onClick={()=>reset(id)}><SettingsIcon id="reset"/></button>}
    </div>
    <AnimatedDisclosure open={expanded}><div id={`lc-settings-group-${id}`} className="lc-settings-fold-body" inert={!expanded}>{children}</div></AnimatedDisclosure>
  </section>;
}

const PROVIDERS = ["local", "ollama", "openai", "groq"] as const;

const VOICE_ENGINES: { id: VoiceConfig["engine"]; label: string; blurb: string }[] = [
  { id: "android", label: "Android", blurb: "Built into the tablet. Text appears as you speak." },
  { id: "local", label: "Whisper on your PC", blurb: "Free and private. The Whisper app must be running on your PC." },
  { id: "openai", label: "OpenAI", blurb: "Online. Needs an API key." },
  { id: "groq", label: "Groq", blurb: "Online. Needs an API key." },
  { id: "deepgram", label: "Deepgram", blurb: "Online. Needs an API key." },
];

const VOICE_CLEANUP: { id: VoiceConfig["cleanup"]; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "local", label: "Local" },
  { id: "ollama", label: "Ollama" },
  { id: "openai", label: "OpenAI" },
  { id: "groq", label: "Groq" },
];

function voiceClipModel(voice: VoiceConfig): string {
  switch (voice.engine) {
    case "local": return voice.local_model;
    case "openai": return voice.openai_model;
    case "groq": return voice.groq_model;
    case "deepgram": return voice.deepgram_model;
    default: return "";
  }
}

/**
 * Fallback poll for DLC status, used only where Tauri events are unavailable.
 *
 * Slow on purpose. It is the browser-preview path, nobody is installing a
 * dataset there, and the fast interval this replaces was running beside a
 * working listener that already reported every change.
 */
const DLC_POLL_MS = 15_000;
const MODES = ["ambient", "review", "bridge", "viz", "planner"] as const;

/**
 * Settings → AI Behavior, grouped by what the question actually is.
 *
 * Flat, these read as five unrelated switches, and "Plan the approaches first"
 * in particular looked like a mystery toggle rather than the one setting that
 * changes what the coach *knows* before it has seen anything. Three headings,
 * because there are three questions: what does it know going in, how does it
 * hold its ground, and how does it talk back.
 */
const COACH_FLAG_GROUPS: Array<{
  id: string;
  title: string;
  blurb: string;
  flags: Array<[keyof CoachFlags, string, string]>;
}> = [
  {
    id: "coach-knows",
    title: "Planning",
    blurb:
      "Optional. Uses one extra AI request per problem.",
    flags: [
      [
        "planner_enabled",
        "Plan approaches first",
        "Before reading your board, the assistant lists the ways the problem can be solved. It uses only the problem description and examples, never a solution.",
      ],
    ],
  },
  {
    id: "coach-reads",
    title: "Approach",
    blurb: "What the assistant does when your board points to one way of solving the problem.",
    flags: [
      [
        "approach_commitment",
        "Stick to one approach",
        "Follows the approach on your board and tells you if a change on the board changes it.",
      ],
    ],
  },
];

const SHARED_AGENT_FLAGS: Array<[keyof CoachFlags, string, string]> = [
      [
        "ws_runs",
        "Show replies as they’re written",
        "See each part of a reply as soon as it’s ready.",
      ],
      [
        "process_events_ui",
        "Show what the assistant is doing",
        "Shows its thinking steps and the tools it uses.",
      ],
      ["draw_review_enabled", "Check drawn diagrams", "The assistant checks each diagram it draws and fixes it once if needed. Needs a model that can read images, and takes a little longer."],
];

/** What each coach mode is for, shown under its provider picker. */
const MODE_HINTS: Record<(typeof MODES)[number], string> = {
  ambient: "Glances at the board every 2 minutes.",
  review: "Staged reviews and Ask.",
  bridge: "The step-by-step path shown after you choose Reveal.",
  viz: "Draws diagrams and animations.",
  planner: "Lists the approaches each problem allows. A larger model works best; it never sees or writes a solution.",
};

/** Display names for the agent modes and providers (their ids stay in config). */
const MODE_LABELS: Record<(typeof MODES)[number], string> = {
  ambient: "Background check",
  review: "Review and Ask",
  bridge: "Reveal",
  viz: "Diagrams",
  planner: "Planner",
};
const PROVIDER_LABELS: Record<(typeof PROVIDERS)[number], string> = {
  local: "Local",
  ollama: "Ollama",
  openai: "OpenAI",
  groq: "Groq",
};

/**
 * What the model list is offering, and why it might be short.
 *
 * A provider that will not list its models is ordinary — OpenAI and Groq want
 * a key before they answer, and a local server that is not running answers
 * nothing at all — so this reads as information, never as an error.
 */
function modelHint(
  catalog: ModelCatalog | null,
  busy: boolean,
  typed: string,
  selected: ModelEntry | undefined,
): string {
  if (busy) return "Reading the model list…";
  if (!catalog) return "Couldn’t load the model list. Type the model name instead.";

  const onServer = catalog.models.filter((entry) => entry.source === "server").length;
  const onDisk = catalog.models.length - onServer;
  const found: string[] = [];
  if (onServer > 0) found.push(`${onServer} from the server`);
  if (onDisk > 0) found.push(`${onDisk} in the models folder`);

  const lines: string[] = [];
  if (found.length > 0) lines.push(`${found.join(", ")}.`);
  // A typed id the server has never heard of is the failure worth catching
  // here rather than on the first Review, where it arrives as a bare 404.
  if (typed.length > 0 && selected === undefined && onServer > 0) {
    lines.push(`The server did not list “${typed}”, so a chat call may fail.`);
  }
  if (catalog.notes[0]) lines.push(catalog.notes[0]);
  return lines.join(" ") || "No models listed — type the id by hand.";
}

/**
 * What is actually known about images for the chosen model — and nothing more.
 *
 * Only a server that says `multimodal` counts as a yes. A projector file beside
 * the weights is reported as what it is: evidence the model *can*, not proof
 * the server was launched to. Everything else says plainly that nothing was
 * reported, because the alternative is guessing from the name, and a wrong
 * guess sends every Draw request a PNG the endpoint will refuse.
 */
function visionEvidence(
  catalog: ModelCatalog | null,
  selected: ModelEntry | undefined,
  /** What the reader has answered, not what the server advertises. */
  ticked: boolean,
): string {
  if (!catalog || !selected) {
    return ticked
      ? "Images will be sent. This couldn’t be checked automatically."
      : "Choose Yes if this model can read images. It couldn’t be checked automatically.";
  }
  if (selected.advertises_vision === true) {
    return ticked
      ? "The server reports this model accepts images. ✓"
      : "The server reports this model accepts images — answer Yes to let Draw and board review use them.";
  }
  if (selected.has_mmproj) {
    return ticked
      ? "A projector file (mmproj) sits beside these weights, so images should work if the server was started with it."
      : "A projector file (mmproj) sits beside these weights, so this model can read images if the server was started with it. The server does not advertise it, so this one is your call.";
  }
  return ticked
    ? "This endpoint does not report image support. Images will still be sent — answer No if Draw starts failing."
    : "This endpoint does not report image support. That is not the same as “no”: OpenAI and Groq never say. Answer Yes only if you know the model reads images.";
}

function llmServerHint(provider: "local" | "ollama" | "openai" | "groq"): string {
  switch (provider) {
    case "local":
    case "ollama":
      return "Where the AI server is running. For Ollama on this computer it’s usually http://localhost:11434/v1.";
    case "openai":
      return "OpenAI's cloud API. Requests leave from this app; the API key lives here too.";
    case "groq":
      return "Groq's cloud API. Requests leave from this app; the API key lives here too.";
  }
}

function formatDlcBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function emptyProvider(): ProviderConfig {
  return {
    base_url: "",
    model: "",
    vision_model: "",
    vision: null,
    embed_model: "",
    embed_base_url: "",
  };
}

function emptyConfig(): LcConfig {
  return {
    data_json_dir: null,
    dataset_dirs: {},
    workspace_dir: "~/lc-workspace",
    stop_on_first_failure: false,
    default_provider: "local",
    models_dir: "",
    local: emptyProvider(),
    ollama: emptyProvider(),
    openai: emptyProvider(),
    groq: emptyProvider(),
    modes: {
      ambient: "local",
      review: "local",
      bridge: "local",
      viz: "local",
      planner: "local",
    },
    serve_port: 7878,
    serve_token: null,
    coach: { ...DEFAULT_COACH_FLAGS },
    token_set: false,
    openai_key_set: false,
    groq_key_set: false,
  };
}

/** Device-only prefs edited in Personalise — deferred until Save like config.toml. */
interface DevicePrefs {
  headerModes: HeaderModes;
  agentDisplay: AgentDisplayPrefs;
  uiHandedness: UiHandedness;
  uiCorners: UiCorners;
  /** Which tabs a relaunch opens. Read once, at the next launch. */
  startupTabs: StartupTabs;
  /** Continuous scroll, or a page at a time with a page turn. */
  readingMode: ReadingMode;
  /** Pages reading: the whole page edge to edge, or with a margin. */
  pageFit: PageFitPref;
  showBooktabs: boolean;
  showFootnoteTitles: boolean;
  booktabPosition: BooktabPosition;
  booktabFootnotes: BooktabFootnotes;
  handedness: InkHandedness;
  /**
   * Hand a failed run to the coach without being asked.
   *
   * Used to be a "Failures" toggle in the chat composer, which put it beside
   * the flags that describe *this* message — but it describes what happens on a
   * test run minutes later, and it does not apply to the reading pads at all.
   * It belongs with the rest of the failure decision, under When a case fails.
   */
  testForward: TestForwardMode;
  captureMode: CaptureMode;
  captureDestination: CaptureDestination;
  captureFolder: string;
  captureCountdown: number;
  offlineMerge: OfflineMergePolicy;
  pressureClip: number;
  inkSmoothing: number;
  inkSmoothingMode: InkSmoothingMode;
  inkSpeed: number;
  /** Ink Pooling strength: hold-to-grow and richer deposit (0–1). */
  inkSpeedBlotBlend: number;
  /** Nib material (0–1). */
  inkGrain: number;
  /** Pace wash toward pencil (0–1). */
  inkSpeedFade: number;
  /** Boost stroke opacity to compensate for Ink Pooling / fade (0–3). */
  inkBoldness: number;
  /** Eraser rubs pixels out, rather than taking whole strokes. */
  eraserPartial: boolean;
  /** Milliseconds between board autosaves; 0 is off. */
  autosaveMs: AutosaveInterval;
  /** Whether a successful autosave raises the chrome banner. */
  autosaveBanner: AutosaveBanner;
  /** Whether this device pushes itself to the hub on its own. */
  hubAutoSync: HubAutoSyncPref;
  /** ColourHunt tag the ink wheel asks for. */
  palettePrefs: PalettePrefs;
  /** Show ColorRadial on the drawing island (temporary colour until 1D Save). */
  colorWheelOnToolbar: boolean;
  /** Hub tap to apply a wheel pick. Off applies on the inner wedge. */
  tapOk: boolean;
  /** Hidden-chrome wake mark: smear, checkerboard pulse, or nothing. */
  chromeWake: ChromeWakeMarker;
  /** Recolor smear + checkerboard with a cycling gradient, or leave them mono. */
  chromeWakeTint: ChromeWakeTint;
  /** Show the live/pred/err pill while a PDF is flicked. */
  pdfFlickHud: boolean;
  /** 0–100; 0 stops on lift, 50 is the shipping coast, 100 is a long glide. */
  pdfFlickMomentum: number;
  /** Ink lab HUD on the whiteboard. */
  inkPerfOverlay: boolean;
  /** 5px load bar on the whiteboard. */
  inkPerfBar: boolean;
  /** Floating Hub Sync pill on the board chrome. Off keeps Sync in the tab. */
  hubSyncWindowPill: boolean;
  notificationCards: boolean;
  /** Display refresh for HUD vsync and live present cap. */
  inkDisplayHz: InkDisplayHzPref;
  /** Present every dirty vsync. Off keeps the 60fps cap on 90Hz+. */
  inkMatchDisplay: boolean;
}

function loadDevicePrefs(): DevicePrefs {
  return {
    headerModes: loadHeaderModes(),
    agentDisplay: loadAgentDisplayPrefs(),
    uiHandedness: loadUiHandedness(),
    uiCorners: loadUiCorners(),
    startupTabs: loadStartupTabs(),
    readingMode: loadReadingMode(),
    pageFit: loadPageFit(),
    showBooktabs: loadShowBooktabs(),
    showFootnoteTitles: loadShowFootnoteTitles(),
    booktabPosition: loadBooktabPosition(),
    booktabFootnotes: loadBooktabFootnotes(),
    handedness: loadInkHandedness(),
    testForward: loadTestForwardMode(),
    captureMode: loadCaptureMode(),
    captureDestination: loadCaptureDestination(),
    captureFolder: loadCaptureFolder(),
    captureCountdown: loadCaptureCountdown(),
    offlineMerge: loadOfflineMergePolicy(),
    pressureClip: loadInkPressureClip(),
    inkSmoothing: loadInkSmoothing(),
    inkSmoothingMode: loadInkSmoothingMode(),
    inkSpeed: loadInkSpeed(),
    inkSpeedBlotBlend: loadInkSpeedBlotBlend(),
    inkGrain: loadInkGrain(),
    inkSpeedFade: loadInkSpeedFade(),
    inkBoldness: loadInkBoldness(),
    eraserPartial: loadEraserPartial(),
    autosaveMs: loadAutosaveInterval(),
    autosaveBanner: loadAutosaveBanner(),
    hubAutoSync: loadHubAutosyncPref(),
    palettePrefs: loadPalettePrefs(),
    colorWheelOnToolbar: loadInkToolPresets().colorWheelOnToolbar,
    tapOk: loadInkToolPresets().tapOk,
    chromeWake: loadChromeWakeMarker(),
    chromeWakeTint: loadChromeWakeTint(),
    pdfFlickHud: loadPdfFlickHud(),
    pdfFlickMomentum: loadPdfFlickMomentum(),
    inkPerfOverlay: loadInkPerfOverlay(),
    inkPerfBar: loadInkPerfBar(),
    hubSyncWindowPill: loadHubSyncWindowPill(),
    notificationCards: loadNotificationCards(),
    inkDisplayHz: loadInkDisplayHz(),
    inkMatchDisplay: loadInkMatchDisplay(),
  };
}

function prefsEqual(a: DevicePrefs, b: DevicePrefs): boolean {
  return (
    HEADER_MODES.every(([mode]) => a.headerModes[mode] === b.headerModes[mode]) &&
    a.agentDisplay.autoCollapseThinking === b.agentDisplay.autoCollapseThinking &&
    a.agentDisplay.collapseThinkingSteps === b.agentDisplay.collapseThinkingSteps &&
    a.agentDisplay.colorThinkingSteps === b.agentDisplay.colorThinkingSteps &&
    a.uiHandedness === b.uiHandedness &&
    a.uiCorners === b.uiCorners &&
    a.startupTabs === b.startupTabs &&
    a.readingMode === b.readingMode &&
    a.pageFit === b.pageFit &&
    a.showBooktabs === b.showBooktabs &&
    a.showFootnoteTitles === b.showFootnoteTitles &&
    a.booktabPosition === b.booktabPosition &&
    a.booktabFootnotes === b.booktabFootnotes &&
    a.handedness === b.handedness &&
    a.testForward === b.testForward &&
    a.captureMode === b.captureMode &&
    a.captureDestination === b.captureDestination &&
    a.captureFolder === b.captureFolder &&
    a.captureCountdown === b.captureCountdown &&
    a.offlineMerge === b.offlineMerge &&
    a.pressureClip === b.pressureClip &&
    a.inkSmoothing === b.inkSmoothing &&
    a.inkSmoothingMode === b.inkSmoothingMode &&
    a.inkSpeed === b.inkSpeed &&
    a.inkSpeedBlotBlend === b.inkSpeedBlotBlend &&
    a.inkGrain === b.inkGrain &&
    a.inkSpeedFade === b.inkSpeedFade &&
    a.inkBoldness === b.inkBoldness &&
    a.eraserPartial === b.eraserPartial &&
    a.autosaveMs === b.autosaveMs &&
    a.autosaveBanner === b.autosaveBanner &&
    a.hubAutoSync === b.hubAutoSync &&
    JSON.stringify(a.palettePrefs) === JSON.stringify(b.palettePrefs) &&
    a.colorWheelOnToolbar === b.colorWheelOnToolbar &&
    a.tapOk === b.tapOk &&
    a.chromeWake === b.chromeWake &&
    a.chromeWakeTint === b.chromeWakeTint &&
    a.pdfFlickHud === b.pdfFlickHud &&
    a.pdfFlickMomentum === b.pdfFlickMomentum &&
    a.inkPerfOverlay === b.inkPerfOverlay &&
    a.inkPerfBar === b.inkPerfBar &&
    a.hubSyncWindowPill === b.hubSyncWindowPill &&
    a.notificationCards === b.notificationCards &&
    a.inkDisplayHz === b.inkDisplayHz &&
    a.inkMatchDisplay === b.inkMatchDisplay
  );
}

function configEqual(a: LcConfig, b: LcConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface SettingsModalProps {
  open: boolean;
  client: LcClient;
  onClose: () => void;
  onSaved?: () => void;
  /** Open on a specific tab (e.g. LLM from the LLM gate). */
  initialTab?: TabId;
  /** Live coach / LLM reachability for the LLM tab badge. */
  coachStatus?: "unknown" | "online" | "offline";
  coachDetail?: string | null;
}

/**
 * Say which half of the pairing is wrong.
 *
 * The address and the code fail in the same place and used to read the same
 * way, so a tablet that could not sync gave no clue whether to check the Wi-Fi
 * or check six digits.
 */
function padHubProblem(result: Extract<PadHubCheck, { ok: false }>): string {
  if (result.reason === "code") {
    return "The PC didn’t accept this code. Check the 6-digit code in Settings → Personalize → Storage → Sync with your PC on the PC.";
  }
  return `Nothing answered (${result.detail}). Check the URL, and that both devices are on the same Wi-Fi.`;
}

export function SettingsModal({
  open,
  client,
  onClose,
  onSaved,
  initialTab,
  coachStatus = "unknown",
  coachDetail = null,
}: SettingsModalProps) {
  const mobile = useIsMobile();
  const backdropDown = useRef(false);
  const [tab, setTab] = useState<TabId>(initialTab ?? "personalise");
  const [page, setPage] = useState("root");
  const [settingsQuery, setSettingsQuery] = useState("");
  const [draft, setDraft] = useState<LcConfig>(emptyConfig);
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  /** Separate from `busy` so a slow/hung GET /config cannot leave Save stuck disabled. */
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [providerFocus, setProviderFocus] = useState<(typeof PROVIDERS)[number]>("local");
  const [openaiKeyDraft, setOpenaiKeyDraft] = useState("");
  const [groqKeyDraft, setGroqKeyDraft] = useState("");
  const [clearOpenaiKey, setClearOpenaiKey] = useState(false);
  const [clearGroqKey, setClearGroqKey] = useState(false);
  const [deepgramKeyDraft, setDeepgramKeyDraft] = useState("");
  const [clearDeepgramKey, setClearDeepgramKey] = useState(false);
  const [datasets, setDatasets] = useState<DatasetInfo[]>([]);
  /**
   * What this origin is using, read once when Personalise opens.
   *
   * Not polled: the numbers are deliberately coarse (the spec lets the browser
   * pad them so storage cannot be used to fingerprint across origins), so a
   * live counter would be false precision on a figure that only needs to answer
   * "am I near the wall?".
   */
  const [storage, setStorage] = useState<(StorageUsage & { persisted: boolean }) | null>(null);
  /*
   * The document-copy sweep, and its answer.
   *
   * "Clear all" is armed by a first tap rather than a confirm dialog: it is the
   * destructive one of the three, and every other hold-to-confirm control in
   * this app works the same way.
   */
  const [docCache, setDocCache] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; facts: SettingsFact[] }
    | { kind: "failed"; facts: SettingsFact[] }
  >({ kind: "idle" });

  /** Duplicate strokes from older merges: counted, or removed on a hold. */
  const [inkDupes, setInkDupes] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; facts: SettingsFact[] }
    | { kind: "failed"; facts: SettingsFact[] }
  >({ kind: "idle" });
  const runInkDupes = useCallback(async (remove: boolean) => {
    setInkDupes({ kind: "busy" });
    try {
      const report = await auditInkDuplicates({ remove });
      const strokes = (n: number) => `${n.toLocaleString()} ${n === 1 ? "stroke" : "strokes"}`;
      const facts: SettingsFact[] = report.duplicates === 0
        ? [{ value: "No duplicate strokes.", tone: "ok" }]
        : remove
          ? [{ value: `Removed ${strokes(report.duplicates)} from ${report.pages} ${report.pages === 1 ? "page" : "pages"}. The pages look the same; the change syncs.`, tone: "ok" }]
          : [{ value: `${strokes(report.duplicates)} of ${report.strokes.toLocaleString()} are copies, on ${report.pages} ${report.pages === 1 ? "page" : "pages"} in ${report.books} ${report.books === 1 ? "document" : "documents"}.`, tone: "warn" }];
      setInkDupes({ kind: "done", facts });
    } catch (cause) {
      setInkDupes({ kind: "failed", facts: factsFromMessage(cause instanceof Error ? cause.message : String(cause)) });
    }
  }, []);

  const runDocCache = useCallback(
    async (action: "check" | "repair" | "clear" | "inspect") => {
      if (action === "inspect") {
        setDocCache({ kind: "busy" });
        try {
          const report = await inspectDocStore();
          setDocCache({
            kind: report.writeFailure ? "failed" : "done",
            facts: docStoreFacts(report),
          });
        } catch (cause) {
          setDocCache({
            kind: "failed",
            facts: factsFromMessage(
              `The document store could not be opened: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          });
        }
        return;
      }
      setDocCache({ kind: "busy" });
      try {
        const audit =
          action === "clear"
            ? await clearDocBytes()
            : await auditDocBytes({ repair: action === "repair" });
        const held = `${audit.rows} ${audit.rows === 1 ? "copy" : "copies"}`;
        if (action === "clear") {
          setDocCache({
            kind: "done",
            facts: factsFromMessage(
              `Cleared ${held}, freeing ${formatBytes(audit.freed)}. Pick each document again to bring it back.`,
            ),
          });
        } else if (audit.rows === 0) {
          // Not the same as healthy. An empty store on a device that has opened
          // documents means saving them is failing, and no repair touches that.
          setDocCache({
            kind: "failed",
            facts: factsFromMessage(
              "No stored copies at all. If you have opened documents on this device, saving them is failing — run Diagnose.",
            ),
          });
        } else if (audit.bad === 0) {
          setDocCache({
            kind: "done",
            facts: factsFromMessage(`${held} checked, all of them intact.`),
          });
        } else if (action === "repair") {
          setDocCache({
            kind: "done",
            facts: factsFromMessage(
              `Dropped ${audit.removed} bad ${audit.removed === 1 ? "copy" : "copies"} of ${held}, freeing ${formatBytes(audit.freed)}. Pick those documents again — the rest are untouched.`,
            ),
          });
        } else {
          setDocCache({
            kind: "done",
            facts: factsFromMessage(
              `${audit.bad} of ${held} no longer match the document they are filed under. Repair drops just those.`,
            ),
          });
        }
        // The bar above is now stale — re-read it rather than leave a number
        // that contradicts what this just reported.
        const usage = await estimateStorage().catch(() => null);
        if (usage) {
          setStorage((prev) => ({ ...usage, persisted: prev?.persisted ?? false }));
        }
      } catch (cause) {
        setDocCache({
          kind: "failed",
          facts: factsFromMessage(cause instanceof Error ? cause.message : String(cause)),
        });
      }
    },
    [],
  );
  /*
   * The local search index wipe, and its answer.
   *
   * Ask builds its index on this device over time; a stale one (old embedding
   * model, text from files long gone) can only be answered by dropping it all
   * and letting indexing start over. Deliberately local: when a pad hub is
   * set, the hub's docs.db is a different file on a different machine, and a
   * clear button that reaches past this device would be a surprise no label
   * carries. Armed by a first tap, like Clear all above.
   */
  const [indexWipe, setIndexWipe] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "done"; facts: SettingsFact[] }
    | { kind: "failed"; facts: SettingsFact[] }
  >({ kind: "idle" });
  const runIndexInspect = useCallback(
    async (detail: boolean) => {
      setIndexWipe({ kind: "busy" });
      try {
        const local = await client.listDocChunkDigestsLocal();
        if (!detail) {
          setIndexWipe({
            kind: "done",
            facts: indexFacts(local, "this device", { perDocument: false }),
          });
          return;
        }
        let hub = null as Awaited<ReturnType<typeof client.listDocChunkDigests>> | null;
        if (loadSavedPadHub()) {
          try {
            hub = await client.listDocChunkDigests();
          } catch (cause) {
            setIndexWipe({
              kind: "done",
              facts: [
                ...indexFacts(local, "this device"),
                {
                  label: "Hub",
                  value: `could not be read (${cause instanceof Error ? cause.message : String(cause)})`,
                  tone: "warn",
                },
              ],
            });
            return;
          }
        }
        setIndexWipe({ kind: "done", facts: compareIndexFacts(local, hub) });
      } catch (cause) {
        setIndexWipe({
          kind: "failed",
          facts: factsFromMessage(cause instanceof Error ? cause.message : String(cause)),
        });
      }
    },
    [client],
  );
  const runIndexWipe = useCallback(async () => {
    setIndexWipe({ kind: "busy" });
    try {
      const report = await client.clearLocalDocIndex();
      setIndexWipe({
        kind: "done",
        facts: factsFromMessage(
          `Cleared ${report.documents} ${report.documents === 1 ? "document" : "documents"} (${report.chunks} chunks). Ask rebuilds the index as documents are opened again.`,
        ),
      });
    } catch (cause) {
      setIndexWipe({
        kind: "failed",
        facts: factsFromMessage(cause instanceof Error ? cause.message : String(cause)),
      });
    }
  }, [client]);
  const [siblingDevices, setSiblingDevices] = useState<DevicePrefsDto[]>([]);
  /*
   * Register, then read back — in that order, and from wherever the device
   * calls now point.
   *
   * Pairing changes which database answers, so the roster has to be re-read
   * after a hub is saved, and this device has to put itself on the new one
   * first or the PC's list will not know it exists.
   */
  const refreshDevices = useCallback(async () => {
    await ensureDevicePrefs(client);
    setSiblingDevices(await client.listDevices());
  }, [client]);

  useEffect(() => {
    if (!open) return;
    const onHub = () => {
      void refreshDevices().catch(() => setSiblingDevices([]));
    };
    window.addEventListener(PAD_HUB_EVENT, onHub);
    return () => window.removeEventListener(PAD_HUB_EVENT, onHub);
  }, [open, refreshDevices]);
  const [chatBotClient, setChatBotClient] = useState<ChatBotClient>(loadChatBotClient);
  const [baselineChatBotClient, setBaselineChatBotClient] = useState<ChatBotClient>(loadChatBotClient);
  const [chatBotAnswerMode, setChatBotAnswerMode] = useState<ChatBotAnswerMode>(loadChatBotAnswerMode);
  const [baselineChatBotAnswerMode, setBaselineChatBotAnswerMode] = useState<ChatBotAnswerMode>(loadChatBotAnswerMode);
  const [runnerConfig, setRunnerConfig] = useState<AssistantRunnerConfig | null>(null);
  const [baselineRunnerConfig, setBaselineRunnerConfig] = useState<AssistantRunnerConfig | null>(null);
  const [runnerStatus, setRunnerStatus] = useState<AssistantRunnerStatus | null>(null);
  const [runnerError, setRunnerError] = useState<string | null>(null);
  const [runnerTesting, setRunnerTesting] = useState(false);
  useEffect(() => {
    if (!open) return;
    let current = true;
    setRunnerConfig(null); setBaselineRunnerConfig(null); setRunnerError(null); setRunnerStatus(null);
    void (async () => {
      try {
        const config = await client.assistantRunnerConfig();
        if (current) { setRunnerConfig(config); setBaselineRunnerConfig(config); }
      } catch {
        if (current) setRunnerError("Connect to your PC to set up the assistant app.");
      }
    })();
    return () => { current = false; };
  }, [open, client]);
  useEffect(() => {
    if (!open || chatBotAnswerMode !== "app") return;
    let current = true;
    const refresh = async () => {
      try {
        const status = await client.assistantRunnerStatus();
        if (current) setRunnerStatus(status);
      } catch { /* Connection guidance already appears with the app settings. */ }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => { current = false; window.clearInterval(timer); };
  }, [open, client, chatBotAnswerMode]);
  /** The last hand-edited vocabulary, so picking a preset and back to Custom restores it. */
  const [customVocabulary, setCustomVocabulary] = useState("");
  const [hubUrl, setHubUrl] = useState("");
  const [hubToken, setHubToken] = useState("");
  const [baselineHubUrl, setBaselineHubUrl] = useState("");
  const [baselineHubToken, setBaselineHubToken] = useState("");
  const [hubCheck, setHubCheck] = useState<
    | { kind: "idle" }
    | { kind: "busy" }
    | { kind: "ok"; message: string }
    | { kind: "bad"; message: string }
  >({ kind: "idle" });
  /** This PC's address on the LAN — the thing a tablet has to be told. */
  const [lanUrl, setLanUrl] = useState<string | null>(null);
  const [bootNotice, setBootNotice] = useState<string | null>(null);
  const [handedness, setHandedness] = useState<InkHandedness>(() => loadInkHandedness());
  const [uiHandedness, setUiHandedness] = useState<UiHandedness>(loadUiHandedness);
  const [uiCorners, setUiCorners] = useState<UiCorners>(loadUiCorners);
  const [startupTabs, setStartupTabs] = useState<StartupTabs>(loadStartupTabs);
  const [headerModes, setHeaderModes] = useState(loadHeaderModes);
  const [readingMode, setReadingMode] = useState<ReadingMode>(loadReadingMode);
  const [pageFit, setPageFit] = useState<PageFitPref>(loadPageFit);
  const [showBooktabs, setShowBooktabs] = useState(loadShowBooktabs);
  const [showFootnoteTitles, setShowFootnoteTitles] = useState(loadShowFootnoteTitles);
  const [booktabPosition, setBooktabPosition] = useState(loadBooktabPosition);
  const [booktabFootnotes, setBooktabFootnotes] = useState(loadBooktabFootnotes);
  const [agentDisplay, setAgentDisplay] = useState(loadAgentDisplayPrefs);
  const [colorWheelOnToolbar, setColorWheelOnToolbar] = useState(
    () => loadInkToolPresets().colorWheelOnToolbar,
  );
  const [tapOk, setTapOk] = useState(() => loadInkToolPresets().tapOk);
  const [chromeWake, setChromeWake] = useState<ChromeWakeMarker>(() =>
    loadChromeWakeMarker(),
  );
  const [chromeWakeTint, setChromeWakeTint] = useState<ChromeWakeTint>(() =>
    loadChromeWakeTint(),
  );
  const [pdfFlickHud, setPdfFlickHud] = useState(() => loadPdfFlickHud());
  const [pdfFlickMomentum, setPdfFlickMomentum] = useState(() => loadPdfFlickMomentum());
  const [inkPerfOverlay, setInkPerfOverlay] = useState(() => loadInkPerfOverlay());
  const [inkPerfBar, setInkPerfBar] = useState(() => loadInkPerfBar());
  const [hubSyncWindowPill, setHubSyncWindowPill] = useState(() => loadHubSyncWindowPill());
  const [notificationCards, setNotificationCards] = useState(() => loadNotificationCards());
  const [inkDisplayHz, setInkDisplayHz] = useState<InkDisplayHzPref>(() => loadInkDisplayHz());
  const [inkMatchDisplay, setInkMatchDisplay] = useState(() => loadInkMatchDisplay());
  // The debug log switch waits for Save like every other setting.
  const [debugLog, setDebugLog] = useState(debugLogEnabled);
  const [baselineDebugLog, setBaselineDebugLog] = useState(debugLogEnabled);
  const [testForward, setTestForward] = useState<TestForwardMode>(() =>
    loadTestForwardMode(),
  );
  const [captureMode, setCaptureMode] = useState<CaptureMode>(() => loadCaptureMode());
  const [captureDestination, setCaptureDestination] = useState<CaptureDestination>(() =>
    loadCaptureDestination(),
  );
  const [captureFolder, setCaptureFolder] = useState(() => loadCaptureFolder());
  const [captureCountdown, setCaptureCountdown] = useState(() => loadCaptureCountdown());
  const [offlineMerge, setOfflineMerge] = useState<OfflineMergePolicy>(() =>
    loadOfflineMergePolicy(),
  );
  const [pressureClip, setPressureClip] = useState(() => loadInkPressureClip());
  const [inkSmoothing, setInkSmoothing] = useState(() => loadInkSmoothing());
  const [inkSmoothingMode, setInkSmoothingMode] = useState<InkSmoothingMode>(() =>
    loadInkSmoothingMode(),
  );
  const [inkSpeed, setInkSpeed] = useState(() => loadInkSpeed());
  const [inkSpeedBlotBlend, setInkSpeedBlotBlend] = useState(() => loadInkSpeedBlotBlend());
  const [inkGrain, setInkGrain] = useState(() => loadInkGrain());
  const [inkSpeedFade, setInkSpeedFade] = useState(() => loadInkSpeedFade());
  const [inkBoldness, setInkBoldness] = useState(() => loadInkBoldness());
  const [eraserPartial, setEraserPartial] = useState(() => loadEraserPartial());
  const [autosaveMs, setAutosaveMs] = useState<AutosaveInterval>(() =>
    loadAutosaveInterval(),
  );
  const [autosaveBanner, setAutosaveBanner] = useState<AutosaveBanner>(() =>
    loadAutosaveBanner(),
  );
  const [hubAutoSync, setHubAutoSync] = useState<HubAutoSyncPref>(() =>
    loadHubAutosyncPref(),
  );
  /* Draft until Save — dirty detection includes this so Save enables. */
  const [palettePrefs, setPalettePrefs] = useState<PalettePrefs>(loadPalettePrefs);
  /** Last saved config + device prefs — Cancel restores these; Save advances them. */
  const [baselineConfig, setBaselineConfig] = useState<LcConfig>(emptyConfig);
  const [baselinePrefs, setBaselinePrefs] = useState<DevicePrefs>(loadDevicePrefs);
  const [dlcRows, setDlcRows] = useState<DlcStatus[]>([]);

  const refreshLlm = useCallback(async () => {
    try {
      setLlmStatus(await client.llmStatus());
    } catch {
      setLlmStatus(null);
    }
  }, [client]);

  /**
   * What the focused provider could be pointed at. Read-only: it fills the
   * model list and reports what the server says about images, but the vision
   * flag stays the reader's to tick — a name is not a capability.
   */
  const catalogGenRef = useRef(0);
  const refreshCatalog = useCallback(
    async (provider: string) => {
      /*
       * Only the newest request may answer.
       *
       * Every result used to be committed unconditionally, so switching
       * providers faster than the slower one replied let the *old* provider's
       * models land in the list — and stay there, under the new provider's
       * name, until something else refreshed it.
       */
      const gen = ++catalogGenRef.current;
      setCatalogBusy(true);
      try {
        const models = await client.listModels(provider);
        if (gen !== catalogGenRef.current) return;
        setCatalog(models);
      } catch {
        if (gen !== catalogGenRef.current) return;
        setCatalog(null);
      } finally {
        if (gen === catalogGenRef.current) setCatalogBusy(false);
      }
    },
    [client],
  );

  // The list is per provider, so a tab switch invalidates it. Clearing first
  // stops the previous provider's models being offered for this one.
  const showingLlm = open && (tab === "llm" || page === "llm");
  useEffect(() => {
    if (!showingLlm) return;
    setCatalog(null);
    void refreshCatalog(providerFocus);
  }, [showingLlm, providerFocus, refreshCatalog]);

  /** Re-read on each visit to Personalise, so it reflects the session just saved. */
  useEffect(() => {
    if (tab !== "personalise") return;
    let cancelled = false;
    void (async () => {
      const usage = await estimateStorage();
      if (cancelled || !usage) return;
      let persisted = false;
      try {
        persisted = (await navigator.storage?.persisted?.()) ?? false;
      } catch {
        /* absent in some WebViews — the bar is still worth showing */
      }
      if (!cancelled) setStorage({ ...usage, persisted });
    })();
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const refreshDlc = useCallback(async () => {
    try {
      const rows = await client.dlcStatus();
      if (Array.isArray(rows)) setDlcRows(current => mergeDlcStatus(current, rows));
    } catch {
      // Retain the last known status during a transient request failure.
    }
    try {
      setDatasets(await client.datasets());
    } catch {
      /* older daemon has no /datasets */
    }
  }, [client]);

  /*
   * DLC status: the event bus where there is one, a poll only where there is not.
   *
   * This used to do both — a listener *and* a request every 1.5 seconds, for
   * as long as the page was open, even though the listener was already
   * reporting every change. The poll is the fallback for browser preview,
   * where there is no Tauri event bus to subscribe to, so it belongs in the
   * `catch` and nowhere else.
   */
  useEffect(() => {
    if (!open || tab !== "workspace") return;
    void refreshDlc();
    let cancelled = false;
    let stop: (() => void) | undefined;
    let timer = 0;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<DlcStatus[]>("lc-dlc-status", (event) => {
          if (!Array.isArray(event.payload)) return;
          setDlcRows(current => mergeDlcStatus(current, event.payload));
          setDatasets((current) =>
            current.map((entry) => {
              const row = event.payload.find((item) => item.slug === entry.id);
              return row ? { ...entry, count: row.count } : entry;
            }),
          );
        }),
      )
      .then((unlisten) => {
        if (cancelled) {
          unlisten();
          return;
        }
        stop = unlisten;
      })
      .catch(() => {
        /* browser preview has no Tauri event bus — ask instead */
        if (cancelled) return;
        timer = window.setInterval(() => void refreshDlc(), DLC_POLL_MS);
      });
    return () => {
      cancelled = true;
      stop?.();
      window.clearInterval(timer);
    };
  }, [open, tab, refreshDlc]);

  const onDlcInstall = useCallback(
    (slug: string) => {
      setDlcRows(current => current.map(row => row.slug === slug
        ? {...row,phase:"starting",progress:-1,error:null,downloaded:0,total:0} : row));
      void client.dlcInstall(slug).then((row) => {
        if (!row?.slug) return;
        setDlcRows(current => mergeDlcStatus(current, [row]));
      }).catch((cause) => {
        const error = cause instanceof Error ? cause.message : String(cause);
        setDlcRows(current => current.map(row => row.slug === slug ? {...row,phase:"error",error} : row));
      });
    },
    [client],
  );

  const onDlcRemove = useCallback(
    (slug: string) => {
      void client.dlcRemove(slug).then((row) => {
        if (!row?.slug) return;
        setDlcRows(current => mergeDlcStatus(current, [row]));
      }).catch((cause) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [client],
  );

  const restoreDeviceDraft = (prefs: DevicePrefs) => {
    setHeaderModes(prefs.headerModes);
    setHandedness(prefs.handedness);
    setUiHandedness(prefs.uiHandedness);
    setUiCorners(prefs.uiCorners);
    setStartupTabs(prefs.startupTabs);
    setReadingMode(prefs.readingMode);
    setPageFit(prefs.pageFit);
    setShowBooktabs(prefs.showBooktabs);
    setShowFootnoteTitles(prefs.showFootnoteTitles);
    setBooktabPosition(prefs.booktabPosition);
    setBooktabFootnotes(prefs.booktabFootnotes);
    setAgentDisplay(prefs.agentDisplay);
    setTestForward(prefs.testForward);
    setCaptureMode(prefs.captureMode);
    setCaptureDestination(prefs.captureDestination);
    setCaptureFolder(prefs.captureFolder);
    setCaptureCountdown(prefs.captureCountdown);
    setOfflineMerge(prefs.offlineMerge);
    setPressureClip(prefs.pressureClip);
    setInkSmoothing(prefs.inkSmoothing);
    setInkSmoothingMode(prefs.inkSmoothingMode);
    setInkSpeed(prefs.inkSpeed);
    setInkSpeedBlotBlend(prefs.inkSpeedBlotBlend);
    setInkGrain(prefs.inkGrain ?? 0);
    setInkSpeedFade(prefs.inkSpeedFade);
    setInkBoldness(prefs.inkBoldness);
    setEraserPartial(prefs.eraserPartial);
    setAutosaveMs(prefs.autosaveMs);
    setAutosaveBanner(prefs.autosaveBanner);
    setHubAutoSync(prefs.hubAutoSync);
    setPalettePrefs(prefs.palettePrefs);
    setColorWheelOnToolbar(prefs.colorWheelOnToolbar);
    setTapOk(prefs.tapOk);
    setChromeWake(prefs.chromeWake);
    setChromeWakeTint(prefs.chromeWakeTint);
    setPdfFlickHud(prefs.pdfFlickHud);
    setPdfFlickMomentum(prefs.pdfFlickMomentum);
    setInkPerfOverlay(prefs.inkPerfOverlay);
    setInkPerfBar(prefs.inkPerfBar);
    setHubSyncWindowPill(prefs.hubSyncWindowPill);
    setNotificationCards(prefs.notificationCards);
    setInkDisplayHz(prefs.inkDisplayHz);
    setInkMatchDisplay(prefs.inkMatchDisplay);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(null);
    setBusy("loading…");
    const prefs = loadDevicePrefs();
    restoreDeviceDraft(prefs);
    setBaselinePrefs(prefs);
    // Saved only: the desktop that *is* the hub runs on a loopback it never
    // typed, and showing that here would read as "connected to some other PC".
    const savedChatBot = loadChatBotClient();
    setChatBotClient(savedChatBot);
    setBaselineChatBotClient(savedChatBot);
    const savedAnswerMode = loadChatBotAnswerMode();
    setChatBotAnswerMode(savedAnswerMode);
    setBaselineChatBotAnswerMode(savedAnswerMode);
    const hub = loadSavedPadHub();
    setHubUrl(hub?.url ?? "");
    setHubToken(hub?.token ?? "");
    setBaselineHubUrl(hub?.url ?? "");
    setBaselineHubToken(hub?.token ?? "");
    setHubCheck({ kind: "idle" });
    if (initialTab) setTab(initialTab);
    setPage("writing");
    setSettingsQuery("");
    void (async () => {
      try {
        const cfg = await client.getConfig();
        if (!cancelled) {
          setDraft(cfg);
          setBaselineConfig(cfg);
          setOpenaiKeyDraft("");
          setGroqKeyDraft("");
          setDeepgramKeyDraft("");
          setClearOpenaiKey(false);
          setClearGroqKey(false);
          setClearDeepgramKey(false);
          setBusy(null);
          const url = await client.lanBaseUrl(cfg.serve_port);
          if (!cancelled) setLanUrl(url);
        }
        await refreshLlm();
        try {
          const notice = await client.bootNotice();
          if (!cancelled) setBootNotice(notice);
        } catch {
          if (!cancelled) setBootNotice(null);
        }
        try {
          const all = await client.datasets();
          if (!cancelled) setDatasets(all);
        } catch {
          // An older daemon has no /datasets — the tab just says so.
          if (!cancelled) setDatasets([]);
        }
        try {
          await refreshDevices();
        } catch {
          if (!cancelled) setSiblingDevices([]);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setBusy(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, client, refreshLlm, initialTab]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || saving) return;
      event.preventDefault();
      if (page !== "root") setPage("root");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, page, onClose, saving]);


  const draftPrefs: DevicePrefs = {
    headerModes,
    agentDisplay,
    uiHandedness,
    uiCorners,
    startupTabs,
    readingMode,
    pageFit,
    showBooktabs,
    showFootnoteTitles,
    booktabPosition,
    booktabFootnotes,
    handedness,
    testForward,
    captureMode,
    captureDestination,
    captureFolder,
    captureCountdown,
    offlineMerge,
    pressureClip,
    inkSmoothing,
    inkSmoothingMode,
    inkSpeed,
    inkSpeedBlotBlend,
    inkGrain,
    inkSpeedFade,
    inkBoldness,
    eraserPartial,
    autosaveMs,
    autosaveBanner,
    hubAutoSync,
    palettePrefs,
    colorWheelOnToolbar,
    tapOk,
    chromeWake,
    chromeWakeTint,
    pdfFlickHud,
    pdfFlickMomentum,
    inkPerfOverlay,
    inkPerfBar,
    hubSyncWindowPill,
    notificationCards,
    inkDisplayHz,
    inkMatchDisplay,
  };
  const keysDirty =
    openaiKeyDraft.trim() !== "" ||
    groqKeyDraft.trim() !== "" ||
    deepgramKeyDraft.trim() !== "" ||
    clearOpenaiKey ||
    clearGroqKey ||
    clearDeepgramKey;
  const dirty =
    !configEqual(draft, baselineConfig) ||
    !prefsEqual(draftPrefs, baselinePrefs) ||
    keysDirty ||
    hubUrl.trim() !== baselineHubUrl ||
    hubToken.trim() !== baselineHubToken ||
    debugLog !== baselineDebugLog || chatBotClient !== baselineChatBotClient || chatBotAnswerMode !== baselineChatBotAnswerMode ||
    JSON.stringify(runnerConfig) !== JSON.stringify(baselineRunnerConfig);

  const changeCount = countSettingsChanges(draftPrefs, baselinePrefs)
    + countSettingsChanges({...draft, coach: {...DEFAULT_COACH_FLAGS, ...draft.coach}}, {...baselineConfig, coach: {...DEFAULT_COACH_FLAGS, ...baselineConfig.coach}})
    + Number(Boolean(openaiKeyDraft.trim()) || clearOpenaiKey)
    + Number(Boolean(groqKeyDraft.trim()) || clearGroqKey)
    + Number(Boolean(deepgramKeyDraft.trim()) || clearDeepgramKey)
    + Number(hubUrl.trim() !== baselineHubUrl) + Number(hubToken.trim() !== baselineHubToken)
    + Number(debugLog !== baselineDebugLog) + Number(chatBotClient !== baselineChatBotClient) + Number(chatBotAnswerMode !== baselineChatBotAnswerMode)
    + countSettingsChanges(runnerConfig ?? {}, baselineRunnerConfig ?? {});
  const prefGroups: Record<string, (keyof DevicePrefs)[]> = {
    writing: ["handedness", "chromeWake", "chromeWakeTint", "captureMode", "captureDestination", "captureFolder", "captureCountdown", "inkMatchDisplay", "pressureClip", "inkSmoothing", "inkSmoothingMode", "inkSpeed", "inkSpeedBlotBlend", "inkGrain", "inkSpeedFade", "inkBoldness", "eraserPartial"],
    "ink-tools": ["tapOk", "colorWheelOnToolbar", "palettePrefs"],
    reading: ["pdfFlickMomentum"],
    storage: ["autosaveMs", "autosaveBanner", "hubAutoSync", "offlineMerge"],
    ui: ["headerModes", "uiHandedness", "uiCorners", "startupTabs", "readingMode", "pageFit", "showBooktabs", "booktabPosition", "booktabFootnotes", "showFootnoteTitles", "agentDisplay", "notificationCards"],
    diagnostics: ["inkDisplayHz", "inkPerfOverlay", "inkPerfBar", "pdfFlickHud", "hubSyncWindowPill"],
    tests: ["testForward"],
  };
  const configGroups: Record<string, (keyof LcConfig)[]> = {
    paths: ["data_json_dir", "workspace_dir"], datasets: ["dataset_dirs"], tests: ["stop_on_first_failure"],
    llm: ["default_provider", "models_dir", "local", "ollama", "openai", "groq", "modes", "serve_port", "serve_token"],
    voice: ["voice"],
  };
  const select = <T extends object,>(value: T, fields: (keyof T)[]) => Object.fromEntries(fields.map(key => [key, value[key]]));
  const changes = Object.fromEntries([...new Set([...Object.keys(prefGroups), ...Object.keys(configGroups)])].map(id => [id,
    countSettingsChanges(select(draftPrefs, prefGroups[id] ?? []), select(baselinePrefs, prefGroups[id] ?? []))
    + countSettingsChanges(select(draft, configGroups[id] ?? []), select(baselineConfig, configGroups[id] ?? []))
  ]));
  const sharedUiFlags: (keyof CoachFlags)[] = ["ws_runs", "process_events_ui"];
  const coachChanges = (fields: (keyof CoachFlags)[]) => countSettingsChanges(
    select({...DEFAULT_COACH_FLAGS, ...draft.coach}, fields), select({...DEFAULT_COACH_FLAGS, ...baselineConfig.coach}, fields));
  changes.ui = (changes.ui ?? 0) + coachChanges(sharedUiFlags);
  for (const group of COACH_FLAG_GROUPS) changes[group.id] = coachChanges(group.flags.map(([key]) => key));
  changes.storage = (changes.storage ?? 0) + Number(hubUrl.trim() !== baselineHubUrl) + Number(hubToken.trim() !== baselineHubToken);
  changes.diagnostics = (changes.diagnostics ?? 0) + Number(debugLog !== baselineDebugLog);
  changes.llm = (changes.llm ?? 0) + Number(Boolean(openaiKeyDraft.trim()) || clearOpenaiKey) + Number(Boolean(groqKeyDraft.trim()) || clearGroqKey);
  changes.chatbot = Number(chatBotClient !== baselineChatBotClient) + Number(chatBotAnswerMode !== baselineChatBotAnswerMode)
    + countSettingsChanges(runnerConfig ?? {}, baselineRunnerConfig ?? {});
  changes.voice = (changes.voice ?? 0) + Number(Boolean(deepgramKeyDraft.trim()) || clearDeepgramKey);
  const resetGroup = (id: string) => {
    if (saving) return;
    restoreDeviceDraft({...draftPrefs, ...select(baselinePrefs, prefGroups[id] ?? [])});
    const coachFields = id === "ui" ? sharedUiFlags : COACH_FLAG_GROUPS.find(group => group.id === id)?.flags.map(([key]) => key) ?? [];
    setDraft(prev => ({...prev, ...select(baselineConfig, configGroups[id] ?? []),
      coach: {...DEFAULT_COACH_FLAGS, ...prev.coach, ...select({...DEFAULT_COACH_FLAGS, ...baselineConfig.coach}, coachFields)}}));
    if (id === "chatbot") { setChatBotClient(baselineChatBotClient); setChatBotAnswerMode(baselineChatBotAnswerMode); setRunnerConfig(baselineRunnerConfig); }
    if (id === "storage") { setHubUrl(baselineHubUrl); setHubToken(baselineHubToken); }
    if (id === "diagnostics") setDebugLog(baselineDebugLog);
    if (id === "llm") { setOpenaiKeyDraft(""); setGroqKeyDraft(""); setClearOpenaiKey(false); setClearGroqKey(false); }
    if (id === "voice") { setDeepgramKeyDraft(""); setClearDeepgramKey(false); }
  };
  const voice = { ...DEFAULT_VOICE_CONFIG, ...draft.voice };
  const voiceLabel = VOICE_ENGINES.find((engine) => engine.id === voice.engine)?.label ?? "Android";
  const summaries: Record<string,string> = {
    writing: `${handedness === "left" ? "Left hand" : "Right hand"} · ${chromeWake === "off" ? "No marker" : chromeWake === "pulse" ? "Pulsing squares" : "Faint smudge"}`,
    "ink-tools": `${palettePrefs.tags.map(paletteTagLabel).join(", ")}${palettePrefs.mixColours ? " · Mix colors" : ""}`,
    reading: `Momentum ${pdfFlickMomentum}`,
    storage: `${autosaveMs ? `Autosave ${autosaveMs/1000}s` : "Autosave off"} / ${hubAutoSync === "off" ? "Manual sync" : "Auto sync"}`,
    ui: `${uiHandedness === "left" ? "Left hand" : "Right hand"} · ${readingMode === "pages" ? "Pages" : "Scroll"}`,
    diagnostics: [inkPerfOverlay && "Speed overlay", inkPerfBar && "Speed bar", pdfFlickHud && "Page preview", hubSyncWindowPill && "Sync button", debugLog && "Activity log"].filter(Boolean).join(" · ") || "Off", paths: draft.workspace_dir,
    datasets: `${datasets.length} datasets`, tests: draft.stop_on_first_failure ? "Stop at first failure" : "Run all cases",
    llm: `${PROVIDER_LABELS[draft.default_provider as (typeof PROVIDERS)[number]] ?? draft.default_provider} · ${draft[draft.default_provider as keyof Pick<LcConfig,"local"|"ollama"|"openai"|"groq">]?.model || "No model selected"}`,
    chatbot: chatBotAnswerMode === "app" ? runnerConfig?.app === "claude" ? "Claude Code on your PC" : "Codex on your PC"
      : chatBotAnswerMode === "llm" ? "Your AI model" : CHATBOT_CLIENTS.find(client => client.id === chatBotClient)?.label ?? "Other assistant",
    voice: `${voice.engine === "android" ? voiceLabel : `${voiceLabel} · ${voiceClipModel(voice)}`}${voice.cleanup !== "off" ? ` · tidy: ${voice.cleanup}` : ""}`,
    ...Object.fromEntries(COACH_FLAG_GROUPS.map(group=>[group.id, `${group.flags.filter(([key])=>(draft.coach ?? DEFAULT_COACH_FLAGS)[key]).length} of ${group.flags.length} on`])),
  };

  const patchProvider = (key: "local" | "ollama" | "openai" | "groq", patch: Partial<ProviderConfig>) => {
    setDraft((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }));
  };

  const patchVoice = (patch: Partial<VoiceConfig>) => {
    setDraft(prev => ({ ...prev, voice: { ...DEFAULT_VOICE_CONFIG, ...prev.voice, ...patch } }));
  };

  const cancel = () => {
    if (saving) return;
    // Nothing persisted mid-edit — closing drops the draft. Baseline stays on disk.
    onClose();
  };

  /** How long Save waits on PUT /config before surfacing an error. */
  const CONFIG_SAVE_TIMEOUT_MS = 30_000;

  const save = async (opts?: { close?: boolean }) => {
    const shouldClose = opts?.close !== false;
    if (!dirty) {
      if (shouldClose) onClose();
      return;
    }
    setSaving(true);
    setError(null);
    const prefsDirty = !prefsEqual(draftPrefs, baselinePrefs);
    const configDirty = !configEqual(draft, baselineConfig) || keysDirty;
    try {
      // Device prefs never need the daemon — persist them even if PUT /config fails.
      if (prefsDirty) {
        saveInkHandedness(handedness);
        saveUiHandedness(uiHandedness);
        saveUiCorners(uiCorners);
        saveHeaderModes(headerModes);
        saveStartupTabs(startupTabs);
        saveReadingMode(readingMode);
        savePageFit(pageFit);
        saveShowBooktabs(showBooktabs);
        saveShowFootnoteTitles(showFootnoteTitles);
        saveBooktabPosition(booktabPosition);
        saveBooktabFootnotes(booktabFootnotes);
        saveAgentDisplayPrefs(agentDisplay);
        saveTestForwardMode(testForward);
        saveCaptureMode(captureMode);
        saveCaptureDestination(captureDestination);
        saveCaptureFolder(captureFolder);
        saveCaptureCountdown(captureCountdown);
        saveOfflineMergePolicy(offlineMerge);
        saveInkPressureClip(pressureClip);
        saveInkSmoothing(inkSmoothing);
        saveInkSmoothingMode(inkSmoothingMode);
        saveInkSpeed(inkSpeed);
        saveInkSpeedBlotBlend(inkSpeedBlotBlend);
        saveInkGrain(inkGrain);
        saveInkSpeedFade(inkSpeedFade);
        saveInkBoldness(inkBoldness);
        saveEraserPartial(eraserPartial);
        saveAutosaveInterval(autosaveMs);
        saveAutosaveBanner(autosaveBanner);
        saveHubAutosyncPref(hubAutoSync);
        savePalettePrefs(palettePrefs);
        saveInkToolPresets({
          ...loadInkToolPresets(),
          colorWheelOnToolbar,
          tapOk,
        });
        saveChromeWakeMarker(chromeWake);
        saveChromeWakeTint(chromeWakeTint);
        savePdfFlickHud(pdfFlickHud);
        savePdfFlickMomentum(pdfFlickMomentum);
        saveInkPerfOverlay(inkPerfOverlay);
        saveInkPerfBar(inkPerfBar);
        saveHubSyncWindowPill(hubSyncWindowPill);
        saveNotificationCards(notificationCards);
        saveInkDisplayHz(inkDisplayHz);
        saveInkMatchDisplay(inkMatchDisplay);
        setBaselinePrefs(draftPrefs);
        void saveThisDevicePrefs(client).catch(() => {});
        window.dispatchEvent(
          new CustomEvent<InkHandedness>("lc-ink-handedness", { detail: handedness }),
        );
        window.dispatchEvent(
          new CustomEvent<TestForwardMode>("lc-agent-test-forward", {
            detail: testForward,
          }),
        );
        window.dispatchEvent(new CustomEvent("lc-ink-pressure-clip"));
        window.dispatchEvent(new CustomEvent("lc-ink-smoothing"));
        window.dispatchEvent(new CustomEvent("lc-ink-speed"));
        window.dispatchEvent(new CustomEvent(INK_SPEED_BLOT_BLEND_EVENT));
        window.dispatchEvent(new CustomEvent(INK_GRAIN_EVENT));
        window.dispatchEvent(new CustomEvent(INK_SPEED_FADE_EVENT));
        window.dispatchEvent(new CustomEvent(INK_BOLDNESS_EVENT));
        window.dispatchEvent(new CustomEvent(ERASER_PARTIAL_EVENT));
        window.dispatchEvent(new CustomEvent(AUTOSAVE_EVENT));
        window.dispatchEvent(new CustomEvent(HUB_AUTOSYNC_EVENT));
        window.dispatchEvent(new CustomEvent(CHROME_WAKE_EVENT));
        window.dispatchEvent(new CustomEvent(PDF_READING_EVENT));
      }
      if (chatBotClient !== baselineChatBotClient) {
        saveChatBotClient(chatBotClient);
        setBaselineChatBotClient(chatBotClient);
      }
      if (debugLog !== baselineDebugLog) {
        setDebugLogEnabled(debugLog);
        setBaselineDebugLog(debugLog);
      }
      const hubDirty =
        hubUrl.trim() !== baselineHubUrl || hubToken.trim() !== baselineHubToken;
      if (hubDirty) {
        const url = hubUrl.trim();
        const token = hubToken.trim();
        if (Boolean(url) !== Boolean(token) || (token && !/^\d{6}$/.test(token))) {
          throw new Error("Enter both the PC address and the 6-digit code.");
        }
        savePadHub(url && token ? { url, token } : null);
        setBaselineHubUrl(url);
        setBaselineHubToken(token);
        if (url && token) {
          // Store first, then ask. Saving a pair that turns out not to work is
          // still worth keeping — the reader is one digit away from a fix and
          // should not have to retype the address to try it. But it must not
          // pass in silence: a hub that was never reached looks exactly like a
          // hub that was, until the day a file fails to arrive.
          const result = await runHubCheck({ url, token });
          if (!result.ok) throw new Error(`Saved, but not connected. ${padHubProblem(result)}`);
        } else {
          setHubCheck({ kind: "idle" });
        }
      }
      if (chatBotAnswerMode === "app" && !runnerConfig) throw new Error("Connect to your PC to set up the assistant app.");
      if (runnerConfig && JSON.stringify(runnerConfig) !== JSON.stringify(baselineRunnerConfig)) {
        const saved = await client.putAssistantRunnerConfig(runnerConfig);
        setRunnerConfig(saved); setBaselineRunnerConfig(saved);
      }
      if (chatBotAnswerMode !== baselineChatBotAnswerMode) {
        saveChatBotAnswerMode(chatBotAnswerMode);
        setBaselineChatBotAnswerMode(chatBotAnswerMode);
      }
      if (configDirty) {
        const payload: LcConfigPut = { ...draft };
        if (openaiKeyDraft.trim()) payload.openai_api_key = openaiKeyDraft.trim();
        else if (clearOpenaiKey) payload.openai_api_key = "";
        if (groqKeyDraft.trim()) payload.groq_api_key = groqKeyDraft.trim();
        else if (clearGroqKey) payload.groq_api_key = "";
        if (deepgramKeyDraft.trim()) payload.deepgram_api_key = deepgramKeyDraft.trim();
        else if (clearDeepgramKey) payload.deepgram_api_key = "";
        const saved = await client.putConfig(payload, { timeoutMs: CONFIG_SAVE_TIMEOUT_MS });
        setDraft(saved);
        setBaselineConfig(saved);
        setOpenaiKeyDraft("");
        setGroqKeyDraft("");
        setDeepgramKeyDraft("");
        setClearOpenaiKey(false);
        setClearGroqKey(false);
        setClearDeepgramKey(false);
      }
      onSaved?.();
      if (shouldClose) onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const runHubCheck = async (hub: { url: string; token: string }): Promise<PadHubCheck> => {
    setHubCheck({ kind: "busy" });
    const result = await checkPadHub(hub);
    setHubCheck(
      result.ok
        ? {
            kind: "ok",
            message: result.version
              ? `Connected — this PC is running Pen Island ${result.version}.`
              : "Connected.",
          }
        : { kind: "bad", message: padHubProblem(result) },
    );
    return result;
  };

  const startLlm = async () => {
    setBusy("starting local LLM…");
    setError(null);
    try {
      setLlmStatus(await client.llmStart());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const stopLlm = async () => {
    setBusy("stopping local LLM…");
    setError(null);
    try {
      setLlmStatus(await client.llmStop());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const provider = draft[providerFocus];
  const selectedModel = catalog?.models.find((entry) => entry.id === provider.model.trim());
  const modelListHint = modelHint(catalog, catalogBusy, provider.model.trim(), selectedModel);
  const visionHint = visionEvidence(catalog, selectedModel, provider.vision === true);
  const searching = Boolean(settingsQuery.trim());
  /** App, model, effort and Test for the assistant app on this PC. */
  const renderRunnerFields = (config: AssistantRunnerConfig) => (
    <div className="lc-settings-fields">
        <p className="lc-settings-hint">These settings are saved on your PC.</p>
        <label><span>App</span><select aria-label="Assistant app" value={config.app}
          onChange={event => setRunnerConfig({ ...config, app: event.target.value as AssistantRunnerConfig["app"] })}>
          <option value="codex">Codex</option><option value="claude">Claude Code</option>
        </select></label>
        <label><span>Model (optional)</span><input aria-label="Assistant app model" value={config.model} maxLength={200}
          placeholder="Use the app's default" onChange={event => setRunnerConfig({ ...config, model: event.target.value })} /></label>
        {config.app === "codex" ? <label><span>Effort</span><select aria-label="Assistant app effort" value={config.effort}
          onChange={event => setRunnerConfig({ ...config, effort: event.target.value as AssistantRunnerConfig["effort"] })}>
          <option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option>
        </select></label> : null}
        <div className="lc-settings-actions-row"><button type="button" className="lc-secondary lc-dialog-action" disabled={runnerTesting || saving}
          onClick={() => {
            setRunnerTesting(true); setRunnerError(null);
            void client.testAssistantRunner(config).then(setRunnerStatus).catch(() => {
              setRunnerError("The assistant app couldn't finish its check. Make sure it is installed and signed in on your PC.");
            }).finally(() => setRunnerTesting(false));
          }}>{runnerTesting ? "Testing…" : "Test"}</button></div>
        <p className="lc-settings-hint">Test checks the connection without answering requests.</p>
      </div>
  );

  return <DialogPresence>{open && (
    <DialogBackdrop className="lc-settings-backdrop" role="presentation"
      onPointerDown={e=>{backdropDown.current=e.target===e.currentTarget;}}
      onPointerCancel={()=>{backdropDown.current=false;}}
      onClick={e=>{const started=backdropDown.current;backdropDown.current=false;if(shouldDismissBackdrop(started,e.target,e.currentTarget))cancel();}}>
      <DialogFrame className="lc-settings-dialog" titleId="lc-settings-dialog-title" title="Settings" subtitle="Every tab · Every workspace" shape="blocky" onClose={cancel} closeDisabled={saving}
        icon={<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><path d="M5 3v18M12 3v18M19 3v18M2 8h6m1 8h6m1-8h6"/></svg>}>
        <div className="lc-dialog-context"><label className="lc-settings-command">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" aria-hidden="true"><circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/></svg>
          <input type="search" aria-label="Search settings" placeholder="Search settings..." value={settingsQuery} onChange={event=>setSettingsQuery(event.target.value)}/>
        </label></div>
        <SettingsPageCtx.Provider value={{page,open:setPage,query:settingsQuery,summaries,changes,reset:resetGroup,saving}}>
        <div className="lc-settings-tabs" role="tablist">
          {TABS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={tab === entry.id}
              className={tab === entry.id ? "lc-settings-tab is-active" : "lc-settings-tab"}
              onClick={() => { setTab(entry.id); setPage("root"); setSettingsQuery(""); }}
            >
              <SettingsIcon id={entry.id === "personalise" ? "diagnostics" : entry.id === "workspace" ? "paths" : entry.id}/>
              {entry.label}
            </button>
          ))}
        </div>

        <div className="lc-settings-body lc-dialog-body lc-scroll-pane">
          {bootNotice && (
            <div className="lc-warning">
              Running on built-in defaults — this device’s config file did not
              load ({bootNotice}). Saving here writes the defaults over it.
            </div>
          )}
          {error && <div className="lc-warning">{error}</div>}
          {busy && <div className="lc-muted">{busy}</div>}

          {(tab === "workspace" || searching) && FEATURE_LEETCODE && (
            <div className="lc-settings-fields">
              <SettingsFold id="paths" title="Folders">
              <label>
                <span>Problem sets</span>
                <input
                  value={draft.data_json_dir ?? ""}
                  onChange={(e) =>
                    setDraft((prev) => ({
                      ...prev,
                      data_json_dir: e.target.value.trim() ? e.target.value : null,
                    }))
                  }
                  placeholder="path to JSON corpus"
                />
                <p className="lc-settings-hint">
                  The folder of practice problems on this computer.
                </p>
              </label>
              <label>
                <span>Practice folder</span>
                <input
                  value={draft.workspace_dir}
                  onChange={(e) => setDraft((prev) => ({ ...prev, workspace_dir: e.target.value }))}
                />
                <p className="lc-settings-hint">
                  Where your Practice code, boards and history are saved.
                </p>
              </label>
              </SettingsFold>

              <SettingsFold id="datasets" title="Problem sets">
              <p className="lc-muted">
                Each problem set is indexed into its own table. By default a corpus lives in{" "}
                <code>&lt;problems folder&gt;/&lt;dataset&gt;/</code>; override it below when it
                lives somewhere else.
              </p>
              <div className="lc-setting-row">
<div className="lc-settings-subhead">Available problem sets</div>
              <p className="lc-settings-hint">Install a problem set to download it. KodCode is about 1 GB.</p>
              {(Array.isArray(dlcRows) ? dlcRows : []).map((row) => {
                const working = ["starting", "downloading", "unpacking", "indexing"].includes(row.phase);
                const pct = row.progress >= 0 ? Math.round(row.progress * 100) : null;
                const label = working
                  ? row.phase === "downloading" && pct != null
                    ? `${pct}%`
                    : "…"
                  : row.phase === "error" ? "Retry"
                  : row.installed
                    ? "Remove"
                    : "Install";
                const countLabel = dlcProgressLabel(row, formatDlcBytes);
                const fillPct =
                  working && pct != null ? `${pct}%` : working ? "40%" : "0%";
                return (
                  <div key={row.slug} className="lc-settings-dlc-row">
                    <span className="lc-settings-dlc-name">{row.label}</span>
                    <span className="lc-settings-dlc-count">{countLabel}</span>
                    {row.installed && !working && row.phase !== "error" ? <HoldButton
                      label={`Remove ${row.label}`} ariaLabel={`Hold to remove ${row.label}`} dataTip={`Remove ${row.label}`}
                      className="lc-secondary lc-settings-icon-action lc-hold-danger" disabled={Boolean(busy)}
                      onConfirm={() => void onDlcRemove(row.slug)}><SettingsIcon id="delete"/></HoldButton> : <button
                      type="button"
                      className={[
                        "lc-settings-dlc-action",
                        row.installed && !working && row.phase !== "error" ? "is-remove" : "",
                        working ? "is-busy" : "",
                        working && pct == null ? "is-indeterminate" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      style={{ "--dlc-progress": fillPct } as CSSProperties}
                      disabled={Boolean(busy) || working}
                      onClick={() => onDlcInstall(row.slug)}
                    >
                      <span>{label}</span>
                    </button>}
                    {row.error && <p className="lc-warning lc-settings-dlc-error">{row.error}</p>}
                  </div>
                );
              })}
              {datasets.length === 0 && (
                <p className="lc-muted">
                  This build does not report datasets — rebuild with Practice support (the <code>leetcode</code> Cargo feature).
                </p>
              )}
              {datasets.map((entry) => (
                <label key={entry.id}>
                  <span>
                    {entry.label}
                    <span className="lc-settings-badge">
                      {entry.count.toLocaleString()} indexed
                    </span>
                  </span>
                  <input
                    value={draft.dataset_dirs?.[entry.id] ?? ""}
                    placeholder={entry.corpus_dir ?? `<problems folder>/${entry.id}`}
                    onChange={(e) =>
                      setDraft((prev) => {
                        const dirs = { ...(prev.dataset_dirs ?? {}) };
                        if (e.target.value.trim()) dirs[entry.id] = e.target.value;
                        else delete dirs[entry.id];
                        return { ...prev, dataset_dirs: dirs };
                      })
                    }
                  />
                  <p className="lc-settings-hint">
                    <code>{entry.source}</code> — index with{" "}
                    <code>lc index --dataset {entry.id}</code>
                  </p>
                </label>
              ))}
              </div>
</SettingsFold>
            </div>
          )}

          {(tab === "personalise" || searching) && (
            <div className="lc-settings-fields">
              <SettingsFold id="writing" title="Annotate">
              <div className="lc-setting-row">
<div className="lc-settings-subhead">Writing hand</div>
              <p className="lc-settings-hint">Which side the pen tools appear on.</p>
              <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Writing hand">
                <button
                  type="button"
                  role="radio"
                  aria-checked={handedness === "right"}
                  className={
                    handedness === "right"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setHandedness("right")}
                >
                  <strong>Right hand</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={handedness === "left"}
                  className={
                    handedness === "left"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setHandedness("left")}
                >
                  <strong>Left hand</strong>
                </button>
              </SettingsChoices>

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Hidden-tools marker</div>
              <p className="lc-settings-hint">Marks the corner where the hidden tools are.</p>
              <SettingsChoices
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Hidden-tools marker"
              >
                {(
                  [
                    [
                      "smear",
                      "A light gray mark.",
                    ],
                    [
                      "pulse",
                      "A small checkerboard that pulses gently.",
                    ],
                    [
                      "off",
                      "No mark. Tapping the corner still opens the tools.",
                    ],
                  ] as Array<[ChromeWakeMarker, string]>
                ).map(([marker, blurb]) => (
                  <button
                    key={marker}
                    type="button"
                    role="radio"
                    aria-checked={chromeWake === marker}
                    className={
                      chromeWake === marker
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setChromeWake(marker)}
                  >
                    <strong>{marker === "off" ? "None" : marker === "pulse" ? "Pulsing squares" : "Faint smudge"}</strong>
                    {blurb && <span className="lc-muted">{blurb}</span>}
                  </button>
                ))}
              </SettingsChoices>

              {chromeWake !== "off" && <>
              <div className="lc-settings-subhead">Marker color</div>
              <SettingsChoices
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Hidden-tools marker color"
              >
                {(
                  [
                    ["mono", ""],
                    ["color", ""],
                  ] as Array<[ChromeWakeTint, string]>
                ).map(([tint, blurb]) => (
                  <button
                    key={tint}
                    type="button"
                    role="radio"
                    aria-checked={chromeWakeTint === tint}
                    className={
                      chromeWakeTint === tint
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setChromeWakeTint(tint)}
                  >
                    <strong>{tint === "color" ? "Rainbow" : "Black and white"}</strong>
                    {blurb && <span className="lc-muted">{blurb}</span>}
                  </button>
                ))}
              </SettingsChoices>

              </>}
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">When you capture</div>
              <p className="lc-settings-hint">What happens when you capture the board or part of it.</p>
              <SettingsChoices
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="What a capture does"
              >
                {(
                  [
                    [
                      "board",
                      "The picture is placed on the board.",
                    ],
                    [
                      "board-save",
                      "Also saves it as an image file.",
                    ],
                    [
                      "save",
                      "Saves an image file and leaves the board as it was.",
                    ],
                  ] as Array<[CaptureMode, string]>
                ).map(([mode, blurb]) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={captureMode === mode}
                    className={
                      captureMode === mode
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setCaptureMode(mode)}
                  >
                    <strong>{mode === "board" ? "Add to board" : mode === "board-save" ? "Add to board and save" : "Save only"}</strong>
                    {blurb && <span className="lc-muted">{blurb}</span>}
                  </button>
                ))}
              </SettingsChoices>

              {captureWritesFile(captureMode) && (
                <>
                  <div className="lc-settings-subhead">Save to</div>
                  <SettingsChoices
                    className="lc-settings-choice"
                    role="radiogroup"
                    aria-label="Capture save location"
                  >
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "photos"}
                      className={
                        captureDestination === "photos"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("photos")}
                    >
                      <strong>Photos (default)</strong>
                      <span className="lc-muted">
                        Pictures/lc.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "downloads"}
                      className={
                        captureDestination === "downloads"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("downloads")}
                    >
                      <strong>Downloads</strong>
                      <span className="lc-muted"></span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "folder"}
                      className={
                        captureDestination === "folder"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("folder")}
                    >
                      <strong>A folder</strong>
                      <span className="lc-muted">
                        Pick one on Android; type a path on desktop.
                      </span>
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={captureDestination === "share"}
                      className={
                        captureDestination === "share"
                          ? "lc-settings-choice-option is-active"
                          : "lc-settings-choice-option"
                      }
                      onClick={() => setCaptureDestination("share")}
                    >
                      <strong>Share sheet</strong>
                      <span className="lc-muted">
                        Android. Elsewhere it saves to Photos.
                      </span>
                    </button>
                  </SettingsChoices>

                  {captureDestination === "folder" && (
                    <>
                      <p className="lc-settings-hint">
                        On Android, choose a folder to grant access. On desktop, enter an absolute path (<code>~</code> works). Save failures are reported.
                      </p>
                      <input
                        type="text"
                        value={captureFolder}
                        readOnly={/Android/i.test(navigator.userAgent)}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoCorrect="off"
                        placeholder="~/Pictures/lc-board"
                        aria-label="Capture folder"
                        onChange={(event) => setCaptureFolder(event.target.value)}
                      />
                      {/Android/i.test(navigator.userAgent) && <button type="button" onClick={async () => {
                        try { const folder = await pickCaptureFolder(); if (folder) setCaptureFolder(folder); }
                        catch (error) { window.alert(`Could not choose folder: ${String(error)}`); }
                      }}>Choose folder…</button>}
                    </>
                  )}

                </>
              )}
                  </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Countdown</div>
              <p className="lc-settings-hint">Wait a few seconds before capturing. Tap the countdown to capture right away.</p>
                  <SettingsChoices
                    className="lc-settings-choice lc-settings-choice-compact"
                    role="radiogroup"
                    aria-label="Countdown"
                  >
                    {CAPTURE_COUNTDOWN_CHOICES.map((seconds) => (
                      <button
                        key={seconds}
                        type="button"
                        role="radio"
                        aria-checked={captureCountdown === seconds}
                        className={
                          captureCountdown === seconds
                            ? "lc-settings-choice-option is-active"
                            : "lc-settings-choice-option"
                        }
                        onClick={() => setCaptureCountdown(seconds)}
                      >
                        <strong>{seconds === 0 ? "Off" : `${seconds}s`}</strong>
                      </button>
                    ))}
                  </SettingsChoices>


              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Smoother motion</div>
              <p className="lc-settings-hint">Uses your screen’s highest refresh rate. Uses a little more battery.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Smoother motion"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!inkMatchDisplay}
                  className={
                    inkMatchDisplay
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setInkMatchDisplay(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={inkMatchDisplay}
                  className={
                    inkMatchDisplay
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setInkMatchDisplay(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>
              </div>
</SettingsFold>
              <SettingsFold id="ink-tools" title="Ink tools">
<div className="lc-setting-row">
<div className="lc-settings-subhead">Confirm colors with OK</div>
              <p className="lc-settings-hint">On: tap OK in the middle of the color wheel to choose. Off: the color is chosen when you lift your pen.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Confirm colors with OK"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!tapOk}
                  className={
                    tapOk
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setTapOk(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={tapOk}
                  className={
                    tapOk
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTapOk(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Color wheel on the toolbar</div>
              <p className="lc-settings-hint">Pick a one-off color without changing your saved colors.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Color wheel on the toolbar"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!colorWheelOnToolbar}
                  className={
                    colorWheelOnToolbar
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setColorWheelOnToolbar(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={colorWheelOnToolbar}
                  className={
                    colorWheelOnToolbar
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setColorWheelOnToolbar(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>

              {/*
                What the ⟳ on the colour wheel asks for.
                
                The feed was queried with no tag at all, which is not "no
                preference" so much as "whatever the site sorts by" — and what
                came back was pastel after pastel. Any stays the default: a
                preference nobody asked for should not narrow what they get.
              */}
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">New palettes</div>
              <p className="lc-settings-hint">Styles to use when you ask for a new set of colors. Without internet, a built-in list is used.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-wrap"
                role="group"
                aria-label="Palette colors"
              >
                {PALETTE_TAGS.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    aria-pressed={palettePrefs.tags.includes(tag)}
                    className={
                      palettePrefs.tags.includes(tag)
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => {
                      setPalettePrefs(prefs => togglePaletteTag(prefs, tag));
                    }}
                  >
                    <strong>{paletteTagLabel(tag)}</strong>
                  </button>
                ))}
              </SettingsChoices>
              <SettingsChoices className="lc-settings-choice lc-settings-palette-options">
                <button type="button" role="switch" aria-checked={palettePrefs.matchAll}
                  disabled={palettePrefs.tags.length < 2}
                  className={palettePrefs.matchAll ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                  onClick={() => setPalettePrefs(prefs => ({ ...prefs, matchAll: !prefs.matchAll }))}>
                  <strong>Match every style</strong><span className="lc-muted">Only use palettes that fit all the styles you picked.</span>
                </button>
                <button type="button" role="switch" aria-checked={palettePrefs.mixColours}
                  className={palettePrefs.mixColours ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                  onClick={() => setPalettePrefs(prefs => ({ ...prefs, mixColours: !prefs.mixColours }))}>
                  <strong>Mix colors</strong><span className="lc-muted">Make four distinct colors that stand out on the page.</span>
                </button>
              </SettingsChoices>

              </div>
</SettingsFold>

              <SettingsFold id="reading" title="Scroll">
              <div className="lc-setting-row">
<div className="lc-settings-subhead">Flick momentum</div>
              <p className="lc-settings-hint">
                How far the page keeps moving after you flick it. 50 is normal.
              </p>
              <SettingsSlider
                label="Flick momentum"
                min={0}
                max={100}
                step={1}
                value={pdfFlickMomentum}
                display={String(pdfFlickMomentum)}
                onChange={setPdfFlickMomentum}
              />
              </div>
</SettingsFold>

              <SettingsFold id="storage" title="Storage">
              <div className="lc-setting-row">
<div className="lc-settings-subhead">Devices</div>
              <p className="lc-settings-hint">
                Personalize settings are saved separately on each device.
              </p>
              <ul className="lc-settings-hint">
                <li>
                  {deviceRole()} · {loadDeviceId().slice(0, 8)}… · this device
                </li>
                {siblingDevices
                  .filter((dev) => dev.id !== loadDeviceId())
                  .map((dev) => (
                    <li key={dev.id}>
                      {dev.role} · {dev.id.slice(0, 8)}… ·{" "}
                      {new Date(dev.updated_at).toLocaleString()}
                    </li>
                  ))}
              </ul>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Sync with your PC</div>
              <p className="lc-settings-hint">
                Keep documents, whiteboards and handwriting in sync with the Pen Island app on your PC, over your home Wi-Fi.
              </p>
              {draft.serve_token ? (
                <>
                  <p className="lc-settings-hint">
                    This PC is the one other devices sync with. Enter both of these on the tablet, in
                    Settings → Personalize → Storage → Sync with your PC.
                  </p>
                  <dl className="lc-pad-hub-card">
                    <div>
                      <dt>PC URL</dt>
                      <dd>
                        {lanUrl ? (
                          <code className="lc-pad-hub-url">{lanUrl}</code>
                        ) : (
                          <span className="lc-muted">
                            this PC’s address on the network, port {draft.serve_port}
                          </span>
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>6-digit code</dt>
                      <dd>
                        <code className="lc-pad-hub-code">{draft.serve_token}</code>
                      </dd>
                    </div>
                  </dl>
                </>
              ) : (
                <p className="lc-settings-hint">
                  To find the PC address and 6-digit code, open Settings in the Pen Island app on your PC.
                </p>
              )}
              <label className="lc-md-new-title">
                <span className="lc-muted">PC address</span>
                <input
                  type="url"
                  value={hubUrl}
                  /*
                   * Spelled as an example, because it did not used to be.
                   * A bare address here reads as a value already filled in —
                   * so the code went in, the URL stayed empty, and Save
                   * answered with a complaint about a field that looked full.
                   */
                  placeholder="e.g. http://192.168.1.10:7878"
                  onChange={(event) => {
                    setHubUrl(event.target.value);
                    setHubCheck({ kind: "idle" });
                  }}
                />
              </label>
              <label className="lc-md-new-title">
                <span className="lc-muted">6-digit code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={6}
                  pattern="[0-9]{6}"
                  placeholder="e.g. 000000"
                  value={hubToken}
                  onChange={(event) => {
                    setHubToken(event.target.value.replace(/\D/g, "").slice(0, 6));
                    setHubCheck({ kind: "idle" });
                  }}
                />
              </label>
              <div className="lc-pad-hub-check">
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={
                    hubCheck.kind === "busy" ||
                    !hubUrl.trim() ||
                    !/^\d{6}$/.test(hubToken.trim())
                  }
                  onClick={() => {
                    void runHubCheck({ url: hubUrl.trim(), token: hubToken.trim() });
                  }}
                >
                  {hubCheck.kind === "busy" ? "Checking…" : "Check connection"}
                </button>
                {hubCheck.kind === "ok" && (
                  <p className="lc-pad-hub-verdict is-ok">{hubCheck.message}</p>
                )}
                {hubCheck.kind === "bad" && (
                  <p className="lc-pad-hub-verdict is-bad">{hubCheck.message}</p>
                )}
              </div>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Autosave</div>
              <p className="lc-settings-hint">
                How often your work is saved automatically, so nothing is lost if the
                app closes unexpectedly. Discard still undoes everything since you
                opened the document.
              </p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Autosave interval"
              >
                {AUTOSAVE_CHOICES.map(([ms, label]) => (
                  <button
                    key={ms}
                    type="button"
                    role="radio"
                    aria-checked={autosaveMs === ms}
                    className={
                      autosaveMs === ms
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setAutosaveMs(ms)}
                  >
                    <strong>{label}</strong>
                  </button>
                ))}
              </SettingsChoices>
              <p className="lc-settings-hint">
                Saving always happens; this only controls the Saved message.
              </p>
              <SettingsChoices
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="Autosave banners"
              >
                {AUTOSAVE_BANNER_CHOICES.map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={autosaveBanner === id}
                    className={
                      autosaveBanner === id
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setAutosaveBanner(id)}
                  >
                    <strong>{label}</strong>
                    {hint && <span className="lc-muted">{hint}</span>}
                  </button>
                ))}
              </SettingsChoices>

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Automatic sync</div>
              <p className="lc-settings-hint">
                Sync with your PC in the background. When off, changes stay on this
                device until you tap Sync.
              </p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Automatic sync"
              >
                {HUB_AUTOSYNC_CHOICES.map(([id, label, hint]) => (
                  <button
                    key={id}
                    type="button"
                    role="radio"
                    aria-checked={hubAutoSync === id}
                    className={
                      hubAutoSync === id
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setHubAutoSync(id)}
                  >
                    <strong>{label}</strong>
                    {hint && <span className="lc-muted">{hint}</span>}
                  </button>
                ))}
              </SettingsChoices>

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Storage on this device</div>
              <p className="lc-settings-hint">
                Documents, whiteboards and handwriting share the space available to the
                app. Handwriting takes the most space.
              </p>
              {storage ? (
                <>
                  <div
                    className="lc-storage-bar"
                    role="meter"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(storage.ratio * 100)}
                    aria-label="Storage used"
                  >
                    <div
                      className="lc-storage-bar-fill"
                      style={{ width: `${Math.max(1, Math.round(storage.ratio * 100))}%` }}
                    />
                  </div>
                  <p className="lc-muted">
                    {formatBytes(storage.usage)} used of {formatBytes(storage.quota)}
                    {storage.persisted ? " · kept when space runs short" : ""}
                  </p>
                </>
              ) : (
                <p className="lc-muted">This browser does not report a storage estimate.</p>
              )}

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Saved document copies</div>
              <p className="lc-settings-hint">
                Finds saved copies that no longer match their original file. Repair removes them; open the file again to get it back.
              </p>
              <div className="lc-pad-hub-check">
                <button aria-label="Check stored copies" title="Check stored copies"
                  type="button"
                  className="lc-secondary lc-settings-icon-action"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("check");
                  }}
                ><SettingsIcon id="check"/></button>
                <button aria-label="Diagnose stored copies" title="Diagnose stored copies"
                  type="button"
                  className="lc-secondary lc-settings-icon-action"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("inspect");
                  }}
                ><SettingsIcon id="diagnose"/></button>
                <button aria-label="Repair stored copies" title="Repair stored copies"
                  type="button"
                  className="lc-secondary lc-settings-icon-action"
                  disabled={docCache.kind === "busy"}
                  onClick={() => {
                    void runDocCache("repair");
                  }}
                ><SettingsIcon id="repair"/></button>
                <HoldButton label="Clear all stored copies" ariaLabel="Hold to clear all stored copies" dataTip="Clear all stored copies"
                  className="lc-secondary lc-settings-icon-action lc-hold-danger" disabled={docCache.kind === "busy"}
                  onConfirm={() => void runDocCache("clear")}><SettingsIcon id="delete"/></HoldButton>
              </div>
              {docCache.kind === "done" && <SettingsFacts facts={docCache.facts} />}
              {docCache.kind === "failed" && <SettingsFacts facts={docCache.facts} error />}

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Duplicate strokes</div>
              <p className="lc-settings-hint">
                Older versions sometimes saved the same pen stroke twice. Removing the extras doesn’t change how pages look.
              </p>
              <div className="lc-pad-hub-check">
                <button aria-label="Check for duplicate strokes" title="Check for duplicate strokes"
                  type="button"
                  className="lc-secondary lc-settings-icon-action"
                  disabled={inkDupes.kind === "busy"}
                  onClick={() => { void runInkDupes(false); }}
                ><SettingsIcon id="check"/></button>
                <HoldButton label="Remove duplicate strokes" ariaLabel="Hold to remove duplicate strokes" dataTip="Remove duplicate strokes"
                  className="lc-secondary lc-settings-icon-action" disabled={inkDupes.kind === "busy"}
                  onConfirm={() => void runInkDupes(true)}><SettingsIcon id="repair"/></HoldButton>
              </div>
              {inkDupes.kind === "done" && <SettingsFacts facts={inkDupes.facts} />}
              {inkDupes.kind === "failed" && <SettingsFacts facts={inkDupes.facts} error />}
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Search index</div>
              <p className="lc-settings-hint">
                Lets Ask find text in your documents. If answers seem out of date, clear it. Your documents aren’t affected.
              </p>
              <div className="lc-pad-hub-check">
                <button aria-label="Check search index" title="Check search index"
                  type="button"
                  className="lc-secondary lc-settings-icon-action"
                  disabled={indexWipe.kind === "busy"}
                  onClick={() => {
                    void runIndexInspect(false);
                  }}
                ><SettingsIcon id="check"/></button>
                <button aria-label="Diagnose search index" title="Diagnose search index"
                  type="button"
                  className="lc-secondary lc-settings-icon-action"
                  disabled={indexWipe.kind === "busy"}
                  onClick={() => {
                    void runIndexInspect(true);
                  }}
                ><SettingsIcon id="diagnose"/></button>
                <HoldButton label="Clear local search index" ariaLabel="Hold to clear local search index" dataTip="Clear local search index"
                  className="lc-secondary lc-settings-icon-action lc-hold-danger" disabled={indexWipe.kind === "busy"}
                  onConfirm={() => void runIndexWipe()}><SettingsIcon id="delete"/></HoldButton>
              </div>
              {indexWipe.kind === "done" && <SettingsFacts facts={indexWipe.facts} />}
              {indexWipe.kind === "failed" && <SettingsFacts facts={indexWipe.facts} error />}
              </div>
</SettingsFold>
              <SettingsFold id="ui" title="Display">
                <div className="lc-setting-row">
                  <div className="lc-settings-subhead">Top bar buttons</div>
                  <p className="lc-settings-hint">Choose which shortcuts appear at the top. Everything stays available from Home.</p>
                  <SettingsChoices className="lc-settings-choice" aria-label="Top bar buttons">
                    {HEADER_MODES.map(([mode, label]) => <button key={mode} type="button" role="switch"
                      aria-label={`Show ${label} in header`} aria-checked={headerModes[mode]}
                      className={headerModes[mode] ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                      onClick={() => setHeaderModes(current => ({ ...current, [mode]: !current[mode] }))}>
                      <strong>{label}</strong><span className="lc-muted">{headerModes[mode] ? "Shown" : "Hidden"}</span>
                    </button>)}
                  </SettingsChoices>
                </div>
                <div className="lc-setting-row">
<div className="lc-settings-subhead">Menu side</div>
              <p className="lc-settings-hint">Puts the top bar, assistant panel and menus on the side that suits your hand.</p>
                <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Menu side">
                  {(["right", "left"] as const).map(hand => <button key={hand} type="button" role="radio"
                    aria-checked={uiHandedness === hand} className={uiHandedness === hand ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setUiHandedness(hand)}><strong>{hand === "right" ? "Right hand" : "Left hand"}</strong></button>)}
                </SettingsChoices>
                </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Corners</div>
                <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Corners">
                  {(["blocky", "rounded"] as const).map(style => <button key={style} type="button" role="radio"
                    aria-checked={uiCorners === style} className={uiCorners === style ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setUiCorners(style)}><strong>{style === "blocky" ? "Square" : "Rounded"}</strong></button>)}
                </SettingsChoices>
                </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">When the app opens</div>
                <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Tabs on launch">
                  {([
                    ["restore", "Reopen last session", "Opens where you left off. Can be slow with large documents."],
                    ["home", "Keep tabs, start on Home", "Your tabs stay, but nothing loads until you tap one."],
                    ["fresh", "Start fresh", "Opens Home with no tabs. Your documents are kept."],
                  ] as const).map(([value, label, hint]) => <button key={value} type="button" role="radio"
                    aria-checked={startupTabs === value} className={startupTabs === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setStartupTabs(value)}>
                    <strong>{label}</strong>{hint && <span className="lc-muted">{hint}</span>}
                  </button>)}
                </SettingsChoices>
                <p className="lc-settings-hint">Takes effect the next time you open the app.</p>
                </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Reading</div>
                <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Reading">
                  {([
                    ["scroll", "Scroll", "Pages in one continuous column."],
                    ["pages", "Pages", "One page at a time; swipe sideways to turn."],
                  ] as const).map(([value, label, hint]) => <button key={value} type="button" role="radio"
                    aria-checked={readingMode === value} className={readingMode === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setReadingMode(value)}>
                    <strong>{label}</strong>{hint && <span className="lc-muted">{hint}</span>}
                  </button>)}
                </SettingsChoices>
                {readingMode === "pages" && (
                  <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Page size">
                    {([
                      ["full", "Full screen", ""],
                      ["margin", "With margin", ""],
                    ] as const).map(([value, label, hint]) => <button key={value} type="button" role="radio"
                      aria-checked={pageFit === value} className={pageFit === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                      onClick={() => setPageFit(value)}>
                      <strong>{label}</strong>{hint && <span className="lc-muted">{hint}</span>}
                    </button>)}
                  </SettingsChoices>
                )}
                </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Booktabs</div>
                <p className="lc-settings-hint">Numbered tabs match each footnote's color and mark its place on the page.</p>
                <SettingsChoices className="lc-settings-choice" aria-label="Booktabs">
                  <button type="button" role="switch" aria-checked={showBooktabs}
                    className={showBooktabs ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setShowBooktabs(!showBooktabs)}><strong>Show booktabs</strong></button>
                </SettingsChoices>
                {showBooktabs && <>
                  <div className="lc-settings-subhead">Position</div>
                  <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Booktab position">
                    {([["beside", "Beside the footnote"], ["top", "Top edge"], ["bottom", "Bottom edge"]] as const).map(([value, label]) =>
                      <button key={value} type="button" role="radio" aria-checked={booktabPosition === value}
                        className={booktabPosition === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                        onClick={() => setBooktabPosition(value)}><strong>{label}</strong></button>)}
                  </SettingsChoices>
                  <div className="lc-settings-subhead">Which footnotes</div>
                  <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Booktab footnotes">
                    {([["chatbot", "ChatBot footnotes"], ["all", "All footnotes"]] as const).map(([value, label]) =>
                      <button key={value} type="button" role="radio" aria-checked={booktabFootnotes === value}
                        className={booktabFootnotes === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                        onClick={() => setBooktabFootnotes(value)}><strong>{label}</strong></button>)}
                  </SettingsChoices>
                </>}
                <div className="lc-settings-subhead">Footnote titles</div>
                <p className="lc-settings-hint">A footnote's title beside its square, kept in the margin so it never covers the page's text. Where the margin is too narrow it is left off; the footnote panel always shows it.</p>
                <SettingsChoices className="lc-settings-choice" aria-label="Footnote titles">
                  <button type="button" role="switch" aria-checked={showFootnoteTitles}
                    className={showFootnoteTitles ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setShowFootnoteTitles(!showFootnoteTitles)}><strong>Show titles on the page</strong></button>
                </SettingsChoices>
                </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Assistant replies</div>
                <SettingsChoices className="lc-settings-choice" aria-label="Thinking display">
                  {([
                    ["autoCollapseThinking", "Collapse steps when the answer arrives", ""],
                    ["collapseThinkingSteps", "Start with steps collapsed", ""],
                    ["colorThinkingSteps", "Color-code steps", "Gives neighboring steps different colors so they’re easier to tell apart."],
                  ] as const).map(([key, label, hint]) => <button key={key} type="button" role="switch"
                    aria-checked={agentDisplay[key]} className={agentDisplay[key] ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setAgentDisplay(prefs => ({ ...prefs, [key]: !prefs[key] }))}>
                    <strong>{label}</strong>{hint && <span className="lc-muted">{hint}</span>}
                  </button>)}
                </SettingsChoices>
                <p className="lc-settings-hint">How the assistant’s replies look in every chat.</p>
                <SettingsChoices className="lc-settings-choice lc-settings-coach-flags">
                  {SHARED_AGENT_FLAGS.map(([key, label, hint]) => (
                    <button key={key} type="button" role="switch"
                      aria-checked={(draft.coach ?? DEFAULT_COACH_FLAGS)[key]}
                      className={(draft.coach ?? DEFAULT_COACH_FLAGS)[key] ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                      onClick={() => setDraft(prev => ({ ...prev, coach: { ...DEFAULT_COACH_FLAGS, ...prev.coach,
                        [key]: !(prev.coach ?? DEFAULT_COACH_FLAGS)[key] } }))}>
                      <strong>{label}</strong>{hint && <span className="lc-muted">{hint}</span>}
                    </button>
                  ))}
                </SettingsChoices>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Notifications</div>
              <p className="lc-settings-hint">Small notices in the corner, like “Desktop app is offline”. Turning them off doesn’t hide sync status.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Notifications"
              >
                {([[true, "On"], [false, "Off"]] as const).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={notificationCards === value}
                    className={notificationCards === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                    onClick={() => setNotificationCards(value)}
                  >
                    <strong>{label}</strong>
                  </button>
                ))}
              </SettingsChoices>
              </div>
</SettingsFold>
              <SettingsFold id="diagnostics" title="Troubleshooting">
              <div className="lc-setting-row">
<p className="lc-settings-hint">Tools for diagnosing problems. Most people never need these.</p>
<div className="lc-settings-subhead">Measurement refresh rate</div>
              <p className="lc-settings-hint">The screen speed the performance tools compare against.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Measurement refresh rate"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={inkDisplayHz === "auto"}
                  className={
                    inkDisplayHz === "auto"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setInkDisplayHz("auto")}
                >
                  <strong>Auto</strong>
                </button>
                {INK_DISPLAY_HZ.map((hz) => (
                  <button
                    key={hz}
                    type="button"
                    role="radio"
                    aria-checked={inkDisplayHz === hz}
                    className={
                      inkDisplayHz === hz
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => setInkDisplayHz(hz)}
                  >
                    <strong>{hz}</strong>
                  </button>
                ))}
              </SettingsChoices>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Speed overlay</div>
              <p className="lc-settings-hint">Shows drawing speed on the whiteboard.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Speed overlay"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!inkPerfOverlay}
                  className={
                    inkPerfOverlay
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setInkPerfOverlay(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={inkPerfOverlay}
                  className={
                    inkPerfOverlay
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setInkPerfOverlay(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Floating Sync button</div>
              <p className="lc-settings-hint">Shows Sync as a button on the board instead of in the tab.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Floating Sync button"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!hubSyncWindowPill}
                  className={
                    hubSyncWindowPill
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setHubSyncWindowPill(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={hubSyncWindowPill}
                  className={
                    hubSyncWindowPill
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setHubSyncWindowPill(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Drawing speed bar</div>
              <p className="lc-settings-hint">
                A thin bar showing how quickly each pen stroke appears.
              </p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Drawing speed bar"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!inkPerfBar}
                  className={
                    inkPerfBar
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setInkPerfBar(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={inkPerfBar}
                  className={
                    inkPerfBar
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setInkPerfBar(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>
              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Page preview while flicking</div>
              <p className="lc-settings-hint">While flicking through a PDF, shows the page you’ll land on.</p>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Page preview while flicking"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!pdfFlickHud}
                  className={
                    pdfFlickHud
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() => setPdfFlickHud(false)}
                >
                  <strong>Off</strong>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={pdfFlickHud}
                  className={
                    pdfFlickHud
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setPdfFlickHud(true)}
                >
                  <strong>On</strong>
                </button>
              </SettingsChoices>

                <DebugLogSettings on={debugLog} saved={baselineDebugLog} onChange={setDebugLog} />
              </div>
</SettingsFold>
              <SettingsFold id="licenses" title="Licenses">
                <div className="lc-setting-row">
                  <LicenseSettings />
                </div>
              </SettingsFold>
            </div>
          )}

          {(tab === "ai" || searching) && FEATURE_LEETCODE && (
            <div className="lc-settings-fields">
              {FEATURE_LEETCODE && (
              <SettingsFold id="tests" title="Tests">
              <div className="lc-setting-row">
<div className="lc-settings-subhead">When a test fails</div>
              <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Test run mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={!draft.stop_on_first_failure}
                  className={
                    draft.stop_on_first_failure
                      ? "lc-settings-choice-option"
                      : "lc-settings-choice-option is-active"
                  }
                  onClick={() =>
                    setDraft((prev) => ({ ...prev, stop_on_first_failure: false }))
                  }
                >
                  <strong>Run every test</strong>
                  <span className="lc-muted">
                    The assistant can point to a real failing example.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={draft.stop_on_first_failure}
                  className={
                    draft.stop_on_first_failure
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setDraft((prev) => ({ ...prev, stop_on_first_failure: true }))}
                >
                  <strong>Stop at the first failure</strong>
                  <span className="lc-muted">
                    Faster when there are many tests.
                  </span>
                </button>
              </SettingsChoices>
              <div className="lc-settings-subhead">After tests fail</div>
<p className="lc-settings-hint">Test results always appear in the chat.</p>
              <SettingsChoices
                className="lc-settings-choice"
                role="radiogroup"
                aria-label="When a failed run should call the agent"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={testForward === "wait"}
                  className={
                    testForward === "wait"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTestForward("wait")}
                >
                  <strong>Wait</strong>
                  <span className="lc-muted">
                    The assistant stays quiet until you ask.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={testForward === "whole-run"}
                  className={
                    testForward === "whole-run"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTestForward("whole-run")}
                >
                  <strong>One reply for all failures</strong>
                  <span className="lc-muted">
                    The assistant looks at every failed test at once.
                  </span>
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={testForward === "per-case"}
                  className={
                    testForward === "per-case"
                      ? "lc-settings-choice-option is-active"
                      : "lc-settings-choice-option"
                  }
                  onClick={() => setTestForward("per-case")}
                >
                  <strong>One reply per failure</strong>
                  <span className="lc-muted">
                    A separate reply for each failed test.
                  </span>
                </button>
              </SettingsChoices>

              </div>
</SettingsFold>
              )}

              {COACH_FLAG_GROUPS.map((group) => (
                <SettingsFold key={group.id} id={group.id} title={group.title}>
                  <p className="lc-settings-hint">{group.blurb}</p>
                  <SettingsChoices className="lc-settings-choice">
                    {group.flags.map(([key, label, hint]) => {
                      const on = (draft.coach ?? DEFAULT_COACH_FLAGS)[key];
                      return (
                        <button
                          key={key}
                          type="button"
                          aria-pressed={on}
                          className={
                            on
                              ? "lc-settings-choice-option is-active"
                              : "lc-settings-choice-option"
                          }
                          onClick={() =>
                            setDraft((prev) => {
                              const current = (prev.coach ?? DEFAULT_COACH_FLAGS)[key];
                              return {
                                ...prev,
                                coach: {
                                  ...DEFAULT_COACH_FLAGS,
                                  ...(prev.coach ?? {}),
                                  [key]: !current,
                                },
                              };
                            })
                          }
                        >
                          <strong>{label}</strong>
                          {hint && <span className="lc-muted">{hint}</span>}
                        </button>
                      );
                    })}
                  </SettingsChoices>
                </SettingsFold>
              ))}
            </div>
          )}

          {(tab === "llm" || searching) && (
            <div className="lc-settings-fields">
              {!searching && <div className="lc-settings-callout" role="note">
                <strong>&ldquo;localhost&rdquo; means this device</strong>
                <p>
                  In the addresses below, <code>localhost</code> (or <code>127.0.0.1</code>) always points to
                  the device this app is running on{mobile ? ", not your PC" : ""}.
                  {mobile ? " To use an AI model on your PC, enter the PC’s address instead." : ""}
                </p>
              </div>}

              <SettingsFold id="llm" title="AI model">
              <div className="lc-setting-row">
<div className="lc-settings-subhead">Status</div>
              <p className="lc-agent-live" data-status={coachStatus}>
                <span className="lc-agent-live-dot" aria-hidden />
                <span>
                  {coachStatus === "online"
                    ? "AI model online"
                    : coachStatus === "offline"
                      ? "Agent LLM offline"
                      : "Agent LLM status unknown"}
                </span>
              </p>
              {coachDetail && <p className="lc-settings-hint">{coachDetail}</p>}

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Model setup</div>
              <label>
                <span>Provider</span>
                <select
                  value={draft.default_provider}
                  onChange={(e) =>
                    setDraft((prev) => ({ ...prev, default_provider: e.target.value }))
                  }
                >
                  {PROVIDERS.map((p) => (
                    <option key={p} value={p}>
                      {PROVIDER_LABELS[p]}
                    </option>
                  ))}
                </select>
              </label>

              <div className="lc-settings-provider-tabs" role="tablist">
                {PROVIDERS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    role="tab"
                    aria-selected={providerFocus === p}
                    className={
                      providerFocus === p
                        ? "lc-settings-subtab is-active"
                        : "lc-settings-subtab"
                    }
                    onClick={() => setProviderFocus(p)}
                  >
                    {p === "local"
                      ? "Local"
                      : p === "ollama"
                        ? "Ollama"
                        : p === "openai"
                          ? "OpenAI"
                          : "Groq"}
                  </button>
                ))}
              </div>

              <label>
                <span>Server address</span>
                <input
                  value={provider.base_url}
                  onChange={(e) => patchProvider(providerFocus, { base_url: e.target.value })}
                  placeholder={
                    providerFocus === "openai"
                      ? "https://api.openai.com/v1"
                      : providerFocus === "groq"
                        ? "https://api.groq.com/openai/v1"
                        : "http://localhost:11434/v1"
                  }
                />
                <p className="lc-settings-hint">{llmServerHint(providerFocus)}</p>
              </label>
              {(providerFocus === "local" || providerFocus === "ollama") && (
                <label>
                  <span>Models folder</span>
                  <input
                    value={draft.models_dir}
                    onChange={(e) =>
                      setDraft((prev) => ({ ...prev, models_dir: e.target.value }))
                    }
                    placeholder="C:\Users\you\Models"
                  />
                  <p className="lc-settings-hint">
                    Optional. A folder of downloaded models to choose from, even when the
                    server isn’t running. Save, then tap Refresh models.
                  </p>
                </label>
              )}
              <label>
                <span>Chat model</span>
                <input
                  list="lc-model-options"
                  value={provider.model}
                  onChange={(e) => patchProvider(providerFocus, { model: e.target.value })}
                />
                <datalist id="lc-model-options">
                  {(catalog?.models ?? []).map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.source === "disk" ? `${entry.id} · disk` : `${entry.id} · server`}
                    </option>
                  ))}
                </datalist>
                <p className="lc-settings-hint">{modelListHint}</p>
              </label>
              <div className="lc-settings-actions-row">
                <button
                  type="button"
                  className="lc-secondary"
                  disabled={catalogBusy}
                  onClick={() => void refreshCatalog(providerFocus)}
                >
                  {catalogBusy ? "Reading…" : "Refresh models"}
                </button>
              </div>
              <label>
                <span>Image model</span>
                <input
                  value={provider.vision_model}
                  onChange={(e) =>
                    patchProvider(providerFocus, { vision_model: e.target.value })
                  }
                  placeholder="(same as chat model)"
                />
                <p className="lc-settings-hint">Used when the AI looks at your board or images. Leave empty to use the chat model.</p>
              </label>
              {/*
                Embeddings, for the document index.
                
                Local-only: the index is a local SQLite file beside the corpus,
                and shipping every page of every document to a hosted embedding
                endpoint is not a decision to make quietly in a settings row.
              */}
              {providerFocus === "local" && (
                <>
                  <label>
                    <span>Search model</span>
                    <input
                      value={provider.embed_model ?? ""}
                      onChange={(e) =>
                        patchProvider(providerFocus, { embed_model: e.target.value })
                      }
                      list="lc-model-options"
                      placeholder="(none — match on words)"
                    />
                    <p className="lc-settings-hint">Helps Ask find passages by meaning, not just exact words. Leave empty to match words only.</p>
                  </label>
                  <label>
                    <span>Search server</span>
                    <input
                      value={provider.embed_base_url ?? ""}
                      onChange={(e) =>
                        patchProvider(providerFocus, { embed_base_url: e.target.value })
                      }
                      placeholder="(same as base URL)"
                    />
                    <p className="lc-settings-hint">
                      Optional. Leave empty to use the server address above.
                    </p>
                  </label>
                </>
              )}

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Can read images</div>
              <SettingsChoices
                className="lc-settings-choice lc-settings-choice-compact"
                role="radiogroup"
                aria-label="Can read images"
              >
                {([
                  [true, "Yes"],
                  [false, "No"],
                ] as const).map(([value, label]) => (
                  <button
                    key={label}
                    type="button"
                    role="radio"
                    aria-checked={(provider.vision === true) === value}
                    className={
                      (provider.vision === true) === value
                        ? "lc-settings-choice-option is-active"
                        : "lc-settings-choice-option"
                    }
                    onClick={() => patchProvider(providerFocus, { vision: value })}
                  >
                    <strong>{label}</strong>
                  </button>
                ))}
              </SettingsChoices>
              <p className="lc-settings-hint">{visionHint}</p>

              {(providerFocus === "openai" || providerFocus === "groq") && (
                <label>
                  <span>API key</span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={providerFocus === "openai" ? openaiKeyDraft : groqKeyDraft}
                    onChange={(e) => {
                      if (providerFocus === "openai") {
                        setOpenaiKeyDraft(e.target.value);
                        setClearOpenaiKey(false);
                      } else {
                        setGroqKeyDraft(e.target.value);
                        setClearGroqKey(false);
                      }
                    }}
                    placeholder={
                      (providerFocus === "openai" ? draft.openai_key_set : draft.groq_key_set)
                        ? "leave blank to keep the stored key"
                        : providerFocus === "openai"
                          ? "sk-…"
                          : "gsk_…"
                    }
                  />
                  <p className="lc-settings-hint">Kept in this device&apos;s config.toml. An environment variable wins if set.</p>
                  {(providerFocus === "openai" ? draft.openai_key_set : draft.groq_key_set) && (
                    <HoldButton label="Clear stored key" ariaLabel="Hold to clear stored key" dataTip="Clear stored key"
                      className="lc-secondary lc-settings-icon-action lc-hold-danger"
                      onConfirm={() => {
                        if (providerFocus === "openai") {
                          setOpenaiKeyDraft("");
                          setClearOpenaiKey(true);
                        } else {
                          setGroqKeyDraft("");
                          setClearGroqKey(true);
                        }
                      }}
                    >
                      <SettingsIcon id="delete"/>
                    </HoldButton>
                  )}
                  {(providerFocus === "openai" ? clearOpenaiKey : clearGroqKey) && (
                    <p className="lc-muted">Stored key will be cleared on Save.</p>
                  )}
                </label>
              )}

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Model for each task</div>
              <p className="lc-settings-hint">Use a different AI for different jobs. Most people can leave these alone.</p>
              {MODES.map((mode) => (
                <label key={mode}>
                  <span>{MODE_LABELS[mode]}</span>
                  <select
                    value={draft.modes[mode]}
                    onChange={(e) =>
                      setDraft((prev) => ({
                        ...prev,
                        modes: { ...prev.modes, [mode]: e.target.value },
                      }))
                    }
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {PROVIDER_LABELS[p]}
                      </option>
                    ))}
                  </select>
                  <p className="lc-settings-hint">{MODE_HINTS[mode]}</p>
                </label>
              ))}

              </div>
<div className="lc-setting-row">
<div className="lc-settings-subhead">Built-in model</div>
              <p className="lc-settings-hint">
                Start or stop the AI model that comes with the app on this computer.
              </p>
              <p className="lc-muted">
                {llmStatus?.detail ?? "Status unknown"}
                {llmStatus?.pid != null ? ` · pid ${llmStatus.pid}` : ""}
              </p>
              <div className="lc-settings-actions-row">
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void startLlm()}>
                  Start local LLM
                </button>
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void stopLlm()}>
                  Stop local LLM
                </button>
                <button type="button" className="lc-secondary" disabled={!!busy} onClick={() => void refreshLlm()}>
                  Refresh
                </button>
              </div>
              </div>
</SettingsFold>
              <SettingsFold id="chatbot" title="ChatBot">
                <div className="lc-setting-row">
                  <p className="lc-settings-hint">Select text in a document and tap Ask ChatBot to get an explanation added as a footnote. Keep Pen Island open on your PC so answers can be delivered.</p>
                  <label><span>Answer with</span>
                    <select aria-label="ChatBot answer mode" value={chatBotAnswerMode} onChange={event => setChatBotAnswerMode(event.target.value as ChatBotAnswerMode)}>
                      <option value="llm">Your AI model</option>
                      <option value="bot">An assistant bot</option>
                      <option value="app">An assistant app on this PC</option>
                    </select>
                  </label>
                  {chatBotAnswerMode === "llm" ? <p className="lc-settings-hint">A local model or a cloud API key. Quick; fine for single footnotes.</p>
                    : chatBotAnswerMode === "app" ? <>
                      <p className="lc-settings-hint">Codex or Claude Code. Runs automatically when you ask for a footnote, using your subscription's limits.</p>
                      {runnerConfig ? renderRunnerFields(runnerConfig) : null}
                      {runnerStatus ? <p className="lc-settings-hint" role="status">{assistantRunnerMessage(runnerStatus)}</p> : null}
                      {runnerError ? <p className="lc-settings-hint" role="alert">{runnerError}</p> : null}
                    </> : <>
                  <p className="lc-settings-hint">Grok, Claude and others. You ask it to check, or tell it to check every few minutes.</p>
                  <label><span>Assistant</span>
                    <select aria-label="ChatBot assistant" value={chatBotClient} onChange={event => setChatBotClient(event.target.value as ChatBotClient)}>
                      {CHATBOT_CLIENTS.map(client => <option key={client.id} value={client.id}>{client.label}</option>)}
                    </select>
                  </label>
                  <p className="lc-settings-hint">{CHATBOT_CLIENTS.find(client => client.id === chatBotClient)?.help}</p>
                  <p className="lc-settings-hint">Connect the assistant in its own app. Every connected assistant sees the same list of requests.</p>
                  {/* Shown greyed out while the PC is out of reach, so it can be found. */}
                  <SettingsChoices className="lc-settings-choice">
                    <button type="button" role="switch" aria-checked={Boolean(runnerConfig?.allow_bots)} disabled={!runnerConfig}
                      className={runnerConfig?.allow_bots ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                      onClick={() => runnerConfig && setRunnerConfig({ ...runnerConfig, allow_bots: !runnerConfig.allow_bots })}>
                      <strong>Let it hand the writing to an app on this PC</strong>
                      <span className="lc-muted">{runnerConfig
                        ? "Ask your assistant to “use Codex”, and Codex or Claude Code writes the footnotes with your subscription."
                        : "Open Pen Island on your PC to change this. It is saved there."}</span>
                    </button>
                  </SettingsChoices>
                  {runnerConfig?.allow_bots ? renderRunnerFields(runnerConfig) : null}
                  {runnerStatus && runnerConfig?.allow_bots ? <p className="lc-settings-hint" role="status">{assistantRunnerMessage(runnerStatus)}</p> : null}
                  <details className="lc-settings-advanced">
                    <summary>Advanced: connection commands</summary>
                    <label><span>Command for assistants on this PC</span><input readOnly value="lc mcp" /></label>
                    <label><span>Private connection for online assistants</span><input readOnly value="lc mcp --listen 127.0.0.1:7879 --auth-token-file path-to-token.txt" /></label>
                    <p className="lc-settings-hint">Shares only footnote requests and answers, and needs its own password file. Online assistants such as Grok Bot also need the sign-in bridge; see the setup guide (docs/AI-SETUP-GUIDE.md).</p>
                  </details>
                  {chatBotClient === "dots" && <>
                    <p className="lc-settings-hint">You’ll need an OpenAI Platform tunnel ID and API key; a ChatGPT subscription alone isn’t enough.</p>
                    <a href="https://developers.openai.com/api/docs/guides/secure-mcp-tunnels" target="_blank" rel="noreferrer">OpenAI connection guide</a>
                  </>}
                  {chatBotClient === "grok" && <a href="https://docs.x.ai/grok-bot/team-bots" target="_blank" rel="noreferrer">Grok Bot connection guide</a>}
                  </>}
                </div>
              </SettingsFold>
              <SettingsFold id="voice" title="Voice typing">
              <div className="lc-setting-row">
                <p className="lc-settings-hint">Choose how the microphone in the chat box turns speech into text.</p>
                <div className="lc-settings-subhead">Engine</div>
                <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Voice typing engine">
                  {VOICE_ENGINES.map((engine) => (
                    <button
                      key={engine.id}
                      type="button"
                      role="radio"
                      aria-checked={voice.engine === engine.id}
                      className={voice.engine === engine.id ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                      onClick={() => patchVoice({ engine: engine.id })}
                    >
                      <strong>{engine.label}</strong>
                      <span className="lc-muted">{engine.blurb}</span>
                    </button>
                  ))}
                </SettingsChoices>
                {voice.engine === "local" && (
                  <>
                    <label>
                      <span>Whisper server URL</span>
                      <input
                        value={voice.local_base_url}
                        onChange={(e) => patchVoice({ local_base_url: e.target.value })}
                      />
                      <p className="lc-settings-hint">On the tablet, use this PC&apos;s address, e.g. http://192.168.1.20:8000/v1 — localhost would be the tablet.</p>
                    </label>
                    <label>
                      <span>Model</span>
                      <input
                        value={voice.local_model}
                        onChange={(e) => patchVoice({ local_model: e.target.value })}
                      />
                    </label>
                  </>
                )}
                {(voice.engine === "openai" || voice.engine === "groq") && (
                  <>
                    <label>
                      <span>Model</span>
                      <input
                        value={voice.engine === "openai" ? voice.openai_model : voice.groq_model}
                        onChange={(e) => patchVoice(voice.engine === "openai" ? { openai_model: e.target.value } : { groq_model: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>API key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={voice.engine === "openai" ? openaiKeyDraft : groqKeyDraft}
                        onChange={(e) => {
                          if (voice.engine === "openai") {
                            setOpenaiKeyDraft(e.target.value);
                            setClearOpenaiKey(false);
                          } else {
                            setGroqKeyDraft(e.target.value);
                            setClearGroqKey(false);
                          }
                        }}
                        placeholder={
                          (voice.engine === "openai" ? draft.openai_key_set : draft.groq_key_set)
                            ? "leave blank to keep the stored key"
                            : voice.engine === "openai"
                              ? "sk-…"
                              : "gsk_…"
                        }
                      />
                      <p className="lc-settings-hint">Shared with the OpenAI/Groq provider under LLM.</p>
                      {(voice.engine === "openai" ? draft.openai_key_set : draft.groq_key_set) && (
                        <HoldButton label="Clear stored key" ariaLabel="Hold to clear stored key" dataTip="Clear stored key"
                          className="lc-secondary lc-settings-icon-action lc-hold-danger"
                          onConfirm={() => {
                            if (voice.engine === "openai") {
                              setOpenaiKeyDraft("");
                              setClearOpenaiKey(true);
                            } else {
                              setGroqKeyDraft("");
                              setClearGroqKey(true);
                            }
                          }}
                        >
                          <SettingsIcon id="delete"/>
                        </HoldButton>
                      )}
                      {(voice.engine === "openai" ? clearOpenaiKey : clearGroqKey) && (
                        <p className="lc-muted">Stored key will be cleared on Save.</p>
                      )}
                    </label>
                  </>
                )}
                {voice.engine === "deepgram" && (
                  <>
                    <label>
                      <span>Model</span>
                      <input
                        value={voice.deepgram_model}
                        onChange={(e) => patchVoice({ deepgram_model: e.target.value })}
                      />
                    </label>
                    <label>
                      <span>API key</span>
                      <input
                        type="password"
                        autoComplete="off"
                        value={deepgramKeyDraft}
                        onChange={(e) => {
                          setDeepgramKeyDraft(e.target.value);
                          setClearDeepgramKey(false);
                        }}
                        placeholder={draft.deepgram_key_set ? "leave blank to keep the stored key" : ""}
                      />
                      <p className="lc-settings-hint">Kept in this device&apos;s config.toml. DEEPGRAM_API_KEY wins if set.</p>
                      {draft.deepgram_key_set && (
                        <HoldButton label="Clear stored key" ariaLabel="Hold to clear stored key" dataTip="Clear stored key"
                          className="lc-secondary lc-settings-icon-action lc-hold-danger"
                          onConfirm={() => {
                            setDeepgramKeyDraft("");
                            setClearDeepgramKey(true);
                          }}
                        >
                          <SettingsIcon id="delete"/>
                        </HoldButton>
                      )}
                      {clearDeepgramKey && (
                        <p className="lc-muted">Stored key will be cleared on Save.</p>
                      )}
                    </label>
                  </>
                )}
                <div className="lc-settings-subhead">Tidy up text</div>
                <SettingsChoices className="lc-settings-choice" role="radiogroup" aria-label="Tidy up text">
                  {VOICE_CLEANUP.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      role="radio"
                      aria-checked={voice.cleanup === option.id}
                      className={voice.cleanup === option.id ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                      onClick={() => patchVoice({ cleanup: option.id })}
                    >
                      <strong>{option.label}</strong>
                    </button>
                  ))}
                </SettingsChoices>
                <p className="lc-settings-hint">After you stop talking, an AI model fixes punctuation, capital letters and filler words like “um”. It won’t change your words.</p>
                <div className="lc-settings-subhead">Vocabulary</div>
                <p className="lc-settings-hint">Words you want spelled correctly, like names and technical terms. Start from a list and edit it; your edits become Custom. Not used by Android voice typing.</p>
                <SettingsChoices className="lc-settings-choice lc-settings-choice-compact" role="radiogroup" aria-label="Vocabulary list">
                  {[...VOCABULARY_PRESETS.map(preset => ({ id: preset.id, label: preset.label, words: preset.words })),
                    { id: "custom", label: "Custom", words: customVocabulary }].map(choice => {
                    const active = vocabularyPresetId(voice.vocabulary) === choice.id;
                    return (
                      <button key={choice.id} type="button" role="radio" aria-checked={active}
                        className={active ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
                        onClick={() => {
                          // Keep hand-edited words before a preset replaces them.
                          if (vocabularyPresetId(voice.vocabulary) === "custom") setCustomVocabulary(voice.vocabulary);
                          patchVoice({ vocabulary: choice.words });
                        }}>
                        <strong>{choice.label}</strong>
                      </button>
                    );
                  })}
                </SettingsChoices>
                <label>
                  <span>Words</span>
                  <textarea
                    rows={3}
                    value={voice.vocabulary}
                    placeholder="memoization, heapq, BFS, two pointers"
                    onChange={(e) => {
                      patchVoice({ vocabulary: e.target.value });
                      if (vocabularyPresetId(e.target.value) === "custom") setCustomVocabulary(e.target.value);
                    }}
                  />
                  <p className="lc-settings-hint">Separate words with commas or new lines.</p>
                </label>
              </div>
              </SettingsFold>
            </div>
          )}
          {searching && <p className="lc-muted lc-settings-search-empty">No matching settings.</p>}
        </div>

        <div className="lc-settings-foot lc-dialog-foot">
          <span className="lc-settings-change-count" role="status" aria-live="polite" data-changed={changeCount > 0}>{changeCount ? `${changeCount} ${changeCount === 1 ? "change" : "changes"}` : "No changes"}</span>
          {page !== "root" && <button type="button" className="lc-secondary lc-dialog-action" disabled={saving} onClick={()=>setPage("root")}>Back</button>}
          <button type="button" className="lc-secondary lc-dialog-action" disabled={saving} onClick={cancel}>Cancel</button>
          <button type="button" className="lc-primary lc-dialog-action" disabled={!dirty || saving} onClick={()=>void save({close:true})}>{saving ? "Saving..." : "Save"}</button>
        </div>
        </SettingsPageCtx.Provider>
      </DialogFrame>
    </DialogBackdrop>
  )}</DialogPresence>;
}

/**
 * Settings → Diagnostics: the debug log. The switch is part of the form and
 * takes effect on Save; exporting and clearing what is recorded are actions,
 * done at once.
 */
function DebugLogSettings({ on, saved, onChange }: {
  on: boolean;
  /** Whether the log is recording now — the switch as last saved. */
  saved: boolean;
  onChange: (on: boolean) => void;
}) {
  const [count, setCount] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    void debugLogCount().then((n) => live && setCount(n));
    return () => {
      live = false;
    };
  }, [saved]);
  return (
    <>
      <div className="lc-settings-subhead">Activity log</div>
      <p className="lc-settings-hint">
        Records what the app does on this device, to help track down problems. Off records nothing.
      </p>
      <SettingsChoices className="lc-settings-choice lc-settings-choice-compact" role="radiogroup" aria-label="Activity log">
        {([false, true] as const).map((value) => (
          <button key={String(value)} type="button" role="radio" aria-checked={on === value}
            className={on === value ? "lc-settings-choice-option is-active" : "lc-settings-choice-option"}
            onClick={() => onChange(value)}>
            <strong>{value ? "On" : "Off"}</strong>
          </button>
        ))}
      </SettingsChoices>
      {on && !saved && <p className="lc-settings-hint">Board and client calls start next launch.</p>}
      <div className="lc-settings-actions-row">
        <button type="button" className="lc-secondary" disabled={busy || !count}
          onClick={() => {
            setBusy(true);
            void exportDebugLog().finally(() => setBusy(false));
          }}>
          <SettingsIcon id="export"/> Export log{count ? ` (${count.toLocaleString()})` : ""}
        </button>
        <HoldButton label="Clear log" ariaLabel="Hold to clear log" dataTip="Clear log"
          className="lc-secondary lc-settings-icon-action lc-hold-danger" disabled={busy || !count}
          onConfirm={() => { setBusy(true); void clearDebugLog().then(() => setCount(0)).finally(() => setBusy(false)); }}>
          <SettingsIcon id="delete"/>
        </HoldButton>
      </div>
    </>
  );
}

/**
 * Settings → Licenses. The notices file is generated by
 * scripts/third-party-notices.mjs into public/, so every build carries it;
 * it is fetched only when asked for.
 */
function LicenseSettings() {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const show = () => {
    setFailed(false);
    void fetch(`${import.meta.env.BASE_URL}third-party-licenses.txt`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(setText, () => setFailed(true));
  };
  return (
    <>
      <div className="lc-settings-subhead">Pen Island</div>
      <p className="lc-settings-hint">
        Free for personal, educational and other non-commercial use. Commercial use needs a
        separate license (PolyForm Noncommercial License 1.0.0).
      </p>
      <div className="lc-settings-subhead">Open-source components</div>
      <p className="lc-settings-hint">Pen Island includes software from other authors, used under their licenses.</p>
      {text === null ? (
        <div className="lc-settings-actions-row">
          <button type="button" className="lc-secondary" onClick={show}>
            <SettingsIcon id="licenses"/> Show licenses
          </button>
        </div>
      ) : (
        <pre className="lc-settings-licenses" tabIndex={0}>{text}</pre>
      )}
      {failed && <p className="lc-settings-hint">Couldn’t load the license list.</p>}
    </>
  );
}
