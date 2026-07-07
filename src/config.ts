'use strict';

const path = require('path');

// Parse an env var as a positive integer, falling back when unset, non-numeric,
// or non-positive. Guards against NaN silently disabling rate-limit logic.
function parsePositiveInt(value: string | undefined, fallback: number): number {
  const num = value != null ? parseInt(String(value), 10) : NaN;
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

// PORT=0 is valid (ephemeral port), so we use Number() with a NaN guard instead
// of parsePositiveInt which rejects zero.
const PORT = Number(process.env.PORT ?? 8000);
if (!Number.isFinite(PORT)) throw new Error('PORT must be a finite number');
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(__dirname, '..', 'data');
const FILES_DIR = path.join(DATA_DIR, 'files');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const SQLITE_FILE = path.join(DATA_DIR, 'store.db');

const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB
const JSON_BODY_LIMIT = 2 * 1024 * 1024;
const HEARTBEAT_INTERVAL_MS = 30000;
const UNLOCK_TOKEN_TTL_MS = 8 * 60 * 60 * 1000; // 8h (pad unlock bearer window)
const MAX_PADS = 50;
const FILE_TTL_HOURS = parsePositiveInt(process.env.FILE_TTL_HOURS, 72);
const FILE_TTL_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1h
const CONVERT_MAX_BYTES = parsePositiveInt(process.env.CONVERT_MAX_BYTES, 10 * 1024 * 1024); // 10MB
const CONVERT_TIMEOUT_MS = parsePositiveInt(process.env.CONVERT_TIMEOUT_MS, 60 * 1000); // 60s
const MAX_PASSWORD_LENGTH = 1024;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const MAX_WS_CONNECTIONS = 1000;
const MAX_WS_CONNECTIONS_PER_IP = 10;
// Per-connection patch rate limit. HTTP writes go through express-rate-limit
// (60/min); WS messages bypass Express, so we enforce an equivalent cap here.
const WS_PATCH_WINDOW_MS = parsePositiveInt(process.env.WS_PATCH_WINDOW_MS, 60 * 1000);
const MAX_WS_PATCHES_PER_WINDOW = parsePositiveInt(process.env.MAX_WS_PATCHES_PER_WINDOW, 120);

// Supported extensions for Markdown conversion
const CONVERTIBLE_EXTS = [
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'csv',
  'txt',
  'log',
  'html',
  'htm',
  'json',
  'xml',
  'yaml',
  'yml',
  'jpg',
  'jpeg',
  'png',
  'gif',
];

// Feature flags for conversion capabilities
const CONVERT_FEATURES = {
  pptx: true,
  imageMetadata: true,
  imageCaption: false,
  ocr: false,
};

// Session & Auth
const isProduction = process.env.NODE_ENV === 'production';
const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  (isProduction
    ? (() => {
        throw new Error('SESSION_SECRET env var is required in production');
      })()
    : require('crypto').randomBytes(32).toString('hex'));

const SESSION_TOKEN_TTL_DAYS = parsePositiveInt(process.env.SESSION_TOKEN_TTL_DAYS, 30);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const cookieFlags = isProduction
  ? 'HttpOnly; SameSite=Strict; Path=/; Secure'
  : 'HttpOnly; SameSite=Strict; Path=/';

module.exports = {
  PORT,
  DATA_DIR,
  FILES_DIR,
  STORE_FILE,
  SQLITE_FILE,
  MAX_FILE_BYTES,
  JSON_BODY_LIMIT,
  HEARTBEAT_INTERVAL_MS,
  UNLOCK_TOKEN_TTL_MS,
  MAX_PADS,
  FILE_TTL_HOURS,
  FILE_TTL_CHECK_INTERVAL_MS,
  CONVERT_MAX_BYTES,
  CONVERT_TIMEOUT_MS,
  MAX_PASSWORD_LENGTH,
  ADMIN_TOKEN,
  MAX_WS_CONNECTIONS,
  MAX_WS_CONNECTIONS_PER_IP,
  WS_PATCH_WINDOW_MS,
  MAX_WS_PATCHES_PER_WINDOW,
  CONVERTIBLE_EXTS,
  CONVERT_FEATURES,
  isProduction,
  SESSION_SECRET,
  SESSION_TOKEN_TTL_DAYS,
  PUBLIC_ORIGIN,
  cookieFlags,
};
