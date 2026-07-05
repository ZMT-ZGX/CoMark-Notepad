# Context — CoMark-Notepad

## What This Project Is

A self-hosted, LAN-first collaborative notepad. Think Google Docs meets a sticky note — no accounts, no cloud, just open a browser and start typing. Files can be shared alongside notes, and documents can be auto-converted to Markdown.

## Why It Exists

For small teams / families on a local network who want zero-friction collaboration without signing up for SaaS. Scan a QR code, get editing.

## Current State (as of v1.1.0)

- **Mature**: 11 rounds of code review completed, 50+ issues fixed
- **Stable**: 68 integration/unit tests all passing
- **Security-hardened**: CSRF protection, rate limiting, timing-safe auth, CSP headers, path traversal prevention, XSS sanitization in HTML→Markdown
- **Feature-complete**: Multi-pad, patch-based WebSocket sync, FTS5 search, file upload/convert, password protection, invitation system, dark/light theme, mobile-optimized
- **Patch-based collaboration**: `diff-match-patch` over WS; offline queue in localStorage; cursor preservation on remote apply

## Key Files & Their Roles

| File | Role |
|------|------|
| `src/server.ts` | DI assembly, HTTP/WS startup, graceful shutdown |
| `src/app.ts` | Express app, global middleware, `/api/search` route |
| `src/config.ts` | Env vars & constants |
| `src/types.ts` | Core types + WsMessage union |
| `src/auth/` | session.ts, password.ts (HMAC, scrypt) |
| `src/middlewares/` | auth, security, errorHandler |
| `src/routes/` | auth, pads, files, invitations, convert, health |
| `src/services/` | padService (incl. `applyPatch`), fileService, inviteService, convertService |
| `src/db/sqlite.ts` | SQLite schema, FTS5 + triggers, WAL, busy_timeout |
| `src/db/pads.ts` | Pad CRUD + `searchPads` / `searchSnippet` |
| `src/ws/index.ts` | WS connection handler, heartbeat, `patch` message routing |
| `src/ws/broadcast.ts` | Per-pad broadcast utility |
| `public/index.html` | SPA markup, all modals, vendor script tag |
| `public/js/core.js` | Shared state singleton, patchQueue localStorage helpers |
| `public/js/text-sync.js` | Patch send/receive, offline queue, image paste |
| `public/js/ws.js` | WebSocket lifecycle, message dispatch |
| `public/js/search.js` | FTS5 search UI (Ctrl+Shift+F) |
| `public/js/preview.js` | Markdown preview + TOC extraction |
| `public/js/shortcuts.js` | Keyboard shortcut registry |
| `public/js/pads.js` | Pad tabs, switch/create/delete |
| `public/js/files.js` | File list, upload, search |
| `public/js/invitation.js` | Invite generation + redemption |
| `public/js/export.js` | Markdown export, beforeunload patch flush |
| `public/js/theme.js` | Theme toggle (auto/dark/light) + system matchMedia |
| `public/js/gestures.js` | Mobile touch gestures (AlloyFinger) |
| `public/js/qr.js` | QR code popup |
| `public/js/modals.js` | Modal open/close + pad unlock |
| `public/js/server.js` | HTTP API client (fetch wrappers) |
| `public/vendor/diff_match_patch.js` | CommonJS → window.* wrapper |
| `public/style.css` | Apple-style design, dark/light, mobile responsive |
| `convert-worker.js` | Worker thread: file → Markdown |
| `tests/identity.test.js` | Auth, invitations, access control |
| `tests/smoke.test.js` | Core API, WebSocket flow |
| `tests/convert.test.js` | Worker conversion correctness |
| `tests/e2e/` | Playwright E2E tests |

## Architecture Highlights

- **Patch-based sync** — `diff-match-patch` over WS; clients send diffs, server applies + broadcasts
- **Offline queue** — `localStorage` keyed by `padId`; flushed on `onopen` and at `beforeunload`
- **SQLite + FTS5** — `pad_search` virtual table with 3 triggers; WAL + `busy_timeout=5000`
- **No frontend framework** — vanilla JS with `$()` helper, ES Modules
- **Worker isolation** — each file conversion runs in a fresh Worker thread with 512MB heap cap
- **Cookie auth** — HMAC-SHA256 signed tokens in httpOnly cookies, 30-day TTL
- **WebSocket rooms** — clients grouped by padId, broadcast scoped per-pad
- **3-tier access** — public pads (anyone), private pads (owner + invited), admin (everything)
- **TypeScript + Zod** — strict TS on backend, runtime validation on all write paths
- **Module monolith** — single Express process, modular by directory (`src/{routes,services,db,ws,...}`)

## Known Limitations

- **No OT/CRDT** — concurrent inserts at the same position can still lose patches (use Yjs/Automerge for Google-Docs-level merging)
- **Image base64 in SQLite** — simple but bloats DB; >2MB rejected at paste time
- **Vendor libs** — `diff-match-patch` is wrapped manually; future browsers libs should follow the same pattern

## Deployment

```bash
# Direct
npm run dev                        # development (tsx watch)
npm run build && npm start         # production

# Docker
docker compose up -d
```

Data persists in `./data/` (or `DATA_DIR` env var). SQLite migrations run automatically on startup.
