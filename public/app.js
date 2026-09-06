/**
 * CoMark-Notepad — Entry module
 *
 * Orchestrates initialization of all sub-modules and wires cross-module
 * dependencies (e.g. visibility change handler that touches both files and
 * websocket modules).
 */

import { state, $ } from './js/core.js';
import { initTheme } from './js/theme.js';
import { loadPadContent, renderPadTabs, refreshPads, updateLockButton, initLockButton } from './js/pads.js';
import { initFileSearch, initFileUpload, startTimeLabelUpdater, stopTimeLabelUpdater } from './js/files.js';
import { initPasswordModal, initUnlockModal } from './js/modals.js';
import { initInvitation } from './js/invitation.js';
import { initIdentity, connectWS, loadConvertCapabilitiesUI, reconnectNow } from './js/ws.js';
import { initTextSync } from './js/text-sync.js';
import { initQR } from './js/qr.js';
import { initExport, initBeforeUnload } from './js/export.js';
import { initShortcuts } from './js/shortcuts.js';
import { initGestures, reinitGesturesOnResize } from './js/gestures.js';
import { initSearch } from './js/search.js';
import { initWriteAccess } from './js/write-access.js';
import { initPresence } from './js/presence.js';
import { initPreview } from './js/preview.js';

// --- Mobile detection ---
function updateMobileClass() {
  document.documentElement.classList.toggle('is-mobile', window.innerWidth <= 600);
}
updateMobileClass();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    updateMobileClass();
    reinitGesturesOnResize();
  }, 150);
});
window.addEventListener('orientationchange', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    updateMobileClass();
    reinitGesturesOnResize();
  }, 300);
});

// --- Visibility change (coordinates files + ws modules) ---
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopTimeLabelUpdater();
  } else {
    startTimeLabelUpdater();
    refreshPads();
    if (state.ws && state.ws.readyState !== WebSocket.OPEN) connectWS();
  }
});

// --- Init ---
async function init() {
  // Independent synchronous inits
  initTheme();
  initLockButton();
  initPasswordModal();
  initUnlockModal();
  initInvitation();
  initTextSync();
  initFileSearch();
  initFileUpload();
  initQR();
  initExport();
  initBeforeUnload();
  // CDN-loaded optional dependency: a failed network/SRI load must not abort
  // the rest of application initialization.
  initShortcuts(globalThis.hotkeys);
  initGestures();
  initSearch();
  initWriteAccess();
  initPresence();
  initPreview();
  const reconnectBtn = $('#reconnect-now');
  if (reconnectBtn) reconnectBtn.addEventListener('click', reconnectNow);

  // Async: load capabilities + identity in parallel
  await Promise.all([loadConvertCapabilitiesUI(), initIdentity()]);

  // Load pads, content, then connect WebSocket. A fresh install has no pads
  // (server-side Pad #1 seeding was removed): connecting would be closed with
  // 4404 "Pad not found", so stay deliberately offline until a pad exists —
  // switchPad() connects the moment the first one is created.
  await refreshPads();
  await loadPadContent();
  if (state.pads.some((p) => p.id === state.currentPadId)) {
    connectWS();
  }
}

init();
