'use strict';

const sqlite = require('./sqlite');

import type { Invitation, AccessGrant } from '../types';

function findByToken(token: string): Invitation | undefined {
  const db = sqlite.getDb();
  const row = db.prepare('SELECT * FROM invitations WHERE token = ?').get(token);
  return row ? rowToInvitation(row) : undefined;
}

function create(invite: Invitation): Invitation {
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

function remove(token: string): { ok: boolean; revokedGrants: number } | false {
  const db = sqlite.getDb();
  const grantsBefore = db
    .prepare('SELECT COUNT(*) as cnt FROM access_grants WHERE invite_token = ?')
    .get(token).cnt;
  const result = db.prepare('DELETE FROM invitations WHERE token = ?').run(token);
  if (result.changes === 0) return false;
  db.prepare('DELETE FROM access_grants WHERE invite_token = ?').run(token);
  return { ok: true, revokedGrants: grantsBefore };
}

function hasAccessGrant(grantorCode: string, granteeCode: string): boolean {
  const db = sqlite.getDb();
  const row = db
    .prepare('SELECT 1 FROM access_grants WHERE grantor_code = ? AND grantee_code = ? LIMIT 1')
    .get(grantorCode, granteeCode);
  return !!row;
}

function addGrant(grant: AccessGrant): void {
  const db = sqlite.getDb();
  // Atomic: increment use_count only if the invite is still under its limit,
  // then insert the grant. Wrapping both in a transaction guarantees no orphan
  // grant row is left behind if the limit was reached, and provides defense in
  // depth against a race on max_uses even though better-sqlite3 is synchronous.
  const txn = db.transaction((g: AccessGrant) => {
    const upd = db
      .prepare(
        'UPDATE invitations SET use_count = use_count + 1 WHERE token = ? AND (max_uses = 0 OR use_count < max_uses)'
      )
      .run(g.inviteToken);
    if (upd.changes === 0) throw new Error('INVITE_LIMIT_REACHED');
    db.prepare(
      'INSERT INTO access_grants (invite_token, grantor_code, grantee_code, granted_at) VALUES (?, ?, ?, ?)'
    ).run(g.inviteToken, g.grantorCode, g.granteeCode, g.grantedAt || Date.now());
  });
  txn(grant);
}

function listByCreator(creatorCode: string): Invitation[] {
  const db = sqlite.getDb();
  return db
    .prepare('SELECT * FROM invitations WHERE creator_code = ?')
    .all(creatorCode)
    .map(rowToInvitation);
}

function listGrantsByGrantee(granteeCode: string): AccessGrant[] {
  const db = sqlite.getDb();
  return db
    .prepare('SELECT * FROM access_grants WHERE grantee_code = ?')
    .all(granteeCode)
    .map(rowToGrant);
}

function rowToInvitation(row: any): Invitation {
  return {
    token: row.token,
    creatorCode: row.creator_code,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at ?? null,
    createdAt: row.created_at,
  };
}

function rowToGrant(row: any): AccessGrant {
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
