/**
 * CoMark-Notepad — QR Code popup module
 *
 * Handles hover/click-to-show QR code for mobile pairing.
 */

import { $ } from './core.js';

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
