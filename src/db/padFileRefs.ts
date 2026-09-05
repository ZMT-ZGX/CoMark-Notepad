'use strict';

const sqlite = require('./sqlite');

/**
 * Junction of "pad body references file" edges, derived from pads.text.
 *
 * The hourly TTL sweep used to answer "is this expired file referenced?" with
 * a per-candidate `instr()` scan over every pad body — O(expired × pads ×
 * body) on the event loop, seconds once bodies and files accumulate. The
 * junction turns that into an indexed lookup. It is a derived index, not a
 * source of truth: it is refreshed on the same debounced flush as the FTS
 * index, rebuilt at boot by sqlite.ts reconcileSearchIndex(), and a crash or
 * a dropped refresh heals at the next boot exactly like FTS.
 *
 * Needle semantics are the documented AGENTS.md contract, preserved exactly
 * from the instr() scan it replaced: file F is referenced iff the bare
 * substring `files/` + F occurs anywhere in the body. The bare needle errs
 * safe — `files/abc1` matches inside a longer token — so extraction resolves
 * every prefix of each captured token whose length equals some existing file
 * id's length (ids are base64url and 16 chars today; the length set keeps a
 * legacy shorter id matching exactly as instr() did).
 */

const REF_TOKEN_RE = /files\/([A-Za-z0-9_-]+)/g;

// A pad rarely carries more than a handful of attachments; 500 bounds the
// SQLite variable count per resolution query for pathological bodies.
const RESOLVE_CHUNK = 500;

/** Distinct lengths among current file ids, e.g. [16] for base64url(12). */
function fileIdLengths(db: any): number[] {
  return db
    .prepare('SELECT DISTINCT LENGTH(id) AS len FROM files')
    .all()
    .map((r: any) => r.len)
    .filter((len: number) => len > 0);
} /**
 * File ids possibly referenced by `text` under the bare-needle contract:
 * every prefix (at a real id length) of every `files/<token>` occurrence.
 * Pure function — resolution against the files table happens in refresh().
 */
function candidateFileIds(text: string, idLengths: number[]): string[] {
  const candidates = new Set<string>();
  if (!text || idLengths.length === 0) return [];
  for (const match of text.matchAll(REF_TOKEN_RE)) {
    const token = match[1];
    for (const len of idLengths) {
      if (len <= token.length) candidates.add(token.slice(0, len));
    }
  }
  return Array.from(candidates);
}

/**
 * Replace the reference rows of one pad. Runs plain statements so it can
 * participate in a caller's transaction (the debounced flush wraps it in
 * one); for standalone use, wrap it yourself. `lengths` may be precomputed
 * once for a whole flush batch via fileIdLengths() — a per-pad query here
 * would run one throwaway SELECT per entry.
 */
function refresh(padId: number, text: string, lengths?: number[]): void {
  const db = sqlite.getDb();
  db.prepare('DELETE FROM pad_file_refs WHERE pad_id = ?').run(padId);
  const candidates = candidateFileIds(text, lengths || fileIdLengths(db));
  if (candidates.length === 0) return;

  const referenced: string[] = [];
  for (let i = 0; i < candidates.length; i += RESOLVE_CHUNK) {
    const chunk = candidates.slice(i, i + RESOLVE_CHUNK);
    const rows = db
      .prepare(`SELECT id FROM files WHERE id IN (${chunk.map(() => '?').join(',')})`)
      .all(...chunk);
    for (const row of rows) referenced.push(row.id);
  }

  const insert = db.prepare('INSERT OR IGNORE INTO pad_file_refs (pad_id, file_id) VALUES (?, ?)');
  for (const fileId of referenced) insert.run(padId, fileId);
}

/** Drop one pad's rows (pad deletion is also covered by the pad_frd trigger). */
function removeByPad(padId: number): void {
  sqlite.getDb().prepare('DELETE FROM pad_file_refs WHERE pad_id = ?').run(padId);
}

/**
 * Rebuild the junction from every pad body. Runs at boot (bounded: pads are
 * capped at MAX_PADS) so a crash between a body write and its debounced
 * refresh can never leave the TTL sweep acting on stale edges.
 */
function rebuildAll(): void {
  const db = sqlite.getDb();
  const pads = db.prepare('SELECT id, text FROM pads').all();
  const lengths = fileIdLengths(db);
  const rebuild = db.transaction((rows: any[]) => {
    db.exec('DELETE FROM pad_file_refs');
    for (const pad of rows) refresh(pad.id, pad.text, lengths);
  });
  rebuild(pads);
}

module.exports = { candidateFileIds, fileIdLengths, refresh, removeByPad, rebuildAll };
