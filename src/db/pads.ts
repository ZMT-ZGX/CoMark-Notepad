'use strict';

const sqlite = require('./sqlite');
const { FTS_SYNC_DEBOUNCE_MS } = require('../config');
const logger = require('../utils/logger');
const padFileRefs = require('./padFileRefs');

import type { Pad } from '../types';

// ── Per-pad body cache ────────────────────────────────────────────────
// The WS patch path re-reads the full body from SQLite on every keystroke
// purely to have a patch base — but that base necessarily equals the body the
// previous updateText() wrote. Keep the latest body of each pad in memory and
// invalidate on every write; pads are capped at MAX_PADS, so the cache is
// bounded (≈ MAX_PADS × body size). The row is the source of truth and the
// cache is transparent to a SIGKILL: a fresh process rebuilds it from SQLite
// on first read. Callers always receive a shallow copy, never the cached
// object itself (the text string is shared — strings are immutable).
const bodyCache = new Map<number, Pad>();

function findById(id: number): Pad | undefined {
  const hit = bodyCache.get(id);
  if (hit) return { ...hit };
  const row = sqlite.prepareCached('SELECT * FROM pads WHERE id = ?').get(id);
  if (!row) return undefined;
  const pad = rowToPad(row);
  bodyCache.set(id, pad);
  return { ...pad };
}

function findAll(): Pad[] {
  const db = sqlite.getDb();
  return db.prepare('SELECT * FROM pads ORDER BY id').all().map(rowToPad);
}

// Columns needed for listing, lock checks and permission/version decisions.
// Deliberately excludes `text`, which is up to 100KB per pad: reading every
// body just to render the sidebar or to gate a search result pulled megabytes
// into memory per request. `text_version` IS included — a meta row must be
// able to answer "what version is this pad on" (e.g. the conditional-update
// check) without dragging the body out of SQLite.
const META_COLUMNS = 'id, password, created_at, owner_user_id, creator_code, text_version';

function findByIdMeta(id: number): Pad | undefined {
  const row = sqlite.prepareCached(`SELECT ${META_COLUMNS} FROM pads WHERE id = ?`).get(id);
  return row ? rowToPadMeta(row) : undefined;
}

function findAllMeta(): Pad[] {
  return sqlite
    .prepareCached(`SELECT ${META_COLUMNS} FROM pads ORDER BY id`)
    .all()
    .map(rowToPadMeta);
}

function count(): number {
  return sqlite.prepareCached('SELECT COUNT(*) AS cnt FROM pads').get().cnt;
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
  // RETURNING reads back only the scalar columns. The caller already knows the
  // body it just wrote, so re-selecting the whole row would drag up to 100KB
  // back out of SQLite on every keystroke purely to learn the new version.
  const row = sqlite
    .prepareCached(
      `UPDATE pads SET text = ?, text_version = text_version + 1 WHERE id = ?
       RETURNING ${META_COLUMNS}`
    )
    .get(text, id);
  if (!row) return null;
  scheduleSearchSync(id, text);
  const updated = { ...rowToPadMeta(row), text, textVersion: row.text_version };
  // The cache entry is a separate object: a caller holding `updated` must not
  // be able to mutate what findById() hands out later.
  bodyCache.set(id, { ...updated });
  return updated;
}

// ── Throttled derived-index sync (FTS + file references) ─────────────
// The pads row is written synchronously on every edit (durability is
// unchanged), but refreshing the trigram index used to ride along via an
// UPDATE trigger — one full re-tokenize of the whole body per keystroke. The
// refresh is now deferred per pad: the first edit schedules a sync, further
// edits inside the window only overwrite the pending body, and one UPDATE
// runs when the window closes. A crash before the flush is repaired by the
// boot-time reconcileSearchIndex(). The pad_file_refs junction rides the
// same flush (padFileRefs.refresh) so the TTL sweep reads edges that match
// the current bodies.

const SEARCH_SYNC_DEBOUNCE_MS = FTS_SYNC_DEBOUNCE_MS;

// Pending bodies, one entry per dirty pad. Kept outside the timer so
// flushSearchSync() can drain synchronously on shutdown.
const pendingSearchSync = new Map<number, string>();
let searchSyncTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSearchSync(id: number, text: string): void {
  pendingSearchSync.set(id, text);
  if (searchSyncTimer) return;
  searchSyncTimer = setTimeout(flushSearchSync, SEARCH_SYNC_DEBOUNCE_MS);
  searchSyncTimer.unref?.();
}

function flushSearchSync(): void {
  searchSyncTimer = null;
  if (pendingSearchSync.size === 0) return;
  // Snapshot and clear up front: from here the entries are the timer's
  // responsibility. flushSearchSync runs inside a setTimeout callback, so an
  // unhandled throw would take the whole process down — we never let one
  // escape onto the timer stack.
  const entries = Array.from(pendingSearchSync);
  pendingSearchSync.clear();
  writeSearchEntries(entries, 0);
}

/**
 * Apply the deferred FTS + reference refreshes with the timer-surviving
 * guarantee above. Any SQLite error is swallowed and retried once on the
 * next tick (covers the transient cases — SQLITE_BUSY under a concurrent
 * writer, a WAL checkpoint); a second failure drops the entries rather than
 * retrying forever. Nothing here is unrecoverable: reconcileSearchIndex()
 * rebuilds both derived indexes from the bodies at boot, and any pad edited
 * again schedules a fresh sync.
 */
function writeSearchEntries(entries: [number, string][], attempt: number): void {
  try {
    const db = sqlite.getDb();
    const update = db.prepare('UPDATE pad_search SET content = ? WHERE id = ?');
    const batch = db.transaction((rows: [number, string][]) => {
      const refLengths = padFileRefs.fileIdLengths(db);
      for (const [id, text] of rows) {
        update.run(text, id);
        padFileRefs.refresh(id, text, refLengths);
      }
    });
    batch(entries);
  } catch (err) {
    if (attempt < 1) {
      const retry = setTimeout(
        () => writeSearchEntries(entries, attempt + 1),
        SEARCH_SYNC_DEBOUNCE_MS
      );
      retry.unref?.();
      return;
    }
    logger.error(
      { err, pads: entries.length },
      'Derived-index refresh failed after retry; rebuilt at next boot'
    );
  }
}

/**
 * Synchronously flush any pending derived-index refreshes ("now", as opposed
 * to the debounced flush). Called on graceful shutdown so a search started
 * right after a restart never misses recent edits, and by the file TTL sweep
 * so it never acts on reference edges that trail a just-written body.
 */
function flushSearchSyncNow(): void {
  if (searchSyncTimer) {
    clearTimeout(searchSyncTimer);
    searchSyncTimer = null;
  }
  flushSearchSync();
}

function updatePassword(id: number, passwordHash: string | null): Pad | null {
  const result = sqlite
    .prepareCached('UPDATE pads SET password = ? WHERE id = ?')
    .run(passwordHash, id);
  if (result.changes === 0) return null;
  // The cached body carries the old password hash — drop it so findById
  // re-reads the row instead of answering from the stale entry.
  bodyCache.delete(id);
  return findById(id) || null;
}

function remove(id: number): void {
  bodyCache.delete(id);
  sqlite.prepareCached('DELETE FROM pads WHERE id = ?').run(id);
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

// Used for the metadata-only queries. `text` is intentionally empty: these
// rows exist for listing, lock checks and permission decisions, and any code
// that needs the document body must go through findById / findAll. Unlike
// `text`, `textVersion` carries the real value (see META_COLUMNS).
function rowToPadMeta(row: any): Pad {
  return {
    id: row.id,
    text: '',
    textVersion: row.text_version ?? 0,
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
  flushSearchSyncNow,
};
