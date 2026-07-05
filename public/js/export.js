/**
 * CoMark-Notepad — Export module
 *
 * Handles Markdown file download and beforeunload flush.
 */

import { state, $, getPadToken, showToast } from './core.js';

const textarea = () => $('#text-input');

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
    if (state.sendTimeout) {
      clearTimeout(state.sendTimeout);
      state.sendTimeout = null;
      const token = getPadToken(state.currentPadId);
      const payload = JSON.stringify({ text: textarea().value, _wsId: state.wsId });
      const blob = new Blob([payload], { type: 'application/json' });
      const url = token
        ? `/api/pads/${state.currentPadId}/text?padToken=${encodeURIComponent(token)}`
        : `/api/pads/${state.currentPadId}/text`;
      navigator.sendBeacon(url, blob);
    }
  });
}
