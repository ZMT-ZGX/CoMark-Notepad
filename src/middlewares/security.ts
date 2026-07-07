'use strict';

// Only truthy when the operator explicitly set this env var (not the localhost default)
const EXPLICIT_PUBLIC_ORIGIN = process.env.PUBLIC_ORIGIN || null;

function isPrivateIp(hostname: string): boolean {
  // Strip IPv6-mapped IPv4 prefix (e.g. ::ffff:192.168.1.1)
  hostname = hostname.replace(/^::ffff:/i, '');
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') return true;
  const m = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1],
      b = +m[2];
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  // IPv6 unique local (fc00::/7 = fc00::/8 + fd00::/8) and link-local (fe80::/10)
  // NOTE: fc00::/7 occupies the first 7 bits 1111 110, so the second nibble is
  // either c or d. The original regex only matched fc00::/8, silently rejecting
  // the actually-assigned fd00::/8 range used by most LANs (CSRF 403 + WS 4400).
  if (/^f[cd][0-9a-f]/i.test(hostname) || /^fe80:/i.test(hostname)) return true;
  return false;
}

function isAllowedOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true;
  if (origin === 'null') return false;
  if (EXPLICIT_PUBLIC_ORIGIN) {
    // Explicit PUBLIC_ORIGIN: only that origin is allowed (no private-IP bypass)
    return origin === EXPLICIT_PUBLIC_ORIGIN;
  }
  try {
    const host = new URL(origin).hostname;
    if (isPrivateIp(host)) return true;
  } catch {}
  return false;
}

function extractOriginFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function checkOrigin(req: any, res: any, next: any): void {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') {
    return next();
  }
  const origin = req.headers.origin;
  if (origin) {
    if (isAllowedOrigin(origin)) return next();
  } else {
    // Exact match for /api/auth/register (browser register form sends no Origin/Referer initially)
    if (req.path === '/register' && req.baseUrl === '/api/auth') return next();
    const refererOrigin = extractOriginFromReferer(req.headers.referer);
    if (refererOrigin && isAllowedOrigin(refererOrigin)) return next();
  }
  return res.status(403).json({ error: 'Invalid origin' });
}

/**
 * Factory: returns middleware that checks pad lock (password-protected pads).
 * @param {object} padService - PadService instance
 * @param {function} [padIdResolver] - (req) => number. Defaults to Number(req.params.id)
 */
function requirePadUnlock(padService: any, padIdResolver?: (req: any) => number): (req: any, res: any, next: any) => void {
  return (req, res, next) => {
    const padId = padIdResolver ? padIdResolver(req) : Number(req.params.id);
    if (!Number.isInteger(padId) || padId <= 0) return next(); // let route handle validation
    const pad = padService.getPadById(padId);
    if (!pad || !pad.password) return next(); // no lock — proceed
    const token = req.headers['x-pad-token'] || (req.query && req.query.padToken);
    if (!padService.isValidUnlockToken(token, pad.id)) {
      return res.status(403).json({ error: 'Pad locked', hasPassword: true });
    }
    next();
  };
}

module.exports = {
  checkOrigin,
  requirePadUnlock,
  isAllowedOrigin,
  isPrivateIp,
};
