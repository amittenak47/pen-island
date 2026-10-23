/**
 * Fillable PDF forms (AcroForm): what a file offers, and the values the
 * reader typed into it.
 *
 * The standard is AcroForm (ISO 32000, §12.7): the catalog's `/AcroForm`
 * lists `/Fields`, and each field shows on a page as a `/Widget` annotation.
 * XFA is Adobe's XML form layer (`/XFA` in the same dictionary), deprecated in
 * PDF 2.0. A hybrid file carries both and is filled through its AcroForm
 * fields; a pure XFA file has no widgets, so there is nothing to fill here.
 *
 * Values never go into the PDF's bytes while reading. The bytes are the
 * document's identity (its hash keys the ink, the copies and sync), so values
 * live beside the ink on the annotation set — sparse, keyed by the field's
 * fully qualified name — and reach the file only on export.
 */

import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";

/** Text and single choice: a string. Checkbox: checked. Multi-select list: its export values. */
export type PdfFormValue = string | boolean | string[];
/** Only the fields the reader changed; the rest keep the file's own value. */
export type PdfFormValues = Record<string, PdfFormValue>;

export type PdfFieldKind = "text" | "checkbox" | "radio" | "choice";

export interface PdfFormOption { value: string; label: string }

/** Where a widget sits on its sheet, as fractions of the sheet's width and height. */
export interface PdfSheetBox { left: number; top: number; width: number; height: number }

export interface PdfFormWidget {
  /** pdf.js annotation id, the key into `annotationStorage`. */
  id: string;
  /** Fully qualified field name; radio buttons share one. */
  field: string;
  kind: PdfFieldKind;
  /** 1-based. */
  page: number;
  box: PdfSheetBox;
  readOnly: boolean;
  /** Checkbox / radio: the value this widget stands for when it is on. */
  exportValue?: string;
  options?: PdfFormOption[];
  multiline?: boolean;
  multiSelect?: boolean;
  maxLen?: number;
  password?: boolean;
}

export type PdfFormKind = "none" | "acroform" | "xfa";

export interface PdfFormModel {
  kind: PdfFormKind;
  widgets: PdfFormWidget[];
  /** The value each field already has in the file. */
  defaults: PdfFormValues;
}

export const NO_PDF_FORM: PdfFormModel = { kind: "none", widgets: [], defaults: {} };

interface FieldObject {
  id?: string;
  type?: string;
  name?: string;
  value?: unknown;
  exportValues?: unknown;
  editable?: boolean;
  hidden?: boolean;
  multiline?: boolean;
  password?: boolean;
  charLimit?: number;
  multipleSelection?: boolean;
  items?: unknown;
  page?: number;
  rect?: unknown;
}

const isRect = (rect: unknown): rect is [number, number, number, number] =>
  Array.isArray(rect) && rect.length === 4 && rect.every((n) => typeof n === "number" && Number.isFinite(n));

function readOptions(items: unknown): PdfFormOption[] {
  if (!Array.isArray(items)) return [];
  const out: PdfFormOption[] = [];
  for (const item of items) {
    if (typeof item === "string") out.push({ value: item, label: item });
    else if (item && typeof item === "object") {
      const { exportValue, displayValue } = item as { exportValue?: unknown; displayValue?: unknown };
      const value = typeof exportValue === "string" ? exportValue : typeof displayValue === "string" ? displayValue : null;
      if (value != null) out.push({ value, label: typeof displayValue === "string" ? displayValue : value });
    }
  }
  return out;
}

function choiceValue(value: unknown, multi: boolean): PdfFormValue {
  const list = Array.isArray(value) ? value.filter((v): v is string => typeof v === "string")
    : typeof value === "string" && value ? [value] : [];
  return multi ? list : list[0] ?? "";
}

/**
 * Which kind of form a document is, and every fillable widget in it.
 *
 * `IsAcroFormPresent` / `IsXFAPresent` come from the catalog and are cheap;
 * the field list is read only when there is an AcroForm. Signature fields and
 * push buttons are left out: neither holds a value a reader types.
 */
export async function readPdfForm(doc: PDFDocumentProxy): Promise<PdfFormModel> {
  const meta = await doc.getMetadata().catch(() => null);
  const info = (meta?.info ?? {}) as { IsAcroFormPresent?: boolean; IsXFAPresent?: boolean };
  const objects = info.IsAcroFormPresent || info.IsXFAPresent
    ? ((await doc.getFieldObjects().catch(() => null)) as Record<string, FieldObject[]> | null)
    : null;
  const raw: { name: string; object: FieldObject }[] = [];
  for (const [name, list] of Object.entries(objects ?? {})) {
    for (const object of list ?? []) {
      if (!object?.id || object.hidden || typeof object.page !== "number" || !isRect(object.rect)) continue;
      if (!["text", "checkbox", "radiobutton", "combobox", "listbox"].includes(object.type ?? "")) continue;
      raw.push({ name, object });
    }
  }
  if (raw.length === 0) return info.IsXFAPresent ? { ...NO_PDF_FORM, kind: "xfa" } : NO_PDF_FORM;

  // A checkbox group whose widgets stand for different values is a radio group.
  const exports = new Map<string, Set<string>>();
  for (const { name, object } of raw) {
    if (object.type !== "checkbox" || typeof object.exportValues !== "string") continue;
    let set = exports.get(name);
    if (!set) exports.set(name, set = new Set());
    set.add(object.exportValues);
  }

  const viewports = new Map<number, { width: number; height: number; toView: (r: number[]) => number[] }>();
  for (const page of new Set(raw.map(({ object }) => object.page!))) {
    const proxy = await doc.getPage(page + 1);
    const viewport = proxy.getViewport({ scale: 1 });
    viewports.set(page, {
      width: viewport.width,
      height: viewport.height,
      toView: (r) => [
        ...viewport.convertToViewportPoint(r[0]!, r[1]!),
        ...viewport.convertToViewportPoint(r[2]!, r[3]!),
      ] as number[],
    });
  }

  const widgets: PdfFormWidget[] = [];
  const defaults: PdfFormValues = {};
  for (const { name, object } of raw) {
    const view = viewports.get(object.page!)!;
    const [x1, y1, x2, y2] = view.toView(object.rect as number[]);
    const box: PdfSheetBox = {
      left: Math.min(x1, x2) / view.width,
      top: Math.min(y1, y2) / view.height,
      width: Math.abs(x2 - x1) / view.width,
      height: Math.abs(y2 - y1) / view.height,
    };
    const base = { id: object.id!, field: name, page: object.page! + 1, box, readOnly: object.editable === false };
    if (object.type === "text") {
      widgets.push({ ...base, kind: "text", multiline: !!object.multiline, password: !!object.password,
        ...(typeof object.charLimit === "number" && object.charLimit > 0 ? { maxLen: object.charLimit } : {}) });
      defaults[name] ??= typeof object.value === "string" ? object.value : "";
    } else if (object.type === "checkbox" && (exports.get(name)?.size ?? 0) <= 1) {
      const on = typeof object.exportValues === "string" ? object.exportValues : "Yes";
      widgets.push({ ...base, kind: "checkbox", exportValue: on });
      defaults[name] ??= object.value === on;
    } else if (object.type === "checkbox" || object.type === "radiobutton") {
      const on = typeof object.exportValues === "string" ? object.exportValues : "";
      widgets.push({ ...base, kind: "radio", exportValue: on });
      defaults[name] ??= typeof object.value === "string" && object.value !== "Off" ? object.value : "";
    } else {
      const multi = !!object.multipleSelection;
      widgets.push({ ...base, kind: "choice", options: readOptions(object.items), multiSelect: multi });
      defaults[name] ??= choiceValue(object.value, multi);
    }
  }
  return { kind: "acroform", widgets, defaults };
}

/** The value a field shows: the reader's, else the file's. */
export function pdfFieldValue(model: PdfFormModel, values: PdfFormValues, field: string): PdfFormValue {
  return Object.prototype.hasOwnProperty.call(values, field) ? values[field]! : model.defaults[field] ?? "";
}

export function samePdfFormValue(a: PdfFormValue | undefined, b: PdfFormValue | undefined): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/**
 * What pdf.js's `annotationStorage` wants for one widget, so the page paints
 * with the reader's value (`AnnotationMode.ENABLE_STORAGE`).
 */
export function pdfStorageEntry(widget: PdfFormWidget, value: PdfFormValue): { value: string | boolean | string[] } {
  if (widget.kind === "checkbox") return { value: value === true };
  if (widget.kind === "radio") return { value: typeof value === "string" && value !== "" && value === widget.exportValue };
  if (widget.kind === "choice") return { value: Array.isArray(value) ? value : typeof value === "string" ? value : "" };
  return { value: typeof value === "string" ? value : "" };
}

/**
 * Load values into the open document's storage. Returns the pages whose
 * picture changed and need painting again.
 *
 * Fields that left `values` (cleared, or another set's values) are put back to
 * the file's own value, so the storage always says exactly this set.
 */
export function seedPdfFormStorage(
  doc: PDFDocumentProxy,
  model: PdfFormModel,
  values: PdfFormValues,
  previous: PdfFormValues,
): Set<number> {
  const changed = new Set<number>();
  const storage = doc.annotationStorage;
  for (const widget of model.widgets) {
    const now = pdfFieldValue(model, values, widget.field);
    const was = pdfFieldValue(model, previous, widget.field);
    const seeded = storage.getRawValue(widget.id) !== undefined;
    if (seeded && samePdfFormValue(now, was)) continue;
    if (!seeded && !Object.prototype.hasOwnProperty.call(values, widget.field)) continue;
    storage.setValue(widget.id, pdfStorageEntry(widget, now));
    if (!samePdfFormValue(now, was) || !seeded) changed.add(widget.page);
  }
  return changed;
}

/**
 * Keep only well-formed entries — values arrive from other devices and older
 * builds, and one bad row must not stop the rest from showing.
 */
export function sanitizePdfFormValues(input: unknown): PdfFormValues {
  const out: PdfFormValues = {};
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!key) continue;
    if (typeof value === "string" || typeof value === "boolean") out[key] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === "string")) out[key] = [...value];
  }
  return out;
}

export function hasPdfFormValues(values: PdfFormValues | null | undefined): values is PdfFormValues {
  return !!values && Object.keys(values).length > 0;
}
