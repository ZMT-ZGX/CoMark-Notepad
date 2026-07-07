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
const { formatBytes, downloadBasename } = require('../utils/file');
const { MAX_FILE_BYTES } = require('../config');
const logger = require('../utils/logger');

class FileService {
  store: DataStore;
  broadcast: Broadcast;
  padService: { isValidUnlockToken(token: unknown, padId: number): boolean } | null;

  constructor(store: DataStore, broadcast: Broadcast, padService: { isValidUnlockToken(token: unknown, padId: number): boolean } | null) {
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
    if (!file) return null;
    return this.store.findPadById(file.padId ?? 1) || null;
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
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch {}
      }
      filePath = null;
    };

    const fail = (status: number, error: string) => {
      if (finished || res.headersSent) return;
      finished = true;
      cleanupPartialFile();
      res.status(status).json({ error });
    };

    req.on('close', () => {
      if (!finished && req.destroyed && !busboyFinished) {
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

    busboy.on('file', (name: string, file: any, info: { filename: string; mimeType: string; encoding: string }) => {
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

      writeStream = fs.createWriteStream(filePath, { flags: 'wx' });
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
    });

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

      // Resolve file ownership and pad association
      const targetPadId = padIdField || this.store.findAllPads()[0]?.id || 1;
      const targetPad = this.store.findPadById(targetPadId);
      if (!targetPad) return fail(404, 'Pad not found');

      // Authoritative access check
      if (!this.canAccessPad(req.userId, targetPad)) return fail(403, 'Access denied');

      // Pad lock check
      if (
        targetPad.password &&
        (!this.padService ||
          !this.padService.isValidUnlockToken(
            req.headers['x-pad-token'] || req.query?.padToken,
            targetPad.id
          ))
      ) {
        return fail(403, 'Pad locked');
      }

      if (!fileInfo) return fail(500, 'File info missing');
      const finalInfo = fileInfo as import('../types').FileInfo;
      finalInfo.ownerUserId = resolveFileOwner(req.userId, targetPad);
      finalInfo.padId = targetPadId;

      this.store.createFile(finalInfo);
      this.broadcast.toPad(finalInfo.padId, { type: 'file-added', padId: finalInfo.padId, file: finalInfo }, excludeWsId);
      finished = true;
      if (!res.headersSent) res.json(finalInfo);
    });

    req.pipe(busboy);
  }

  async downloadFile(userId: string | null, fileId: string, unlockToken: string | undefined): Promise<{ file: FileInfo; filepath: string }> {
    const file = this.store.findFileById(fileId);
    if (!file) throw NotFoundError('File not found');
    if (!this.canAccessFile(userId, file)) throw NotFoundError('File not found');
    const pad = this.store.findPadById(file.padId ?? 1);
    if (
      pad?.password &&
      (!this.padService || !this.padService.isValidUnlockToken(unlockToken, pad.id))
    ) {
      throw ForbiddenError('Pad locked');
    }
    const filepath = path.join(this.store.FILES_DIR, file.filename);
    return { file, filepath };
  }

  async deleteFile(userId: string | null, isAdminUser: boolean, fileId: string, excludeWsId: string | undefined) {
    const file = this.store.findFileById(fileId);
    if (!file) throw NotFoundError('File not found');

    const pad = this.store.findPadById(file.padId ?? 1);
    if (!pad) throw NotFoundError('Pad not found');

    // Permission check
    if (file.ownerUserId) {
      if (userId !== file.ownerUserId && !isAdminUser) {
        if (!this.canManagePad(userId, isAdminUser, pad)) {
          throw ForbiddenError('Access denied');
        }
      }
    } else {
      if (!this.canManagePad(userId, isAdminUser, pad)) {
        throw ForbiddenError('Access denied');
      }
    }

    this.store.removeFile(fileId);
    try {
      fs.unlinkSync(path.join(this.store.FILES_DIR, file.filename));
    } catch {}
    this.broadcast.toPad(file.padId ?? 1, { type: 'file-deleted', padId: file.padId ?? 1, fileId }, excludeWsId);
    return { ok: true };
  }

  async clearFiles(userId: string | null, isAdminUser: boolean, padId: number, excludeWsId: string | undefined) {
    const pad = this.store.findPadById(padId);
    if (!pad) throw NotFoundError('Pad not found');

    if (!this.canManagePad(userId, isAdminUser, pad)) {
      throw ForbiddenError('Access denied');
    }

    const toDelete = this.store.findAllFiles().filter((f) => f.padId === padId);
    for (const file of toDelete) {
      try {
        fs.unlinkSync(path.join(this.store.FILES_DIR, file.filename));
      } catch {}
    }
    if (toDelete.length > 0) {
      this.store.removeFilesMany(toDelete.map((f) => f.id));
    }
    for (const file of toDelete) {
      this.broadcast.toPad(padId, { type: 'file-deleted', padId, fileId: file.id }, excludeWsId);
    }
    return { ok: true, cleared: toDelete.length };
  }
}

export = FileService;
