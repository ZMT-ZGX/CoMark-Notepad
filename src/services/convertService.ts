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
const { canAccessFile: authCanAccessFile } = require('../utils/auth');
const {
  CONVERT_MAX_BYTES,
  CONVERT_TIMEOUT_MS,
  CONVERTIBLE_EXTS,
  CONVERT_FEATURES,
} = require('../config');
const logger = require('../utils/logger');

const MAX_CONCURRENT_CONVERTS = 3;

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

  async convert(userId: string | null, fileId: string) {
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

      await fs.promises.writeFile(mdDiskPath, markdown, 'utf8');

      const targetPad = this.store.findPadById(file.padId);
      const mdFile = {
        id: mdId,
        filename: mdDiskName,
        originalName: safeMdName,
        size: Buffer.byteLength(markdown, 'utf8'),
        mimeType: 'text/markdown',
        createdAt: Date.now(),
        ownerUserId: targetPad?.ownerUserId || userId || null,
        padId: file.padId,
      };

      this.store.createFile(mdFile);
      this.store.removeFile(fileId);
      try {
        fs.unlinkSync(filepath);
      } catch {}

      this.broadcast.toPad(file.padId, {
        type: 'file-deleted',
        padId: file.padId,
        fileId: file.id,
      });
      this.broadcast.toPad(mdFile.padId, { type: 'file-added', padId: mdFile.padId, file: mdFile });

      return mdFile;
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
        workerData: { buffer, ext, mimeType, originalName },
        resourceLimits: { maxOldGenerationSizeMb: 512 },
      });
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        worker.terminate().catch(() => {});
        reject(new Error('CONVERT_TIMEOUT'));
      }, CONVERT_TIMEOUT_MS);

      worker.on('message', (msg: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate().catch(() => {});
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
        clearTimeout(timer);
        worker.terminate().catch(() => {});
        reject(err);
      });
      worker.on('exit', (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
