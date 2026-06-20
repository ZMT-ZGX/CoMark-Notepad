const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const PROJECT_DIR = path.resolve(__dirname, '..');

function startServer() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-notepad-'));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: PROJECT_DIR,
      env: { ...process.env, PORT: '0', DATA_DIR: dataDir },
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
    }, 5000);

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

async function fetchJson(baseUrl, pathname, init) {
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

test('state endpoint returns default shape with one pad', async () => {
  const server = await startServer();
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/state');
    assert.equal(response.status, 200);
    assert.equal(body.pads.length, 1);
    assert.equal(body.pads[0].id, 1);
    assert.equal(body.pads[0].hasPassword, false);
    assert.deepEqual(body.files, []);
  } finally {
    await stopServer(server);
  }
});

test('health endpoint returns status', async () => {
  const server = await startServer();
  try {
    const { response, body } = await fetchJson(server.baseUrl, '/api/health');
    assert.equal(response.status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.pads, 1);
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
    const c = await createReadyClient(server.wsUrl, 2);

    a.drain();
    b.drain();
    c.drain();

    const { response, body } = await fetchJson(server.baseUrl, '/api/pads/1/text', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'pad 1 test', _wsId: a.wsId }),
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
  const server = await startServer();
  try {
    // Register a user (needed for destructive operations on public pads)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const regData = await regRes.json();
    const authHeaders = { 'Content-Type': 'application/json', Cookie: regRes.headers.get('set-cookie') };

    // Set password on pad 1
    const setPassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: authHeaders,
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    assert.equal(wrongUnlock.response.status, 403);

    // Correct password unlock should succeed
    const correctUnlock = await fetchJson(server.baseUrl, '/api/pads/1/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'secret123' }),
    });
    assert.equal(correctUnlock.response.status, 200);
    assert.ok(correctUnlock.body.token);

    // Remove password
    const removePassword = await fetchJson(server.baseUrl, '/api/pads/1/password', {
      method: 'POST',
      headers: { ...authHeaders, 'X-Pad-Token': token },
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

test('file updates broadcast to same pad only', async () => {
  const server = await startServer();
  try {
    // Register a user so uploaded files have an owner (deletion requires auth)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const cookie = regRes.headers.get('set-cookie');

    const a = await createReadyClient(server.wsUrl, 1);
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
    // Register a user first (needed for clear permission)
    const regRes = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
    const regData = await regRes.json();
    const cookie = regRes.headers.get('set-cookie');

    for (const name of ['a.txt', 'b.txt']) {
      const formData = new FormData();
      formData.append('padId', '1');
      formData.append('file', new Blob(['content\n'], { type: 'text/plain' }), name);
      await fetchJson(server.baseUrl, '/api/upload', { method: 'POST', body: formData, headers: { Cookie: cookie } });
    }

    const beforeState = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: cookie } });
    assert.equal(beforeState.body.files.length, 2);

    const clearResult = await fetchJson(server.baseUrl, '/api/files', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ padId: 1 }),
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

    // Duplicate convert → 409
    const dup = await fetchJson(server.baseUrl, `/api/convert/${upload.body.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({}),
    });
    assert.equal(dup.response.status, 409);

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

test('old single-pad store migrates to multi-pad', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-notepad-migrate-'));
  const storeFile = path.join(dataDir, 'store.json');
  const filesDir = path.join(dataDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  fs.writeFileSync(storeFile, JSON.stringify({
    text: 'old content',
    textVersion: 5,
    files: [],
  }));

  const child = spawn(process.execPath, ['server.js'], {
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
    await delay(500);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
