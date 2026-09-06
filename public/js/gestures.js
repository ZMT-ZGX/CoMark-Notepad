/**
 * Mobile touch-gesture module — powered by AlloyFinger.
 *
 * Only initialised on mobile viewports (`.is-mobile` on <html>).
 * Provides:
 *   - Swipe Left / Right on the main area → switch Pad
 *   - Swipe Down on the main area → close open modals
 */

import { state, $, showToast } from './core.js';
import { switchPad } from './pads.js';
import { closeAllModals, isModalOpen } from './modal-manager.js';

/* global AlloyFinger */

/**
 * Navigate to the adjacent pad in the given direction.
 * @param {'left'|'right'} direction
 */
function navigatePad(direction) {
  const pads = state.pads;
  if (pads.length <= 1) return;

  const idx = pads.findIndex((p) => p.id === state.currentPadId);
  let nextIdx;
  if (direction === 'left') {
    nextIdx = (idx + 1) % pads.length;
  } else {
    nextIdx = (idx - 1 + pads.length) % pads.length;
  }

  const target = pads[nextIdx];
  switchPad(target.id);
  showToast(`Pad ${target.id}`);
}

function anyModalOpen() {
  return [
    'password-modal', 'unlock-modal', 'confirm-modal',
    'invite-modal', 'upload-confirm-modal', 'preview-modal',
    'write-access-modal', 'profile-modal', 'members-modal',
  ].some((id) => isModalOpen(id));
}

let gestureInstance = null;

/**
 * Initialise touch gestures on the main content area.
 * No-op when AlloyFinger is unavailable or the viewport is desktop-sized.
 * Re-initialises automatically when switching between mobile/desktop.
 */
export function initGestures() {
  if (typeof AlloyFinger === 'undefined') return;

  const isMobile = document.documentElement.classList.contains('is-mobile');

  // Tear down existing instance when switching to desktop
  if (!isMobile) {
    if (gestureInstance) {
      gestureInstance.destroy?.();
      gestureInstance = null;
    }
    return;
  }

  const main = document.querySelector('main');
  if (!main) return;

  // Avoid double-init
  if (gestureInstance) return;

  // Swipe detection threshold — AlloyFinger fires `swipe` only when the
  // touch movement is fast enough (< ~300 ms).  Slower drags are treated
  // as pressMove and ignored here, so normal textarea scrolling is safe.

  gestureInstance = new AlloyFinger(main, {
    swipe(evt) {
      // If a modal is open, any swipe should close it first.
      if (anyModalOpen()) {
        closeAllModals();
        return;
      }

      // Fast horizontal swipe inside the textarea is text selection / caret
      // motion — never treat it as a pad switch.
      const origin = evt.target || evt.srcEvent?.target;
      if (origin && origin.closest && origin.closest('#text-input')) return;

      switch (evt.direction) {
        case 'Left':
          navigatePad('left');
          break;
        case 'Right':
          navigatePad('right');
          break;
        case 'Down':
          break;
      }
    },
  });
}

/**
 * Re-evaluate gesture binding after viewport changes.
 * Call this from the resize/orientationchange handler.
 */
export function reinitGesturesOnResize() {
  if (gestureInstance) {
    gestureInstance.destroy?.();
    gestureInstance = null;
  }
  initGestures();
}
