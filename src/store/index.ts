'use strict';

/**
 * Unified data-access facade (SQLite-backed).
 *
 * Services depend on this class instead of the individual `db/*` modules.
 * Swapping to another backend only requires replacing this implementation
 * while keeping the DataStore interface contract.
 *
 * ── Interface ────────────────────────────────────────────────────────
 *  Pad:          findPadById · createPad · updatePadText · updatePadPassword
 *                removePad · findAllPads · findAllPadMeta · countPads · padExists
 *  File:         findFileById · findAllFiles · createFile · sumFileBytes
 *                removeFile · removeFilesByPadId · removeFilesMany · removeExpiredFiles
 *  User:         userExists · createUser · findUserByCode · findAllUsers
 *                setUserDisplayName
 *  WriteGrant:   findWriteGrant · findAllWriteGrants · upsertWriteGrant
 *                removeWriteGrant · touchWriteGrant
 *  Invitation:   createInvitation · findInvitationByToken · removeInvitation
 *                hasAccessGrant · addAccessGrant
 *                listInvitationsByCreator · listGrantsByGrantee
 *  Persistence:  flushSync  (closes SQLite on shutdown)
 *  Meta:         rawStore · FILES_DIR
 */

import type { DataStore, IJSONStore } from '../types';

// Type the db module so the class gets real method signatures instead of `any`.
interface DbModule {
  store: IJSONStore;
  FILES_DIR: string;
  pads: {
    findById(id: number): any;
    findByIdMeta(id: number): any;
    findAll(): any[];
    findAllMeta(): any[];
    count(): number;
    create(pad: any): any;
    updateText(id: number, text: string): any;
    updatePassword(id: number, hash: string | null): any;
    remove(id: number): void;
  };
  files: {
    findById(id: string): any;
    findAll(): any[];
    create(info: any): any;
    sumBytes(ownerUserId?: string | null): number;
    remove(id: string): void;
    removeByPadId(padId: number): void;
    removeMany(ids: string[]): void;
    removeExpired(ttlMs: number): any[];
  };
  users: {
    exists(code: string): boolean;
    create(user: any): any;
    findByCode(code: string): any;
    findAll(): any[];
    setDisplayName(code: string, displayName: string | null): boolean;
  };
  writeGrants: {
    findByUser(code: string): any;
    findAll(): any[];
    upsert(grant: any): any;
    remove(code: string): boolean;
    touch(code: string, expiresAt: number | null): void;
  };
  invitations: {
    create(invite: any): any;
    findByToken(token: string): any;
    remove(token: string): any;
    hasAccessGrant(grantor: string | null, grantee: string | null): boolean;
    addGrant(grant: any): void;
    listByCreator(code: string | null): any[];
    listGrantsByGrantee(code: string | null): any[];
  };
}

class SqliteDataStore implements DataStore {
  private db: DbModule;
  rawStore: DataStore['rawStore'];
  FILES_DIR: string;

  constructor(db: DbModule) {
    this.db = db;
    this.rawStore = db.store;
    this.FILES_DIR = db.FILES_DIR;
  }

  // ── Pad ────────────────────────────────────────────────────────
  findPadById(id: number) {
    return this.db.pads.findById(id);
  }
  findPadMetaById(id: number) {
    return this.db.pads.findByIdMeta(id);
  }
  findAllPads() {
    return this.db.pads.findAll();
  }
  findAllPadMeta() {
    return this.db.pads.findAllMeta();
  }
  countPads() {
    return this.db.pads.count();
  }
  padExists(id: number) {
    return !!this.db.pads.findById(id);
  }
  createPad(pad: any) {
    return this.db.pads.create(pad);
  }
  updatePadText(id: number, text: string) {
    return this.db.pads.updateText(id, text);
  }
  updatePadPassword(id: number, hash: string | null) {
    return this.db.pads.updatePassword(id, hash);
  }
  removePad(id: number) {
    return this.db.pads.remove(id);
  }

  // ── File ───────────────────────────────────────────────────────
  findFileById(id: string) {
    return this.db.files.findById(id);
  }
  findAllFiles() {
    return this.db.files.findAll();
  }
  createFile(info: any) {
    return this.db.files.create(info);
  }
  sumFileBytes(ownerUserId: string | null = null) {
    return this.db.files.sumBytes(ownerUserId);
  }
  removeFile(id: string) {
    return this.db.files.remove(id);
  }
  removeFilesByPadId(padId: number) {
    return this.db.files.removeByPadId(padId);
  }
  removeFilesMany(ids: string[]) {
    return this.db.files.removeMany(ids);
  }
  removeExpiredFiles(ttlMs: number) {
    return this.db.files.removeExpired(ttlMs);
  }

  // ── User ───────────────────────────────────────────────────────
  userExists(code: string) {
    return this.db.users.exists(code);
  }
  createUser(user: any) {
    return this.db.users.create(user);
  }
  findUserByCode(code: string) {
    return this.db.users.findByCode(code);
  }
  findAllUsers() {
    return this.db.users.findAll();
  }
  setUserDisplayName(code: string, displayName: string | null) {
    return this.db.users.setDisplayName(code, displayName);
  }

  // ── Write grant ────────────────────────────────────────────────
  findWriteGrant(code: string) {
    return this.db.writeGrants.findByUser(code);
  }
  findAllWriteGrants() {
    return this.db.writeGrants.findAll();
  }
  upsertWriteGrant(grant: any) {
    return this.db.writeGrants.upsert(grant);
  }
  removeWriteGrant(code: string) {
    return this.db.writeGrants.remove(code);
  }
  touchWriteGrant(code: string, expiresAt: number | null) {
    return this.db.writeGrants.touch(code, expiresAt);
  }

  // ── Invitation ─────────────────────────────────────────────────
  createInvitation(invite: any) {
    return this.db.invitations.create(invite);
  }
  findInvitationByToken(token: string) {
    return this.db.invitations.findByToken(token);
  }
  removeInvitation(token: string) {
    return this.db.invitations.remove(token);
  }
  hasAccessGrant(grantor: string | null, grantee: string | null) {
    return this.db.invitations.hasAccessGrant(grantor, grantee);
  }
  addAccessGrant(grant: any) {
    return this.db.invitations.addGrant(grant);
  }
  listInvitationsByCreator(code: string | null) {
    return this.db.invitations.listByCreator(code);
  }
  listGrantsByGrantee(code: string | null) {
    return this.db.invitations.listGrantsByGrantee(code);
  }

  // ── Persistence ────────────────────────────────────────────────
  // save() and flush() are no-ops with SQLite (auto-committed writes).
  // Kept to satisfy the DataStore interface for any legacy callers.
  save() {}
  flush(): Promise<void> {
    return Promise.resolve();
  }
  flushSync() {
    return this.db.store.flushSync();
  }
}

function createDataStore(db: DbModule): DataStore {
  return new SqliteDataStore(db);
}

module.exports = { createDataStore, SqliteDataStore };
