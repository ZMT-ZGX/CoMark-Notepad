'use strict';

/**
 * Instance-wide ledger of storage bytes that are spoken for but not yet
 * visible in the `files` table.
 *
 * Every write path that mints a file row — upload (FileService) and
 * conversion (ConvertService) — checks the caps and then hits an `await`
 * before the row lands. Without a shared reservation each overlapping
 * request reads the same committed total, all of them pass, and the cap is
 * overshot by however many requests happen to overlap.
 *
 * One ledger for the whole process is the entire point: an upload and a
 * conversion running at the same time must see each other's bytes, so this
 * cannot be per-service state. Conversion is the sharper case — it creates a
 * brand-new row, so an unshared counter would make it a plain quota bypass.
 */

class StorageQuota {
  private pendingBytesTotal = 0;
  private pendingBytesByUser = new Map<string, number>();

  /**
   * Reserve `size` bytes for the life of an in-flight write.
   *
   * Returns an idempotent release callback. Call it once the bytes are in the
   * `files` table — the row then accounts for itself — or once the write is
   * abandoned for any reason.
   *
   * Callers must take the reservation in the same synchronous block as the
   * cap check. That is what closes the race: nothing can interleave between
   * "count my bytes" and "read the totals".
   */
  reserve(size: number, ownerUserId: string | null): () => void {
    if (!(size > 0)) return () => {};
    this.pendingBytesTotal += size;
    if (ownerUserId) {
      const next = (this.pendingBytesByUser.get(ownerUserId) || 0) + size;
      this.pendingBytesByUser.set(ownerUserId, next);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.pendingBytesTotal = Math.max(0, this.pendingBytesTotal - size);
      if (!ownerUserId) return;
      const remaining = (this.pendingBytesByUser.get(ownerUserId) || 0) - size;
      if (remaining > 0) this.pendingBytesByUser.set(ownerUserId, remaining);
      else this.pendingBytesByUser.delete(ownerUserId);
    };
  }

  /** Committed bytes plus bytes still in flight, instance-wide. */
  used(committedBytes: number): number {
    return committedBytes + this.pendingBytesTotal;
  }

  /** Same, narrowed to a single account. */
  usedBy(committedBytes: number, ownerUserId: string): number {
    return committedBytes + (this.pendingBytesByUser.get(ownerUserId) || 0);
  }
}

// The caps are per instance, so the ledger is too: every service that can
// create a file row shares this one.
const storageQuota = new StorageQuota();

export = storageQuota;
