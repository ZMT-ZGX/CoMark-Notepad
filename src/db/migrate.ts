'use strict';

const sqlite = require('./sqlite');
const logger = require('../utils/logger');

/**
 * Schema migration is handled by sqlite.ts (CREATE TABLE IF NOT EXISTS).
 * JSON → SQLite data migration is handled by sqlite.ts migrateFromJSON().
 * Default pad seeding is handled by sqlite.ts seedDefaultPad().
 *
 * This module is kept for backward compatibility with the server startup sequence.
 */
function run() {
  const db = sqlite.getDb();
  if (!db) {
    throw new Error('SQLite database not initialized');
  }

  // Ensure at least one pad exists (delegates to sqlite.seedDefaultPad logic)
  const padCount = db.prepare('SELECT COUNT(*) as cnt FROM pads').get().cnt;
  if (padCount === 0) {
    db.prepare(
      'INSERT INTO pads (id, text, text_version, password, created_at, owner_user_id, creator_code) VALUES (NULL, ?, 0, NULL, ?, NULL, NULL)'
    ).run('', Date.now());
    logger.info('Created default pad #1');
  }

  logger.info('Migration check complete');
  return Promise.resolve();
}

module.exports = { run };
