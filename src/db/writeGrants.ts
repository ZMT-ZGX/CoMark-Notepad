'use strict';

const sqlite = require('./sqlite');

import type { WriteGrant } from '../types';

/**
 * Persistence for write-access grants.
 *
 * A grant is bound to `user_code` rather than to a cookie: that makes it
 * inspectable and revocable by an admin, and it survives a browser restart.
 * `expires_at IS NULL` means permanent (admin-granted trusted member).
 */
function rowToGrant(row: any): WriteGrant {
  return {
    userCode: row.user_code,
    source: row.source,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at ?? null,
    lastUsedAt: row.last_used_at ?? null,
    grantedBy: row.granted_by ?? null,
  };
}

function findByUser(code: string): WriteGrant | undefined {
  // Runs on every accepted write in gated mode (per keystroke) — keep it
  // compiled once.
  const row = sqlite.prepareCached('SELECT * FROM write_grants WHERE user_code = ?').get(code);
  return row ? rowToGrant(row) : undefined;
}

function findAll(): WriteGrant[] {
  const db = sqlite.getDb();
  return db
    .prepare('SELECT * FROM write_grants ORDER BY granted_at')
    .all()
    .map((r: any) => rowToGrant(r));
}

/**
 * Insert or replace the grant for a user (one grant per user — the PK
 * enforces it). `expiresAt` may be null for a permanent grant.
 */
function upsert(grant: WriteGrant): WriteGrant {
  const db = sqlite.getDb();
  db.prepare(
    `INSERT INTO write_grants (user_code, source, granted_at, expires_at, last_used_at, granted_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_code) DO UPDATE SET
       source = excluded.source,
       granted_at = excluded.granted_at,
       expires_at = excluded.expires_at,
       last_used_at = excluded.last_used_at,
       granted_by = excluded.granted_by`
  ).run(
    grant.userCode,
    grant.source,
    grant.grantedAt,
    grant.expiresAt,
    grant.lastUsedAt,
    grant.grantedBy
  );
  return grant;
}

function remove(code: string): boolean {
  const db = sqlite.getDb();
  return db.prepare('DELETE FROM write_grants WHERE user_code = ?').run(code).changes > 0;
}

/**
 * Record use and (optionally) extend the expiry in a single write.
 * Called on every accepted write, so keep it to one UPDATE.
 */
function touch(code: string, expiresAt: number | null): void {
  sqlite
    .prepareCached('UPDATE write_grants SET last_used_at = ?, expires_at = ? WHERE user_code = ?')
    .run(Date.now(), expiresAt, code);
}

module.exports = {
  findByUser,
  findAll,
  upsert,
  remove,
  touch,
};
