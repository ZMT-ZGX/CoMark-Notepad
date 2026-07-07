'use strict';

import type { Services } from './types';

const http = require('http');
const fs = require('fs');
const path = require('path');
const QRCode = require('qrcode');

const { PORT, FILE_TTL_HOURS, FILE_TTL_CHECK_INTERVAL_MS } = require('./config');
const logger = require('./utils/logger');
const { getLanIP } = require('./utils/file');
const db = require('./db');
const { createDataStore } = require('./store');
const session = require('./auth/session');
const { createApp } = require('./app');
const { initWSS } = require('./ws');
const broadcast = require('./ws/broadcast');
const PadService = require('./services/padService');
const FileService = require('./services/fileService');
const InviteService = require('./services/inviteService');
const ConvertService = require('./services/convertService');

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

  const services: Services = { db, padService, fileService, inviteService, convertService };

  // 6. Create Express app
  const app = createApp(services, getServerPort, connections.getPadClients);

  // 7. Create HTTP server
  const server = http.createServer(app);

  // 8. Init WebSocket
  const { wss, heartbeatTimer } = initWSS(server, padService);

  // --- Helpers ---
  function getServerPort() {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : PORT;
  }

  // --- File TTL cleanup ---
  function cleanupExpiredFiles() {
    const ttlMs = FILE_TTL_HOURS * 3600000;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const expired = db.files.removeExpired(ttlMs);
    if (expired.length === 0) return;
    for (const file of expired) {
      try {
        fs.unlinkSync(path.join(db.FILES_DIR, file.filename));
      } catch {}
    }
    const defaultPadId = db.pads.findAll()[0]?.id || 1;
    for (const file of expired) {
      const filePadId = file.padId || defaultPadId;
      broadcast.toPad(filePadId, { type: 'file-deleted', padId: filePadId, fileId: file.id });
    }
    logger.info(`Cleaned up ${expired.length} expired file(s) (TTL=${FILE_TTL_HOURS}h)`);
  }

  const fileTtlTimer = setInterval(cleanupExpiredFiles, FILE_TTL_CHECK_INTERVAL_MS);
  fileTtlTimer.unref?.();

  // --- Graceful shutdown ---
  function gracefulShutdown(signal: string) {
    logger.info(`${signal} received, shutting down...`);
    clearInterval(heartbeatTimer);
    clearInterval(fileTtlTimer);
    clearInterval(padService.getCleanupTimer());
    clearInterval(session.getCleanupTimer());
    // Close SQLite database (backward-compat method name from JSON store era)
    db.store.flushSync();

    // Close all WebSocket connections
    try {
      for (const client of wss.clients) {
        try {
          client.close(1001, 'Server shutting down');
        } catch {}
      }
    } catch {}

    server.close(() => {
      logger.info('Server closed.');
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000).unref();
  }

  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

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
    cleanupExpiredFiles();

    // Startup info
    logger.info('CoMark-Notepad is running!');
    logger.info(`  Local:   http://localhost:${currentPort}`);
    logger.info(`  Network: ${url}`);
    const padCount = db.pads.findAll().length;
    logger.info(`  Pads:    ${padCount}`);

    const { isProduction, PUBLIC_ORIGIN } = require('./config');
    if (isProduction && !PUBLIC_ORIGIN) {
      logger.warn('PUBLIC_ORIGIN is not set. Origin-based CSRF protection will accept any localhost/LAN origin. Set PUBLIC_ORIGIN in production.');
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
