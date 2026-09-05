'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin } = require('../middlewares/security');
const { UnauthorizedError } = require('../utils/errors');
const { generateUserCode, signSessionToken, verifySessionToken } = require('../utils/crypto');
const session = require('../auth/session');
const { SESSION_TOKEN_TTL_DAYS, cookieFlags } = require('../config');
const { validate } = require('../middlewares/validate');
const { RegisterSchema, VerifySchema, UpdateProfileSchema } = require('../validators/auth');

const registerLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts.' },
});

// Receives the store facade (not the raw db modules) — AGENTS.md forbids
// route handlers from touching `db` directly.
function createRouter(store: any) {
  const router = express.Router();

  router.post(
    '/register',
    registerLimiter,
    checkOrigin,
    validate(RegisterSchema),
    (req: any, res: any) => {
      let code;
      let attempts = 0;
      do {
        code = generateUserCode();
        attempts++;
      } while (store.userExists(code) && attempts < 10);
      if (store.userExists(code)) {
        return res.status(500).json({ error: 'Failed to generate unique user code' });
      }
      store.createUser({
        code,
        createdAt: Date.now(),
        displayName: typeof req.body?.displayName === 'string' ? req.body.displayName : null,
      });

      const requested = req.body.expiresInDays;
      const expiresInDays =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), SESSION_TOKEN_TTL_DAYS)
          : SESSION_TOKEN_TTL_DAYS;

      const token = signSessionToken(code, expiresInDays);
      res.setHeader(
        'Set-Cookie',
        `session_token=${token}; ${cookieFlags}; Max-Age=${expiresInDays * 86400}`
      );
      // Do not echo the raw token in the response body — it is delivered via
      // HttpOnly cookie only, which prevents XSS-based token theft.
      res.json({ code, expiresInDays });
    }
  );

  router.post('/verify', checkOrigin, validate(VerifySchema), (req: any, res: any) => {
    const { token } = req.body;
    const userId = session.verify(token);
    if (userId && store.userExists(userId)) {
      res.json({ valid: true, code: userId });
    } else {
      res.json({ valid: false });
    }
  });

  router.get('/me', (req: any, res: any, next: any) => {
    try {
      if (!req.userId) throw UnauthorizedError('Not authenticated');
      const user = store.findUserByCode(req.userId);
      res.json({
        code: req.userId,
        displayName: user ? user.displayName : null,
      });
    } catch (e) {
      next(e);
    }
  });

  // Set or clear your display name. Shown in the member list and (later)
  // alongside presence cursors, so a team can tell who is who.
  router.patch(
    '/me',
    checkOrigin,
    validate(UpdateProfileSchema),
    (req: any, res: any, next: any) => {
      try {
        if (!req.userId) throw UnauthorizedError('Not authenticated');
        const { displayName } = req.body;
        store.setUserDisplayName(req.userId, displayName ?? null);
        res.json({ ok: true, code: req.userId, displayName: displayName ?? null });
      } catch (e) {
        next(e);
      }
    }
  );

  router.post('/logout', checkOrigin, (req: any, res: any) => {
    const { parseCookies } = require('../middlewares/auth');
    const cookies = parseCookies(req.headers.cookie || '');
    const cookieToken = cookies['session_token'];
    const headerToken = req.headers['x-session-token'];
    const nowSec = Date.now() / 1000;
    const ttl = SESSION_TOKEN_TTL_DAYS * 86400;

    // Only revoke tokens that carry a valid HMAC signature. An unsigned or
    // forged string would just insert garbage into the revoked_tokens table,
    // gradually inflating it with every unauthenticated POST /logout request.
    if (cookieToken && verifySessionToken(cookieToken))
      session.revokeToken(cookieToken, nowSec + ttl);
    if (headerToken && typeof headerToken === 'string' && verifySessionToken(headerToken))
      session.revokeToken(headerToken, nowSec + ttl);

    res.setHeader('Set-Cookie', `session_token=; ${cookieFlags}; Max-Age=0`);
    res.json({ ok: true });
  });

  return router;
}

module.exports = createRouter;
