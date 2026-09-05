'use strict';

/**
 * Zod schemas for inbound WebSocket messages.
 *
 * HTTP routes are validated via `src/validators/*.ts`, but WS messages
 * bypass Express body parsing and reach `ws/index.ts` as raw JSON.
 * This module closes that gap: every client→server message type is
 * validated before the handler sees it, and malformed frames are
 * rejected with a 4400 close code (consistent with the existing
 * "Invalid origin" / "Invalid pad id" / "Invalid message" closes).
 *
 * Adding a new message type: add a schema to MESSAGE_SCHEMAS and
 * an entry to WsClientMessage union below — that's it.
 */

import { z } from 'zod';

// ── Client → Server message schemas ────────────────────────────────

const AuthSchema = z.object({
  type: z.literal('auth'),
  padToken: z.string().min(1).max(256),
});

const PresenceSchema = z.object({
  type: z.literal('presence'),
  name: z.string().max(40).optional(),
  active: z.boolean().optional(),
});

const PatchSchema = z.object({
  type: z.literal('patch'),
  padId: z.number().int().positive(),
  data: z.string().max(200000),
  seq: z.number().int().optional(),
  operationId: z.string().max(128).optional(),
  baseVersion: z.number().int().nonnegative().optional(),
});

// ── Schema registry ────────────────────────────────────────────────
//
// Null-prototype on purpose. A plain object literal inherits
// `Object.prototype`, so a frame like `{"type":"constructor"}` would make
// `MESSAGE_SCHEMAS[type]` resolve to `Object` — truthy, but with no
// `safeParse`. The resulting TypeError is thrown inside the `message`
// listener, where nothing catches it, so a single frame from any client
// that passed the origin check would take the whole process down.

const MESSAGE_SCHEMAS: Record<string, z.ZodTypeAny> = Object.assign(
  Object.create(null) as Record<string, z.ZodTypeAny>,
  {
    auth: AuthSchema,
    presence: PresenceSchema,
    patch: PatchSchema,
  }
);

// ── Public API ─────────────────────────────────────────────────────

/** Union of all validated client→server message shapes. */
export type WsAuthMessage = z.infer<typeof AuthSchema>;
export type WsPresenceMessage = z.infer<typeof PresenceSchema>;
export type WsPatchMessage = z.infer<typeof PatchSchema>;

export type WsClientMessage = WsAuthMessage | WsPresenceMessage | WsPatchMessage;

export interface ParsedMessage {
  ok: true;
  data: WsClientMessage;
}

export interface RejectedMessage {
  ok: false;
  error: string;
}

/**
 * Parse and validate an inbound WS message.
 *
 * Returns `{ ok: true, data }` when the message matches a known schema,
 * or `{ ok: false, error }` when it is malformed / unknown.
 * The caller should close the socket with 4400 on rejection.
 */
function parseWsMessage(raw: unknown): ParsedMessage | RejectedMessage {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Message must be a JSON object' };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.type !== 'string') {
    return { ok: false, error: 'Message type must be a string' };
  }
  // Own-property check (not truthiness) — see the registry comment above.
  if (!Object.prototype.hasOwnProperty.call(MESSAGE_SCHEMAS, obj.type)) {
    return { ok: false, error: 'Unknown message type' };
  }
  const schema = MESSAGE_SCHEMAS[obj.type];
  if (!schema || typeof schema.safeParse !== 'function') {
    return { ok: false, error: 'Unknown message type' };
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path?.join('.') ?? '?';
    return { ok: false, error: `Invalid ${obj.type}: ${path} ${first?.message ?? ''}` };
  }
  return { ok: true, data: result.data as WsClientMessage };
}

module.exports = { parseWsMessage, MESSAGE_SCHEMAS };
