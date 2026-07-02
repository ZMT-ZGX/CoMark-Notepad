import { state, $, showToast, getPadToken, upsertLocalFile, removeLocalFile, escapeHtml } from './core.js';
import { fetchMe, registerUser, updatePadText } from './server.js';
import { refreshPads, loadPadContent, renderPadTabs, updateLockButton } from './pads.js';
import { addFileToList, removeFileFromList, updateFilesEmpty, updateTextStats } from './files.js';
import { showUnlockModal } from './modals.js';

// --- Identity ---

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
    updateUserCodeUI();
  }
}

function updateUserCodeUI() {
  const el = $('#user-code-display');
  if (!el) return;
  if (state.userCode) {
    el.textContent = state.userCode;
    el.parentElement.hidden = false;
  } else {
    el.parentElement.hidden = true;
  }
}

function copyUserCode() {
  if (!state.userCode) return;
  if (!navigator.clipboard) { showToast('Copy not available in this browser context'); return; }
  navigator.clipboard.writeText(state.userCode).then(
    () => showToast('User code copied!'),
    () => showToast('Copy failed')
  );
}

// --- Text Sync ---

const textarea = () => $('#text-input');

export function applyTextState(text, version) {
  text = text || '';
  const ta = textarea();
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = text;
  ta.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
  state.textVersion = Math.max(state.textVersion, version || 0);
  updateTextStats();
}

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

function sendText() {
  clearTimeout(state.sendTimeout);
  state.sendTimeout = setTimeout(sendTextNow, 300);
}

export async function sendTextNow() {
  state.sendTimeout = null;
  const requestId = ++state.lastTextRequestId;
  const padId = state.currentPadId;
  try {
    const data = await updatePadText(padId, textarea().value, state.wsId);
    if (requestId === state.lastTextRequestId) {
      state.textVersion = Math.max(state.textVersion, data.textVersion || 0);
    }
  } catch (e) {
    console.warn('Failed to sync text:', e);
  }
}

export function initTextSync() {
  const ta = textarea();
  ta.addEventListener('input', () => { sendText(); updateTextStats(); });
  ta.addEventListener('blur', () => { applyPendingRemoteText(); });
  updateTextStats();
}

// --- WebSocket ---

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
  if (padToken) params.set('padToken', padToken);
  const newWs = new WebSocket(`${proto}//${location.host}/?${params}`);
  state.ws = newWs;

  newWs.onopen = () => {
    if (state.ws !== newWs) return;
    state.reconnectAttempts = 0;
    $('#status').className = 'status online';
    $('#status').title = 'Connected';
    loadPadContent();
  };

  newWs.onmessage = (e) => {
    if (state.ws !== newWs) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { console.warn('Malformed WebSocket message:', e.data); return; }
    switch (msg.type) {
      case 'hello':
        state.wsId = msg.wsId;
        break;
      case 'text-update':
        if (msg.padId === state.currentPadId) applyRemoteText(msg.text, msg.textVersion);
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

// --- Markdown Preview ---

export async function openMarkdownPreview(file) {
  const modal = $('#preview-modal');
  const titleEl = $('#preview-title');
  const bodyEl = $('#preview-body');
  state.previewTargetId = file.id;
  titleEl.textContent = file.originalName;
  bodyEl.className = 'preview-body is-loading';
  bodyEl.textContent = 'Loading...';
  modal.hidden = false;

  try {
    const padToken = getPadToken(file.padId || state.currentPadId);
    const url = padToken
      ? `/api/files/${file.id}?padToken=${encodeURIComponent(padToken)}`
      : `/api/files/${file.id}`;
    const res = await fetch(url);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const markdown = await res.text();
    if (state.previewTargetId !== file.id) return;
    let html;
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      html = `<pre>${escapeHtml(markdown)}</pre>`;
    } else {
      html = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
    }
    bodyEl.className = 'preview-body';
    bodyEl.innerHTML = html;
  } catch (e) {
    if (state.previewTargetId !== file.id) return;
    bodyEl.className = 'preview-body is-error';
    bodyEl.textContent = e.message || 'Failed to load preview';
  }
}

export function closeMarkdownPreview() {
  const modal = $('#preview-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  $('#preview-body').innerHTML = '';
}

// --- QR Code ---

export function initQR() {
  const titleEl = document.querySelector('.header-left');
  const qrPopup = $('#qr-popup');
  const qrImg = $('#qr-image');
  let qrLoaded = false;

  titleEl.addEventListener('mouseenter', () => {
    if (!qrLoaded) { qrImg.src = '/api/qrcode'; qrLoaded = true; }
    qrPopup.hidden = false;
  });
  titleEl.addEventListener('mouseleave', () => { qrPopup.hidden = true; });
  titleEl.addEventListener('click', (e) => {
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      e.stopPropagation();
      if (!qrLoaded) { qrImg.src = '/api/qrcode'; qrLoaded = true; }
      qrPopup.hidden = !qrPopup.hidden;
    }
  });
  document.addEventListener('click', (e) => {
    if (!titleEl.contains(e.target) && !qrPopup.contains(e.target)) qrPopup.hidden = true;
  });
}

// --- Export ---

export function initExport() {
  $('#export-btn').addEventListener('click', () => {
    const text = textarea().value;
    if (!text.trim()) { showToast('Nothing to export'); return; }
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `pad-${state.currentPadId}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Exported!');
  });
}

// --- Keyboard Shortcuts ---

export function initKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('#password-modal').hidden = true;
      $('#unlock-modal').hidden = true;
      $('#confirm-modal').hidden = true;
      const inviteModal = $('#invite-modal');
      if (inviteModal) inviteModal.hidden = true;
      const uploadModal = $('#upload-confirm-modal');
      if (uploadModal) uploadModal.hidden = true;
      closeMarkdownPreview();
    }
  });
}

// --- Beforeunload (flush debounced text sync) ---

export function initBeforeUnload() {
  window.addEventListener('beforeunload', () => {
    if (state.sendTimeout) {
      clearTimeout(state.sendTimeout);
      state.sendTimeout = null;
      const token = getPadToken(state.currentPadId);
      const payload = JSON.stringify({ text: textarea().value, _wsId: state.wsId });
      const blob = new Blob([payload], { type: 'application/json' });
      const url = token
        ? `/api/pads/${state.currentPadId}/text?padToken=${encodeURIComponent(token)}`
        : `/api/pads/${state.currentPadId}/text`;
      navigator.sendBeacon(url, blob);
    }
  });
}

// --- Identity event bindings ---

export function initIdentityBindings() {
  $('#copy-user-code-btn').addEventListener('click', copyUserCode);
}

// --- Convert Capabilities ---

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
