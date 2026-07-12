'use strict';

import type { CoMarkWebSocket } from '../types';
const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin, requirePadUnlock, extractPadTokens } = require('../middlewares/security');
const { isAdmin } = require('../middlewares/auth');
const { BadRequestError } = require('../utils/errors');
const { validate } = require('../middlewares/validate');
const { UpdateTextSchema, SetPasswordSchema, UnlockSchema } = require('../validators/pads');

const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
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

const publicPadCreateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skip: (req: any) => !!req.userId,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many public pad creations.' },
});

function createRouter(
  padService: any,
  getPadClients: (padId: number) => Set<CoMarkWebSocket> | undefined
) {
  const router = express.Router();
  const padUnlock = requirePadUnlock(padService);

  // Get pad content
  router.get('/:id', padUnlock, async (req: any, res: any, next: any) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
      const pad = await padService.getPad(req.userId, padId);
      res.json({
        id: pad.id,
        text: pad.text,
        textVersion: pad.textVersion,
        hasPassword: !!pad.password,
      });
    } catch (e) {
      next(e);
    }
  });

  // Update pad text (PUT for normal sync; POST alias for navigator.sendBeacon)
  const updatePadText = async (req: any, res: any, next: any) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
      const { text, _wsId, baseVersion } = req.body;
      const updated = await padService.updateText(
        req.userId,
        padId,
        text,
        _wsId,
        baseVersion ?? null
      );
      if (updated && updated.conflict) {
        return res
          .status(409)
          .json({ conflict: true, text: updated.pad.text, textVersion: updated.pad.textVersion });
      }
      res.json({ ok: true, textVersion: updated.textVersion });
    } catch (e) {
      next(e);
    }
  };

  router.put(
    '/:id/text',
    writeLimiter,
    checkOrigin,
    padUnlock,
    validate(UpdateTextSchema),
    updatePadText
  );
  router.post(
    '/:id/text',
    writeLimiter,
    checkOrigin,
    padUnlock,
    validate(UpdateTextSchema),
    updatePadText
  );

  // Create new pad
  router.post('/', publicPadCreateLimiter, checkOrigin, async (req: any, res: any, next: any) => {
    try {
      const pad = await padService.createPad(req.userId);
      res.json({
        id: pad.id,
        text: '',
        textVersion: 0,
        hasPassword: false,
        ownerUserId: pad.ownerUserId,
      });
    } catch (e) {
      next(e);
    }
  });

  // Set/change/remove pad password
  router.post(
    '/:id/password',
    unlockLimiter,
    checkOrigin,
    validate(SetPasswordSchema),
    async (req: any, res: any, next: any) => {
      try {
        const padId = Number(req.params.id);
        if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
        // Match any of the comma-separated unlock tokens for THIS pad.
        const tokens = extractPadTokens(req);
        const unlockToken =
          tokens.find((t: string) => padService.isValidUnlockToken(t, padId)) || tokens[0] || null;
        const { password, currentPassword, _wsId } = req.body;
        const result = await padService.setPassword(
          req.userId,
          isAdmin(req),
          padId,
          password,
          currentPassword,
          unlockToken,
          _wsId
        );
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  // Delete pad (owner/admin can delete even without unlock token)
  router.delete('/:id', checkOrigin, async (req: any, res: any, next: any) => {
    try {
      const padId = Number(req.params.id);
      if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');

      const result = await padService.deletePad(req.userId, isAdmin(req), padId);

      // Disconnect AFTER successful deletion
      const deletedClients = getPadClients(padId);
      if (deletedClients) {
        for (const ws of Array.from(deletedClients) as CoMarkWebSocket[]) {
          try {
            ws.close(4404, 'Pad deleted');
          } catch {}
        }
      }

      res.json(result);
    } catch (e) {
      next(e);
    }
  });

  // Unlock pad (verify password)
  router.post(
    '/:id/unlock',
    unlockLimiter,
    checkOrigin,
    validate(UnlockSchema),
    async (req: any, res: any, next: any) => {
      try {
        const padId = Number(req.params.id);
        if (!Number.isInteger(padId) || padId <= 0) throw BadRequestError('Invalid pad ID');
        await padService.getPad(req.userId, padId); // access check
        const result = await padService.unlockPad(padId, req.body.password);
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  return router;
}

module.exports = createRouter;
