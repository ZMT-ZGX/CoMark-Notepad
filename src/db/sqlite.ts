'use strict';

const Database = require('better-sqlite3');
const fs = require('fs');
const logger = require('../utils/logger');
const { SQLITE_FILE, STORE_FILE } = require('../config');

let db;

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
  created_at INTEGER NOT NULL
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

CREATE TABLE IF NOT EXISTS revoked_tokens (
  token TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
`;

/**
 * Open SQLite database, create schema, migrate from store.json if needed.
 */
function open() {
  db = new Database(SQLITE_FILE);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  logger.info(`SQLite opened: ${SQLITE_FILE}`);

  // Migrate from store.json if SQLite is empty and JSON exists
  migrateFromJSON();

  return db;
}

/**
 * One-time migration: import store.json data into SQLite.
 * Only runs when the pads table is empty and store.json exists.
 */
function migrateFromJSON() {
  if (!fs.existsSync(STORE_FILE)) {
    seedDefaultPad();
    return;
  }

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
  } catch {
    seedDefaultPad();
    return;
  }

  const migrateInsert = db.transaction((rawData) => {
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
          f.padId || 1
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

function seedDefaultPad() {
  const padCount = db.prepare('SELECT COUNT(*) as cnt FROM pads').get().cnt;
  if (padCount > 0) return;

  db.prepare(
    'INSERT INTO pads (id, text, text_version, password, created_at, owner_user_id, creator_code) VALUES (NULL, ?, 0, NULL, ?, NULL, NULL)'
  ).run('', Date.now());
}

/**
 * Close the database connection.
 */
function close() {
  if (db) {
    db.close();
    db = null;
    logger.info('SQLite closed');
  }
}

/**
 * Get the raw database handle.
 */
function getDb() {
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
  const revokedTokens = {};
  for (const row of db.prepare('SELECT token, expires_at FROM revoked_tokens').all()) {
    revokedTokens[row.token] = row.expires_at;
  }
  return { pads, files, users, inviteTokens, accessGrants, revokedTokens };
}

// ── Row → Object mappers ──────────────────────────────────────────

function rowToPad(row) {
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

function rowToFile(row) {
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

function rowToUser(row) {
  return { code: row.code, createdAt: row.created_at };
}

function rowToInvitation(row) {
  return {
    token: row.token,
    creatorCode: row.creator_code,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  };
}

function rowToGrant(row) {
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
};
