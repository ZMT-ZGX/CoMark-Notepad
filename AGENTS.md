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
│   ├── middlewares/              # auth · security · writeAccess · errorHandler
│   ├── routes/                   # auth · pads · files · invitations · convert · health · writeAccess (+members)
│   ├── services/                 # padService · fileService · inviteService · convertService · writeAccessService
│   ├── db/                       # sqlite.ts (incl. FTS5 + triggers) · pads · files · users · invitations · writeGrants · migrate
│   ├── store/                    # DataStore facade
│   ├── validators/               # Zod schemas
│   ├── utils/                    # crypto · auth · errors · file · logger
│   └── ws/                       # connections · broadcast · index · handlers · validate · close
├── public/                       # Frontend (vanilla JS, zero framework)
│   ├── index.html
│   ├── js/                       # ES Modules
│   │   ├── core.js               # Shared state singleton (state shape + setters)
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
│   │   ├── gestures.js           # Mobile gestures
│   │   ├── presence.js           # Online-members chips (relay-only)
│   │   └── write-access.js       # Write-gate UI: banner, chip, passphrase modal, members panel
│   ├── vendor/                   # Browser globals (CommonJS → window.*)
│   │   └── diff_match_patch.js   # Patch-based sync library
│   └── style.css
├── convert-worker.js             # Worker thread: file → Markdown
├── tests/                        # 111 integration tests (node --test)
│   ├── helpers.js                # Shared harness: spawnServer/stopServer/installOriginFetch (NOT a test file)
│   ├── identity.test.js          # Auth & access control (36)
│   ├── smoke.test.js             # Core API, WebSocket (31)
│   ├── convert.test.js           # Worker conversion (20)
│   ├── write-access.test.js      # Write gate open/gated (9)
│   ├── security.test.js          # WS frames, orphans, zip bombs, quotas, convert authz (8)
│   ├── concurrency.test.js       # baseVersion mandatory, WS origin (4)
│   └── e2e/                      # Playwright E2E
├── scripts/                      # Ops: deploy.sh (build+health+rollback) · backup.sh · sqlite-backup.js
├── docs/                         # DEPLOYMENT.md (self-hosting runbook) · competitive-analysis.md · public-deployment-plan.md
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
npm test                          # node --test (111 tests)
npm run lint                      # ESLint
npm run format                    # Prettier
npm run test:e2e                  # Playwright (requires build first)
```

- **Test framework**: **Node.js built-in** (`node:test` + `node:assert/strict`), NOT jest
- Tests spawn real server subprocesses on random ports with temp data dirs — the shared harness lives in `tests/helpers.js` (`spawnServer` / `stopServer` / `installOriginFetch`); do not copy-paste new spawn blocks
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
- **State** is a single mutable singleton in `public/js/core.js` — the shape and every setter live there; other modules mutate values only through `state.setWriteAccess()` / `state.setAdminToken()` / `getPatchQueue`-style methods, never by assigning new fields

## Architecture Notes

- **Session tokens**: HMAC-SHA256 in httpOnly cookies (`userId.timestamp.signature`), 30-day TTL
- **CSRF**: Origin header validation with private IP bypass for LAN clients
- **Pad access**: 3-tier — public (`ownerUserId=null`), private (owner+invited), legacy (admin-only)
- **Pad unlock tokens**: bearer tokens for password-protected pads; **header only** (`X-Pad-Token`, comma-separated multi-token OK). Never put unlock tokens in query strings (access/proxy logs). Shared helpers: `extractPadTokens` / `hasValidUnlockToken` in `middlewares/security.ts`; client: `padAuthHeaders()` in `public/js/core.js`
- **WebSocket**: per-pad rooms, 30s ping/pong heartbeat, per-IP connection limit (10); locked pads auth via first message `{ type: 'auth', padToken }`; every `applyPatch` re-validates `ws.unlockToken` (close **4403** if invalid). Sockets are counted from the `connection` event (pending) through `finalizeConnection` (live) so the 1.5s auth window can't be used to stack invisible connections. **Every close goes through `safeClose()` (`src/ws/close.ts`)** — `ws` throws a synchronous RangeError on reasons longer than 123 bytes, and an uncaught throw from inside a ws listener trips the process-level `uncaughtException` net (`server.ts`), which shuts the whole instance down; never call `ws.close()` directly
- **Write access gate** (`WRITE_ACCESS_MODE=gated`): all write paths run through `requireWriteAccess(writeAccessService)` (factory in `middlewares/writeAccess.ts`; admin check resolved per-request internally) + WS re-check on every patch (`4405`). Locked: 11 HTTP + 1 WS = 12 write paths — a new write endpoint without the gate is a security bug. Client UI: banner (read-only) + header chip (writable: remaining days + release) in `public/js/write-access.js`
- **Patch sync**: `diff-match-patch` over WS; per-pad shadow + single in-flight op; pad-scoped offline queue in localStorage; clients send `baseVersion` on every patch and the server nacks on mismatch. **`baseVersion` is MANDATORY on both write paths** (WS `patch` and HTTP `PUT/POST /:id/text`): a write that omits it is rejected (WS → `patch-nack`; HTTP → `409` conflict) instead of being applied against whatever the server currently holds. It used to be optional with the check skipped when absent, which made the concurrency control opt-in — any client could disable it by omitting one field and silently clobber a concurrent edit. Regression tests: `tests/concurrency.test.js` **One diff-only frame per edit** — `patch-ack` returns only `{textVersion, seq}` and the broadcast `patch` frame carries only the diff (the receiver rebuilds the body via `patch_apply` on its shadow; HTTP resync covers apply failures). Never put a full body back into these frames: acking a patch implies the server body equals the sender's `sentText`, and echoing bodies costs a full serialization per keystroke per peer
- **Presence**: `{type:'presence'}` / `{type:'presence-request'}` frames are relay-only — the server stores nothing and runs no timeouts; per-connection 400ms relay throttle, removal via close broadcast + 35s client-side staleness prune. Chips live in `public/js/presence.js`; remote caret overlay in the textarea is deliberately NOT implemented (plain textarea can't host caret overlays)
- **Editor writes**: always go through `setEditorText()` in `text-sync.js` so the caret is mapped across the diff; never assign `textarea.value` while an IME composition is active (see below)
- **FTS5 search**: `pad_search` virtual table (trigram) + insert/delete triggers only — the per-update trigger was removed in favour of a **throttled per-pad sync** (`FTS_SYNC_DEBOUNCE_MS`, default 1200ms; batched flush in `db/pads.ts`, boot-time `reconcileSearchIndex()`, shutdown `flushSearchSyncNow()`). The pads row itself is written synchronously on every edit — do not "optimize" this into a write debounce (tests SIGKILL the server; only the index may lag). Search may trail edits by up to the debounce window; `/api/search` with access filtering + unlock gating; snippet delimiters are private-use `U+E000`/`U+E001` (client escapes then restores `<mark>`) — never raw HTML from FTS
- **File conversion**: in-worker with configurable heap (`CONVERT_WORKER_HEAP_MB`, default 512MB) and concurrency (`CONVERT_MAX_CONCURRENT`, default 3), 60s timeout; default **100MB** (`CONVERT_MAX_BYTES`). Peak memory = concurrency × worker heap, and the file being converted is briefly held **twice** (main process + the structured-clone copy handed to the worker). This total must fit inside the container memory limit. **Archive guard is two-layer** (`assertSafeArchive` in `convert-worker.js`): declared-size pre-flight + streaming decompression verification (zlib pipe, cumulative cap, chunks discarded) — `CONVERT_MAX_BYTES` is injected via `workerData.maxBytes`, so both layers move with the config. The read-excel-file grandchild worker is unreachable — never assume `resourceLimits` bounds it; the archive guard does
- **Conversion semantics benchmark** — `convert-worker.js` is hand-written (mammoth / pdf-parse / read-excel-file / turndown), and its per-format behaviour is benchmarked against **microsoft/markitdown** (the project briefly used `markitdown-ts`, removed in 46bfced). When markitdown ships fixes, port the RELEVANT ones to the worker (behavior + worker tests mirroring the upstream assertions), and record the per-item verdict in CHANGELOG. Do NOT re-add a markitdown dependency — the npm TS port is stale; the reference is the Python repo. `npm outdated` guards the converter's own libraries
- **Aggregate storage quotas**: `MAX_STORAGE_BYTES` (instance) / `MAX_STORAGE_BYTES_PER_USER` (account) are checked **before** the upload rename (`fail()` cleans the `.part`); a rejected upload must leave nothing on disk
- **Health probes**: `/api/health` is **liveness only — it must never touch the database** (Docker restarts the container after repeated failures, so a busy SQLite checkpoint must not kill a healthy process). `/api/health/ready` is readiness: it queries SQLite and returns `pads` / `files`, 503 if the DB is unreachable
- **Container limits**: `docker-compose.yml` must use service-level `mem_limit` / `cpus`. `deploy.resources.limits` is only honoured in Swarm mode or with `--compatibility` — on a single self-hosted box it silently does nothing
- **Logging**: production logs are JSON (pino) with `cookie` / `authorization` / `x-pad-token` / `password` / `token` / `passphrase` / `adminToken` redacted via `redact`. Pad unlock tokens are long-lived bearer credentials — never let them reach the log stream
- **File lifecycle**: TTL cleanup deletes files past `FILE_TTL_HOURS` **only when no pad body references them** (`files/<id>` substring — deleting a referenced attachment leaves a broken image/link). All unlink/write paths are `fs.promises`; uploads stream to a `.part` sibling and `rename` into place, so never write uploads directly to their final name
- **WAL + busy_timeout=5000 + synchronous=NORMAL**: SQLite concurrency/durability hardening. NORMAL is deliberate — every keystroke commits, and FULL would fsync the WAL per keystroke; NORMAL trades at-most "lose the last commits on power loss" (never corruption). Keep it unless you can quantify the cost of reverting
- **Shutdown order**: SIGTERM/SIGINT drain first (flush FTS → `safeClose` all WS → `server.close()` + `closeIdleConnections()`), and SQLite closes **only** inside the drain callback (`store.flushSync()` calls `sqlite.close()` and nulls the handle — closing it before the drain turns every in-flight request into a 500). `unhandledRejection` is logged and survived; `uncaughtException` drains and exits non-zero. Async side tasks (TTL sweep etc.) must `.catch` at the timer, not rely on the net
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
- Do NOT modify the `state` shape outside `public/js/core.js` — other modules assign values only through core.js setters (`setWriteAccess`, `setAdminToken`, `setPatchQueue`, ...)
- Do NOT call `ws.close()` directly anywhere in the server — route every close through `safeClose()` (`src/ws/close.ts`); a long reason throws a synchronous RangeError and kills the process
- Do NOT add a write endpoint without the `requireWriteAccess` gate — 11 HTTP + 1 WS = 12 write paths are locked in gated mode
- Do NOT commit secrets, `.env` files, or API keys

## Environment Variables

See `.env.example`. Key vars:
- `SESSION_SECRET` — required in production (HMAC signing key)
- `PUBLIC_ORIGIN` — CSRF origin check (falls back to localhost/LAN)
- `ADMIN_TOKEN` — global pad management
- `DATA_DIR` — data directory path (default: `./data`)
- `PORT` — server port (default: 8000)
- `WRITE_ACCESS_MODE` — `open` (default) / `gated`; gated = read-only without a grant
- `WRITE_PASSPHRASES` — comma-separated `<phrase>[:<days>]` redeemable for a 7-day (default) grant
- `WRITE_GRANT_TTL_DAYS` / `WRITE_GRANT_RENEW_THRESHOLD_DAYS` — grant TTL & sliding-renewal threshold (defaults 7 / 5)
- `WS_ALLOW_NO_ORIGIN` — `true` admits WS clients that send no Origin header (non-browser/scripted clients); server fails closed otherwise
- `MAX_STORAGE_BYTES` / `MAX_STORAGE_BYTES_PER_USER` — aggregate storage quotas (defaults 2GB / 512MB)
- `FILE_TTL_HOURS` — file TTL (default 72); referenced files never expire
- `FTS_SYNC_DEBOUNCE_MS` — FTS index per-pad throttle (default 1200)
- `CONVERT_MAX_BYTES` — max file size for Markdown conversion (default: 100MB); also caps archive decompression
- `CONVERT_TIMEOUT_MS` — conversion timeout (default: 60000)
- `CONVERT_MAX_CONCURRENT` / `CONVERT_WORKER_HEAP_MB` — conversion concurrency & per-worker heap (defaults 3 / 512). Raise concurrency only after raising the container `mem_limit` by the same multiple of the heap
- `TRUST_PROXY_HOPS` — proxy hops trusted for `X-Forwarded-For` (default 0). **Set to 1 behind Caddy/Nginx**: at 0 every request looks like it comes from the proxy, collapsing the HTTP rate limiter and per-IP WebSocket cap into one shared bucket. Parsed once in `config.ts`; do not read `process.env` directly in `app.ts`
- `LOG_LEVEL` — pino level (default `info`)
- `MAX_WS_CONNECTIONS` / `MAX_WS_CONNECTIONS_PER_IP` / `WS_PATCH_WINDOW_MS` / `MAX_WS_PATCHES_PER_WINDOW` — WebSocket limits (defaults 1000 / 10 / 60000 / 120)

## Definition of Done

A change is complete when:
1. All code changes are saved to files
2. `npm run typecheck` passes (0 errors)
3. `npm test` passes with exit code 0 (111/111)
4. `npm run lint` passes with no new warnings
5. If security-related: verify CSRF, auth, CSP, and unlock-token header-only behavior
6. If frontend: verify in browser at relevant breakpoints (desktop + mobile)
7. If public API: document in README.md and CHANGELOG.md
