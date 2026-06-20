const $ = (s) => document.querySelector(s);

// --- Mobile detection (more reliable than @media on iOS Safari) ---
function updateMobileClass() {
  document.documentElement.classList.toggle('is-mobile', window.innerWidth <= 600);
}
updateMobileClass();
window.addEventListener('resize', updateMobileClass);
window.addEventListener('orientationchange', () => setTimeout(updateMobileClass, 100));

// --- State ---
let ws;
let wsId = null;
let currentPadId = 1;
let pads = [];
let textVersion = 0;
let pendingRemoteState = null;
let lastTextRequestId = 0;
let reconnectTimer = null;
let userCode = null; // Current user's display code (from cookie-based auth)
let longPressed = false; // Flag to prevent click after long-press on pad tabs

async function initIdentity() {
  // Check if we already have a user code in sessionStorage
  try { userCode = sessionStorage.getItem('userCode') || null; } catch {}

  // Try to verify existing session via cookie
  try {
    const res = await fetch('/api/auth/me');
    if (res.ok) {
      const data = await res.json();
      userCode = data.code;
    } else {
      // No valid session → register new user
      const regRes = await fetch('/api/auth/register', { method: 'POST' });
      if (regRes.ok) {
        const regData = await regRes.json();
        userCode = regData.code;
      }
    }
  } catch (e) {
    console.warn('Identity init failed:', e);
  }

  // Persist user code for display purposes
  if (userCode) {
    try { sessionStorage.setItem('userCode', userCode); } catch {}
    updateUserCodeUI();
  }
}

function updateUserCodeUI() {
  const el = $('#user-code-display');
  if (!el) return;
  if (userCode) {
    el.textContent = userCode;
    el.parentElement.hidden = false;
  } else {
    el.parentElement.hidden = true;
  }
}

function copyUserCode() {
  if (!userCode) return;
  navigator.clipboard.writeText(userCode).then(
    () => showToast('User code copied!'),
    () => showToast('Copy failed')
  );
}



// Pad unlock tokens (padId -> token), stored in sessionStorage
function getPadToken(padId) {
  try { return JSON.parse(sessionStorage.getItem('pad-tokens') || '{}')[padId] || null; } catch { return null; }
}
function setPadToken(padId, token) {
  try {
    const tokens = JSON.parse(sessionStorage.getItem('pad-tokens') || '{}');
    if (token) tokens[padId] = token;
    else delete tokens[padId];
    sessionStorage.setItem('pad-tokens', JSON.stringify(tokens));
  } catch {}
}

// --- Theme ---
let themeMode = localStorage.getItem('notepad-theme') || 'auto';

function applyTheme() {
  if (themeMode === 'auto') {
    document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } else {
    document.documentElement.dataset.theme = themeMode;
  }
}

function toggleTheme() {
  const order = ['auto', 'dark', 'light'];
  themeMode = order[(order.indexOf(themeMode) + 1) % 3];
  if (themeMode === 'auto') localStorage.removeItem('notepad-theme');
  else localStorage.setItem('notepad-theme', themeMode);
  applyTheme();
}

applyTheme();
$('#theme-toggle').addEventListener('click', toggleTheme);
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (themeMode === 'auto') applyTheme();
});

// --- Pad Tabs ---

function renderPadTabs() {
  const container = $('#pad-tabs');
  container.innerHTML = '';

  // Group pads: public (ownerUserId=null), mine, invited
  const myPads = pads.filter(p => p.ownerUserId === userCode);
  const publicPads = pads.filter(p => !p.ownerUserId);
  const invitedPads = pads.filter(p => p.ownerUserId && p.ownerUserId !== userCode);

  function addPadBtn(pad, label) {
    const btn = document.createElement('button');
    btn.className = 'pad-btn' + (pad.id === currentPadId ? ' active' : '');
    if (pad.hasPassword) btn.classList.add('locked');
    btn.textContent = label || pad.id;
    btn.title = pad.hasPassword ? `Pad ${pad.id} (locked)` : `Pad ${pad.id}`;
    btn.addEventListener('click', () => {
      if (longPressed) { longPressed = false; return; }
      switchPad(pad.id);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showDeletePadMenu(pad.id);
    });
    // Long-press for mobile (no right-click)
    let longPressTimer;
    btn.addEventListener('touchstart', (e) => {
      longPressed = false;
      longPressTimer = setTimeout(() => {
        longPressed = true;
        showDeletePadMenu(pad.id);
      }, 600);
    }, { passive: true });
    btn.addEventListener('touchend', () => clearTimeout(longPressTimer));
    btn.addEventListener('touchmove', () => clearTimeout(longPressTimer));
    container.appendChild(btn);
  }

  // Show all pads (simple flat list with optional group labels for clarity)
  for (const pad of pads) {
    addPadBtn(pad);
  }

  // Add [+] button
  const addBtn = document.createElement('button');
  addBtn.className = 'pad-add-btn';
  addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.title = 'New pad';
  addBtn.addEventListener('click', createPad);
  container.appendChild(addBtn);
}

async function switchPad(padId) {
  if (padId === currentPadId) return;
  currentPadId = padId;
  textVersion = 0;
  pendingRemoteState = null;
  $('#text-input').value = '';

  renderPadTabs();
  updateLockButton();

  // Try to load pad content
  await loadPadContent();
  // Reconnect WebSocket with new pad
  connectWS();
}

async function createPad() {
  try {
    const res = await fetch('/api/pads', { method: 'POST' });
    if (!res.ok) throw new Error('Failed to create pad');
    const data = await res.json();
    // Refresh pads list
    await refreshPads();
    await switchPad(data.id);
    showToast(`Created pad ${data.id}`);
  } catch (e) {
    showToast(e.message);
  }
}

async function refreshPads() {
  try {
    const res = await fetch('/api/state');
    if (!res.ok) throw new Error('Failed to load state');
    const data = await res.json();
    pads = data.pads || [];
    renderFilesList(data.files || []);
    renderPadTabs();
    updateLockButton();
  } catch (e) {
    console.warn('Failed to refresh pads:', e);
  }
}

async function loadPadContent() {
  const padId = currentPadId;
  const token = getPadToken(padId);
  const headers = {};
  if (token) headers['X-Pad-Token'] = token;

  try {
    const res = await fetch(`/api/pads/${padId}`, { headers });
    if (res.status === 403) {
      const data = await res.json();
      if (data.hasPassword) {
        showUnlockModal(padId);
        return;
      }
    }
    if (!res.ok) throw new Error('Failed to load pad');
    const data = await res.json();
    const nextVersion = Number.isInteger(data.textVersion) ? data.textVersion : 0;
    applyTextState(data.text || '', nextVersion);
  } catch (e) {
    console.warn('Failed to load pad content:', e);
  }
}

// --- Lock Button ---

function updateLockButton() {
  const pad = pads.find(p => p.id === currentPadId);
  const btn = $('#pad-lock-btn');
  if (!pad) { btn.hidden = true; return; }
  btn.hidden = false;
  if (pad.hasPassword) {
    btn.title = 'Change/remove password';
    btn.style.color = 'var(--primary)';
  } else {
    btn.title = 'Set password';
    btn.style.color = '';
  }
}

$('#pad-lock-btn').addEventListener('click', () => {
  const pad = pads.find(p => p.id === currentPadId);
  if (!pad) return;
  if (pad.hasPassword) {
    showPasswordModal('change');
  } else {
    showPasswordModal('set');
  }
});

// --- Password Modal ---

let passwordMode = 'set'; // 'set' | 'change' | 'remove'

function showPasswordModal(mode) {
  passwordMode = mode;
  const modal = $('#password-modal');
  const title = $('#password-modal-title');
  const desc = $('#password-modal-desc');
  const input = $('#password-input');
  const confirmInput = $('#password-confirm');
  const currentInput = $('#password-current');
  const confirmBtn = $('#password-confirm-btn');
  const error = $('#password-error');

  error.hidden = true;
  input.value = '';
  confirmInput.value = '';
  currentInput.value = '';

  if (mode === 'set') {
    title.textContent = 'Set Password';
    desc.textContent = 'Enter a password to protect this pad';
    currentInput.hidden = true;
    confirmInput.hidden = false;
    confirmBtn.textContent = 'Set Password';
    confirmBtn.className = 'modal-btn confirm';
  } else if (mode === 'change') {
    title.textContent = 'Change Password';
    desc.textContent = 'Enter a new password, or leave empty to remove';
    // Current password is optional: server accepts a valid X-Pad-Token instead.
    // Only needed when the unlock token has expired (24h) or session was lost.
    currentInput.hidden = false;
    currentInput.placeholder = 'Current password (if unlock expired)';
    confirmInput.hidden = false;
    confirmBtn.textContent = 'Update';
    confirmBtn.className = 'modal-btn confirm';
  }

  modal.hidden = false;
  input.focus();
}

function hidePasswordModal() {
  $('#password-modal').hidden = true;
}

$('#password-cancel').addEventListener('click', hidePasswordModal);

$('#password-confirm-btn').addEventListener('click', async () => {
  const password = $('#password-input').value;
  const confirm = $('#password-confirm').value;
  const currentPassword = $('#password-current').value;
  const error = $('#password-error');

  if (password && password !== confirm) {
    error.textContent = 'Passwords do not match';
    error.hidden = false;
    return;
  }

  const token = getPadToken(currentPadId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;

  const body = { password: password || null };
  // Send currentPassword when provided (covers the case where the unlock
  // token has expired and X-Pad-Token alone won't authorize the change).
  if (currentPassword) body.currentPassword = currentPassword;

  try {
    const res = await fetch(`/api/pads/${currentPadId}/password`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Failed to set password');
    }
    const data = await res.json();
    if (data.token) setPadToken(currentPadId, data.token);
    else setPadToken(currentPadId, null);

    hidePasswordModal();
    await refreshPads();
    showToast(password ? 'Password set' : 'Password removed');
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
});

// --- Unlock Modal ---

let unlockTargetPadId = null;

function showUnlockModal(padId) {
  unlockTargetPadId = padId;
  $('#unlock-error').hidden = true;
  $('#unlock-input').value = '';
  $('#unlock-modal').hidden = false;
  $('#unlock-input').focus();
}

function hideUnlockModal() {
  $('#unlock-modal').hidden = true;
  unlockTargetPadId = null;
}

$('#unlock-cancel').addEventListener('click', hideUnlockModal);

$('#unlock-confirm-btn').addEventListener('click', async () => {
  if (!unlockTargetPadId) return;
  const password = $('#unlock-input').value;
  const error = $('#unlock-error');
  error.hidden = true;

  try {
    const res = await fetch(`/api/pads/${unlockTargetPadId}/unlock`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'Wrong password');
    }
    const data = await res.json();
    if (data.token) setPadToken(unlockTargetPadId, data.token);
    hideUnlockModal();
    currentPadId = unlockTargetPadId;
    await loadPadContent();
    connectWS();
    renderPadTabs();
    updateLockButton();
    showToast('Unlocked');
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
});

$('#unlock-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#unlock-confirm-btn').click();
});

// --- Confirm Modal (for delete pad / clear all) ---

function showConfirmModal(title, desc, okText, onConfirm) {
  $('#confirm-title').textContent = title;
  $('#confirm-desc').textContent = desc;
  $('#confirm-ok').textContent = okText;
  $('#confirm-modal').hidden = false;

  const okBtn = $('#confirm-ok');
  const cancelBtn = $('#confirm-cancel');

  function cleanup() {
    $('#confirm-modal').hidden = true;
  }

  cancelBtn.onclick = cleanup;
  okBtn.onclick = () => {
    cleanup();
    onConfirm();
  };
}

async function showDeletePadMenu(padId) {
  if (pads.length <= 1) {
    showToast('Cannot delete the last pad');
    return;
  }
  showConfirmModal(
    `Delete Pad ${padId}?`,
    'This will permanently delete the pad and its content.',
    'Delete',
    async () => {
      const token = getPadToken(padId);
      const headers = {};
      if (token) headers['X-Pad-Token'] = token;
      try {
        const res = await fetch(`/api/pads/${padId}`, { method: 'DELETE', headers });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Delete failed');
        }
        setPadToken(padId, null);
        if (padId === currentPadId) {
          const nextPad = pads.find(p => p.id !== padId);
          if (nextPad) {
            currentPadId = nextPad.id;
            textVersion = 0;
            await loadPadContent();
            connectWS();
          }
        }
        await refreshPads();
        showToast(`Deleted pad ${padId}`);
      } catch (e) {
        showToast(e.message);
      }
    }
  );
}

// --- WebSocket ---

function connectWS() {
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const padToken = getPadToken(currentPadId);
  const params = new URLSearchParams({ pad: String(currentPadId) });
  if (padToken) params.set('padToken', padToken);
  ws = new WebSocket(`${proto}//${location.host}/?${params}`);
  // Note: session token is sent via httpOnly cookie (browser auto-includes)
  // padToken is the per-pad unlock token (only present for password-protected pads)

  ws.onopen = () => {
    $('#status').className = 'status online';
    $('#status').title = 'Connected';
    loadPadContent();
  };

  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    switch (msg.type) {
      case 'hello':
        wsId = msg.wsId;
        break;
      case 'text-update':
        if (msg.padId === currentPadId) {
          applyRemoteText(msg.text, msg.textVersion);
        }
        break;
      case 'file-added':
        addFileToList(msg.file, true);
        updateFilesEmpty();
        break;
      case 'file-deleted':
        removeFileFromList(msg.fileId);
        break;
      case 'online-count':
        $('#online-count').textContent = msg.count;
        break;
      case 'pad-created':
      case 'pad-updated':
      case 'pad-deleted':
        refreshPads();
        break;
    }
  };

  ws.onclose = (e) => {
    $('#status').className = 'status offline';
    $('#status').title = 'Disconnected - reconnecting...';
    $('#online-count').textContent = '0';
    wsId = null;
    // 4403 = pad locked (password required) — don't auto-reconnect, prompt unlock
    if (e.code === 4403) {
      showUnlockModal(currentPadId);
      return;
    }
    // 4401 = access denied (no access grant) — unlocking won't help; don't loop
    if (e.code === 4401) {
      showToast('No access to this pad');
      refreshPads();
      return;
    }
    reconnectTimer = setTimeout(connectWS, 2000);
  };

  ws.onerror = () => ws.close();
}

// --- Invitation System ---

async function generateInvitation() {
  try {
    const res = await fetch('/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUses: 5 }),
    });
    if (!res.ok) throw new Error('Failed to create invitation');
    const data = await res.json();
    showInviteTokenModal(data.token);
  } catch (e) {
    showToast(e.message);
  }
}

function showInviteTokenModal(token) {
  const modal = $('#invite-modal');
  if (!modal) return;
  const tokenBox = modal.querySelector('.invite-token-box');
  const tokenDisplay = modal.querySelector('.invite-token-display');
  if (tokenDisplay) tokenDisplay.textContent = token;
  if (tokenBox) tokenBox.hidden = false;
  modal.hidden = false;
}

function hideInviteModal() {
  const modal = $('#invite-modal');
  if (modal) modal.hidden = true;
}

function copyInviteToken() {
  const modal = $('#invite-modal');
  const token = modal?.querySelector('.invite-token-display')?.textContent;
  if (!token) return;
  navigator.clipboard.writeText(token).then(
    () => showToast('Invite token copied!'),
    () => showToast('Copy failed')
  );
}

async function redeemInvite() {
  const input = $('#redeem-input');
  const error = $('#redeem-error');
  if (!input || !error) return;
  const token = input.value.trim();
  if (!token) { error.textContent = 'Please enter an invite token'; error.hidden = false; return; }

  try {
    const res = await fetch('/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Redeem failed');
    }
    const data = await res.json();
    hideInviteModal();
    showToast(`Access granted from ${data.grantorCode}`);
    await refreshPads();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
}

// --- Identity event bindings (CSP-safe, no inline onclick) ---

$('#copy-user-code-btn').addEventListener('click', copyUserCode);
$('#invite-btn').addEventListener('click', () => {
  const modal = $('#invite-modal');
  modal.hidden = !modal.hidden;
  $('#redeem-error').hidden = true;
});
$('#generate-invite-btn').addEventListener('click', generateInvitation);
$('#copy-invite-btn').addEventListener('click', copyInviteToken);
$('#close-invite-btn').addEventListener('click', hideInviteModal);
$('#redeem-invite-btn').addEventListener('click', redeemInvite);

// --- Text Sync ---

const textarea = $('#text-input');

function shouldDeferRemoteText() {
  return document.activeElement === textarea;
}

function applyTextState(text, version) {
  const ta = textarea;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  ta.value = text;
  ta.setSelectionRange(Math.min(start, text.length), Math.min(end, text.length));
  textVersion = Math.max(textVersion, version || 0);
}

function queueRemoteText(text, version) {
  if (version <= textVersion) return;
  pendingRemoteState = { text, textVersion: version };
}

function applyPendingRemoteText() {
  if (!pendingRemoteState) return;
  applyTextState(pendingRemoteState.text, pendingRemoteState.textVersion);
  pendingRemoteState = null;
}

function applyRemoteText(text, version) {
  if (version <= textVersion) return;
  if (shouldDeferRemoteText()) {
    queueRemoteText(text, version);
    return;
  }
  applyTextState(text, version);
}

let sendTimeout;
function sendText() {
  clearTimeout(sendTimeout);
  sendTimeout = setTimeout(async () => {
    const requestId = ++lastTextRequestId;
    const token = getPadToken(currentPadId);
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['X-Pad-Token'] = token;
    try {
      const res = await fetch(`/api/pads/${currentPadId}/text`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ text: textarea.value, _wsId: wsId }),
      });
      if (!res.ok) throw new Error('Failed to sync text');
      const data = await res.json();
      if (requestId === lastTextRequestId) {
        textVersion = Math.max(textVersion, data.textVersion || 0);
      }
    } catch (e) {
      console.warn('Failed to sync text:', e);
    }
  }, 300);
}

textarea.addEventListener('input', () => {
  sendText();
});

textarea.addEventListener('blur', () => {
  applyPendingRemoteText();
});

// --- File Upload ---

const fileInput = $('#file-input');
const dropOverlay = $('#drop-overlay');
let dragCounter = 0;

fileInput.addEventListener('change', (e) => {
  Array.from(e.target.files).forEach(uploadFile);
  e.target.value = '';
});

document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragCounter++;
  dropOverlay.classList.add('visible');
});

document.addEventListener('dragleave', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
  }
});

document.addEventListener('dragover', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
});

document.addEventListener('drop', (e) => {
  if (!e.dataTransfer?.types?.includes('Files')) return;
  e.preventDefault();
  dragCounter = 0;
  dropOverlay.classList.remove('visible');
  Array.from(e.dataTransfer.files).forEach(uploadFile);
});

async function uploadFile(file) {
  if (file.size > 100 * 1024 * 1024) {
    showToast('File too large (max 100MB)');
    return;
  }

  const progress = $('#upload-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  progress.hidden = false;
  progressText.textContent = `Uploading ${file.name}...`;
  progressFill.style.width = '0%';

  const formData = new FormData();
  formData.append('file', file, file.name);
  if (wsId) formData.append('_wsId', wsId);
  formData.append('padId', String(currentPadId));

  try {
    const uploadedFile = await uploadWithProgress(formData, (percent) => {
      progressFill.style.width = `${percent}%`;
    });
    addFileToList(uploadedFile, true);
    updateFilesEmpty();
    progressFill.style.width = '100%';
    showToast(`Uploaded: ${file.name}`);
  } catch (e) {
    showToast(e.message);
  }

  setTimeout(() => {
    progress.hidden = true;
  }, 500);
}

// --- File List ---

function formatSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function timeAgo(ts) {
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hrs = Math.floor(min / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function fileIcon(name) {
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

function createFileElement(file) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.dataset.id = file.id;
  el.dataset.createdAt = String(file.createdAt || Date.now());

  const sizeLabel = formatSize(file.size);
  el.innerHTML = `
    <div class="file-icon">${fileIcon(file.originalName)}</div>
    <div class="file-info">
      <div class="file-name">${escapeHtml(file.originalName)}</div>
      <div class="file-meta" data-size="${escapeHtml(sizeLabel)}">${sizeLabel} · ${timeAgo(file.createdAt)}</div>
    </div>
    <div class="file-actions">
      <button class="file-action download" title="Download">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="file-action delete" title="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `;

  el.querySelector('.download').addEventListener('click', () => {
    const a = document.createElement('a');
    a.href = `/api/files/${file.id}`;
    a.download = file.originalName;
    a.click();
  });

  el.querySelector('.delete').addEventListener('click', async () => {
    try {
      const res = await fetch(`/api/files/${file.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ _wsId: wsId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Delete failed');
      }
      removeFileFromList(file.id);
    } catch (e) {
      showToast(e.message);
    }
  });

  return el;
}

function addFileToList(file, prepend = false) {
  const list = $('#files-list');
  if (list.querySelector(`[data-id="${file.id}"]`)) return;
  const el = createFileElement(file);
  if (prepend) list.prepend(el);
  else list.appendChild(el);
}

function removeFileFromList(fileId) {
  const el = $(`#files-list [data-id="${fileId}"]`);
  if (el) {
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(-20px)';
    setTimeout(() => {
      el.remove();
      updateFilesEmpty();
    }, 200);
    return;
  }
  updateFilesEmpty();
}

function renderFilesList(files) {
  const list = $('#files-list');
  list.innerHTML = '';
  files.forEach((file) => addFileToList(file));
  updateFilesEmpty();
}

function updateFilesEmpty() {
  const empty = $('#files-empty');
  const list = $('#files-list');
  empty.hidden = list.children.length > 0;
}

// --- Utilities ---

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showToast(msg) {
  const toast = $('#toast');
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 2500);
}

function uploadWithProgress(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      const data = xhr.response && typeof xhr.response === 'object'
        ? xhr.response
        : safeJsonParse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error(data?.error || 'Upload failed'));
    });

    xhr.addEventListener('error', () => {
      reject(new Error('Upload failed'));
    });

    xhr.addEventListener('abort', () => {
      reject(new Error('Upload canceled'));
    });

    xhr.send(formData);
  });
}

function safeJsonParse(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

// --- Refresh time labels ---
setInterval(() => {
  document.querySelectorAll('.file-item').forEach((el) => {
    const meta = el.querySelector('.file-meta');
    if (!meta) return;
    const createdAt = Number(el.dataset.createdAt);
    const size = meta.dataset.size || '';
    meta.textContent = `${size} · ${timeAgo(createdAt)}`;
  });
}, 60000);

// --- QR Code ---

const titleEl = document.querySelector('.header-left');
const qrPopup = $('#qr-popup');
const qrImg = $('#qr-image');
let qrLoaded = false;

titleEl.addEventListener('mouseenter', () => {
  if (!qrLoaded) {
    qrImg.src = '/api/qrcode';
    qrLoaded = true;
  }
  qrPopup.hidden = false;
});

titleEl.addEventListener('mouseleave', () => {
  qrPopup.hidden = true;
});

// Mobile: tap to toggle QR popup (no hover on touch devices)
titleEl.addEventListener('click', (e) => {
  if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
    e.stopPropagation();
    if (!qrLoaded) {
      qrImg.src = '/api/qrcode';
      qrLoaded = true;
    }
    qrPopup.hidden = !qrPopup.hidden;
  }
});

// Close QR popup when tapping outside
document.addEventListener('click', (e) => {
  if (!titleEl.contains(e.target) && !qrPopup.contains(e.target)) {
    qrPopup.hidden = true;
  }
});

// --- Keyboard shortcuts ---

document.addEventListener('keydown', (e) => {
  // Escape closes modals
  if (e.key === 'Escape') {
    $('#password-modal').hidden = true;
    $('#unlock-modal').hidden = true;
    $('#confirm-modal').hidden = true;
    const inviteModal = $('#invite-modal');
    if (inviteModal) inviteModal.hidden = true;
  }
});

// --- Init ---

async function init() {
  await initIdentity();
  await refreshPads();
  await loadPadContent();
  connectWS();
}

init();
