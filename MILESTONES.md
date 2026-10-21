# GPU port: milestones

This branch (`gpu-port`) is a port of the document surface to WebGPU. Pages, ink and page
turns are drawn on the GPU under one camera, to cut memory use and rendering latency.

The port is developed separately and never merges into `main`. `main` is merged into it, one
way, in small steps. A build of `main` pinned to a commit is the baseline: the port has to
match it in look, timing, behaviour and saved data.

## Ground rules

- **Same app.** Ink look and feel, erasing and undo, gestures, selection, links, animations
  and their timings, captures, exports, and everything that is saved or synced stay as they
  are on `main`.
- **No second renderer on screen.** A device without WebGPU gets a clear message instead of
  a fallback.
- **Text stays real HTML at rest.** Markdown, EPUB and statement pages are browser HTML when
  still. The GPU draws the paper underneath and the ink on top, and shows a picture of the
  page only while it moves.
- **Web pages stay HTML** (captured and live).
- **PDF pages** are drawn by pdf.js and shown by the GPU as textures.
- **Data is compatible both ways.** Port and `main` builds sync with the same hub, so the
  port must never save anything that `main` reads differently.

## Testing

Every milestone adds tests, and keeps all earlier ones running.

1. **Logic tests** (Vitest, Node): geometry, camera, memory budget, saved-data invariants.
2. **GPU tests in a browser** (Vitest browser mode, Chromium with WebGPU). Output is compared
   with reference images made by `main` from the same input. Fails if no GPU adapter is
   present.
3. **Full-app tests** on Windows and on an Android tablet: whole-window screenshots, recorded
   pen input, frame timing, memory by source.
4. **Physical input checklist** on the tablet: pen and palm, second finger, screen-edge
   gestures, long-press selection, rotation.

Reference images and traces record where they came from (`main` commit, documents, settings,
viewport, input timing). Performance is judged against measured distributions with set
tolerances.

## Milestones

| # | Milestone | Done when |
|---|---|---|
| M0a | **Infrastructure and isolation.** The port installs beside the current app (its own app id and local data, on Android and desktop). Test tooling for all four layers. Dead code removed. | Both builds run side by side with separate data. All test layers run. |
| M0b | **Baseline, contracts, experiments.** Reference recordings from `main`. Numeric memory and latency targets. Capture, page-readiness, ink-lifecycle, resource and coordinate contracts as tested interfaces. Experiments: ink parity, layer stacking, HTML picture handoff, full page-turn stack, GPU start-up and device loss. | The baseline reproduces within tolerance, contracts pass against `main`, and each experiment has a go or a redesign. |
| M1 | **The WebGPU module, in test pages.** Device and recovery, surfaces, camera, one memory budget, textured pages, ink (pen, highlighter, erase preview). | Drawing matches `main`'s reference images on desktop and tablet. Recovery from device loss is proven at every stage. |
| M2 | **Ink in the app.** The old ink tile caches are removed. | Same ink, erasing, undo/redo and saved bytes as `main`, including races between stroke finalising and undo. Ink memory within target. |
| M3 | **One camera.** The CSS layer sliding is removed. | Pan, pinch, flick, rotation and resizing match `main` during gestures, not only at rest. No layer drift. Saved data unchanged. |
| M4 | **PDF pages as GPU textures.** | Pages, marks, captures, exports and thumbnails match `main`. Open time and total memory within target. |
| M5 | **Markdown, EPUB and statement pages.** HTML at rest, a texture during motion. | No visible handoff. Selection, links and focus intact. No stale pictures after edits or image loads. |
| M6 | **Page turn on the GPU,** keeping the current curl and timings. | Turn shape and timing match `main`. Grab and landing are no slower. |
| M7 | **Sync soak.** The port used day to day beside `main`. | Controlled two-way sync scenarios pass, and a week of use shows no unexplained data differences. |
| M8 | *Optional:* **a GPU vector PDF renderer** evaluated against M4. | Adopted only if it wins on speed, memory and fidelity. |
| M9a | **Scroll and Pages as one layout choice.** | Product sign-off, and compatibility checks pass. |
| M9b | **New whiteboards from the Annotate menu,** replacing the separate entry point. | Product sign-off, and existing whiteboards are unaffected. |

## Status

M0a has not started.
