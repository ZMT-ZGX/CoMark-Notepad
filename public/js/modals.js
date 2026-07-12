import { state, $, showToast, getPadToken, setPadToken } from './core.js';
import { setPadPassword, unlockPadApi } from './server.js';
import { refreshPads, loadPadContent, updateLockButton, renderPadTabs } from './pads.js';
import { connectWS } from './ws.js';

// --- Password Modal ---

let passwordMode = 'set';

export function showPasswordModal(mode) {
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

export function initPasswordModal() {
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

    try {
      const data = await setPadPassword(state.currentPadId, password || null, currentPassword);
      if (data.token) setPadToken(state.currentPadId, data.token);
      else setPadToken(state.currentPadId, null);

      hidePasswordModal();
      await refreshPads();
      showToast(password ? 'Password set' : 'Password removed');
    } catch (e) {
      error.textContent = e.message;
      error.hidden = false;
    }
  });
}

// --- Unlock Modal ---

let unlockTargetPadId = null;

export function showUnlockModal(padId) {
  if (!$('#unlock-modal').hidden) return;
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

export function initUnlockModal() {
  $('#unlock-cancel').addEventListener('click', hideUnlockModal);

  $('#unlock-confirm-btn').addEventListener('click', async () => {
    if (!unlockTargetPadId) return;
    const password = $('#unlock-input').value;
    const error = $('#unlock-error');
    error.hidden = true;

    try {
      const data = await unlockPadApi(unlockTargetPadId, password);
      if (data.token) setPadToken(unlockTargetPadId, data.token);
      hideUnlockModal();
      state.currentPadId = unlockTargetPadId;
      // Re-fetch state with the new unlock token so gated file metadata for
      // this pad becomes visible without a full page reload.
      await refreshPads();
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
}

// --- Confirm Modal ---

export function showConfirmModal(title, desc, okText, onConfirm) {
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
