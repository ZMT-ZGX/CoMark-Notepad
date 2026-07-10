'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { JSON_BODY_LIMIT } = require('./config');
const { authenticate } = require('./middlewares/auth');
const errorHandler = require('./middlewares/errorHandler');
const { mountRoutes } = require('./routes');
const logger = require('./utils/logger');

function createApp(
  services: any,
  getServerPort: (() => number) | null,
  getPadClients: (padId: number) => Set<any> | undefined
) {
  const app = express();
  app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS ?? 0));
  app.disable('x-powered-by');

  // Security headers (relaxed CSP for inline SVG favicon)
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          baseUri: ["'self'"],
          fontSrc: ["'self'", 'https:', 'data:'],
          formAction: ["'self'"],
          frameAncestors: ["'self'"],
          objectSrc: ["'none'"],
          scriptSrcAttr: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    })
  );

  // Request logging
  app.use((req: any, _res: any, next: any) => {
    const ip = req.ip || req.socket.remoteAddress;
    logger.info(`${req.method} ${req.path} [${ip}]`);
    next();
  });

  // Rate limiting — general API limiter
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
  });
  app.use('/api/', generalLimiter);

  // Delete limiter — guards the destructive "delete whole pad" action.
  // Single-file deletes (DELETE /api/files/:id) are routine user operations
  // and are instead covered by the general limiter below; the bulk "clear all
  // files" action already has its own clearFilesLimiter (max 5).
  const deleteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skip: (req: any) => req.method !== 'DELETE',
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many delete requests.' },
  });
  app.use('/api/pads/', deleteLimiter);

  // Body parser
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Authenticate (sets req.userId, never blocks)
  app.use(authenticate);

  // Prevent iOS Safari from caching HTML (ensures fresh CSS/JS refs)
  app.use((req: any, res: any, next: any) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
  });

  // Static files (public/ and vendored browser libs)
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/vendor', express.static(path.join(__dirname, '..', 'public', 'vendor')));

  // Full-text search (FTS5) — scoped to pads the current user can access
  app.get('/api/search', (req: any, res: any, next: any) => {
    try {
      const raw = String(req.query.q || '')
        .trim()
        .slice(0, 200);
      if (!raw) return res.json({ results: [] });
      // Build MATCH query: wrap each token in quotes for phrase search,
      // AND them together so multi-term narrows results.
      const tokens = raw
        .split(/\s+/)
        .filter(Boolean)
        .map((t) => `"${t.replace(/"/g, '""')}"`)
        .join(' AND ');
      const db = services.db;
      const { padService } = services;
      const rows = db.searchPads(tokens);
      // Use full pad from DB so invitation-grant check in canAccessPad works correctly.
      const results = rows
        .map((r: any) => {
          const pad = db.pads.findById(r.id);
          if (!pad || !padService.canAccessPad(req.userId, pad)) return null;
          // Password-protected pads: their body must not leak through search
          // unless the requester has unlocked THIS pad for THIS request. A
          // public pad with a password is still "accessible" (canAccessPad
          // returns true for public pads) but its content stays gated.
          const padToken = req.query.padToken || req.headers['x-pad-token'];
          if (pad.password && !padService.isValidUnlockToken(padToken, pad.id)) return null;
          return {
            id: r.id,
            content: r.content,
            snippet: db.searchSnippet(tokens, r.id),
          };
        })
        .filter(Boolean);
      res.json({ results });
    } catch (e) {
      next(e);
    }
  });

  // Mount all API routes
  mountRoutes(app, services, getServerPort, getPadClients);

  // Global error handler
  app.use(errorHandler);

  return app;
}

module.exports = { createApp };
