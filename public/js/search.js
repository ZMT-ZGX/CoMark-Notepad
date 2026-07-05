/**
 * CoMark-Notepad — Full-text search UI
 *
 * Toggleable search bar in the header. Queries /api/search which uses
 * SQLite FTS5 underneath. Results clickable to switch pads.
 */

import { state, $, showToast, escapeHtml } from './core.js';
import { switchPad } from './pads.js';

const SEARCH_DEBOUNCE_MS = 300;

let debounceTimer = null;

export function initSearch() {
  const btn = $('#search-btn');
  const bar = $('#search-bar');
  const input = $('#search-input');
  const closeBtn = $('#search-close');

  if (!btn || !bar || !input) return;

  btn.addEventListener('click', () => {
    bar.hidden = false;
    input.focus();
  });

  closeBtn.addEventListener('click', closeSearch);

  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const q = input.value.trim();
    if (!q) {
      $('#search-results').innerHTML = '';
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), SEARCH_DEBOUNCE_MS);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      if (bar.hidden) {
        bar.hidden = false;
        input.focus();
      } else {
        closeSearch();
      }
    }
  });
}

function closeSearch() {
  const bar = $('#search-bar');
  if (!bar) return;
  bar.hidden = true;
  $('#search-input').value = '';
  $('#search-results').innerHTML = '';
}

async function runSearch(q) {
  const resultsEl = $('#search-results');
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderResults(data.results || []);
  } catch (e) {
    resultsEl.innerHTML = '<div class="search-empty">Search failed</div>';
  }
}

function renderResults(results) {
  const el = $('#search-results');
  if (results.length === 0) {
    el.innerHTML = '<div class="search-empty">No matches</div>';
    return;
  }
  el.innerHTML = results
    .map(
      (r) => `
    <div class="search-result" data-pad-id="${r.id}">
      <div class="search-result-id">Pad #${r.id}</div>
      <div class="search-result-snippet">${escapeHtml(r.snippet || r.content || '').slice(0, 120)}</div>
    </div>`
    )
    .join('');

  el.querySelectorAll('.search-result').forEach((node) => {
    node.addEventListener('click', () => {
      const padId = Number(node.dataset.padId);
      if (padId) {
        switchPad(padId);
        closeSearch();
      }
    });
  });
}

