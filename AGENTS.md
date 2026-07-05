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
│   │   ├── files.js              # File list
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
├── tests/                        # 68 integration tests
│   ├── identity.test.js          # Auth & access control
│   ├── smoke.test.js             # Core API, WebSocket
│   ├── convert.test.js           # Worker conversion
│   └── e2e/                      # Playwright E2E
├── Dockerfile                    # Multi-stage (node:20-alpine, non-root)
├── docker-compose.yml
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
npm test                          # node --test (68 tests)
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
- **WebSocket**: per-pad rooms, 30s ping/pong heartbeat, per-IP connection limit (10)
- **Patch sync**: `diff-match-patch` over WS; `state.lastSyncedText` as diff base; pad-scoped offline queue in localStorage
- **File conversion**: in-worker with 512MB heap limit, 60s timeout, max 3 concurrent
- **FTS5 search**: `pad_search` virtual table (trigram) + 3 triggers; `/api/search` endpoint with access filtering
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
- Do NOT add offline queue entries with a global key — namespace by `padId`
- Do NOT modify `state` object outside `public/js/core.js` modules
- Do NOT commit secrets, `.env` files, or API keys

## Environment Variables

See `.env.example`. Key vars:
- `SESSION_SECRET` — required in production (HMAC signing key)
- `PUBLIC_ORIGIN` — CSRF origin check (falls back to localhost/LAN)
- `ADMIN_TOKEN` — global pad management
- `DATA_DIR` — data directory path (default: `./data`)
- `PORT` — server port (default: 8000)

## Definition of Done

A change is complete when:
1. All code changes are saved to files
2. `npm run typecheck` passes (0 errors)
3. `npm test` passes with exit code 0 (68/68)
4. `npm run lint` passes with no new warnings
5. If security-related: verify CSRF, auth, and CSP behavior
6. If frontend: verify in browser at relevant breakpoints (desktop + mobile)
7. If public API: document in README.md and CHANGELOG.md
