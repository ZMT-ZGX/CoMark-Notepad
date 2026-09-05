'use strict';

const sqlite = require('./sqlite');
const logger = require('../utils/logger');

/**
 * Schema migration is handled by sqlite.ts (CREATE TABLE IF NOT EXISTS plus
 * ensureColumn() for later additions). JSON → SQLite data migration is handled
 * by sqlite.ts migrateFromJSON().
 *
 * Default pad seeding was removed: a fresh install intentionally starts with
 * zero pads, because the legacy Pad #1 was public (owner NULL) and therefore
 * readable by anyone who registered on a public deployment.
 *
 * This module is kept for backward compatibility with the server startup sequence.
 */
function run() {
  const db = sqlite.getDb();
  if (!db) {
    throw new Error('SQLite database not initialized');
  }

  logger.info('Migration check complete');
  return Promise.resolve();
}

module.exports = { run };
