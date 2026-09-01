'use strict';

const express = require('express');
const QRCode = require('qrcode');
const { getLanIP } = require('../utils/file');

// Cache LAN IP at module load time — it rarely changes during runtime
const CACHED_LAN_IP = getLanIP();

function createRouter(db: any, getServerPort: (() => number) | null) {
  const router = express.Router();

  // Liveness probe (before any auth, for the Docker healthcheck).
  // Deliberately never touches the database: Docker restarts the container
  // after `retries` consecutive failures, and a healthy process that is
  // momentarily blocked on a SQLite checkpoint must not be killed for it.
  router.get('/health', (req: any, res: any) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
    });
  });

  // Readiness probe. Unlike liveness this hits SQLite, so it answers
  // "can this instance serve traffic right now". The deploy script gates on
  // it before cutting over. Counts use the metadata-only COUNT(*) helpers —
  // findAll() here would pull every pad body into memory on each probe.
  router.get('/health/ready', (req: any, res: any) => {
    try {
      res.json({
        status: 'ok',
        uptime: process.uptime(),
        pads: db.pads.count(),
        files: db.files.count(),
      });
    } catch {
      // Deliberately generic: this endpoint is unauthenticated, so the failure
      // reason must not leak database internals to callers.
      res.status(503).json({ status: 'error', error: 'database unavailable' });
    }
  });

  // QR code
  router.get('/qrcode', async (req: any, res: any, next: any) => {
    try {
      const port = getServerPort ? getServerPort() : 8000;
      const url = `http://${CACHED_LAN_IP}:${port}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 2, width: 200 });
      res.type('image/svg+xml').send(svg);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

module.exports = createRouter;
