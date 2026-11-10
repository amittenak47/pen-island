# Pen Island architecture

Internals. If you just want to install and use the app, read the
[README](README.md) instead.

---

## The pieces

| Name | What it is | Where |
| --- | --- | --- |
| Root Rust crate | `whiteboard`, the shared engine: corpus index, Practice tests, router, notebook DB | [`Cargo.toml`](Cargo.toml) |
| CLI binary | `lc`: `index`, `datasets`, `config`, and `mcp` (the MCP server for ChatBot and agent requests); from `cargo install --path .` | [`src/`](src/) |
| GUI crate | `whiteboard-gui` | [`app/src-tauri/Cargo.toml`](app/src-tauri/Cargo.toml) |
| GUI native lib | `whiteboard_lib`, which Android links as `libwhiteboard_lib.so` | same |
| Client | React + Vite | [`app/src/`](app/src/) |
| Android id | `dev.lc.whiteboard`, shared by both build flavors | |

The Practice split uses Cargo feature `leetcode` (on by default) together with
`VITE_FEATURE_LEETCODE`. Disabling both gives the Whiteboard-only build.

The five native plugins are `gallerysave` (screenshot saves), `gestureguard`
(writing gesture protection), `inkrecognition` (ML Kit), `livewebview` (native
pages and page screenshots), and `voicedictation`. They live under
[`app/src-tauri/plugins/`](app/src-tauri/plugins/).

## Names you'll see in the code

Pen Island is the public product name. The executable `lc`, Rust crates
`whiteboard` / `whiteboard-gui`, native library `whiteboard_lib`, app id
`dev.lc.whiteboard`, plugin packages, CSS `lc-` classes and `lc_*` commands stay
stable. Storage keys and databases (`whiteboard.*`, `lc`, `pads.db`, `pad-blobs`),
Practice directories (`~/lc-workspace`, `.lc/`), and backup formats keep their
existing names so data and imports continue to work. Whiteboard also remains
the mode and build-flavor name. The GitHub repository was renamed from
`lc-gui-tui` to `pen-island`; GitHub redirects the old repository and download
URLs, so builds that still fetch problem sets from the old address keep working.

The `lc` CLI handles corpus indexing, dataset inspection and configuration, and
`lc mcp` serves Pen Island's MCP tools to an AI assistant; bare `lc` prints
help. The separate `audit_tests` binary audits corpus tests. Problem editing,
tests and Agent interactions run through the app.

---

## There is no daemon

Tauri dispatches local app commands through axum in-process. Tests run on
RustPython rather than a `python` executable, on desktop and Android alike.
There is no separate `lc serve` CLI daemon.

Desktop startup also serves the shared router on `0.0.0.0`, at configured
`serve.port` (default **7878**), with a persisted six-digit pairing code. Both
Practice and Whiteboard-only host this LAN Pad hub. Its PC URL and code appear
under **Settings → Personalize → Storage → Sync with your PC**; the tablet connects from
the same section. Android keeps its own embedded router and does not start this
desktop listener. Model calls and corpus downloads use network services.

```
JSON corpora ──lc index / GUI install──▶ SQLite (problems.db)
                                       │
                        Practice open: /problems/:id/load
                                       ▼
        ~/lc-workspace/[<dataset>/]<task_id>/
        ├── solution.py
        ├── board.json          ← whiteboard, when kept
        ├── run_tests.py
        └── .lc/meta.json       ← cases / entry point (no reference solution)
                                       │
                              In-app Run tests / Agent
```

```mermaid
flowchart LR
  subgraph gui [Desktop_GUI]
    UI[Canvas_UI]
    Axum[in_process_axum]
    RP[RustPython]
    Corpus[SQLite_corpus]
    WS[lc_workspace]
    Pads[pads.db_and_pad_blobs]
    LAN[LAN_listener_0.0.0.0_7878]
    UI -->|"named invoke"| Axum
    LAN -->|"same router; pairing code"| Axum
    Axum --> RP
    Axum --> Corpus
    Axum --> WS
    Axum --> Pads
  end
  Tablet[Tablet_local_working_copy] <-->|"Pad hub sync"| LAN
  Axum -->|"chat completions"| LLM[Local_Ollama_OpenAI_Groq]
  Axum -->|"headless run, MCP tools only"| App[Codex_or_Claude_Code]
  Bot[MCP_assistant_via_lc_mcp] -->|"requests and answers"| LAN
```

Layers that move independently:

| Layer | What | Where | "Anywhere" means |
| --- | --- | --- | --- |
| Canvas UI | Ink, footnotes, tabs | On the device | Already there |
| Agent / LLM | Chat HTTP to a model, or a run answered by an assistant app or MCP assistant | Same process as the GUI, out to the model URL; assistant runs go through the desktop | The model URL must be reachable from *this* device; assistant runs need the desktop app running |
| Harness | Corpus, `solution.py`, RustPython tests, document index | Inside the GUI process | Workspaces and `problems.db` on this machine |
| Pad hub | Notebook, document, problem-board and attachment history | Desktop LAN listener and local disk | A paired device can sync library content; pairing does not install its corpus or runtime |

The same React client runs on desktop, on Android, and under Vite. Vite in a
browser (`npm run dev`) has no Tauri behind it and is not a supported path. To
drive the desktop window from a tablet, use spacedesk. That sends pixels, not a
second instance.

---

## Notebooks vs problems

```mermaid
flowchart TD
  subgraph device [Device_working_copies]
    WB[Whiteboard_IndexedDB]
    AN[Annotate_IndexedDB]
    PB[Problem_board_IndexedDB]
  end
  subgraph hub [Local_backend_or_paired_desktop_hub]
    Pads[pads.db_and_pad_blobs]
  end
  WB <--> Pads
  AN <--> Pads
  PB <--> Pads
  subgraph practice [Local_Practice_execution]
    Load[Open_problem]
    Load --> Workspace[device_workspace]
    Workspace --> Tests[lc_run_tests]
    Tests --> Progress[config_session.json_and_last_run.json]
  end
```

| Surface | Offline | Sync |
| --- | --- | --- |
| Whiteboard / Annotate | The working copy is IndexedDB on the device; downloaded documents and ink remain available offline. | Dual-writes to the local backend or paired hub's `pads.db` and `pad-blobs/`: documents, boards, agent threads, attachments and snapshots. Tombstones archive items across devices; sidecar `.lc-ink.json` files are backups. |
| Problem boards | Local board, agent and attachment working copies can be edited offline. Practice needs a corpus installed under Settings → Workspace → Problem sets → Install. | Live problem boards, agent threads and attachments sync through the pad store, addressed by `dataset/task_id`. Offline edits sync on the next pass; reconnecting can surface a conflict. |
| Practice execution / progress | Generated Python workspaces and attempt archives stay on the executing device. RustPython tests run there. `session.json` and `last_run.json` live under its backend config root. | Pairing does not copy the corpus index, Python runtime, generated workspaces, or session/test-result files. Dataset Remove/reinstall preserves the local progress file. |

The device IndexedDB is the working copy. `pads.db` is the backend historical
copy, local or on a paired desktop hub. A missing or corrupt local row must
never delete the on-disk copy. Delete is hold-to-confirm and tombstones the live
list. Restore comes from the library's Trash view or available 2h / 24h / 7d
snapshots; annotation/whiteboard export and import provide independent backups.

Offline board conflict policy `offlineMerge` supports ask / prefer-local /
prefer-server. Hub conflicts also have explicit comparison and resolution;
sharing only the Python workspace directory does not share every kind of state.

Personalize (handedness, theme, screenshot folder, and so on) is a per-device blob.
Video tab marks are device-local for now.

### A note on the word "pad"

It means two unrelated things in this repo, and only one of them was renamed.

**The build flavor.** What used to be called "pads-only" is now
**Whiteboard-only**. Scripts and npm targets are renamed. The old names still
work as forwarding wrappers.

**The notebook library.** `pads.db`, `pad-blobs/`, `/pads/…`,
[`src/pads.rs`](src/pads.rs), `PadKind`. Not renamed. These name data on disk in
every existing install. Changing them is a runtime migration rather than a
rename, and getting it wrong opens the app to an empty library.

"Scratchpad" is a third thing again, the blank-notebook mode as opposed to
annotating a PDF. Also unchanged.

---

## The agent

Redaction lives in [`src/gate/`](src/gate/) and the dataset adapters, diagrams
as programs rather than pictures in [`src/llm/viz/`](src/llm/viz/) (validated in
[`src/serve/viz.rs`](src/serve/viz.rs)), the approach-commitment model in
[`src/llm/coach/approach.rs`](src/llm/coach/approach.rs), and the frame contract
in [`src/serve/ws.rs`](src/serve/ws.rs) and
[`src/llm/coach/events.rs`](src/llm/coach/events.rs). The client side, and how
the coach is kept honest, is in
[app/README.md](app/README.md#how-the-practice-agent-is-kept-honest).

Ordinary Ask, Review and planning use redacted problem sources. Explicitly
confirmed Reveal can load the reference solution to build a bridge; its intended
output is a stepwise path from the student's work. The legacy reveal-mode Lazy
path also uses this confirmation boundary. The current composer's separate
`lazy_fill` action works from the board and approach claim without loading the
reference or granting Reveal consent.

Review runs perceive → claim → verdict inside the process, and answers over
Tauri events (`lc-coach-frame-<channel>`) so each stage appears as it happens. It is sent
through Review in the Agent composer. Practice toolbar Submit runs solution
tests; it does not send a solution to a judge site.

HTTP routes stay `/coach/*`. Config keys stay `coach.*` and
`llm.modes.<ambient|review|bridge|viz|planner>`. The rename to "Agent" is
user-facing only. `/workspace/:id/agent` is a different thing: the chat
transcript file.

Feature flags:
`coach.<ws_runs|process_events_ui|approach_commitment|planner_enabled|draw_review_enabled|agent_mcp_tools|agent_send_board_image>`,
plus `coach.agent_bot_timeout_secs` (60 to 600, default 600).

### Assistant apps, AI assistants and ChatBot

Each `llm.modes.*` entry is a model provider (`local`, `ollama`, `openai`,
`groq`) or one of two assistants:

- `app`: the desktop app runs Codex or Claude Code headless, in an empty
  directory, with only Pen Island's MCP tools
  ([`src/serve/agent_cli.rs`](src/serve/agent_cli.rs)). Codex must be a version
  on `VERIFIED_CODEX_VERSIONS`; Claude Code needs a claude.ai sign-in.
- `bot`: the run waits in the agent-run registry
  ([`src/llm/coach/agent_runs.rs`](src/llm/coach/agent_runs.rs)) for an MCP client
  connected through `lc mcp` ([`src/mcp.rs`](src/mcp.rs),
  [`src/mcp/coach.rs`](src/mcp/coach.rs)), up to `coach.agent_bot_timeout_secs`.

The window and the desktop LAN listener share one agent-run registry, so a run
started on a paired tablet is answered on the PC too.

ChatBot footnotes use the same pieces. Requests and page runs (annotation jobs)
live in the hub's footnote inbox ([`src/pads/`](src/pads/)). They are written by
the configured model ([`src/serve/footnote_answers.rs`](src/serve/footnote_answers.rs),
single footnotes only), by an MCP assistant, or by the assistant app that
[`src/serve/assistant_runner.rs`](src/serve/assistant_runner.rs) starts, one
process at a time, with its settings under `assistant_app.*`.

---

## Building

Use Rust **1.93+** and Node **22.13+** with the current locks. Android wrappers
select JDK **17–24**. Windows Android Practice builds also need Git for Windows
and GNU make for RustPython; Whiteboard-only omits those cp/make prerequisites. See the
[Android setup guide](app/docs/ANDROID_SETUP.md) for the environment and wrappers.

| Change | Root `Cargo.lock` | `app/src-tauri/Cargo.lock` | `app/package-lock.json` | Rebuild? |
| --- | --- | --- | --- | --- |
| Docs | no | no | no | no |
| `package.json` **scripts**, `.cmd` / `.sh` / `.mjs` | no | no | no, scripts are not in the lockfile | no, until you want a new APK |
| `.github/workflows/*.yml` | no | no | no | CI compiles on next push |
| Rust dependency changes | update if affected | update if affected | no | affected Rust binaries |
| Renaming the `whiteboard` crate | yes | yes | no | everything, plus `package = "whiteboard"` in the GUI crate |

Both APK flavors build aarch64 only. Practice has to, because rustpython 0.5
does not compile for 32-bit Android, and Whiteboard-only is pinned the same way
so each build compiles one target. Don't add armv7, x86 or x86_64 targets. The
debug output still uses Tauri's universal flavor name, with only arm64 inside:

```
app/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
```

A build split per ABI lands at `.../apk/arm64/debug/app-arm64-debug.apk`
instead, which the Practice installer also accepts. Nothing under `gen/` is in
git. The parts worth keeping live in
`app/src-tauri/android-overlay/`.

CI pins NDK **r26d**. Local tablet builds have been on **29.0.13846066**. Both
work. If a build fails in one place and not the other, check that first.

### Auditing a corpus

```bash
cargo run --release --bin audit_tests -- --dataset kodcode --out audit-kodcode.jsonl
cargo run --release --bin audit_tests -- --dataset kodcode --out audit-kodcode.jsonl --resume
```

One JSON object per problem whose tests RustPython cannot execute. It flushes
every 25 rows, and `--resume` continues after a crash.

Dataset adapters live in [`src/datasets/`](src/datasets/). After changing one,
run `lc index --dataset <slug> --rebuild`.

---

## Not done yet

- Explore is shipped as WIP.
- The Video tab is in testing, and its marks don't sync through the hub yet.
