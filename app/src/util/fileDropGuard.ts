/**
 * Keep a dropped file from replacing the app.
 *
 * The desktop window lets the page handle file drops (`dragDropEnabled: false`
 * in tauri.conf.json), so the Video tab's drop zone gets files dragged in from
 * Explorer. The cost is the browser's own default: a file dropped anywhere
 * else would be opened in place of the app. These listeners sit on `window`
 * and run after every handler below them, so a drop zone that took the file
 * has already called `preventDefault` and is left alone. Anywhere else the
 * drag shows "no drop" and the drop does nothing.
 */

function carriesFiles(event: DragEvent): boolean {
  return Boolean(event.dataTransfer?.types && Array.from(event.dataTransfer.types).includes("Files"));
}

export function installFileDropGuard(target: Window = window): () => void {
  const over = (event: DragEvent) => {
    if (!carriesFiles(event) || event.defaultPrevented) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
  };
  const drop = (event: DragEvent) => {
    if (carriesFiles(event) && !event.defaultPrevented) event.preventDefault();
  };
  target.addEventListener("dragover", over);
  target.addEventListener("drop", drop);
  return () => {
    target.removeEventListener("dragover", over);
    target.removeEventListener("drop", drop);
  };
}
