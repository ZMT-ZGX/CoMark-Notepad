'use strict';

const sqlite = require('./sqlite');

import type { Pad } from '../types';

function findById(id: number): Pad | undefined {
  const db = sqlite.getDb();
  const row = db.prepare('SELECT * FROM pads WHERE id = ?').get(id);
  return row ? rowToPad(row) : undefined;
}

function findAll(): Pad[] {
  const db = sqlite.getDb();
  return db.prepare('SELECT * FROM pads ORDER BY id').all().map(rowToPad);
}

// Columns needed for listing and permission decisions. Deliberately excludes
// `text`, which is up to 100KB per pad: reading every body just to render the
// sidebar or to gate a search result pulled megabytes into memory per request.
const META_COLUMNS = 'id, password, created_at, owner_user_id, creator_code';

function findByIdMeta(id: number): Pad | undefined {
  const db = sqlite.getDb();
  const row = db.prepare(`SELECT ${META_COLUMNS} FROM pads WHERE id = ?`).get(id);
  return row ? rowToPadMeta(row) : undefined;
}

function findAllMeta(): Pad[] {
  const db = sqlite.getDb();
  return db.prepare(`SELECT ${META_COLUMNS} FROM pads ORDER BY id`).all().map(rowToPadMeta);
}

function count(): number {
  const db = sqlite.getDb();
  return db.prepare('SELECT COUNT(*) AS cnt FROM pads').get().cnt;
}

function create(
  pad: Partial<Pad> & { ownerUserId?: string | null; creatorCode?: string | null }
): Pad | undefined {
  const db = sqlite.getDb();
  const createdAt = Date.now();

  const result = db
    .prepare(
      'INSERT INTO pads (id, text, text_version, password, created_at, owner_user_id, creator_code) VALUES (NULL, ?, 0, ?, ?, ?, ?)'
    )
    .run('', null, createdAt, pad.ownerUserId || null, pad.creatorCode || null);

  return findById(Number(result.lastInsertRowid));
}

function updateText(id: number, text: string): Pad | null {
  const db = sqlite.getDb();
  // RETURNING reads back only the scalar columns. The caller already knows the
  // body it just wrote, so re-selecting the whole row would drag up to 100KB
  // back out of SQLite on every keystroke purely to learn the new version.
  const row = db
    .prepare(
      `UPDATE pads SET text = ?, text_version = text_version + 1 WHERE id = ?
       RETURNING ${META_COLUMNS}, text_version`
    )
    .get(text, id);
  if (!row) return null;
  return { ...rowToPadMeta(row), text, textVersion: row.text_version };
}

function updatePassword(id: number, passwordHash: string | null): Pad | null {
  const db = sqlite.getDb();
  const result = db.prepare('UPDATE pads SET password = ? WHERE id = ?').run(passwordHash, id);
  if (result.changes === 0) return null;
  return findById(id) || null;
}

function remove(id: number): void {
  const db = sqlite.getDb();
  db.prepare('DELETE FROM pads WHERE id = ?').run(id);
}

/**
 * Full-text search via FTS5 (trigram tokenizer).
 * Returns padId + content (truncated to 200 chars).
 */
function searchPads(
  matchQuery: string
): Array<{ id: number; content: string; ownerUserId: string | null }> {
  const db = sqlite.getDb();
  // bm25() gives relevance ranking; lower score = better match.
  // FTS5 requires the MATCH / bm25() operand to reference the virtual table by
  // its actual name (aliasing it as `s MATCH` fails with "no such column: s").
  const rows = db
    .prepare(
      `SELECT s.id, substr(s.content, 1, 200) as content, p.owner_user_id as ownerUserId
       FROM pad_search s
       JOIN pads p ON p.id = s.id
       WHERE pad_search MATCH ?
       ORDER BY bm25(pad_search)
       LIMIT 20`
    )
    .all(matchQuery);
  return rows;
}

// Private-use delimiters (U+E000 / U+E001) so the client can re-wrap matches
// in <mark> after HTML-escaping the rest. Using real <mark> here would be
// indistinguishable from user-authored "<mark>" in pad text and enable XSS
// after un-escape.
const SNIPPET_MARK_OPEN = '\uE000';
const SNIPPET_MARK_CLOSE = '\uE001';

// Compiled statements are cached per database handle. `prepare()` compiles SQL,
// and the search route calls this once per result (up to 20 per request), so
// building the statement inline meant 20 compilations on every search.
let snippetCache: { db: any; withPad: any; global: any } | null = null;

function snippetStatements(db: any) {
  if (!snippetCache || snippetCache.db !== db) {
    // Only the constant SQL text is baked in; the MATCH query and pad id stay
    // bound parameters on every call.
    const select = (where: string) =>
      `SELECT snippet(pad_search, 2, '${SNIPPET_MARK_OPEN}', '${SNIPPET_MARK_CLOSE}', '…', 32) AS snippet
         FROM pad_search
         WHERE ${where}
         LIMIT 1`;
    snippetCache = {
      db,
      withPad: db.prepare(select('pad_search MATCH ? AND id = ?')),
      global: db.prepare(select('pad_search MATCH ?')),
    };
  }
  return snippetCache;
}

/**
 * Return a highlighted snippet of the pad text centered on the first match,
 * using FTS5's built-in snippet() helper. Returns '' if no match.
 */
function searchSnippet(matchQuery: string, padId?: number): string {
  try {
    const stmts = snippetStatements(sqlite.getDb());
    const row = padId != null ? stmts.withPad.get(matchQuery, padId) : stmts.global.get(matchQuery);
    return row?.snippet || '';
  } catch {
    return '';
  }
}

function rowToPad(row: any): Pad {
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

// Used for the metadata-only queries. `text` / `textVersion` are intentionally
// empty: these rows exist for listing and permission checks only, and any code
// that needs the document body must go through findById / findAll.
function rowToPadMeta(row: any): Pad {
  return {
    id: row.id,
    text: '',
    textVersion: 0,
    password: row.password ?? null,
    createdAt: row.created_at,
    ownerUserId: row.owner_user_id ?? null,
    creatorCode: row.creator_code ?? null,
  };
}

module.exports = {
  findById,
  findByIdMeta,
  findAll,
  findAllMeta,
  count,
  create,
  updateText,
  updatePassword,
  remove,
  searchPads,
  searchSnippet,
};
