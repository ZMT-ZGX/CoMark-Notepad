'use strict';

/**
 * WebSocket message handlers.
 *
 * Extracted from the monolithic initWSS so each message type has its
 * own scope and the connection handler stays focused on lifecycle.
 *
 * Every handler receives the validated message (already parsed and
 * schema-checked by validate.ts) plus the socket context it needs.
 */

import type { CoMarkWebSocket } from '../types';
import type { WsClientMessage, WsPresenceMessage, WsPatchMessage } from './validate';

const broadcast = require('./broadcast');
const { safeClose } = require('./close');
const logger = require('../utils/logger');

const { WS_PATCH_WINDOW_MS, MAX_WS_PATCHES_PER_WINDOW } = require('../config');

// Aliases for readability inside the patch handler.
const PATCH_WINDOW_MS = WS_PATCH_WINDOW_MS;
const MAX_PATCHES_PER_WINDOW = MAX_WS_PATCHES_PER_WINDOW;

// ── Presence ───────────────────────────────────────────────────────

const PRESENCE_THROTTLE_MS = 400;

function handlePresence(ws: CoMarkWebSocket, msg: WsPresenceMessage): void {
  const now = Date.now();
  if (now - ws.lastPresenceSent < PRESENCE_THROTTLE_MS) return;
  ws.lastPresenceSent = now;
  broadcast.toPad(
    ws.padId,
    {
      type: 'presence',
      padId: ws.padId,
      wsId: ws.clientId,
      name: msg.name,
      active: msg.active,
    },
    ws.clientId
  );
}

// ── Patch ──────────────────────────────────────────────────────────

interface PatchDeps {
  padService: any;
  writeAccessService: any;
}

function handlePatch(ws: CoMarkWebSocket, msg: WsPatchMessage, deps: PatchDeps): void {
  const { padService, writeAccessService } = deps;

  // The schema guarantees a positive int, but the socket is the authority on
  // which pad this connection was admitted to. A mismatched (or stale) padId
  // means the client is confused about its own room — drop the frame rather
  // than write to whatever pad the socket happens to hold.
  if (msg.padId !== ws.padId) return;
  if (!padService || typeof padService.applyPatch !== 'function') return;

  // Write gate — re-checked on EVERY patch, never snapshotted from
  // connect time. A grant can expire or be revoked while this socket
  // is open, and this is the primary editing path.
  if (writeAccessService) {
    const writeStatus = writeAccessService.status(ws.userId || null, false);
    if (!writeStatus.allowed) {
      try {
        ws.send(JSON.stringify({ type: 'write-denied', padId: ws.padId, reason: 'no_grant' }));
      } catch {}
      safeClose(ws, 4405, 'Write access required');
      return;
    }
    // Sliding renewal — reuses writeStatus (one write_grants SELECT per patch,
    // not two).
    writeAccessService.renewFromStatus(ws.userId || null, writeStatus);
  }

  // Per-connection patch rate limit (DoS hardening — HTTP writes go
  // through express-rate-limit, but WS messages bypass Express).
  const now = Date.now();
  if (now - ws.patchWindowStart > PATCH_WINDOW_MS) {
    ws.patchWindowStart = now;
    ws.patchCount = 0;
  }
  ws.patchCount += 1;
  if (ws.patchCount > MAX_PATCHES_PER_WINDOW) {
    logger.warn('WS patch rate limit exceeded, closing connection', {
      padId: ws.padId,
      clientId: ws.clientId,
      count: ws.patchCount,
    });
    safeClose(ws, 4001, 'Patch rate limit exceeded');
    return;
  }

  padService
    .applyPatch(
      ws.userId,
      ws.padId,
      msg.data,
      ws.clientId,
      msg.operationId ?? null,
      msg.baseVersion ?? null,
      ws.unlockToken || null
    )
    .then((result: any) => {
      if (!result) return;
      try {
        if (result.notFound || result.denied) return;
        if (result.locked) {
          safeClose(ws, 4403, 'Pad locked');
          return;
        }
        if (result.ok) {
          ws.send(
            JSON.stringify({
              type: 'patch-ack',
              textVersion: result.pad.textVersion,
              seq: msg.seq,
            })
          );
        } else {
          // Distinguish a client that omitted `baseVersion` from a pad that
          // moved on underneath it. Both resync identically, so this is purely
          // about observability — but they are different failures: one is a
          // contract violation that will repeat forever, the other is ordinary
          // contention. Collapsing them makes neither visible.
          ws.send(
            JSON.stringify({
              type: 'patch-nack',
              padId: ws.padId,
              reason: result.missingBaseVersion ? 'missing_base_version' : 'version_conflict',
              text: result.pad.text,
              textVersion: result.pad.textVersion,
            })
          );
        }
      } catch (err) {
        logger.warn({ err, padId: ws.padId }, 'Failed to send patch ack/nack');
      }
    })
    .catch((err: any) => {
      // AGENTS.md: patch failures must be visible. Rejecting here is
      // unobservable otherwise — the client would just sit on a stale shadow.
      logger.warn({ err, padId: ws.padId, clientId: ws.clientId }, 'applyPatch failed');
    });
}

// ── Dispatch ───────────────────────────────────────────────────────

/**
 * Route a validated client→server message to the right handler.
 * Unknown types are already rejected by parseWsMessage, so the
 * default branch should never be hit in practice.
 */
function handleMessage(ws: CoMarkWebSocket, msg: WsClientMessage, deps: PatchDeps): void {
  if (msg.type === 'presence') {
    handlePresence(ws, msg);
  } else if (msg.type === 'patch') {
    handlePatch(ws, msg, deps);
  }
  // Future message types: add an `else if` here and a handler above.
}

module.exports = { handleMessage, handlePresence, handlePatch };
