/**
 * CoMark-Notepad — Text Sync module
 *
 * Patch-based sync over WebSocket. Falls back to HTTP on WS unavailable.
 *
 * Sync model is per-pad and serialized: each pad has exactly ONE confirmed
 * shadow (`lastSyncedText`), at most ONE in-flight operation (a WS patch or an
 * HTTP write), and a `pendingTarget` text we intend to reach. Sending a second
 * patch before the first is acknowledged is forbidden — newer edits are folded
 * into `pendingTarget` and re-diffed once the in-flight op is confirmed. This
 * prevents duplicate/garbled bodies from parallel un-ACKed patches (P1 #1) and
 * keeps each pad's reliable-delivery state isolated (P1 #3).
 */

import { state, $, showToast, getPadSync } from './core.js';
import { updateTextStats } from './files.js';
import { updatePadText } from './server.js';
import { loadPadContent } from './pads.js';

const textarea = () => $('#text-input');

// Keep the operation namespace stable across reconnects in this browser
// session. sessionStorage is deliberately used instead of localStorage so
// separate tabs/clients created from the same auth state cannot share IDs.
let clientInstanceId = null;
try {
  clientInstanceId = sessionStorage.getItem('comark-sync-client-id');
  if (!clientInstanceId) {
    clientInstanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem('comark-sync-client-id', clientInstanceId);
  }
} catch {
  clientInstanceId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

// Monotonic sequence for WS patches (used to match ACKs).
let patchSeq = 0;

// Reuse a single diff-match-patch instance instead of constructing one per
// send/receive. Returns null when the vendored library is unavailable so
// callers can bail out safely.
let dmpInstance = null;
function getDmp() {
  if (typeof window.diff_match_patch !== 'function') return null;
  if (!dmpInstance) dmpInstance = new window.diff_match_patch();
  return dmpInstance;
}

// Rebase the latest local target onto an authoritative snapshot. For a
// WebSocket operation, use the text captured before that operation as the
// patch base so a remote edit arriving before our ACK cannot erase it.
function mergePendingTarget(authoritativeText, sync) {
  const inflight = sync.inflight;
  const target = sync.pendingTarget ?? (inflight?.kind === 'ws' ? inflight.sentText : null);
  const base = inflight?.kind === 'ws' ? inflight.baseText : sync.lastSyncedText;
  if (target == null || target === base) return authoritativeText;
  const dmp = getDmp();
  if (!dmp) return target;
  const localPatches = dmp.patch_make(base, target);
  const [merged, results] = dmp.patch_apply(localPatches, authoritativeText);
  return results.every(Boolean) ? merged : target;
}

function rememberOperation(sync, operationId) {
  if (!operationId) return;
  sync.seenOperations.add(operationId);
  while (sync.seenOperations.size > 10000) {
    const oldest = sync.seenOperations.values().next().value;
    if (!oldest) break;
    sync.seenOperations.delete(oldest);
  }
}

// --- Caret preservation & IME safety ---

// True while an IME composition (Chinese / Japanese / Korean input) is in
// progress. Assigning `textarea.value` mid-composition aborts the composition
// and throws away the word being typed, so remote bodies are parked and
// rebased onto the editor at `compositionend` instead. Sends are suspended for
// the same window: a patch built mid-composition carries a base version the
// server has already moved past, and the nack's HTTP retry would then overwrite
// the very remote edit we were trying to merge.
let composing = false;

// Adopt whatever server body was parked during the composition, rebase the
// committed local text onto it, and resume sending.
function endComposition() {
  if (!composing) return;
  composing = false;
  const padId = state.currentPadId;
  // The committing `input` event has already fired (the listener below defers
  // this call by a tick for exactly that reason), so the textarea holds the
  // final local text and it is safe to make it the pending target.
  getPadSync(padId).pendingTarget = textarea().value;
  applyPendingRemoteText(padId);
  sendText();
}

// Map a caret offset in `oldText` onto the equivalent offset in `newText` by
// walking the diff: text deleted before the caret pulls it back, text inserted
// before it pushes it forward. This is required because assigning
// `textarea.value` resets the caret to the end of the document — without it
// every remote keystroke would yank the local cursor away.
function mapCaret(oldText, newText, caret) {
  if (oldText === newText) return Math.min(caret, newText.length);
  const dmp = getDmp();
  if (!dmp) return Math.min(caret, newText.length);
  // Trim the shared prefix/suffix first. The overwhelmingly common case is a
  // remote edit far away from the caret, which then resolves arithmetically
  // without paying for a full diff of the whole document.
  let start = 0;
  const maxStart = Math.min(oldText.length, newText.length);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) start++;
  let endOld = oldText.length;
  let endNew = newText.length;
  while (
    endOld > start &&
    endNew > start &&
    oldText.charCodeAt(endOld - 1) === newText.charCodeAt(endNew - 1)
  ) {
    endOld--;
    endNew--;
  }
  if (caret <= start) return caret; // the edit is entirely after the caret
  if (caret >= endOld) return newText.length - (oldText.length - caret); // entirely before it
  let oldPos = start;
  let newPos = start;
  const diffs = dmp.diff_main(oldText.slice(start, endOld), newText.slice(start, endNew));
  for (const [op, text] of diffs) {
    const len = text.length;
    if (op === 0) {
      if (oldPos + len >= caret) return Math.min(newPos + (caret - oldPos), newText.length);
      oldPos += len;
      newPos += len;
    } else if (op === -1) {
      if (oldPos + len >= caret) return Math.min(newPos, newText.length);
      oldPos += len;
    } else {
      newPos += len;
    }
  }
  return Math.min(newPos, newText.length);
}

// Replace the editor contents while keeping the selection anchored to the same
// logical place in the document.
function setEditorText(ta, nextText) {
  if (ta.value === nextText) return;
  const start = mapCaret(ta.value, nextText, ta.selectionStart);
  const end = mapCaret(ta.value, nextText, ta.selectionEnd);
  ta.value = nextText;
  try {
    ta.setSelectionRange(start, end);
  } catch {
    /* selection is unavailable for this element type */
  }
}

// --- Reliable delivery primitives (per-pad) ---

// Send one WS patch and mark it as the single in-flight op for this pad.
function sendPatchOverWs(patchText, sentText, padId, sync, operationId = null) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.padId !== padId) return false;
  const seq = ++patchSeq;
  const opId = operationId || `${clientInstanceId}:${padId}:${seq}`;
  try {
    ws.send(JSON.stringify({
      type: 'patch',
      padId,
      data: patchText,
      seq,
      operationId: opId,
      baseVersion: sync.textVersion,
    }));
    sync.inflight = {
      kind: 'ws',
      seq,
      operationId: opId,
      patchText,
      sentText,
      baseText: sync.lastSyncedText,
      baseVersion: sync.textVersion,
    };
    return true;
  } catch {
    return false;
  }
}

// Server confirmed the in-flight WS patch: advance the confirmed shadow, clear
// in-flight, and pump the pipeline for any newer local edits (P1 #1).
export function ackInflight(seq, padId = state.currentPadId, authoritativeText = null, authoritativeVersion = null) {
  const sync = getPadSync(padId);
  if (!sync.inflight || sync.inflight.kind !== 'ws' || sync.inflight.seq !== seq) return;
  const inflight = sync.inflight;
  const sentText = inflight.sentText;
  const ackVersion = typeof authoritativeVersion === 'number' ? authoritativeVersion : null;
  const isStaleAck = ackVersion !== null && ackVersion < sync.textVersion;
  inflight.authoritativeText = typeof authoritativeText === 'string' ? authoritativeText : null;
  if (!isStaleAck) {
    sync.lastSyncedText = inflight.authoritativeText ?? inflight.sentText;
    if (ackVersion !== null) sync.textVersion = Math.max(sync.textVersion, ackVersion);
  }
  sync.inflight = null;
  if (typeof authoritativeText === 'string' && padId === state.currentPadId) {
    const target = sync.pendingTarget;
    const ta = textarea();
    let nextValue;
    if (isStaleAck) {
      nextValue = mergePendingTarget(sync.lastSyncedText, sync);
    } else if (target == null || target === sentText) {
      nextValue = authoritativeText;
    } else {
      const dmp = getDmp();
      if (dmp) {
        const localPatches = dmp.patch_make(sentText, target);
        const [merged, results] = dmp.patch_apply(localPatches, authoritativeText);
        nextValue = results.every(Boolean) ? merged : target;
      } else {
        nextValue = target;
      }
    }
    if (composing && document.activeElement === ta) {
      // The op the server just confirmed was sent *before* this composition
      // began, so the shadow advance above is already correct — `ta.value`
      // contains that text. Only the DOM write must wait, because assigning
      // `value` now would abort the IME.
      return;
    }
    setEditorText(ta, nextValue);
    updateTextStats();
  }
  pump(padId);
}

// Fold the in-flight op's intended text (or current textarea) back into the
// offline queue against the confirmed shadow, so a dropped connection can't
// lose local typing. Called on disconnect and on pad switch (P1 #3).
export function requeueInflight(padId = state.currentPadId) {
  const sync = getPadSync(padId);
  const q = state.getPatchQueue(padId);
  const ta = textarea();
  const queuedTarget = q.length > 0 && typeof q[q.length - 1] !== 'string' ? q[q.length - 1].sentText : null;
  const target = sync.pendingTarget ?? queuedTarget ?? ta.value;
  const inflight = sync.inflight;
  const hadQueuedItem = q.length > 0;
  // Start from a clean slate: anything previously queued is now folded into
  // `target`, so keeping it would double-apply those edits.
  q.length = 0;
  state.setPatchQueue(q, padId);
  const canRetrySameOperation = inflight?.kind === 'ws' && inflight.sentText === target && !hadQueuedItem;
  enqueuePatch(padId, sync, target, canRetrySameOperation ? inflight.operationId : null, false);
  sync.inflight = null;
  sync.pendingTarget = null;
}

// Drive the send pipeline for one pad. Only does work when there is no
// in-flight op. Flushes the oldest offline-queue item first, then sends any
// new local edits (shadow → current textarea). Sends exactly ONE op and then
// returns; the ACK handler re-pumps to continue.
function pump(padId = state.currentPadId) {
  // Suspend sends for the duration of an IME composition: the patch would be
  // diffed against a shadow the server has already moved past, and the nack's
  // HTTP retry would clobber the remote edit. endComposition() re-drives this.
  if (composing) return;
  const sync = getPadSync(padId);
  if (sync.inflight) return; // one in-flight at a time (P1 #1)
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.padId !== padId) return;

  // 1) Flush the oldest offline-queue item first (older edits precede new).
  let q = state.getPatchQueue(padId);
  if (q.length > 0) {
    const item = q[0];
    const patchText = typeof item === 'string' ? item : item.patchText;
    const sentText = typeof item === 'string' ? sync.lastSyncedText : item.sentText;
    const operationId = typeof item === 'string' ? null : item.operationId;
    if (sendPatchOverWs(patchText, sentText, padId, sync, operationId)) {
      q.shift();
      state.setPatchQueue(q, padId);
      if (q.length === 0) hideOfflineBanner();
    }
    return; // wait for ACK to send the next item
  }

  // 2) Send new local edits (shadow → current textarea).
  const currentText = sync.pendingTarget ?? textarea().value;
  sync.pendingTarget = currentText;
  if (currentText === sync.lastSyncedText) return;
  const dmp = getDmp();
  if (!dmp) return;
  const patches = dmp.patch_make(sync.lastSyncedText, currentText);
  const patchText = dmp.patch_toText(patches);
  if (!patchText) { sync.lastSyncedText = currentText; return; }
  sendPatchOverWs(patchText, currentText, padId, sync);
}

// Store the pad's unsent edits in localStorage while there is no usable
// connection. Does NOT advance the confirmed shadow (that only happens on ACK).
//
// The queue is deliberately collapsed to a SINGLE entry: one diff from the
// confirmed shadow straight to the newest local text. Appending one entry per
// 300ms debounce tick looked "sequential", but every entry carried a full copy
// of the document, so a 50KB pad went offline for two minutes and produced
// ~20MB — far past the ~5MB localStorage quota. The write then threw, the
// exception was swallowed, and edits disappeared while the banner still
// promised "pending sync". Collapsing is equivalent: each chained entry was
// diffed from the same shadow, so the last one already subsumes the others.
function enqueuePatch(padId, sync, target, operationId = null, announce = true) {
  if (target === sync.lastSyncedText) return;
  const dmp = getDmp();
  if (!dmp) return;
  let patchText = '';
  try {
    patchText = dmp.patch_toText(dmp.patch_make(sync.lastSyncedText, target));
  } catch {
    return;
  }
  if (!patchText) return;
  const q = state.getPatchQueue(padId);
  q.length = 0;
  q.push({
    patchText,
    sentText: target,
    operationId: operationId || `${clientInstanceId}:${padId}:${++patchSeq}`,
  });
  state.setPatchQueue(q, padId);
  if (announce) showOfflineBanner();
}

function queueOfflineDiff(padId, sync) {
  enqueuePatch(padId, sync, textarea().value);
}

// HTTP fallback used when the WS is CLOSED. Serialized like WS: only one
// in-flight HTTP write per pad, tagged with a monotonic per-pad requestToken so
// a stale response from a previous pad can't be applied to the new one (P1 #4).
async function httpFallback(padId, sync) {
  if (composing) return; // see pump() — never write mid-composition
  if (sync.inflight) return; // one in-flight at a time
  const currentText = textarea().value;
  const targetText = sync.pendingTarget ?? currentText;
  sync.pendingTarget = targetText;
  if (targetText === sync.lastSyncedText) return;
  if (typeof window.diff_match_patch !== 'function') return;

  const requestToken = ++sync.requestToken; // monotonic per-pad, never reset
  const baseVersion = sync.textVersion;
  sync.inflight = { kind: 'http', sentText: targetText, requestToken };
  try {
    const data = await updatePadText(padId, targetText, state.wsId, baseVersion);
    if (sync.inflight?.kind !== 'http' || sync.inflight.requestToken !== requestToken) return;
    if (data && data.conflict) {
      await mergeAndResync(targetText, data.text, data.textVersion, padId, sync, requestToken);
    } else {
      sync.textVersion = Math.max(sync.textVersion, data?.textVersion || 0);
      sync.lastSyncedText = targetText;
    }
  } catch (e) {
    if (e && e.status === 409 && e.data) {
      if (sync.inflight?.kind === 'http' && sync.inflight.requestToken === requestToken) {
        await mergeAndResync(targetText, e.data.text, e.data.textVersion, padId, sync, requestToken);
      }
    } else {
      console.warn('Failed to sync text:', e);
    }
  } finally {
    if (sync.inflight?.kind === 'http' && sync.inflight.requestToken === requestToken) {
      sync.inflight = null;
    }
    pump(padId);
  }
}

// --- Text state ---

// Apply a full authoritative body for a pad. Guarded so a stale (lower-version)
// full-text GET can never overwrite a newer WS-delivered body (P2 #5).
export function applyTextState(text, version, padId = state.currentPadId) {
  const sync = getPadSync(padId);
  text = text || '';
  const nextVersion = version || 0;
  if (nextVersion < sync.textVersion) return;
  const ta = textarea();
  setEditorText(ta, text);
  sync.textVersion = Math.max(sync.textVersion, nextVersion);
  sync.lastSyncedText = text;
  updateTextStats();
}

// Load a full snapshot without discarding a local operation that is queued or
// awaiting ACK. This is used after reconnects and patch-apply failures, where
// the snapshot can race the local write. The next ACK still replaces the shadow
// with the server's authoritative body.
export function applyLoadedText(text, version, padId = state.currentPadId) {
  const sync = getPadSync(padId);
  const q = state.getPatchQueue(padId);
  const hasPending = sync.pendingTarget !== null || !!sync.inflight || q.length > 0;
  const queuedTarget = q.length > 0 && typeof q[q.length - 1] !== 'string' ? q[q.length - 1].sentText : null;
  const target = sync.pendingTarget
    ?? sync.inflight?.sentText
    ?? queuedTarget
    ?? textarea().value;
  if (!hasPending) {
    applyTextState(text, version, padId);
    return;
  }
  sync.textVersion = Math.max(sync.textVersion, version || 0);
  setEditorText(textarea(), target);
  updateTextStats();
}

// --- Remote text merge ---

function queueRemoteText(text, version, sync, force = false) {
  if (version <= sync.textVersion) return;
  sync.pendingRemoteState = { text, textVersion: version, force };
}

function applyPendingRemoteText(padId = state.currentPadId) {
  const sync = getPadSync(padId);
  if (!sync.pendingRemoteState) return;
  // `force` is set when the body was deferred for a reason other than focus
  // (an IME composition was in flight) — the shadow version may already have
  // advanced past it, but the editor text still needs the update.
  if (!sync.pendingRemoteState.force && sync.pendingRemoteState.textVersion <= sync.textVersion) {
    sync.pendingRemoteState = null;
    return;
  }
  // Preserve any local edits made while the editor was focused.
  const remoteText = sync.pendingRemoteState.text;
  const hadLocal = sync.pendingTarget !== null || !!sync.inflight || textarea().value !== sync.lastSyncedText;
  const merged = mergePendingTarget(remoteText, sync);
  applyTextState(merged, sync.pendingRemoteState.textVersion, padId);
  sync.lastSyncedText = remoteText;
  if (hadLocal) sync.pendingTarget = merged;
  sync.pendingRemoteState = null;
}

export function applyRemoteText(text, version, padId = state.currentPadId, force = false) {
  const sync = getPadSync(padId);
  if (version <= sync.textVersion) return;
  if (!force && document.activeElement === textarea()) {
    queueRemoteText(text, version, sync);
    return;
  }
  if (composing && document.activeElement === textarea()) {
    queueRemoteText(text, version, sync, true);
    return;
  }
  // Apply the remote body visually, but keep the shadow authoritative. Any
  // local edits preserved by the rebase must remain a diff to be sent later.
  const hadLocal = sync.pendingTarget !== null || !!sync.inflight || textarea().value !== sync.lastSyncedText;
  const merged = mergePendingTarget(text, sync);
  applyTextState(merged, version, padId);
  sync.lastSyncedText = text;
  if (hadLocal) sync.pendingTarget = merged;
}

/**
 * Apply a remote patch to the editor while preserving cursor position.
 * Falls back to full-text replacement if patch_apply reports failures.
 */
export function applyRemotePatch(
  patchText,
  version,
  padId = state.currentPadId,
  authoritativeText = null,
  operationId = null
) {
  const sync = getPadSync(padId);
  if (operationId && sync.seenOperations.has(operationId)) return;
  if (!operationId && version <= sync.textVersion) return;
  if (typeof window.diff_match_patch !== 'function') return;
  if (typeof authoritativeText === 'string' && version > sync.textVersion) {
    const ta = textarea();
    // Never write `value` mid-IME-composition: doing so aborts the composition
    // and discards the word the user is currently spelling out. Park the
    // authoritative body and rebase onto it at compositionend.
    //
    // The shadow is deliberately NOT advanced here. `ta.value` is still diffed
    // against the old shadow, so advancing it would make the deferred merge
    // compute an empty local delta and silently drop the remote edit.
    if (composing && document.activeElement === ta) {
      queueRemoteText(authoritativeText, version, sync, true);
      rememberOperation(sync, operationId);
      return;
    }
    const hadLocal = sync.pendingTarget !== null || !!sync.inflight || ta.value !== sync.lastSyncedText;
    const mergedText = mergePendingTarget(authoritativeText, sync);
    setEditorText(ta, mergedText);
    sync.textVersion = Math.max(sync.textVersion, version);
    sync.lastSyncedText = authoritativeText;
    if (hadLocal) sync.pendingTarget = mergedText;
    rememberOperation(sync, operationId);
    updateTextStats();
    return;
  }
  const dmp = getDmp();
  let patches;
  try {
    patches = dmp.patch_fromText(patchText);
  } catch {
    return;
  }
  const ta = textarea();
  // Apply patch against the shadow (last confirmed server state), not the dirty
  // textarea value which may contain unsent local edits.
  const [newText, results] = dmp.patch_apply(patches, sync.lastSyncedText);
  if (!Array.isArray(results) || results.some((r) => !r)) {
    console.warn('applyRemotePatch: patch failed to apply cleanly — resyncing from server');
    loadPadContent();
    return;
  }
  // Preserve unsent local edits (e.g. text typed during the 300ms debounce
  // window): rebase them onto the new remote text instead of discarding them.
  const hadLocal = sync.pendingTarget !== null || !!sync.inflight || ta.value !== sync.lastSyncedText;
  const mergedText = mergePendingTarget(newText, sync);
  setEditorText(ta, mergedText);
  sync.textVersion = Math.max(sync.textVersion, version);
  // Shadow becomes the post-remote confirmed state; any surviving local delta
  // will be re-sent on the next send (currentText !== shadow).
  sync.lastSyncedText = newText;
  if (hadLocal) sync.pendingTarget = mergedText;
  rememberOperation(sync, operationId);
  updateTextStats();
}

/**
 * Server rejected our patch (concurrent conflict it couldn't merge, or
 * malformed patch). Reset shadow to the authoritative server text and rebuild
 * the offline queue as a single clean diff so the user's unsent edits are
 * re-sent rather than lost or double-applied. Does NOT clobber the editor with
 * the server text (the local edits are still in the textarea and will be
 * re-pushed).
 */
export function applyPatchNack(text, version, padId = state.currentPadId) {
  const sync = getPadSync(padId);
  if (version < sync.textVersion) return;
  const authoritative = text || '';
  sync.lastSyncedText = authoritative;
  sync.textVersion = version;
  sync.inflight = null;

  const ta = textarea();
  // A patch nack means the sender's base was incompatible with the server's
  // current body. Replaying another patch against that body can fail again;
  // use the conditional HTTP path so the server can atomically accept or merge
  // the complete intended text at this authoritative version.
  sync.pendingTarget = ta.value;
  state.setPatchQueue([], padId);
  const ws = state.ws;
  if (padId === state.currentPadId && ws && ws.readyState === WebSocket.OPEN && ws.padId === padId) {
    void httpFallback(padId, sync);
  } else {
    const dmp = getDmp();
    if (dmp && ta.value !== authoritative) {
      const patches = dmp.patch_make(authoritative, ta.value);
      const patchText = dmp.patch_toText(patches);
      if (patchText) {
        state.setPatchQueue([{
          patchText,
          sentText: ta.value,
          operationId: `${clientInstanceId}:${padId}:${++patchSeq}`,
        }], padId);
      }
    }
  }
}

// --- Offline banner ---

export function showOfflineBanner() {
  const banner = $('#offline-banner');
  if (banner) banner.hidden = false;
}

export function hideOfflineBanner() {
  const banner = $('#offline-banner');
  if (banner) banner.hidden = true;
}

// --- Send path (patch over WS, HTTP fallback) ---

function sendText() {
  const sync = getPadSync(state.currentPadId);
  sync.pendingTarget = textarea().value;
  clearTimeout(state.sendTimeout);
  state.sendTimeout = setTimeout(sendTextNow, 300);
}

export async function sendTextNow(padId = state.currentPadId) {
  state.sendTimeout = null;
  const sync = getPadSync(padId);
  const currentText = textarea().value;
  // Record the latest intended text; the pipeline re-diffs shadow → target
  // once the in-flight op is acknowledged.
  const targetText = sync.pendingTarget ?? currentText;
  sync.pendingTarget = targetText;
  if (targetText === sync.lastSyncedText && state.getPatchQueue(padId).length === 0) return;
  if (typeof window.diff_match_patch !== 'function') return;

  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN && ws.padId === padId) {
    pump(padId);
  } else if (!ws || ws.readyState === WebSocket.CONNECTING || ws.padId !== padId) {
    // Queue for when connection opens — pad-scoped. (P1 #2: shadow is NOT
    // advanced here, so a failed locked-pad unlock preserves the queue.)
    queueOfflineDiff(padId, sync);
  } else {
    // WS closed — HTTP fallback.
    await httpFallback(padId, sync);
  }
}

// Server rejected our HTTP write because its text diverged from our base. Merge
// our local edits (relative to the last confirmed shadow) onto the server's
// current text and re-save; if the merge can't be clean, keep the server text
// locally to avoid silent divergence.
async function mergeAndResync(localText, serverText, serverVersion, padId, sync, requestToken) {
  let merged = serverText;
  const dmp = getDmp();
  if (dmp && localText !== sync.lastSyncedText) {
    const localPatches = dmp.patch_make(sync.lastSyncedText, localText);
    const [m, results] = dmp.patch_apply(localPatches, serverText);
    if (results.every(Boolean)) merged = m;
  }
  try {
    if (sync.inflight?.kind !== 'http' || sync.inflight.requestToken !== requestToken) return;
    const data = await updatePadText(padId, merged, state.wsId, serverVersion);
    sync.textVersion = Math.max(sync.textVersion, data?.textVersion || serverVersion || 0);
    sync.lastSyncedText = merged;
    sync.inflight = null;
    if (padId === state.currentPadId) {
      setEditorText(textarea(), merged);
    }
  } catch (e) {
    // Couldn't persist the merge — at least adopt the server's text locally.
    console.warn('Failed to resync after conflict:', e);
    sync.textVersion = Math.max(sync.textVersion, serverVersion || 0);
    sync.lastSyncedText = serverText;
  }
}

// Flush the offline queue for a pad over the open WS. Safe to call on connect:
// items stay in localStorage until a WS is actually open (P1 #2).
export function flushPatchQueue(padId = state.currentPadId) {
  const ws = state.ws;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  pump(padId);
}

/**
 * Handle image paste → convert data URL → insert as Markdown image reference.
 * The base64 data is stored in SQLite text column, but the server rejects pads
 * whose text exceeds 100k characters, and base64 inflates ~4/3 — so cap the
 * embedded data URL well under that to avoid a server nack (P2 #6).
 */
function handleImagePaste(e) {
  const items = e.clipboardData?.items;
  if (!items) return;
  for (const item of items) {
    if (!item.type.startsWith('image/')) continue;
    e.preventDefault();
    const file = item.getAsFile();
    if (!file) continue;
    if (file.size > 2 * 1024 * 1024) {
      showToast('Image too large (max 2MB)');
      continue;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const currentText = textarea().value;
      if (typeof dataUrl === 'string' && (dataUrl.length > 75000 || currentText.length + dataUrl.length + 8 > 100000)) {
        showToast('Image too large to embed (max ~56KB)');
        return;
      }
      const ta2 = textarea();
      const pos = ta2.selectionStart;
      const alt = file.name || 'image';
      const insert = `![${alt}](${dataUrl})\n`;
      ta2.value = ta2.value.slice(0, pos) + insert + ta2.value.slice(ta2.selectionEnd);
      ta2.selectionStart = ta2.selectionEnd = pos + insert.length;
      // Do NOT advance lastSyncedText here — let sendText() compute the real
      // diff from the previous shadow so the image is actually pushed to peers.
      sendText();
      updateTextStats();
    };
    reader.readAsDataURL(file);
    break; // Only handle first image
  }
}

/**
 * On unload, if WS is closed and there's unsynced text, flush into the
 * queue so it's sent on next page load once WS reopens.
 */
function handleBeforeUnload() {
  const ws = state.ws;
  if (ws && ws.readyState === WebSocket.OPEN) return;
  const padId = state.currentPadId;
  const sync = getPadSync(padId);
  const ta = textarea();
  if (!ta || ta.value === sync.lastSyncedText) return;
  try {
    enqueuePatch(padId, sync, ta.value, null, false);
  } catch {}
}

export function initTextSync() {
  const ta = textarea();
  ta.addEventListener('input', () => { sendText(); updateTextStats(); });
  ta.addEventListener('blur', () => {
    // Safety net: if `compositionend` never fires (IME cancelled, editor
    // hidden), stop suspending sends before applying the deferred body.
    endComposition();
    applyPendingRemoteText();
  });
  ta.addEventListener('paste', handleImagePaste);
  ta.addEventListener('compositionstart', () => { composing = true; });
  ta.addEventListener('compositionend', () => {
    // The browser emits the committing `input` event right after this one, so
    // let it land first: pendingTarget then holds the committed text and the
    // rebase keeps both the local word and the remote edit.
    setTimeout(endComposition, 0);
  });
  window.addEventListener('beforeunload', handleBeforeUnload);
  // Coming back from a background tab (mobile especially) can leave us holding
  // a stale body after the socket silently died. Re-pull the snapshot unless
  // the user has edits we have not flushed yet — those must not be clobbered.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const padId = state.currentPadId;
    const sync = getPadSync(padId);
    const hasPending = sync.pendingTarget !== null
      || !!sync.inflight
      || state.getPatchQueue(padId).length > 0;
    if (!hasPending) void loadPadContent();
  });
  // Restore lastSyncedText from any queued patches on load
  setTimeout(flushPatchQueue, 2000); // try flush after WS has had a chance to connect
  updateTextStats();
}
