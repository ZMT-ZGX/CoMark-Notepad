'use strict';

import type WriteAccessService = require('../services/writeAccessService');

const { isAdmin } = require('../middlewares/auth');

/**
 * Denies every write when the deployment is gated and the caller holds no
 * valid grant. Returns a stable `code` so the client can react by prompting
 * for a passphrase instead of showing a generic error.
 *
 * Admins bypass the gate: they already hold a separate break-glass credential
 * (ADMIN_TOKEN) and are the only ones who can grant access in the first place.
 *
 * Takes only the service: the admin check is resolved per-request from
 * X-Admin-Token internally, so routers construct the gate as
 * `requireWriteAccess(writeAccessService)` — one argument, no data clump.
 */
function requireWriteAccess(writeAccessService: WriteAccessService) {
  return (req: any, res: any, next: any) => {
    const status = writeAccessService.status(req.userId || null, isAdmin(req));
    if (!status.allowed) {
      return res.status(403).json({
        error: 'Write access required',
        code: 'WRITE_REQUIRED',
        gated: writeAccessService.gated,
      });
    }
    // Sliding renewal for time-limited grants — reuses the status already in
    // hand; no second write_grants query per request.
    writeAccessService.renewFromStatus(req.userId || null, status);
    next();
  };
}

module.exports = { requireWriteAccess };
