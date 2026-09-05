const test = require('node:test');
const assert = require('node:assert/strict');
const WebSocket = require('ws');

const { installOriginFetch, spawnServer, stopServer } = require('./helpers');

// Auto-inject Origin for state-changing methods so CSRF checks pass.
installOriginFetch();

const ADMIN = 'secret-token';

/**
 * Gated mode blocks bootstrap, so callers that need a pre-existing pad pass
 * `gatedPad: true` here — we then create a public pad via the admin token
 * (which bypasses the gate and, having no session cookie, yields
 * ownerUserId = null).
 */
// Gated mode spins up more DB tables and the admin bootstrap path, so the
// boot timeout is more generous than the default.
function startServer(extraEnv = {}, { gatedPad = false } = {}) {
  return spawnServer(extraEnv, { label: 'wa', timeoutMs: 8000 }).then(async (server) => {
    if (!gatedPad) return server;
    try {
      const res = await fetch(`${server.baseUrl}/api/pads`, {
        method: 'POST',
        headers: { 'X-Admin-Token': ADMIN, Origin: server.baseUrl },
      });
      if (!res.ok) throw new Error(`bootstrap pad failed: ${res.status} ${await res.text()}`);
    } catch (e) {
      await stopServer(server);
      throw e;
    }
    return server;
  });
}

async function register(baseUrl) {
  const res = await fetch(`${baseUrl}/api/auth/register`, { method: 'POST' });
  const body = await res.json();
  return { code: body.code, cookie: res.headers.get('set-cookie').split(';')[0] };
}

async function call(baseUrl, method, urlPath, { cookie, body, admin } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (admin) headers['X-Admin-Token'] = admin;
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, body: json };
}

/**
 * Every write path. If a new write endpoint is added and the gate is not
 * applied to it, this list (asserted below) catches it.
 */
function writeRequests(baseUrl, cookie, padId = 1) {
  const form = new FormData();
  form.append('file', new Blob(['hello']), 'note.txt');
  form.append('padId', String(padId));

  return [
    {
      name: 'POST /api/upload',
      run: async () => {
        const r = await fetch(`${baseUrl}/api/upload`, {
          method: 'POST',
          headers: { Cookie: cookie },
          body: form,
        });
        let b = null;
        try {
          b = await r.json();
        } catch {}
        return { status: r.status, body: b };
      },
    },
    { name: 'DELETE /api/files/:id', run: () => call(baseUrl, 'DELETE', '/api/files/missing', { cookie }) },
    { name: 'DELETE /api/files (clear)', run: () => call(baseUrl, 'DELETE', '/api/files', { cookie, body: { padId } }) },
    { name: 'PUT /api/pads/:id/text', run: () => call(baseUrl, 'PUT', `/api/pads/${padId}/text`, { cookie, body: { text: 'x' } }) },
    { name: 'POST /api/pads/:id/text', run: () => call(baseUrl, 'POST', `/api/pads/${padId}/text`, { cookie, body: { text: 'x' } }) },
    { name: 'POST /api/pads (create)', run: () => call(baseUrl, 'POST', '/api/pads', { cookie, body: {} }) },
    { name: 'POST /api/pads/:id/password', run: () => call(baseUrl, 'POST', `/api/pads/${padId}/password`, { cookie, body: { password: 'x' } }) },
    { name: 'DELETE /api/pads/:id', run: () => call(baseUrl, 'DELETE', `/api/pads/${padId}`, { cookie }) },
    { name: 'POST /api/invitations', run: () => call(baseUrl, 'POST', '/api/invitations', { cookie, body: { maxUses: 1 } }) },
    { name: 'DELETE /api/invitations/:token', run: () => call(baseUrl, 'DELETE', '/api/invitations/x', { cookie }) },
    { name: 'POST /api/convert/:fileId', run: () => call(baseUrl, 'POST', '/api/convert/missing', { cookie, body: {} }) },
  ];
}

const GATED_ENV = { WRITE_ACCESS_MODE: 'gated', WRITE_PASSPHRASES: 'team2026', ADMIN_TOKEN: ADMIN };

test('open mode: the gate never fires (no WRITE_REQUIRED responses)', async () => {
  const server = await startServer();
  try {
    const { cookie } = await register(server.baseUrl);
    for (const req of writeRequests(server.baseUrl, cookie)) {
      const { status, body } = await req.run();
      // The gate's 403 carries code: WRITE_REQUIRED. Service-level 403s (e.g.
      // "only admin can set a public pad's password") are fine — those mean
      // the gate passed and the handler applied its own authorization.
      if (status === 403) {
        assert.notEqual(
          body?.code,
          'WRITE_REQUIRED',
          `${req.name} must not be blocked by the gate in open mode`
        );
      }
    }
  } finally {
    await stopServer(server);
  }
});

test('gated mode blocks all 11 HTTP write paths without a grant', async () => {
  const server = await startServer(GATED_ENV);
  try {
    const { cookie } = await register(server.baseUrl);
    for (const req of writeRequests(server.baseUrl, cookie)) {
      const res = await req.run();
      assert.equal(res.status, 403, `${req.name} must be blocked in gated mode`);
      assert.equal(res.body?.code, 'WRITE_REQUIRED', `${req.name} must carry the gate code`);
    }
  } finally {
    await stopServer(server);
  }
});

test('gated mode blocks real-time editing over WebSocket (4405)', async () => {
  const server = await startServer(GATED_ENV, { gatedPad: true });
  try {
    const { cookie } = await register(server.baseUrl);
    const code = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${server.wsUrl}/?pad=1`, { headers: { Cookie: cookie } });
      let sawDenied = false;
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw));
        if (msg.type === 'write-denied') sawDenied = true;
      });
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'patch', padId: 1, data: '', baseVersion: 0 }));
      });
      ws.on('close', (c) => {
        assert.equal(c, 4405, 'socket must be closed with 4405');
        assert.equal(sawDenied, true, 'client must be told why before the close');
        resolve(c);
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('timed out waiting for close')), 5000);
    });
    assert.equal(code, 4405);
  } finally {
    await stopServer(server);
  }
});

test('redeeming a passphrase opens writes (and a wrong phrase is refused)', async () => {
  const server = await startServer(GATED_ENV);
  try {
    const { cookie } = await register(server.baseUrl);

    const wrong = await call(server.baseUrl, 'POST', '/api/write-access/redeem', {
      cookie,
      body: { passphrase: 'nope' },
    });
    assert.equal(wrong.status, 403);
    assert.equal(wrong.body.code, 'INVALID_PASSPHRASE');

    const ok = await call(server.baseUrl, 'POST', '/api/write-access/redeem', {
      cookie,
      body: { passphrase: 'team2026' },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.writeAccess.allowed, true);
    assert.equal(ok.body.writeAccess.source, 'passphrase');
    assert.equal(ok.body.writeAccess.permanent, false);

    // Now this user may create and edit their own pad.
    const created = await call(server.baseUrl, 'POST', '/api/pads', { cookie, body: {} });
    assert.equal(created.status, 200);
    const padId = created.body.id;
    const write = await call(server.baseUrl, 'PUT', `/api/pads/${padId}/text`, {
      cookie,
      body: { text: 'now allowed', baseVersion: 0 },
    });
    assert.equal(write.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('admin can grant and revoke permanent write access per member', async () => {
  const server = await startServer(GATED_ENV);
  try {
    const { cookie, code } = await register(server.baseUrl);

    const blocked = await call(server.baseUrl, 'POST', '/api/pads', { cookie, body: {} });
    assert.equal(blocked.status, 403);

    const granted = await call(server.baseUrl, 'POST', `/api/members/${code}/write`, {
      admin: ADMIN,
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.grant.expiresAt, null);

    const created = await call(server.baseUrl, 'POST', '/api/pads', { cookie, body: {} });
    assert.equal(created.status, 200);

    const status = await call(server.baseUrl, 'GET', '/api/write-access/status', { cookie });
    assert.equal(status.body.writeAccess.permanent, true);
    assert.equal(status.body.writeAccess.source, 'admin');

    await call(server.baseUrl, 'DELETE', `/api/members/${code}/write`, { admin: ADMIN });
    const afterRevoke = await call(server.baseUrl, 'POST', '/api/pads', { cookie, body: {} });
    assert.equal(afterRevoke.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('redeeming a passphrase must not downgrade an admin permanent grant', async () => {
  const server = await startServer(GATED_ENV);
  try {
    const { cookie, code } = await register(server.baseUrl);

    // Admin marks this member permanently trusted (expiresAt === null).
    const granted = await call(server.baseUrl, 'POST', `/api/members/${code}/write`, {
      admin: ADMIN,
    });
    assert.equal(granted.status, 200);

    // The member then redeems a valid phrase. The phrase matches, so the
    // request succeeds — but redeem() used to REPLACE the row unconditionally,
    // swapping permanent admin trust for a time-limited passphrase grant and
    // rewriting grantedBy. The member would silently lose access at the TTL.
    const redeemed = await call(server.baseUrl, 'POST', '/api/write-access/redeem', {
      cookie,
      body: { passphrase: 'team2026' },
    });
    assert.equal(redeemed.status, 200);

    const status = await call(server.baseUrl, 'GET', '/api/write-access/status', { cookie });
    assert.equal(status.body.writeAccess.permanent, true, 'permanent grant must survive a redeem');
    assert.equal(status.body.writeAccess.source, 'admin', 'grant source must not be rewritten');
    assert.equal(status.body.writeAccess.expiresAt, null, 'a permanent grant has no expiry');
  } finally {
    await stopServer(server);
  }
});

test('releasing your own grant immediately blocks writes', async () => {
  const server = await startServer(GATED_ENV);
  try {
    const { cookie } = await register(server.baseUrl);
    await call(server.baseUrl, 'POST', '/api/write-access/redeem', {
      cookie,
      body: { passphrase: 'team2026' },
    });
    const released = await call(server.baseUrl, 'DELETE', '/api/write-access/release', { cookie });
    assert.equal(released.status, 200);
    const blocked = await call(server.baseUrl, 'POST', '/api/pads', { cookie, body: {} });
    assert.equal(blocked.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('member list requires the admin token', async () => {
  const server = await startServer(GATED_ENV);
  try {
    const { cookie } = await register(server.baseUrl);
    const denied = await call(server.baseUrl, 'GET', '/api/members', { cookie });
    assert.equal(denied.status, 403);

    const res = await fetch(`${server.baseUrl}/api/members`, {
      headers: { 'X-Admin-Token': ADMIN },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.members.length, 1);
    assert.equal(body.members[0].writeAccess.allowed, false);
  } finally {
    await stopServer(server);
  }
});

test('read paths stay open in gated mode', async () => {
  const server = await startServer(GATED_ENV, { gatedPad: true });
  try {
    const { cookie } = await register(server.baseUrl);
    for (const p of ['/api/state', '/api/pads/1', '/api/convert/capabilities', '/api/auth/me']) {
      const res = await fetch(`${server.baseUrl}${p}`, { headers: { Cookie: cookie } });
      assert.equal(res.status, 200, `${p} must stay readable in gated mode`);
    }
  } finally {
    await stopServer(server);
  }
});

test('display name can be set and is returned by /api/auth/me', async () => {
  const server = await startServer();
  try {
    const { cookie } = await register(server.baseUrl);
    const res = await fetch(`${server.baseUrl}/api/auth/me`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ displayName: '张三' }),
    });
    assert.equal(res.status, 200);
    const me = await (
      await fetch(`${server.baseUrl}/api/auth/me`, { headers: { Cookie: cookie } })
    ).json();
    assert.equal(me.displayName, '张三');
  } finally {
    await stopServer(server);
  }
});
