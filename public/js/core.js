// Shared application state — mutable singleton imported by all modules
// --- Per-pad reliable-delivery sync state ---
// Each pad gets its own isolated sync state so that switching pads (or a
// reconnect) can never let one pad's in-flight patch leak into another, and
// the model is a simple "one confirmed shadow + one in-flight op + one pending
// target text" instead of a global array of parallel patches.
//   lastSyncedText : confirmed shadow (base for computing diffs)
//   textVersion    : confirmed server version
//   inflight       : the single op currently in flight (WS patch seq or HTTP
//                    sentinel), or null. Only one exists at a time.
//   pendingTarget  : the latest local text we intend to reach; once the
//                    in-flight op is acknowledged we diff shadow → pendingTarget
//                    to send any newer edits.
//   requestToken   : monotonic (never reset) per-pad token for HTTP-fallback
//                    request/response matching, so a stale response from a
//                    previous pad can never be applied to the new one.
//   pendingRemoteState : remote text deferred while the editor is focused.
export function getPadSync(padId) {
  if (!state.padSync[padId]) {
    state.padSync[padId] = {
      lastSyncedText: '',
      textVersion: 0,
      inflight: null,
      pendingTarget: null,
      requestToken: 0,
      pendingRemoteState: null,
      seenOperations: new Set(),
    };
  }
  return state.padSync[padId];
}

export const state = {
  ws: null,
  wsId: null,
  currentPadId: 1,
  pads: [],
  allFiles: [],
  reconnectTimer: null,
  reconnectAttempts: 0,
  userCode: null,
  longPressed: false,
  toastTimer: null,
  previewTargetId: null,
  sendTimeout: null,
  // Per-pad reliable-delivery state (see getPadSync).
  padSync: {},
  patchQueueKey(padId = this.currentPadId) {
    return `patch-queue:${padId || 1}`;
  },
  getPatchQueue(padId = this.currentPadId) {
    try { return JSON.parse(localStorage.getItem(this.patchQueueKey(padId)) || '[]'); } catch { return []; }
  },
  setPatchQueue(q, padId = this.currentPadId) {
    try { localStorage.setItem(this.patchQueueKey(padId), JSON.stringify(q)); } catch {}
  },
  convertCapabilities: {
    maxBytes: 10 * 1024 * 1024,
    timeoutMs: 60 * 1000,
    extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'log', 'html', 'htm', 'json', 'xml', 'yaml', 'yml', 'jpg', 'jpeg', 'png', 'gif'],
    features: { pptx: true, imageMetadata: true, imageCaption: false, ocr: false },
  },
};

export const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
export const $ = (s) => document.querySelector(s);

// --- DOM Helpers ---

export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

export function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// --- Pad Token Management (sessionStorage) ---

export function getPadToken(padId) {
  try { return JSON.parse(sessionStorage.getItem('pad-tokens') || '{}')[padId] || null; } catch { return null; }
}

export function setPadToken(padId, token) {
  try {
    const tokens = JSON.parse(sessionStorage.getItem('pad-tokens') || '{}');
    if (token) tokens[padId] = token;
    else delete tokens[padId];
    sessionStorage.setItem('pad-tokens', JSON.stringify(tokens));
  } catch {}
}

// --- Pad Data Operations ---

export function findPad(id) {
  return state.pads.find(p => p.id === id);
}

// --- File Data Operations ---

export function upsertLocalFile(file) {
  state.allFiles = state.allFiles.filter(f => f.id !== file.id);
  state.allFiles.unshift(file);
}

export function removeLocalFile(fileId) {
  state.allFiles = state.allFiles.filter(f => f.id !== fileId);
}

export function getFilesForPad(padId) {
  return state.allFiles.filter(f => f.padId === padId);
}

// --- Convertible Extensions ---

const CONVERTIBLE_EXTS = new Set(state.convertCapabilities.extensions);

export function isConvertible(name) {
  return CONVERTIBLE_EXTS.has((name || '').toLowerCase().split('.').pop());
}

export function canConvert(file) {
  return isConvertible(file.name) && file.size <= state.convertCapabilities.maxBytes;
}

export function refreshConvertibleExts() {
  CONVERTIBLE_EXTS.clear();
  state.convertCapabilities.extensions.forEach(ext => CONVERTIBLE_EXTS.add(ext));
}

// --- File Display Helpers ---

export function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function timeAgo(ts) {
  const sec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export function fileIcon(name) {
  const ext = (name || '').toLowerCase().split('.').pop();
  const icons = {
    pdf: '📄', doc: '📄', docx: '📄', txt: '📄', md: '📄',
    xls: '📊', xlsx: '📊', csv: '📊',
    zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
    mp3: '🎵', wav: '🎵', ogg: '🎵', flac: '🎵', aac: '🎵',
    mp4: '🎬', webm: '🎬', mov: '🎬', avi: '🎬',
    png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
    js: '💻', ts: '💻', py: '💻', go: '💻', rs: '💻', java: '💻',
    json: '💻', xml: '💻', yaml: '💻', yml: '💻',
  };
  return icons[ext] || '📁';
}

export function safeJsonParse(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}
