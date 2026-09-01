'use strict';

import type { CoMarkWebSocket } from '../types';

const padClients = new Map<number, Set<CoMarkWebSocket>>(); // padId -> Set<ws>
const wsConnectionsPerIp = new Map<string, number>(); // tracks active WS connections per IP

// Sockets that completed the TCP/WebSocket upgrade but are not yet registered
// as real connections (they are waiting for the `auth` first message required
// by password-protected pads). A connection is only counted by `add()` once
// that handshake finishes, so without tracking these separately the global and
// per-IP ceilings cannot see them — an attacker could open an unbounded number
// of pending sockets against a locked pad and exhaust memory while neither
// limit ever trips.
const pendingPerIp = new Map<string, number>();
let pendingTotal = 0;

function reserve(ipAddress: string): void {
  pendingTotal += 1;
  if (ipAddress) pendingPerIp.set(ipAddress, (pendingPerIp.get(ipAddress) || 0) + 1);
}

function releaseReservation(ipAddress: string): void {
  if (pendingTotal > 0) pendingTotal -= 1;
  if (!ipAddress) return;
  const count = pendingPerIp.get(ipAddress) || 0;
  if (count <= 1) pendingPerIp.delete(ipAddress);
  else pendingPerIp.set(ipAddress, count - 1);
}

function getPendingTotal(): number {
  return pendingTotal;
}

function getPendingIpCount(ip: string): number {
  return pendingPerIp.get(ip) || 0;
}

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
  reserve,
  releaseReservation,
  getTotalCount,
  getIpCount,
  getPendingTotal,
  getPendingIpCount,
  getPadCount,
  forEach,
  getPadClients,
};
