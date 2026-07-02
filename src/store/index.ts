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

function createDataStore(db) {
  return {
    // ── Raw access (init / migration / shutdown only) ──────────────
    rawStore: db.store,
    FILES_DIR: db.FILES_DIR,

    // ── Pad ────────────────────────────────────────────────────────
    findPadById(id) {
      return db.pads.findById(id);
    },

    findAllPads() {
      return db.pads.findAll();
    },

    padExists(id) {
      return !!db.pads.findById(id);
    },

    createPad(pad) {
      return db.pads.create(pad);
    },

    updatePadText(id, text) {
      return db.pads.updateText(id, text);
    },

    updatePadPassword(id, hash) {
      return db.pads.updatePassword(id, hash);
    },

    removePad(id) {
      return db.pads.remove(id);
    },

    // ── File ───────────────────────────────────────────────────────
    findFileById(id) {
      return db.files.findById(id);
    },

    findAllFiles() {
      return db.files.findAll();
    },

    createFile(info) {
      return db.files.create(info);
    },

    removeFile(id) {
      return db.files.remove(id);
    },

    removeFilesByPadId(padId) {
      return db.files.removeByPadId(padId);
    },

    removeFilesMany(ids) {
      return db.files.removeMany(ids);
    },

    removeExpiredFiles(ttlMs) {
      return db.files.removeExpired(ttlMs);
    },

    // ── User ───────────────────────────────────────────────────────
    userExists(code) {
      return db.users.exists(code);
    },

    createUser(user) {
      return db.users.create(user);
    },

    // ── Invitation ─────────────────────────────────────────────────
    createInvitation(invite) {
      return db.invitations.create(invite);
    },

    findInvitationByToken(token) {
      return db.invitations.findByToken(token);
    },

    removeInvitation(token) {
      return db.invitations.remove(token);
    },

    hasAccessGrant(grantor, grantee) {
      return db.invitations.hasAccessGrant(grantor, grantee);
    },

    addAccessGrant(grant) {
      return db.invitations.addGrant(grant);
    },

    listInvitationsByCreator(code) {
      return db.invitations.listByCreator(code);
    },

    listGrantsByGrantee(code) {
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
