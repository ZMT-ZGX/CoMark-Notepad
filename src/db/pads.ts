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
  const result = db
    .prepare('UPDATE pads SET text = ?, text_version = text_version + 1 WHERE id = ?')
    .run(text, id);
  if (result.changes === 0) return null;
  return findById(id) || null;
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

/**
 * Return a highlighted snippet of the pad text centered on the first match,
 * using FTS5's built-in snippet() helper. Returns '' if no match.
 */
function searchSnippet(matchQuery: string, padId?: number): string {
  const db = sqlite.getDb();
  try {
    const sql =
      padId != null
        ? `SELECT snippet(pad_search, 2, '${SNIPPET_MARK_OPEN}', '${SNIPPET_MARK_CLOSE}', '…', 32) AS snippet
         FROM pad_search
         WHERE pad_search MATCH ? AND id = ?
         LIMIT 1`
        : `SELECT snippet(pad_search, 2, '${SNIPPET_MARK_OPEN}', '${SNIPPET_MARK_CLOSE}', '…', 32) AS snippet
         FROM pad_search
         WHERE pad_search MATCH ?
         LIMIT 1`;
    const row =
      padId != null ? db.prepare(sql).get(matchQuery, padId) : db.prepare(sql).get(matchQuery);
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

module.exports = {
  findById,
  findAll,
  create,
  updateText,
  updatePassword,
  remove,
  searchPads,
  searchSnippet,
};
