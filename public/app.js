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
import {
  initIdentity, initIdentityBindings, connectWS, initTextSync,
  initQR, initExport, initKeyboard, initBeforeUnload,
  loadConvertCapabilitiesUI,
} from './js/ws.js';

// --- Mobile detection ---
function updateMobileClass() {
  document.documentElement.classList.toggle('is-mobile', window.innerWidth <= 600);
}
updateMobileClass();

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateMobileClass, 150);
});
window.addEventListener('orientationchange', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(updateMobileClass, 300);
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
  initKeyboard();
  initBeforeUnload();
  initIdentityBindings();

  // Async: load capabilities + identity in parallel
  await Promise.all([loadConvertCapabilitiesUI(), initIdentity()]);

  // Load pads, content, then connect WebSocket
  await refreshPads();
  await loadPadContent();
  connectWS();
}

init();
