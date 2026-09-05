'use strict';

import type { CoMarkWebSocket } from '../types';

// RFC 6455 bounds a close reason to 123 bytes, and `ws` throws a synchronous
// RangeError on anything longer. A throw from inside ws's message / close
// listeners has no net below it (there is no uncaughtException handler), so
// every close call in the codebase must go through `safeClose`.
const MAX_CLOSE_REASON_BYTES = 123;

/**
 * Close a socket without ever throwing. Reasons longer than 123 bytes are
 * truncated (a multi-byte code point split by the cut decodes to a
 * replacement char — the close reason is advisory text, so that is fine);
 * any residual error from an already-broken socket is swallowed.
 */
function safeClose(ws: CoMarkWebSocket, code: number, reason: string): void {
  try {
    const bytes = Buffer.from(reason, 'utf8');
    let bounded = reason;
    if (bytes.length > MAX_CLOSE_REASON_BYTES) {
      // Truncate on a byte boundary and RE-DECODE until the UTF-8 encoding
      // also fits. One cut is not enough: a split multi-byte sequence decodes
      // to U+FFFD replacement chars (3 bytes each), so the decoded string can
      // re-expand past the limit (123 bytes of split code points → up to ~369
      // bytes) and `ws.close` would throw — and the throw would escape into
      // ws's listener and kill the process. Terminates: cut=0 → '' → 0 bytes.
      let cut = MAX_CLOSE_REASON_BYTES;
      bounded = bytes.subarray(0, cut).toString('utf8');
      while (Buffer.byteLength(bounded, 'utf8') > MAX_CLOSE_REASON_BYTES && cut > 0) {
        cut -= 1;
        bounded = bytes.subarray(0, cut).toString('utf8');
      }
    }
    ws.close(code, bounded);
  } catch {}
}

module.exports = { safeClose, MAX_CLOSE_REASON_BYTES };
