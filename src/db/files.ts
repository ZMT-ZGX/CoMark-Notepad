'use strict';

const sqlite = require('./sqlite');

import type { FileInfo } from '../types';

function findById(id: string): FileInfo | undefined {
  const db = sqlite.getDb();
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  return row ? rowToFile(row) : undefined;
}

function findAll(): FileInfo[] {
  const db = sqlite.getDb();
  return db.prepare('SELECT * FROM files ORDER BY created_at DESC').all().map(rowToFile);
}

// Metadata-only count. Callers that just need a total (health check, pad
// listing) must use this instead of findAll().length — findAll() materializes
// every row and maps it through rowToFile.
function count(): number {
  const db = sqlite.getDb();
  return db.prepare('SELECT COUNT(*) AS cnt FROM files').get().cnt;
}

function create(fileInfo: FileInfo): FileInfo {
  const db = sqlite.getDb();
  db.prepare(
    'INSERT INTO files (id, filename, original_name, size, mime_type, created_at, owner_user_id, pad_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(
    fileInfo.id,
    fileInfo.filename,
    fileInfo.originalName,
    fileInfo.size,
    fileInfo.mimeType,
    fileInfo.createdAt || Date.now(),
    fileInfo.ownerUserId || null,
    fileInfo.padId ?? 1
  );
  return fileInfo;
}

function remove(id: string): void {
  const db = sqlite.getDb();
  db.prepare('DELETE FROM files WHERE id = ?').run(id);
}

function removeByPadId(padId: number): void {
  const db = sqlite.getDb();
  db.prepare('DELETE FROM files WHERE pad_id = ?').run(padId);
}

function removeMany(ids: string[]): void {
  if (!ids || ids.length === 0) return;
  const db = sqlite.getDb();
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(`DELETE FROM files WHERE id IN (${placeholders})`).run(...ids);
}

// A file whose lifetime has expired is only collectable when NO pad body
// links to it. Pad text can embed `/api/files/<id>` references (manual
// Markdown image/link syntax), and deleting a referenced file would leave a
// permanently broken image or link behind — the attachment outlives the TTL
// as long as some pad still uses it.
//
// The needle is the bare `files/<id>` substring (the documented AGENTS.md
// contract). A narrower `)`/`/` continuation needle would MISS references
// that end in `>`, `"`, whitespace or end-of-text and delete those files as
// broken links. The trade-off of the bare needle: a shorter id
// substring-matches inside a reference to a longer one (`files/abc1` inside
// `files/abc123`), which errs in the safe direction — the file is kept
// longer than strictly needed, never deleted while referenced.
function findExpired(ttlMs: number): FileInfo[] {
  const db = sqlite.getDb();
  const cutoff = Date.now() - ttlMs;
  return db
    .prepare(
      `SELECT * FROM files
       WHERE created_at < ?
         AND NOT EXISTS (
           SELECT 1 FROM pads p
           WHERE instr(p.text, 'files/' || files.id) > 0
         )`
    )
    .all(cutoff)
    .map(rowToFile);
}

function removeExpired(ttlMs: number): FileInfo[] {
  const expired = findExpired(ttlMs);
  if (expired.length === 0) return [];
  const expiredIds = expired.map((f: FileInfo) => f.id);
  removeMany(expiredIds);
  return expired;
}

function rowToFile(row: any): FileInfo {
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

// Total bytes currently held on disk. Passing `ownerUserId` narrows the sum
// to a single account; otherwise it is the instance-wide total. Backs the
// aggregate storage caps, so it must count committed rows only.
function sumBytes(ownerUserId?: string | null): number {
  const db = sqlite.getDb();
  const row = ownerUserId
    ? db
        .prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files WHERE owner_user_id = ?')
        .get(ownerUserId)
    : db.prepare('SELECT COALESCE(SUM(size), 0) AS total FROM files').get();
  return Number(row.total) || 0;
}

module.exports = {
  findById,
  findAll,
  count,
  create,
  sumBytes,
  remove,
  removeByPadId,
  removeMany,
  findExpired,
  removeExpired,
};
