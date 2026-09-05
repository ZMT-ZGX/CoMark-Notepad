'use strict';

const path = require('path');

// Parse an env var as a positive integer, falling back when unset, non-numeric,
// or non-positive. Guards against NaN silently disabling rate-limit logic.
function parsePositiveInt(value: string | undefined, fallback: number): number {
  const num = value != null ? parseInt(String(value), 10) : NaN;
  return Number.isInteger(num) && num > 0 ? num : fallback;
}

// Like parsePositiveInt but accepts 0, which is meaningful for TRUST_PROXY_HOPS
// (0 = no reverse proxy, trust the socket address directly).
function parseNonNegativeInt(value: string | undefined, fallback: number): number {
  const num = value != null ? parseInt(String(value), 10) : NaN;
  return Number.isInteger(num) && num >= 0 ? num : fallback;
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
const CONVERT_MAX_BYTES = parsePositiveInt(process.env.CONVERT_MAX_BYTES, 100 * 1024 * 1024); // 100MB

// Aggregate storage caps. The per-file ceiling above bounds ONE upload, but
// nothing bounded the TOTAL: a single account could upload 100MB files
// repeatedly and — because unreferenced files survive up to FILE_TTL_HOURS —
// fill the disk, at which point SQLite writes start failing and the whole
// instance goes down. Defaults leave ample headroom for a self-hosted team.
const MAX_STORAGE_BYTES = parsePositiveInt(process.env.MAX_STORAGE_BYTES, 2 * 1024 * 1024 * 1024); // 2GB instance-wide
const MAX_STORAGE_BYTES_PER_USER = parsePositiveInt(
  process.env.MAX_STORAGE_BYTES_PER_USER,
  512 * 1024 * 1024
); // 512MB per account
const CONVERT_TIMEOUT_MS = parsePositiveInt(process.env.CONVERT_TIMEOUT_MS, 60 * 1000); // 60s
// Peak conversion memory is CONVERT_MAX_CONCURRENT x CONVERT_WORKER_HEAP_MB and
// must fit inside the container memory limit next to the main process. Both are
// env-tunable so a small VPS can trade throughput for headroom instead of being
// OOM-killed mid-conversion; the defaults preserve the historical behaviour.
const CONVERT_MAX_CONCURRENT = parsePositiveInt(process.env.CONVERT_MAX_CONCURRENT, 3);
const CONVERT_WORKER_HEAP_MB = parsePositiveInt(process.env.CONVERT_WORKER_HEAP_MB, 512);
const MAX_PASSWORD_LENGTH = 1024;
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;
const MAX_WS_CONNECTIONS = parsePositiveInt(process.env.MAX_WS_CONNECTIONS, 1000);
// Per-IP cap guards against a single client exhausting the pool. Env-tunable so
// test harnesses (which drive many browser contexts from 127.0.0.1) can raise it.
const MAX_WS_CONNECTIONS_PER_IP = parsePositiveInt(process.env.MAX_WS_CONNECTIONS_PER_IP, 10);
// Per-connection patch rate limit. HTTP writes go through express-rate-limit
// (60/min); WS messages bypass Express, so we enforce an equivalent cap here.
const WS_PATCH_WINDOW_MS = parsePositiveInt(process.env.WS_PATCH_WINDOW_MS, 60 * 1000);
const MAX_WS_PATCHES_PER_WINDOW = parsePositiveInt(process.env.MAX_WS_PATCHES_PER_WINDOW, 120);
// How long a pad's FTS row may lag behind its body before the throttled sync
// refreshes the trigram index. The pads row itself is written synchronously on
// every edit (durability is unchanged); only the expensive trigram re-tokenize
// is deferred, so a keystroke burst costs one reindex instead of one per char.
const FTS_SYNC_DEBOUNCE_MS = parsePositiveInt(process.env.FTS_SYNC_DEBOUNCE_MS, 1200);
// Number of reverse-proxy hops to trust for X-Forwarded-For. Single source of
// truth for `app.set('trust proxy', ...)`; app.ts must read it from here rather
// than process.env so a malformed value falls back instead of silently
// disabling client-IP resolution.
const TRUST_PROXY_HOPS = parseNonNegativeInt(process.env.TRUST_PROXY_HOPS, 0);

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
const SESSION_SECRET = (() => {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (isProduction) {
    throw new Error('SESSION_SECRET env var is required in production');
  }
  // Dev convenience: persist a stable secret so login sessions survive a
  // server restart. Without this, every reboot regenerates the HMAC key and
  // invalidates all session cookies (users get logged out and then hit
  // "Access denied" when deleting files they own).
  try {
    const fs = require('fs');
    const secretFile = path.join(DATA_DIR, '.session_secret');
    // Reuse an existing secret if one was already persisted. Guard with
    // existsSync so a missing file (first run) doesn't throw ENOENT and skip
    // the write below — that bug meant the secret was never actually persisted
    // and every restart logged users out.
    if (fs.existsSync(secretFile)) {
      const existing = fs.readFileSync(secretFile, 'utf8').trim();
      if (existing) return existing;
    }
    // First run: generate and persist. config is evaluated before the store
    // creates DATA_DIR, so ensure it exists first.
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const generated = require('crypto').randomBytes(32).toString('hex');
    // 0600 so the HMAC signing key is not world-/group-readable on shared hosts.
    fs.writeFileSync(secretFile, generated, { mode: 0o600 });
    console.error('[config] persisted SESSION_SECRET to', secretFile);
    return generated;
  } catch (e) {
    console.error(
      '[config] failed to persist SESSION_SECRET:',
      e instanceof Error ? e.message : String(e)
    );
    return require('crypto').randomBytes(32).toString('hex');
  }
})();

const SESSION_TOKEN_TTL_DAYS = parsePositiveInt(process.env.SESSION_TOKEN_TTL_DAYS, 30);

// ── Write access gate ────────────────────────────────────────────────
// 'open'  — legacy behaviour: any visitor may edit. Correct for LAN / single
//           user installs, and keeps existing tests and local dev working.
// 'gated' — visitors are read-only until they hold a write grant (redeemed
//           passphrase or admin-granted trusted member). Required for any
//           publicly reachable deployment, because /api/auth/register needs no
//           credentials at all.
const WRITE_ACCESS_MODE: 'open' | 'gated' =
  process.env.WRITE_ACCESS_MODE === 'gated' ? 'gated' : 'open';

// WebSocket origin gating. Browsers always send an `Origin` header on the WS
// handshake, so a missing Origin identifies a non-browser client. Treating
// "no Origin" as allowed is a fail-open default that lets any unidentified
// client into a pad room, so fail closed unless the operator opts in (needed
// only for scripted/CLI clients that do not send the header).
const WS_ALLOW_NO_ORIGIN = process.env.WS_ALLOW_NO_ORIGIN === 'true';

// Write passphrases, comma separated: `<phrase>[:<days>]`. `:0` (or an omitted
// suffix) uses WRITE_GRANT_TTL_DAYS; a positive suffix overrides it per phrase.
// Compared in constant time and never logged — see writeAccessService.
const WRITE_PASSPHRASES: string[] = (process.env.WRITE_PASSPHRASES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const WRITE_GRANT_TTL_DAYS = parsePositiveInt(process.env.WRITE_GRANT_TTL_DAYS, 7);
// Sliding renewal threshold: a grant whose remaining life drops below this is
// pushed back to a full TTL on the next write, so an actively used grant never
// lapses mid-sentence.
const WRITE_GRANT_RENEW_THRESHOLD_DAYS = parsePositiveInt(
  process.env.WRITE_GRANT_RENEW_THRESHOLD_DAYS,
  5
);
const PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || `http://localhost:${PORT}`;
const cookieFlags = isProduction
  ? 'HttpOnly; SameSite=Strict; Path=/; Secure'
  : 'HttpOnly; SameSite=Strict; Path=/';

// Misconfigurations that are survivable but wrong for a self-hosted install.
// Warn instead of throwing: a boot loop is strictly worse than a degraded
// posture, and an operator reading the log can act on a warning. Only runs in
// production so dev and test (which deliberately leave these unset) stay quiet.
function productionConfigWarnings(): string[] {
  const warnings: string[] = [];
  const rawOrigin = process.env.PUBLIC_ORIGIN;

  if (!rawOrigin) {
    warnings.push(
      'PUBLIC_ORIGIN is not set. Origin-based CSRF checks will accept any localhost/LAN origin. Set it to your public URL, e.g. https://notepad.example.com'
    );
  } else {
    let origin: URL | null = null;
    try {
      origin = new URL(rawOrigin);
    } catch {
      warnings.push(
        `PUBLIC_ORIGIN (${rawOrigin}) is not a valid URL. CSRF origin checks will never match.`
      );
    }
    if (origin) {
      const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(origin.hostname);
      if (origin.protocol === 'http:' && !isLoopback) {
        warnings.push(
          `PUBLIC_ORIGIN is plain http (${rawOrigin}) but production session cookies are sent with the Secure flag. Browsers will drop the cookie and login will appear to do nothing. Terminate TLS at the reverse proxy and set PUBLIC_ORIGIN to the https URL.`
        );
      }
    }
  }

  if (TRUST_PROXY_HOPS === 0) {
    warnings.push(
      'TRUST_PROXY_HOPS is 0, so client IPs come from the socket address. Behind a reverse proxy every request looks like it comes from the proxy, which collapses the HTTP rate limiter and the per-IP WebSocket cap into a single shared bucket. Set TRUST_PROXY_HOPS=1 when running behind Caddy/Nginx.'
    );
  }

  if (!ADMIN_TOKEN) {
    warnings.push(
      'ADMIN_TOKEN is not set. Administrative pad management is disabled; set it if you need break-glass admin access.'
    );
  }

  if (SESSION_SECRET.length < 32) {
    warnings.push(
      'SESSION_SECRET is shorter than 32 characters. Session cookies are HMAC-signed with it; generate one with `openssl rand -hex 32`.'
    );
  }

  if (WRITE_ACCESS_MODE === 'open') {
    warnings.push(
      'WRITE_ACCESS_MODE is "open": anyone who can reach this instance can register an identity (no credentials required) and edit every public pad, including deleting files uploaded by others. Set WRITE_ACCESS_MODE=gated if this instance is reachable from the public internet.'
    );
  } else if (WRITE_PASSPHRASES.length === 0 && !ADMIN_TOKEN) {
    warnings.push(
      'WRITE_ACCESS_MODE is "gated" but neither WRITE_PASSPHRASES nor ADMIN_TOKEN is set, so nobody can obtain write access. Configure at least one, or grant a trusted member via the admin API.'
    );
  }

  return warnings;
}

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
  MAX_STORAGE_BYTES,
  MAX_STORAGE_BYTES_PER_USER,
  CONVERT_TIMEOUT_MS,
  CONVERT_MAX_CONCURRENT,
  CONVERT_WORKER_HEAP_MB,
  MAX_PASSWORD_LENGTH,
  ADMIN_TOKEN,
  MAX_WS_CONNECTIONS,
  WS_ALLOW_NO_ORIGIN,
  MAX_WS_CONNECTIONS_PER_IP,
  WS_PATCH_WINDOW_MS,
  MAX_WS_PATCHES_PER_WINDOW,
  FTS_SYNC_DEBOUNCE_MS,
  TRUST_PROXY_HOPS,
  CONVERTIBLE_EXTS,
  CONVERT_FEATURES,
  isProduction,
  SESSION_SECRET,
  SESSION_TOKEN_TTL_DAYS,
  PUBLIC_ORIGIN,
  cookieFlags,
  WRITE_ACCESS_MODE,
  WRITE_PASSPHRASES,
  WRITE_GRANT_TTL_DAYS,
  WRITE_GRANT_RENEW_THRESHOLD_DAYS,
  productionConfigWarnings,
};
