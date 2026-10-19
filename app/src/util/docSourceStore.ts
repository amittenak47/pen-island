/** Source locations belong to this device, separately from every saved book. */
export interface DocSourceRef {
  kind: "path" | "uri";
  location: string;
  name: string;
  size: number | null;
  modified: number | null;
  hash: string;
  checkedAt: number;
}

const KEY = "pen.docSources.v1";

function valid(value: unknown): value is DocSourceRef {
  if (!value || typeof value !== "object") return false;
  const ref = value as DocSourceRef;
  const optionalNumber = (n: unknown) => n === null || (typeof n === "number" && Number.isFinite(n) && n >= 0);
  return (ref.kind === "path" || ref.kind === "uri") && typeof ref.location === "string" && !!ref.location
    && typeof ref.name === "string" && typeof ref.hash === "string" && optionalNumber(ref.size)
    && optionalNumber(ref.modified) && typeof ref.checkedAt === "number" && Number.isFinite(ref.checkedAt);
}

export function listDocSources(): Record<string, DocSourceRef> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => valid(value)));
  } catch {
    return {};
  }
}

export function getDocSource(id: string): DocSourceRef | null {
  const refs = listDocSources();
  return Object.hasOwn(refs, id) ? refs[id] : null;
}

export function setDocSource(id: string, ref: DocSourceRef): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...listDocSources(), [id]: ref }));
  } catch {
    /* Device storage may be unavailable; the app copy still opens. */
  }
}

export function clearDocSource(id: string): void {
  try {
    const refs = listDocSources();
    delete refs[id];
    localStorage.setItem(KEY, JSON.stringify(refs));
  } catch {
    /* Device storage may be unavailable. */
  }
}
