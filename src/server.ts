'use strict';

import type { Services } from './types';

const http = require('http');
const path = require('path');
const QRCode = require('qrcode');

const { PORT, FILE_TTL_HOURS, FILE_TTL_CHECK_INTERVAL_MS } = require('./config');
const logger = require('./utils/logger');
const { getLanIP, safeUnlink } = require('./utils/file');
const db = require('./db');
const { createDataStore } = require('./store');
const session = require('./auth/session');
const { createApp } = require('./app');
const { initWSS } = require('./ws');
const broadcast = require('./ws/broadcast');
const { safeClose } = require('./ws/close');
const PadService = require('./services/padService');
const FileService = require('./services/fileService');
const InviteService = require('./services/inviteService');
const ConvertService = require('./services/convertService');
const WriteAccessService = require('./services/writeAccessService');

async function start() {
  // 1. Open SQLite database (backward-compat method name from JSON store era)
  await db.store.load();

  // 2. Migrate store format (if needed)
  await db.migrate.run();

  // 3. Init user index
  db.users.init();

  // 4. Restore revoked tokens from store
  session.restoreFromStore();

  // 5. Create unified data-access facade (services depend on this, not raw db)
  const dataStore = createDataStore(db);

  // 6. Create Service instances (DI: inject store + broadcast + connections)
  const connections = require('./ws/connections');
  const padService = new PadService(dataStore, broadcast, connections.getPadClients);
  const fileService = new FileService(dataStore, broadcast, padService);
  const inviteService = new InviteService(dataStore, broadcast, connections.getPadClients);
  const convertService = new ConvertService(dataStore, broadcast);
  const writeAccessService = new WriteAccessService(dataStore, require('./config'));

  const services: Services = {
    store: dataStore,
    db,
    padService,
    fileService,
    inviteService,
    convertService,
    writeAccessService,
  };

  // 6. Create Express app
  const app = createApp(services, getServerPort, connections.getPadClients);

  // 7. Create HTTP server
  const server = http.createServer(app);

  // 8. Init WebSocket
  const { wss, heartbeatTimer } = initWSS(server, padService, writeAccessService);

  // --- Helpers ---
  function getServerPort() {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : PORT;
  }

  // --- File TTL cleanup ---
  // Deletes files past their TTL that are not referenced by any pad body
  // (see db/files.ts findExpired). Unlinking is awaited concurrently via
  // fs.promises — a batch of expired files must not stall the event loop
  // with synchronous disk I/O.
  async function cleanupExpiredFiles() {
    const ttlMs = FILE_TTL_HOURS * 3600000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    // Drain the debounced derived-index flush first: the reference junction
    // rides the same flush as the search index, and the sweep must never act
    // on edges that trail a just-written body (a reference added within the
    // debounce window still protects its file).
    db.pads.flushSearchSyncNow();
    const expired = db.files.removeExpired(ttlMs);
    if (expired.length === 0) return;
    await Promise.all(
      expired.map((file: { filename: string }) =>
        safeUnlink(path.join(db.FILES_DIR, file.filename))
      )
    );
    const defaultPadId = db.pads.findAllMeta()[0]?.id;
    for (const file of expired) {
      const filePadId = file.padId || defaultPadId;
      if (filePadId == null) continue;
      broadcast.toPad(filePadId, { type: 'file-deleted', padId: filePadId, fileId: file.id });
    }
    logger.info(`Cleaned up ${expired.length} expired file(s) (TTL=${FILE_TTL_HOURS}h)`);
  }

  const fileTtlTimer = setInterval(
    () =>
      cleanupExpiredFiles().catch((err: Error) => logger.warn({ err }, 'File TTL cleanup failed')),
    FILE_TTL_CHECK_INTERVAL_MS
  );
  fileTtlTimer.unref?.();

  // --- Graceful shutdown ---
  // A throw from an async side task (SQLITE_BUSY during the hourly TTL sweep,
  // a failing unlink) must not take the instance down: rejections from the
  // timers above are caught at their source, and anything that slips through
  // is logged here. An uncaughtException is different — synchronous state is
  // no longer trusted, so it goes through the same drain but exits non-zero.
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  let shuttingDown = false;
  function gracefulShutdown(signal: string, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down...`);
    clearInterval(heartbeatTimer);
    clearInterval(fileTtlTimer);
    clearInterval(padService.getCleanupTimer());
    clearInterval(session.getCleanupTimer());

    // Persist any FTS refreshes the throttle still held in memory so search
    // is not stale until the next boot-time rebuild. Runs while the database
    // is still open — the close itself happens after the drain below.
    try {
      db.pads.flushSearchSyncNow();
    } catch (err) {
      logger.error({ err }, 'FTS flush on shutdown failed');
    }

    // Close all WebSocket connections
    try {
      for (const client of wss.clients) {
        safeClose(client, 1001, 'Server shutting down');
      }
    } catch {}

    server.close(() => {
      // Close SQLite only after the drain: requests still in flight during
      // the close window must not find the database already shut.
      try {
        db.store.flushSync();
      } catch (err) {
        logger.error({ err }, 'SQLite close on shutdown failed');
      }
      logger.info('Server closed.');
      process.exit(exitCode);
    });
    // Idle keep-alive sockets would otherwise hold server.close() open until
    // the hard timeout; dropping them lets the drain finish immediately.
    (server as any).closeIdleConnections?.();
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('uncaughtException', (err: Error) => {
    logger.error({ err }, 'Uncaught exception, shutting down');
    gracefulShutdown('uncaughtException', 1);
  });

  server.on('close', () => {
    clearInterval(heartbeatTimer);
    clearInterval(fileTtlTimer);
    clearInterval(padService.getCleanupTimer());
    clearInterval(session.getCleanupTimer());
  });

  // --- Start listening ---
  const lanIP = getLanIP();

  server.listen(PORT, '0.0.0.0', async () => {
    const currentPort = getServerPort();
    const url = `http://${lanIP}:${currentPort}`;

    // Initial TTL cleanup run
    cleanupExpiredFiles().catch((err: Error) =>
      logger.warn({ err }, 'Initial file TTL cleanup failed')
    );

    // Startup info
    logger.info('CoMark-Notepad is running!');
    logger.info(`  Local:   http://localhost:${currentPort}`);
    logger.info(`  Network: ${url}`);
    const padCount = db.pads.count();
    logger.info(`  Pads:    ${padCount}`);

    // NOTE: this reads process.env directly rather than the exported
    // PUBLIC_ORIGIN, which falls back to http://localhost:<port> and is
    // therefore always truthy — checking it would make the warning dead code.
    const { isProduction, productionConfigWarnings } = require('./config');
    if (isProduction) {
      for (const warning of productionConfigWarnings()) {
        logger.warn(warning);
      }
      // Legacy public pads: fresh installs start with zero pads, but a
      // database from before that change can still carry the always-seeded
      // Pad #1 (owner_user_id=NULL) — readable AND writable-file-manageable
      // by every registered user on a public deployment. Deletion is the
      // operator's call (their content), so surface it instead of migrating
      // silently.
      const publicPads = db.pads
        .findAllMeta()
        .filter(
          (p: { ownerUserId: string | null; creatorCode: string | null }) =>
            !p.ownerUserId && !p.creatorCode
        );
      if (publicPads.length > 0) {
        logger.warn(
          { padIds: publicPads.map((p: { id: number }) => p.id) },
          'Public pad(s) detected (no owner): on a public deployment every registered user ' +
            'can read them and manage unowned uploads. Delete them via the admin API, or ' +
            'set a pad password to lock them, if this is not intended.'
        );
      }
    }

    try {
      const qr = await QRCode.toString(url, { type: 'terminal', small: true });
      logger.info(`Scan QR code to connect from phone:\n${qr}`);
    } catch {}
  });

  return server;
}

start().catch((err) => {
  logger.error({ err }, 'Failed to start server');
  process.exit(1);
});
