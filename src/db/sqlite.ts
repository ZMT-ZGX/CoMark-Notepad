'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const logger = require('../utils/logger');
const { SQLITE_FILE, STORE_FILE } = require('../config');

let db: any;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL DEFAULT '',
  text_version INTEGER NOT NULL DEFAULT 0,
  password TEXT,
  created_at INTEGER NOT NULL,
  owner_user_id TEXT,
  creator_code TEXT
);

CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  owner_user_id TEXT,
  pad_id INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS users (
  code TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  display_name TEXT
);

-- Write-access grants. Bound to user_code (not to a cookie) so an admin can
-- inspect, grant and revoke them server-side, and so they survive a browser
-- restart. expires_at IS NULL means permanent (admin-granted trusted member).
CREATE TABLE IF NOT EXISTS write_grants (
  user_code TEXT PRIMARY KEY REFERENCES users(code) ON DELETE CASCADE,
  source TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_used_at INTEGER,
  granted_by TEXT
);

CREATE TABLE IF NOT EXISTS invitations (
  token TEXT PRIMARY KEY,
  creator_code TEXT NOT NULL,
  max_uses INTEGER NOT NULL,
  use_count INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS access_grants (
  invite_token TEXT NOT NULL REFERENCES invitations(token) ON DELETE CASCADE,
  grantor_code TEXT NOT NULL,
  grantee_code TEXT NOT NULL,
  granted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_access_grants_grantor_grantee
  ON access_grants(grantor_code, grantee_code);
CREATE INDEX IF NOT EXISTS idx_access_grants_grantee
  ON access_grants(grantee_code);
CREATE INDEX IF NOT EXISTS idx_access_grants_token
  ON access_grants(invite_token);
CREATE INDEX IF NOT EXISTS idx_invitations_creator
  ON invitations(creator_code);
CREATE INDEX IF NOT EXISTS idx_files_pad_id
  ON files(pad_id);
CREATE INDEX IF NOT EXISTS idx_write_grants_expires
  ON write_grants(expires_at);

CREATE TABLE IF NOT EXISTS revoked_tokens (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS pad_search USING fts5(
  id UNINDEXED,
  title,
  content,
  tokenize='trigram'
);

CREATE TRIGGER IF NOT EXISTS pad_ai AFTER INSERT ON pads BEGIN
  INSERT INTO pad_search(id, title, content) VALUES (NEW.id, '', NEW.text);
END;

CREATE TRIGGER IF NOT EXISTS pad_ad AFTER DELETE ON pads BEGIN
  DELETE FROM pad_search WHERE id = OLD.id;
END;
`;

/**
 * Add a column to an existing table unless it is already present.
 * `CREATE TABLE IF NOT EXISTS` only handles brand-new tables, so schema
 * additions after the first release need an explicit ALTER.
 */
function ensureColumn(table: string, column: string, type: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as any[];
  if (cols.some((c: any) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  logger.info(`Schema migration: added ${table}.${column}`);
}

/**
 * Open SQLite database, create schema, migrate from store.json if needed.
 */
function open(): any {
  db = new Database(SQLITE_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // The per-update FTS trigger was removed in favour of a throttled sync
  // (every keystroke re-tokenized the whole body through the trigram
  // tokenizer). Older databases still carry the trigger, and leaving it in
  // place would defeat the throttle entirely — drop it idempotently.
  db.exec('DROP TRIGGER IF EXISTS pad_au');
  db.exec(SCHEMA);
  // CREATE TABLE IF NOT EXISTS cannot add columns to an existing table, so
  // later additions are applied here. Idempotent — safe on every boot.
  ensureColumn('users', 'display_name', 'TEXT');
  reconcileSearchIndex();
  logger.info(`SQLite opened: ${SQLITE_FILE}`);

  // Migrate from store.json if SQLite is empty and JSON exists
  migrateFromJSON();

  return db;
}

/**
 * Rebuild the FTS index from the pads table. Runs at boot so the index can
 * never drift from the bodies: the throttled sync defers refreshes, and a
 * crash between a body write and its refresh would otherwise leave stale
 * search results until the pad is edited again. Pads are capped at MAX_PADS,
 * so the rebuild is bounded and cheap.
 */
function reconcileSearchIndex(): void {
  const padCount = db.prepare('SELECT COUNT(*) AS cnt FROM pads').get().cnt;
  if (padCount === 0) return;
  const rebuild = db.transaction(() => {
    db.exec('DELETE FROM pad_search');
    db.exec("INSERT INTO pad_search(id, title, content) SELECT id, '', text FROM pads");
  });
  rebuild();
}

/**
 * One-time migration: import store.json data into SQLite.
 * Only runs when the pads table is empty and store.json exists.
 */
function migrateFromJSON() {
  // No store.json — nothing to migrate. A fresh install deliberately starts
  // with zero pads: the legacy always-seeded Pad #1 was public (owner NULL),
  // which on a public deployment made it readable by anyone who registered.
  if (!fs.existsSync(STORE_FILE)) return;

  const padCount = db.prepare('SELECT COUNT(*) as cnt FROM pads').get().cnt;
  if (padCount > 0) return; // Already has data, skip migration

  // Backup store.json before migration for rollback safety
  const backupPath = `${STORE_FILE}.backup.${Date.now()}`;
  try {
    fs.copyFileSync(STORE_FILE, backupPath);
    logger.info(`Backed up store.json to ${backupPath}`);
  } catch (e: any) {
    logger.warn(`Failed to backup store.json: ${e.message}`);
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
  } catch (e: any) {
    logger.warn(`store.json unreadable, skipping migration: ${e.message}`);
    return;
  }

  const migrateInsert = db.transaction((rawData: any) => {
    // Handle old single-pad format: { text, textVersion } → { pads: [{ ... }] }
    let data = rawData;
    if (!data.pads && data.text !== undefined) {
      const oldText = data.text || '';
      const oldVersion = Number.isInteger(data.textVersion) ? data.textVersion : 0;
      data = {
        pads: [
          {
            id: 1,
            text: oldText,
            textVersion: oldVersion,
            password: null,
            createdAt: Date.now(),
            ownerUserId: null,
            creatorCode: null,
          },
        ],
        files: data.files || [],
        users: data.users || [],
        inviteTokens: data.inviteTokens || [],
        accessGrants: data.accessGrants || [],
        revokedTokens: data.revokedTokens || {},
      };
      logger.info('Migrated old single-pad store to multi-pad format (pad #1)');
    }

    // Migrate pads
    const insertPad = db.prepare(
      'INSERT OR REPLACE INTO pads (id, text, text_version, password, created_at, owner_user_id, creator_code) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    if (Array.isArray(data.pads)) {
      for (const p of data.pads) {
        insertPad.run(
          p.id,
          p.text || '',
          p.textVersion || 0,
          p.password || null,
          p.createdAt || Date.now(),
          p.ownerUserId || null,
          p.creatorCode || null
        );
      }
    }

    // Migrate files
    const insertFile = db.prepare(
      'INSERT OR REPLACE INTO files (id, filename, original_name, size, mime_type, created_at, owner_user_id, pad_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    );
    if (Array.isArray(data.files)) {
      for (const f of data.files) {
        insertFile.run(
          f.id,
          f.filename,
          f.originalName,
          f.size,
          f.mimeType,
          f.createdAt || Date.now(),
          f.ownerUserId || null,
          f.padId ?? 1
        );
      }
    }

    // Migrate users
    const insertUser = db.prepare('INSERT OR REPLACE INTO users (code, created_at) VALUES (?, ?)');
    if (Array.isArray(data.users)) {
      for (const u of data.users) {
        insertUser.run(u.code, u.createdAt || Date.now());
      }
    }

    // Migrate invitations
    const insertInvite = db.prepare(
      'INSERT OR REPLACE INTO invitations (token, creator_code, max_uses, use_count, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    if (Array.isArray(data.inviteTokens)) {
      for (const t of data.inviteTokens) {
        insertInvite.run(
          t.token,
          t.creatorCode,
          t.maxUses || 0,
          t.useCount || 0,
          t.expiresAt || null,
          t.createdAt || Date.now()
        );
      }
    }

    // Migrate access grants
    const insertGrant = db.prepare(
      'INSERT INTO access_grants (invite_token, grantor_code, grantee_code, granted_at) VALUES (?, ?, ?, ?)'
    );
    if (Array.isArray(data.accessGrants)) {
      for (const g of data.accessGrants) {
        insertGrant.run(g.inviteToken, g.grantorCode, g.granteeCode, g.grantedAt || Date.now());
      }
    }

    // Migrate revoked tokens
    const insertRevoked = db.prepare(
      'INSERT OR REPLACE INTO revoked_tokens (token, expires_at) VALUES (?, ?)'
    );
    if (data.revokedTokens && typeof data.revokedTokens === 'object') {
      for (const [token, expiresAt] of Object.entries(data.revokedTokens)) {
        insertRevoked.run(token, expiresAt);
      }
    }
  });

  migrateInsert(raw);
  logger.info('Migrated store.json data to SQLite');
}

/**
 * Close the database connection.
 */
function close(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite closed');
  }
}

/**
 * Get the raw database handle.
 */
function getDb(): any {
  return db;
}

/**
 * Load all data from SQLite into a plain object (for backward-compat getStore()).
 */
function getStoreSnapshot() {
  const pads = db.prepare('SELECT * FROM pads ORDER BY id').all().map(rowToPad);
  const files = db.prepare('SELECT * FROM files ORDER BY created_at DESC').all().map(rowToFile);
  const users = db.prepare('SELECT * FROM users').all().map(rowToUser);
  const inviteTokens = db.prepare('SELECT * FROM invitations').all().map(rowToInvitation);
  const accessGrants = db.prepare('SELECT * FROM access_grants').all().map(rowToGrant);
  const revokedTokens: Record<string, number> = {};
  for (const row of db.prepare('SELECT token, expires_at FROM revoked_tokens').all()) {
    revokedTokens[row.token] = row.expires_at;
  }
  return { pads, files, users, inviteTokens, accessGrants, revokedTokens };
}

// ── Row → Object mappers ──────────────────────────────────────────

function rowToPad(row: any) {
  return {
    id: row.id,
    text: row.text,
    textVersion: row.text_version,
    password: row.password ?? null,
    createdAt: row.created_at,
    ownerUserId: row.owner_user_id ?? null,
    creatorCode: row.creator_code ?? null,
  };
}

function rowToFile(row: any) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: row.original_name,
    size: row.size,
    mimeType: row.mime_type,
    createdAt: row.created_at,
    ownerUserId: row.owner_user_id ?? null,
    padId: row.pad_id,
  };
}

function rowToUser(row: any) {
  return { code: row.code, createdAt: row.created_at, displayName: row.display_name ?? null };
}

function rowToInvitation(row: any) {
  return {
    token: row.token,
    creatorCode: row.creator_code,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  };
}

function rowToGrant(row: any) {
  return {
    inviteToken: row.invite_token,
    grantorCode: row.grantor_code,
    granteeCode: row.grantee_code,
    grantedAt: row.granted_at,
  };
}

module.exports = {
  open,
  close,
  getDb,
  getStoreSnapshot,
  rowToUser,
};
