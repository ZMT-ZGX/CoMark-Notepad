import { state, $, showToast } from './core.js';
import { createInvitation, redeemInvitation } from './server.js';
import { refreshPads } from './pads.js';

async function generateInvitation() {
  try {
    const data = await createInvitation();
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
  if (!navigator.clipboard) {
    showToast('Copy not available in this browser context');
    return;
  }
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
    const data = await redeemInvitation(token);
    hideInviteModal();
    showToast(`Access granted from ${data.grantorCode}`);
    await refreshPads();
  } catch (e) {
    error.textContent = e.message;
    error.hidden = false;
  }
}

export function toggleInviteModal() {
  const modal = $('#invite-modal');
  modal.hidden = !modal.hidden;
  $('#redeem-error').hidden = true;
}

export function initInvitation() {
  $('#invite-btn').addEventListener('click', toggleInviteModal);
  $('#generate-invite-btn').addEventListener('click', generateInvitation);
  $('#copy-invite-btn').addEventListener('click', copyInviteToken);
  $('#close-invite-btn').addEventListener('click', hideInviteModal);
  $('#redeem-invite-btn').addEventListener('click', redeemInvite);
}
