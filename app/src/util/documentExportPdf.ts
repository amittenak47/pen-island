import { PDFDocument, PDFName, PDFHexString, PDFString, PDFArray, PDFBool,
  PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix } from "pdf-lib";
import type { PdfFormValues } from "../modes/pdfForms";

export interface PdfPlacement { page:number; right?:boolean; spread?:boolean }
/** Displayed bottom-left coordinates to the PDF crop box, including rotation. */
export function pdfDisplayTransform(box:{x:number;y:number;width:number;height:number},rotation:number) {
  const r=((rotation%360)+360)%360;
  if(r===90)return {matrix:[0,1,-1,0,box.x+box.width,box.y],width:box.height,height:box.width};
  if(r===180)return {matrix:[-1,0,0,-1,box.x+box.width,box.y+box.height],width:box.width,height:box.height};
  if(r===270)return {matrix:[0,-1,1,0,box.x,box.y+box.height],width:box.height,height:box.width};
  return {matrix:[1,0,0,1,box.x,box.y],width:box.width,height:box.height};
}

export class AnnotatedPdf {
  private keepAppearances=false;
  private constructor(private pdf:PDFDocument) {}
  static async open(bytes:Uint8Array) { return new AnnotatedPdf(await PDFDocument.load(bytes)); }
  static async create() { return new AnnotatedPdf(await PDFDocument.create()); }
  pageCount() { return this.pdf.getPageCount(); }
  async overlay(input:PdfPlacement & {png:Uint8Array}) {
    const page=this.pdf.getPage(input.page-1);
    const {matrix,width,height}=pdfDisplayTransform(page.getCropBox(),page.getRotation().angle);
    const image=await this.pdf.embedPng(input.png);
    page.pushOperators(pushGraphicsState(),concatTransformationMatrix(...matrix as [number,number,number,number,number,number]));
    page.drawImage(image,{x:input.right ? width/2:0,y:0,width:input.spread ? width/2:width,height});
    page.pushOperators(popGraphicsState());
    await this.pdf.flush();
  }
  note(input:PdfPlacement & {number:number;text:string;x:number;y:number}) {
    const page=this.pdf.getPage(input.page-1);
    const {matrix:m,width,height}=pdfDisplayTransform(page.getCropBox(),page.getRotation().angle);
    const x=(input.right ? width/2:0)+input.x*(input.spread ? width/2:width),y=(1-input.y)*height;
    const points=[[x,y],[x+12,y-12]].map(([u,v])=>[m[0]*u+m[2]*v+m[4],m[1]*u+m[3]*v+m[5]]);
    const annotation=this.pdf.context.obj({Type:"Annot",Subtype:"Text",
      Rect:[Math.min(...points.map(p=>p[0])),Math.min(...points.map(p=>p[1])),Math.max(...points.map(p=>p[0])),Math.max(...points.map(p=>p[1]))],
      Contents:PDFHexString.fromText(input.text),T:PDFHexString.fromText(`Footnote ${input.number}`),Name:"Comment",F:4,
      NM:PDFString.of(`export-footnote-${input.number}`)});
    const existing=page.node.lookupMaybe(PDFName.of("Annots"),PDFArray) ?? this.pdf.context.obj([]);
    existing.push(this.pdf.context.register(annotation));page.node.set(PDFName.of("Annots"),existing);
  }
  /**
   * Write the reader's values into the AcroForm, or flatten them into the page.
   * Runs before the ink overlays, so flattened values sit under the ink.
   * Returns the fields that could not take their value.
   */
  form(values:PdfFormValues,flatten:boolean):string[] {
    const form=this.pdf.getForm();const skipped:string[]=[];
    for(const field of form.getFields()) {
      const name=field.getName();
      if(!Object.prototype.hasOwnProperty.call(values,name))continue;
      const value=values[name]!;const list=Array.isArray(value) ? value:typeof value==="string" && value ? [value]:[];
      try {
        if(field instanceof PDFTextField)field.setText(typeof value==="string" ? value:"");
        else if(field instanceof PDFCheckBox){if(value===true)field.check();else field.uncheck();}
        else if(field instanceof PDFRadioGroup){if(list[0])field.select(list[0]);else field.clear();}
        else if(field instanceof PDFDropdown || field instanceof PDFOptionList) {
          // Stored as export values; pdf-lib selects by what it lists (display text).
          const labels=list.map(v=>{const option=field.acroField.getOptions().find(o=>o.value.decodeText()===v);return option ? (option.display ?? option.value).decodeText():v;});
          if(labels.length===0)field.clear();
          else if(labels.every(label=>field.getOptions().includes(label)))field.select(labels.length>1 ? labels:labels[0]!);
          else skipped.push(name);
        }
      }catch{skipped.push(name);}
    }
    // A hybrid file's XFA copy would win in Acrobat and show the old values.
    form.deleteXFA();
    try{form.updateFieldAppearances();}
    catch(error) {
      if(flatten)throw new Error("A filled value uses characters the export font cannot draw. Export without flattening to keep it.");
      // Leave drawing the values to the viewer.
      form.acroForm.dict.set(PDFName.of("NeedAppearances"),PDFBool.True);this.keepAppearances=true;
    }
    if(flatten)form.flatten({updateFieldAppearances:false});
    return skipped;
  }
  async appendix(png:Uint8Array) {
    const image=await this.pdf.embedPng(png);const page=this.pdf.addPage([612,792]);
    page.drawImage(image,{x:0,y:0,width:612,height:792});await this.pdf.flush();
  }
  finish() { return this.pdf.save({objectsPerTick:25,updateFieldAppearances:!this.keepAppearances}); }
}
