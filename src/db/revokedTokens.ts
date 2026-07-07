'use strict';

/**
 * Revoked token blocklist — shared between auth/session.js and db/store.js.
 *
 * With SQLite backend:
 *   - In-memory Map for fast lookups (unchanged)
 *   - SQLite revoked_tokens table for persistence
 *   - restoreFromStoreData reads from SQLite instead of JSON
 */

const revokedTokens = new Map() as Map<string, number>; // token -> expiresAt (epoch seconds)

function set(token: string, expiresAtEpoch: number): void {
  revokedTokens.set(token, expiresAtEpoch);
  // Persist to SQLite immediately
  try {
    const sqlite = require('./sqlite');
    const db = sqlite.getDb();
    if (db) {
      db.prepare('INSERT OR REPLACE INTO revoked_tokens (token, expires_at) VALUES (?, ?)').run(
        token,
        expiresAtEpoch
      );
    }
  } catch {}
}

function has(token: string): boolean {
  return revokedTokens.has(token);
}

function get(token: string): number | undefined {
  return revokedTokens.get(token);
}

function del(token: string): void {
  revokedTokens.delete(token);
  try {
    const sqlite = require('./sqlite');
    const db = sqlite.getDb();
    if (db) {
      db.prepare('DELETE FROM revoked_tokens WHERE token = ?').run(token);
    }
  } catch {}
}

function getAll() {
  return revokedTokens;
}

function size() {
  return revokedTokens.size;
}

function cleanupExpired() {
  const nowSec = Date.now() / 1000;
  const toDelete: string[] = [];
  for (const [token, exp] of revokedTokens) {
    if (nowSec > exp) toDelete.push(token);
  }
  for (const token of toDelete) {
    revokedTokens.delete(token);
  }
  // Clean up SQLite too
  try {
    const sqlite = require('./sqlite');
    const db = sqlite.getDb();
    if (db) {
      db.prepare('DELETE FROM revoked_tokens WHERE expires_at < ?').run(nowSec);
    }
  } catch {}
}

/**
 * Restore from SQLite revoked_tokens table (called once at startup).
 * Filters out already-expired tokens.
 */
function restoreFromSQLite() {
  try {
    const sqlite = require('./sqlite');
    const db = sqlite.getDb();
    if (!db) return;
    const nowSec = Date.now() / 1000;
    const rows = db
      .prepare('SELECT token, expires_at FROM revoked_tokens WHERE expires_at > ?')
      .all(nowSec);
    for (const row of rows) {
      revokedTokens.set(row.token, row.expires_at);
    }
  } catch {}
}

/**
 * Legacy compat: restore from store data (kept for backward compat).
 * With SQLite, use restoreFromSQLite() instead.
 */
function restoreFromStoreData(storeData: any): void {
  // Try SQLite first
  try {
    const sqlite = require('./sqlite');
    const db = sqlite.getDb();
    if (db) {
      restoreFromSQLite();
      return;
    }
  } catch {}
  // Fallback to JSON data if SQLite not available
  const raw = (storeData && storeData.revokedTokens) || {};
  const nowSec = Date.now() / 1000;
  for (const token of Object.keys(raw)) {
    const expiresAt = raw[token];
    if (typeof expiresAt === 'number' && expiresAt > nowSec) {
      revokedTokens.set(token, expiresAt);
    }
  }
}

module.exports = {
  set,
  has,
  get,
  del,
  getAll,
  size,
  cleanupExpired,
  restoreFromStoreData,
  restoreFromSQLite,
};
