# CLAUDE.md — Project Instructions

## Project Overview

LAN real-time collaborative notepad with file sharing. No registration required — users get auto-assigned codes. Supports multi-pad tabs, WebSocket text sync, drag-and-drop file upload, file-to-Markdown conversion, password protection, invitation-based access control, and QR code mobile pairing.

## Tech Stack

- **Runtime**: Node.js >= 18
- **Backend**: Express 5, ws (WebSocket), Busboy (multipart upload)
- **Frontend**: Vanilla HTML/CSS/JS (zero framework)
- **Conversion**: Worker thread per request — mammoth (DOCX), pdf-parse, read-excel-file, AdmZip (PPTX), Turndown (HTML→Markdown)
- **Security**: helmet, express-rate-limit, HMAC-SHA256 cookies, timing-safe comparisons
- **Storage**: JSON file (`data/store.json`) with 200ms debounced atomic writes
- **Deployment**: Direct `node server.js` or multi-stage Docker (node:20-alpine, non-root)

## Project Structure

```
server.js            — Express app, WebSocket, auth, all API routes (~1725 lines)
convert-worker.js    — Worker thread: file → Markdown conversion (~606 lines)
public/app.js        — Frontend: UI, WebSocket client, file upload (~1516 lines)
public/index.html    — Single-page HTML
public/style.css     — All styles (Apple design, dark/light theme, mobile)
tests/
  smoke.test.js      — Integration tests: API, WebSocket, auth, access control
  identity.test.js   — Auth system, invitation lifecycle, pad permissions
  convert.test.js    — Worker conversion: MIME sniff, HTML security, PPTX, images
data/                — Runtime data (store.json, files/, converted/)
```

## Commands

```bash
npm start            # Start server (default port 8000)
npm test             # Run all tests (node --test)
PORT=3000 npm start  # Custom port
```

## Code Conventions

- **No framework** on frontend — use vanilla DOM APIs, `$()` shorthand for querySelector
- **Server routes** are defined inline in server.js (no router files)
- **Worker threads** for CPU-intensive conversion (never block main loop)
- **Atomic writes**: writeStoreAtomic() uses tmp+rename pattern; saveStore() debounces, flushStore() is immediate
- **Error handling**: try/catch with console.error; API returns `{ error: string }`
- **Security headers**: helmet with relaxed CSP (inline SVG favicon needs unsafe-inline style)
- **Naming**: camelCase for functions/vars, PascalCase for constructors, UPPER_SNAKE for constants

## Testing

- Test framework: **Node.js built-in** (`node:test` + `node:assert/strict`), NOT jest
- Tests spawn real server subprocesses on random ports with temp data dirs
- All tests must pass before committing: `npm test` → 66 tests
- Worker tests use actual Worker threads with real file buffers

## Key Architecture Decisions

- **Session tokens**: HMAC-SHA256 in httpOnly cookies (userId.timestamp.signature)
- **CSRF**: Origin header validation with private IP bypass for LAN clients
- **Pad access**: 3-tier — public (ownerUserId=null), private (owner+invited), legacy (admin-only management)
- **WebSocket**: per-pad rooms, heartbeat every 30s, per-IP connection limit (10)
- **File conversion**: in-worker with 512MB heap limit, 60s timeout, max 3 concurrent
- **Store migration**: migrateStore() handles old single-pad → multi-pad format

## Environment Variables

See `.env.example`. Key vars:
- `SESSION_SECRET` — required in production
- `PUBLIC_ORIGIN` — CSRF origin check (falls back to localhost/LAN)
- `ADMIN_TOKEN` — global pad management
- `DATA_DIR` — data directory path (default: `./data`)

## Things to Be Careful About

- `store` is a global mutable object — all mutations go through saveStore()/flushStore()
- `userCodes` Set must stay in sync with `store.users` (updated on register + loadStore)
- WebSocket `padClients` Map uses Set per padId — always use addClient/removeClient helpers
- Upload handler has complex state machine (busboy events) — be careful with finished/aborted guards
- `convert-worker.js` runs in isolated thread — no access to main process globals
- Frontend `allFiles` is a local cache — server `/api/state` is the source of truth
