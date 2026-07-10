/**
 * CoMark-Notepad — WebSocket module
 *
 * Manages the WebSocket connection lifecycle, message dispatch,
 * automatic reconnection, and inactivity-based heartbeat.
 *
 * Other UI features that were historically in this file (preview, QR,
 * export, beforeunload) have been extracted to their own modules in
 * public/js/. Callers import them from their dedicated modules directly.
 */

import { state, $, showToast, getPadToken, getPadSync, upsertLocalFile, removeLocalFile } from './core.js';
import { refreshPads, loadPadContent } from './pads.js';
import { addFileToList, removeFileFromList, updateFilesEmpty } from './files.js';
import { showUnlockModal } from './modals.js';
import { applyRemoteText, applyRemotePatch, applyPatchNack, applyTextState, flushPatchQueue, showOfflineBanner, hideOfflineBanner, ackInflight, requeueInflight } from './text-sync.js';

// --- Identity (kept here because it touches state init + pads + ws) ---

import { fetchMe, registerUser } from './server.js';

export async function initIdentity() {
  try { state.userCode = sessionStorage.getItem('userCode') || null; } catch {}
  try {
    const data = await fetchMe();
    if (data) {
      state.userCode = data.code;
    } else {
      const regData = await registerUser();
      if (regData) state.userCode = regData.code;
    }
  } catch (e) {
    console.warn('Identity init failed:', e);
  }
  if (state.userCode) {
    try { sessionStorage.setItem('userCode', state.userCode); } catch {}
  }
}

export async function loadConvertCapabilitiesUI() {
  const { loadConvertCapabilities } = await import('./server.js');
  const { refreshConvertibleExts } = await import('./core.js');
  const data = await loadConvertCapabilities();
  if (!data) return;
  if (Array.isArray(data.extensions)) {
    state.convertCapabilities.extensions = data.extensions;
    refreshConvertibleExts();
  }
  if (typeof data.maxBytes === 'number') state.convertCapabilities.maxBytes = data.maxBytes;
  if (typeof data.timeoutMs === 'number') state.convertCapabilities.timeoutMs = data.timeoutMs;
  if (data.features && typeof data.features === 'object') state.convertCapabilities.features = data.features;
}

// --- WebSocket connection ---

export function connectWS() {
  if (state.ws) {
    try { state.ws.close(); } catch {}
    state.ws = null;
  }
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const padToken = getPadToken(state.currentPadId);
  const params = new URLSearchParams({ pad: String(state.currentPadId) });
  const newWs = new WebSocket(`${proto}//${location.host}/?${params}`);
  newWs.padId = state.currentPadId; // remember which pad this socket belongs to
  state.ws = newWs;

  newWs.onopen = () => {
    if (state.ws !== newWs) return;
    // Send padToken as first message instead of URL param to avoid log exposure
    if (padToken) newWs.send(JSON.stringify({ type: 'auth', padToken }));
    state.reconnectAttempts = 0;
    $('#status').className = 'status online';
    $('#status').title = 'Connected';
    // Do NOT flush the offline queue / load body here — wait for the server's
    // `hello` (which proves auth succeeded). Flushing before `hello` on a
    // locked pad with an invalid unlock token would leak the queue and then
    // lose it (P1 #2).
  };

  newWs.onmessage = (e) => {
    if (state.ws !== newWs) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { console.warn('Malformed WebSocket message:', e.data); return; }
    switch (msg.type) {
      case 'hello':
        state.wsId = msg.wsId;
        // Auth confirmed (incl. locked-pad unlock token): safe to flush the
        // offline queue now (P1 #2). Do not race a queued write with a stale
        // GET snapshot; the patch ACK carries the authoritative body.
        const helloSync = getPadSync(state.currentPadId);
        const hasPending = state.getPatchQueue(state.currentPadId).length > 0
          || !!helloSync.inflight
          || (helloSync.pendingTarget !== null && helloSync.pendingTarget !== helloSync.lastSyncedText);
        if (hasPending) flushPatchQueue();
        else loadPadContent();
        break;
      case 'patch-ack':
        if (typeof msg.seq === 'number') ackInflight(msg.seq, state.currentPadId, msg.text, msg.textVersion);
        if (msg.textVersion) {
          const sync = getPadSync(state.currentPadId);
          sync.textVersion = Math.max(sync.textVersion, msg.textVersion);
        }
        break;
      case 'patch-nack':
        if (msg.padId === state.currentPadId) {
          applyPatchNack(msg.text, msg.textVersion);
        }
        break;
      case 'patch':
        if (msg.padId === state.currentPadId && msg.senderId !== state.wsId) {
          applyRemotePatch(msg.data, msg.textVersion, state.currentPadId, msg.text, msg.operationId);
        }
        break;
      case 'text-update':
        if (msg.padId === state.currentPadId) applyRemoteText(msg.text, msg.textVersion, state.currentPadId, true);
        break;
      case 'file-added':
        upsertLocalFile(msg.file);
        if (msg.padId === state.currentPadId) { addFileToList(msg.file, true); updateFilesEmpty(); }
        break;
      case 'file-deleted':
        removeLocalFile(msg.fileId);
        if (msg.padId === state.currentPadId) removeFileFromList(msg.fileId);
        break;
      case 'online-count':
        if (msg.padId === state.currentPadId) $('#online-count').textContent = msg.count;
        break;
      case 'pad-created':
      case 'pad-updated':
      case 'pad-deleted':
        refreshPads();
        break;
    }
  };

  newWs.onclose = (e) => {
    if (state.ws !== newWs) return;
    // Fold any in-flight / unsent edits back into the offline queue for THIS
    // socket's pad before reconnecting, so a dropped connection can't lose
    // local typing — and (on a pad switch) the old socket can't fold its
    // in-flight patch into the newly-active pad (P1 #3).
    try { requeueInflight(newWs.padId); } catch {}
    $('#status').className = 'status offline';
    $('#status').title = 'Disconnected - reconnecting...';
    $('#online-count').textContent = '0';
    state.wsId = null;
    if (e.code === 4400) { showToast('Connection rejected by server'); return; }
    if (e.code === 4403) {
      if (!$('#unlock-modal').hidden) return;
      showUnlockModal(state.currentPadId);
      return;
    }
    if (e.code === 4401) { showToast('No access to this pad'); refreshPads(); return; }
    if (e.code === 4404) { showToast('Pad not found'); refreshPads(); return; }
    if (e.code === 1013) {
      showToast('Server busy, retrying in 30s...');
      state.reconnectAttempts = Math.max(state.reconnectAttempts, 5);
    }
    const delay = Math.min(2000 * Math.pow(2, state.reconnectAttempts), 30000);
    state.reconnectAttempts++;
    state.reconnectTimer = setTimeout(connectWS, delay);
  };

  newWs.onerror = () => newWs.close();
}
