import {
  state, $, showToast, escapeHtml, getPadToken, padAuthHeaders, upsertLocalFile, removeLocalFile,
  formatSize, timeAgo, fileIcon, isConvertible, canConvert, MAX_FILE_SIZE,
} from './core.js';
import { deleteFileApi, convertFileApi, uploadWithProgress } from './server.js';
import { refreshPads } from './pads.js';

// --- Text Stats ---

const textarea = () => $('#text-input');

export function updateTextStats() {
  const stats = $('#text-stats');
  if (!stats) return;
  const text = textarea().value;
  const chars = text.length;
  const lines = text ? text.split('\n').length : 1;
  stats.textContent = `${chars} char${chars !== 1 ? 's' : ''} · ${lines} line${lines !== 1 ? 's' : ''}`;
}

// --- File Element Creation ---

function createFileElement(file) {
  const el = document.createElement('div');
  el.className = 'file-item';
  el.dataset.id = file.id;
  el.dataset.createdAt = String(file.createdAt || Date.now());

  const sizeLabel = formatSize(file.size);
  const showConvert = isConvertible(file.originalName) && file.size <= state.convertCapabilities.maxBytes;
  const isMd = (file.originalName || '').toLowerCase().endsWith('.md');
  el.innerHTML = `
    <div class="file-icon">${fileIcon(file.originalName)}</div>
    <div class="file-info">
      <div class="file-name${isMd ? ' is-previewable' : ''}" title="${isMd ? 'Click to preview' : ''}">${escapeHtml(file.originalName)}</div>
      <div class="file-meta" data-size="${escapeHtml(sizeLabel)}">${sizeLabel} · ${timeAgo(file.createdAt)}</div>
    </div>
    <div class="file-actions">
      ${showConvert ? `<button class="file-action convert" title="Convert to Markdown">
        <svg class="icon-doc" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <svg class="icon-spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
        <svg class="icon-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
      </button>` : ''}
      <button class="file-action download" title="Download">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </button>
      <button class="file-action delete" title="Delete">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
      </button>
    </div>
  `;

  el.querySelector('.download').addEventListener('click', async () => {
    // Fetch with header so the unlock token never appears in the URL / logs.
    try {
      const res = await fetch(`/api/files/${file.id}`, {
        headers: padAuthHeaders(file.padId || state.currentPadId),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.originalName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      showToast(e.message || 'Download failed');
    }
  });

  const previewName = el.querySelector('.file-name.is-previewable');
  if (previewName) {
    previewName.addEventListener('click', async () => {
      const { openMarkdownPreview } = await import('./ws.js');
      openMarkdownPreview(file);
    });
  }

  const convertBtn = el.querySelector('.convert');
  if (convertBtn) {
    convertBtn.addEventListener('click', async () => {
      convertBtn.disabled = true;
      convertBtn.title = 'Converting...';
      convertBtn.classList.add('loading');
      try {
        const data = await convertFileApi(file.id, file.padId);
        removeLocalFile(file.id);
        upsertLocalFile(data);
        removeFileFromList(file.id);
        addFileToList(data, true);
        updateFilesEmpty();
        showToast(`Converted: ${data.originalName}`);
        convertBtn.classList.remove('loading');
        convertBtn.classList.add('success');
        convertBtn.title = 'Already converted';
      } catch (e) {
        showToast(e.message);
        convertBtn.classList.remove('loading');
        convertBtn.disabled = false;
        convertBtn.title = 'Convert to Markdown';
      }
    });
  }

  el.querySelector('.delete').addEventListener('click', async () => {
    try {
      await deleteFileApi(file.id, file.padId);
      removeLocalFile(file.id);
      removeFileFromList(file.id);
    } catch (e) {
      showToast(e.message);
    }
  });

  return el;
}

// --- File List Management ---

export function addFileToList(file, prepend = false) {
  const list = $('#files-list');
  const existing = list.querySelector(`[data-id="${CSS.escape(file.id)}"]`);
  if (existing) {
    if (existing.style.opacity === '0') existing.remove();
    else return;
  }
  const el = createFileElement(file);
  if (prepend) list.prepend(el);
  else list.appendChild(el);
}

export function removeFileFromList(fileId) {
  const el = $(`#files-list [data-id="${CSS.escape(fileId)}"]`);
  if (el) {
    el.style.transition = 'opacity 0.2s, transform 0.2s';
    el.style.opacity = '0';
    el.style.transform = 'translateX(-20px)';
    setTimeout(() => {
      el.remove();
      updateFilesEmpty();
    }, 200);
    return;
  }
  updateFilesEmpty();
}

export function renderFilesList(files) {
  const list = $('#files-list');
  list.innerHTML = '';
  files.forEach((file) => addFileToList(file));
  updateFilesEmpty();
}

export function updateFilesEmpty() {
  const empty = $('#files-empty');
  const list = $('#files-list');
  empty.hidden = list.children.length > 0;
  const searchBar = $('#file-search-bar');
  const totalFiles = list.children.length;
  searchBar.hidden = totalFiles < 4;
}

// --- File Search ---

export function initFileSearch() {
  $('#file-search').addEventListener('input', (e) => {
    const query = e.target.value.toLowerCase().trim();
    document.querySelectorAll('#files-list .file-item').forEach((el) => {
      const name = (el.querySelector('.file-name')?.textContent || '').toLowerCase();
      el.style.display = (!query || name.includes(query)) ? '' : 'none';
    });
  });
}

// --- Time Label Updater ---

let timeLabelInterval = null;

export function startTimeLabelUpdater() {
  if (timeLabelInterval) return;
  const tick = () => {
    document.querySelectorAll('.file-item').forEach((el) => {
      const meta = el.querySelector('.file-meta');
      if (!meta) return;
      const createdAt = Number(el.dataset.createdAt);
      const size = meta.dataset.size || '';
      meta.textContent = `${size} · ${timeAgo(createdAt)}`;
    });
  };
  tick();
  timeLabelInterval = setInterval(tick, 60000);
}

export function stopTimeLabelUpdater() {
  clearInterval(timeLabelInterval);
  timeLabelInterval = null;
}

// --- File Upload ---

/**
 * Collect files from a ClipboardData object.
 * Handles two cases:
 *   1. Real files copied from OS file manager  → clipboardData.files
 *   2. Screenshot / image data from clipboard  → clipboardData.items (image/* blobs)
 * Returns an array of File objects ready for upload.
 */
function collectClipboardFiles(clipboardData) {
  if (!clipboardData) return [];

  // Case 1: actual files (e.g. copied from Finder / Explorer)
  const realFiles = Array.from(clipboardData.files).filter((f) => f.size > 0);
  if (realFiles.length > 0) return realFiles;

  // Case 2: image blob from screenshot or "Copy Image"
  const imageFiles = [];
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  let imgIdx = 0;
  for (const item of Array.from(clipboardData.items)) {
    if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
    const blob = item.getAsFile();
    if (!blob || blob.size === 0) continue;
    const ext = item.type.split('/')[1]?.replace('jpeg', 'jpg') || 'png';
    const suffix = imageFiles.length > 0 ? `-${++imgIdx}` : '';
    const name = `pasted-${ts}${suffix}.${ext}`;
    imageFiles.push(new File([blob], name, { type: item.type }));
  }
  return imageFiles;
}

export function initFileUpload() {
  const fileInput = $('#file-input');
  const dropOverlay = $('#drop-overlay');
  let dragCounter = 0;

  function hasDraggedFiles(e) {
    const types = e.dataTransfer?.types;
    if (!types) return false;
    if (typeof types.includes === 'function') return types.includes('Files');
    if (typeof types.contains === 'function') return types.contains('Files');
    return Array.from(types).includes('Files');
  }

  fileInput.addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    if (files.length > 0) showUploadConfirm(files);
    e.target.value = '';
  });

  document.addEventListener('dragenter', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragCounter++;
    dropOverlay.classList.add('visible');
  });

  document.addEventListener('dragleave', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      dragCounter = 0;
      dropOverlay.classList.remove('visible');
    }
  });

  document.addEventListener('dragover', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
  });

  document.addEventListener('drop', (e) => {
    if (!hasDraggedFiles(e)) return;
    e.preventDefault();
    dragCounter = 0;
    dropOverlay.classList.remove('visible');
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) showUploadConfirm(files);
  });

  // Paste-to-upload: press Ctrl+V / Cmd+V anywhere on the page to upload a file
  // copied from the OS file manager. We key off the clipboard *content* (does it
  // hold files?) rather than mouse position — the common flow is Cmd+Tab back to
  // the browser then paste, where no pointerenter fires, so a hover requirement
  // silently breaks it. clipboardData.files is empty when only text is on the
  // clipboard, so this never disturbs pasting text into the notepad.
  //
  // One exception: when the caret is in the notepad textarea AND the clipboard
  // holds an image, text-sync.js (handleImagePaste) embeds it inline as a
  // Markdown data-URL. We defer to that path so an image isn't both embedded and
  // uploaded. Non-image files (PDF, docx, …) always upload.
  document.addEventListener('paste', (e) => {
    const files = collectClipboardFiles(e.clipboardData);
    if (files.length === 0) return;

    const inTextarea = document.activeElement?.id === 'text-input';
    const allImages = files.every((f) => f.type.startsWith('image/'));
    if (inTextarea && allImages) return; // handled by text-sync inline-image paste

    e.preventDefault();
    showUploadConfirm(files);
  });
}

// --- Upload Confirm Modal ---

function showUploadConfirm(files) {
  const modal = $('#upload-confirm-modal');
  const list = $('#upload-confirm-list');
  list.innerHTML = '';

  for (const file of files) {
    const isLarge = file.size > MAX_FILE_SIZE;
    const canCv = isConvertible(file.name) && file.size <= state.convertCapabilities.maxBytes;
    const item = document.createElement('div');
    item.className = 'upload-confirm-item';
    if (isLarge) item.style.opacity = '0.5';
    item.innerHTML = `
      <div class="file-icon">${fileIcon(file.name)}</div>
      <span class="upload-confirm-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
      ${canCv && !isLarge ? `<span class="upload-confirm-badge">→ Markdown</span>` : ''}
      ${isLarge ? '<span class="upload-confirm-badge warn">Too large</span>' : ''}
    `;
    list.appendChild(item);
  }

  modal.hidden = false;

  $('#upload-confirm-cancel').onclick = () => {
    modal.hidden = true;
    const queue = files.map((file) => ({ file, shouldConvert: false }));
    processUploadQueue(queue);
  };

  $('#upload-confirm-ok').onclick = () => {
    modal.hidden = true;
    const queue = files.map((file) => ({
      file,
      shouldConvert: isConvertible(file.name) && file.size <= state.convertCapabilities.maxBytes,
    }));
    processUploadQueue(queue);
  };
}

async function processUploadQueue(queue) {
  const CONCURRENCY = 3;
  const progress = $('#upload-progress');
  const progressFill = progress.querySelector('.progress-fill');
  const progressText = progress.querySelector('.progress-text');
  progress.hidden = false;
  progressFill.style.width = '0%';
  progressText.textContent = `Uploading 0/${queue.length}...`;

  let completed = 0;
  let idx = 0;
  async function worker() {
    while (idx < queue.length) {
      const i = idx++;
      const { file, shouldConvert } = queue[i];
      await uploadFile(file, shouldConvert, (filePercent) => {
        const overall = Math.round(((completed + filePercent / 100) / queue.length) * 100);
        progressFill.style.width = `${overall}%`;
        progressText.textContent = `Uploading ${completed}/${queue.length}...`;
      });
      completed++;
      progressFill.style.width = `${Math.round((completed / queue.length) * 100)}%`;
      progressText.textContent = completed < queue.length
        ? `Uploading ${completed}/${queue.length}...`
        : `Uploaded ${queue.length} file${queue.length !== 1 ? 's' : ''}`;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () => worker()));
  setTimeout(() => { progress.hidden = true; }, 500);
}

async function uploadFile(file, shouldConvert = false, onProgress) {
  if (file.size > MAX_FILE_SIZE) {
    showToast(`Skipped: ${file.name} (too large)`);
    return;
  }

  const padId = state.currentPadId;
  const padToken = getPadToken(padId);

  const formData = new FormData();
  formData.append('file', file, file.name);
  if (state.wsId) formData.append('_wsId', state.wsId);
  formData.append('padId', String(padId));

  try {
    const uploadedFile = await uploadWithProgress(formData, padToken, onProgress || (() => {}));
    upsertLocalFile(uploadedFile);
    addFileToList(uploadedFile, true);
    updateFilesEmpty();
    showToast(`Uploaded: ${file.name}`);

    if (shouldConvert && isConvertible(uploadedFile.originalName) && uploadedFile.size <= state.convertCapabilities.maxBytes) {
      const convertBtn = document.querySelector(`#files-list [data-id="${uploadedFile.id}"] .convert`);
      if (convertBtn) {
        convertBtn.disabled = true;
        convertBtn.title = 'Converting...';
        convertBtn.classList.add('loading');
      }
      try {
        const data = await convertFileApi(uploadedFile.id, padId);
        removeLocalFile(uploadedFile.id);
        upsertLocalFile(data);
        removeFileFromList(uploadedFile.id);
        addFileToList(data, true);
        updateFilesEmpty();
        showToast(`Converted: ${data.originalName}`);
        if (convertBtn) {
          convertBtn.classList.remove('loading');
          convertBtn.classList.add('success');
          convertBtn.title = 'Already converted';
        }
      } catch (e) {
        showToast(`Convert failed: ${e.message}`);
        if (convertBtn) {
          convertBtn.classList.remove('loading');
          convertBtn.disabled = false;
          convertBtn.title = 'Convert to Markdown';
        }
      }
    }
  } catch (e) {
    showToast(e.message);
  }
}

