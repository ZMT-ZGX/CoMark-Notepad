'use strict';

/**
 * WebSocket server initialization.
 *
 * Connection lifecycle (reserve → validate → auth → finalize → heartbeat)
 * lives here; message dispatch is delegated to `handlers.ts` and
 * validation to `validate.ts`.
 */

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
const { safeClose } = require('./close');
const {
  MAX_WS_CONNECTIONS,
  MAX_WS_CONNECTIONS_PER_IP,
  HEARTBEAT_INTERVAL_MS,
  JSON_BODY_LIMIT,
  WS_ALLOW_NO_ORIGIN,
} = require('../config');
const { parseWsMessage } = require('./validate');
const { handleMessage } = require('./handlers');

// Minimum gap between room-wide presence-throttle resets for the same pad.
const PRESENCE_RESET_COOLDOWN_MS = 2000;
const lastPresenceResetAt = new Map<number, number>();

/**
 * Reject a frame: close with a fixed, short reason and keep the detail in the
 * log instead.
 *
 * Two constraints force this shape:
 *  1. `ws` throws a synchronous RangeError when a close reason exceeds 123
 *     bytes (handled centrally by `safeClose`), and the throw would happen
 *     inside the `message` listener — nothing catches it there, so the
 *     process dies.
 *  2. Echoing validation detail back to the client leaks the schema.
 */
function rejectFrame(ws: CoMarkWebSocket, reason: string, detail: string): void {
  logger.warn('WS frame rejected', {
    padId: ws.padId,
    clientId: ws.clientId,
    detail: detail.slice(0, 200),
  });
  safeClose(ws, 4400, reason);
}

// Database lookups needed during connection admission. Injected via `deps` so
// initWSS stays testable and the admission path follows the same DI shape as
// the message handlers (`patchDeps`); defaults to the real db modules.
interface WsAdmissionDeps {
  db?: typeof db;
}

function initWSS(
  server: any,
  padService: any,
  writeAccessService?: any,
  deps: WsAdmissionDeps = {}
): { wss: any; heartbeatTimer: ReturnType<typeof setInterval> } {
  const admissionDb = deps.db || db;
  const wss = new WebSocketServer({ server, maxPayload: JSON_BODY_LIMIT });
  const patchDeps = { padService, writeAccessService };

  wss.on('connection', (ws: CoMarkWebSocket, req: any) => {
    const clientIp = req.socket.remoteAddress;

    // Reserve a slot before any async work so the connection ceiling
    // covers pending auth sockets too.
    connections.reserve(clientIp);
    let reserved = true;
    const releaseReservation = () => {
      if (!reserved) return;
      reserved = false;
      connections.releaseReservation(clientIp);
    };
    ws.once('close', releaseReservation);

    // ── Connection ceilings ──────────────────────────────────────
    if (connections.getTotalCount() + connections.getPendingTotal() > MAX_WS_CONNECTIONS) {
      safeClose(ws, 1013, 'Server overloaded');
      return;
    }
    if (
      connections.getIpCount(clientIp) + connections.getPendingIpCount(clientIp) >
      MAX_WS_CONNECTIONS_PER_IP
    ) {
      safeClose(ws, 1013, 'Connection limit reached for this IP');
      return;
    }

    // ── Origin check ─────────────────────────────────────────────
    const origin = req.headers.origin;
    // `isAllowedOrigin` returns true for a MISSING origin, a fail-open default
    // that admits any client which simply omits the header. Browsers always
    // send Origin on a WS handshake, so the only clients that omit it are
    // non-browser ones: fail closed unless the operator opted in.
    if (!origin ? !WS_ALLOW_NO_ORIGIN : !isAllowedOrigin(origin)) {
      safeClose(ws, 4400, 'Invalid origin');
      return;
    }

    // ── Parse padId ──────────────────────────────────────────────
    const url = new URL(req.url, 'http://localhost');
    const rawPadParam = url.searchParams.get('pad');
    const rawPad = Number(rawPadParam);
    if (!Number.isInteger(rawPad) || rawPad <= 0) {
      safeClose(ws, 4400, 'Invalid pad id');
      return;
    }
    const padId = rawPad;

    // ── Session ──────────────────────────────────────────────────
    const cookieToken = parseCookies(req.headers.cookie || '')['session_token'];
    const token = cookieToken || null;
    const userId = session.verify(token);
    ws.userId = userId && admissionDb.users.exists(userId) ? userId : null;

    // ── Access control ───────────────────────────────────────────
    const targetPad = admissionDb.pads.findById(padId);
    if (!targetPad) {
      safeClose(ws, 4404, 'Pad not found');
      return;
    }
    if (!targetPad.ownerUserId || targetPad.ownerUserId === ws.userId) {
      // Public pad or owner — allow
    } else if (
      !ws.userId ||
      !admissionDb.invitations.hasAccessGrant(targetPad.ownerUserId, ws.userId)
    ) {
      safeClose(ws, 4401, 'Access denied');
      return;
    }

    // ── Finalize: register connection, bind message/close handlers ──
    function finalizeConnection(unlockToken: string | null = null) {
      ws.ipAddress = clientIp;
      ws.clientId = generateId();
      ws.padId = padId;
      ws.isAlive = true;
      ws.unlockToken = unlockToken;
      ws.patchWindowStart = Date.now();
      ws.patchCount = 0;
      ws.lastPresenceSent = 0;

      releaseReservation();
      connections.add(ws, { clientId: ws.clientId, padId, userId: ws.userId, ipAddress: clientIp });

      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => {
        connections.remove(ws);
        const remaining = connections.getPadCount(padId);
        // Drop cooldown state for pads nobody is on, so the map can't grow
        // without bound on a long-lived server.
        if (!remaining) lastPresenceResetAt.delete(padId);
        broadcast.toPad(padId, { type: 'online-count', padId, count: remaining });
        broadcast.toPad(padId, { type: 'presence', padId, wsId: ws.clientId, gone: true });
      });
      ws.on('error', () => connections.remove(ws));
      ws.on('message', (raw: Buffer) => {
        // Last-resort net: a throw from anywhere below would otherwise escape
        // into ws's receiver and take the process down (there is no
        // uncaughtException handler). Reject-don't-crash.
        try {
          let rawObj: unknown;
          try {
            rawObj = JSON.parse(raw as unknown as string);
          } catch {
            return;
          }
          const parsed = parseWsMessage(rawObj);
          if (!parsed.ok) {
            rejectFrame(ws, 'Invalid message', parsed.error);
            return;
          }
          handleMessage(ws, parsed.data, patchDeps);
        } catch (err) {
          logger.error({ err }, 'WS message handler failed');
          safeClose(ws, 4000, 'Internal error');
        }
      });

      // ── Hello + presence bootstrap ────────────────────────────
      ws.send(JSON.stringify({ type: 'hello', wsId: ws.clientId, padId, userId: ws.userId }));
      // A joiner clears the room's presence throttle so everyone answers the
      // request below immediately instead of waiting out their 400ms window.
      // Without a cooldown a client that reconnects in a loop makes every peer
      // rebroadcast on every join — O(N^2) frames from a single socket — so the
      // reset is capped at one per pad per PRESENCE_RESET_COOLDOWN_MS.
      const now = Date.now();
      if (now - (lastPresenceResetAt.get(padId) || 0) >= PRESENCE_RESET_COOLDOWN_MS) {
        lastPresenceResetAt.set(padId, now);
        for (const peer of connections.getPadClients(padId) || []) {
          peer.lastPresenceSent = 0;
        }
      }
      broadcast.toPad(padId, { type: 'presence-request', padId });
      broadcast.toPad(padId, {
        type: 'online-count',
        padId,
        count: connections.getPadCount(padId),
      });
    }

    // ── Password-protected pad: auth handshake ──────────────────
    if (targetPad.password) {
      const authTimer = setTimeout(() => safeClose(ws, 4403, 'Pad locked'), 1500);
      ws.once('close', () => clearTimeout(authTimer));
      ws.once('message', (raw: Buffer) => {
        clearTimeout(authTimer);
        try {
          let rawObj: unknown;
          try {
            rawObj = JSON.parse(raw as unknown as string);
          } catch {
            rejectFrame(ws, 'Invalid message', 'auth handshake: unparseable JSON');
            return;
          }
          const parsed = parseWsMessage(rawObj);
          if (!parsed.ok) {
            rejectFrame(ws, 'Invalid message', parsed.error);
            return;
          }
          if (parsed.data.type !== 'auth') {
            rejectFrame(ws, 'Expected auth message', `got ${parsed.data.type}`);
            return;
          }
          if (!padService || !padService.isValidUnlockToken(parsed.data.padToken, padId)) {
            safeClose(ws, 4403, 'Pad locked');
            return;
          }
          finalizeConnection(parsed.data.padToken);
        } catch (err) {
          logger.error({ err }, 'WS auth handshake failed');
          safeClose(ws, 4000, 'Internal error');
        }
      });
    } else {
      finalizeConnection(null);
    }
  });

  // ── Heartbeat ────────────────────────────────────────────────────
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
