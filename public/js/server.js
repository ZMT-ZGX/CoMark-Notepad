import { state, getPadToken, safeJsonParse, MAX_FILE_SIZE } from './core.js';

// --- Pad API ---

export async function fetchState() {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error('Failed to load state');
  return res.json();
}

export async function fetchPadContent(padId) {
  const token = getPadToken(padId);
  const headers = {};
  if (token) headers['X-Pad-Token'] = token;
  return fetch(`/api/pads/${padId}`, { headers });
}

export async function updatePadText(padId, text, wsId) {
  const token = getPadToken(padId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;
  const res = await fetch(`/api/pads/${padId}/text`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ text, _wsId: wsId }),
  });
  if (!res.ok) throw new Error('Failed to sync text');
  return res.json();
}

export async function createPadApi() {
  const res = await fetch('/api/pads', { method: 'POST' });
  if (!res.ok) throw new Error('Failed to create pad');
  return res.json();
}

export async function deletePadApi(padId) {
  const token = getPadToken(padId);
  const headers = {};
  if (token) headers['X-Pad-Token'] = token;
  const res = await fetch(`/api/pads/${padId}`, { method: 'DELETE', headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Delete failed');
  }
}

export async function setPadPassword(padId, password, currentPassword) {
  const token = getPadToken(padId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;
  const body = { password: password || null };
  if (currentPassword) body.currentPassword = currentPassword;
  const res = await fetch(`/api/pads/${padId}/password`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Failed to set password');
  }
  return res.json();
}

export async function unlockPadApi(padId, password) {
  const res = await fetch(`/api/pads/${padId}/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Wrong password');
  }
  return res.json();
}

// --- File API ---

export async function deleteFileApi(fileId, padId) {
  const token = getPadToken(padId || state.currentPadId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;
  const res = await fetch(`/api/files/${fileId}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ _wsId: state.wsId }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || 'Delete failed');
  }
}

export async function convertFileApi(fileId, padId) {
  const token = getPadToken(padId || state.currentPadId);
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Pad-Token'] = token;
  const res = await fetch(`/api/convert/${fileId}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ _wsId: state.wsId }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Conversion failed');
  return data;
}

// --- Auth API ---

export async function fetchMe() {
  const res = await fetch('/api/auth/me');
  if (!res.ok) return null;
  return res.json();
}

export async function registerUser() {
  const res = await fetch('/api/auth/register', { method: 'POST' });
  if (!res.ok) return null;
  return res.json();
}

// --- Invitation API ---

export async function createInvitation() {
  const res = await fetch('/api/invitations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ maxUses: 5 }),
  });
  if (!res.ok) throw new Error('Failed to create invitation');
  return res.json();
}

export async function redeemInvitation(token) {
  const res = await fetch('/api/invitations/redeem', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!res.ok) {
    const data = await res.json();
    throw new Error(data.error || 'Redeem failed');
  }
  return res.json();
}

// --- Convert Capabilities ---

export async function loadConvertCapabilities() {
  try {
    const res = await fetch('/api/convert/capabilities');
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

// --- Upload with Progress ---

export function uploadWithProgress(formData, padToken, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.responseType = 'json';
    xhr.timeout = 300000; // 5 minutes
    if (padToken) xhr.setRequestHeader('X-Pad-Token', padToken);

    xhr.upload.addEventListener('progress', (e) => {
      if (!e.lengthComputable) return;
      onProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      const data = xhr.response && typeof xhr.response === 'object'
        ? xhr.response
        : safeJsonParse(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(data);
        return;
      }
      reject(new Error(data?.error || 'Upload failed'));
    });

    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload canceled')));
    xhr.addEventListener('timeout', () => reject(new Error('Upload timed out')));
    xhr.send(formData);
  });
}
