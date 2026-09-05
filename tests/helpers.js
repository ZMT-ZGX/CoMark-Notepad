'use strict';

// Shared integration-test harness.
//
// Extracted from the five integration test files, which had been copy-pasting
// the same spawn/stop/Origin-injection block — each even admitted in its own
// comments that it "mirrors helpers in the other test files". Only the
// verbatim-identical shapes live here; helpers that diverge meaningfully
// (bootstrap variants, WS client wrappers, smoke's per-init Origin injection)
// stay in their files.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PROJECT_DIR = path.resolve(__dirname, '..');

let pristineFetch = null;

/**
 * Wrap globalThis.fetch to auto-inject Origin on state-changing methods.
 * Without it, POST/PUT/DELETE/PATCH requests carry no Origin header and the
 * CSRF check (checkOrigin) rejects them with 403 before any handler under
 * test is reached. Call once at module load, like the old per-file wrappers.
 * Returns the pristine fetch (see getPristineFetch).
 *
 * smoke.test.js deliberately does NOT install this: it injects Origin per
 * request instead, and some of its cases assert the rejection of requests
 * that legitimately carry no Origin header.
 */
function installOriginFetch() {
  const orig = pristineFetch || globalThis.fetch;
  pristineFetch = orig;
  globalThis.fetch = async (input, init) => {
    const method = (init?.method || 'GET').toUpperCase();
    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      const url = typeof input === 'string' ? input : input.toString();
      const headers = { ...(init?.headers || {}) };
      if (!headers.Origin && !headers.origin) {
        try {
          headers.Origin = new URL(url).origin;
        } catch {}
      }
      init = { ...init, headers };
    }
    return orig(input, init);
  };
  return orig;
}

/**
 * The fetch that was installed BEFORE the Origin wrapper — for the few tests
 * that must send a request genuinely lacking an Origin header and assert the
 * 403 CSRF rejection.
 */
function getPristineFetch() {
  return pristineFetch || globalThis.fetch;
}

/**
 * Spawn a real server subprocess (tsx, TypeScript) on a random port with a
 * temp DATA_DIR. Resolves once the boot log reports the port; rejects on
 * early exit or after `timeoutMs`.
 *
 * WS_ALLOW_NO_ORIGIN=true opts into the no-Origin escape hatch in
 * src/config.ts: the harnesses are scripted (non-browser) WS clients that do
 * not send an Origin header on the WebSocket handshake, and the server now
 * fails closed for such clients.
 */
function spawnServer(extraEnv = {}, { label = 'notepad', timeoutMs = 5000 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `comark-${label}-`));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/server.ts'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir, WS_ALLOW_NO_ORIGIN: 'true', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`Timed out starting server.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = stdout.match(/Local:\s+http:\/\/localhost:(\d+)/);
      if (!match || settled) return;

      settled = true;
      clearTimeout(timeout);
      resolve({
        child,
        dataDir,
        port: Number(match[1]),
        baseUrl: `http://127.0.0.1:${match[1]}`,
        wsUrl: `ws://127.0.0.1:${match[1]}`,
      });
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Server exited early with code ${code} signal ${signal}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  });
}

/**
 * SIGINT the child (SIGKILL fallback after 1s), then remove the temp data
 * dir. Safe to call on an already-exited child.
 */
async function stopServer(server) {
  const { child, dataDir } = server;

  await new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 1000);

    child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });

    child.kill('SIGINT');
  });

  fs.rmSync(dataDir, { recursive: true, force: true });
}

module.exports = { PROJECT_DIR, installOriginFetch, getPristineFetch, spawnServer, stopServer };
