const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const DiffMatchPatch = require('diff-match-patch');

const { PROJECT_DIR, spawnServer, stopServer } = require('./helpers');

// NOTE: smoke does not install the helpers' global fetch Origin wrapper — it
// injects Origin per request via fetchJson, and some cases below assert the
// rejection of requests that legitimately carry no Origin header.

/**
 * A fresh install intentionally starts with zero pads — the legacy always-seeded
 * Pad #1 was public (owner NULL) and therefore readable by anyone who could
 * register, which is wrong for a public deployment.
 *
 * Most tests below exercise the legacy single-pad topology, so they opt into
 * creating one. Creating it as an anonymous user yields ownerUserId = null,
 * i.e. a public pad with id 1 — exactly the old default.
 */
async function ensurePublicPad(server, extraEnv = {}) {
  const { response, body } = await fetchJson(server.baseUrl, '/api/pads', {
    method: 'POST',
    headers: { Origin: extraEnv.PUBLIC_ORIGIN || server.baseUrl },
  });
  if (response.status !== 200) {
    throw new Error(`bootstrap pad failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return body.id;
}

function startServer(extraEnv = {}, { bootstrap = true } = {}) {
  return spawnServer(extraEnv).then(async (server) => {
    if (!bootstrap) return server;
    try {
      await ensurePublicPad(server, extraEnv);
    } catch (e) {
      // Never leak the spawned server: node --test waits for the event loop to
      // drain, so an orphaned child hangs the entire run.
      await stopServer(server);
      throw e;
    }
    return server;
  });
}

async function fetchJson(baseUrl, pathname, init) {
  // Auto-inject Origin header for state-changing methods if not already set
  if (init && init.method && init.method !== 'GET' && init.method !== 'HEAD') {
    const headers = init.headers || {};
    if (!headers.Origin && !headers.origin) {
      init.headers = { ...headers, Origin: baseUrl };
    }
  }
  const response = await fetch(`${baseUrl}${pathname}`, init);
  const body = await response.json();
  return { response, body };
}

function createClient(wsUrl, padId = 1) {
  const url = padId ? `${wsUrl}/?pad=${padId}` : wsUrl;
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const messages = [];

    socket.on('message', (raw) => {
      messages.push(JSON.parse(String(raw)));
    });

    socket.once('open', () => {
      resolve({
        socket,
        messages,
        wsId: null,
        padId,
        drain() {
          messages.length = 0;
        },
      });
    });

    socket.once('error', reject);
  });
}

async function waitForMessage(client, predicate, timeout = 1500) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const index = client.messages.findIndex(predicate);
    if (index >= 0) {
      const [message] = client.messages.splice(index, 1);
      if (message.type === 'hello') client.wsId = message.wsId;
      return message;
    }
    await delay(10);
  }
  throw new Error('Timed out waiting for message');
}

async function expectNoMessage(client, predicate, timeout = 300) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (client.messages.some(predicate)) {
      throw new Error('Received unexpected message');
    }
    await delay(10);
  }
}

async function closeClient(client) {
  await new Promise((resolve) => {
    if (client.socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    client.socket.once('close', resolve);
    client.socket.close();
  });
}

async function createReadyClient(wsUrl, padId = 1) {
  const client = await createClient(wsUrl, padId);
  await waitForMessage(client, (msg) => msg.type === 'hello');
  return client;
}

test('fresh install starts with zero pads (no public Pad #1)', async () => {
  const server = await startServer({}, { bootstrap: false });
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/state');
    assert.equal(response.status, 200);
    assert.deepEqual(body.pads, []);
    assert.deepEqual(body.files, []);
  } finally {
    await stopServer(server);
  }
});

test('pad created by an authenticated user is owned by that user', async () => {
  const server = await startServer({}, { bootstrap: false });
  try {
    // Register to obtain a session cookie for this request.
    const registerRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = registerRes.headers.get('set-cookie').split(';')[0];
    const { response, body } = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.ok(body.ownerUserId, 'owned pad should carry the creator user code');
  } finally {
    await stopServer(server);
  }
});

test('pad created without a session stays public (ownerUserId null)', async () => {
  const server = await startServer({}, { bootstrap: false });
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });
    assert.equal(response.status, 200);
    assert.equal(body.ownerUserId, null);
  } finally {
    await stopServer(server);
  }
});

test('health endpoints expose liveness and readiness', async () => {
  const server = await startServer();
  try {
    // Liveness: the process is up. Intentionally does NOT touch the database —
    // Docker restarts the container after repeated failures, so a healthy
    // process blocked on a SQLite checkpoint must not be killed for it.
    const liveness = await fetchJson(server.baseUrl, '/api/health');
    assert.equal(liveness.response.status, 200);
    assert.equal(liveness.body.status, 'ok');
    assert.equal(typeof liveness.body.uptime, 'number');

    // Readiness: the database is reachable and serving. Counts moved here from
    // /api/health because they require a query.
    const readiness = await fetchJson(server.baseUrl, '/api/health/ready');
    assert.equal(readiness.response.status, 200);
    assert.equal(readiness.body.status, 'ok');
    assert.equal(readiness.body.pads, 1);
    assert.equal(readiness.body.files, 0);
  } finally {
    await stopServer(server);
  }
});

test('online count is per-pad', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    await waitForMessage(a, (msg) => msg.type === 'online-count' && msg.count === 1);

    const b = await createReadyClient(server.wsUrl, 1);
    await waitForMessage(a, (msg) => msg.type === 'online-count' && msg.count === 2);
    await waitForMessage(b, (msg) => msg.type === 'online-count' && msg.count === 2);

    // Create pad 2 before connecting to it (WebSocket rejects non-existent pads)
    await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });

    // Client on pad 2 should NOT affect pad 1's count
    const c = await createReadyClient(server.wsUrl, 2);
    await waitForMessage(c, (msg) => msg.type === 'online-count' && msg.count === 1);
    await expectNoMessage(a, (msg) => msg.type === 'online-count' && msg.count === 3);

    await closeClient(b);
    await closeClient(c);
    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('text updates are scoped to the same pad', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    const b = await createReadyClient(server.wsUrl, 1);

    // Create pad 2 before connecting to it (WebSocket rejects non-existent pads)
    await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });
    const c = await createReadyClient(server.wsUrl, 2);

    a.drain();
    b.drain();
    c.drain();

    const { response, body } = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'pad 1 test', _wsId: a.wsId, baseVersion: 0 }),
    });

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.textVersion, 1);

    // Client b (same pad) should receive the update
    const update = await waitForMessage(b, (msg) => msg.type === 'text-update');
    assert.equal(update.text, 'pad 1 test');
    assert.equal(update.padId, 1);

    // Client a (sender) should NOT receive it
    await expectNoMessage(a, (msg) => msg.type === 'text-update');

    // Client c (different pad) should NOT receive it
    await expectNoMessage(c, (msg) => msg.type === 'text-update');

    await closeClient(a);
    await closeClient(b);
    await closeClient(c);
  } finally {
    await stopServer(server);
  }
});

test('create new pad and switch to it', async () => {
  const server = await startServer();
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
    });
    assert.equal(response.status, 200);
    assert.equal(body.id, 2);
    assert.equal(body.text, '');

    const state = await fetchJson(server.baseUrl, '/api/state');
    assert.equal(state.body.pads.length, 2);
    assert.equal(state.body.pads[1].id, 2);
  } finally {
    await stopServer(server);
  }
});

test('pad password protection', async () => {
  const server = await startServer({ ADMIN_TOKEN: 'admin123' });
  try {
    // Admin sets password on pad 1
    const setPassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(setPassword.response.status, 200);
    assert.equal(setPassword.body.hasPassword, true);
    assert.ok(setPassword.body.token);

    const token = setPassword.body.token;

    // GET pad without token should fail
    const locked = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(locked.response.status, 403);
    assert.equal(locked.body.hasPassword, true);

    // GET pad with token should succeed
    const unlocked = await fetchJson(server.baseUrl, '/api/pads/1', {
      headers: { 'X-Pad-Token': token },
    });
    assert.equal(unlocked.response.status, 200);

    // Wrong password unlock should fail
    const wrongUnlock = await fetchJson(server.baseUrl, '/api/pads/1/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(wrongUnlock.response.status, 403);

    // Correct password unlock should succeed
    const correctUnlock = await fetchJson(server.baseUrl, '/api/pads/1/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(correctUnlock.response.status, 200);
    assert.ok(correctUnlock.body.token);

    // Remove password (admin with unlock token)
    const removePassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        'X-Pad-Token': correctUnlock.body.token,
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: null }),
    });
    assert.equal(removePassword.response.status, 200);
    assert.equal(removePassword.body.hasPassword, false);

    // Now GET without token should work
    const openPad = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(openPad.response.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('locked pad content is not exposed through search without an unlock token', async () => {
  // FTS_SYNC_DEBOUNCE_MS is cut to 20ms because the FTS refresh is throttled:
  // the search below must see the freshly-seeded body without waiting a full
  // second, while still exercising the real (async) sync path.
  const server = await startServer({ ADMIN_TOKEN: 'admin123', FTS_SYNC_DEBOUNCE_MS: '20' });
  try {
    // Admin sets a password on the public pad 1 and receives an unlock token.
    const setPassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': 'admin123', Origin: server.baseUrl },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(setPassword.response.status, 200);
    const token = setPassword.body.token;

    // Seed unique, searchable content (the PUT also needs the unlock token).
    const unique = 'comarklockedsearchterm';
    const putRes = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Pad-Token': token, Origin: server.baseUrl },
      body: JSON.stringify({ text: `secret note ${unique}`, baseVersion: 0 }),
    });
    assert.equal(putRes.response.status, 200);

    // Wait out the (shortened) FTS sync debounce so the search below sees
    // the freshly-seeded body.
    await delay(200);

    // Search WITHOUT an unlock token must not leak the locked pad's content.
    const lockedSearch = await fetchJson(server.baseUrl, `/api/search?q=${unique}`, {
      headers: { Origin: server.baseUrl },
    });
    assert.equal(lockedSearch.response.status, 200);
    const leaked = (lockedSearch.body.results || []).some((r) => String(r.content).includes(unique));
    assert.equal(leaked, false, 'locked pad content must not appear in search without unlock token');

    // Search WITH a valid unlock token should return the content.
    const unlockedSearch = await fetchJson(server.baseUrl, `/api/search?q=${unique}`, {
      headers: { 'X-Pad-Token': token, Origin: server.baseUrl },
    });
    assert.equal(unlockedSearch.response.status, 200);
    const found = (unlockedSearch.body.results || []).some((r) => String(r.content).includes(unique));
    assert.equal(found, true, 'locked pad content should appear in search when unlocked');
  } finally {
    await stopServer(server);
  }
});

test('file updates broadcast to same pad only', async () => {
  const server = await startServer();
  try {
    // Register a user so uploaded files have an owner (deletion requires auth)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const a = await createReadyClient(server.wsUrl, 1);

    // Create pad 2 before connecting to it (WebSocket rejects non-existent pads).
    // Keep pad 2 public (no cookie) so the anonymous client b can join it.
    const pad2 = await fetchJson(server.baseUrl, '/api/pads', { method: 'POST' });
    assert.equal(pad2.response.status, 200);
    assert.equal(pad2.body.id, 2);
    const b = await createReadyClient(server.wsUrl, 2);

    a.drain();
    b.drain();

    const formData = new FormData();
    formData.append('_wsId', a.wsId);
    formData.append('padId', '1');
    formData.append('file', new Blob(['sample upload\n'], { type: 'text/plain' }), 'sample.txt');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });

    assert.equal(upload.response.status, 200);
    assert.equal(upload.body.originalName, 'sample.txt');

    // Client b (different pad) should NOT receive file-added (files are now pad-scoped)
    await expectNoMessage(b, (msg) => msg.type === 'file-added');
    // Client a (sender) should NOT receive it either (sender excluded)
    await expectNoMessage(a, (msg) => msg.type === 'file-added');

    // Client on same pad should receive it
    const a2 = await createReadyClient(server.wsUrl, 1);
    a2.drain();

    const formData2 = new FormData();
    formData2.append('_wsId', a.wsId);
    formData2.append('padId', '1');
    formData2.append('file', new Blob(['second file\n'], { type: 'text/plain' }), 'second.txt');
    const upload2 = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData2,
    });
    assert.equal(upload2.response.status, 200);

    // Client a2 (same pad, not sender) should receive file-added
    const fileAddedA2 = await waitForMessage(a2, (msg) => msg.type === 'file-added');
    assert.equal(fileAddedA2.file.id, upload2.body.id);

    // Delete the file
    const deleteResult = await fetchJson(server.baseUrl, `/api/files/${upload.body.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ _wsId: a.wsId }),
    });
    assert.equal(deleteResult.response.status, 200);

    // Client a2 (same pad) should receive file-deleted
    const fileDeletedA2 = await waitForMessage(a2, (msg) => msg.type === 'file-deleted');
    assert.equal(fileDeletedA2.fileId, upload.body.id);
    // Client b (different pad) should NOT receive delete broadcast
    await expectNoMessage(b, (msg) => msg.type === 'file-deleted');

    await closeClient(a);
    await closeClient(b);
    await closeClient(a2);
  } finally {
    await stopServer(server);
  }
});

test('clear all files', async () => {
  const server = await startServer();
  try {
    // Register a user and create a pad they are allowed to manage.
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');
    const padRes = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    assert.equal(padRes.response.status, 200);
    const padId = padRes.body.id;

    for (const name of ['a.txt', 'b.txt']) {
      const formData = new FormData();
      formData.append('padId', String(padId));
      formData.append('file', new Blob(['content\n'], { type: 'text/plain' }), name);
      await fetchJson(server.baseUrl, '/api/upload', { method: 'POST', body: formData, headers: { Cookie: cookie } });
    }

    const beforeState = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: cookie } });
    assert.equal(beforeState.body.files.length, 2);

    const clearResult = await fetchJson(server.baseUrl, '/api/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ padId }),
    });
    assert.equal(clearResult.response.status, 200);
    assert.equal(clearResult.body.cleared, 2);

    const afterState = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: cookie } });
    assert.equal(afterState.body.files.length, 0);

    const filesDir = path.join(server.dataDir, 'files');
    assert.deepEqual(fs.readdirSync(filesDir), []);
  } finally {
    await stopServer(server);
  }
});

test('upload preserves chinese filenames', async () => {
  const server = await startServer();
  try {
    const formData = new FormData();
    formData.append('file', new Blob(['hello\n'], { type: 'text/plain' }), '测试文档.txt');

    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      body: formData,
    });

    assert.equal(upload.response.status, 200);
    assert.equal(upload.body.originalName, '测试文档.txt');

    const download = await fetch(`${server.baseUrl}/api/files/${upload.body.id}`);
    assert.equal(download.status, 200);
    assert.match(
      download.headers.get('content-disposition') || '',
      /filename\*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E6%A1%A3\.txt/
    );
  } finally {
    await stopServer(server);
  }
});

test('convert file to markdown', async () => {
  const server = await startServer();
  try {
    // Register user
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    // Upload a CSV file
    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['name,age\nAlice,30\n'], { type: 'text/csv' }), 'data.csv');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    // Convert to markdown
    const convert = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 200);
    assert.equal(convert.body.mimeType, 'text/markdown');
    assert.match(convert.body.originalName, /\.md$/);

    // Verify .md file exists on disk
    const filesDir = path.join(server.dataDir, 'files');
    const mdFiles = fs.readdirSync(filesDir).filter(f => f.endsWith('.md'));
    assert.ok(mdFiles.length >= 1, 'Expected at least one .md file on disk');

    // Duplicate convert (original file was deleted after first conversion) → 404
    const dup = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(dup.response.status, 404);

    // Nonexistent fileId → 404
    const missing = await fetchJson(server.baseUrl, '/api/convert/nonexistent123', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(missing.response.status, 404);
  } finally {
    await stopServer(server);
  }
});

test('convert requires file access', async () => {
  const server = await startServer();
  try {
    // Register and upload a file with an owner (so it's not public)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['secret,data\n'], { type: 'text/csv' }), 'secret.csv');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    // Unauthenticated request (no cookie) → 403
    const convert = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('convert rejects .md source files', async () => {
  const server = await startServer();
  try {
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['# Hello\n'], { type: 'text/markdown' }), 'already.md');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);

    const convert = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 400);
    assert.match(convert.body.error, /Markdown/i);
  } finally {
    await stopServer(server);
  }
});

test('old single-pad store migrates to multi-pad', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comark-notepad-migrate-'));
  const storeFile = path.join(dataDir, 'store.json');
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  fs.writeFileSync(storeFile, JSON.stringify({
    text: 'old content',
    textVersion: 5,
    files: [],
  }));

  const child = spawn(process.execPath, [require.resolve('tsx/cli'), 'src/server.ts'], {
    cwd: PROJECT_DIR,
    env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    const { baseUrl } = await new Promise((resolve, reject) => {
      let stdout = '';
      const timeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Server start timeout'));
      }, 5000);

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = stdout.match(/Local:\s+http:\/\/localhost:(\d+)/);
        if (match) {
          clearTimeout(timeout);
          resolve({ baseUrl: `http://127.0.0.1:${match[1]}` });
        }
      });
    });

    const state = await fetchJson(baseUrl, '/api/state');
    assert.equal(state.body.pads.length, 1);
    assert.equal(state.body.pads[0].id, 1);

    const pad = await fetchJson(baseUrl, '/api/pads/1');
    assert.equal(pad.body.text, 'old content');
    assert.equal(pad.body.textVersion, 5);
  } finally {
    child.kill('SIGINT');
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 3000); // fallback if process doesn't exit
    });
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('invitation lifecycle', async () => {
  const server = await startServer();
  try {
    // Register two users
    const regA = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieA = regA.headers.get('set-cookie');
    const userA = await regA.json();

    const regB = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieB = regB.headers.get('set-cookie');
    const userB = await regB.json();

    // User A creates an invitation
    const create = await fetchJson(server.baseUrl, '/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ maxUses: 2, expiresInHours: 1 }),
    });
    assert.equal(create.response.status, 200);
    assert.ok(create.body.token);
    assert.equal(create.body.maxUses, 2);

    // User B redeems it
    const redeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(redeem.response.status, 200);
    assert.equal(redeem.body.grantorCode, userA.code);

    // Duplicate redeem → 409
    const dupRedeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(dupRedeem.response.status, 409);

    // Self-redeem → 400
    const selfRedeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(selfRedeem.response.status, 400);

    // List invitations
    const list = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieA },
    });
    assert.equal(list.response.status, 200);
    assert.equal(list.body.created.length, 1);
    assert.equal(list.body.created[0].token, create.body.token);

    // User B lists received grants
    const listB = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieB },
    });
    assert.equal(listB.response.status, 200);
    assert.equal(listB.body.received.length, 1);
    assert.equal(listB.body.received[0].grantorCode, userA.code);

    // Delete invitation
    const del = await fetchJson(server.baseUrl, `/api/invitations/${create.body.token}`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(del.response.status, 200);

    // Redeem after delete → 404
    const postDel = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(postDel.response.status, 404);
  } finally {
    await stopServer(server);
  }
});

test('requireOrigin rejects cross-origin write requests', async () => {
  const server = await startServer();
  try {
    // Authenticated user
    const reg = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = reg.headers.get('set-cookie');

    // PUT text with disallowed Origin
    const put = await fetch(`${server.baseUrl}/api/pads/1/text`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Cookie: cookie,
      },
      body: JSON.stringify({ text: 'bad' }),
    });
    assert.equal(put.status, 403);
    const putBody = await put.json();
    assert.equal(putBody.error, 'Invalid origin');

    // POST upload with disallowed Origin
    const formData = new FormData();
    formData.append('file', new Blob(['x'], { type: 'text/plain' }), 'x.txt');
    const upload = await fetch(`${server.baseUrl}/api/upload`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example.com', Cookie: cookie },
      body: formData,
    });
    assert.equal(upload.status, 403);
    const upBody = await upload.json();
    assert.equal(upBody.error, 'Invalid origin');

    // Same-origin (with matching Origin header) still works
    const ok = await fetch(`${server.baseUrl}/api/pads/1/text`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: server.baseUrl },
      body: JSON.stringify({ text: 'good', baseVersion: 0 }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('pad routes reject invalid pad IDs', async () => {
  const server = await startServer();
  try {
    const cases = [
      { path: '/api/pads/abc', method: 'GET', expected: 400 },
      { path: '/api/pads/0', method: 'GET', expected: 400 },
      { path: '/api/pads/-1', method: 'GET', expected: 400 },
      { path: '/api/pads/1.5', method: 'GET', expected: 400 },
      { path: '/api/pads/abc/text', method: 'PUT', expected: 400 },
      { path: '/api/pads/0/text', method: 'PUT', expected: 400 },
      { path: '/api/pads/abc/password', method: 'POST', expected: 400 },
      { path: '/api/pads/abc/unlock', method: 'POST', expected: 400 },
      { path: '/api/pads/abc', method: 'DELETE', expected: 400 },
    ];

    for (const { path, method, expected } of cases) {
      const init = { method, headers: { 'Content-Type': 'application/json' } };
      if (method === 'PUT' || method === 'POST') {
        init.body = JSON.stringify({ text: '', password: null });
      }
      const { response } = await fetchJson(server.baseUrl, path, init);
      assert.equal(response.status, expected, `${method} ${path} should return ${expected}, got ${response.status}`);
    }
  } finally {
    await stopServer(server);
  }
});

test('deleting invitation revokes associated access grants', async () => {
  const server = await startServer();
  try {
    // Register two users
    const regA = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieA = regA.headers.get('set-cookie');

    const regB = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookieB = regB.headers.get('set-cookie');

    // User A creates invitation
    const create = await fetchJson(server.baseUrl, '/api/invitations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieA },
      body: JSON.stringify({ maxUses: 5 }),
    });
    assert.equal(create.response.status, 200);

    // User B redeems it
    const redeem = await fetchJson(server.baseUrl, '/api/invitations/redeem', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieB },
      body: JSON.stringify({ token: create.body.token }),
    });
    assert.equal(redeem.response.status, 200);

    // Verify B has the grant
    const listBefore = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieB },
    });
    assert.equal(listBefore.body.received.length, 1);

    // User A deletes the invitation
    const del = await fetchJson(server.baseUrl, `/api/invitations/${create.body.token}`, {
      method: 'DELETE',
      headers: { Cookie: cookieA },
    });
    assert.equal(del.response.status, 200);
    assert.equal(del.body.revokedGrants, 1);

    // Verify B's grant is revoked
    const listAfter = await fetchJson(server.baseUrl, '/api/invitations', {
      headers: { Cookie: cookieB },
    });
    assert.equal(listAfter.body.received.length, 0);
  } finally {
    await stopServer(server);
  }
});

// --- Patch sync integration tests ---

function makePatch(oldText, newText) {
  const dmp = new DiffMatchPatch();
  const patches = dmp.patch_make(oldText, newText);
  return dmp.patch_toText(patches);
}

test('patch messages sync between clients on the same pad', async () => {
  const server = await startServer();
  try {
    // Seed initial text so both clients share a known shadow
    await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ text: 'Hello', baseVersion: 0 }),
    });

    const a = await createReadyClient(server.wsUrl, 1);
    const b = await createReadyClient(server.wsUrl, 1);
    a.drain(); b.drain();

    // Client A sends a valid patch: "Hello" → "Hello World"
    const patchText = makePatch('Hello', 'Hello World');
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: patchText, baseVersion: 1 }));

    // A should receive patch-ack. Diff-only: the server applied the patch
    // because A's base version matched, so echoing the body back would
    // serialize the whole document per keystroke for zero information.
    const ack = await waitForMessage(a, (msg) => msg.type === 'patch-ack', 1500);
    assert.ok(ack.textVersion > 0, 'patch-ack should carry a positive textVersion');
    assert.equal(ack.text, undefined, 'patch-ack must be diff-only (no authoritative body)');

    // B should receive the broadcast patch, also diff-only: the receiver
    // rebuilds the body by applying the diff to its own shadow.
    const remote = await waitForMessage(b, (msg) => msg.type === 'patch', 1500);
    assert.equal(remote.padId, 1);
    assert.equal(remote.data, patchText);
    assert.equal(remote.text, undefined, 'patch frame must be diff-only (no authoritative body)');
    const dmp = new DiffMatchPatch();
    const [rebuilt] = dmp.patch_apply(dmp.patch_fromText(remote.data), 'Hello');
    assert.equal(rebuilt, 'Hello World', 'receiver must rebuild the body from the diff alone');

    // Exactly ONE broadcast frame per edit. A second `text-update` snapshot
    // used to double the outbound body on every keystroke, and the client
    // dropped it regardless: the patch frame already advances its version to
    // the same value, so the snapshot failed the `version <= textVersion` guard.
    await delay(100);
    assert.equal(
      b.messages.filter((msg) => msg.type === 'patch' || msg.type === 'text-update').length,
      0,
      'each edit must produce a single broadcast frame, not a patch plus a duplicate snapshot'
    );

    // Server text should reflect the change
    const pad = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();
    assert.equal(pad.text, 'Hello World');

    await closeClient(a);
    await closeClient(b);
  } finally {
    await stopServer(server);
  }
});

test('malformed patch triggers patch-nack with server text', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    a.drain();

    // Send garbage that is not a valid patch
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: '@@@ invalid @@@', baseVersion: 0 }));

    // Server should respond with patch-nack (not patch-ack)
    const nack = await waitForMessage(a, (msg) => msg.type === 'patch-nack', 1500);
    assert.equal(nack.type, 'patch-nack');
    assert.equal(nack.padId, 1);
    assert.ok(typeof nack.text === 'string', 'nack should carry text');
    assert.ok(typeof nack.textVersion === 'number', 'nack should carry textVersion');

    // Verify nack text matches server state
    const pad = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();
    assert.equal(nack.text, pad.text);
    assert.equal(nack.textVersion, pad.textVersion);

    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('concurrent patches at the same position: exactly one wins, the stale one is nacked', async () => {
  const server = await startServer();
  try {
    // Seed text so both clients share the shadow "Hello".
    await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ text: 'Hello', baseVersion: 0 }),
    });

    const a = await createReadyClient(server.wsUrl, 1);
    const b = await createReadyClient(server.wsUrl, 1);
    a.drain(); b.drain();

    const base = (await (await fetch(`${server.baseUrl}/api/pads/1`)).json()).textVersion;

    // Both clients diffed from the same shadow, so both declare the same base.
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: makePatch('Hello', 'HelloAAA'), baseVersion: base }));
    b.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: makePatch('Hello', 'HelloBBB'), baseVersion: base }));

    const ackA = await waitForMessage(a, (msg) => msg.type === 'patch-ack' || msg.type === 'patch-nack', 1500);
    const ackB = await waitForMessage(b, (msg) => msg.type === 'patch-ack' || msg.type === 'patch-nack', 1500);

    // Once the first patch lands, the second one's base version is stale, so
    // it MUST be rejected instead of being applied on top of the winner.
    // "Both succeed" was only ever possible because the version check was
    // skipped when the client omitted baseVersion.
    assert.deepEqual(
      [ackA.type, ackB.type].sort(),
      ['patch-ack', 'patch-nack'],
      'exactly one of two patches sharing a base version must be applied'
    );

    // No corruption: the body is one coherent document, not an interleaving
    // of two diffs applied out of order.
    const pad = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();
    assert.ok(
      pad.text === 'HelloAAA' || pad.text === 'HelloBBB',
      `body must be exactly one of the two candidate edits, got: ${pad.text}`
    );

    await closeClient(a);
    await closeClient(b);
  } finally {
    await stopServer(server);
  }
});

test('patch-ack echoes the client-provided seq for reliable delivery', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    a.drain();

    // The client stamps each outgoing patch with a monotonic seq. The server
    // must echo it back in patch-ack so the client can match the ACK to the
    // exact in-flight patch and advance its confirmed shadow (and, on a drop
    // before ACK, re-queue only the unconfirmed edits). Without the echo the
    // client can't distinguish which patch was confirmed.
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: makePatch('', 'seq tracked edit'), seq: 7, baseVersion: 0 }));

    const ack = await waitForMessage(a, (msg) => msg.type === 'patch-ack', 1500);
    assert.equal(ack.seq, 7, 'patch-ack must echo the seq the client sent');
    assert.ok(ack.textVersion > 0, 'patch-ack should carry a positive textVersion');

    // Server text should reflect the applied patch.
    const pad = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();
    assert.equal(pad.text, 'seq tracked edit');

    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('WS patch rate limit closes connection with code 4001', async () => {
  // Override rate-limit config via env vars so the test doesn't need 120+ messages
  const server = await startServer({
    MAX_WS_PATCHES_PER_WINDOW: '5',
    WS_PATCH_WINDOW_MS: '60000',
  });
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    a.drain();

    // Send more patches than the per-window limit (5)
    for (let i = 0; i < 8; i++) {
      a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: makePatch('', `text${i}`), baseVersion: 0 }));
    }

    // Connection should be closed by server with code 4001
    const closeEvent = await new Promise((resolve) => {
      a.socket.once('close', (code, reason) => resolve({ code, reason: String(reason) }));
      // Fallback timeout — if no close within 3s, fail
      setTimeout(() => resolve({ code: -1, reason: 'timeout' }), 3000);
    });
    assert.equal(closeEvent.code, 4001, `Expected close code 4001, got ${closeEvent.code}`);

    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('unauthenticated connections to a locked pad count toward the per-IP limit', async () => {
  const server = await startServer({
    ADMIN_TOKEN: 'admin123',
    MAX_WS_CONNECTIONS_PER_IP: '3',
  });
  try {
    const setPassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-token': 'admin123',
        Origin: server.baseUrl,
      },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(setPassword.response.status, 200);
    assert.equal(setPassword.body.hasPassword, true);
    // Sanity check: the pad really is locked, otherwise every socket below
    // would finalize immediately and never test the pending path.
    const locked = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(locked.response.status, 403);

    // A password-protected pad holds each socket in a "pending" state until it
    // receives an `auth` message (up to 1.5s), so none of these reach
    // connections.add(). They must still be counted: otherwise a client can
    // stack an unlimited number of pending sockets and exhaust server memory
    // while neither the global nor the per-IP ceiling ever sees them.
    // Note the sockets are judged by whether the server closes them, not by
    // the client's `open` event: the client fires `open` as soon as the
    // handshake completes, which is before the server's close frame can
    // arrive. The 500ms window sits well inside the 1.5s auth timeout, so an
    // admitted socket is still open while a rejected one has already closed.
    const sockets = [];
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        new Promise((resolve) => {
          const socket = new WebSocket(`${server.wsUrl}/?pad=1`);
          sockets.push(socket);
          let settled = false;
          const done = (outcome) => {
            if (settled) return;
            settled = true;
            resolve(outcome);
          };
          socket.once('close', (code) => done(code));
          socket.once('error', () => done('error'));
          setTimeout(() => done('admitted'), 500);
        })
      )
    );

    assert.equal(
      results.filter((r) => r === 'admitted').length,
      3,
      `expected 3 pending sockets to be admitted, got ${JSON.stringify(results)}`
    );
    assert.equal(
      results.filter((r) => r === 1013).length,
      1,
      `expected the 4th socket to be rejected with 1013, got ${JSON.stringify(results)}`
    );

    for (const socket of sockets) {
      try {
        socket.close();
      } catch {}
    }
  } finally {
    await stopServer(server);
  }
});

test('stale patch (mismatched baseVersion) is rejected with patch-nack', async () => {
  const server = await startServer();
  try {
    await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ text: 'v1 body', baseVersion: 0 }),
    });

    const a = await createReadyClient(server.wsUrl, 1);
    a.drain();

    // The patch was diffed against a version the server has already moved
    // past — applying it would silently overwrite a concurrent edit, so the
    // server must reject it and hand back the authoritative body.
    const stalePatch = makePatch('v1 body', 'v1 body plus local edit');
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: stalePatch, baseVersion: 9999 }));

    const nack = await waitForMessage(a, (msg) => msg.type === 'patch-nack', 1500);
    assert.equal(nack.padId, 1);
    assert.equal(nack.text, 'v1 body', 'patch-nack must carry the authoritative body for resync');

    const pad = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();
    assert.equal(pad.text, 'v1 body', 'stale patch must not modify the pad');

    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('matching baseVersion patch is accepted and acked without body', async () => {
  const server = await startServer();
  try {
    await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ text: 'hello', baseVersion: 0 }),
    });
    const pad = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();

    const a = await createReadyClient(server.wsUrl, 1);
    a.drain();

    const patchText = makePatch('hello', 'hello world');
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: patchText, baseVersion: pad.textVersion }));

    const ack = await waitForMessage(a, (msg) => msg.type === 'patch-ack', 1500);
    assert.equal(ack.textVersion, pad.textVersion + 1);
    assert.equal(ack.seq, undefined, 'ack echoes seq only when the client sent one');

    const after = await (await fetch(`${server.baseUrl}/api/pads/1`)).json();
    assert.equal(after.text, 'hello world');

    await closeClient(a);
  } finally {
    await stopServer(server);
  }
});

test('presence frames are relayed to pad peers and removed on disconnect', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    const b = await createReadyClient(server.wsUrl, 1);
    a.drain();
    b.drain();

    // A announces itself; B must see the relay with A's socket id attached.
    a.socket.send(JSON.stringify({ type: 'presence', name: 'Alice', active: true }));
    const presence = await waitForMessage(
      b,
      (msg) => msg.type === 'presence' && msg.name === 'Alice',
      1500
    );
    assert.equal(presence.wsId, a.wsId, 'relayed presence must carry the sender socket id');
    assert.equal(presence.active, true);
    assert.ok(!presence.gone);

    // The sender must NOT see its own presence echoed back.
    await expectNoMessage(
      a,
      (msg) => msg.type === 'presence' && msg.name === 'Alice',
      300
    );

    // On disconnect the room is told the peer is gone.
    await closeClient(a);
    const gone = await waitForMessage(b, (msg) => msg.type === 'presence' && msg.gone, 1500);
    assert.equal(gone.wsId, a.wsId, 'the gone frame must identify the departed socket');

    await closeClient(b);
  } finally {
    await stopServer(server);
  }
});

test('FTS search reflects edits only after the sync debounce', async () => {
  const server = await startServer({ FTS_SYNC_DEBOUNCE_MS: '80' });
  try {
    // Seed through the JSON store migration so pad 1 exists with searchable
    // text, then edit it over the normal write path.
    await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ text: 'searchable zebra term', baseVersion: 0 }),
    });

    // Immediately after the write the throttled index has not caught up —
    // this is the accepted (documented) consistency window.
    const early = await fetchJson(server.baseUrl, '/api/search?q=zebra', {
      headers: { Origin: server.baseUrl },
    });
    assert.equal(early.response.status, 200);
    assert.equal(
      (early.body.results || []).length,
      0,
      'search must not see the edit before the FTS sync debounce fires'
    );

    // After the debounce the throttled sync must have refreshed the index.
    await delay(400);
    const later = await fetchJson(server.baseUrl, '/api/search?q=zebra', {
      headers: { Origin: server.baseUrl },
    });
    assert.equal(later.response.status, 200);
    assert.equal(
      (later.body.results || []).length > 0,
      true,
      'search must find the edit once the throttled FTS sync has run'
    );
  } finally {
    await stopServer(server);
  }
});

test('TTL cleanup deletes expired unreferenced files but keeps pad-referenced ones', async () => {
  const Database = require('better-sqlite3');
  const server = await startServer();
  const dataDir = server.dataDir;
  let fileA;
  let fileB;
  let server2 = null;
  try {
    // Two uploads to pad 1: A will be referenced from the pad body, B will
    // not. (Upload finalization streams to a .part file and renames — a
    // successful upload response already proves that path works.)
    const upload = async (name, content) => {
      const formData = new FormData();
      formData.append('padId', '1');
      formData.append('file', new Blob([content], { type: 'text/plain' }), name);
      const res = await fetchJson(server.baseUrl, '/api/upload', { method: 'POST', body: formData });
      assert.equal(res.response.status, 200);
      return res.body;
    };
    fileA = await upload('referenced.txt', 'referenced content\n');
    fileB = await upload('orphan.txt', 'orphan content\n');

    // Stop the server but keep its data dir so the test can age the file
    // rows directly: the TTL only expires files older than FILE_TTL_HOURS
    // and these uploads are brand new.
    await new Promise((resolve) => {
      if (server.child.exitCode !== null) return resolve();
      const killer = setTimeout(() => server.child.kill('SIGKILL'), 1000);
      server.child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      server.child.kill('SIGINT');
    });

    const db = new Database(path.join(dataDir, 'store.db'));
    const veryOld = Date.now() - 100 * 24 * 60 * 60 * 1000; // far past the 72h default TTL
    db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(veryOld, fileA.id);
    db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(veryOld, fileB.id);
    db.prepare('UPDATE pads SET text = ? WHERE id = 1').run(
      `see attachment: ![att](/api/files/${fileA.id})`
    );
    db.close();

    // Boot GC runs once on listen: it must delete the unreferenced expired
    // file and keep the one the pad body still links to.
    server2 = await startServer({ DATA_DIR: dataDir }, { bootstrap: false });
    const state = await fetchJson(server2.baseUrl, '/api/state');
    const ids = (state.body.files || []).map((f) => f.id);
    assert.ok(ids.includes(fileA.id), 'referenced file must survive TTL cleanup');
    assert.ok(!ids.includes(fileB.id), 'unreferenced expired file must be collected');

    assert.ok(
      fs.existsSync(path.join(dataDir, 'files', fileA.filename)),
      'referenced file must still exist on disk'
    );
    assert.ok(
      !fs.existsSync(path.join(dataDir, 'files', fileB.filename)),
      'collected file must be removed from disk (async unlink)'
    );
  } finally {
    if (server2) await stopServer(server2);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('file reference junction tracks runtime edits and drops edges on pad deletion', async () => {
  const Database = require('better-sqlite3');
  // ADMIN_TOKEN must be set explicitly: pad 2 is created anonymously, so only
  // an admin may delete it (no owner, no creator code).
  const server = await startServer({ FTS_SYNC_DEBOUNCE_MS: '100', ADMIN_TOKEN: 'admin123' });
  const dbPath = path.join(server.dataDir, 'store.db');
  let fileA;
  let fileB;
  let pad2Id = null;
  try {
    const upload = async (name, content) => {
      const formData = new FormData();
      formData.append('padId', '1');
      formData.append('file', new Blob([content], { type: 'text/plain' }), name);
      const res = await fetchJson(server.baseUrl, '/api/upload', { method: 'POST', body: formData });
      assert.equal(res.response.status, 200);
      return res.body;
    };
    fileA = await upload('junction-a.txt', 'a\n');
    fileB = await upload('junction-b.txt', 'b\n');

    // The junction rides the debounced derived-index flush, so read it
    // externally (readonly WAL connection) after the debounce window.
    const readRefs = (padId) => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return db
          .prepare('SELECT file_id FROM pad_file_refs WHERE pad_id = ? ORDER BY file_id')
          .all(padId)
          .map((r) => r.file_id);
      } finally {
        db.close();
      }
    };

    const putText = async (padId, text, baseVersion) => {
      const res = await fetchJson(server.baseUrl, `/api/pads/${padId}/text`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, baseVersion }),
      });
      assert.equal(res.response.status, 200, JSON.stringify(res.body));
      return res.body.textVersion;
    };

    // Reference A from pad 1: the flush must record exactly that edge.
    const v1 = await putText(1, `see ![a](/api/files/${fileA.id})`, 0);
    await delay(400);
    assert.deepEqual(
      readRefs(1),
      [fileA.id],
      'junction must record the reference written at runtime'
    );

    // Removing the reference must drop the edge, not accumulate it.
    await putText(1, 'no references anymore', v1);
    await delay(400);
    assert.deepEqual(readRefs(1), [], 'junction must drop removed references');

    // A second pad referencing B (a file attached to pad 1) adds a cross-pad
    // edge; deleting the referencing pad must drop it via the pad_frd trigger.
    const pad2 = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
      headers: { Origin: server.baseUrl },
    });
    assert.equal(pad2.response.status, 200);
    pad2Id = pad2.body.id;
    await putText(pad2Id, `linked: /api/files/${fileB.id}`, 0);
    await delay(400);
    assert.deepEqual(
      readRefs(pad2Id),
      [fileB.id],
      'cross-pad reference must land in the junction'
    );
    const del = await fetchJson(server.baseUrl, `/api/pads/${pad2Id}`, {
      method: 'DELETE',
      headers: { 'x-admin-token': 'admin123', Origin: server.baseUrl },
    });
    assert.equal(del.response.status, 200, JSON.stringify(del.body));
    assert.deepEqual(
      readRefs(pad2Id),
      [],
      'deleted pad must leave no reference edges behind (pad_frd trigger)'
    );
  } finally {
    void fileA;
    void fileB;
    await stopServer(server);
  }
});

test('TTL sweep protects files referenced by runtime-written text across restart', async () => {
  const Database = require('better-sqlite3');
  const server = await startServer({ FTS_SYNC_DEBOUNCE_MS: '100' });
  const dataDir = server.dataDir;
  let fileA;
  let fileB;
  let server2 = null;
  try {
    const upload = async (name, content) => {
      const formData = new FormData();
      formData.append('padId', '1');
      formData.append('file', new Blob([content], { type: 'text/plain' }), name);
      const res = await fetchJson(server.baseUrl, '/api/upload', { method: 'POST', body: formData });
      assert.equal(res.response.status, 200);
      return res.body;
    };
    fileA = await upload('restart-referenced.txt', 'a\n');
    fileB = await upload('restart-orphan.txt', 'b\n');

    const putRes = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `keep ![a](/api/files/${fileA.id})`, baseVersion: 0 }),
    });
    assert.equal(putRes.response.status, 200);

    // Graceful stop so the shutdown flush lands. The junction is derived, so
    // even a hard kill would be healed by the boot rebuild — this asserts the
    // whole chain end to end.
    await new Promise((resolve) => {
      if (server.child.exitCode !== null) return resolve();
      const killer = setTimeout(() => server.child.kill('SIGKILL'), 1000);
      server.child.once('exit', () => {
        clearTimeout(killer);
        resolve();
      });
      server.child.kill('SIGINT');
    });

    const db = new Database(path.join(dataDir, 'store.db'));
    const veryOld = Date.now() - 100 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(veryOld, fileA.id);
    db.prepare('UPDATE files SET created_at = ? WHERE id = ?').run(veryOld, fileB.id);
    db.close();

    server2 = await startServer({ DATA_DIR: dataDir }, { bootstrap: false });
    const state = await fetchJson(server2.baseUrl, '/api/state');
    const ids = (state.body.files || []).map((f) => f.id);
    assert.ok(ids.includes(fileA.id), 'file referenced by runtime-written text must survive');
    assert.ok(!ids.includes(fileB.id), 'unreferenced expired file must be collected');
  } finally {
    if (server2) await stopServer(server2);
    else fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('CSP connect-src is restricted to self (no wildcard ws:/wss:)', async () => {
  const server = await startServer();
  try {
    const res = await fetch(`${server.baseUrl}/`);
    assert.equal(res.status, 200);
    const csp = res.headers.get('content-security-policy') || '';
    const directive = (name) =>
      csp
        .split(';')
        .map((d) => d.trim())
        .find((d) => d.startsWith(name));
    assert.equal(
      directive('connect-src'),
      "connect-src 'self'",
      'same-origin ws/wss is covered by self; a bare ws: admits sockets to any host'
    );
    assert.equal(
      directive('script-src'),
      "script-src 'self'",
      'all scripts are self-hosted; no CDN may remain in the allow list'
    );
  } finally {
    await stopServer(server);
  }
});

test('frontend vendor assets are self-hosted (no CDN scripts)', async () => {
  const server = await startServer();
  try {
    const page = await fetch(`${server.baseUrl}/`);
    const html = await page.text();
    assert.ok(!html.includes('cdn.jsdelivr.net'), 'no CDN script tags may remain in the page');
    for (const asset of [
      'diff_match_patch.js',
      'hotkeys.min.js',
      'alloy_finger.js',
      'marked.min.js',
      'purify.min.js',
    ]) {
      const res = await fetch(`${server.baseUrl}/vendor/${asset}`);
      assert.equal(res.status, 200, `vendor asset ${asset} must be served locally`);
    }
  } finally {
    await stopServer(server);
  }
});

test('WS patch base uses the latest committed body after an HTTP write', async () => {
  const server = await startServer();
  try {
    const a = await createReadyClient(server.wsUrl, 1);
    a.drain();

    // HTTP full-text write commits v1; the patch path must diff against that
    // body, not a stale pre-write copy (regression guard for the per-pad body
    // cache in db/pads.ts).
    const put = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'alpha beta', baseVersion: 0 }),
    });
    assert.equal(put.response.status, 200);
    assert.equal(put.body.textVersion, 1);

    const patchText = makePatch('alpha beta', 'alpha beta gamma');
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: patchText, baseVersion: 1 }));
    const ack = await waitForMessage(a, (msg) => msg.type === 'patch-ack', 1500);
    assert.equal(ack.textVersion, 2);
    const text = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(text.body.text, 'alpha beta gamma');

    // And back the other way: an HTTP overwrite must invalidate whatever the
    // patch path last cached, or the next patch would apply against a ghost.
    const put2 = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'fresh start', baseVersion: 2 }),
    });
    assert.equal(put2.response.status, 200);
    assert.equal(put2.body.textVersion, 3);

    const patchText2 = makePatch('fresh start', 'fresh start end');
    a.socket.send(JSON.stringify({ type: 'patch', padId: 1, data: patchText2, baseVersion: 3 }));
    const ack2 = await waitForMessage(a, (msg) => msg.type === 'patch-ack', 1500);
    assert.equal(ack2.textVersion, 4);
    const text2 = await fetchJson(server.baseUrl, '/api/pads/1');
    assert.equal(text2.body.text, 'fresh start end');
  } finally {
    await stopServer(server);
  }
});
