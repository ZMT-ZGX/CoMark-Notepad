'use strict';

/**
 * Permission helpers — pure functions, no req/res, no I/O.
 * These are the single source of truth for access-control rules.
 */

import type { Pad, FileInfo } from '../types';

function canAccessPad(userId: string | null, pad: Pad, hasAccessGrantFn?: (ownerId: string, uid: string) => boolean): boolean {
  if (!pad.ownerUserId) return true; // public pad
  if (!userId) return false;
  if (pad.ownerUserId === userId) return true; // owner
  return hasAccessGrantFn ? hasAccessGrantFn(pad.ownerUserId, userId) : false;
}

function canAccessFile(userId: string | null, file: FileInfo, findPadById: (id: number) => Pad | undefined, hasAccessGrantFn: (ownerId: string, uid: string) => boolean): boolean {
  if (!file.ownerUserId) return true; // public file
  if (!userId) return false;
  if (file.ownerUserId === userId) return true;
  const pad = findPadById(file.padId);
  if (pad) return canAccessPad(userId, pad, hasAccessGrantFn);
  return false;
}

function canManagePad(userId: string | null, isAdminUser: boolean, pad: Pad): boolean {
  if (pad.ownerUserId) {
    return userId === pad.ownerUserId || isAdminUser;
  }
  if (pad.creatorCode) {
    return userId === pad.creatorCode || isAdminUser;
  }
  // Pad has no owner and no creator — only admins can manage
  return isAdminUser;
}

function resolveFileOwner(userId: string | null, pad: Pad | null): string | null {
  if (pad && pad.ownerUserId) return pad.ownerUserId;
  return userId || null;
}

module.exports = {
  canAccessPad,
  canAccessFile,
  canManagePad,
  resolveFileOwner,
};
