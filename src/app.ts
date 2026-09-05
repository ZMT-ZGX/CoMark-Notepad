'use strict';

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { JSON_BODY_LIMIT, TRUST_PROXY_HOPS } = require('./config');
const { authenticate } = require('./middlewares/auth');
const { extractPadTokens, hasValidUnlockToken } = require('./middlewares/security');
const errorHandler = require('./middlewares/errorHandler');
const { mountRoutes } = require('./routes');
const logger = require('./utils/logger');

function createApp(
  services: any,
  getServerPort: (() => number) | null,
  getPadClients: (padId: number) => Set<any> | undefined
) {
  const app = express();
  app.set('trust proxy', TRUST_PROXY_HOPS);
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

  // Access log. Registered on 'finish' rather than on the request so the entry
  // can carry the status code and duration, which are unknown at request time.
  // Health probes are skipped: Docker and Caddy poll them every few seconds and
  // they would otherwise drown out real traffic in the log stream.
  const ACCESS_LOG_SKIP_PATHS = new Set(['/api/health', '/api/health/ready']);
  app.use((req: any, res: any, next: any) => {
    if (ACCESS_LOG_SKIP_PATHS.has(req.path)) return next();
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const meta = {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Math.round(durationMs * 10) / 10,
        ip: req.ip || req.socket.remoteAddress,
      };
      if (res.statusCode >= 500) logger.error(meta, 'request failed');
      else if (res.statusCode >= 400) logger.warn(meta, 'request rejected');
      else logger.info(meta, 'request completed');
    });
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

  // Prevent iOS Safari from caching HTML (ensures fresh CSS/JS refs). Must
  // run before static: serve-static only sets Cache-Control when none exists.
  app.use((req: any, res: any, next: any) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
    next();
  });

  // Static files before body parsing and session auth: page assets (JS/CSS/
  // images, vendored libs) are public by construction, and routing them
  // through authenticate would cost every request a cookie parse + HMAC check
  // + users-table lookup for nothing. public/ already contains public/vendor,
  // so no separate /vendor mount is needed.
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // Body parser
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  // Authenticate (sets req.userId, never blocks)
  app.use(authenticate);

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
      const unlockTokens = extractPadTokens(req);
      const rows = db.searchPads(tokens);
      // Pad metadata (owner / creator / password) is enough for the
      // invitation-grant check in canAccessPad — loading the full row would
      // pull every matching pad body into memory just to gate a snippet.
      const results = rows
        .map((r: any) => {
          const pad = db.pads.findByIdMeta(r.id);
          if (!pad || !padService.canAccessPad(req.userId, pad)) return null;
          // Password-protected pads: their body must not leak through search
          // unless the requester has unlocked THIS pad for THIS request. A
          // public pad with a password is still "accessible" (canAccessPad
          // returns true for public pads) but its content stays gated.
          // Header only — a query param would land in access logs / proxy logs.
          // Multiple tokens may be comma-separated (one per unlocked pad).
          if (pad.password && !hasValidUnlockToken(padService, unlockTokens, pad.id)) return null;
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
