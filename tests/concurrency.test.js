'use strict';

/**
 * Regression tests for optimistic concurrency control.
 *
 * The server rejects a patch whose `baseVersion` does not match the pad's
 * current `textVersion` — that is the whole point of the nack/ack protocol.
 * But `baseVersion` is optional, so a client that simply omits the field skips
 * the version check entirely and applies its diff against whatever the server
 * currently holds, silently clobbering a concurrent edit. The same hole exists
 * on the HTTP full-text path, where omitting it is an unconditional overwrite.
 *
 * These tests pin the invariant: **concurrency control is mandatory, not
 * opt-in.** A write that does not declare what version it was computed
 * against must be rejected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const WebSocket = require('ws');
const DiffMatchPatch = require('diff-match-patch');

const { installOriginFetch, spawnServer, stopServer } = require('./helpers');

// Auto-inject Origin on state-changing requests, mirroring the other test
// files: without it checkOrigin rejects the write with 403 before the handler
// under test is ever reached.
installOriginFetch();

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

function getPad(baseUrl, id = 1) {
  return fetch(`${baseUrl}/api/pads/${id}`).then((r) => r.json());
}

function putText(baseUrl, id, body) {
  return fetch(`${baseUrl}/api/pads/${id}/text`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify(body),
  });
}

function makePatch(oldText, newText) {
  const dmp = new DiffMatchPatch();
  return dmp.patch_toText(dmp.patch_make(oldText, newText));
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

async function waitForMessage(client, predicate, timeout = 2000) {
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

test('WS patch without baseVersion must be rejected, not applied', async () => {
  const server = await startServer();
  try {
    const seeded = await getPad(server.baseUrl);
    const seedRes = await putText(server.baseUrl, 1, {
      text: 'Hello',
      baseVersion: seeded.textVersion,
    });
    assert.equal(seedRes.status, 200, 'seed write with baseVersion must succeed');

    const client = await createClient(server.wsUrl, 1);
    await waitForMessage(client, (m) => m.type === 'hello');
    client.drain();

    // A conforming patch declares its base version: accepted.
    const before = await getPad(server.baseUrl);
    client.socket.send(
      JSON.stringify({
        type: 'patch',
        padId: 1,
        data: makePatch('Hello', 'Hello World'),
        baseVersion: before.textVersion,
      })
    );
    const accepted = await waitForMessage(
      client,
      (m) => m.type === 'patch-ack' || m.type === 'patch-nack'
    );
    assert.equal(accepted.type, 'patch-ack', 'patch carrying baseVersion must be accepted');

    const afterConforming = await getPad(server.baseUrl);
    assert.equal(afterConforming.text, 'Hello World');

    // A non-conforming patch omits baseVersion. It was computed against the
    // *old* text, so applying it would silently clobber the edit above.
    client.socket.send(
      JSON.stringify({
        type: 'patch',
        padId: 1,
        data: makePatch('Hello', 'CLOBBERED'),
      })
    );
    const reply = await waitForMessage(
      client,
      (m) => m.type === 'patch-ack' || m.type === 'patch-nack'
    );
    assert.equal(
      reply.type,
      'patch-nack',
      'a patch that omits baseVersion must be rejected instead of applied'
    );
    assert.equal(
      reply.reason,
      'missing_base_version',
      'the nack must distinguish a client contract violation from ordinary contention'
    );

    const after = await getPad(server.baseUrl);
    assert.equal(after.text, 'Hello World', 'the concurrent edit must survive');
    assert.ok(!after.text.includes('CLOBBERED'), 'the stale patch must not be applied');

    await closeClient(client);
  } finally {
    await stopServer(server);
  }
});

test('WS handshake without an Origin header is rejected by default', async () => {
  // Explicitly disable the escape hatch the shared harness turns on for
  // scripted clients, so this instance runs fail-closed.
  const server = await startServer({ WS_ALLOW_NO_ORIGIN: 'false' });
  try {
    // The handshake completes before the server's close frame arrives, so the
    // client sees `open` first. Resolve on `close` (-1 = opened and stayed
    // open, -2 = transport error) rather than treating `open` as success.
    const code = await new Promise((resolve) => {
      const socket = new WebSocket(`${server.wsUrl}/?pad=1`);
      let opened = false;
      const timer = setTimeout(() => resolve(opened ? -1 : -2), 3000);
      socket.once('open', () => {
        opened = true;
      });
      socket.once('close', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
      socket.once('error', () => {
        clearTimeout(timer);
        resolve(-2);
      });
    });
    assert.equal(
      code,
      4400,
      'a WS client that sends no Origin must be refused instead of admitted'
    );
  } finally {
    await stopServer(server);
  }
});

test('WS handshake without Origin is allowed only when explicitly opted in', async () => {
  const server = await startServer({ WS_ALLOW_NO_ORIGIN: 'true' });
  try {
    const client = await createClient(server.wsUrl, 1);
    const hello = await waitForMessage(client, (msg) => msg.type === 'hello');
    assert.ok(hello.wsId, 'opted-in scripted clients must still be admitted');
    await closeClient(client);
  } finally {
    await stopServer(server);
  }
});

test('HTTP full-text write without baseVersion must conflict, not overwrite', async () => {
  const server = await startServer();
  try {
    const seeded = await getPad(server.baseUrl);
    await putText(server.baseUrl, 1, { text: 'Hello', baseVersion: seeded.textVersion });

    const before = await getPad(server.baseUrl);
    const good = await putText(server.baseUrl, 1, {
      text: 'Hello World',
      baseVersion: before.textVersion,
    });
    assert.equal(good.status, 200, 'write carrying baseVersion must succeed');

    // Same request but without baseVersion: an unconditional overwrite that
    // would erase the edit above.
    const bad = await putText(server.baseUrl, 1, { text: 'CLOBBERED' });
    assert.equal(
      bad.status,
      409,
      'a full-text write that omits baseVersion must conflict instead of overwriting'
    );

    const after = await getPad(server.baseUrl);
    assert.equal(after.text, 'Hello World', 'the concurrent edit must survive');
  } finally {
    await stopServer(server);
  }
});
