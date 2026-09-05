'use strict';

const crypto = require('crypto');

import type { DataStore, WriteGrant, WriteAccessStatus } from '../types';

const DAY_MS = 24 * 60 * 60 * 1000;

const DENIED: WriteAccessStatus = {
  allowed: false,
  source: null,
  expiresAt: null,
  permanent: false,
  daysRemaining: null,
};

/**
 * Gates every write path.
 *
 * Two sources of write access:
 *  - `passphrase` — the user redeemed one of WRITE_PASSPHRASES. Time-limited,
 *    sliding renewal so an active collaborator never lapses mid-edit.
 *  - `admin`      — an admin marked this user code as trusted. Permanent,
 *    revocable per person. This replaces a "permanent backdoor passphrase":
 *    same convenience (no re-entry), but revocable, auditable, and with no
 *    shared secret that leaks permanently.
 *
 * Grants are keyed by user code, not by cookie, so they are inspectable and
 * revocable server-side.
 */
class WriteAccessService {
  private store: DataStore;
  private mode: 'open' | 'gated';
  private passphrases: string[];
  private ttlDays: number;
  private renewThresholdDays: number;

  constructor(store: DataStore, config: any) {
    this.store = store;
    this.mode = config.WRITE_ACCESS_MODE;
    this.passphrases = config.WRITE_PASSPHRASES || [];
    this.ttlDays = config.WRITE_GRANT_TTL_DAYS;
    // A threshold at or above the TTL leaves no renewal window: `remaining`
    // starts at the TTL and only decays, so it would sit below the threshold
    // from the moment the grant is written and every accepted write would
    // re-write the same expiry — one extra DB write per keystroke for no
    // benefit. Fall back to half the TTL so a real window (at least one day)
    // always exists. The default (5 of 7) is untouched.
    const configuredThreshold = config.WRITE_GRANT_RENEW_THRESHOLD_DAYS ?? 5;
    this.renewThresholdDays =
      configuredThreshold >= this.ttlDays
        ? Math.max(1, Math.floor(this.ttlDays / 2))
        : configuredThreshold;
  }

  /** True when the gate is enforced at all. */
  get gated(): boolean {
    return this.mode === 'gated';
  }

  modeOf(): 'open' | 'gated' {
    return this.mode;
  }

  /**
   * Constant-time comparison. Length is compared first (unavoidable —
   * timingSafeEqual throws on length mismatch), then the bytes. Same pattern
   * as the admin token check, so a passphrase cannot be brute-forced by
   * measuring response time.
   */
  private matchesPassphrase(candidate: string): { ok: boolean; days: number | null } {
    for (const entry of this.passphrases) {
      const sep = entry.lastIndexOf(':');
      // A trailing ':N' is a per-phrase TTL override; anything else is part of
      // the phrase itself (phrases may contain any character but a comma).
      const hasSuffix = sep > 0 && /^\d+$/.test(entry.slice(sep + 1));
      const phrase = hasSuffix ? entry.slice(0, sep) : entry;
      const days = hasSuffix ? Number(entry.slice(sep + 1)) : null;

      // Hash to a fixed 32 bytes before comparing: comparing the raw buffers
      // has to check their length first (timingSafeEqual throws on a mismatch),
      // and that length check leaks how long the secret is. Hashing both sides
      // makes every comparison the same length, so the only remaining signal is
      // a constant-time equality check.
      const a = crypto.createHash('sha256').update(candidate, 'utf8').digest();
      const b = crypto.createHash('sha256').update(phrase, 'utf8').digest();
      if (crypto.timingSafeEqual(a, b)) return { ok: true, days };
    }
    return { ok: false, days: null };
  }

  private toStatus(grant: WriteGrant | undefined, now: number): WriteAccessStatus {
    if (!grant) return DENIED;
    const permanent = grant.expiresAt == null;
    if (!permanent && grant.expiresAt! <= now) return DENIED;
    return {
      allowed: true,
      source: grant.source,
      expiresAt: grant.expiresAt,
      permanent,
      daysRemaining: permanent ? null : Math.max(0, Math.ceil((grant.expiresAt! - now) / DAY_MS)),
    };
  }

  /**
   * Current write status for a user. Admins bypass the gate (they already
   * hold a separate break-glass credential).
   */
  status(userId: string | null, isAdminUser = false): WriteAccessStatus {
    if (!this.gated) {
      return {
        allowed: true,
        source: 'open',
        expiresAt: null,
        permanent: true,
        daysRemaining: null,
      };
    }
    // Admin bypasses the gate even without a session: ADMIN_TOKEN is a
    // break-glass credential, and some admin flows (creating the initial
    // public pad, granting the first trusted member) happen before any user
    // identity exists.
    if (isAdminUser) {
      return {
        allowed: true,
        source: 'admin',
        expiresAt: null,
        permanent: true,
        daysRemaining: null,
      };
    }
    if (!userId) return DENIED;
    return this.toStatus(this.store.findWriteGrant(userId), Date.now());
  }

  /**
   * Exchange a passphrase for a time-limited grant. Never logs the phrase.
   */
  redeem(userId: string | null, passphrase: string): { ok: boolean; status: WriteAccessStatus } {
    if (!this.gated || !userId || typeof passphrase !== 'string' || !passphrase) {
      return { ok: false, status: DENIED };
    }
    const match = this.matchesPassphrase(passphrase);
    if (!match.ok) return { ok: false, status: DENIED };

    // Never downgrade a permanent grant. grantTrusted() writes one with
    // expiresAt === null (source 'admin'); redeeming a phrase would REPLACE
    // that row with a time-limited one, so a trusted member who happens to
    // enter a valid phrase would silently lose permanent access when the TTL
    // lapses — and grantedBy would be overwritten, erasing who granted it.
    const existing = this.store.findWriteGrant(userId);
    if (existing && existing.expiresAt == null) {
      return { ok: true, status: this.toStatus(existing, Date.now()) };
    }

    const now = Date.now();
    // days === 0 means "use the default"; null (no suffix) means the same.
    const days = match.days && match.days > 0 ? match.days : this.ttlDays;
    const grant: WriteGrant = {
      userCode: userId,
      source: 'passphrase',
      grantedAt: now,
      expiresAt: now + days * DAY_MS,
      lastUsedAt: now,
      // 'passphrase' marks a self-redeemed grant, distinguishing it from the
      // granting admin's code that grantTrusted writes. Never the phrase.
      grantedBy: 'passphrase',
    };
    this.store.upsertWriteGrant(grant);
    return { ok: true, status: this.toStatus(grant, Date.now()) };
  }

  /** Admin-granted permanent trust. No shared secret, revocable per person. */
  grantTrusted(targetCode: string, adminCode: string | null): WriteGrant {
    const now = Date.now();
    const grant: WriteGrant = {
      userCode: targetCode,
      source: 'admin',
      grantedAt: now,
      expiresAt: null,
      lastUsedAt: null,
      grantedBy: adminCode,
    };
    return this.store.upsertWriteGrant(grant);
  }

  revoke(targetCode: string): boolean {
    return this.store.removeWriteGrant(targetCode);
  }

  /**
   * Sliding renewal: push the expiry back to a full TTL once the remaining
   * life drops below the threshold. Takes the status the caller just computed
   * (HTTP gate / WS patch re-check) instead of re-querying write_grants — the
   * naive pair status() + renewIfNeeded() cost two SELECTs per keystroke in
   * gated mode. Called on accepted writes only, and only writes when the
   * threshold is crossed, so it costs nothing in the common case.
   */
  renewFromStatus(userId: string | null, status: WriteAccessStatus): void {
    if (!this.gated || !userId || !status.allowed) return;
    if (status.expiresAt == null) return; // permanent grant — nothing to renew
    const remaining = status.expiresAt - Date.now();
    if (remaining > this.renewThresholdDays * DAY_MS) return;
    this.store.touchWriteGrant(userId, Date.now() + this.ttlDays * DAY_MS);
  }

  /** Members and their grants, for the admin member-management view. */
  list(): Array<{
    code: string;
    displayName: string | null;
    createdAt: number;
    writeAccess: WriteAccessStatus;
  }> {
    const now = Date.now();
    const grants = new Map(this.store.findAllWriteGrants().map((g) => [g.userCode, g]));
    return this.store.findAllUsers().map((u) => ({
      code: u.code,
      displayName: u.displayName,
      createdAt: u.createdAt,
      writeAccess: this.toStatus(grants.get(u.code), now),
    }));
  }
}

export = WriteAccessService;
