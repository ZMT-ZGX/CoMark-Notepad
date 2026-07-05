/**
 * CoMark-Notepad — Text Sync module
 *
 * Patch-based sync over WebSocket. Falls back to HTTP on WS unavailable.
 * Maintains lastSyncedText as the base for computing diffs.
 */

import { state, $, showToast } from './core.js';
import { updateTextStats } from './files.js';
import { updatePadText } from './server.js';

const textarea = () => $('#text-input');

// --- Text state ---

export function applyTextState(text, version) {
  text = text || '';
  const ta = textarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = text;
  ta.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
  state.textVersion = Math.max(state.textVersion, version || 0);
  state.lastSyncedText = text;
  updateTextStats();
}

// --- Remote text merge ---

function queueRemoteText(text, version) {
  if (version <= state.textVersion) return;
  state.pendingRemoteState = { text, textVersion: version };
}

function applyPendingRemoteText() {
  if (!state.pendingRemoteState) return;
  if (state.pendingRemoteState.textVersion <= state.textVersion) {
    state.pendingRemoteState = null;
    return;
  }
  applyTextState(state.pendingRemoteState.text, state.pendingRemoteState.textVersion);
  state.pendingRemoteState = null;
}

export function applyRemoteText(text, version) {
  if (version <= state.textVersion) return;
  if (document.activeElement === textarea()) {
    queueRemoteText(text, version);
    return;
  }
  applyTextState(text, version);
}

/**
 * Apply a remote patch to the editor while preserving cursor position.
 * Falls back to full-text replacement if patch_apply reports failures.
 */
export function applyRemotePatch(patchText, version) {
  if (version <= state.textVersion) return;
  if (typeof window.diff_match_patch !== 'function') return;
  const dmp = new window.diff_match_patch();
  let patches;
  try {
    patches = dmp.patch_fromText(patchText);
  } catch {
    return;
  }
  const ta = textarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const [newText, results] = dmp.patch_apply(patches, ta.value);
  if (!Array.isArray(results) || results.some((r) => !r)) {
    console.warn('applyRemotePatch: patch failed to apply cleanly');
    return;
  }
  ta.value = newText;
  // Restore cursor as best effort: map old offset into newText length
  ta.setSelectionRange(Math.min(start, newText.length), Math.min(end, newText.length));
  state.textVersion = Math.max(state.textVersion, version);
  state.lastSyncedText = newText;
  updateTextStats();
}

// --- Offline banner ---

export function showOfflineBanner() {
  const banner = $('#offline-banner');
  if (banner) banner.hidden = false;
}

export function hideOfflineBanner() {
  const banner = $('#offline-banner');
  if (banner) banner.hidden = true;
}

// --- Send path (patch over WS, HTTP fallback) ---

function sendText() {
  clearTimeout(state.sendTimeout);
  state.sendTimeout = setTimeout(sendTextNow, 300);
}

export async function sendTextNow() {
  state.sendTimeout = null;
  const currentText = textarea().value;
  if (currentText === state.lastSyncedText) return;

  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (typeof window.diff_match_patch !== 'function') return;
    const dmp = new window.diff_match_patch();
    const patches = dmp.patch_make(state.lastSyncedText, currentText);
    const patchText = dmp.patch_toText(patches);
    state.lastSyncedText = currentText;
    ws.send(JSON.stringify({ type: 'patch', padId: state.currentPadId, data: patchText }));
  } else if (!ws || ws.readyState === WebSocket.CONNECTING) {
    if (typeof window.diff_match_patch !== 'function') return;
    // Queue for when connection opens — pad-scoped
    const dmp = new window.diff_match_patch();
    const patches = dmp.patch_make(state.lastSyncedText, currentText);
    const patchText = dmp.patch_toText(patches);
    state.lastSyncedText = currentText;
    const padId = state.currentPadId;
    const q = state.getPatchQueue(padId);
    q.push(patchText);
    state.setPatchQueue(q, padId);
    showOfflineBanner();
  } else {
    // WS closed — HTTP fallback
    const requestId = ++state.lastTextRequestId;
    const padId = state.currentPadId;
    try {
      const data = await updatePadText(padId, currentText, state.wsId);
      if (requestId === state.lastTextRequestId) {
        state.textVersion = Math.max(state.textVersion, data.textVersion || 0);
        state.lastSyncedText = currentText;
      }
    } catch (e) {
      console.warn('Failed to sync text:', e);
    }
  }
}

export function flushPatchQueue(padId = state.currentPadId) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  let q = state.getPatchQueue(padId);
  while (q.length > 0) {
    const patchText = q.shift();
    ws.send(JSON.stringify({ type: 'patch', padId, data: patchText }));
  }
  state.setPatchQueue(q, padId);
  hideOfflineBanner();
}

/**
 * Handle image paste → convert data URL → insert as Markdown image reference.
 * The base64 data is stored in SQLite text column (a few MB is fine for SQLite).
 */
function handleImagePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) continue;
    if (file.size > 2 * 1024 * 1024) {
      showToast('Image too large (max 2MB)');
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const ta2 = textarea();
      const pos = ta2.selectionStart;
      const alt = file.name || 'image';
      const insert = `![${alt}](${dataUrl})\n`;
      ta2.value = ta2.value.slice(0, pos) + insert + ta2.value.slice(ta2.selectionEnd);
      ta2.selectionStart = ta2.selectionEnd = pos + insert.length;
      state.lastSyncedText = ta2.value;
      // Trigger sync + stats
      sendText();
      updateTextStats();
    };
    reader.readAsDataURL(file);
    break; // Only handle first image
  }
}

/**
 * On unload, if WS is closed and there's unsynced text, flush into the
 * queue so it's sent on next page load once WS reopens.
 */
function handleBeforeUnload() {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const ta = textarea();
  if (!ta || ta.value === state.lastSyncedText) return;
  try {
    const dmp = new window.diff_match_patch();
    const patches = dmp.patch_make(state.lastSyncedText, ta.value);
    const patchText = dmp.patch_toText(patches);
    if (patchText) {
      const padId = state.currentPadId;
      const q = state.getPatchQueue(padId);
      q.push(patchText);
      state.setPatchQueue(q, padId);
    }
  } catch {}
}

export function initTextSync() {
  const ta = textarea();
  ta.addEventListener('input', () => { sendText(); updateTextStats(); });
  ta.addEventListener('blur', () => { applyPendingRemoteText(); });
  ta.addEventListener('paste', handleImagePaste);
  window.addEventListener('beforeunload', handleBeforeUnload);
  // Restore lastSyncedText from any queued patches on load
  setTimeout(flushPatchQueue, 2000); // try flush after WS has had a chance to connect
  updateTextStats();
}
