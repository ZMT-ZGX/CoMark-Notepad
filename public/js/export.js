/**
 * CoMark-Notepad — Export module
 *
 * Handles Markdown file download and beforeunload flush.
 */

import { state, $, getPadToken, padAuthHeaders, showToast } from './core.js';

const textarea = () => $('#text-input');

// Chrome caps both sendBeacon and fetch(keepalive) bodies around 64KB.
// Leave headroom under that; larger pads already sync via WS / offline queue.
const UNLOAD_BODY_MAX = 60_000;

export function initExport() {
  $('#export-btn').addEventListener('click', () => {
    const text = textarea().value;
    if (!text.trim()) { showToast('Nothing to export'); return; }
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `pad-${state.currentPadId}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Exported!');
  });
}

export function initBeforeUnload() {
  window.addEventListener('beforeunload', () => {
    if (!state.sendTimeout) return;
    clearTimeout(state.sendTimeout);
    state.sendTimeout = null;

    // Narrow window only: debounce still pending when the tab closes.
    // Main sync is WS; this is a best-effort tail flush.
    const padId = state.currentPadId;
    const payload = JSON.stringify({ text: textarea().value, _wsId: state.wsId });
    const bodyBlob = new Blob([payload], { type: 'application/json' });
    if (bodyBlob.size > UNLOAD_BODY_MAX) return;

    const token = getPadToken(padId);
    try {
      if (token) {
        // Locked pad: must send X-Pad-Token. sendBeacon cannot set headers,
        // and ?padToken= would land in access / proxy logs — use keepalive fetch.
        fetch(`/api/pads/${padId}/text`, {
          method: 'POST',
          headers: padAuthHeaders(padId, { 'Content-Type': 'application/json' }),
          body: payload,
          keepalive: true,
        });
      } else {
        // Unlocked pad: no auth header needed; sendBeacon is fine.
        navigator.sendBeacon(`/api/pads/${padId}/text`, bodyBlob);
      }
    } catch {
      /* page is unloading — best effort */
    }
  });
}
