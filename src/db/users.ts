'use strict';

const sqlite = require('./sqlite');

import type { User } from '../types';

function init(): void {
  // With SQLite, no need to build in-memory index — queries go directly to DB
}

function exists(code: string): boolean {
  // Runs in the auth middleware on every request — keep it compiled once.
  const row = sqlite.prepareCached('SELECT 1 FROM users WHERE code = ?').get(code);
  return !!row;
}

function create(user: User): User {
  const db = sqlite.getDb();
  db.prepare('INSERT INTO users (code, created_at, display_name) VALUES (?, ?, ?)').run(
    user.code,
    user.createdAt || Date.now(),
    user.displayName ?? null
  );
  return user;
}

function findByCode(code: string): User | undefined {
  const row = sqlite.prepareCached('SELECT * FROM users WHERE code = ?').get(code);
  return row ? sqlite.rowToUser(row) : undefined;
}

function findAll(): User[] {
  const db = sqlite.getDb();
  return db
    .prepare('SELECT * FROM users ORDER BY created_at')
    .all()
    .map((r: any) => sqlite.rowToUser(r));
}

function setDisplayName(code: string, displayName: string | null): boolean {
  const db = sqlite.getDb();
  const name = displayName && displayName.trim() ? displayName.trim().slice(0, 64) : null;
  return db.prepare('UPDATE users SET display_name = ? WHERE code = ?').run(name, code).changes > 0;
}

module.exports = {
  init,
  exists,
  create,
  findByCode,
  findAll,
  setDisplayName,
};
