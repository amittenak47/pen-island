import type { AnnotateDocMeta } from "./annotateStore";
import { docTypeForName } from "./annotateFs";
import { getDocSource } from "./docSourceStore";
import { statDocumentSource, type FolderEntry } from "./docSourceNative";

export interface FolderSourceMatch {
  doc: AnnotateDocMeta;
  entry: FolderEntry;
}

export async function matchDocSourceFolder(docs: AnnotateDocMeta[], entries: FolderEntry[]): Promise<{
  matches: FolderSourceMatch[];
  duplicateNames: number;
  failures: string[];
}> {
  const names = new Map<string, FolderEntry[]>();
  for (const entry of entries) {
    const name = entry.name.toLowerCase();
    names.set(name, [...(names.get(name) ?? []), entry]);
  }
  const duplicateNames = [...names.values()].filter(files => files.length > 1).length;
  const matches: FolderSourceMatch[] = [];
  const failures: string[] = [];
  for (const doc of docs) {
    if (doc.deletedAt !== undefined) continue;
    const files = names.get(doc.name.toLowerCase());
    if (files?.length !== 1 || docTypeForName(files[0].name) !== doc.docType) continue;
    const entry = files[0];
    const source = getDocSource(doc.id);
    try {
      if (source && await statDocumentSource(source.kind, source.location)) continue;
      matches.push({ doc, entry });
    } catch (cause) {
      failures.push(`${doc.name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return { matches, duplicateNames, failures };
}
