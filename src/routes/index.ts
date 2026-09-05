'use strict';

const rateLimit = require('express-rate-limit');
const { checkOrigin, extractPadTokens } = require('../middlewares/security');
const { requireWriteAccess } = require('../middlewares/writeAccess');

const createAuthRouter = require('./auth');
const createPadsRouter = require('./pads');
const createFilesRouter = require('./files');
const createInvitationsRouter = require('./invitations');
const createConvertRouter = require('./convert');
const createHealthRouter = require('./health');
const { createWriteAccessRouter, createMembersRouter } = require('./writeAccess');

const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads.' },
});

function mountRoutes(
  app: any,
  services: any,
  getServerPort: (() => number) | null,
  getPadClients: (padId: number) => Set<any> | undefined
) {
  const { store, db, padService, fileService, inviteService, convertService, writeAccessService } =
    services;
  const writeGate = requireWriteAccess(writeAccessService);

  // Routers take the store facade, never the raw db modules (AGENTS.md).
  app.use('/api/auth', createAuthRouter(store));

  // Global state endpoint (mounted at /api, not /api/pads)
  app.get('/api/state', async (req: any, res: any, next: any) => {
    try {
      // Unlock tokens (header only) gate file metadata of password-protected pads.
      const state = await padService.getState(req.userId, extractPadTokens(req));
      res.json(state);
    } catch (e) {
      if (res.headersSent) return;
      next(e);
    }
  });

  // Upload endpoint (mounted at /api/upload, not /api/files/upload).
  // Not part of any router, so the write gate has to be applied explicitly here.
  app.post(
    '/api/upload',
    uploadLimiter,
    checkOrigin,
    writeGate,
    async (req: any, res: any, next: any) => {
      try {
        await fileService.upload(req, res);
      } catch (e) {
        if (res.headersSent) return;
        next(e);
      }
    }
  );

  app.use('/api/pads', createPadsRouter(padService, getPadClients, writeAccessService));
  app.use('/api/files', createFilesRouter(fileService, padService, writeAccessService));
  app.use('/api/invitations', createInvitationsRouter(inviteService, writeAccessService));
  app.use('/api/convert', createConvertRouter(convertService, padService, writeAccessService));
  app.use('/api/write-access', createWriteAccessRouter(writeAccessService));
  app.use('/api/members', createMembersRouter(writeAccessService, store));
  app.use('/api', createHealthRouter(db, getServerPort));
}

module.exports = { mountRoutes };
