# AGENTS.md

## Repository Layout

```
server.js            — Express 5 backend, WebSocket, auth, all API routes (~1725 lines)
convert-worker.js    — Worker thread: file → Markdown conversion (~606 lines)
public/app.js        — Frontend: vanilla JS, UI, WebSocket client (~1516 lines)
public/index.html    — Single-page HTML (~201 lines)
public/style.css     — Apple design, dark/light theme, mobile (~1449 lines)
tests/               — Integration tests (Node.js built-in test runner)
  smoke.test.js        Core: API, WebSocket, auth, access control
  identity.test.js     Auth system, invitation lifecycle, pad permissions
  convert.test.js      Worker: MIME sniff, HTML security, PPTX, images
data/                — Runtime data (store.json, files/, converted/)
.env.example         — Environment variable template
Dockerfile           — Multi-stage build (node:20-alpine, non-root)
docker-compose.yml   — Container orchestration
```

## How to Run

```bash
npm start            # Start server on port 8000
PORT=3000 npm start  # Custom port
docker compose up -d # Container deployment
```

No build step required — pure Node.js, no transpilation.

## Build, Test & Lint

```bash
npm test             # Run all 66 tests (node --test tests/*.test.js)
```

- Test framework: **Node.js built-in** (`node:test` + `node:assert/strict`), NOT jest
- Tests spawn real server subprocesses on random ports with temp data dirs
- Worker tests use actual Worker threads with real file buffers
- All tests must pass (exit 0) before any change is considered complete

## Code Style & Conventions

- **No frontend framework** — vanilla DOM APIs, `$()` shorthand for `querySelector`
- **Server routes** defined inline in `server.js` (no separate router files)
- **Worker threads** for CPU-intensive conversion (never block main loop)
- **Atomic writes**: `writeStoreAtomic()` uses tmp+rename; `saveStore()` debounces, `flushStore()` is immediate
- **Error handling**: `try/catch` with `console.error`; API returns `{ error: string }`
- **Naming**: camelCase for functions/vars, PascalCase for constructors, UPPER_SNAKE for constants
- **Security headers**: helmet with relaxed CSP (inline SVG favicon needs `unsafe-inline` style)

## Architecture Notes

- **Session tokens**: HMAC-SHA256 in httpOnly cookies (`userId.timestamp.signature`)
- **CSRF**: Origin header validation with private IP bypass for LAN clients
- **Pad access**: 3-tier — public (`ownerUserId=null`), private (owner+invited), legacy (admin-only)
- **WebSocket**: per-pad rooms, heartbeat every 30s, per-IP connection limit (10)
- **File conversion**: in-worker with 512MB heap limit, 60s timeout, max 3 concurrent
- **Store migration**: `migrateStore()` handles old single-pad → multi-pad format
- **User lookup**: `userCodes` Set mirrors `store.users[].code` for O(1) auth checks

## Constraints — Do NOT

- Do NOT use `jest` — this project uses `node --test`
- Do NOT add a frontend framework (React, Vue, etc.) — vanilla JS only
- Do NOT split server routes into separate files — keep inline in `server.js`
- Do NOT call `saveStore()` inside loops — use `flushStore()` for batch operations
- Do NOT access `store` directly for mutations — always go through `saveStore()`/`flushStore()`
- Do NOT modify `userCodes` Set outside of `register` endpoint and `loadStore`
- Do NOT touch WebSocket `padClients` Map directly — use `addClient()`/`removeClient()` helpers
- Do NOT run conversion on the main thread — always delegate to worker
- Do NOT commit secrets, `.env` files, or API keys

## Environment Variables

See `.env.example`. Key vars:
- `SESSION_SECRET` — required in production (HMAC signing key)
- `PUBLIC_ORIGIN` — CSRF origin check (falls back to localhost/LAN)
- `ADMIN_TOKEN` — global pad management
- `DATA_DIR` — data directory path (default: `./data`)

## Definition of Done

A change is complete when:
1. All code changes are saved to files
2. `npm test` passes with exit code 0 (66/66 tests)
3. No new lint warnings introduced
4. If security-related: verify CSRF, auth, and CSP behavior
5. If frontend: verify in browser at relevant breakpoints (desktop + mobile)
