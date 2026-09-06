// Write-access gate UI.
//
// In "gated" deployments every visitor is read-only until they hold a grant
// (a redeemed passphrase, or admin-granted trusted status). This module
// polls /api/write-access/status, toggles the editor's readOnly flag, shows
// the banner + passphrase modal, and exposes the admin member-management
// panel (X-Admin-Token is kept in sessionStorage, not localStorage, so it
// does not survive a browser restart — break-glass credentials should not
// persist silently).
import { state, $, showToast } from './core.js';
import { openModal, closeModal, withPending } from './modal-manager.js';
import {
  fetchWriteStatus,
  redeemPassphraseApi,
  releaseWriteAccessApi,
  updateProfileApi,
  fetchMe,
  fetchMembersApi,
  grantMemberWriteApi,
  revokeMemberWriteApi,
} from './server.js';

// --- State: values only — every mutation goes through a core.js setter ---
state.setAdminToken(sessionStorage.getItem('admin-token'));

const textarea = () => $('#text-input');

// Escape a value for interpolation into an innerHTML template. Only the
// handful of member-list call sites need it; lists built from fixed strings
// stay as-is.
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Write buttons that must be disabled while read-only. */
function writeButtons() {
  return [
    $('#upload-btn-wrap') || document.querySelector('.upload-btn'),
    $('#invite-btn'),
    $('#pad-lock-btn'),
    $('#file-input'),
  ].filter(Boolean);
}

export function isReadOnly() {
  return state.gated && !state.writeAccess.allowed;
}

function applyReadOnlyMode() {
  const ro = isReadOnly();
  const ta = textarea();
  if (ta) ta.readOnly = ro;
  const banner = $('#write-access-banner');
  if (banner) banner.hidden = !ro;
  for (const btn of writeButtons()) {
    if (btn.tagName === 'INPUT') btn.disabled = ro;
    else btn.toggleAttribute('disabled', ro);
  }
  // Writable-state chip (gated mode + grant held): shows remaining days and
  // the release button. Without the chip the release action is reachable
  // from no UI at all — the API exists but no element bound to it.
  const chip = $('#write-access-chip');
  if (chip) chip.hidden = !(state.gated && state.writeAccess.allowed);
  // Reflect remaining time so a writer sees expiry coming.
  const meta = $('#write-access-meta');
  if (meta) {
    const wa = state.writeAccess;
    if (state.gated && wa.allowed && !wa.permanent && wa.daysRemaining != null) {
      meta.textContent = `写权限剩余 ${wa.daysRemaining} 天`;
      meta.hidden = false;
    } else {
      meta.hidden = true;
    }
  }
}

export async function refreshWriteStatus() {
  try {
    const data = await fetchWriteStatus();
    state.setWriteAccess({ gated: !!data.gated, writeAccess: data.writeAccess });
    applyReadOnlyMode();
  } catch {
    // If the status call fails, assume open so a transient error never locks
    // a legitimate writer out of their own editor.
  }
}

// --- Passphrase modal ---

export function showPassphraseModal() {
  const m = $('#write-access-modal');
  if (!m) return;
  openModal(m);
  const input = $('#write-access-passphrase');
  const err = $('#write-access-error');
  if (err) err.hidden = true;
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 0);
  }
}

function hidePassphraseModal() {
  closeModal('write-access-modal');
}

async function submitPassphrase() {
  const input = $('#write-access-passphrase');
  const err = $('#write-access-error');
  if (!input) return;
  const phrase = input.value;
  if (!phrase) return;
  try {
    const data = await redeemPassphraseApi(phrase);
    state.setWriteAccess({ gated: state.gated, writeAccess: data.writeAccess });
    applyReadOnlyMode();
    hidePassphraseModal();
    showToast('已解锁编辑权限');
    // Re-send any edits queued while read-only.
    import('./text-sync.js').then((m) => m.flushPatchQueue?.());
  } catch (e) {
    if (err) {
      err.textContent = e.code === 'INVALID_PASSPHRASE' ? '口令错误' : e.message;
      err.hidden = false;
    }
  }
}

// --- Release ---

async function releaseAccess() {
  const { showConfirmModal } = await import('./modals.js');
  showConfirmModal(
    '放弃写权限？',
    '确定放弃当前写权限？此 Pad 将变为只读。',
    '放弃',
    async () => {
      try {
        await releaseWriteAccessApi();
        await refreshWriteStatus();
        showToast('已切换为只读');
      } catch (e) {
        showToast((e && e.message) || '释放写权限失败', 'error');
      }
    }
  );
}

// --- Profile (display name) modal ---

function showProfileModal() {
  const m = $('#profile-modal');
  if (!m) return;
  openModal(m);
  const input = $('#profile-name');
  const err = $('#profile-error');
  if (err) err.hidden = true;
  // Prefill from current /api/auth/me (state.userCode is the fallback label).
  fetchMe()
    .then((me) => {
      if (input) input.value = (me && me.displayName) || '';
    })
    .catch(() => {});
  setTimeout(() => input && input.focus(), 0);
}

function hideProfileModal() {
  closeModal('profile-modal');
}

async function submitProfile() {
  const input = $('#profile-name');
  const err = $('#profile-error');
  if (!input) return;
  const name = input.value.trim();
  try {
    await updateProfileApi(name || null);
    hideProfileModal();
    showToast('已保存昵称', 'success');
    const { refreshPresenceName } = await import('./presence.js');
    refreshPresenceName();
  } catch (e) {
    if (err) {
      err.textContent = e.message;
      err.hidden = false;
    }
  }
}

// --- Admin member panel ---

function showMembersModal() {
  const m = $('#members-modal');
  if (!m) return;
  openModal(m);
  const tokenInput = $('#members-admin-token');
  if (tokenInput) tokenInput.value = state.adminToken || '';
  renderMembersList();
  setTimeout(() => tokenInput && tokenInput.focus(), 0);
}

function hideMembersModal() {
  closeModal('members-modal');
}

async function renderMembersList() {
  const token = state.adminToken;
  const list = $('#members-list');
  if (!list) return;
  if (!token) {
    list.innerHTML = '<li class="members-empty">请先输入管理员令牌</li>';
    return;
  }
  list.innerHTML = '<li class="members-empty">加载中…</li>';
  try {
    const members = await fetchMembersApi(token);
    if (!members.length) {
      list.innerHTML = '<li class="members-empty">暂无成员</li>';
      return;
    }
    list.innerHTML = members
      .map((m) => {
        // displayName is user-controlled — never interpolate it raw into
        // HTML. The code is server-generated but escaped as well so the row
        // template stays safe by construction.
        const name = escapeHtml(m.displayName || m.code.slice(0, 8));
        const code = escapeHtml(m.code);
        const trusted = m.writeAccess && m.writeAccess.allowed && m.writeAccess.permanent;
        const temp = m.writeAccess && m.writeAccess.allowed && !m.writeAccess.permanent;
        const days = m.writeAccess && m.writeAccess.daysRemaining;
        const tag = trusted ? '<span class="member-tag trusted">永久</span>' : temp ? `<span class="member-tag temp">临时 ${days}天</span>` : '<span class="member-tag none">只读</span>';
        return `<li class="member-row" data-code="${code}">
          <span class="member-name">${name}</span>
          ${tag}
          <button class="member-action" data-action="${trusted ? 'revoke' : 'trust'}">${trusted ? '撤销' : '授予永久'}</button>
        </li>`;
      })
      .join('');
  } catch (e) {
    list.innerHTML = `<li class="members-empty">${escapeHtml(String(e.message || e))}</li>`;
  }
}

async function saveAdminToken() {
  const input = $('#members-admin-token');
  if (!input) return;
  const token = input.value.trim();
  state.setAdminToken(token);
  if (token) sessionStorage.setItem('admin-token', token);
  else sessionStorage.removeItem('admin-token');
  await renderMembersList();
}

async function onMemberAction(e) {
  const btn = e.target.closest('.member-action');
  if (!btn) return;
  const row = btn.closest('.member-row');
  if (!row) return;
  const code = row.dataset.code;
  const action = btn.dataset.action;
  const token = state.adminToken;
  if (!token) {
    showToast('请先输入管理员令牌');
    return;
  }
  try {
    await withPending(btn, async () => {
      if (action === 'trust') {
        await grantMemberWriteApi(code, token);
        showToast('已授予永久写权限', 'success');
      } else {
        await revokeMemberWriteApi(code, token);
        showToast('已撤销写权限');
      }
      await renderMembersList();
    });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

// Called from ws.js when the server signals write access was lost mid-session.
export function handleWriteDenied() {
  refreshWriteStatus().then(() => {
    applyReadOnlyMode();
    showPassphraseModal();
  });
}

// --- Boot ---

export function initWriteAccess() {
  const openBtn = $('#write-access-open-btn');
  if (openBtn) openBtn.addEventListener('click', showPassphraseModal);

  const submitBtn = $('#write-access-submit');
  if (submitBtn) submitBtn.addEventListener('click', (e) => withPending(e.currentTarget, submitPassphrase));
  const phraseInput = $('#write-access-passphrase');
  if (phraseInput) {
    phraseInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitPassphrase();
      }
    });
  }
  const cancelBtn = $('#write-access-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', hidePassphraseModal);

  const releaseBtn = $('#write-access-release');
  if (releaseBtn) releaseBtn.addEventListener('click', releaseAccess);

  const profileBtn = $('#profile-btn');
  if (profileBtn) profileBtn.addEventListener('click', showProfileModal);
  const profileSubmit = $('#profile-submit');
  if (profileSubmit) profileSubmit.addEventListener('click', (e) => withPending(e.currentTarget, submitProfile));
  const profileCancel = $('#profile-cancel');
  if (profileCancel) profileCancel.addEventListener('click', hideProfileModal);

  const membersBtn = $('#members-btn');
  if (membersBtn) membersBtn.addEventListener('click', showMembersModal);
  const membersClose = $('#members-close');
  if (membersClose) membersClose.addEventListener('click', hideMembersModal);
  const membersSaveToken = $('#members-save-token');
  if (membersSaveToken) membersSaveToken.addEventListener('click', (e) => withPending(e.currentTarget, saveAdminToken));
  const membersList = $('#members-list');
  if (membersList) membersList.addEventListener('click', onMemberAction);

  refreshWriteStatus();
  // Lightweight poll: re-check after reconnects and every 5 minutes so an
  // expired grant flips the editor to read-only without a manual reload.
  setInterval(refreshWriteStatus, 5 * 60 * 1000);
}
