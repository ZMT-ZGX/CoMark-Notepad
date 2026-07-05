/**
 * Keyboard shortcuts module — powered by hotkeys-js.
 *
 * All shortcuts use Ctrl (Windows/Linux) or ⌘ (macOS) modifiers so they
 * don't conflict with normal typing in the textarea.
 */

import { state, $, showToast } from './core.js';
import { createPad, switchPad } from './pads.js';
import { showPasswordModal } from './modals.js';
import { toggleInviteModal } from './invitation.js';
import { sendTextNow } from './text-sync.js';

/* global hotkeys */

/**
 * @typedef {typeof hotkeys} HotkeysFn
 */

/**
 * Close every open modal and the markdown preview.
 */
function closeAllModals() {
  $('#password-modal').hidden = true;
  $('#unlock-modal').hidden = true;
  $('#confirm-modal').hidden = true;
  const inviteModal = $('#invite-modal');
  if (inviteModal) inviteModal.hidden = true;
  const uploadModal = $('#upload-confirm-modal');
  if (uploadModal) uploadModal.hidden = true;
  const previewModal = $('#preview-modal');
  if (previewModal) previewModal.hidden = true;
  $('#preview-body').innerHTML = '';
}

/**
 * Export current pad text as a Markdown file.
 */
function exportMarkdown() {
  const text = $('#text-input').value;
  if (!text.trim()) {
    showToast('Nothing to export');
    return;
  }
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pad-${state.currentPadId}.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Exported!');
}

/**
 * Focus the textarea and place cursor at the end.
 */
function focusEditor() {
  const ta = $('#text-input');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

/**
 * Toggle the file-search input.
 */
function toggleFileSearch() {
  const bar = $('#file-search-bar');
  if (!bar) return;
  bar.hidden = !bar.hidden;
  if (!bar.hidden) {
    const input = $('#file-search');
    if (input) input.focus();
  }
}

/**
 * Register all keyboard shortcuts.
 * @param {HotkeysFn} hotkeysFn
 */
export function initShortcuts(hotkeysFn) {
  // Allow hotkeys to fire even when focus is inside <input> / <textarea>.
  // This is essential for Ctrl+S (save), Ctrl+E (export), etc.
  hotkeysFn.filter = (event) => {
    const tag = event.target?.tagName;
    // Always allow processing — individual handlers decide what to do.
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      // Allow modifier-combo shortcuts AND Escape inside text fields.
      return event.ctrlKey || event.metaKey || event.altKey || event.key === 'Escape';
    }
    return true;
  };

  // ── Pad management ──────────────────────────────────────────────

  // Ctrl/Cmd + N  →  New pad
  hotkeysFn('ctrl+n, command+n', (e) => {
    e.preventDefault();
    createPad();
  });

  // Ctrl/Cmd + S  →  Force-save current text (skip debounce)
  hotkeysFn('ctrl+s, command+s', (e) => {
    e.preventDefault();
    if (state.sendTimeout) {
      clearTimeout(state.sendTimeout);
      state.sendTimeout = null;
    }
    sendTextNow();
    showToast('Saved');
  });

  // Ctrl/Cmd + E  →  Export as Markdown
  hotkeysFn('ctrl+e, command+e', (e) => {
    e.preventDefault();
    exportMarkdown();
  });

  // ── Modal shortcuts ─────────────────────────────────────────────

  // Ctrl/Cmd + I  →  Toggle invite modal
  hotkeysFn('ctrl+i, command+i', (e) => {
    e.preventDefault();
    toggleInviteModal();
  });

  // Ctrl/Cmd + L  →  Set / change password
  hotkeysFn('ctrl+l, command+l', (e) => {
    e.preventDefault();
    const pad = state.pads.find((p) => p.id === state.currentPadId);
    if (pad) showPasswordModal(pad.hasPassword ? 'change' : 'set');
  });

  // Escape  →  Close all modals
  hotkeysFn('escape', (e) => {
    e.preventDefault();
    closeAllModals();
  });

  // ── File shortcuts ──────────────────────────────────────────────

  // Ctrl/Cmd + U  →  Upload file (open file picker)
  hotkeysFn('ctrl+u, command+u', (e) => {
    e.preventDefault();
    $('#file-input')?.click();
  });

  // Ctrl/Cmd + F  →  Toggle file search
  hotkeysFn('ctrl+f, command+f', (e) => {
    // Only intercept when the file section is visible (not in textarea).
    if (document.activeElement === $('#text-input')) return;
    e.preventDefault();
    toggleFileSearch();
  });

  // Ctrl/Cmd + Shift + F  →  Full-text pad search (FTS5)
  hotkeysFn('ctrl+shift+f, command+shift+f', (e) => {
    e.preventDefault();
    $('#search-btn')?.click();
  });

  // ── Pad switching: Ctrl/Cmd + 1-9 ──────────────────────────────

  for (let i = 1; i <= 9; i++) {
    hotkeysFn(`ctrl+${i}, command+${i}`, (e) => {
      e.preventDefault();
      if (i <= state.pads.length) {
        switchPad(state.pads[i - 1].id);
      }
    });
  }

  // ── Misc ────────────────────────────────────────────────────────

  // Ctrl/Cmd + ,  →  Toggle theme
  hotkeysFn('ctrl+,, command+,', (e) => {
    e.preventDefault();
    $('#theme-toggle')?.click();
  });

  // Ctrl/Cmd + K  →  Show keyboard shortcuts help
  hotkeysFn('ctrl+k, command+k', (e) => {
    e.preventDefault();
    showShortcutsHelp();
  });
}

/**
 * Display a toast listing all available shortcuts.
 */
function showShortcutsHelp() {
  const mod = navigator.platform?.includes('Mac') ? '⌘' : 'Ctrl';
  const shortcuts = [
    [`${mod}+N`, 'New pad'],
    [`${mod}+S`, 'Save (force sync)'],
    [`${mod}+E`, 'Export Markdown'],
    [`${mod}+I`, 'Invite / Redeem'],
    [`${mod}+L`, 'Set password'],
    [`${mod}+U`, 'Upload file'],
    [`${mod}+F`, 'Search files'],
    [`${mod}+1-9`, 'Switch pad'],
    [`${mod}+,`, 'Toggle theme'],
    [`${mod}+K`, 'Show shortcuts'],
    ['Esc', 'Close modals'],
  ];
  const html = shortcuts
    .map(([key, desc]) => `<b>${key}</b>  ${desc}`)
    .join('<br>');
  const toast = $('#toast');
  toast.innerHTML = html;
  toast.classList.add('shortcuts');
  toast.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    toast.classList.remove('show');
    toast.classList.remove('shortcuts');
  }, 5000);
}
