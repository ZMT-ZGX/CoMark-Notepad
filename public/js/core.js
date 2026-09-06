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
//   pendingRemotePatches : remote diffs deferred while an IME composition is
//                    active — patch frames carry no body, so they are parked
//                    as diffs and replayed in arrival order at compositionend.
//
// `seenOperations` grows to 10k entries per pad, so pads are kept on a small
// LRU: the least recently used ones have their dedupe cache dropped, while
// their shadow / version / in-flight state must survive because offline diffs
// for a background pad are still computed against that shadow.
const PAD_SYNC_LRU_LIMIT = 5;
const padSyncOrder = [];

function prunePadSyncCaches() {
  while (padSyncOrder.length > PAD_SYNC_LRU_LIMIT) {
    const stale = padSyncOrder.shift();
    const sync = state.padSync[stale];
    if (sync) sync.seenOperations.clear();
  }
}

export function getPadSync(padId) {
  if (!state.padSync[padId]) {
    state.padSync[padId] = {
      lastSyncedText: '',
      textVersion: 0,
      inflight: null,
      pendingTarget: null,
      requestToken: 0,
      pendingRemoteState: null,
      pendingRemotePatches: [],
      seenOperations: new Set(),
    };
  }
  const at = padSyncOrder.indexOf(padId);
  if (at !== -1) padSyncOrder.splice(at, 1);
  padSyncOrder.push(padId);
  prunePadSyncCaches();
  return state.padSync[padId];
}

// Drop every trace of a deleted pad: sync state, in-memory queue, and the
// persisted offline queue. Without this, deleting a pad leaked its shadow and
// localStorage entry forever.
export function dropPadState(padId) {
  delete state.padSync[padId];
  delete state.volatilePatchQueue[padId];
  const at = padSyncOrder.indexOf(padId);
  if (at !== -1) padSyncOrder.splice(at, 1);
  try { localStorage.removeItem(state.patchQueueKey(padId)); } catch {}
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
  isPadLocked(padId = this.currentPadId) {
    const pad = this.pads.find((p) => Number(p.id) === Number(padId));
    return !!(pad && pad.hasPassword);
  },
  // Queues for password-protected pads live in memory only.
  //
  // A queued entry is a diff from the confirmed shadow, so the first offline
  // edit to a freshly-loaded pad makes the entry effectively the *whole
  // document*. Writing that to localStorage leaves the protected body in
  // cleartext on disk — readable by any script running in the origin and
  // surviving browser restarts — which is precisely what the pad password
  // exists to prevent. The trade-off: unsent edits to a locked pad are lost
  // on reload instead of being recovered.
  volatilePatchQueue: {},
  getPatchQueue(padId = this.currentPadId) {
    if (this.isPadLocked(padId)) return this.volatilePatchQueue[padId] || [];
    try { return JSON.parse(localStorage.getItem(this.patchQueueKey(padId)) || '[]'); } catch { return []; }
  },
  // A failed write must be visible: silently dropping the queue lost the
  // user's offline edits while the banner still promised they were pending.
  setPatchQueue(q, padId = this.currentPadId) {
    if (this.isPadLocked(padId)) {
      this.volatilePatchQueue[padId] = q;
      // Drop anything persisted before this pad became known-locked.
      try { localStorage.removeItem(this.patchQueueKey(padId)); } catch {}
      return;
    }
    delete this.volatilePatchQueue[padId];
    const key = this.patchQueueKey(padId);
    try {
      localStorage.setItem(key, JSON.stringify(q));
    } catch {
      try {
        // Quota exceeded — keep at least the newest entry so the latest edits
        // still make it out once the connection is back.
        localStorage.setItem(key, JSON.stringify(q.slice(-1)));
        showToast('Offline queue too large - keeping only your latest change');
      } catch {
        try { localStorage.removeItem(key); } catch {}
        showToast('Local storage is full - offline changes may be lost');
      }
    }
  },
  convertCapabilities: {
    maxBytes: 100 * 1024 * 1024,
    timeoutMs: 60 * 1000,
    extensions: ['pdf', 'docx', 'xlsx', 'pptx', 'csv', 'txt', 'log', 'html', 'htm', 'json', 'xml', 'yaml', 'yml', 'jpg', 'jpeg', 'png', 'gif'],
    features: { pptx: true, imageMetadata: true, imageCaption: false, ocr: false },
  },
  // Write-access gate state. The SHAPE lives here (state is declared in one
  // place); write-access.js updates values only through the setters below —
  // the same getter/setter contract as getPatchQueue/setPatchQueue.
  gated: false,
  writeAccess: { allowed: true, source: 'open', permanent: true, expiresAt: null, daysRemaining: null },
  adminToken: null,
  setWriteAccess(next) {
    this.gated = !!next.gated;
    this.writeAccess = next.writeAccess;
  },
  setAdminToken(token) {
    this.adminToken = token || null;
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

export function showToast(msg, type = 'info') {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.remove('error', 'success', 'shortcuts');
  if (type === 'error' || type === 'success') toast.classList.add(type);
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

// --- Pad Token Management (sessionStorage) ---

export function getPadToken(padId) {
  try { return JSON.parse(sessionStorage.getItem('pad-tokens') || '{}')[padId] || null; } catch { return null; }
}

export function getAllPadTokens() {
  try {
    return Object.values(JSON.parse(sessionStorage.getItem('pad-tokens') || '{}')).filter(Boolean);
  } catch {
    return [];
  }
}

export function setPadToken(padId, token) {
  try {
    const tokens = JSON.parse(sessionStorage.getItem('pad-tokens') || '{}');
    if (token) tokens[padId] = token;
    else delete tokens[padId];
    sessionStorage.setItem('pad-tokens', JSON.stringify(tokens));
  } catch {}
}

// Build request headers carrying X-Pad-Token. Pass a padId for that pad's
// token, or omit it to send every stored unlock token (search / state).
export function padAuthHeaders(padId, base = {}) {
  const headers = { ...base };
  if (padId != null) {
    const token = getPadToken(padId);
    if (token) headers['X-Pad-Token'] = token;
  } else {
    const tokens = getAllPadTokens();
    if (tokens.length) headers['X-Pad-Token'] = tokens.join(',');
  }
  return headers;
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
