'use strict';

const sqlite = require('./sqlite');

function findByToken(token) {
  const db = sqlite.getDb();
  const row = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
  return row ? rowToInvitation(row) : undefined;
}

function create(invite) {
  const db = sqlite.getDb();
  db.prepare(
    'INSERT INTO invitations (token, creator_code, max_uses, use_count, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    invite.token,
    invite.creatorCode,
    invite.maxUses || 0,
    invite.useCount || 0,
    invite.expiresAt || null,
    invite.createdAt || Date.now()
  );
  return invite;
}

function remove(token) {
  const db = sqlite.getDb();
  const grantsBefore = db
    .prepare('SELECT COUNT(*) as cnt FROM access_grants WHERE invite_token = ?')
    .get(token).cnt;
  const result = db.prepare('DELETE FROM invitations WHERE token = ?').run(token);
  if (result.changes === 0) return false;
  db.prepare('DELETE FROM access_grants WHERE invite_token = ?').run(token);
  return { ok: true, revokedGrants: grantsBefore };
}

function hasAccessGrant(grantorCode, granteeCode) {
  const db = sqlite.getDb();
  const row = db
    .prepare('SELECT 1 FROM access_grants WHERE grantor_code = ? AND grantee_code = ? LIMIT 1')
    .get(grantorCode, granteeCode);
  return !!row;
}

function addGrant(grant) {
  const db = sqlite.getDb();
  db.prepare(
    'INSERT INTO access_grants (invite_token, grantor_code, grantee_code, granted_at) VALUES (?, ?, ?, ?)'
  ).run(grant.inviteToken, grant.grantorCode, grant.granteeCode, grant.grantedAt || Date.now());
  // Increment use count
  db.prepare('UPDATE invitations SET use_count = use_count + 1 WHERE token = ?').run(
    grant.inviteToken
  );
}

function listByCreator(creatorCode) {
  const db = sqlite.getDb();
  return db
    .prepare('SELECT * FROM invitations WHERE creator_code = ?')
    .all(creatorCode)
    .map(rowToInvitation);
}

function listGrantsByGrantee(granteeCode) {
  const db = sqlite.getDb();
  return db
    .prepare('SELECT * FROM access_grants WHERE grantee_code = ?')
    .all(granteeCode)
    .map(rowToGrant);
}

function rowToInvitation(row) {
  return {
    token: row.token,
    creatorCode: row.creator_code,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  };
}

function rowToGrant(row) {
  return {
    inviteToken: row.invite_token,
    grantorCode: row.grantor_code,
    granteeCode: row.grantee_code,
    grantedAt: row.granted_at,
  };
}

module.exports = {
  findByToken,
  create,
  remove,
  hasAccessGrant,
  addGrant,
  listByCreator,
  listGrantsByGrantee,
};
