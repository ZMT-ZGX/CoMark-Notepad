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

function findExpired(ttlMs: number): FileInfo[] {
  const db = sqlite.getDb();
  const cutoff = Date.now() - ttlMs;
  return db.prepare('SELECT * FROM files WHERE created_at < ?').all(cutoff).map(rowToFile);
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

module.exports = {
  findById,
  findAll,
  create,
  remove,
  removeByPadId,
  removeMany,
  findExpired,
  removeExpired,
};
