/** Immutable local alternatives. Reading/exporting never schedules publication. */
import { abortTransaction, run, STORE_SYNC_RECOVERY, STORE_BYTES, withTransaction } from "./idb";
import { equalStored, MigrationError, type RecoveryCopy } from "./queueMigration";
import type { PadKind } from "./syncState";

export type { RecoveryCopy } from "./queueMigration";

export async function listRecoveryCopies(kind?:PadKind,bookId?:string):Promise<RecoveryCopy[]> {
  const rows=await run<RecoveryCopy[]>(STORE_SYNC_RECOVERY,"readonly",store=>store.getAll());
  return rows.filter(row=>(kind===undefined||row.kind===kind)&&(bookId===undefined||row.bookId===bookId));
}
export async function readRecoveryCopy(id:string):Promise<RecoveryCopy|null> {
  return await run<RecoveryCopy|undefined>(STORE_SYNC_RECOVERY,"readonly",store=>store.get(id))??null;
}
export async function exportRecoveryCopy(id:string):Promise<RecoveryCopy> {
  const copy=await readRecoveryCopy(id);
  if(!copy)throw new Error("This retained copy could not be found.");
  return copy;
}
/** An explicit library choice supplies the authored local restore implementation. */
export async function restoreRecoveryRecord(id:string,restore:(record:NonNullable<RecoveryCopy["record"]>)=>Promise<void>):Promise<void> {
  const copy=await exportRecoveryCopy(id);
  if(copy.type!=="record"||!copy.record)throw new Error("This retained copy is not a restorable book.");
  await restore(copy.record);
  // Retain the recovery copy even after restoration; it is never an upload job.
}

export async function assertBytesUnambiguous(hash:string):Promise<void> {
  const {current,alternatives}=await readRetainedByteCopies(hash);
  const bytes=async(value:unknown):Promise<unknown>=>{
    if(typeof Blob!=="undefined"&&value instanceof Blob) {
      const read=await value.arrayBuffer();
      if(read.byteLength!==value.size)throw new MigrationError("A retained byte copy could not be read completely.");
      return read;
    }
    return value;
  };
  if(!alternatives.length)return;
  const existing=await bytes(current);
  for(const copy of alternatives)if(!equalStored(existing,await bytes(copy.bytes)))
    throw new MigrationError(`Multiple retained byte copies claim ${hash}. Resolve the collision before reading or publishing this document.`);
}

/** Immutable insertion is useful to guarded conflict publication as well. */
export async function retainRecoveryCopy(copy:RecoveryCopy):Promise<void> {
  await withTransaction<void>([STORE_SYNC_RECOVERY],"readwrite",(tx,setResult)=>{
    const store=tx.objectStore(STORE_SYNC_RECOVERY),request=store.get(copy.id);
    request.onsuccess=()=>{
      if(request.result===undefined)store.add(copy,copy.id);
      else if(!equalStored(request.result,copy))abortTransaction(tx,new MigrationError("A retained recovery copy changed identity; the original copy was kept."));
      setResult(undefined);
    };
  });
}

export async function readRetainedByteCopies(hash:string):Promise<{current:unknown;alternatives:RecoveryCopy[]}> {
  const [current,copies]=await Promise.all([
    run<unknown>(STORE_BYTES,"readonly",store=>store.get(hash)),recoveryCopiesThatMayClaim(hash),
  ]);
  return {current,alternatives:copies.filter(copy=>copy.type==="bytes"&&copy.claimedHash===hash)};
}

/*
 * The retained copies that could be byte copies of `hash`, read by key first.
 *
 * Every document read checks for colliding byte copies, and this used to load
 * the whole store to look: 300 retained books on the tablet, 0.5 s of
 * deserializing on the main thread each time a book opened. Byte copies are
 * keyed by `recoveryId(source, STORE_BYTES, key, hash)`, so the keys alone rule
 * out every other copy. A key in any other shape is read and checked as before.
 */
async function recoveryCopiesThatMayClaim(hash:string):Promise<RecoveryCopy[]> {
  const keys=await run<IDBValidKey[]>(STORE_SYNC_RECOVERY,"readonly",store=>store.getAllKeys());
  const wanted=keys.filter(key=>mayClaimBytes(key,hash));
  if(!wanted.length)return [];
  const rows=await withTransaction<(RecoveryCopy|undefined)[]>([STORE_SYNC_RECOVERY],"readonly",(tx,setResult)=>{
    const store=tx.objectStore(STORE_SYNC_RECOVERY),out:(RecoveryCopy|undefined)[]=[];
    let left=wanted.length;
    wanted.forEach((key,index)=>{
      const request=store.get(key);
      request.onsuccess=()=>{out[index]=request.result;if(--left===0)setResult(out);};
    });
  });
  return rows.filter((row):row is RecoveryCopy=>row!==undefined);
}

function mayClaimBytes(key:IDBValidKey,hash:string):boolean {
  if(typeof key!=="string"||!key.startsWith("recovery:"))return true;
  try {
    const parts:unknown=JSON.parse(key.slice("recovery:".length));
    if(!Array.isArray(parts)||parts.length!==4)return true;
    return parts[1]===STORE_BYTES&&parts[3]===hash;
  } catch {
    return true;
  }
}
