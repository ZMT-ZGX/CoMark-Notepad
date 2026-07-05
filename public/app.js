/**
 * CoMark-Notepad — Entry module
 *
 * Orchestrates initialization of all sub-modules and wires cross-module
 * dependencies (e.g. visibility change handler that touches both files and
 * websocket modules).
 */

import { state } from './js/core.js';
import { initTheme } from './js/theme.js';
import { loadPadContent, renderPadTabs, refreshPads, updateLockButton, initLockButton } from './js/pads.js';
import { initFileSearch, initFileUpload, startTimeLabelUpdater, stopTimeLabelUpdater } from './js/files.js';
import { initPasswordModal, initUnlockModal } from './js/modals.js';
import { initInvitation } from './js/invitation.js';
import { initIdentity, initIdentityBindings, connectWS, loadConvertCapabilitiesUI } from './js/ws.js';
import { initTextSync } from './js/text-sync.js';
import { initQR } from './js/qr.js';
import { initExport, initBeforeUnload } from './js/export.js';
import { initShortcuts } from './js/shortcuts.js';
import { initGestures, reinitGesturesOnResize } from './js/gestures.js';
import { initSearch } from './js/search.js';

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
  initIdentityBindings();
  initShortcuts(hotkeys);
  initGestures();
  initSearch();

  // Async: load capabilities + identity in parallel
  await Promise.all([loadConvertCapabilitiesUI(), initIdentity()]);

  // Load pads, content, then connect WebSocket
  await refreshPads();
  await loadPadContent();
  connectWS();
}

init();
