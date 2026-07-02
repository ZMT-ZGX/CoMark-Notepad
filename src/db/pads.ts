'use strict';

const sqlite = require('./sqlite');

function findById(id) {
  const db = sqlite.getDb();
  const row = db.prepare('SELECT * FROM pads WHERE id = ?').get(id);
  return row ? rowToPad(row) : undefined;
}

function findAll() {
  const db = sqlite.getDb();
  return db.prepare('SELECT * FROM pads ORDER BY id').all().map(rowToPad);
}

function create(pad) {
  const db = sqlite.getDb();
  const createdAt = Date.now();

  const result = db
    .prepare(
      'INSERT INTO pads (id, text, text_version, password, created_at, owner_user_id, creator_code) VALUES (NULL, ?, 0, ?, ?, ?, ?)'
    )
    .run('', null, createdAt, pad.ownerUserId || null, pad.creatorCode || null);

  return findById(Number(result.lastInsertRowid));
}

function updateText(id, text) {
  const db = sqlite.getDb();
  const result = db
    .prepare('UPDATE pads SET text = ?, text_version = text_version + 1 WHERE id = ?')
    .run(text, id);
  if (result.changes === 0) return null;
  return findById(id);
}

function updatePassword(id, passwordHash) {
  const db = sqlite.getDb();
  const result = db.prepare('UPDATE pads SET password = ? WHERE id = ?').run(passwordHash, id);
  if (result.changes === 0) return null;
  return findById(id);
}

function remove(id) {
  const db = sqlite.getDb();
  db.prepare('DELETE FROM pads WHERE id = ?').run(id);
}

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

module.exports = {
  findById,
  findAll,
  create,
  updateText,
  updatePassword,
  remove,
};
