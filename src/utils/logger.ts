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
      'headers.cookie',
      'headers.authorization',
      'headers["x-pad-token"]',
      '*.headers.cookie',
      '*.headers.authorization',
      '*.headers["x-pad-token"]',
      'password',
      '*.password',
      'token',
      '*.token',
      'padToken',
      '*.padToken',
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
