'use strict';

import type { CoMarkWebSocket } from '../types';

const connections = require('./connections');

function toPad(padId: number, data: any, excludeWsId?: string | null): void {
  const set = connections.getPadClients(padId);
  if (!set || set.size === 0) return;
  const msg = JSON.stringify(data);
  const items = Array.from(set) as CoMarkWebSocket[];
  for (let i = 0; i < items.length; i++) {
    const ws = items[i];
    if (excludeWsId && ws.clientId === excludeWsId) continue;
    if (ws.readyState !== 1) {
      connections.remove(ws);
      continue;
    }
    try {
      ws.send(msg);
    } catch {
      connections.remove(ws);
    }
  }
}

function toAll(data: any): void {
  const msg = JSON.stringify(data);
  const allClients: CoMarkWebSocket[] = [];
  // Collect all active clients first (snapshot), to avoid mutation during iteration
  connections.forEach((ws: CoMarkWebSocket) => {
    if (ws.readyState === 1) {
      allClients.push(ws);
    } else {
      connections.remove(ws);
    }
  });
  for (const ws of allClients) {
    try {
      ws.send(msg);
    } catch {
      connections.remove(ws);
    }
  }
}

module.exports = { toPad, toAll };
