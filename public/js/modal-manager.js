/**
 * Modal manager — single source of truth for opening/closing modal overlays.
 *
 * Replaces the per-module `hidden` toggling and the three divergent
 * `closeAllModals` copies that used to live in shortcuts.js / gestures.js /
 * the modules themselves. Provides:
 *   - an open-stack so Esc closes the topmost modal only
 *   - a native document-level Esc listener (works even when hotkeys-js fails)
 *   - focus trap (Tab cycles inside the topmost modal) + focus restore
 *   - role="dialog" / aria-modal on open
 */

const openStack = []; // topmost = last
let escBound = false;

function resolve(idOrEl) {
  if (typeof idOrEl === 'string') return document.getElementById(idOrEl);
  return idOrEl;
}

function focusables(modal) {
  return Array.from(
    modal.querySelectorAll(
      'button:not([disabled]):not([hidden]), input:not([disabled]):not([hidden]), [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => el.offsetParent !== null || el === document.activeElement);
}

function onKeydown(e) {
  if (openStack.length === 0) return;
  const top = openStack[openStack.length - 1];
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    closeModal(top);
    return;
  }
  if (e.key === 'Tab') {
    const items = focusables(top);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    } else if (!top.contains(document.activeElement)) {
      e.preventDefault();
      first.focus();
    }
  }
}

function bindEsc() {
  if (escBound) return;
  escBound = true;
  document.addEventListener('keydown', onKeydown, true);
}

export function openModal(idOrEl) {
  const modal = resolve(idOrEl);
  if (!modal) return;
  bindEsc();
  if (openStack.includes(modal)) return;
  modal._triggerEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modal.hidden = false;
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  openStack.push(modal);
}

export function closeModal(idOrEl) {
  const modal = resolve(idOrEl);
  if (!modal) return;
  modal.hidden = true;
  const at = openStack.indexOf(modal);
  if (at !== -1) openStack.splice(at, 1);
  // Return focus to whatever opened the modal so keyboard users don't get lost.
  const trigger = modal._triggerEl;
  modal._triggerEl = null;
  if (openStack.length === 0 && trigger && trigger.isConnected) {
    try { trigger.focus(); } catch {}
  }
}

export function closeAllModals() {
  while (openStack.length > 0) {
    closeModal(openStack[openStack.length - 1]);
  }
}

export function isModalOpen(id) {
  const modal = resolve(id);
  return !!modal && !modal.hidden;
}

/**
 * Disable a button for the duration of an async action (prevents double
 * submits on slow networks).
 */
export async function withPending(btn, fn) {
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  try {
    await fn();
  } finally {
    btn.disabled = false;
  }
}
