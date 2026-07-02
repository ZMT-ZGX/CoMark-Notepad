'use strict';

import type { StoreState } from '../types';
const sqlite = require('./sqlite');
const { FILES_DIR } = require('../config');
const fsSync = require('fs');
const logger = require('../utils/logger');

// Ensure directories exist
fsSync.mkdirSync(FILES_DIR, { recursive: true });

/**
 * SQLite-backed store adapter.
 *
 * Replaces the old JSONStore while preserving the same public API:
 *   load() / getStore() / save() / flush() / flushSync()
 *
 * With SQLite, writes are synchronous and auto-committed, so
 * save/flush/flushSync are effectively no-ops (kept for backward compat).
 */
class SQLiteStore {
  dataDir: string;
  data: StoreState | null;
  dirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  writeLock: boolean;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.data = null;
    this.dirty = false;
    this.saveTimer = null;
    this.writeLock = false;
  }

  /**
   * Open SQLite database, create schema, migrate from JSON if needed.
   */
  async load() {
    sqlite.open();
    // Populate in-memory data snapshot for backward compat
    this.data = sqlite.getStoreSnapshot();
    logger.info('SQLite store loaded');
  }

  /**
   * Return the full data snapshot.
   * NOTE: This is now a read-only snapshot. Callers should use db/* modules
   * for mutations instead of modifying this object directly.
   */
  getStore() {
    // Refresh snapshot on demand (called by legacy code paths)
    this.data = sqlite.getStoreSnapshot();
    return this.data;
  }

  /**
   * No-op with SQLite (writes are auto-committed).
   */
  save() {
    // SQLite auto-commits; nothing to debounce
  }

  /**
   * No-op with SQLite.
   */
  async flush() {
    // SQLite auto-commits; nothing to flush
  }

  /**
   * Close the SQLite connection on shutdown.
   */
  flushSync() {
    // SQLite auto-commits; just close on shutdown
    sqlite.close();
  }
}

// Singleton instance
const store = new SQLiteStore(FILES_DIR);

module.exports = {
  store,
  FILES_DIR,
};
