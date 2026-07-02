'use strict';

const crypto = require('crypto');
const session = require('../auth/session');
const users = require('../db/users');
const { ADMIN_TOKEN } = require('../config');

function parseCookies(cookieHeader): Record<string, string> {
  const result = {};
  if (!cookieHeader) return result;
  for (const pair of cookieHeader.split(';')) {
    const idx = pair.indexOf('=');
    if (idx < 0) continue;
    const key = pair.slice(0, idx).trim();
    try {
      result[key] = decodeURIComponent(pair.slice(idx + 1).trim());
    } catch {
      result[key] = pair.slice(idx + 1).trim();
    }
  }
  return result;
}

// Authenticate middleware: sets req.userId, never blocks
function authenticate(req, res, next) {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.session_token || req.headers['x-session-token'] || null;
  const userId = session.verify(token);
  req.userId = userId && users.exists(userId) ? userId : null;
  next();
}

function requireAuth(req, res, next) {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  next();
}

function isAdmin(req) {
  if (!ADMIN_TOKEN) return false;
  const provided = req.headers['x-admin-token'] || '';
  if (provided.length !== ADMIN_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(ADMIN_TOKEN));
}

module.exports = {
  parseCookies,
  authenticate,
  requireAuth,
  isAdmin,
};
