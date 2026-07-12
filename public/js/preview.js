/**
 * CoMark-Notepad — Markdown Preview module
 *
 * Handles loading and rendering file content with DOMPurify sanitization,
 * plus a floating TOC (h1–h3) that scrolls the preview body smoothly.
 */

import { state, $, padAuthHeaders, escapeHtml } from './core.js';

export async function openMarkdownPreview(file) {
  const modal = $('#preview-modal');
  const titleEl = $('#preview-title');
  const bodyEl = $('#preview-body');
  const tocEl = document.getElementById('preview-toc');
  state.previewTargetId = file.id;
  titleEl.textContent = file.originalName;
  bodyEl.className = 'preview-body is-loading';
  bodyEl.textContent = 'Loading...';
  if (tocEl) tocEl.innerHTML = '';
  modal.hidden = false;

  try {
    // Header only — never put padToken in the URL (access / proxy logs).
    const res = await fetch(`/api/files/${file.id}`, {
      headers: padAuthHeaders(file.padId || state.currentPadId),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    const markdown = await res.text();
    if (state.previewTargetId !== file.id) return;
    let html;
    if (typeof marked === 'undefined' || typeof DOMPurify === 'undefined') {
      html = `<pre>${escapeHtml(markdown)}</pre>`;
    } else {
      html = DOMPurify.sanitize(marked.parse(markdown, { async: false }));
    }
    bodyEl.className = 'preview-body';
    bodyEl.innerHTML = html;

    // Build TOC from rendered headings
    buildToc(bodyEl, tocEl);
  } catch (e) {
    if (state.previewTargetId !== file.id) return;
    bodyEl.className = 'preview-body is-error';
    bodyEl.textContent = e.message || 'Failed to load preview';
  }
}

function buildToc(bodyEl, tocEl) {
  if (!tocEl) return;
  const headings = bodyEl.querySelectorAll('h1, h2, h3');
  if (headings.length < 2) {
    tocEl.hidden = true;
    return;
  }
  tocEl.hidden = false;
  const frag = document.createDocumentFragment();
  headings.forEach((h, i) => {
    const id = `toc-heading-${i}`;
    h.id = id;
    const level = Number(h.tagName[1]); // 1, 2, or 3
    const item = document.createElement('div');
    item.className = `toc-item toc-level-${level}`;
    item.textContent = h.textContent || '';
    item.addEventListener('click', (e) => {
      e.preventDefault();
      h.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    frag.appendChild(item);
  });
  tocEl.innerHTML = '';
  tocEl.appendChild(frag);
}

export function closeMarkdownPreview() {
  const modal = $('#preview-modal');
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  $('#preview-body').innerHTML = '';
  const tocEl = document.getElementById('preview-toc');
  if (tocEl) tocEl.innerHTML = '';
}
