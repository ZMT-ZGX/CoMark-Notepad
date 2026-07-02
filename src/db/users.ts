'use strict';

const sqlite = require('./sqlite');

function init() {
  // With SQLite, no need to build in-memory index — queries go directly to DB
}

function exists(code) {
  const db = sqlite.getDb();
  const row = db.prepare('SELECT 1 FROM users WHERE code = ?').get(code);
  return !!row;
}

function create(user) {
  const db = sqlite.getDb();
  db.prepare('INSERT INTO users (code, created_at) VALUES (?, ?)').run(
    user.code,
    user.createdAt || Date.now()
  );
  return user;
}

module.exports = {
  init,
  exists,
  create,
};
