'use strict';

import type { DataStore, Broadcast, FileInfo, Pad } from '../types';
const path = require('path');
const fs = require('fs');
const Busboy = require('busboy');
const { NotFoundError, ForbiddenError, BadRequestError } = require('../utils/errors');
const {
  canAccessPad,
  canAccessFile: authCanAccessFile,
  canManagePad,
  resolveFileOwner,
} = require('../utils/auth');
const { generateId } = require('../utils/crypto');
const { formatBytes, downloadBasename, safeUnlink } = require('../utils/file');
const { MAX_FILE_BYTES, MAX_STORAGE_BYTES, MAX_STORAGE_BYTES_PER_USER } = require('../config');
const logger = require('../utils/logger');
const { extractPadTokens, hasValidUnlockToken } = require('../middlewares/security');
const storageQuota = require('./storageQuota');

// A pad is public when it has neither an owner nor a creator code — accessible
// to anyone. Centralized here so the same definition is reused everywhere.
function isPublicPad(pad: Pad): boolean {
  return !pad.ownerUserId && !pad.creatorCode;
}

class FileService {
  store: DataStore;
  broadcast: Broadcast;
  padService: { isValidUnlockToken(token: unknown, padId: number): boolean } | null;

  constructor(
    store: DataStore,
    broadcast: Broadcast,
    padService: { isValidUnlockToken(token: unknown, padId: number): boolean } | null
  ) {
    this.store = store;
    this.broadcast = broadcast;
    this.padService = padService || null;
  }

  _hasAccessGrant(grantor: string | null, grantee: string | null): boolean {
    return this.store.hasAccessGrant(grantor, grantee);
  }

  canAccessPad(userId: string | null, pad: Pad): boolean {
    return canAccessPad(userId, pad, this._hasAccessGrant.bind(this));
  }

  canAccessFile(userId: string | null, file: FileInfo): boolean {
    return authCanAccessFile(
      userId,
      file,
      this.store.findPadById.bind(this.store),
      this._hasAccessGrant.bind(this)
    );
  }

  canManagePad(userId: string | null, isAdminUser: boolean, pad: Pad): boolean {
    return canManagePad(userId, isAdminUser, pad);
  }

  getFileById(fileId: string): FileInfo | null {
    return this.store.findFileById(fileId) || null;
  }

  getPadForFileById(fileId: string): Pad | null {
    const file = this.store.findFileById(fileId);
    if (!file || file.padId == null) return null;
    return this.store.findPadById(file.padId) || null;
  }

  async upload(req: any, res: any) {
    const contentType = req.headers['content-type'] || '';
    if (!contentType.startsWith('multipart/form-data')) {
      throw BadRequestError('multipart/form-data required');
    }

    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        defParamCharset: 'utf8',
        limits: { files: 1, fileSize: MAX_FILE_BYTES, fields: 8, parts: 9 },
      });
    } catch {
      throw BadRequestError('Invalid multipart form data');
    }

    let excludeWsId: string | undefined = undefined;
    let padIdField: number | null = null;
    let fileInfo: import('../types').FileInfo | null = null;
    let filePath: string | null = null;
    // Uploads stream into a `.part` sibling and are renamed into place only
    // after the stream finishes, so a concurrent lister/downloader can never
    // observe a half-written file (rename is atomic on the same filesystem).
    let partPath: string | null = null;
    // True once the `files` row exists. From that point the on-disk file is
    // owned by the store and must survive even if cleanup runs.
    let committed = false;
    let writeStream: ReturnType<typeof fs.createWriteStream> | null = null;
    let fileWritePromise: Promise<void> | null = null;
    let fileSeen = false;
    let fileLimitReached = false;
    let finished = false;
    let aborted = false;
    let busboyFinished = false;
    let uploadAccessDenied = false;

    const cleanupPartialFile = () => {
      if (writeStream) {
        writeStream.destroy();
        writeStream = null;
      }
      // Two shapes of leftover, and both are invisible to TTL cleanup (which
      // only walks the `files` table): the `.part` temp file before the
      // rename, and the promoted file after it but before the DB row. Leaving
      // the second behind is what made rejected uploads accumulate on disk.
      const stalePaths = [partPath, committed ? null : filePath];
      partPath = null;
      filePath = null;
      for (const stale of stalePaths) {
        // Fire-and-forget: callers are synchronous busboy event handlers, and
        // safeUnlink swallows ENOENT, so no existsSync probe is needed.
        if (stale) void safeUnlink(stale);
      }
    };

    const fail = (status: number, error: string) => {
      if (finished || res.headersSent) return;
      finished = true;
      cleanupPartialFile();
      res.status(status).json({ error });
    };

    // Detect a genuine client-side abort. `req.on('aborted')` has been deprecated
    // since Node 16; the supported replacement is `req.on('close')` combined with
    // a check that the request body was NOT fully received (`req.complete`). We
    // must NOT key off `req.destroyed`, which also becomes true during the normal
    // end-of-request teardown once the body has been read — larger multipart
    // bodies make `close` fire (with destroyed=true) before busboy's `finish`, so
    // the old check aborted valid uploads mid-write and the request hung forever
    // waiting on a write promise that never settled.
    req.on('close', () => {
      if (req.complete) return; // body fully received → normal completion, not an abort
      if (!finished && !busboyFinished) {
        aborted = true;
        cleanupPartialFile();
      }
    });

    busboy.on('field', (name: string, value: string) => {
      if (name === '_wsId') excludeWsId = String(value || '');
      if (name === 'padId') padIdField = Number(value) || null;
    });

    busboy.on('filesLimit', () => fail(400, 'Only one file allowed'));
    busboy.on('partsLimit', () => fail(400, 'Too many form parts'));

    busboy.on(
      'file',
      (name: string, file: any, info: { filename: string; mimeType: string; encoding: string }) => {
        if (name !== 'file' || fileSeen) {
          file.resume();
          return;
        }
        fileSeen = true;

        const originalName = downloadBasename(info.filename, '');
        if (!originalName) {
          file.resume();
          return;
        }

        const id = generateId();
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
        const filename = `${id}_${safeName}`;
        filePath = path.join(this.store.FILES_DIR, filename);
        partPath = `${filePath}.part`;

        // Early access check
        if (padIdField !== null) {
          const earlyPad = this.store.findPadById(padIdField);
          if (earlyPad && !this.canAccessPad(req.userId, earlyPad)) {
            uploadAccessDenied = true;
            file.resume();
            return;
          }
        }

        fileInfo = {
          id,
          filename,
          originalName,
          size: 0,
          mimeType: (info.mimeType || 'application/octet-stream').toLowerCase(),
          createdAt: Date.now(),
          ownerUserId: null,
          padId: 1,
        } as import('../types').FileInfo;

        writeStream = fs.createWriteStream(partPath, { flags: 'wx' });
        fileWritePromise = new Promise((resolve, reject) => {
          writeStream.on('finish', resolve);
          writeStream.on('error', reject);
          file.on('error', reject);
        });
        fileWritePromise.catch(() => {});

        file.on('limit', () => {
          fileLimitReached = true;
          if (writeStream) writeStream.destroy(new Error('File too large'));
        });

        file.pipe(writeStream);
        file.on('data', (chunk: Buffer) => {
          if (fileInfo) fileInfo.size += chunk.length;
        });
      }
    );

    busboy.on('error', () => fail(400, 'Invalid multipart form data'));

    busboy.on('finish', async () => {
      busboyFinished = true;
      if (finished || aborted) return;
      if (uploadAccessDenied) {
        finished = true;
        if (!res.headersSent) res.status(403).json({ error: 'Access denied' });
        return;
      }
      if (!fileSeen || !fileInfo) return fail(400, 'file required');
      if (fileLimitReached) return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);

      try {
        await fileWritePromise;
      } catch (err) {
        if (finished || aborted) return;
        if (fileLimitReached)
          return fail(413, `File too large (max ${formatBytes(MAX_FILE_BYTES)})`);
        logger.error({ err }, 'Failed to save upload');
        return fail(500, 'Failed to save upload');
      }

      if (finished || aborted) return;

      // Resolve + authorize BEFORE promoting the temp file.
      //
      // Ordering is a security property, not a style choice. Once renamed, the
      // bytes sit on disk with no `files` row, and TTL cleanup only walks that
      // table — so any rejection after the rename leaves a file nothing will
      // ever collect. An unauthenticated client could then fill the disk
      // (100MB per request, 20 uploads / 15min per IP) by uploading to a pad id
      // that does not exist, or to a pad it cannot access.
      //
      // This must also run after busboy has finished: the `padId` field may
      // arrive *after* the file part, so the early check in the `file` handler
      // is best-effort only and this one is authoritative.
      const targetPadId = padIdField || this.store.findAllPadMeta()[0]?.id || 1;
      const targetPad = this.store.findPadById(targetPadId);
      if (!targetPad) return fail(404, 'Pad not found');

      // Authoritative access check
      if (!this.canAccessPad(req.userId, targetPad)) return fail(403, 'Access denied');

      // Pad lock check — header only (query tokens land in access / proxy logs).
      // Use shared extractPadTokens so comma-separated multi-token headers work.
      if (
        targetPad.password &&
        (!this.padService ||
          !hasValidUnlockToken(this.padService, extractPadTokens(req), targetPad.id))
      ) {
        return fail(403, 'Pad locked');
      }

      // ── Storage quota ────────────────────────────────────────────
      // Checked before the rename so a rejected upload leaves nothing on
      // disk: `fail()` runs cleanupPartialFile(). Without this an account
      // could upload 100MB files until the disk filled.
      //
      // The bytes are reserved here, in the same synchronous block as the
      // check and before the first `await` below — see reserveStorageQuota.
      const incomingSize = fileInfo ? fileInfo.size : 0;
      const quotaOwner = resolveFileOwner(req.userId, targetPad);
      const releaseQuota = storageQuota.reserve(incomingSize, quotaOwner);
      try {
        const usedTotal = storageQuota.used(this.store.sumFileBytes());
        if (usedTotal > MAX_STORAGE_BYTES) {
          logger.warn('upload rejected: instance storage quota exceeded', {
            used: usedTotal,
            incomingSize,
            limit: MAX_STORAGE_BYTES,
          });
          return fail(413, 'Storage quota exceeded');
        }
        if (quotaOwner) {
          const usedByUser = storageQuota.usedBy(this.store.sumFileBytes(quotaOwner), quotaOwner);
          if (usedByUser > MAX_STORAGE_BYTES_PER_USER) {
            logger.warn('upload rejected: per-account storage quota exceeded', {
              ownerUserId: quotaOwner,
              used: usedByUser,
              incomingSize,
              limit: MAX_STORAGE_BYTES_PER_USER,
            });
            return fail(413, 'Storage quota exceeded for this account');
          }
        }

        // Promote the completed `.part` file to its final name. After this
        // point the file is immutable content, so a reader that wins the race
        // sees the whole file or none of it — never a partial body.
        if (!partPath || !filePath) return fail(500, 'Upload target missing');
        try {
          await fs.promises.rename(partPath, filePath);
          partPath = null;
        } catch (err) {
          logger.error({ err }, 'Failed to finalize upload');
          return fail(500, 'Failed to save upload');
        }

        if (finished || aborted) return;

        if (!fileInfo) return fail(500, 'File info missing');
        const finalInfo = fileInfo as import('../types').FileInfo;
        finalInfo.ownerUserId = resolveFileOwner(req.userId, targetPad);
        finalInfo.padId = targetPadId;

        committed = true;
        this.store.createFile(finalInfo);
        // The row is in the table, so it accounts for its own bytes from here
        // on. Releasing before any await keeps the accounting exact — a
        // concurrent upload sees either the reservation or the row, never both.
        releaseQuota();
        this.broadcast.toPad(
          finalInfo.padId,
          { type: 'file-added', padId: finalInfo.padId, file: finalInfo },
          excludeWsId
        );
        finished = true;
        if (!res.headersSent) res.json(finalInfo);
      } finally {
        // Idempotent: a no-op once the upload committed above.
        releaseQuota();
      }
    });

    req.pipe(busboy);
  }

  async downloadFile(
    userId: string | null,
    fileId: string,
    unlockTokens: string[] = []
  ): Promise<{ file: FileInfo; filepath: string }> {
    const file = this.store.findFileById(fileId);
    if (!file) throw NotFoundError('File not found');
    if (!this.canAccessFile(userId, file)) throw NotFoundError('File not found');
    // Do not coerce missing padId to 1 — that mis-attributes lock checks.
    if (file.padId == null) throw NotFoundError('File not found');
    const pad = this.store.findPadById(file.padId);
    if (!pad) throw NotFoundError('File not found');
    if (
      pad.password &&
      (!this.padService || !hasValidUnlockToken(this.padService, unlockTokens, pad.id))
    ) {
      throw ForbiddenError('Pad locked');
    }
    const filepath = path.join(this.store.FILES_DIR, file.filename);
    return { file, filepath };
  }

  async deleteFile(
    userId: string | null,
    isAdminUser: boolean,
    fileId: string,
    excludeWsId: string | undefined
  ) {
    const file = this.store.findFileById(fileId);
    if (!file) throw NotFoundError('File not found');
    if (file.padId == null) throw NotFoundError('File not found');

    const pad = this.store.findPadById(file.padId);
    if (!pad) throw NotFoundError('Pad not found');

    // Permission check — ownership is the primary gate.
    //
    // The old rule short-circuited on "pad is public" and then ignored
    // ownership entirely. That was written for a single-user local notepad; on
    // a public deployment it means any self-registered identity can delete
    // anyone else's file, and registration is open to anyone
    // (POST /api/auth/register). User codes are persisted in SQLite and the
    // session cookie lives 30 days, so identity is not actually ephemeral —
    // ownership is a reliable gate.
    const padIsPublic = isPublicPad(pad);
    if (file.ownerUserId) {
      if (userId !== file.ownerUserId && !isAdminUser) {
        if (!this.canManagePad(userId, isAdminUser, pad)) {
          throw ForbiddenError('Access denied');
        }
      }
    } else if (padIsPublic && userId) {
      // Unowned file on a public pad (legacy / guest upload): any
      // authenticated user may remove it. Owned pads never produce unowned
      // files, so this does not weaken private-pad safety.
    } else {
      // Unowned file (e.g. uploaded by a guest to a public pad). The route
      // already rejects anonymous deletions of unowned files with 401, so here
      // any authenticated user may remove it. Restricted (owned) pads never
      // produce unowned files, so this does not weaken private-pad safety.
      if (!userId && !isAdminUser) {
        throw ForbiddenError('Access denied');
      }
    }

    this.store.removeFile(fileId);
    // Awaited so the response reflects the file actually being gone; async
    // unlink instead of unlinkSync keeps disk I/O off the event loop.
    await safeUnlink(path.join(this.store.FILES_DIR, file.filename));
    this.broadcast.toPad(
      file.padId,
      { type: 'file-deleted', padId: file.padId, fileId },
      excludeWsId
    );
    return { ok: true };
  }

  async clearFiles(
    userId: string | null,
    isAdminUser: boolean,
    padId: number,
    excludeWsId: string | undefined
  ) {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    const padIsPublic = isPublicPad(pad);
    if (!padIsPublic) {
      // Owned pad: only a pad manager (owner/admin) may clear.
      if (!this.canManagePad(userId, isAdminUser, pad)) {
        throw ForbiddenError('Access denied');
      }
    } else if (!userId && !isAdminUser) {
      throw ForbiddenError('Access denied');
    }

    // A public pad has no owner who could authorize a bulk delete, so scope
    // the wipe to the caller's own files (plus unowned legacy ones). Letting
    // any authenticated identity clear the whole pad turned one registration
    // into a way to destroy every other user's uploads.
    let toDelete = this.store.findAllFiles().filter((f) => f.padId === padId);
    if (padIsPublic && !isAdminUser) {
      toDelete = toDelete.filter((f) => !f.ownerUserId || f.ownerUserId === userId);
    }
    // Remove DB rows first so a crash between DB and disk leaves orphan
    // files (harmless) rather than orphan DB rows pointing to missing files.
    if (toDelete.length > 0) {
      this.store.removeFilesMany(toDelete.map((f) => f.id));
    }
    for (const file of toDelete) {
      this.broadcast.toPad(padId, { type: 'file-deleted', padId, fileId: file.id }, excludeWsId);
    }
    // Disk cleanup after DB is consistent; safeUnlink swallows ENOENT.
    await Promise.all(
      toDelete.map((file) => safeUnlink(path.join(this.store.FILES_DIR, file.filename)))
    );
    return { ok: true, cleared: toDelete.length };
  }
}

export = FileService;
