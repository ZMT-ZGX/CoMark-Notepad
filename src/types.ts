/**
 * Core type definitions for CoMark-Notepad.
 *
 * These types describe every entity persisted in the JSON store and every
 * message exchanged over WebSocket.  Zod schemas in `src/validators/`
 * should stay aligned with the shapes defined here.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Request } from 'express';
import type { WebSocket } from 'ws';

// ── Entities ────────────────────────────────────────────────────────

export interface Pad {
  id: number;
  text: string;
  textVersion: number;
  password: string | null;
  createdAt: number;
  ownerUserId: string | null;
  creatorCode: string | null;
}

export interface FileInfo {
  id: string;
  filename: string;
  originalName: string;
  size: number;
  mimeType: string;
  createdAt: number;
  ownerUserId: string | null;
  padId: number;
}

export interface User {
  code: string;
  createdAt: number;
}

export interface Invitation {
  token: string;
  creatorCode: string | null;
  maxUses: number;
  useCount: number;
  expiresAt: number | null;
  createdAt: number;
}

export interface AccessGrant {
  inviteToken: string;
  grantorCode: string | null;
  granteeCode: string | null;
  grantedAt: number;
}

// ── Store (JSON persistence) ────────────────────────────────────────

export interface StoreState {
  pads: Pad[];
  files: FileInfo[];
  users: User[];
  inviteTokens: Invitation[];
  accessGrants: AccessGrant[];
  revokedTokens: Record<string, number>;
}

// ── WebSocket messages ──────────────────────────────────────────────

export interface WsTextUpdate {
  type: 'text-update';
  padId: number;
  text: string;
  textVersion: number;
}

export interface WsPatch {
  type: 'patch';
  padId: number;
  data: string;
  text?: string;
  textVersion: number;
  senderId: string | null;
  operationId?: string;
  baseVersion?: number;
}

export interface WsPatchAck {
  type: 'patch-ack';
  textVersion: number;
  text?: string;
  seq?: number;
}

// Server → sender only. Issued when a patch fails to apply (concurrent
// conflict or malformed data). Carries the authoritative text so the client
// can reset its shadow and avoid permanent divergence.
export interface WsPatchNack {
  type: 'patch-nack';
  padId: number;
  text: string;
  textVersion: number;
}

export interface WsFileAdded {
  type: 'file-added';
  padId: number;
  file: FileInfo;
}

export interface WsFileDeleted {
  type: 'file-deleted';
  padId: number;
  fileId: string;
}

export interface WsPadCreated {
  type: 'pad-created';
  pad: PadMeta;
}

export interface WsPadDeleted {
  type: 'pad-deleted';
  padId: number;
}

export interface WsPadUpdated {
  type: 'pad-updated';
  pad: PadMeta;
}

export interface WsOnlineCount {
  type: 'online-count';
  count: number;
}

export interface WsHello {
  type: 'hello';
  wsId: string;
  padId: number;
  userId: string | null;
}

export type WsMessage =
  | WsTextUpdate
  | WsPatch
  | WsPatchAck
  | WsPatchNack
  | WsFileAdded
  | WsFileDeleted
  | WsPadCreated
  | WsPadDeleted
  | WsPadUpdated
  | WsOnlineCount
  | WsHello;

export type PadMeta = Pick<Pad, 'id' | 'createdAt'> & {
  hasPassword: boolean;
  ownerUserId: string | null;
};

// ── Express extensions ──────────────────────────────────────────────

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      userId?: string | null;
    }
  }
}

// ── WebSocket extensions ────────────────────────────────────────────

export interface CoMarkWebSocket extends WebSocket {
  clientId: string;
  padId: number;
  userId: string | null;
  ipAddress: string;
  isAlive: boolean;
  // Per-connection patch rate-limit state (fixed window). See ws/index.ts.
  patchWindowStart: number;
  patchCount: number;
}

// ── Config ──────────────────────────────────────────────────────────

export interface AppConfig {
  PORT: number;
  DATA_DIR: string;
  FILES_DIR: string;
  STORE_FILE: string;
  SQLITE_FILE: string;
  MAX_FILE_BYTES: number;
  JSON_BODY_LIMIT: number;
  HEARTBEAT_INTERVAL_MS: number;
  UNLOCK_TOKEN_TTL_MS: number;
  MAX_PADS: number;
  FILE_TTL_HOURS: number;
  FILE_TTL_CHECK_INTERVAL_MS: number;
  CONVERT_MAX_BYTES: number;
  CONVERT_TIMEOUT_MS: number;
  MAX_PASSWORD_LENGTH: number;
  ADMIN_TOKEN: string | null;
  MAX_WS_CONNECTIONS: number;
  MAX_WS_CONNECTIONS_PER_IP: number;
  WS_PATCH_WINDOW_MS: number;
  MAX_WS_PATCHES_PER_WINDOW: number;
  CONVERTIBLE_EXTS: string[];
  CONVERT_FEATURES: Record<string, boolean>;
  isProduction: boolean;
  SESSION_SECRET: string;
  SESSION_TOKEN_TTL_DAYS: number;
  PUBLIC_ORIGIN: string;
  cookieFlags: string;
}

// ── Data Store interface ────────────────────────────────────────────

export interface DataStore {
  rawStore: IJSONStore;
  FILES_DIR: string;

  // Pad
  findPadById(id: number): Pad | undefined;
  findAllPads(): Pad[];
  padExists(id: number): boolean;
  createPad(pad: Partial<Pad> & { ownerUserId?: string | null; creatorCode?: string | null }): Pad;
  updatePadText(id: number, text: string): Pad | null;
  updatePadPassword(id: number, hash: string | null): Pad | null;
  removePad(id: number): void;

  // File
  findFileById(id: string): FileInfo | undefined;
  findAllFiles(): FileInfo[];
  createFile(info: FileInfo): FileInfo;
  removeFile(id: string): void;
  removeFilesByPadId(padId: number): void;
  removeFilesMany(ids: string[]): void;
  removeExpiredFiles(ttlMs: number): FileInfo[];

  // User
  userExists(code: string): boolean;
  createUser(user: User): User;

  // Invitation
  createInvitation(invite: Invitation): Invitation;
  findInvitationByToken(token: string): Invitation | undefined;
  removeInvitation(token: string): { ok: boolean; revokedGrants: number } | false;
  hasAccessGrant(grantor: string | null, grantee: string | null): boolean;
  addAccessGrant(grant: AccessGrant): void;
  listInvitationsByCreator(code: string | null): Invitation[];
  listGrantsByGrantee(code: string | null): AccessGrant[];

  // Persistence
  save(): void;
  flush(): Promise<void>;
  flushSync(): void;
}

// ── JSON Store ──────────────────────────────────────────────────────

export interface IJSONStore {
  dataDir: string;
  data: StoreState | null;
  dirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  writeLock: boolean;
  load(): Promise<void>;
  getStore(): StoreState;
  save(): void;
  flush(): Promise<void>;
  flushSync(): void;
}

// ── Broadcast ───────────────────────────────────────────────────────

export interface Broadcast {
  toPad(padId: number, data: WsMessage, excludeWsId?: string | null): void;
  toAll(data: WsMessage): void;
}

// ── Services ────────────────────────────────────────────────────────

// Compile-time type imports of service classes (no runtime circular dep)
import type PadService = require('./services/padService');
import type FileService = require('./services/fileService');
import type InviteService = require('./services/inviteService');
import type ConvertService = require('./services/convertService');

export interface Services {
  db: typeof import('./db');
  padService: PadService;
  fileService: FileService;
  inviteService: InviteService;
  convertService: ConvertService;
}

// ── Unlock token entry ──────────────────────────────────────────────

export interface UnlockTokenEntry {
  padId: number;
  expires: number;
}

// ── Convert capabilities ────────────────────────────────────────────

export interface ConvertCapabilities {
  extensions: string[];
  maxBytes: number;
  timeoutMs: number;
  features: Record<string, boolean>;
}
