'use strict';

const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  // Defence in depth: pad unlock tokens travel in X-Pad-Token and sessions in
  // the session cookie. Any future code that logs a request object would
  // otherwise write long-lived bearer credentials into the log stream, which
  // on a self-hosted box is often the same disk as the data directory.
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-pad-token"]',
      'req.headers["x-admin-token"]',
      'req.headers["x-session-token"]',
      'headers.cookie',
      'headers.authorization',
      'headers["x-pad-token"]',
      'headers["x-admin-token"]',
      'headers["x-session-token"]',
      '*.headers.cookie',
      '*.headers.authorization',
      '*.headers["x-pad-token"]',
      '*.headers["x-admin-token"]',
      '*.headers["x-session-token"]',
      'password',
      '*.password',
      'token',
      '*.token',
      'padToken',
      '*.padToken',
      // Write-access passphrase (POST /api/write-access/redeem) — a shared
      // secret that grants editing for WRITE_GRANT_TTL_DAYS. Leaking it in a
      // log line is equivalent to leaking the admin token.
      'passphrase',
      '*.passphrase',
      'adminToken',
      '*.adminToken',
    ],
    censor: '[REDACTED]',
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  base: { pid: process.pid },
});

module.exports = logger;
