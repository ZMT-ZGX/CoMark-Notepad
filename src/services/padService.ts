'use strict';

import type {
  DataStore,
  Broadcast,
  UnlockTokenEntry,
  CoMarkWebSocket,
  Pad,
  FileInfo,
} from '../types';
const path = require('path');
const logger = require('../utils/logger');
const DiffMatchPatch = require('diff-match-patch');
const {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  UnauthorizedError,
} = require('../utils/errors');
const { canAccessPad, canAccessFile, canManagePad } = require('../utils/auth');
const { hashPassword, verifyPassword } = require('../auth/password');
const { generateId } = require('../utils/crypto');
const { safeUnlink } = require('../utils/file');
const { MAX_PADS, UNLOCK_TOKEN_TTL_MS } = require('../config');

class PadService {
  store: DataStore;
  broadcast: Broadcast;
  getPadClients: ((padId: number) => Set<CoMarkWebSocket> | undefined) | null;
  unlockTokens: Map<string, UnlockTokenEntry>;
  unlockCleanupTimer: ReturnType<typeof setInterval>;
  // Reuse a single diff-match-patch instance across applyPatch calls to
  // avoid rebuilding its internal tables on every incoming patch.
  dmp: any;
  patchReceipts: Map<string, { padId: number; expires: number }>;

  constructor(
    store: DataStore,
    broadcast: Broadcast,
    getPadClients: ((padId: number) => Set<CoMarkWebSocket> | undefined) | null = null
  ) {
    this.store = store;
    this.broadcast = broadcast;
    this.getPadClients = getPadClients;
    this.dmp = new DiffMatchPatch();
    this.patchReceipts = new Map();
    this.unlockTokens = new Map();
    this.unlockCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [token, entry] of this.unlockTokens) {
        if (now > entry.expires) this.unlockTokens.delete(token);
      }
      for (const [operationId, entry] of this.patchReceipts) {
        if (now > entry.expires) this.patchReceipts.delete(operationId);
      }
    }, 600000);
    this.unlockCleanupTimer.unref?.();
  }

  padMeta(pad: Pad) {
    return {
      id: pad.id,
      hasPassword: !!pad.password,
      createdAt: pad.createdAt,
      ownerUserId: pad.ownerUserId || null,
    };
  }

  createUnlockToken(padId: number): string {
    const token = generateId() + generateId();
    this.unlockTokens.set(token, { padId, expires: Date.now() + UNLOCK_TOKEN_TTL_MS });
    return token;
  }

  isValidUnlockToken(token: string | undefined | null, padId: number): boolean {
    if (!token) return false;
    const entry = this.unlockTokens.get(token);
    if (!entry) return false;
    if (Date.now() > entry.expires) {
      this.unlockTokens.delete(token);
      return false;
    }
    return entry.padId === padId;
  }

  canAccessPad(userId: string | null, pad: Pad): boolean {
    return canAccessPad(userId, pad, this.store.hasAccessGrant.bind(this.store));
  }

  canAccessFile(userId: string | null, file: FileInfo): boolean {
    return canAccessFile(
      userId,
      file,
      this.store.findPadById.bind(this.store),
      this.store.hasAccessGrant.bind(this.store)
    );
  }

  canManagePad(userId: string | null, isAdminUser: boolean, pad: Pad): boolean {
    return canManagePad(userId, isAdminUser, pad);
  }

  getPadById(padId: number): Pad | null {
    return this.store.findPadById(padId) || null;
  }

  async getPad(userId: string | null, padId: number): Promise<Pad> {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');
    if (!this.canAccessPad(userId, pad)) {
      throw ForbiddenError('Access denied');
    }
    return pad;
  }

  async getState(userId: string | null, unlockTokens: string[] = []) {
    const hasGrantFn = this.store.hasAccessGrant.bind(this.store);
    // Metadata only: rendering the sidebar needs ownership, not document
    // bodies, and every pad-created/updated/deleted broadcast makes every
    // connected client re-request this endpoint.
    const pads = this.store.findAllPadMeta();
    const files = this.store.findAllFiles();
    const accessiblePads = pads.filter((p) => canAccessPad(userId, p, hasGrantFn));
    // Password-protected pads: hide file metadata until the pad is unlocked
    // for this request. canAccessPad still returns true for public-but-locked
    // pads (so they show in the sidebar with hasPassword), but their file
    // names/ids must not leak without a valid unlock token.
    const unlockedPadIds = new Set(
      accessiblePads
        .filter((p) => !p.password || unlockTokens.some((t) => this.isValidUnlockToken(t, p.id)))
        .map((p) => p.id)
    );
    const accessibleFiles = files.filter((f) => {
      // A file with no padId can't belong to a locked pad, so there's no token
      // leak risk — gate only by access (legacy / orphan files stay visible).
      if (f.padId == null) {
        return canAccessFile(userId, f, this.store.findPadById.bind(this.store), hasGrantFn);
      }
      // Pad-scoped files: hide them unless the owning pad is unlocked, so a
      // password-protected pad's file names/ids don't leak before unlock.
      if (!unlockedPadIds.has(f.padId)) return false;
      return canAccessFile(userId, f, this.store.findPadById.bind(this.store), hasGrantFn);
    });
    return {
      pads: accessiblePads.map((p) => this.padMeta(p)),
      files: accessibleFiles,
      userCode: userId || null,
    };
  }

  // Returns a result object so callers (ws/index.ts) can distinguish success
  // from failure and send an appropriate ack/nack to the sender. On failure,
  // `pad` carries the authoritative server state so the client can reset its
  // shadow and avoid permanent divergence. Always returns a structured result
  // (never null): missing pad / access denied / locked all use { ok:false, ... }.
  async applyPatch(
    userId: string | null,
    padId: number,
    patchText: string,
    excludeWsId: string | null,
    operationId: string | null = null,
    baseVersion: number | null = null,
    unlockToken: string | null = null
  ) {
    const pad = this.store.findPadById(padId);
    if (!pad) {
      logger.warn('applyPatch: pad not found', { padId });
      return { ok: false, notFound: true, pad: null };
    }
    if (!this.canAccessPad(userId, pad)) {
      logger.warn('applyPatch: access denied', { padId, userId });
      return { ok: false, denied: true, pad };
    }
    // Re-check the pad lock on every write. Connection-time auth is not enough:
    // the unlock token may expire (8h TTL) or be revoked by a password change
    // while this socket is still open.
    if (pad.password && !this.isValidUnlockToken(unlockToken, padId)) {
      logger.warn('applyPatch: pad locked / unlock token invalid', { padId, userId });
      return { ok: false, locked: true, pad };
    }

    if (operationId) {
      const receipt = this.patchReceipts.get(operationId);
      if (receipt && receipt.padId === padId) {
        // The database may already contain this operation if its ACK was lost.
        return { ok: true, duplicate: true, pad };
      }
    }

    // A patch is only safe against the document version it was diffed from.
    // Reject stale patches so the client can merge its intended full text via
    // the conditional HTTP path instead of applying an operation to a
    // different document and silently overwriting a concurrent edit.
    //
    // `baseVersion` is therefore MANDATORY, not optional. Previously the whole
    // check was skipped when the field was absent, which made the concurrency
    // control opt-in: any non-conforming (or malicious) client could disable
    // it by simply omitting one field and then apply a diff against whatever
    // the server happens to hold right now, silently clobbering a concurrent
    // edit. The server cannot infer a base version, so an undeclared write
    // must be rejected rather than guessed at.
    if (baseVersion == null) {
      return { ok: false, missingBaseVersion: true, pad };
    }
    if (pad.textVersion !== baseVersion) {
      return { ok: false, pad };
    }

    const dmp = this.dmp;
    let patches;
    try {
      patches = dmp.patch_fromText(patchText);
    } catch (e) {
      logger.warn('applyPatch: malformed patch', { padId, error: (e as Error).message });
      return { ok: false, pad };
    }
    const [newText, results] = dmp.patch_apply(patches, pad.text);
    if (!Array.isArray(results) || results.some((r) => !r)) {
      logger.warn('applyPatch: patch_apply failed', { padId, results });
      return { ok: false, pad };
    }

    // Enforce the same body-size ceiling the HTTP path enforces in the Zod
    // schema (100k chars). WS frames bypass Express body parsing, so without
    // this an anonymous client could grow the pad / FTS index without bound.
    if (newText.length > 100000) {
      logger.warn('applyPatch: resulting text exceeds 100000 char limit', {
        padId,
        length: newText.length,
      });
      return { ok: false, pad };
    }

    const updated = this.store.updatePadText(padId, newText);
    if (!updated) {
      logger.warn('applyPatch: updatePadText returned null', { padId });
      return { ok: false, pad };
    }

    if (operationId) {
      this.patchReceipts.set(operationId, { padId, expires: Date.now() + 24 * 60 * 60 * 1000 });
      while (this.patchReceipts.size > 10000) {
        const oldest = this.patchReceipts.keys().next().value;
        if (!oldest) break;
        this.patchReceipts.delete(oldest);
      }
    }

    // One frame per edit, diff-only. The receiver rebuilds the body by
    // applying the patch to its shadow; a receiver that can't apply it
    // cleanly resyncs via the HTTP pad-text endpoint. Carrying the
    // authoritative body here too meant every keystroke shipped the whole
    // document to every other client — on a 100KB pad with four peers that
    // is ~400KB of outbound JSON per character typed, vs a few bytes of
    // diff. The body in the frame was only ever a shortcut: the failure
    // path (patch_apply fails → loadPadContent()) already covers recovery.
    this.broadcast.toPad(
      padId,
      {
        type: 'patch',
        padId,
        data: patchText,
        textVersion: updated.textVersion,
        senderId: excludeWsId || null,
        operationId: operationId || undefined,
      },
      excludeWsId
    );
    return { ok: true, pad: updated };
  }

  async updateText(
    userId: string | null,
    padId: number,
    text: string,
    excludeWsId: string | null,
    baseVersion: number | null = null
  ) {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');
    if (!this.canAccessPad(userId, pad)) throw ForbiddenError('Access denied');
    // Pad lock is enforced by requirePadUnlock on the HTTP routes that call this.

    // Conditional update: the HTTP full-text fallback only overwrites when the
    // client's base version still matches the server's. A mismatch means
    // another client edited in the meantime — blindly overwriting would erase
    // their work, so we report a conflict and let the client merge instead.
    //
    // As on the patch path, `baseVersion` is MANDATORY: omitting it used to
    // skip this guard entirely, turning a full-text PUT into an unconditional
    // overwrite of the whole pad. An undeclared write is treated as a
    // conflict so the client takes its existing resync-and-merge path.
    if (baseVersion == null || pad.textVersion !== baseVersion) {
      return { ok: false, conflict: true, pad };
    }

    const updated = this.store.updatePadText(padId, text);
    if (!updated) throw NotFoundError('Pad not found');
    this.broadcast.toPad(
      padId,
      {
        type: 'text-update',
        padId: pad.id,
        text: updated.text,
        textVersion: updated.textVersion,
      },
      excludeWsId
    );
    return updated;
  }

  async createPad(userId: string | null) {
    if (this.store.countPads() >= MAX_PADS) {
      throw BadRequestError(`Maximum ${MAX_PADS} pads reached`);
    }
    const pad = this.store.createPad({
      ownerUserId: userId || null,
      creatorCode: userId || null,
    });
    this.broadcast.toAll({ type: 'pad-created', pad: this.padMeta(pad) });
    return pad;
  }

  async setPassword(
    userId: string | null,
    isAdminUser: boolean,
    padId: number,
    newPassword: string | null,
    currentPassword: string | null,
    unlockToken: string | null,
    excludeWsId: string | null
  ) {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    if (!this.canManagePad(userId, isAdminUser, pad)) {
      if (!userId) throw UnauthorizedError('Authentication required');
      throw ForbiddenError('Access denied');
    }

    // If pad has a password, require current password OR valid unlock token
    if (pad.password) {
      const hasValidToken = unlockToken && this.isValidUnlockToken(unlockToken, pad.id);
      if (!hasValidToken) {
        if (!currentPassword) throw ForbiddenError('Current password incorrect');
        const valid = await verifyPassword(currentPassword, pad.password);
        if (!valid) throw ForbiddenError('Current password incorrect');
      }
    }

    const hash = newPassword ? await hashPassword(newPassword) : null;
    if (newPassword && !hash) throw BadRequestError('Invalid password');

    const updated = this.store.updatePadPassword(padId, hash);
    if (!updated) throw NotFoundError('Pad not found');

    for (const [token, entry] of this.unlockTokens) {
      if (entry.padId === padId) this.unlockTokens.delete(token);
    }

    let newToken = null;
    if (updated.password) {
      newToken = this.createUnlockToken(padId);
      const clients = this.getPadClients ? this.getPadClients(padId) : undefined;
      if (clients) {
        for (const ws of Array.from(clients) as CoMarkWebSocket[]) {
          if (excludeWsId && ws.clientId === excludeWsId) continue;
          try {
            ws.close(4403, 'Pad locked');
          } catch {}
        }
      }
    }

    this.broadcast.toAll({ type: 'pad-updated', pad: this.padMeta(updated) });
    return { ok: true, hasPassword: !!updated.password, token: newToken };
  }

  async deletePad(userId: string | null, isAdminUser: boolean, padId: number) {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    if (!this.canManagePad(userId, isAdminUser, pad)) {
      throw ForbiddenError('Access denied');
    }

    // Zero pads is a valid state: a fresh install no longer seeds a public
    // Pad #1, so there is nothing that must be kept alive.

    for (const [token, entry] of this.unlockTokens) {
      if (entry.padId === padId) this.unlockTokens.delete(token);
    }

    // Remove file DB rows first, then the pad row. Disk unlinks run last
    // (concurrently via fs.promises) so a crash between DB and disk leaves
    // orphan files (harmless) rather than orphan DB rows pointing to missing
    // files. Broadcast file-deleted before pad-deleted so clients still
    // connected to the pad can process the event.
    const filesToDelete = this.store.findAllFiles().filter((f) => f.padId === padId);
    if (filesToDelete.length > 0) {
      this.store.removeFilesMany(filesToDelete.map((f) => f.id));
    }
    for (const file of filesToDelete) {
      this.broadcast.toPad(padId, { type: 'file-deleted', padId, fileId: file.id });
    }
    this.store.removePad(padId);
    this.broadcast.toAll({ type: 'pad-deleted', padId });
    // Disk cleanup after DB is consistent; safeUnlink swallows ENOENT.
    await Promise.all(
      filesToDelete.map((file) => safeUnlink(path.join(this.store.FILES_DIR, file.filename)))
    );

    return { ok: true, deletedFiles: filesToDelete.length };
  }

  async unlockPad(padId: number, password: string) {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');
    if (!pad.password) return { ok: true, token: null };

    const isValid = await verifyPassword(password, pad.password);
    if (!isValid) throw ForbiddenError('Wrong password');

    const token = this.createUnlockToken(padId);
    return { ok: true, token };
  }

  getCleanupTimer() {
    return this.unlockCleanupTimer;
  }
}

export = PadService;
