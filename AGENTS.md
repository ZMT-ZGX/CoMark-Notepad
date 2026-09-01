# AGENTS.md

> Convention file for AI agents and human contributors. Describes repository layout, conventions, and the rules you must follow.

## Repository Layout

```
collab-notepad/
├── src/                          # Backend (TypeScript, CommonJS)
│   ├── server.ts                 # DI assembly, HTTP/WS startup, graceful shutdown
│   ├── app.ts                    # Express config, /api/search route
│   ├── config.ts                 # Env vars & constants
│   ├── types.ts                  # Core types + WsMessage union
│   ├── auth/                     # session.ts · password.ts
│   ├── middlewares/              # auth · security · errorHandler
│   ├── routes/                   # auth · pads · files · invitations · convert · health
│   ├── services/                 # padService · fileService · inviteService · convertService
│   ├── db/                       # sqlite.ts (incl. FTS5 + triggers) · pads · files · users · invitations
│   ├── store/                    # DataStore facade
│   ├── validators/               # Zod schemas
│   ├── utils/                    # crypto · auth · errors · file · logger
│   └── ws/                       # connections · broadcast · index
├── public/                       # Frontend (vanilla JS, zero framework)
│   ├── index.html
│   ├── js/                       # ES Modules
│   │   ├── core.js               # Shared state singleton
│   │   ├── text-sync.js          # Patch send, offline queue, image paste
│   │   ├── ws.js                 # WebSocket client
│   │   ├── server.js             # HTTP API client
│   │   ├── pads.js               # Pad tabs
│   │   ├── files.js              # File list · drag/paste/click upload
│   │   ├── search.js             # FTS5 search UI
│   │   ├── preview.js            # Markdown preview + TOC
│   │   ├── shortcuts.js          # Keyboard shortcuts
│   │   ├── invitation.js         # Invite/redeem
│   │   ├── modals.js             # Modal handlers
│   │   ├── export.js             # Export Markdown + beforeunload
│   │   ├── theme.js              # Theme toggle
│   │   ├── qr.js                 # QR code
│   │   └── gestures.js           # Mobile gestures
│   ├── vendor/                   # Browser globals (CommonJS → window.*)
│   │   └── diff_match_patch.js   # Patch-based sync library
│   └── style.css
├── convert-worker.js             # Worker thread: file → Markdown
├── tests/                        # 72 integration tests
│   ├── identity.test.js          # Auth & access control
│   ├── smoke.test.js             # Core API, WebSocket
│   ├── convert.test.js           # Worker conversion
│   └── e2e/                      # Playwright E2E
├── scripts/                      # Ops: deploy.sh (build+health+rollback) · backup.sh · sqlite-backup.js
├── docs/                         # DEPLOYMENT.md (self-hosting runbook) · design notes
├── Dockerfile                    # Multi-stage (node:20-alpine, non-root)
├── docker-compose.yml            # Compose + Caddy; service-level mem_limit/cpus
├── Caddyfile                     # Reverse proxy + automatic HTTPS
├── .env.example
└── data/                         # Runtime (SQLite + uploads)
```

## How to Run

```bash
npm install
npm run dev                       # tsx watch mode (TypeScript, no build)
# or
npm run build && npm start        # production build

# Custom port
PORT=3000 npm start

# Docker
docker compose up -d
```

## Build, Test & Lint

```bash
npm run typecheck                 # tsc --noEmit
npm test                          # node --test (75 tests)
npm run lint                      # ESLint
npm run format                    # Prettier
npm run test:e2e                  # Playwright (requires build first)
```

- Test framework: **Node.js built-in** (`node:test` + `node:assert/strict`), NOT jest
- Tests spawn real server subprocesses on random ports with temp data dirs
- Worker tests use actual Worker threads with real file buffers
- All tests must pass (exit 0) before any change is considered complete

## Code Style & Conventions

- **No frontend framework** — vanilla DOM APIs, `$()` shorthand for `querySelector`
- **Frontend** is ES Modules (`import`/`export`)
- **Backend** is CommonJS (`require`/`module.exports`) compiled with `tsc`
- **Class services** typed with `import type` aliases; `export =` for default
- **Worker threads** for CPU-intensive conversion (never block main loop)
- **Atomic writes**: `db.transaction()` for SQLite writes
- **Error handling**: `try/catch` with `logger.warn/error`; API returns `{ error: string }`
- **Naming**: camelCase for functions/vars, PascalCase for classes, UPPER_SNAKE for constants
- **Security headers**: helmet with relaxed CSP (inline SVG favicon needs `unsafe-inline` style)
- **Browser libs** go in `public/vendor/` wrapped to expose `window.*` globals
- **State** is a single mutable singleton in `public/js/core.js`

## Architecture Notes

- **Session tokens**: HMAC-SHA256 in httpOnly cookies (`userId.timestamp.signature`), 30-day TTL
- **CSRF**: Origin header validation with private IP bypass for LAN clients
- **Pad access**: 3-tier — public (`ownerUserId=null`), private (owner+invited), legacy (admin-only)
- **Pad unlock tokens**: bearer tokens for password-protected pads; **header only** (`X-Pad-Token`, comma-separated multi-token OK). Never put unlock tokens in query strings (access/proxy logs). Shared helpers: `extractPadTokens` / `hasValidUnlockToken` in `middlewares/security.ts`; client: `padAuthHeaders()` in `public/js/core.js`
- **WebSocket**: per-pad rooms, 30s ping/pong heartbeat, per-IP connection limit (10); locked pads auth via first message `{ type: 'auth', padToken }`; every `applyPatch` re-validates `ws.unlockToken` (close **4403** if invalid). Sockets are counted from the `connection` event (pending) through `finalizeConnection` (live) so the 1.5s auth window can't be used to stack invisible connections
- **Patch sync**: `diff-match-patch` over WS; per-pad shadow + single in-flight op; pad-scoped offline queue in localStorage. **One broadcast frame per edit** — `applyPatch` sends only `patch` (which carries both the diff and the authoritative body); a second `text-update` snapshot is pure waste because the client's `version <= textVersion` guard drops it
- **Editor writes**: always go through `setEditorText()` in `text-sync.js` so the caret is mapped across the diff; never assign `textarea.value` while an IME composition is active (see below)
- **File conversion**: in-worker with configurable heap (`CONVERT_WORKER_HEAP_MB`, default 512MB) and concurrency (`CONVERT_MAX_CONCURRENT`, default 3), 60s timeout; default **100MB** (`CONVERT_MAX_BYTES`). Peak memory = concurrency × worker heap, and the file being converted is briefly held **twice** (main process + the structured-clone copy handed to the worker). This total must fit inside the container memory limit
- **Health probes**: `/api/health` is **liveness only — it must never touch the database** (Docker restarts the container after repeated failures, so a busy SQLite checkpoint must not kill a healthy process). `/api/health/ready` is readiness: it queries SQLite and returns `pads` / `files`, 503 if the DB is unreachable
- **Container limits**: `docker-compose.yml` must use service-level `mem_limit` / `cpus`. `deploy.resources.limits` is only honoured in Swarm mode or with `--compatibility` — on a single self-hosted box it silently does nothing
- **Logging**: production logs are JSON (pino) with `cookie` / `authorization` / `x-pad-token` / `password` / `token` redacted via `redact`. Pad unlock tokens are long-lived bearer credentials — never let them reach the log stream
- **FTS5 search**: `pad_search` virtual table (trigram) + 3 triggers; `/api/search` with access filtering + unlock gating; snippet delimiters are private-use `U+E000`/`U+E001` (client escapes then restores `<mark>`) — never raw HTML from FTS
- **WAL + busy_timeout=5000**: SQLite concurrency hardening
- **DB migration**: SQLite-first; legacy `store.json` auto-imported with backup

## Constraints — Do NOT

- Do NOT use `jest` — this project uses `node --test`
- Do NOT add a frontend framework (React, Vue, etc.) — vanilla JS only
- Do NOT add new backend router files outside `src/routes/`
- Do NOT access `db` directly from route handlers — go through `padService` / `fileService` / etc.
- Do NOT load diff-match-patch from a CDN — use `public/vendor/diff_match_patch.js`
- Do NOT silently swallow patch failures — log with `logger.warn` and either reject or fall back
- Do NOT skip access checks on new endpoints — always run through `canAccessPad()`
- Do NOT accept pad unlock tokens from query strings (`?padToken=`) — header only
- Do NOT render FTS snippets as HTML without escaping; do NOT reintroduce literal `<mark>` delimiters from SQLite `snippet()`
- Do NOT add offline queue entries with a global key — namespace by `padId`
- Do NOT grow the offline queue beyond one entry per pad — coalesce shadow → latest text (a per-keystroke chain blows the ~5MB localStorage quota and silently loses edits)
- Do NOT assign `textarea.value` directly or send patches while an IME composition is active — use `setEditorText()` and let `endComposition()` reconcile
- Do NOT re-add a second broadcast in `applyPatch` (e.g. `text-update` alongside `patch`) — it doubles outbound body for zero client benefit
- Do NOT add database queries to the `/api/health` liveness endpoint — it exists to prove the *process* is alive; anything DB-backed belongs in `/api/health/ready`
- Do NOT use `deploy.resources.limits` in `docker-compose.yml` for single-host deployment limits — it is ignored outside Swarm/`--compatibility`; use service-level `mem_limit` / `cpus`
- Do NOT raise `CONVERT_MAX_CONCURRENT` without raising the container `mem_limit` proportionally (peak = concurrency × `CONVERT_WORKER_HEAP_MB`)
- Do NOT read `process.env` directly in `app.ts` for config — parse it in `config.ts` so malformed values fall back consistently
- Do NOT modify `state` object outside `public/js/core.js` modules
- Do NOT commit secrets, `.env` files, or API keys

## Environment Variables

See `.env.example`. Key vars:
- `SESSION_SECRET` — required in production (HMAC signing key)
- `PUBLIC_ORIGIN` — CSRF origin check (falls back to localhost/LAN)
- `ADMIN_TOKEN` — global pad management
- `DATA_DIR` — data directory path (default: `./data`)
- `PORT` — server port (default: 8000)
- `CONVERT_MAX_BYTES` — max file size for Markdown conversion (default: 100MB)
- `CONVERT_TIMEOUT_MS` — conversion timeout (default: 60000)
- `CONVERT_MAX_CONCURRENT` / `CONVERT_WORKER_HEAP_MB` — conversion concurrency & per-worker heap (defaults 3 / 512). Raise concurrency only after raising the container `mem_limit` by the same multiple of the heap
- `TRUST_PROXY_HOPS` — proxy hops trusted for `X-Forwarded-For` (default 0). **Set to 1 behind Caddy/Nginx**: at 0 every request looks like it comes from the proxy, collapsing the HTTP rate limiter and per-IP WebSocket cap into one shared bucket. Parsed once in `config.ts`; do not read `process.env` directly in `app.ts`
- `LOG_LEVEL` — pino level (default `info`)
- `MAX_WS_CONNECTIONS` / `MAX_WS_CONNECTIONS_PER_IP` / `WS_PATCH_WINDOW_MS` / `MAX_WS_PATCHES_PER_WINDOW` — WebSocket limits (defaults 1000 / 10 / 60000 / 120)

## Definition of Done

A change is complete when:
1. All code changes are saved to files
2. `npm run typecheck` passes (0 errors)
3. `npm test` passes with exit code 0 (75/75)
4. `npm run lint` passes with no new warnings
5. If security-related: verify CSRF, auth, CSP, and unlock-token header-only behavior
6. If frontend: verify in browser at relevant breakpoints (desktop + mobile)
7. If public API: document in README.md and CHANGELOG.md
