# Agent notes

## Builds

Every extra target, flavor or target folder is a separate full Rust build
(tens of GB). Build only what the task needs.

During development, debug builds only:

| Testing on | Command (from repo root) | Lands in |
|---|---|---|
| Desktop | `cd app && npm run tauri dev` | `app/src-tauri/target/debug` |
| Tablet | `npm run android:wireless:practice` | `app/src-tauri/target/aarch64-linux-android/debug` |
| Rust compiles | `cargo check` in `app/src-tauri` | same `target/` as above |

- The tablet is arm64. Never build armv7, x86, x86_64 or a target-less
  `tauri android build`. The npm scripts are pinned to `aarch64`. Use them.
- Build the whiteboard flavor (`android:wireless:whiteboard`) only when the
  task is about the whiteboard-only APK. It compiles a second full set.
- Don't set `CARGO_TARGET_DIR` or make one-off target folders. Reuse the
  default `target/` so checks share compiled files.
- Don't run `cargo clean` or delete `target/` to "start fresh". A rebuild
  from scratch costs far more than it saves.

Release builds happen only at the end of a piece of work, once or a few
times, and only when the user asks:

- Desktop: `cd app && npm run tauri build` (installer in
  `app/src-tauri/target/release/bundle/`).
- Android: `cd app && npm run android:apk:release` (arm64).

## Temp files

Put scratch files, test APKs and review output in your session's scratch or
system temp directory, not `.tmp-*` in the repo. If a task needs a repo-local
temp folder, delete it when the task is done.
