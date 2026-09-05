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
  displayName: string | null;
}

export interface WriteAccessStatus {
  allowed: boolean;
  // 'open' — the gate is off entirely (LAN / single-user installs).
  // 'passphrase' | 'admin' — an active grant backs this decision.
  source: 'open' | 'passphrase' | 'admin' | null;
  expiresAt: number | null;
  permanent: boolean;
  // Whole days remaining; null when there is no expiry or no access.
  daysRemaining: number | null;
}

// Write-access grant. Bound to a user code (not a cookie) so an admin can
// list, grant and revoke it server-side. expiresAt === null means permanent.
export interface WriteGrant {
  userCode: string;
  // 'passphrase' — redeemed a time-limited code; 'admin' — granted by an admin.
  source: 'passphrase' | 'admin';
  grantedAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  grantedBy: string | null;
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

// Broadcast frame for remote edits. Carries the diff only — the receiver
// reconstructs the body by applying `data` to its shadow; a receiver whose
// shadow can't take the patch resyncs over HTTP (GET pad text). Sending the
// authoritative body alongside the diff doubled outbound bytes per keystroke
// for a fallback the failure path already covers.
export interface WsPatch {
  type: 'patch';
  padId: number;
  data: string;
  textVersion: number;
  senderId: string | null;
  operationId?: string;
  baseVersion?: number;
}

// Sender-only confirmation. Because the server applies a patch only when the
// client-supplied baseVersion matches its current textVersion, an ack implies
// the server body now equals the text the client sent — so the ack carries no
// body. `seq` lets the client match the ack to its single in-flight op.
export interface WsPatchAck {
  type: 'patch-ack';
  textVersion: number;
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

// Lightweight presence relay: the server never interprets presence state, it
// just rebroadcasts it to the pad (minus the sender) and announces removal on
// disconnect. `gone` frames have no user-supplied fields. Clients prune stale
// entries by timestamp, so a missed `gone` self-heals.
export interface WsPresence {
  type: 'presence';
  padId: number;
  wsId: string;
  name?: string;
  active?: boolean;
  gone?: boolean;
}

// Server → all existing pad clients when a new client joins, so the newcomer
// can be greeted with an immediate presence snapshot from everyone else.
export interface WsPresenceRequest {
  type: 'presence-request';
  padId: number;
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
  | WsPresence
  | WsPresenceRequest
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
  // Unlock token presented at connect time for password-protected pads.
  // Re-validated on every patch so expiry / password-change revokes writes.
  unlockToken: string | null;
  // Per-connection patch rate-limit state (fixed window). See ws/index.ts.
  patchWindowStart: number;
  patchCount: number;
  // Timestamp of the last relayed presence frame — throttles presence
  // rebroadcast per connection so a misbehaving client can't flood the room.
  lastPresenceSent: number;
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
  FTS_SYNC_DEBOUNCE_MS: number;
  CONVERTIBLE_EXTS: string[];
  CONVERT_FEATURES: Record<string, boolean>;
  isProduction: boolean;
  SESSION_SECRET: string;
  SESSION_TOKEN_TTL_DAYS: number;
  PUBLIC_ORIGIN: string;
  cookieFlags: string;
  WRITE_ACCESS_MODE: 'open' | 'gated';
  WRITE_PASSPHRASES: string[];
  WRITE_GRANT_TTL_DAYS: number;
  WRITE_GRANT_RENEW_THRESHOLD_DAYS: number;
}

// ── Data Store interface ────────────────────────────────────────────

export interface DataStore {
  rawStore: IJSONStore;
  FILES_DIR: string;

  // Pad
  findPadById(id: number): Pad | undefined;
  findAllPads(): Pad[];
  // Metadata only — omits `text` / `textVersion`, for listing and permissions.
  findAllPadMeta(): Pad[];
  countPads(): number;
  padExists(id: number): boolean;
  createPad(pad: Partial<Pad> & { ownerUserId?: string | null; creatorCode?: string | null }): Pad;
  updatePadText(id: number, text: string): Pad | null;
  updatePadPassword(id: number, hash: string | null): Pad | null;
  removePad(id: number): void;

  // File
  findFileById(id: string): FileInfo | undefined;
  findAllFiles(): FileInfo[];
  createFile(info: FileInfo): FileInfo;
  sumFileBytes(ownerUserId?: string | null): number;
  removeFile(id: string): void;
  removeFilesByPadId(padId: number): void;
  removeFilesMany(ids: string[]): void;
  removeExpiredFiles(ttlMs: number): FileInfo[];

  // User
  userExists(code: string): boolean;
  createUser(user: User): User;
  findUserByCode(code: string): User | undefined;
  findAllUsers(): User[];
  setUserDisplayName(code: string, displayName: string | null): boolean;

  // Write grant
  findWriteGrant(code: string): WriteGrant | undefined;
  findAllWriteGrants(): WriteGrant[];
  upsertWriteGrant(grant: WriteGrant): WriteGrant;
  removeWriteGrant(code: string): boolean;
  touchWriteGrant(code: string, expiresAt: number | null): void;

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
import type WriteAccessServiceInstance = require('./services/writeAccessService');
type WriteAccessService = WriteAccessServiceInstance;

export interface Services {
  // Unified data-access facade — the only object route handlers and services
  // may touch for persistence (AGENTS.md: never reach into `db` directly).
  store: DataStore;
  db: typeof import('./db');
  padService: PadService;
  fileService: FileService;
  inviteService: InviteService;
  convertService: ConvertService;
  writeAccessService: WriteAccessService;
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
