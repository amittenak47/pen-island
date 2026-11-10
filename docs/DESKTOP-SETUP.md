# Desktop setup

There's no prebuilt desktop download yet. [Releases](https://github.com/amittenak47/pen-island/releases)
only carry Android APKs, so on desktop you build Pen Island yourself. This guide
covers two ways to run it:

| | Development mode | Installed app |
| --- | --- | --- |
| Command | `npm run tauri dev` | `npm run tauri build`, then run the installer |
| Start-up | Builds and opens from a terminal each time | Start menu, like any app |
| Code changes | Picked up live | Rebuild and reinstall |
| Use it for | Working on the code | Day-to-day use |

Only Windows has been tested. Tauri can also build for macOS and Linux, but
those builds haven't been tried.

---

## 1. Prerequisites

- **Rust 1.93+**: [rustup.rs](https://rustup.rs)
- **Node 22.13+**: [nodejs.org](https://nodejs.org)
- **Tauri's platform prerequisites**: see
  [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). On Windows
  that's the Microsoft C++ Build Tools and WebView2. WebView2 already comes with
  Windows 11.
- **Not needed for the desktop app:** Git for Windows and GNU make. Only the
  Android Practice build on Windows needs them, to compile the Python test
  runner's `libffi` for Android (see the
  [Android setup guide](../app/docs/ANDROID_SETUP.md)). A desktop build on
  Windows compiles it with the Microsoft C++ tools.

Then install the client's packages once, from `app/`:

```bash
npm install
```

---

## 2. Development mode

From `app/`:

```bash
npm run tauri dev
```

The first build takes several minutes; later ones are much faster. The window
opens on Home.

`npm run dev` on its own opens the client in a browser with no backend behind
it. That isn't a supported way to run the app.

---

## 3. Build an installed app

From `app/`:

```bash
npm run tauri build
```

This builds an optimized app and wraps it in installers. On Windows you get two,
under `app/src-tauri/target/release/bundle/`:

| Installer | File |
| --- | --- |
| Setup program (recommended) | `nsis/Pen Island_0.1.0_x64-setup.exe` |
| Windows Installer package | `msi/Pen Island_0.1.0_x64_en-US.msi` |

Either one works. Run it, and Pen Island shows up in the Start menu. The plain
program is also at `app/src-tauri/target/release/whiteboard-gui.exe` if you'd
rather run it without installing.

The installers aren't code-signed, so Windows SmartScreen may warn the first
time. Choose **More info → Run anyway**.

To rebuild just the program without installers (faster, for updating your own
copy), use:

```bash
npm run tauri -- build --no-bundle
```

and run `app/src-tauri/target/release/whiteboard-gui.exe`. Close the running app
first: Windows can't replace a program that's open.

### Whiteboard-only build

To leave Practice out, set both flags together. The Vite flag hides the Practice
card; the Cargo flag leaves the test runner out of the program.

```powershell
# Windows PowerShell, from app/
$env:VITE_FEATURE_LEETCODE = "0"
npm run tauri -- build -- --no-default-features
```

```bash
# Linux / macOS, from app/
VITE_FEATURE_LEETCODE=0 npm run tauri -- build -- --no-default-features
```

---

## 4. Updating

There's no auto-update. To update:

1. Pull the latest code.
2. Run `npm install` from `app/` if `package-lock.json` changed.
3. Run `npm run tauri build` again.
4. Close Pen Island, then run the new installer over the old one.

Your notebooks, documents and settings aren't stored in the install folder, so
reinstalling keeps them.

**When uninstalling, leave "Delete the application data" unticked.** Ticking it
can remove your local library. Builds from before the rename are called
**Whiteboard** in the Apps list; once Pen Island is installed you can uninstall
Whiteboard, again without ticking that box.

---

## 5. Where things live

| What | Where (Windows) |
| --- | --- |
| Settings (`config.toml`) | `%APPDATA%\lc\config\` |
| Search and problem indexes (`docs.db`, `problems.db`) | the same folder as `config.toml` |
| Practice working folders | `%USERPROFILE%\lc-workspace` |

`lc config path` prints the exact config path.

---

## 6. The `lc` command-line tool (optional)

The repo also builds `lc`, a small tool for problem sets and for connecting AI
assistants to ChatBot footnotes. The app doesn't need it. To install it, from the
repo root:

```bash
cargo install --path .
```

That puts `lc.exe` in `%USERPROFILE%\.cargo\bin`. `lc mcp` lets an AI assistant
answer ChatBot footnotes (`lc mcp --listen 127.0.0.1:7879 --auth-token-file
<file>` serves it over HTTP). See
[Maintenance commands](../README.md#maintenance-commands) and the
[AI setup guide](AI-SETUP-GUIDE.md#option-b-an-assistant-bot-over-mcp).

The **assistant app** ChatBot mode doesn't need `lc` installed: the desktop app
starts Codex or Claude Code with its own copy of the tools.

---

## Next steps

- Connect a tablet: [Using a tablet and a PC together](../README.md#using-a-tablet-and-a-pc-together)
- Install problem sets: [Problem sets](../README.md#problem-sets)
- Set up a model and ChatBot: [AI setup guide](AI-SETUP-GUIDE.md)
