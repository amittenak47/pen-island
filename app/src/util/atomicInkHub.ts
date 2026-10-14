import type { LcClient, PadSyncPingDto } from "../api/client";

/** Legacy adapters must never move ink using an old hub's wall clocks. */
export async function requireAtomicInkHub(client: LcClient, ping?: PadSyncPingDto): Promise<void> {
  const capabilities = ping ?? await client.pingPadSync(0);
  if (!capabilities.features?.includes("atomic_book_sync_v1")) throw new Error("Update the desktop app to sync safely.");
}
