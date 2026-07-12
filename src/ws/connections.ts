'use strict';

import type { CoMarkWebSocket } from '../types';

const padClients = new Map<number, Set<CoMarkWebSocket>>(); // padId -> Set<ws>
const wsConnectionsPerIp = new Map<string, number>(); // tracks active WS connections per IP

function add(
  ws: CoMarkWebSocket,
  meta: { clientId: string; padId: number; userId: string | null; ipAddress: string }
): void {
  ws.clientId = meta.clientId;
  ws.padId = meta.padId;
  ws.userId = meta.userId;
  ws.ipAddress = meta.ipAddress;
  ws.isAlive = true;

  if (!padClients.has(meta.padId)) padClients.set(meta.padId, new Set());
  padClients.get(meta.padId)!.add(ws);

  if (meta.ipAddress) {
    const count = wsConnectionsPerIp.get(meta.ipAddress) || 0;
    wsConnectionsPerIp.set(meta.ipAddress, count + 1);
  }
}

function remove(ws: CoMarkWebSocket): void {
  const set = padClients.get(ws.padId);
  if (!set || !set.delete(ws)) return;
  if (set.size === 0) padClients.delete(ws.padId);

  if (ws.ipAddress) {
    const count = wsConnectionsPerIp.get(ws.ipAddress) || 0;
    if (count <= 1) wsConnectionsPerIp.delete(ws.ipAddress);
    else wsConnectionsPerIp.set(ws.ipAddress, count - 1);
  }
}

function getTotalCount(): number {
  let count = 0;
  for (const set of padClients.values()) count += set.size;
  return count;
}

function getIpCount(ip: string): number {
  return wsConnectionsPerIp.get(ip) || 0;
}

function getPadCount(padId: number): number {
  const set = padClients.get(padId);
  return set ? set.size : 0;
}

function forEach(fn: (ws: CoMarkWebSocket) => void): void {
  for (const set of padClients.values()) {
    for (const ws of set) fn(ws);
  }
}

function getPadClients(padId: number): Set<CoMarkWebSocket> | undefined {
  return padClients.get(padId);
}

module.exports = {
  add,
  remove,
  getTotalCount,
  getIpCount,
  getPadCount,
  forEach,
  getPadClients,
};
