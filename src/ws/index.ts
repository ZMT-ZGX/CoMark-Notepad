'use strict';

import type { CoMarkWebSocket } from '../types';
const { WebSocketServer } = require('ws');
const connections = require('./connections');
const broadcast = require('./broadcast');
const session = require('../auth/session');
const { parseCookies } = require('../middlewares/auth');
const { isAllowedOrigin } = require('../middlewares/security');
const db = require('../db');
const { generateId } = require('../utils/crypto');
const logger = require('../utils/logger');
const {
  MAX_WS_CONNECTIONS,
  MAX_WS_CONNECTIONS_PER_IP,
  HEARTBEAT_INTERVAL_MS,
  WS_PATCH_WINDOW_MS,
  MAX_WS_PATCHES_PER_WINDOW,
  JSON_BODY_LIMIT,
} = require('../config');

// Aliases used inside the message handler (kept module-local so the handler
// reads as plain constants rather than a config lookup each time).
const PATCH_WINDOW_MS = WS_PATCH_WINDOW_MS;
const MAX_PATCHES_PER_WINDOW = MAX_WS_PATCHES_PER_WINDOW;

function initWSS(server: any, padService: any): { wss: any; heartbeatTimer: ReturnType<typeof setInterval> } {
  // Cap inbound frame size so a single oversized WS message can't exhaust
  // server memory. WS frames bypass Express's JSON body-size limit, so this
  // is the only guard against a huge patch frame.
  const wss = new WebSocketServer({ server, maxPayload: JSON_BODY_LIMIT });

  wss.on('connection', (ws: CoMarkWebSocket, req: any) => {
    // Hard connection ceiling to protect memory and heartbeat CPU
    if (connections.getTotalCount() >= MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Server overloaded');
      return;
    }

    // Per-IP connection limit to prevent single-IP pool exhaustion
    // Note: req.ip is an Express property — unavailable on raw upgrade req.
    const clientIp = req.socket.remoteAddress;
    if (connections.getIpCount(clientIp) >= MAX_WS_CONNECTIONS_PER_IP) {
      ws.close(1013, 'Connection limit reached for this IP');
      return;
    }

    // Origin check: prevent cross-origin WebSocket connections.
    // Unlike checkOrigin (HTTP), WebSocket handshakes from browsers always
    // include an Origin header, so a missing Origin here indicates a non-browser
    // client — allow it (same rationale as isAllowedOrigin returning true for
    // missing Origin on GET requests).
    const origin = req.headers.origin;
    if (!isAllowedOrigin(origin)) {
      ws.close(4400, 'Invalid origin');
      return;
    }

    // Parse padId from URL query — reject non-numeric or missing values
    const url = new URL(req.url, 'http://localhost');
    const rawPadParam = url.searchParams.get('pad');
    const rawPad = Number(rawPadParam);
    if (!Number.isInteger(rawPad) || rawPad <= 0) {
      ws.close(4400, 'Invalid pad id');
      return;
    }
    const padId = rawPad;

    // Token verification: Cookie only (session token is never transmitted in URL)
    const cookieToken = parseCookies(req.headers.cookie || '')['session_token'];
    const token = cookieToken || null;
    const userId = session.verify(token);
    ws.userId = userId && db.users.exists(userId) ? userId : null;

    // Access control: reject non-existent pads immediately
    const targetPad = db.pads.findById(padId);
    if (!targetPad) {
      ws.close(4404, 'Pad not found');
      return;
    }

    // Check pad access
    if (!targetPad.ownerUserId || targetPad.ownerUserId === ws.userId) {
      // Public pad or owner — allow
    } else if (!ws.userId || !db.invitations.hasAccessGrant(targetPad.ownerUserId, ws.userId)) {
      ws.close(4401, 'Access denied');
      return;
    }

    function finalizeConnection() {
      ws.ipAddress = clientIp;
      ws.clientId = generateId();
      ws.padId = padId;
      ws.isAlive = true;
      // Patch rate-limit window state (fixed window, reset on first message
      // of each 60s interval). See message handler below.
      ws.patchWindowStart = Date.now();
      ws.patchCount = 0;
      connections.add(ws, { clientId: ws.clientId, padId, userId: ws.userId, ipAddress: clientIp });

      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('close', () => {
        connections.remove(ws);
        broadcast.toPad(padId, { type: 'online-count', padId, count: connections.getPadCount(padId) });
      });
      ws.on('error', () => connections.remove(ws));
      ws.on('message', (raw: Buffer) => {
        let msg;
        try { msg = JSON.parse(raw as unknown as string); } catch { return; }
        if (msg.type === 'patch' && padService) {
          // Per-connection patch rate limit (DoS hardening — HTTP write path
          // has express-rate-limit, but WS messages bypass Express entirely).
          const now = Date.now();
          if (now - ws.patchWindowStart > PATCH_WINDOW_MS) {
            ws.patchWindowStart = now;
            ws.patchCount = 0;
          }
          ws.patchCount += 1;
          if (ws.patchCount > MAX_PATCHES_PER_WINDOW) {
            logger.warn('WS patch rate limit exceeded, closing connection', {
              padId,
              clientId: ws.clientId,
              count: ws.patchCount,
            });
            try { ws.close(4001, 'Patch rate limit exceeded'); } catch {}
            return;
          }

          padService.applyPatch(ws.userId, padId, msg.data, ws.clientId)
            .then((result: any) => {
              if (!result) return; // pad not found / access denied — silently drop
              try {
                if (result.ok) {
                  ws.send(JSON.stringify({
                    type: 'patch-ack',
                    textVersion: result.pad.textVersion,
                  }));
                } else {
                  // Patch failed to apply (concurrent conflict or malformed).
                  // Send the authoritative full text back to the sender so its
                  // shadow resets. Uses a dedicated 'patch-nack' (not text-update)
                  // so the client applies it immediately even while focused,
                  // bypassing the deferred-merge path that could drop the reset.
                  ws.send(JSON.stringify({
                    type: 'patch-nack',
                    padId,
                    text: result.pad.text,
                    textVersion: result.pad.textVersion,
                  }));
                }
              } catch {}
            })
            .catch(() => {});
        }
      });

      ws.send(JSON.stringify({ type: 'hello', wsId: ws.clientId, padId, userId: ws.userId }));
      broadcast.toPad(padId, { type: 'online-count', padId, count: connections.getPadCount(padId) });
    }

    // Password-protected pad: token sent as first WebSocket message (not in URL)
    // to avoid exposing it in proxy/server access logs.
    if (targetPad.password) {
      const authTimer = setTimeout(() => ws.close(4403, 'Pad locked'), 1500);
      // Clear timer if socket closes before auth (e.g. client disconnect, heartbeat timeout)
      ws.once('close', () => clearTimeout(authTimer));
      ws.once('message', (raw: Buffer) => {
        clearTimeout(authTimer);
        let msg;
        try { msg = JSON.parse(raw as unknown as string); } catch { ws.close(4400, 'Invalid message'); return; }
        if (msg.type !== 'auth' || !padService || !padService.isValidUnlockToken(msg.padToken, padId)) {
          ws.close(4403, 'Pad locked');
          return;
        }
        finalizeConnection();
      });
    } else {
      finalizeConnection();
    }
  });

  // Heartbeat
  const heartbeatTimer = setInterval(() => {
    connections.forEach((ws: CoMarkWebSocket) => {
      if (ws.readyState !== 1) {
        connections.remove(ws);
        return;
      }
      if (ws.isAlive === false) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);

  return { wss, heartbeatTimer };
}

module.exports = { initWSS };
