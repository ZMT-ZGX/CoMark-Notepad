'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { checkOrigin } = require('../middlewares/security');
const { UnauthorizedError } = require('../utils/errors');
const { validate } = require('../middlewares/validate');
const { CreateInvitationSchema, RedeemInvitationSchema } = require('../validators/invitations');

const redeemLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many redeem attempts.' },
});

const inviteCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  keyGenerator: (req: any) => req.userId || ipKeyGenerator(req.ip || req.socket.remoteAddress || ''),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many invitations created.' },
});

function createRouter(inviteService: any) {
  const router = express.Router();

  // Create invitation
  router.post(
    '/',
    inviteCreateLimiter,
    checkOrigin,
    validate(CreateInvitationSchema),
    async (req: any, res: any, next: any) => {
      try {
        if (!req.userId) throw UnauthorizedError('Authentication required');
        const { maxUses, expiresInHours = 0 } = req.body;

        const result = await inviteService.create(req.userId, maxUses, expiresInHours);
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  // Redeem invitation
  router.post(
    '/redeem',
    redeemLimiter,
    checkOrigin,
    validate(RedeemInvitationSchema),
    async (req: any, res: any, next: any) => {
      try {
        if (!req.userId) throw UnauthorizedError('Authentication required');
        const { token } = req.body;

        const result = await inviteService.redeem(req.userId, token);
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  // List invitations
  router.get('/', async (req: any, res: any, next: any) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      const result = await inviteService.list(req.userId);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Delete invitation
  router.delete('/:token', checkOrigin, async (req: any, res: any, next: any) => {
    try {
      if (!req.userId) throw UnauthorizedError('Authentication required');
      const result = await inviteService.delete(req.userId, req.params.token);
      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  return router;
}

module.exports = createRouter;
