'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin } = require('../middlewares/security');
const { isAdmin } = require('../middlewares/auth');
const { UnauthorizedError, ForbiddenError } = require('../utils/errors');
const { validate } = require('../middlewares/validate');
const { RedeemPassphraseSchema } = require('../validators/writeAccess');

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many passphrase attempts.' },
});

/**
 * Write-access gate endpoints (mounted at /api/write-access):
 *   GET    /status    — current status for the caller
 *   POST   /redeem    — exchange a passphrase for a time-limited grant
 *   DELETE /release   — give up your own grant
 */
function createWriteAccessRouter(writeAccessService: any) {
  const router = express.Router();

  router.get('/status', (req: any, res: any) => {
    res.json({
      gated: writeAccessService.gated,
      mode: writeAccessService.modeOf(),
      writeAccess: writeAccessService.status(req.userId || null, isAdmin(req)),
    });
  });

  // The phrase is only ever compared in constant time — never stored, echoed
  // back, or logged.
  router.post(
    '/redeem',
    redeemLimiter,
    checkOrigin,
    validate(RedeemPassphraseSchema),
    (req: any, res: any, next: any) => {
      try {
        if (!req.userId) throw UnauthorizedError('Authentication required');
        const result = writeAccessService.redeem(req.userId, req.body.passphrase);
        if (!result.ok) {
          return res.status(403).json({ error: 'Invalid passphrase', code: 'INVALID_PASSPHRASE' });
        }
        res.json({ ok: true, writeAccess: result.status });
      } catch (e) {
        next(e);
      }
    }
  );

  router.delete('/release', checkOrigin, (req: any, res: any, next: any) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      writeAccessService.revoke(req.userId);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

/**
 * Member management (mounted at /api/members, admin only):
 *   GET    /                  — members and their write grants
 *   POST   /:code/write       — grant permanent write access
 *   DELETE /:code/write       — revoke write access
 *
 * Trust is granted per user code rather than through a shared permanent
 * passphrase: same convenience (no re-entry), but revocable per person,
 * auditable, and with no secret that leaks permanently.
 */
function createMembersRouter(writeAccessService: any, store: any) {
  const router = express.Router();

  router.get('/', (req: any, res: any, next: any) => {
    try {
      if (!isAdmin(req)) throw ForbiddenError('Admin token required');
      res.json({ members: writeAccessService.list() });
    } catch (e) {
      next(e);
    }
  });

  router.post('/:code/write', checkOrigin, (req: any, res: any, next: any) => {
    try {
      if (!isAdmin(req)) throw ForbiddenError('Admin token required');
      if (!store.userExists(req.params.code)) throw UnauthorizedError('Unknown member');
      const grant = writeAccessService.grantTrusted(req.params.code, req.userId || null);
      res.json({ ok: true, grant });
    } catch (e) {
      next(e);
    }
  });

  router.delete('/:code/write', checkOrigin, (req: any, res: any, next: any) => {
    try {
      if (!isAdmin(req)) throw ForbiddenError('Admin token required');
      res.json({ ok: true, revoked: writeAccessService.revoke(req.params.code) });
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = { createWriteAccessRouter, createMembersRouter };
