import { state, $, showToast, getPadToken, setPadToken, findPad, getFilesForPad } from './core.js';
import { fetchState, fetchPadContent, createPadApi, deletePadApi } from './server.js';
import { renderFilesList } from './files.js';
import { connectWS } from './ws.js';
import { showUnlockModal, showConfirmModal } from './modals.js';

// --- Pad Tabs ---

export function renderPadTabs() {
  const container = $('#pad-tabs');
  container.innerHTML = '';

  function addPadBtn(pad, label) {
    const btn = document.createElement('button');
    btn.className = 'pad-btn' + (pad.id === state.currentPadId ? ' active' : '');
    btn.dataset.testid = `pad-tab-${pad.id}`;
    if (pad.hasPassword) btn.classList.add('locked');
    btn.textContent = label || pad.id;
    btn.title = pad.hasPassword ? `Pad ${pad.id} (locked)` : `Pad ${pad.id}`;
    btn.addEventListener('click', () => {
      if (state.longPressed) { state.longPressed = false; return; }
      switchPad(pad.id);
    });
    btn.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showDeletePadMenu(pad.id);
    });
    // Long-press for mobile (no right-click)
    let longPressTimer;
    btn.addEventListener('touchstart', () => {
      state.longPressed = false;
      longPressTimer = setTimeout(() => {
        state.longPressed = true;
        showDeletePadMenu(pad.id);
      }, 600);
    }, { passive: true });
    btn.addEventListener('touchend', () => {
      clearTimeout(longPressTimer);
      if (state.longPressed) {
        setTimeout(() => { state.longPressed = false; }, 100);
      }
    });
    btn.addEventListener('touchmove', () => {
      clearTimeout(longPressTimer);
      state.longPressed = false;
    });
    btn.addEventListener('touchcancel', () => {
      clearTimeout(longPressTimer);
      state.longPressed = false;
    });
    container.appendChild(btn);
  }

  for (const pad of state.pads) {
    addPadBtn(pad);
  }

  // Add [+] button
  const addBtn = document.createElement('button');
  addBtn.className = 'pad-add-btn';
  addBtn.dataset.testid = 'new-pad';
  addBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>';
  addBtn.title = 'New pad';
  addBtn.addEventListener('click', createPad);
  container.appendChild(addBtn);
}

export async function switchPad(padId) {
  if (padId === state.currentPadId) return;
  // Flush pending text sync for the old pad before switching
  if (state.sendTimeout) {
    clearTimeout(state.sendTimeout);
    const { sendTextNow } = await import('./text-sync.js');
    await sendTextNow();
  }
  const { flushPatchQueue } = await import('./text-sync.js');
  flushPatchQueue(state.currentPadId); // flush old pad queue if WS open

  state.lastTextRequestId = 0;
  state.currentPadId = padId;
  state.textVersion = 0;
  state.pendingRemoteState = null;
  state.lastSyncedText = '';
  $('#text-input').value = '';

  renderPadTabs();
  updateLockButton();
  renderFilesList(getFilesForPad(padId));

  await loadPadContent();
  connectWS();
}

export async function createPad() {
  try {
    const data = await createPadApi();
    const newPad = {
      id: data.id,
      hasPassword: data.hasPassword || false,
      createdAt: Date.now(),
      ownerUserId: data.ownerUserId || null,
    };
    state.pads.push(newPad);
    renderPadTabs();
    await switchPad(data.id);
    showToast(`Created pad ${data.id}`);
  } catch (e) {
    showToast(e.message);
  }
}

export async function refreshPads() {
  try {
    const data = await fetchState();
    if (!Array.isArray(data.pads)) throw new Error('Invalid pads data');
    state.pads = data.pads;
    state.allFiles = Array.isArray(data.files) ? data.files : [];
    renderFilesList(getFilesForPad(state.currentPadId));
    renderPadTabs();
    updateLockButton();
  } catch (e) {
    console.warn('Failed to refresh pads:', e);
  }
}

export async function loadPadContent() {
  const padId = state.currentPadId;
  try {
    const res = await fetchPadContent(padId);
    if (padId !== state.currentPadId) return;

    if (res.status === 403) {
      const data = await res.json();
      if (data.hasPassword) {
        showUnlockModal(padId);
        return;
      }
    }
    if (!res.ok) throw new Error('Failed to load pad');
    const data = await res.json();
    if (padId !== state.currentPadId) return;
    const nextVersion = Number.isInteger(data.textVersion) ? data.textVersion : 0;
    // Import text-sync lazily to avoid circular dep at init time
    const { applyTextState } = await import('./text-sync.js');
    applyTextState(data.text || '', nextVersion);
  } catch (e) {
    console.warn('Failed to load pad content:', e);
  }
}

// --- Lock Button ---

export function updateLockButton() {
  const pad = findPad(state.currentPadId);
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

export function initLockButton() {
  $('#pad-lock-btn').addEventListener('click', async () => {
    const { showPasswordModal } = await import('./modals.js');
    const pad = findPad(state.currentPadId);
    if (!pad) return;
    showPasswordModal(pad.hasPassword ? 'change' : 'set');
  });
}

// --- Delete Pad ---

async function showDeletePadMenu(padId) {
  if (state.pads.length <= 1) {
    showToast('Cannot delete the last pad');
    return;
  }
  showConfirmModal(
    `Delete Pad ${padId}?`,
    'This will permanently delete the pad and its content.',
    'Delete',
    async () => {
      try {
        await deletePadApi(padId);
        setPadToken(padId, null);
        if (padId === state.currentPadId) {
          const nextPad = state.pads
            .filter(p => p.id !== padId)
            .sort((a, b) => a.createdAt - b.createdAt)[0];
          if (nextPad) {
            state.currentPadId = nextPad.id;
            state.textVersion = 0;
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
