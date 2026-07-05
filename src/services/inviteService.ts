'use strict';

import type { DataStore, Broadcast, CoMarkWebSocket } from '../types';
const {
  NotFoundError,
  ForbiddenError,
  BadRequestError,
  ConflictError,
  GoneError,
} = require('../utils/errors');
const { generateInviteToken } = require('../utils/crypto');

class InviteService {
  store: DataStore;
  broadcast: Broadcast;
  getPadClients: ((padId: number) => Set<CoMarkWebSocket> | undefined) | null;

  constructor(store, broadcast, getPadClients = null) {
    this.store = store;
    this.broadcast = broadcast;
    this.getPadClients = getPadClients;
  }

  async create(userId, maxUses, expiresInHours) {
    const token = generateInviteToken();
    const invite = {
      token,
      creatorCode: userId,
      maxUses: maxUses > 0 ? maxUses : 0, // 0 = unlimited
      useCount: 0,
      expiresAt: expiresInHours > 0 ? Date.now() + expiresInHours * 3600000 : null,
      createdAt: Date.now(),
    };
    this.store.createInvitation(invite);
    return { token, maxUses, expiresInHours: expiresInHours || null };
  }

  async redeem(userId, token) {
    const invite = this.store.findInvitationByToken(token);
    if (!invite) throw NotFoundError('Invalid invitation token');
    if (invite.expiresAt && Date.now() > invite.expiresAt) {
      throw GoneError('Invitation expired');
    }
    if (invite.maxUses > 0 && invite.useCount >= invite.maxUses) {
      throw GoneError('Invitation fully redeemed');
    }
    if (invite.creatorCode === userId) {
      throw BadRequestError('Cannot redeem your own invitation');
    }
    if (this.store.hasAccessGrant(invite.creatorCode, userId)) {
      throw ConflictError('Already have access from this inviter');
    }

    this.store.addAccessGrant({
      inviteToken: token,
      grantorCode: invite.creatorCode,
      granteeCode: userId,
      grantedAt: Date.now(),
    });
    // Note: useCount is incremented atomically by db/invitations.addGrant via SQL UPDATE
    return { ok: true, grantorCode: invite.creatorCode };
  }

  async list(userId) {
    return {
      created: this.store.listInvitationsByCreator(userId),
      received: this.store.listGrantsByGrantee(userId),
    };
  }

  async delete(userId, token) {
    const invite = this.store.findInvitationByToken(token);
    if (!invite) throw NotFoundError('Token not found');
    if (invite.creatorCode !== userId) throw ForbiddenError('Not your invitation');
    const result = this.store.removeInvitation(token);
    if (result) this.closeRevokedClients(userId);
    return result;
  }

  closeRevokedClients(ownerUserId) {
    const pads = this.store.findAllPads().filter((pad) => pad.ownerUserId === ownerUserId);
    for (const pad of pads) {
      const clients = this.getPadClients ? this.getPadClients(pad.id) : undefined;
      if (!clients) continue;
      for (const ws of Array.from(clients) as CoMarkWebSocket[]) {
        if (ws.userId === ownerUserId) continue;
        if (ws.userId && this.store.hasAccessGrant(ownerUserId, ws.userId)) continue;
        try {
          ws.close(4401, 'Access revoked');
        } catch {}
      }
    }
  }
}

export = InviteService;
