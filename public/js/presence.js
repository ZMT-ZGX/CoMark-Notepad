/**
 * CoMark-Notepad — Presence module
 *
 * "Who's here / who's editing" chips in the header. The server only relays
 * presence frames (it stores nothing and runs no timeouts of its own): each
 * client announces its own state when it changes, answers `presence-request`
 * when anyone joins, and removal relies on the socket-close broadcast plus a
 * client-side staleness prune that self-heals missed closes.
 *
 * Deliberately NOT remote carets: a plain <textarea> cannot host caret
 * overlays, so presence shows an "editing now" pulse per peer instead.
 */

import { state, $ } from './core.js';

const SEND_THROTTLE_MS = 500; // min gap between outgoing presence frames
const IDLE_AFTER_MS = 5000; // no local input for this long → not "active"
const PRUNE_AFTER_MS = 35000; // peer silent this long → dropped
const PRUNE_INTERVAL_MS = 10000;
const MAX_CHIPS = 8; // header space is finite; overflow collapses into +N

// wsId → { name, color, active, lastSeen }
const peers = new Map();

let myName = null;
let nameFetched = false;
let lastSentAt = 0;
let lastSentActive = null;
let lastLocalActivity = 0;
let timersStarted = false;

function colorFor(wsId) {
  let hash = 0;
  for (let i = 0; i < wsId.length; i++) hash = (hash * 31 + wsId.charCodeAt(i)) | 0;
  return `hsl(${Math.abs(hash) % 360}, 62%, 50%)`;
}

// Resolve the display name once. The profile API is the only source; until it
// answers (or when it has no name) fall back to a short user code, which is
// what the peer list in the profile modal shows too.
async function ensureName() {
  if (nameFetched) return;
  nameFetched = true;
  try {
    const { fetchMe } = await import('./server.js');
    const me = await fetchMe();
    const code = (me && me.code) || state.userCode || '';
    myName = (me && me.displayName) || (code ? code.slice(0, 6) : '') || null;
  } catch {
    myName = state.userCode ? state.userCode.slice(0, 6) : null;
  }
}

function sendPresence(force = false) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  const active = now - lastLocalActivity < IDLE_AFTER_MS;
  if (!force) {
    if (now - lastSentAt < SEND_THROTTLE_MS) return;
    if (active === lastSentActive) return;
  }
  lastSentAt = now;
  lastSentActive = active;
  void ensureName().then(() => {
    try {
      ws.send(JSON.stringify({ type: 'presence', name: myName, active }));
    } catch {}
  });
}

function render() {
  const list = $('#presence-list');
  if (!list) return;
  const now = Date.now();
  for (const [wsId, peer] of peers) {
    if (now - peer.lastSeen > PRUNE_AFTER_MS) peers.delete(wsId);
  }
  const shown = Array.from(peers.values()).slice(0, MAX_CHIPS);
  const overflow = peers.size - shown.length;
  list.textContent = '';
  for (const peer of shown) {
    const chip = document.createElement('span');
    chip.className = `presence-chip${peer.active ? ' active' : ''}`;
    chip.title = peer.active ? `${peer.name}（正在编辑）` : peer.name;
    const dot = document.createElement('span');
    dot.className = 'presence-dot';
    dot.style.background = peer.color;
    chip.appendChild(dot);
    const label = document.createElement('span');
    label.className = 'presence-name';
    label.textContent = peer.name;
    chip.appendChild(label);
    list.appendChild(chip);
  }
  if (overflow > 0) {
    const more = document.createElement('span');
    more.className = 'presence-chip';
    more.title = `还有 ${overflow} 人`;
    more.textContent = `+${overflow}`;
    list.appendChild(more);
  }
}

function noteLocalActivity() {
  lastLocalActivity = Date.now();
  sendPresence();
}

export function handlePresenceMessage(msg) {
  if (msg.gone) {
    peers.delete(msg.wsId);
  } else {
    peers.set(msg.wsId, {
      name: (typeof msg.name === 'string' && msg.name) || `用户${String(msg.wsId).slice(-4)}`,
      color: colorFor(msg.wsId),
      active: !!msg.active,
      lastSeen: Date.now(),
    });
  }
  render();
}

// The server broadcasts this when any peer joins; everyone (including the
// newcomer) answers once so every peer converges on a full room view.
export function handlePresenceRequest() {
  sendPresence(true);
}

export function resetPresence() {
  peers.clear();
  lastSentActive = null;
  render();
}

export function initPresence() {
  const ta = $('#text-input');
  if (ta) ta.addEventListener('input', noteLocalActivity);
  if (!timersStarted) {
    timersStarted = true;
    // Idle transition: flip our own "active" flag off after a quiet period.
    setInterval(() => {
      if (Date.now() - lastLocalActivity >= IDLE_AFTER_MS) sendPresence();
    }, 2000);
    // Staleness prune for peers whose close frame never arrived.
    setInterval(render, PRUNE_INTERVAL_MS);
  }
}
