/**
 * Filling a PDF's form fields with the pen.
 *
 * Two pieces. {@link PdfFormBoxes} draws each field's outline inside the
 * page's sheet — it rides the page, so the board camera, spread mode and the
 * fitted reader move it for free, and it never takes the pointer. The hook
 * {@link usePdfFormFill} answers a pen tap on a field: the board's ink layer
 * sits over the page, so the tap is caught at the window before the ink sees
 * it, and only when it lands on a field — ink everywhere else still draws.
 *
 * The values are painted by pdf.js into the page bitmap (`ENABLE_STORAGE`),
 * not drawn here. The one editor floats over the field being edited, portalled
 * to the body like the selection chrome: inside the board the scroll
 * gatekeeper takes pointer capture and a control there never gets its click.
 */

import { type CSSProperties, type ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  pdfFieldValue,
  samePdfFormValue,
  type PdfFormModel,
  type PdfFormValue,
  type PdfFormValues,
  type PdfFormWidget,
} from "./pdfForms";

/** A field whose new value is waiting for its page to repaint. */
export type PdfFormPending = ReadonlyMap<string, PdfFormValue>;

const TAP_SLOP_PX = 10;
const TAP_MS = 450;

function pendingGlyph(widget: PdfFormWidget, value: PdfFormValue): string {
  if (widget.kind === "checkbox") return value === true ? "✓" : "";
  if (widget.kind === "radio") return value === widget.exportValue ? "●" : "";
  if (widget.kind === "choice") {
    const picked = Array.isArray(value) ? value : [value];
    return picked.map((v) => widget.options?.find((o) => o.value === v)?.label ?? v).join(", ");
  }
  return typeof value === "string" ? value : "";
}

/** One page's field outlines, in sheet coordinates. */
export function PdfFormBoxes({
  widgets,
  sheetWidth,
  height,
  pending,
}: {
  widgets: readonly PdfFormWidget[];
  sheetWidth: number;
  height: number;
  pending: PdfFormPending;
}) {
  return (
    <div className="lc-pdf-form" aria-hidden="true">
      {widgets.map((widget) => {
        const boxHeight = widget.box.height * height;
        const waiting = pending.get(widget.field);
        const style: CSSProperties = {
          left: widget.box.left * sheetWidth,
          top: widget.box.top * height,
          width: widget.box.width * sheetWidth,
          height: boxHeight,
          fontSize: Math.max(4, Math.min(boxHeight * 0.62, 14)),
        };
        return (
          <div
            key={widget.id}
            className={`lc-pdf-form-box lc-pdf-form-${widget.kind}${widget.readOnly ? " is-readonly" : ""}`}
            data-form-widget={widget.id}
            style={style}
          >
            {waiting !== undefined && (
              <span className={`lc-pdf-form-pending${widget.multiline ? " is-multiline" : ""}`}>
                {pendingGlyph(widget, waiting)}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface Editing {
  widget: PdfFormWidget;
  box: HTMLElement;
  draft: PdfFormValue;
}

const contains = (rect: DOMRect, x: number, y: number) =>
  x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

/**
 * Pen taps on fields, and the editor for the one being filled.
 *
 * `slotsFor(page)` returns the page's slots (two in spread mode); a box is hit
 * only where its slot shows it, since the other half's copy is clipped away.
 */
export function usePdfFormFill({
  model,
  values,
  fill,
  slotsFor,
  onChange,
}: {
  model: PdfFormModel;
  values: PdfFormValues;
  fill: boolean;
  slotsFor: (page: number) => HTMLElement[];
  onChange: (values: PdfFormValues) => void;
}): ReactNode {
  const [editing, setEditing] = useState<Editing | null>(null);
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const editorRef = useRef<HTMLDivElement | null>(null);
  const valuesRef = useRef(values);
  valuesRef.current = values;
  const modelRef = useRef(model);
  modelRef.current = model;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const slotsForRef = useRef(slotsFor);
  slotsForRef.current = slotsFor;

  const write = useCallback((field: string, value: PdfFormValue) => {
    const current = valuesRef.current;
    const fileValue = modelRef.current.defaults[field];
    if (samePdfFormValue(pdfFieldValue(modelRef.current, current, field), value)) return;
    const next = { ...current };
    // Sparse: back to the file's own value means nothing to remember.
    if (fileValue !== undefined && samePdfFormValue(fileValue, value)) delete next[field];
    else next[field] = value;
    valuesRef.current = next;
    onChangeRef.current(next);
  }, []);

  /** `only`: close just that widget's editor — a leaving editor's blur must not close the next. */
  const close = useCallback((commit: boolean, only?: string) => {
    const open = editingRef.current;
    if (!open || (only !== undefined && open.widget.id !== only)) return;
    if (commit) write(open.widget.field, open.draft);
    editingRef.current = null;
    setEditing(null);
  }, [write]);

  const hitAt = useCallback((x: number, y: number): { widget: PdfFormWidget; box: HTMLElement } | null => {
    const byPage = new Map<number, PdfFormWidget[]>();
    for (const widget of modelRef.current.widgets) {
      if (widget.readOnly) continue;
      let list = byPage.get(widget.page);
      if (!list) byPage.set(widget.page, list = []);
      list.push(widget);
    }
    for (const [page, widgets] of byPage) {
      for (const slot of slotsForRef.current(page)) {
        if (!contains(slot.getBoundingClientRect(), x, y)) continue;
        for (const widget of widgets) {
          const box = slot.querySelector<HTMLElement>(`[data-form-widget="${CSS.escape(widget.id)}"]`);
          if (box && contains(box.getBoundingClientRect(), x, y)) return { widget, box };
        }
      }
    }
    return null;
  }, []);

  const activate = useCallback((widget: PdfFormWidget, box: HTMLElement) => {
    close(true);
    const current = pdfFieldValue(modelRef.current, valuesRef.current, widget.field);
    if (widget.kind === "checkbox") {
      write(widget.field, current !== true);
      return;
    }
    if (widget.kind === "radio") {
      if (widget.exportValue) write(widget.field, widget.exportValue);
      return;
    }
    // Rendered now, inside the gesture, so focusing the input raises the soft keyboard.
    flushSync(() => setEditing({ widget, box, draft: current }));
  }, [close, write]);

  useEffect(() => {
    if (!fill) {
      close(true);
      return;
    }
    if (model.widgets.length === 0) return;
    let touch: { id: number; x: number; y: number; at: number } | null = null;
    let swallowMouseUntil = 0;
    const inEditor = (target: EventTarget | null) =>
      target instanceof Node && !!editorRef.current?.contains(target);
    const onDown = (event: PointerEvent) => {
      if (inEditor(event.target)) return;
      if (event.pointerType === "touch") {
        touch = event.isPrimary ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: event.timeStamp } : null;
        return;
      }
      if (event.button !== 0 && event.pointerType === "mouse") return;
      const hit = hitAt(event.clientX, event.clientY);
      if (!hit) {
        close(true);
        return;
      }
      // Before the ink layer, the gatekeeper and text selection see it.
      event.preventDefault();
      event.stopImmediatePropagation();
      activate(hit.widget, hit.box);
    };
    const onUp = (event: PointerEvent) => {
      if (event.pointerType !== "touch" || !touch || event.pointerId !== touch.id) return;
      const start = touch;
      touch = null;
      if (inEditor(event.target)) return;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX) return;
      if (event.timeStamp - start.at > TAP_MS) return;
      const hit = hitAt(event.clientX, event.clientY);
      if (!hit) {
        close(true);
        return;
      }
      // A finger tap's compatibility mousedown would blur the new input.
      swallowMouseUntil = event.timeStamp + 600;
      activate(hit.widget, hit.box);
    };
    const onMouseDown = (event: MouseEvent) => {
      if (event.timeStamp < swallowMouseUntil && !inEditor(event.target)) event.preventDefault();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("mousedown", onMouseDown, true);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("mousedown", onMouseDown, true);
    };
  }, [fill, model, hitAt, activate, close]);

  // A model from another document invalidates the field being edited.
  useEffect(() => {
    const open = editingRef.current;
    if (open && !model.widgets.some((widget) => widget.id === open.widget.id)) {
      editingRef.current = null;
      setEditing(null);
    }
  }, [model]);

  return createPortal(
    <AnimatePresence>
      {editing && (
        <PdfFieldEditor
          key={editing.widget.id}
          editing={editing}
          editorRef={editorRef}
          onDraft={(draft) => {
            const open = editingRef.current;
            if (!open || open.widget.id !== editing.widget.id) return;
            const next = { ...open, draft };
            editingRef.current = next;
            setEditing(next);
          }}
          onCommit={() => close(true, editing.widget.id)}
          onCancel={() => close(false, editing.widget.id)}
          onPick={(value) => {
            const open = editingRef.current;
            if (!open || open.widget.id !== editing.widget.id) return;
            editingRef.current = { ...open, draft: value };
            close(true);
          }}
        />
      )}
    </AnimatePresence>,
    document.body,
  );
}

/** Follows its field while the camera moves; the field's own box is the anchor. */
function PdfFieldEditor({
  editing,
  editorRef,
  onDraft,
  onCommit,
  onCancel,
  onPick,
}: {
  editing: Editing;
  editorRef: React.RefObject<HTMLDivElement | null>;
  onDraft: (value: PdfFormValue) => void;
  onCommit: () => void;
  onCancel: () => void;
  onPick: (value: PdfFormValue) => void;
}) {
  const { widget, box, draft } = editing;
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const [rect, setRect] = useState(() => box.getBoundingClientRect());

  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    let frame = 0;
    let last = "";
    const follow = () => {
      const next = box.getBoundingClientRect();
      const key = `${next.left}|${next.top}|${next.width}|${next.height}`;
      if (key !== last) {
        last = key;
        setRect(next);
      }
      frame = requestAnimationFrame(follow);
    };
    frame = requestAnimationFrame(follow);
    return () => cancelAnimationFrame(frame);
  }, [box]);

  const lineHeight = Math.max(30, Math.min(rect.height, 48));
  // A list opens below its field, or above it when the screen ends first.
  const listHeight = Math.min(320, window.innerHeight * 0.5, ((widget.options?.length ?? 0) + (widget.multiSelect ? 1 : 0)) * 40 + 16);
  const listTop = rect.bottom + 4 + listHeight > window.innerHeight - 8 && rect.top - 4 - listHeight >= 8
    ? rect.top - 4 - listHeight
    : rect.bottom + 4;
  const style: CSSProperties = {
    left: Math.max(8, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8)),
    top: widget.kind === "choice" ? listTop : rect.top + (rect.height - (widget.multiline ? Math.max(rect.height, 72) : lineHeight)) / 2,
    width: Math.max(rect.width, widget.kind === "choice" ? 180 : 140),
  };
  const fontSize = Math.max(15, Math.min(rect.height * 0.6, 22));

  const keys = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    } else if (event.key === "Enter" && !(widget.multiline && event.shiftKey) && !widget.multiline) {
      event.preventDefault();
      onCommit();
    } else if (event.key === "Tab") {
      event.preventDefault();
      onCommit();
    }
  };

  return (
    <motion.div
      ref={editorRef}
      className={`lc-pdf-form-editor lc-pdf-form-editor-${widget.kind}`}
      style={style}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
    >
      {widget.kind === "text" && (widget.multiline ? (
        <textarea
          ref={(node) => { inputRef.current = node; }}
          className="lc-pdf-form-input"
          aria-label={widget.field}
          value={typeof draft === "string" ? draft : ""}
          maxLength={widget.maxLen}
          style={{ fontSize, minHeight: Math.max(rect.height, 72) }}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={keys}
          onBlur={onCommit}
        />
      ) : (
        <input
          ref={(node) => { inputRef.current = node; }}
          className="lc-pdf-form-input"
          aria-label={widget.field}
          type={widget.password ? "password" : "text"}
          value={typeof draft === "string" ? draft : ""}
          maxLength={widget.maxLen}
          enterKeyHint="done"
          style={{ fontSize, height: lineHeight }}
          onChange={(event) => onDraft(event.target.value)}
          onKeyDown={keys}
          onBlur={onCommit}
        />
      ))}
      {widget.kind === "choice" && (
        <div className="lc-pdf-form-options" role="listbox" aria-label={widget.field} aria-multiselectable={widget.multiSelect || undefined}>
          {(widget.options ?? []).map((option) => {
            const picked = Array.isArray(draft) ? draft.includes(option.value) : draft === option.value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={picked}
                className={picked ? "lc-pdf-form-option is-picked" : "lc-pdf-form-option"}
                onClick={() => {
                  if (!widget.multiSelect) {
                    onPick(option.value);
                    return;
                  }
                  const list = Array.isArray(draft) ? draft : draft ? [String(draft)] : [];
                  onDraft(picked ? list.filter((v) => v !== option.value) : [...list, option.value]);
                }}
              >
                {option.label || " "}
              </button>
            );
          })}
          {widget.multiSelect && (
            <button type="button" className="lc-pdf-form-done" onClick={onCommit}>Done</button>
          )}
        </div>
      )}
    </motion.div>
  );
}
