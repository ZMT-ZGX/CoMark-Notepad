const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');

const { installOriginFetch, spawnServer, stopServer } = require('./helpers');

// Wrap global fetch to auto-inject Origin on state-changing methods, exactly
// like the other test files. Without it, POST/PUT/DELETE requests have no
// Origin header and the CSRF check (checkOrigin) rejects them with 403 —
// which would make every upload/convert call fail before it reaches the
// handler under test.
installOriginFetch();

// Bootstrap a public pad (id 1) so file/upload/WS tests have a target.
async function startServer(extraEnv = {}) {
  const server = await spawnServer(extraEnv);
  const res = await fetch(`${server.baseUrl}/api/pads`, {
    method: 'POST',
    headers: { Origin: extraEnv.PUBLIC_ORIGIN || server.baseUrl },
  });
  if (!res.ok) {
    await stopServer(server);
    throw new Error(`bootstrap pad failed: ${res.status}`);
  }
  return server;
}

function fetchJson(baseUrl, p, init) {
  return fetch(`${baseUrl}${p}`, init).then(async (response) => ({
    response,
    body: await response.json().catch(() => null),
  }));
}

function extractCookie(res) {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const match = raw.match(/session_token=([^;]+)/);
  return match ? match[1] : null;
}

async function registerUser(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST' });
  assert.equal(res.status, 200);
  const data = await res.json();
  const cookie = extractCookie(res);
  assert.ok(cookie);
  return { code: data.code, cookie: `session_token=${cookie}` };
}

function countFiles(dataDir) {
  const dir = path.join(dataDir, 'files');
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => /^\d+$/.test(n)).length;
}

// Craft a ZIP whose central directory declares a 1GB uncompressed entry from a
// 10-byte compressed body — an impossible ~100M:1 ratio. This is metadata only
// (no decompression), so it probes the archive-bomb guard in convert-worker.js.
function craftZipBomb() {
  const name = 'xl';
  const local = Buffer.alloc(30 + name.length);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0, 10);
  local.writeUInt16LE(0, 12);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(10, 18); // compressed size
  local.writeUInt32LE(0x40000000, 22); // uncompressed size = 1GB
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  local.write(name, 30, 'latin1');
  const data = Buffer.alloc(10, 0);

  const cd = Buffer.alloc(46 + name.length);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(0, 8);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt16LE(0, 12);
  cd.writeUInt16LE(0, 14);
  cd.writeUInt32LE(0, 16);
  cd.writeUInt32LE(10, 20); // compressed size
  cd.writeUInt32LE(0x40000000, 24); // uncompressed size = 1GB
  cd.writeUInt16LE(name.length, 28);
  cd.writeUInt16LE(0, 30);
  cd.writeUInt16LE(0, 32);
  cd.writeUInt16LE(0, 34);
  cd.writeUInt16LE(0, 36);
  cd.writeUInt32LE(0, 38);
  cd.writeUInt32LE(0, 42); // local header offset
  cd.write(name, 46, 'latin1');

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(local.length + data.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([local, data, cd, eocd]);
}

// ── Tests ────────────────────────────────────────────────────────────────

test('malformed WS frames do not crash the server', async () => {
  const server = await startServer();
  try {
    const sock = new WebSocket(`${server.wsUrl}/?pad=1`);
    await new Promise((resolve, reject) => {
      sock.on('open', resolve);
      sock.on('error', reject);
    });
    // Prototype-chain key — previously `MESSAGE_SCHEMAS[obj.type]` resolved to
    // Object and the missing `.safeParse` threw an uncaught TypeError.
    sock.send(JSON.stringify({ type: 'constructor' }));
    // Over-long type — previously produced ws.close(4400, <300-char reason>),
    // a synchronous RangeError that escaped the message listener.
    sock.send(JSON.stringify({ type: 'x'.repeat(300) }));
    // Non-string type.
    sock.send(JSON.stringify({ type: { nested: true } }));
    // Unparseable frame.
    sock.send('not json');
    await delay(400);
    sock.close();

    // The process must still be alive and serving traffic.
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(server.child.exitCode, null, 'server process must not have exited');
  } finally {
    await stopServer(server);
  }
});

test('rejected upload leaves no orphan file on disk (lock-before-rename)', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);
    // Create a private pad and password-protect it.
    const padRes = await fetchJson(server.baseUrl, '/api/pads', {
      method: 'POST',
      headers: { Cookie: user.cookie },
    });
    assert.equal(padRes.response.status, 200);
    const padId = padRes.body.id;
    const pwRes = await fetchJson(server.baseUrl, `/api/pads/${padId}/password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user.cookie },
      body: JSON.stringify({ password: 'secret' }),
    });
    assert.equal(pwRes.response.status, 200);

    const before = countFiles(server.dataDir);

    // Append the file part BEFORE padId so the early access check is skipped
    // and (pre-fix) the temp file is renamed into place before the lock check
    // runs. With no unlock token the request must be rejected — but no file
    // may remain on disk (TTL cleanup only walks the DB, never orphans).
    const formData = new FormData();
    formData.append('file', new Blob(['payload\n'], { type: 'text/plain' }), 'payload.txt');
    formData.append('padId', String(padId));
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: user.cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 403);
    assert.equal(upload.body.error, 'Pad locked');

    await delay(100);
    const after = countFiles(server.dataDir);
    assert.equal(after, before, 'rejected upload must not leave an orphan file');
  } finally {
    await stopServer(server);
  }
});

test('public pad: a user cannot delete another user\'s file', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);

    async function uploadAs(user, name) {
      const formData = new FormData();
      formData.append('padId', '1');
      formData.append('file', new Blob(['content\n'], { type: 'text/plain' }), name);
      const res = await fetchJson(server.baseUrl, '/api/upload', {
        method: 'POST',
        headers: { Cookie: user.cookie },
        body: formData,
      });
      assert.equal(res.response.status, 200);
      return res.body.id;
    }

    const aliceFile = await uploadAs(alice, 'alice.txt');
    const bobFile = await uploadAs(bob, 'bob.txt');

    // Bob must NOT be able to delete Alice's file on the public pad.
    const bobDeletesAlice = await fetchJson(server.baseUrl, `/api/files/${aliceFile}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
    });
    assert.equal(bobDeletesAlice.response.status, 403);

    // Bob MAY delete his own file.
    const bobDeletesSelf = await fetchJson(server.baseUrl, `/api/files/${bobFile}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(bobDeletesSelf.response.status, 200);

    // A bulk clear by Bob must only remove his own files, not Alice's.
    const state = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: alice.cookie } });
    const remaining = state.body.files.map((f) => f.id);
    assert.ok(remaining.includes(aliceFile), 'Alice\'s file must survive Bob\'s clear');
    assert.equal(remaining.includes(bobFile), false, 'Bob\'s file must be gone');
  } finally {
    await stopServer(server);
  }
});

test('public pad: a user cannot convert another user\'s file (destructive write)', async () => {
  const server = await startServer();
  try {
    const alice = await registerUser(server.baseUrl);
    const bob = await registerUser(server.baseUrl);

    // Alice uploads an owned file (public pad has ownerUserId=null, so
    // resolveFileOwner attributes the upload to Alice's identity).
    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['name,age\nAlice,30\n'], { type: 'text/csv' }), 'alice.csv');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: alice.cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);
    const aliceFile = upload.body.id;

    // Conversion REPLACES the source, so it is a destructive write: Bob (a
    // plain grant-holder, neither the owner nor a pad manager) must be refused
    // even though he could READ Alice's file.
    const convert = await fetchJson(server.baseUrl, `/api/convert/${aliceFile}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: bob.cookie },
      body: JSON.stringify({}),
    });
    assert.equal(convert.response.status, 403);
    assert.equal(server.child.exitCode, null, 'server must stay alive');

    // The source file and its row must survive untouched.
    const state = await fetchJson(server.baseUrl, '/api/state', { headers: { Cookie: alice.cookie } });
    assert.ok(state.body.files.some((f) => f.id === aliceFile), 'Alice\'s file must survive');
  } finally {
    await stopServer(server);
  }
});

test('archive bomb is rejected by the convert worker without crashing', async () => {
  const server = await startServer();
  try {
    const user = await registerUser(server.baseUrl);
    const bomb = craftZipBomb();
    const formData = new FormData();
    formData.append('padId', '1');
    formData.append(
      'file',
      new Blob([bomb], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      'bomb.xlsx'
    );
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: user.cookie },
      body: formData,
    });
    assert.equal(upload.response.status, 200);
    const fileId = upload.body.id;

    const convert = await fetchJson(server.baseUrl, `/api/convert/${fileId}`, {
      method: 'POST',
      headers: { Cookie: user.cookie },
    });
    assert.equal(convert.response.status, 422, 'oversized archive must be rejected as input error');
    assert.equal(convert.body.code, 'CONVERSION_INPUT_ERROR');

    // Server must remain alive after the worker rejects the bomb.
    const health = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.equal(server.child.exitCode, null, 'convert worker must not take down the process');
  } finally {
    await stopServer(server);
  }
});

// ── 9.4 regression: aggregate storage quota ──────────────────────────────

test('upload beyond the global storage quota is rejected (413) and leaves no orphan', async () => {
  // MAX_STORAGE_BYTES=4 bytes: a single 5-byte file already exceeds it, so the
  // upload must be refused before the .part is promoted — and nothing may be
  // left on disk afterwards.
  const server = await startServer({ MAX_STORAGE_BYTES: '4' });
  try {
    const user = await registerUser(server.baseUrl);
    const filesDir = path.join(server.dataDir, 'files');
    const before = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).length : 0;

    const formData = new FormData();
    formData.append('padId', '1');
    formData.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
    const upload = await fetchJson(server.baseUrl, '/api/upload', {
      method: 'POST',
      headers: { Cookie: user.cookie },
      body: formData,
    });

    assert.equal(upload.response.status, 413, 'over-quota upload must be refused');
    assert.equal(upload.body.error, 'Storage quota exceeded');

    await delay(100);
    const after = fs.existsSync(filesDir) ? fs.readdirSync(filesDir).length : 0;
    assert.equal(after, before, 'rejected over-quota upload must not leave a file on disk');
  } finally {
    await stopServer(server);
  }
});

test('repeated uploads by one account hit the per-user storage quota (413)', async () => {
  // Global cap is roomy (1MB); per-user cap is 6 bytes. A 5-byte file fits
  // once, the second pushes the same account past its cap and must be rejected
  // — otherwise a single account could fill the disk.
  const server = await startServer({ MAX_STORAGE_BYTES: '1048576', MAX_STORAGE_BYTES_PER_USER: '6' });
  try {
    const user = await registerUser(server.baseUrl);
    async function uploadOnce() {
      const formData = new FormData();
      formData.append('padId', '1');
      formData.append('file', new Blob(['hello'], { type: 'text/plain' }), `f${Math.random()}.txt`);
      const res = await fetchJson(server.baseUrl, '/api/upload', {
        method: 'POST',
        headers: { Cookie: user.cookie },
        body: formData,
      });
      return res.response.status;
    }
    assert.equal(await uploadOnce(), 200, 'first upload within quota must succeed');
    assert.equal(await uploadOnce(), 413, 'second upload by the same account must exceed per-user quota');
  } finally {
    await stopServer(server);
  }
});

// ── 9.3 regression: registration rate limit ──────────────────────────────

test('concurrent uploads cannot overshoot the storage quota (TOCTOU)', async () => {
  // 100KB cap, 16 concurrent 60KB uploads → exactly one can fit.
  //
  // The quota check and the DB insert are separated by `await rename`, so
  // every request runs its synchronous check before ANY request commits.
  // Without an in-flight reservation all eight therefore read
  // committed = 0, all eight pass, and 480KB lands on a 100KB cap — which is
  // exactly the disk-fill the quota exists to prevent.
  const server = await startServer({ MAX_STORAGE_BYTES: '100000' });
  try {
    const user = await registerUser(server.baseUrl);
    const payload = 'x'.repeat(60000);
    const statuses = await Promise.all(
      Array.from({ length: 16 }, (_, i) => {
        const formData = new FormData();
        formData.append('padId', '1');
        formData.append('file', new Blob([payload], { type: 'text/plain' }), `c${i}.txt`);
        return fetchJson(server.baseUrl, '/api/upload', {
          method: 'POST',
          headers: { Cookie: user.cookie },
          body: formData,
        }).then((r) => r.response.status);
      })
    );
    const ok = statuses.filter((s) => s === 200).length;
    assert.equal(ok, 1, `only one 60KB upload fits in a 100KB cap, but ${ok} were accepted`);
  } finally {
    await stopServer(server);
  }
});

test('registration is rate-limited to 10 per 15 minutes', async () => {
  const server = await startServer();
  try {
    let ok = 0;
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${server.baseUrl}/api/auth/register`, { method: 'POST' });
      if (res.status === 200) ok++;
      else if (res.status === 429) limited++;
    }
    assert.equal(ok, 10, 'the first 10 registration attempts must succeed');
    assert.ok(limited >= 1, 'further attempts must be rate-limited with 429');
  } finally {
    await stopServer(server);
  }
});
