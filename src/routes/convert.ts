'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');
const { checkOrigin, requirePadUnlock } = require('../middlewares/security');
const { isAdmin } = require('../middlewares/auth');
const { requireWriteAccess } = require('../middlewares/writeAccess');

const convertLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many convert attempts.' },
});

function createRouter(convertService: any, padService: any, writeAccessService: any) {
  const router = express.Router();
  const writeGate = requireWriteAccess(writeAccessService);
  const convertPadUnlock = requirePadUnlock(padService, (req: any) => {
    const file = convertService.getFileById(req.params.fileId);
    return file ? file.padId : NaN;
  });

  // Get conversion capabilities
  router.get('/capabilities', (req: any, res: any) => {
    res.json(convertService.getCapabilities());
  });

  // Convert file to Markdown
  router.post(
    '/:fileId',
    convertLimiter,
    checkOrigin,
    writeGate,
    convertPadUnlock,
    async (req: any, res: any, next: any) => {
      try {
        const result = await convertService.convert(req.userId, isAdmin(req), req.params.fileId);
        res.json(result);
      } catch (e) {
        next(e);
      }
    }
  );

  return router;
}

module.exports = createRouter;
