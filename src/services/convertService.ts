'use strict';

import type { DataStore, Broadcast, FileInfo } from '../types';
const path = require('path');
const fs = require('fs');
const { Worker } = require('worker_threads');
const {
  AppError,
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  ConflictError,
  ServiceUnavailableError,
  RequestTimeoutError,
} = require('../utils/errors');
const { generateId } = require('../utils/crypto');
const {
  canAccessFile: authCanAccessFile,
  canManagePad,
  resolveFileOwner,
} = require('../utils/auth');
const {
  CONVERT_MAX_BYTES,
  CONVERT_TIMEOUT_MS,
  CONVERT_MAX_CONCURRENT,
  CONVERT_WORKER_HEAP_MB,
  CONVERTIBLE_EXTS,
  CONVERT_FEATURES,
  MAX_STORAGE_BYTES,
  MAX_STORAGE_BYTES_PER_USER,
} = require('../config');
const logger = require('../utils/logger');
const { safeUnlink } = require('../utils/file');
const storageQuota = require('./storageQuota');

const MAX_CONCURRENT_CONVERTS = CONVERT_MAX_CONCURRENT;

class ConvertService {
  store: DataStore;
  broadcast: Broadcast;
  convertingFiles: Set<string>;
  activeConverts: number;

  constructor(store: DataStore, broadcast: Broadcast) {
    this.store = store;
    this.broadcast = broadcast;
    this.convertingFiles = new Set();
    this.activeConverts = 0;
  }

  getCapabilities() {
    return {
      extensions: CONVERTIBLE_EXTS,
      maxBytes: CONVERT_MAX_BYTES,
      timeoutMs: CONVERT_TIMEOUT_MS,
      features: CONVERT_FEATURES,
    };
  }

  _hasAccessGrant(grantor: string | null, grantee: string | null): boolean {
    return this.store.hasAccessGrant(grantor, grantee);
  }

  getFileById(fileId: string): FileInfo | null {
    return this.store.findFileById(fileId) || null;
  }

  async convert(userId: string | null, isAdminUser: boolean, fileId: string) {
    if (this.activeConverts >= MAX_CONCURRENT_CONVERTS) {
      throw ServiceUnavailableError('Too many conversions in progress, try again shortly');
    }
    this.activeConverts++;
    let mdDiskPath = null;
    let lockAcquired = false;

    try {
      const file = this.store.findFileById(fileId);
      if (!file) throw NotFoundError('File not found');

      // Use shared auth helper for file access check
      const hasGrant = this._hasAccessGrant.bind(this);
      if (!authCanAccessFile(userId, file, this.store.findPadById.bind(this.store), hasGrant)) {
        throw ForbiddenError('Access denied');
      }

      if (file.originalName.toLowerCase().endsWith('.md')) {
        throw BadRequestError('Markdown files cannot be converted');
      }

      const pad = this.store.findPadById(file.padId);
      if (!pad) throw NotFoundError('Pad not found on disk');

      // Conversion REPLACES the source (removeFile + unlink below), so it is a
      // destructive write, not a read. The read-level canAccessFile check above
      // is not enough: without this gate a write-grant holder could destroy
      // another owner's attachment while bypassing deleteFile's manage rules.
      // Same relaxation shape as deleteFile: pad managers (owner/admin) always;
      // the upload's own owner; authenticated destruction of an unowned
      // legacy/public-pad upload. Anonymous → 403.
      if (!canManagePad(userId, isAdminUser, pad)) {
        if (file.ownerUserId) {
          if (userId !== file.ownerUserId) throw ForbiddenError('Access denied');
        } else if (!userId) {
          throw ForbiddenError('Access denied');
        }
      }

      const filepath = path.join(this.store.FILES_DIR, file.filename);
      let stat;
      try {
        stat = await fs.promises.stat(filepath);
      } catch {
        throw NotFoundError('File not found on disk');
      }
      if (stat.size > CONVERT_MAX_BYTES) {
        throw BadRequestError('File too large to convert');
      }

      // Prevent concurrent converts of the same file
      if (this.convertingFiles.has(fileId)) {
        throw ConflictError('Conversion already in progress');
      }
      this.convertingFiles.add(fileId);
      lockAcquired = true;

      const ext = path.extname(file.originalName).toLowerCase();
      let markdown;
      try {
        const buffer = await fs.promises.readFile(filepath);
        markdown = await this._convertInWorker(buffer, ext, file.mimeType, file.originalName);
      } catch (e: any) {
        if (e.message === 'CONVERT_TIMEOUT') {
          throw RequestTimeoutError('Conversion timed out');
        }
        if (e.message === 'UNSUPPORTED_FILE_TYPE' || e.code === 'UNSUPPORTED_FILE_TYPE') {
          throw new AppError('Unsupported file type', 415, 'UNSUPPORTED_FILE_TYPE');
        }
        if (e.code === 'CONVERSION_INPUT_ERROR') {
          throw new AppError('File could not be converted', 422, 'CONVERSION_INPUT_ERROR');
        }
        logger.error({ err: e }, 'Convert error');
        throw BadRequestError('Conversion failed');
      }

      const mdId = generateId();
      const rawBase = path.basename(file.originalName, path.extname(file.originalName));
      const safeBaseName = rawBase.replace(/[^a-zA-Z0-9._-]/g, '_') || 'file';
      const safeMdName = `${safeBaseName}.md`;
      const mdDiskName = `${mdId}_${safeMdName}`;
      mdDiskPath = path.join(this.store.FILES_DIR, mdDiskName);

      // The converted markdown is a NEW row (≤50MB output cap) — instance and
      // per-owner quotas must apply here exactly as they do on upload, or
      // conversion becomes a quota bypass. Checked BEFORE the disk write so a
      // rejected conversion leaves neither an orphan md file nor a changed
      // source.
      const mdSize = Buffer.byteLength(markdown, 'utf8');
      const quotaOwner = resolveFileOwner(userId, pad);
      // Reserved in the same synchronous block as the checks below, for the
      // same reason as the upload path: the write and the row insert are
      // separated by `await writeFile`, so without this every overlapping
      // conversion reads the same committed total. Conversion mints a brand
      // new row, so an unshared counter here would make it a quota bypass.
      const releaseQuota = storageQuota.reserve(mdSize, quotaOwner);
      try {
        if (storageQuota.used(this.store.sumFileBytes()) > MAX_STORAGE_BYTES) {
          throw new AppError('Storage quota exceeded', 413, 'STORAGE_QUOTA');
        }
        if (
          quotaOwner &&
          storageQuota.usedBy(this.store.sumFileBytes(quotaOwner), quotaOwner) >
            MAX_STORAGE_BYTES_PER_USER
        ) {
          throw new AppError('Storage quota exceeded for this account', 413, 'STORAGE_QUOTA');
        }

        await fs.promises.writeFile(mdDiskPath, markdown, 'utf8');

        const mdFile = {
          id: mdId,
          filename: mdDiskName,
          originalName: safeMdName,
          size: mdSize,
          mimeType: 'text/markdown',
          createdAt: Date.now(),
          ownerUserId: pad.ownerUserId || userId || null,
          padId: file.padId,
        };

        this.store.createFile(mdFile);
        // The row accounts for its own bytes from here on, and releasing
        // before any await keeps the accounting exact.
        releaseQuota();
        this.store.removeFile(fileId);
        await safeUnlink(filepath);

        this.broadcast.toPad(file.padId, {
          type: 'file-deleted',
          padId: file.padId,
          fileId: file.id,
        });
        this.broadcast.toPad(mdFile.padId, {
          type: 'file-added',
          padId: mdFile.padId,
          file: mdFile,
        });

        return mdFile;
      } finally {
        // Idempotent: a no-op once the conversion committed above.
        releaseQuota();
      }
    } finally {
      if (lockAcquired) this.convertingFiles.delete(fileId);
      this.activeConverts--;
    }
  }

  _convertInWorker(
    buffer: Buffer,
    ext: string,
    mimeType: string,
    originalName: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, '../../convert-worker.js'), {
        workerData: { buffer, ext, mimeType, originalName, maxBytes: CONVERT_MAX_BYTES },
        resourceLimits: { maxOldGenerationSizeMb: CONVERT_WORKER_HEAP_MB },
      });
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;

      // `terminate()` stops the worker thread, but NOT any worker that thread
      // spawned: read-excel-file runs its XLSX parser in a nested worker
      // (worker-f) that this process holds no handle on, and Node gives us no
      // way to reach it (so no resourceLimits can be handed to it). So: await
      // the termination (the previous code fired and forgot, leaving the
      // outer thread's teardown unobserved), and bound the grandchild the
      // only way left — assertSafeArchive in convert-worker.js inflates every
      // entry through a capped streaming pipe BEFORE parsing (memory stays
      // bounded even when central-directory sizes lie) and concurrency is
      // capped.
      const stopWorker = async (why: string) => {
        if (timer) clearTimeout(timer);
        timer = null;
        try {
          await worker.terminate();
        } catch (err) {
          logger.warn({ err, why }, 'Failed to terminate convert worker');
        }
      };

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        void stopWorker('timeout');
        reject(new Error('CONVERT_TIMEOUT'));
      }, CONVERT_TIMEOUT_MS);

      worker.on('message', (msg: any) => {
        if (settled) return;
        settled = true;
        void stopWorker('message');
        if (msg.ok) resolve(msg.markdown);
        else {
          const err = Object.assign(new Error(msg.error || 'Conversion failed'), {
            code: msg.code || 'CONVERSION_FAILED',
          });
          reject(err);
        }
      });
      worker.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        void stopWorker('error');
        logger.warn({ err }, 'Convert worker errored');
        reject(err);
      });
      worker.on('exit', (code: number) => {
        if (settled) return;
        settled = true;
        void stopWorker('exit');
        if (code !== 0) {
          reject(new Error(`Worker exited with code ${code}`));
        } else {
          reject(new Error('Conversion completed without producing output'));
        }
      });
    });
  }
}

export = ConvertService;
