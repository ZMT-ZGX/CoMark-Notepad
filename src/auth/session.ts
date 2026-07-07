'use strict';

const { verifySessionToken } = require('../utils/crypto');
const revokedTokens = require('../db/revokedTokens');
const logger = require('../utils/logger');

function revokeToken(token: string, expiresAtEpoch: number): void {
  revokedTokens.set(token, expiresAtEpoch);
  // With SQLite, revokedTokens.set() persists immediately to the revoked_tokens table
}

function isTokenRevoked(token: string): boolean {
  if (!revokedTokens.has(token)) return false;
  if (Date.now() / 1000 > revokedTokens.get(token)) {
    revokedTokens.del(token); // expired, clean up
    return false;
  }
  return true;
}

// Cleanup revoked tokens every 10 minutes
const revokedCleanupTimer = setInterval(() => {
  revokedTokens.cleanupExpired();
}, 600000);
revokedCleanupTimer.unref?.();

function verify(token: string | undefined | null): string | null {
  if (!token || isTokenRevoked(token)) return null;
  return verifySessionToken(token);
}

// Restore revoked tokens from SQLite on startup
function restoreFromStore(): void {
  revokedTokens.restoreFromSQLite();
  logger.info(`Restored ${revokedTokens.size()} revoked tokens from SQLite`);
}

function getRevokedTokens(): Record<string, number> {
  return revokedTokens.getAll();
}

function getCleanupTimer(): ReturnType<typeof setInterval> {
  return revokedCleanupTimer;
}

module.exports = {
  verify,
  revokeToken,
  isTokenRevoked,
  restoreFromStore,
  getRevokedTokens,
  getCleanupTimer,
};
