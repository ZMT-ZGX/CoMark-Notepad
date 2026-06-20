const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const Busboy = require('busboy');
const QRCode = require('qrcode');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const PORT = Number(process.env.PORT ?? 8000);
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30000;
const UNLOCK_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const MAX_PADS = 50;
const FILE_TTL_HOURS = Number(process.env.FILE_TTL_HOURS ?? 72);
const FILE_TTL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h

// --- Session & Auth ---
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_SECRET = process.env.SESSION_SECRET || (isProduction
  ? (() => { throw new Error('SESSION_SECRET env var is required in production'); })()
  : crypto.randomBytes(32).toString('hex'));
const cookieFlags = isProduction
  ? 'HttpOnly; SameSite=Strict; Path=/; Secure'
  : 'HttpOnly; SameSite=Strict; Path=/';
const SESSION_TOKEN_TTL_DAYS = Number(process.env.SESSION_TOKEN_TTL_DAYS ?? 30);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;

fs.mkdirSync(FILES_DIR, { recursive: true });

// --- Helpers ---

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 11);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes;
  let idx = -1;
  while (value >= 1024 && idx < units.length - 1) { value /= 1024; idx++; }
  return `${Number.isInteger(value) ? value : value.toFixed(1)} ${units[idx]}`;
}

function downloadBasename(name, fallback = 'file') {
  return String(name || fallback).replace(/\\/g, '/').split('/').pop().replace(/[\0\r\n]/g, '_') || fallback;
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function contentDisposition(disposition, filename) {
  const name = downloadBasename(filename);
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '_').replace(/["\\;]/g, '_').trim() || 'file';
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeRFC5987(name)}`;
}

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal && !iface.address.startsWith('169.254.')) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

// --- Cookie parser ---

function parseCookies(cookieHeader) {
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

// --- Session token ---

function signSessionToken(userId, expiresInDays) {
  const ttl = expiresInDays || SESSION_TOKEN_TTL_DAYS;
  const ts = Math.floor(Date.now() / 1000 + ttl * 86400).toString(36);
  const sig = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${ts}`).digest('hex');
  return `${userId}.${ts}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, tsStr, sig] = parts;
  if (!userId || !tsStr || !sig) return null;
  const expiresAt = parseInt(tsStr, 36);
  if (isNaN(expiresAt) || Date.now() / 1000 > expiresAt) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET)
    .update(`${userId}.${tsStr}`).digest('hex');
  if (sig.length !== expected.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
    ? userId : null;
}

// --- Origin check (CSRF) ---

function requireOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (!origin) return next(); // No origin header (same-origin requests)
  if (origin === PUBLIC_ORIGIN) return next(); // Exact match
  // When PUBLIC_ORIGIN is not explicitly set, also accept localhost and LAN IP
  if (!process.env.PUBLIC_ORIGIN) {
    try {
      const host = new URL(origin).hostname;
      if (host === 'localhost' || host === '127.0.0.1') return next();
      if (host === getLanIP()) return next();
    } catch {}
  }
  return res.status(403).json({ error: 'Invalid origin' });
}

// --- Admin check ---

function isAdmin(req) {
  const adminToken = process.env.ADMIN_TOKEN;
  if (!adminToken) return false;
  const provided = req.headers['x-admin-token'] || '';
  if (provided.length !== adminToken.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(adminToken));
}

// --- Password helpers ---

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const salt = Buffer.from(parts[1], 'hex');
    const hash = Buffer.from(parts[2], 'hex');
    const test = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(hash, test);
  } catch {
    return false;
  }
}

// --- Unlock token store ---

const unlockTokens = new Map(); // token -> { padId, expires }

function createUnlockToken(padId) {
  const token = generateId() + generateId();
  unlockTokens.set(token, { padId, expires: Date.now() + UNLOCK_TOKEN_TTL_MS });
  return token;
}

function isValidUnlockToken(token, padId) {
  if (!token) return false;
  const entry = unlockTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expires) {
    unlockTokens.delete(token);
    return false;
  }
  return entry.padId === padId;
}

// Cleanup expired tokens every 10 minutes
const unlockCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of unlockTokens) {
    if (now > entry.expires) unlockTokens.delete(token);
  }
}, 600000);
unlockCleanupTimer.unref?.();

// --- Store ---

let store = { pads: [], files: [], nextPadId: 1, users: [], inviteTokens: [], accessGrants: [] };

function loadStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load store:', e.message);
  }

  // Migrate old single-pad format → multi-pad
  if (!store.pads && store.text !== undefined) {
    const oldText = store.text || '';
    const oldVersion = Number.isInteger(store.textVersion) ? store.textVersion : 0;
    store = {
      pads: [{
        id: 1,
        text: oldText,
        textVersion: oldVersion,
        password: null,
        createdAt: Date.now(),
        ownerUserId: null,
        creatorCode: null,
      }],
      files: store.files || [],
      nextPadId: 2,
    };
    console.log('Migrated old single-pad store to multi-pad format (pad #1)');
  }

  if (!Array.isArray(store.pads)) store.pads = [];
  if (store.pads.length === 0) {
    store.pads.push({ id: 1, text: '', textVersion: 0, password: null, createdAt: Date.now(), ownerUserId: null, creatorCode: null });
  }
  if (!store.files) store.files = [];
  const maxPadId = store.pads.reduce((max, p) => Math.max(max, p.id), 0);
  if (!Number.isInteger(store.nextPadId) || store.nextPadId <= maxPadId) {
    store.nextPadId = maxPadId + 1;
  }

  // Migrate: add identity fields if missing
  if (!Array.isArray(store.users)) store.users = [];
  if (!Array.isArray(store.inviteTokens)) store.inviteTokens = [];
  if (!Array.isArray(store.accessGrants)) store.accessGrants = [];
  for (const pad of store.pads) {
    if (!('ownerUserId' in pad)) pad.ownerUserId = null;
    if (!('creatorCode' in pad)) pad.creatorCode = null;
  }
  for (const file of store.files) {
    if (!('ownerUserId' in file)) file.ownerUserId = null;
    if (!('padId' in file)) file.padId = store.pads[0]?.id || 1;
  }
}

let saveTimeout;
function saveStore() {
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
    } catch (e) {
      console.error('Failed to save store:', e.message);
    }
  }, 200);
}

function flushStore() {
  clearTimeout(saveTimeout);
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch (e) {
    console.error('Failed to flush store:', e.message);
  }
}

loadStore();

// --- File TTL cleanup ---

function cleanupExpiredFiles() {
  const ttlMs = FILE_TTL_HOURS * 3600000;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
  const now = Date.now();
  const expired = store.files.filter(f => now - (f.createdAt || 0) > ttlMs);
  if (expired.length === 0) return;
  for (const file of expired) {
    try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  }
  const expiredIds = new Set(expired.map(f => f.id));
  store.files = store.files.filter(f => !expiredIds.has(f.id));
  // Sync write: TTL cleanup is rare (hourly); don't risk losing deletions
  // if the process exits within the 200ms saveStore debounce window.
  flushStore();
  // Notify online clients so their file lists update without waiting for a refresh
  if (clients) {
    for (const file of expired) {
      broadcastToPad(file.padId || store.pads[0]?.id || 1, { type: 'file-deleted', fileId: file.id });
    }
  }
  console.log(`  Cleaned up ${expired.length} expired file(s) (TTL=${FILE_TTL_HOURS}h)`);
}

const fileTtlTimer = setInterval(cleanupExpiredFiles, FILE_TTL_CHECK_INTERVAL_MS);
fileTtlTimer.unref?.();

// --- User identity ---

function generateUserCode() {
  return crypto.randomBytes(6).toString('base64url'); // 8 chars
}

function generateInviteToken() {
  return crypto.randomBytes(16).toString('base64url'); // 22 chars, 128 bit
}

// --- Access control ---

function hasAccessGrant(grantorCode, granteeCode) {
  return store.accessGrants.some(
    g => g.grantorCode === grantorCode && g.granteeCode === granteeCode
  );
}

function canAccessPad(userId, pad) {
  if (!pad.ownerUserId) return true; // public pad
  if (!userId) return false;
  if (pad.ownerUserId === userId) return true; // owner
  return hasAccessGrant(pad.ownerUserId, userId); // invited
}

function canAccessFile(userId, file) {
  if (!file.ownerUserId) return true; // public file
  if (!userId) return false;
  if (file.ownerUserId === userId) return true;
  // Check if user has access to the pad this file belongs to
  const pad = findPad(file.padId);
  if (pad) return canAccessPad(userId, pad);
  return false;
}

function resolveFileOwner(req, pad) {
  // In invited pad, files belong to the pad owner, not the uploader
  if (pad && pad.ownerUserId) return pad.ownerUserId;
  return req.userId || null;
}

function canManagePad(req, pad) {
  // Private pad: owner or admin
  if (pad.ownerUserId) {
    return req.userId === pad.ownerUserId || isAdmin(req);
  }
  // Public pad with creator: creator or admin
  if (pad.creatorCode) {
    return req.userId === pad.creatorCode || isAdmin(req);
  }
  // Legacy pad (creatorCode=null): admin; fallback to any auth user when no ADMIN_TOKEN
  if (isAdmin(req)) return true;
  if (!process.env.ADMIN_TOKEN && req.userId) return true;
  return false;
}

// --- Pad helpers ---

function findPad(id) {
  return store.pads.find(p => p.id === id);
}

function padMeta(pad) {
  return {
    id: pad.id,
    hasPassword: !!pad.password,
    createdAt: pad.createdAt,
    ownerUserId: pad.ownerUserId || null,
  };
}

// --- Express ---

const app = express();
app.disable('x-powered-by');

// Security headers (relaxed CSP for inline SVG favicon)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", 'data:', 'blob:'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      baseUri: ["'self'"],
      fontSrc: ["'self'", 'https:', 'data:'],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      objectSrc: ["'none'"],
      scriptSrcAttr: ["'none'"],
      upgradeInsecureRequests: null,
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Request logging
app.use((req, _res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress;
  console.log(`  ${new Date().toISOString().slice(11, 19)} ${req.method} ${req.path} [${ip}]`);
  next();
});

// Rate limiting
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
app.use('/api/', generalLimiter);

const writeLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 min
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many write requests.' },
});

const unlockLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many unlock attempts. Please try again later.' },
});

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many registration attempts.' },
});

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many redeem attempts.' },
});

const publicPadCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  skip: (req) => !!req.userId,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many public pad creations.' },
});

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many uploads.' },
});

const clearFilesLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 5,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many clear-all attempts.' },
});

app.use(express.json({ limit: JSON_BODY_LIMIT }));

// Authenticate middleware (sets req.userId, never blocks)
app.use((req, _res, next) => {
  const cookies = parseCookies(req.headers.cookie || '');
  const token = cookies.session_token || req.headers['x-session-token'] || null;
  const userId = verifySessionToken(token);
  req.userId = (userId && store.users && store.users.some(u => u.code === userId)) ? userId : null;
  next();
});

// Prevent iOS Safari from caching HTML (ensures fresh CSS/JS refs)
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

function getServerPort() {
  const address = server.address();
  return address && typeof address === 'object' ? address.port : PORT;
}

function getNetworkUrl() {
  return `http://${getLanIP()}:${getServerPort()}`;
}

// --- Health check (before any auth, for Docker healthcheck) ---
// authenticate middleware runs before this but only sets req.userId, never blocks

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    pads: store.pads.length,
    files: store.files.length,
    clients: clients.size,
  });
});

// QR code
app.get('/api/qrcode', async (_req, res, next) => {
  try {
    const svg = await QRCode.toString(getNetworkUrl(), { type: 'svg', margin: 2, width: 200 });
    res.type('image/svg+xml').send(svg);
  } catch (err) {
    next(err);
  }
});

// --- Auth API ---

app.post('/api/auth/register', registerLimiter, requireOrigin, (req, res) => {
  const code = generateUserCode();
  store.users.push({ code, createdAt: Date.now() });
  saveStore();
  const requested = Number(req.body?.expiresInDays);
  const expiresInDays = Number.isFinite(requested) && requested > 0
    ? Math.min(Math.floor(requested), SESSION_TOKEN_TTL_DAYS)
    : SESSION_TOKEN_TTL_DAYS;
  const token = signSessionToken(code, expiresInDays);
  res.setHeader('Set-Cookie', `session_token=${token}; ${cookieFlags}; Max-Age=${expiresInDays * 86400}`);
  res.json({ code, token, expiresInDays });
});

app.post('/api/auth/verify', (req, res) => {
  const token = req.body?.token;
  const userId = verifySessionToken(token);
  if (userId && store.users.some(u => u.code === userId)) {
    res.json({ valid: true, code: userId });
  } else {
    res.json({ valid: false });
  }
});

app.get('/api/auth/me', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ code: req.userId });
});

// --- Invitation API ---

app.post('/api/invitations', requireOrigin, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const rawMaxUses = Number(req.body?.maxUses);
  const maxUses = Number.isFinite(rawMaxUses) && rawMaxUses >= 0 ? Math.floor(rawMaxUses) : 1;
  const expiresInHours = Number(req.body?.expiresInHours) || 0;
  const token = generateInviteToken();
  store.inviteTokens.push({
    token,
    creatorCode: req.userId,
    maxUses: maxUses > 0 ? maxUses : 0, // 0 = unlimited
    useCount: 0,
    expiresAt: expiresInHours > 0 ? Date.now() + expiresInHours * 3600000 : null,
    createdAt: Date.now(),
  });
  saveStore();
  res.json({ token, maxUses, expiresInHours: expiresInHours || null });
});

app.post('/api/invitations/redeem', redeemLimiter, requireOrigin, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const token = req.body?.token;
  if (!token) return res.status(400).json({ error: 'Token required' });

  const invite = store.inviteTokens.find(t => t.token === token);
  if (!invite) return res.status(404).json({ error: 'Invalid invitation token' });
  if (invite.expiresAt && Date.now() > invite.expiresAt) {
    return res.status(410).json({ error: 'Invitation expired' });
  }
  if (invite.maxUses > 0 && invite.useCount >= invite.maxUses) {
    return res.status(410).json({ error: 'Invitation fully redeemed' });
  }
  if (invite.creatorCode === req.userId) {
    return res.status(400).json({ error: 'Cannot redeem your own invitation' });
  }
  if (hasAccessGrant(invite.creatorCode, req.userId)) {
    return res.status(409).json({ error: 'Already have access from this inviter' });
  }

  store.accessGrants.push({
    inviteToken: token,
    grantorCode: invite.creatorCode,
    granteeCode: req.userId,
    grantedAt: Date.now(),
  });
  invite.useCount += 1;
  saveStore();
  res.json({ ok: true, grantorCode: invite.creatorCode });
});

app.get('/api/invitations', (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const created = store.inviteTokens.filter(t => t.creatorCode === req.userId);
  const received = store.accessGrants.filter(g => g.granteeCode === req.userId);
  res.json({ created, received });
});

app.delete('/api/invitations/:token', requireOrigin, (req, res) => {
  if (!req.userId) return res.status(401).json({ error: 'Authentication required' });
  const idx = store.inviteTokens.findIndex(t => t.token === req.params.token);
  if (idx === -1) return res.status(404).json({ error: 'Token not found' });
  if (store.inviteTokens[idx].creatorCode !== req.userId) {
    return res.status(403).json({ error: 'Not your invitation' });
  }
  store.inviteTokens.splice(idx, 1);
  saveStore();
  res.json({ ok: true });
});

// --- Pad API ---

// Get global state (pad list metadata + files)
app.get('/api/state', (req, res) => {
  const accessiblePads = store.pads.filter(p => canAccessPad(req.userId, p));
  const accessibleFiles = store.files.filter(f => canAccessFile(req.userId, f));
  res.json({
    pads: accessiblePads.map(padMeta),
    files: accessibleFiles,
    nextPadId: store.nextPadId,
    userCode: req.userId || null,
  });
});

// Get pad content
app.get('/api/pads/:id', (req, res) => {
  const pad = findPad(Number(req.params.id));
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  if (!canAccessPad(req.userId, pad)) return res.status(403).json({ error: 'Access denied' });

  if (pad.password) {
    const token = req.headers['x-pad-token'];
    if (!isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
  }

  res.json({ id: pad.id, text: pad.text, textVersion: pad.textVersion, hasPassword: !!pad.password });
});

// Update pad text
app.put('/api/pads/:id/text', writeLimiter, (req, res) => {
  const pad = findPad(Number(req.params.id));
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  if (!canAccessPad(req.userId, pad)) return res.status(403).json({ error: 'Access denied' });

  if (pad.password) {
    const token = req.headers['x-pad-token'];
    if (!isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
  }

  pad.text = typeof req.body.text === 'string' ? req.body.text : '';
  pad.textVersion += 1;
  saveStore();
  broadcastToPad(pad.id, {
    type: 'text-update',
    padId: pad.id,
    text: pad.text,
    textVersion: pad.textVersion,
  }, req.body._wsId);
  res.json({ ok: true, textVersion: pad.textVersion });
});

// Create new pad
app.post('/api/pads', publicPadCreateLimiter, requireOrigin, (req, res) => {
  if (store.pads.length >= MAX_PADS) {
    return res.status(400).json({ error: `Maximum ${MAX_PADS} pads reached` });
  }
  // Find smallest available ID starting from 1
  const usedIds = new Set(store.pads.map(p => p.id));
  let id = 1;
  while (usedIds.has(id)) id++;
  const pad = {
    id,
    text: '',
    textVersion: 0,
    password: null,
    createdAt: Date.now(),
    ownerUserId: req.userId || null,
    creatorCode: req.userId || null,
  };
  store.pads.push(pad);
  saveStore();
  broadcastToPad(pad.id, { type: 'pad-created', pad: padMeta(pad) });
  res.json({ id, text: '', textVersion: 0, hasPassword: false, ownerUserId: pad.ownerUserId });
});

// Set/change/remove pad password
app.post('/api/pads/:id/password', requireOrigin, (req, res) => {
  const pad = findPad(Number(req.params.id));
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  // Permission: own pad → OK; public pad → creator/Admin; legacy → Admin (fallback any auth)
  if (!canManagePad(req, pad)) {
    return res.status(pad.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
  }

  // If pad already has a password, require current password or unlock token
  if (pad.password) {
    const token = req.headers['x-pad-token'];
    if (!isValidUnlockToken(token, pad.id)) {
      const currentPassword = req.body.currentPassword;
      if (!currentPassword || !verifyPassword(currentPassword, pad.password)) {
        return res.status(403).json({ error: 'Current password incorrect' });
      }
    }
  }

  const newPassword = req.body.password;
  if (newPassword && typeof newPassword === 'string' && newPassword.length > 0) {
    pad.password = hashPassword(newPassword);
  } else {
    pad.password = null;
  }
  saveStore();

  // Invalidate old unlock tokens for this pad
  for (const [token, entry] of unlockTokens) {
    if (entry.padId === pad.id) unlockTokens.delete(token);
  }

  // Issue new unlock token if password was set (so caller stays unlocked)
  let newToken = null;
  if (pad.password) {
    newToken = createUnlockToken(pad.id);
  }

  broadcastToPad(pad.id, { type: 'pad-updated', pad: padMeta(pad) });
  res.json({ ok: true, hasPassword: !!pad.password, token: newToken });
});

// Delete pad
app.delete('/api/pads/:id', requireOrigin, (req, res) => {
  const padId = Number(req.params.id);
  const pad = findPad(padId);
  if (!pad) return res.status(404).json({ error: 'Pad not found' });
  // Permission: own pad → OK; public pad → creator/Admin; legacy → Admin (fallback any auth)
  if (!canManagePad(req, pad)) {
    return res.status(pad.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
  }

  if (pad.password) {
    const token = req.headers['x-pad-token'];
    if (!isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
  }

  // Don't allow deleting the last pad
  if (store.pads.length <= 1) {
    return res.status(400).json({ error: 'Cannot delete the last pad' });
  }

  // Invalidate unlock tokens for this pad
  for (const [token, entry] of unlockTokens) {
    if (entry.padId === padId) unlockTokens.delete(token);
  }

  store.pads = store.pads.filter(p => p.id !== padId);
  saveStore();
  broadcastToPad(padId, { type: 'pad-deleted', padId });
  res.json({ ok: true });
});

// Unlock pad (verify password)
app.post('/api/pads/:id/unlock', unlockLimiter, requireOrigin, (req, res) => {
  const pad = findPad(Number(req.params.id));
  if (!pad) return res.status(404).json({ error: 'Pad not found' });

  if (!pad.password) {
    return res.json({ ok: true, token: null });
  }

  const password = req.body.password;
  if (!password || !verifyPassword(password, pad.password)) {
    return res.status(403).json({ error: 'Wrong password' });
  }

  const token = createUnlockToken(pad.id);
  res.json({ ok: true, token });
});

// --- File API ---

// Upload file
app.post('/api/upload', uploadLimiter, (req, res) => {
  const contentType = req.headers['content-type'] || '';
  if (!contentType.startsWith('multipart/form-data')) {
    return res.status(400).json({ error: 'multipart/form-data required' });
  }

  let busboy;
  try {
    busboy = Busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: {
        files: 1,
        fileSize: MAX_FILE_BYTES,
        fields: 8,
        parts: 9,
      },
    });
  } catch {
    return res.status(400).json({ error: 'Invalid multipart form data' });
  }

  let excludeWsId = null;
  let padIdField = null;
  let fileInfo = null;
  let fileSeen = false;
  let fileLimitReached = false;
  let finished = false;
  let aborted = false;
  let filePath = null;
  let fileWritePromise = null;
  let writeStream = null;
  let uploadAccessDenied = false;

  function cleanupPartialFile() {
    if (writeStream) {
      writeStream.destroy();
      writeStream = null;
    }
    if (filePath && fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    filePath = null;
  }

  function fail(status, error) {
    if (finished) return;
    finished = true;
    cleanupPartialFile();
    res.status(status).json({ error });
  }

  req.on('aborted', () => {
    aborted = true;
    if (!finished) cleanupPartialFile();
  });

  busboy.on('field', (name, value) => {
    if (name === '_wsId') excludeWsId = String(value || '');
    if (name === 'padId') padIdField = Number(value) || null;
  });

  busboy.on('filesLimit', () => {
    fail(400, 'Only one file allowed');
  });

  busboy.on('partsLimit', () => {
    fail(400, 'Too many form parts');
  });

  busboy.on('file', (name, file, info) => {
    if (name !== 'file') {
      file.resume();
      return;
    }
    if (fileSeen) {
      file.resume();
      return;
    }

    fileSeen = true;

    const originalName = downloadBasename(info.filename, '');
    if (!originalName) {
      file.resume();
      return;
    }

    const id = generateId();
    const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
    const filename = `${id}_${safeName}`;
    filePath = path.join(FILES_DIR, filename);

    // Early access check: only safe to short-circuit when padId field has
    // already arrived (field order is not guaranteed by multipart). The
    // authoritative check runs at finish time.
    if (padIdField !== null) {
      const earlyPad = findPad(padIdField);
      if (earlyPad && !canAccessPad(req.userId, earlyPad)) {
        uploadAccessDenied = true;
        file.resume();
        return;
      }
    }

    fileInfo = {
      id,
      filename,
      originalName,
      size: 0,
      mimeType: (info.mimeType || 'application/octet-stream').toLowerCase(),
      createdAt: Date.now(),
      ownerUserId: null, // set after busboy finishes
      padId: 1,          // set after busboy finishes
    };

    writeStream = fs.createWriteStream(filePath, { flags: 'wx' });
    fileWritePromise = new Promise((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      file.on('error', reject);
    });

    file.on('limit', () => {
      fileLimitReached = true;
      if (writeStream) writeStream.destroy(new Error('File too large'));
    });

    file.on('data', (chunk) => {
      if (!fileInfo) return;
      fileInfo.size += chunk.length;
    });

    file.pipe(writeStream);
  });

  busboy.on('error', () => {
    fail(400, 'Invalid multipart form data');
  });

  busboy.on('finish', async () => {
    if (finished || aborted) return;
    if (uploadAccessDenied) {
      finished = true;
      return res.status(403).json({ error: 'Access denied' });
    }
    if (!fileSeen || !fileInfo) {
      return fail(400, 'file required');
    }
    if (fileLimitReached) {
      return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
    }

    try {
      await fileWritePromise;
    } catch (err) {
      if (fileLimitReached) {
        return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
      }
      console.error('Failed to save upload:', err);
      return fail(500, 'Failed to save upload');
    }

    if (finished || aborted) return;

    // Resolve file ownership and pad association
    const targetPadId = padIdField || store.pads[0]?.id || 1;
    const targetPad = findPad(targetPadId);
    // Authoritative access check: padId field may have arrived after the file
    // part, so the early check in the 'file' handler could have missed it.
    if (targetPad && !canAccessPad(req.userId, targetPad)) {
      return fail(403, 'Access denied');
    }
    fileInfo.ownerUserId = resolveFileOwner(req, targetPad);
    fileInfo.padId = targetPadId;

    store.files.unshift(fileInfo);
    saveStore();
    broadcastToPad(fileInfo.padId, { type: 'file-added', file: fileInfo }, excludeWsId);
    finished = true;
    res.json(fileInfo);
  });

  req.pipe(busboy);
});

// Download file
app.get('/api/files/:id', (req, res) => {
  const file = store.files.find(f => f.id === req.params.id);
  if (!file) return res.status(404).json({ error: 'File not found' });
  if (!canAccessFile(req.userId, file)) return res.status(403).json({ error: 'Access denied' });
  const filepath = path.join(FILES_DIR, file.filename);
  if (!fs.existsSync(filepath)) return res.status(404).json({ error: 'File not found on disk' });

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', contentDisposition('attachment', file.originalName));
  res.type(file.mimeType || 'application/octet-stream');
  res.sendFile(filepath);
});

// Delete single file
app.delete('/api/files/:id', requireOrigin, (req, res) => {
  const excludeWsId = req.body && req.body._wsId;
  const idx = store.files.findIndex(f => f.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'File not found' });
  const file = store.files[idx];
  // Permission: file owner → OK; otherwise pad creator/Admin (legacy fallback: any auth user)
  if (file.ownerUserId) {
    if (req.userId !== file.ownerUserId && !isAdmin(req)) {
      // Not the uploader: check if user can manage the pad
      const pad = findPad(file.padId);
      if (!pad || !canManagePad(req, pad)) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }
  } else {
    // Legacy public file (ownerUserId=null): require pad manager or admin
    const pad = findPad(file.padId);
    if (!pad || !canManagePad(req, pad)) {
      return res.status(pad?.ownerUserId ? 403 : (req.userId ? 403 : 401)).json({ error: 'Access denied' });
    }
  }
  store.files.splice(idx, 1);
  try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  saveStore();
  broadcastToPad(file.padId || store.pads[0]?.id || 1, { type: 'file-deleted', fileId: file.id }, excludeWsId);
  res.json({ ok: true });
});

// Clear all files (scoped to current pad)
app.delete('/api/files', clearFilesLimiter, requireOrigin, (req, res) => {
  const excludeWsId = req.body && req.body._wsId;
  const padIdRaw = req.body?.padId;
  const targetPadId = Number(padIdRaw);
  if (!Number.isInteger(targetPadId) || targetPadId <= 0) {
    return res.status(400).json({ error: 'padId required' });
  }
  const targetPad = findPad(targetPadId);
  if (!targetPad) return res.status(404).json({ error: 'Pad not found' });

  // Permission check for the pad
  if (targetPad && targetPad.ownerUserId) {
    if (req.userId !== targetPad.ownerUserId && !isAdmin(req)) {
      return res.status(403).json({ error: 'Access denied' });
    }
  } else if (targetPad && !targetPad.ownerUserId) {
    // Public pad: creator/Admin, or any authenticated user for legacy pads (creatorCode=null)
    if (targetPad.creatorCode && req.userId !== targetPad.creatorCode && !isAdmin(req)) {
      return res.status(403).json({ error: 'Only pad creator or admin can clear files' });
    }
    if (!targetPad.creatorCode && !req.userId && !isAdmin(req)) {
      return res.status(401).json({ error: 'Authentication required' });
    }
  }

  const toDelete = store.files.filter(f => (f.padId || 1) === targetPadId);
  for (const file of toDelete) {
    try { fs.unlinkSync(path.join(FILES_DIR, file.filename)); } catch {}
  }
  const clearedIds = toDelete.map(f => f.id);
  store.files = store.files.filter(f => (f.padId || 1) !== targetPadId);
  saveStore();
  for (const id of clearedIds) {
    broadcastToPad(targetPadId, { type: 'file-deleted', fileId: id }, excludeWsId);
  }
  res.json({ ok: true, cleared: clearedIds.length });
});

// Error handler
app.use((err, _req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `File too large (max ${formatBytes(MAX_FILE_BYTES)})` });
  }
  if (err.status >= 400 && err.status < 500) return res.status(err.status).json({ error: err.message });
  console.error('Unexpected error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- HTTP + WebSocket ---

const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

function getPadClientCount(padId) {
  let count = 0;
  for (const ws of clients) {
    if (ws.padId === padId) count++;
  }
  return count;
}

function broadcastPadOnlineCount(padId) {
  broadcastToPad(padId, { type: 'online-count', count: getPadClientCount(padId) });
}

function removeClient(ws) {
  if (!clients.delete(ws)) return;
  if (ws.padId != null) broadcastPadOnlineCount(ws.padId);
}

wss.on('connection', (ws, req) => {
  // Parse padId and token from URL query
  const url = new URL(req.url, 'http://localhost');
  const padId = Number(url.searchParams.get('pad')) || 1;

  // Token verification: Cookie → query fallback
  const cookieToken = parseCookies(req.headers.cookie || '')['session_token'];
  const queryToken = url.searchParams.get('token');
  const token = cookieToken || queryToken || null;
  const userId = verifySessionToken(token);
  ws.userId = (userId && store.users.some(u => u.code === userId)) ? userId : null;

  // Access control: check if user can access the target pad
  const targetPad = findPad(padId);
  if (targetPad && !canAccessPad(ws.userId, targetPad)) {
    ws.close(4401, 'Access denied');
    return;
  }

  // Password-protected pad: require a valid unlock token (cookie or ?padToken=)
  if (targetPad && targetPad.password) {
    const padToken = url.searchParams.get('padToken') || req.headers['x-pad-token'] || null;
    if (!isValidUnlockToken(padToken, padId)) {
      ws.close(4403, 'Pad locked');
      return;
    }
  }

  ws.clientId = generateId();
  ws.padId = padId;
  ws.isAlive = true;
  clients.add(ws);

  ws.on('pong', () => {
    ws.isAlive = true;
  });
  ws.on('close', () => removeClient(ws));
  ws.on('error', () => removeClient(ws));

  ws.send(JSON.stringify({ type: 'hello', wsId: ws.clientId, padId, userId: ws.userId }));
  broadcastPadOnlineCount(padId);
});

function broadcastToPad(padId, data, excludeWsId) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.padId !== padId) continue;
    if (excludeWsId && ws.clientId === excludeWsId) continue;
    if (ws.readyState !== WebSocket.OPEN) continue;
    try {
      ws.send(msg);
    } catch {
      removeClient(ws);
    }
  }
}

const heartbeatTimer = setInterval(() => {
  for (const ws of clients) {
    if (ws.readyState !== WebSocket.OPEN) {
      removeClient(ws);
      continue;
    }
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

// --- Graceful shutdown ---

function gracefulShutdown(signal) {
  console.log(`\n  ${signal} received, shutting down...`);
  clearInterval(heartbeatTimer);
  clearInterval(unlockCleanupTimer);
  clearInterval(fileTtlTimer);
  flushStore();
  for (const ws of clients) {
    try { ws.close(1001, 'Server shutting down'); } catch {}
  }
  server.close(() => {
    console.log('  Server closed.');
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

server.on('close', () => {
  clearInterval(heartbeatTimer);
  clearInterval(unlockCleanupTimer);
  clearInterval(fileTtlTimer);
});

// --- Start ---

const lanIP = getLanIP();

server.listen(PORT, '0.0.0.0', async () => {
  const currentPort = getServerPort();
  const url = `http://${lanIP}:${currentPort}`;
  // Initial cleanup runs here (not at module load) so `clients`/broadcastToPad
  // are initialized — expired files get broadcast to any already-connected clients.
  cleanupExpiredFiles();
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║     Collab Notepad is running!           ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Local:   http://localhost:${currentPort}`.padEnd(44) + '║');
  console.log(`  ║  Network: ${url}`.padEnd(44) + '║');
  console.log(`  ║  Pads:    ${store.pads.length} (${store.pads.map(p => p.id).join(', ')})`.padEnd(44) + '║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');

  try {
    const qr = await QRCode.toString(url, { type: 'terminal', small: true });
    console.log('  Scan QR code to connect from phone:');
    console.log('');
    console.log(qr);
  } catch {}
});
