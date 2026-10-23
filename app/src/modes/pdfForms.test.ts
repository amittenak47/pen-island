// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, degrees } from "pdf-lib";
// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { pathToFileURL } from "node:url";
// @ts-expect-error Node runtime module used by Vitest; app intentionally has no Node typings.
import { resolve } from "node:path";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api";
import { AnnotatedPdf } from "../util/documentExportPdf";
import {
  pdfFieldValue,
  pdfStorageEntry,
  readPdfForm,
  sanitizePdfFormValues,
  seedPdfFormStorage,
  type PdfFormModel,
} from "./pdfForms";

/** A one-page AcroForm with each kind of field Pen Island fills. */
export async function sampleFormPdf(rotation = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 500]);
  page.setRotation(degrees(rotation));
  const form = doc.getForm();
  const name = form.createTextField("applicant.name");
  name.setText("Ada");
  name.addToPage(page, { x: 40, y: 420, width: 200, height: 24 });
  const notes = form.createTextField("notes");
  notes.enableMultiline();
  notes.addToPage(page, { x: 40, y: 300, width: 300, height: 80 });
  form.createCheckBox("agree").addToPage(page, { x: 40, y: 260, width: 16, height: 16 });
  const size = form.createRadioGroup("size");
  size.addOptionToPage("S", page, { x: 40, y: 220, width: 14, height: 14 });
  size.addOptionToPage("L", page, { x: 80, y: 220, width: 14, height: 14 });
  const color = form.createDropdown("color");
  color.addOptions(["Red", "Green", "Blue"]);
  color.addToPage(page, { x: 40, y: 170, width: 120, height: 22 });
  return doc.save();
}

let pdfjs: typeof import("pdfjs-dist");
const opened: { destroy(): Promise<void> }[] = [];
async function open(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const task = pdfjs.getDocument({
    data: bytes.slice(),
    standardFontDataUrl: `${resolve("node_modules/pdfjs-dist/standard_fonts")}/`,
  });
  opened.push(task);
  return task.promise;
}

beforeAll(async () => {
  pdfjs = (await import("pdfjs-dist/legacy/build/pdf.mjs")) as unknown as typeof import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(resolve("node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
});
afterAll(async () => {
  for (const doc of opened) await doc.destroy();
});

describe("readPdfForm", () => {
  it("finds every fillable field with its kind, value and place", async () => {
    const model = await readPdfForm(await open(await sampleFormPdf()));
    expect(model.kind).toBe("acroform");
    const byField = new Map(model.widgets.map((w) => [`${w.field}:${w.exportValue ?? ""}`, w]));
    expect(byField.get("applicant.name:")?.kind).toBe("text");
    expect(byField.get("notes:")?.multiline).toBe(true);
    expect(byField.get("agree:Yes")?.kind).toBe("checkbox");
    expect(byField.get("size:S")?.kind).toBe("radio");
    expect(byField.get("size:L")?.kind).toBe("radio");
    expect(byField.get("color:")?.options?.map((o) => o.value)).toEqual(["Red", "Green", "Blue"]);
    expect(model.defaults).toMatchObject({ "applicant.name": "Ada", notes: "", agree: false, size: "", color: "" });
    // y is measured from the top of the sheet: 420 + 24 up a 500-high page.
    // (pdf-lib pads the widget by half its border, hence two places.)
    const name = byField.get("applicant.name:")!;
    expect(name.page).toBe(1);
    expect(name.box.left).toBeCloseTo(40 / 400, 2);
    expect(name.box.top).toBeCloseTo((500 - 444) / 500, 2);
    expect(name.box.width).toBeCloseTo(200 / 400, 2);
  });

  it("places boxes on a rotated page as the reader sees it", async () => {
    const model = await readPdfForm(await open(await sampleFormPdf(90)));
    const name = model.widgets.find((w) => w.field === "applicant.name")!;
    // Rotated a quarter turn, the 200-wide field runs down the 500-wide sheet.
    expect(name.box.height).toBeCloseTo(200 / 400, 2);
    expect(name.box.width).toBeCloseTo(24 / 500, 2);
  });

  it("reports a PDF without fields as none", async () => {
    const plain = await PDFDocument.create();
    plain.addPage();
    expect((await readPdfForm(await open(await plain.save()))).kind).toBe("none");
  });
});

describe("form values", () => {
  it("maps each kind to pdf.js storage", () => {
    const model = { kind: "acroform", widgets: [], defaults: {} } satisfies PdfFormModel;
    const base = { id: "1R", field: "f", page: 1, box: { left: 0, top: 0, width: 1, height: 1 }, readOnly: false };
    expect(pdfStorageEntry({ ...base, kind: "text" }, "hi")).toEqual({ value: "hi" });
    expect(pdfStorageEntry({ ...base, kind: "checkbox", exportValue: "Yes" }, true)).toEqual({ value: true });
    expect(pdfStorageEntry({ ...base, kind: "radio", exportValue: "L" }, "L")).toEqual({ value: true });
    expect(pdfStorageEntry({ ...base, kind: "radio", exportValue: "S" }, "L")).toEqual({ value: false });
    expect(pdfStorageEntry({ ...base, kind: "choice" }, ["a", "b"])).toEqual({ value: ["a", "b"] });
    expect(pdfFieldValue(model, {}, "missing")).toBe("");
  });

  it("seeds storage and reports only the pages whose picture changed", async () => {
    const doc = await open(await sampleFormPdf());
    const model = await readPdfForm(doc);
    const first = seedPdfFormStorage(doc, model, { notes: "Hello" }, {});
    expect([...first]).toEqual([1]);
    const notes = model.widgets.find((w) => w.field === "notes")!;
    expect(doc.annotationStorage.getRawValue(notes.id)).toMatchObject({ value: "Hello" });
    expect(seedPdfFormStorage(doc, model, { notes: "Hello" }, { notes: "Hello" }).size).toBe(0);
    // Cleared: back to the file's own value.
    seedPdfFormStorage(doc, model, {}, { notes: "Hello" });
    expect(doc.annotationStorage.getRawValue(notes.id)).toMatchObject({ value: "" });
  });

  it("drops malformed values from other devices", () => {
    expect(sanitizePdfFormValues({ a: "x", b: true, c: ["1"], d: 3, e: [1], "": "no" })).toEqual({ a: "x", b: true, c: ["1"] });
    expect(sanitizePdfFormValues(null)).toEqual({});
    expect(sanitizePdfFormValues(["a"])).toEqual({});
  });
});

describe("export", () => {
  it("writes values into the AcroForm and keeps it fillable", async () => {
    const out = await AnnotatedPdf.open(await sampleFormPdf());
    expect(out.form({ "applicant.name": "Grace", notes: "Line one\nLine two", agree: true, size: "L", color: "Green" }, false)).toEqual([]);
    const result = (await PDFDocument.load(await out.finish())).getForm();
    expect(result.getTextField("applicant.name").getText()).toBe("Grace");
    expect(result.getTextField("notes").getText()).toBe("Line one\nLine two");
    expect(result.getCheckBox("agree").isChecked()).toBe(true);
    expect(result.getRadioGroup("size").getSelected()).toBe("L");
    expect(result.getDropdown("color").getSelected()).toEqual(["Green"]);
  });

  it("leaves untouched fields at the file's value", async () => {
    const out = await AnnotatedPdf.open(await sampleFormPdf());
    out.form({ agree: true }, false);
    const result = (await PDFDocument.load(await out.finish())).getForm();
    expect(result.getTextField("applicant.name").getText()).toBe("Ada");
  });

  it("flattens values into the page and removes the fields", async () => {
    const out = await AnnotatedPdf.open(await sampleFormPdf());
    out.form({ "applicant.name": "Grace" }, true);
    const bytes = await out.finish();
    expect((await PDFDocument.load(bytes)).getForm().getFields()).toHaveLength(0);
    const text = await (await (await open(bytes)).getPage(1)).getTextContent();
    expect(text.items.map((item: object) => ("str" in item ? item.str : "")).join(" ")).toContain("Grace");
  });

  it("keeps a value the export font cannot draw by leaving appearances to the viewer", async () => {
    const out = await AnnotatedPdf.open(await sampleFormPdf());
    out.form({ "applicant.name": "中文" }, false);
    const result = (await PDFDocument.load(await out.finish())).getForm();
    expect(result.getTextField("applicant.name").getText()).toBe("中文");
  });

  it("reports a choice that is not one of the options", async () => {
    const out = await AnnotatedPdf.open(await sampleFormPdf());
    expect(out.form({ color: "Purple" }, false)).toEqual(["color"]);
  });
});
