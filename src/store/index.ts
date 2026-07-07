'use strict';

/**
 * Unified data-access facade.
 *
 * Services depend on this object instead of the individual `db/*` modules.
 * The current implementation delegates to the SQLite-backed db modules.
 * Swapping to another backend only requires replacing this factory
 * while keeping the method signatures identical.
 *
 * ── Interface ────────────────────────────────────────────────────────
 *  Pad:          findPadById · createPad · updatePadText · updatePadPassword
 *                removePad · findAllPads · padExists
 *  File:         findFileById · findAllFiles · createFile · removeFile
 *                removeFilesByPadId · removeFilesMany · removeExpiredFiles
 *  User:         userExists · createUser
 *  Invitation:   createInvitation · findInvitationByToken · removeInvitation
 *                hasAccessGrant · addAccessGrant
 *                listInvitationsByCreator · listGrantsByGrantee
 *  Persistence:  save · flush · flushSync  (no-ops with SQLite, kept for backward compat)
 *  Meta:         rawStore · FILES_DIR
 */

import type { DataStore } from '../types';

function createDataStore(db: any): DataStore {
  return {
    // ── Raw access (init / migration / shutdown only) ──────────────
    rawStore: db.store,
    FILES_DIR: db.FILES_DIR,

    // ── Pad ────────────────────────────────────────────────────────
    findPadById(id: number) {
      return db.pads.findById(id);
    },

    findAllPads() {
      return db.pads.findAll();
    },

    padExists(id: number) {
      return !!db.pads.findById(id);
    },

    createPad(pad: any) {
      return db.pads.create(pad);
    },

    updatePadText(id: number, text: string) {
      return db.pads.updateText(id, text);
    },

    updatePadPassword(id: number, hash: string | null) {
      return db.pads.updatePassword(id, hash);
    },

    removePad(id: number) {
      return db.pads.remove(id);
    },

    // ── File ───────────────────────────────────────────────────────
    findFileById(id: string) {
      return db.files.findById(id);
    },

    findAllFiles() {
      return db.files.findAll();
    },

    createFile(info: any) {
      return db.files.create(info);
    },

    removeFile(id: string) {
      return db.files.remove(id);
    },

    removeFilesByPadId(padId: number) {
      return db.files.removeByPadId(padId);
    },

    removeFilesMany(ids: string[]) {
      return db.files.removeMany(ids);
    },

    removeExpiredFiles(ttlMs: number) {
      return db.files.removeExpired(ttlMs);
    },

    // ── User ───────────────────────────────────────────────────────
    userExists(code: string) {
      return db.users.exists(code);
    },

    createUser(user: any) {
      return db.users.create(user);
    },

    // ── Invitation ─────────────────────────────────────────────────
    createInvitation(invite: any) {
      return db.invitations.create(invite);
    },

    findInvitationByToken(token: string) {
      return db.invitations.findByToken(token);
    },

    removeInvitation(token: string) {
      return db.invitations.remove(token);
    },

    hasAccessGrant(grantor: string, grantee: string) {
      return db.invitations.hasAccessGrant(grantor, grantee);
    },

    addAccessGrant(grant: any) {
      return db.invitations.addGrant(grant);
    },

    listInvitationsByCreator(code: string) {
      return db.invitations.listByCreator(code);
    },

    listGrantsByGrantee(code: string) {
      return db.invitations.listGrantsByGrantee(code);
    },

    // ── Persistence ────────────────────────────────────────────────
    save() {
      return db.store.save();
    },

    flush() {
      return db.store.flush();
    },

    flushSync() {
      return db.store.flushSync();
    },
  };
}

module.exports = { createDataStore };
