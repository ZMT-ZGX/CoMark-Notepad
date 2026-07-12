# Context — CoMark-Notepad

## What This Project Is

A self-hosted, LAN-first collaborative notepad. Think Google Docs meets a sticky note — no accounts, no cloud, just open a browser and start typing. Files can be shared alongside notes, and documents can be auto-converted to Markdown.

## Why It Exists

For small teams / families on a local network who want zero-friction collaboration without signing up for SaaS. Scan a QR code, get editing.

## Current State (as of v1.1.2 + Unreleased security pass)

- **Mature**: Multiple code-review rounds; security pass covering search XSS, unlock-token log exposure, locked-pad gating, WS re-auth on write
- **Stable**: **74** integration/unit tests all passing; `tsc --noEmit` clean
- **Security-hardened**: CSRF protection, rate limiting, timing-safe auth, CSP headers, path traversal prevention, FTS snippet XSS-safe delimiters, unlock tokens header-only
- **Feature-complete**: Multi-pad, patch-based WebSocket sync (per-pad reliable delivery), FTS5 search, file upload/convert (100MB), password protection, invitation system, dark/light theme, mobile-optimized
- **Patch-based collaboration**: `diff-match-patch` over WS; per-pad shadow + single in-flight op; offline queue in localStorage; cursor preservation on remote apply

## Key Files & Their Roles

| File | Role |
|------|------|
| `src/server.ts` | DI assembly, HTTP/WS startup, graceful shutdown |
| `src/app.ts` | Express app, global middleware, `/api/search` (unlock-gated) |
| `src/config.ts` | Env vars & constants (`CONVERT_MAX_BYTES` default 100MB) |
| `src/types.ts` | Core types + WsMessage union; `CoMarkWebSocket.unlockToken` |
| `src/auth/` | session.ts, password.ts (HMAC, scrypt) |
| `src/middlewares/` | auth, security (`extractPadTokens` / `hasValidUnlockToken` / `requirePadUnlock`), errorHandler |
| `src/routes/` | auth, pads, files, invitations, convert, health |
| `src/services/` | padService (`applyPatch` structured results + lock re-check, `getState` file gating), fileService, inviteService, convertService |
| `src/db/sqlite.ts` | SQLite schema, FTS5 + triggers, WAL, busy_timeout |
| `src/db/pads.ts` | Pad CRUD + `searchPads` / `searchSnippet` (U+E000/E001 delimiters) |
| `src/ws/index.ts` | WS connection handler, heartbeat, patch routing, unlock re-validation |
| `src/ws/broadcast.ts` | Per-pad broadcast utility |
| `public/index.html` | SPA markup, all modals, vendor script tag |
| `public/js/core.js` | Shared state singleton, `padAuthHeaders` / pad-token helpers, patchQueue localStorage |
| `public/js/text-sync.js` | Per-pad patch send/receive, offline queue, image paste |
| `public/js/ws.js` | WebSocket lifecycle, auth-first message, message dispatch |
| `public/js/search.js` | FTS5 search UI (Ctrl+Shift+F); XSS-safe snippet render |
| `public/js/preview.js` | Markdown preview + TOC; download via header auth |
| `public/js/shortcuts.js` | Keyboard shortcut registry |
| `public/js/pads.js` | Pad tabs, switch/create/delete, `refreshPads` |
| `public/js/files.js` | File list, drag/paste/click upload, header-auth download |
| `public/js/invitation.js` | Invite generation + redemption |
| `public/js/export.js` | Markdown export; beforeunload hybrid flush (keepalive / sendBeacon) |
| `public/js/theme.js` | Theme toggle (auto/dark/light) + system matchMedia |
| `public/js/gestures.js` | Mobile touch gestures (AlloyFinger) |
| `public/js/qr.js` | QR code popup |
| `public/js/modals.js` | Modal open/close + pad unlock (refreshes state after unlock) |
| `public/js/server.js` | HTTP API client (`padAuthHeaders` on authenticated calls) |
| `public/vendor/diff_match_patch.js` | CommonJS → window.* wrapper |
| `public/style.css` | Apple-style design, dark/light, mobile responsive |
| `convert-worker.js` | Worker thread: file → Markdown |
| `tests/identity.test.js` | Auth, invitations, access control, WS padToken |
| `tests/smoke.test.js` | Core API, WebSocket flow, locked search gating |
| `tests/convert.test.js` | Worker conversion correctness |
| `tests/e2e/` | Playwright E2E tests |

## Architecture Highlights

- **Patch-based sync** — `diff-match-patch` over WS; clients send diffs, server applies + broadcasts; structured ack/nack/locked results
- **Offline queue** — `localStorage` keyed by `padId`; flushed after authenticated `hello`; unload tail via keepalive/sendBeacon
- **SQLite + FTS5** — `pad_search` virtual table with 3 triggers; WAL + `busy_timeout=5000`; XSS-safe snippet delimiters
- **Unlock tokens** — header-only `X-Pad-Token` (multi-token OK); WS first-message auth; re-check on every write
- **No frontend framework** — vanilla JS with `$()` helper, ES Modules
- **Worker isolation** — each file conversion runs in a fresh Worker thread with 512MB heap cap; default convert limit **100MB**
- **Cookie auth** — HMAC-SHA256 signed tokens in httpOnly cookies, 30-day TTL
- **WebSocket rooms** — clients grouped by padId, broadcast scoped per-pad
- **3-tier access** — public pads (anyone), private pads (owner + invited), admin (everything)
- **TypeScript + Zod** — strict TS on backend, runtime validation on all write paths
- **Module monolith** — single Express process, modular by directory (`src/{routes,services,db,ws,...}`)

## Known Limitations

- **No OT/CRDT** — concurrent inserts at the same position can still lose patches (use Yjs/Automerge for Google-Docs-level merging)
- **Image base64 in SQLite** — simple but bloats DB; large embeds capped client-side before server 100k-char limit
- **beforeunload flush is best-effort** — browser ~64KB body cap on beacon/keepalive; main path is WS
- **Pad IDs are SQLite AUTOINCREMENT** — deleted IDs are not reused; UI shows raw id (gaps after delete are expected)
- **Vendor libs** — `diff-match-patch` is wrapped manually; future browser libs should follow the same pattern

## Deployment

```bash
# Direct
npm run dev                        # development (tsx watch)
npm run build && npm start         # production

# Docker
docker compose up -d
```

Data persists in `./data/` (or `DATA_DIR` env var). SQLite migrations run automatically on startup.
