// @ts-check
'use strict';
// The hub under real Node, the runtime of the extension host (the bun tests run it under Bun): over
// real sockets a phone is refused without a Tailscale identity, cannot send a big frame before its
// hello, cannot make the hub queue pongs by pinging without reading, pairs, says hello, lists the
// projects, gets a snapshot and acks (one for a 1 MB message), and is told when remote access is
// turned off. A peer window proves that it knows the secret and counts only then; one with a wrong
// proof is dropped unanswered. State lives in a temp CCE_REMOTE_HOME; nothing touches ~/.cce-remote
// or Tailscale.
//
//   node remote-bridge/test/hub-smoke.js     → prints "hub smoke: ok" and exits 0, or the failure and 1
//
// hub.test.ts runs it ("under real Node").

const assert = require('assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { createHmac, randomBytes } = require('crypto');
const { Hub } = require('../lib/hub.js');
const { connectPeer } = require('../lib/peer-link.js');
const { loadState, updateState } = require('../lib/store.js');

const OWNER = 'owner@example.com';
const ORIGIN = 'https://app.example.com';
const PROJECT = { id: 'aaaaaaaaaaaa', name: 'smoke', folders: ['/Users/example/smoke'], editor: 'Visual Studio Code', claudeOpen: true, sessions: [] };

/** A WebSocket client (Node's own, which takes headers) whose frames can be awaited in order. @param {number} port @param {Record<string, string>} headers */
function openPhone(port, headers) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, /** @type {any} */ ({ headers }));
  /** @type {any[]} */
  const frames = [];
  /** @type {((frame: any) => void)[]} */
  const waiting = [];
  ws.addEventListener('message', (/** @type {any} */ event) => {
    const frame = JSON.parse(String(event.data));
    const waiter = waiting.shift();
    if (waiter) waiter(frame);
    else frames.push(frame);
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (/** @type {any} */ event) => resolve(event.code)));
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(undefined));
    ws.addEventListener('error', () => reject(new Error('the phone could not connect')));
  });
  return {
    opened,
    closed,
    /** @param {object} frame */
    send: (frame) => ws.send(JSON.stringify(frame)),
    /** @returns {Promise<any>} */
    next: () => (frames.length > 0 ? Promise.resolve(frames.shift()) : new Promise((resolve) => waiting.push(resolve))),
    close: () => ws.close(),
  };
}

/** A masked client frame (mask key 0). @param {number} opcode @param {Buffer} payload */
function clientFrame(opcode, payload) {
  const head = Buffer.alloc(payload.length < 126 ? 2 : payload.length < 65536 ? 4 : 10);
  head[0] = 0x80 | opcode;
  if (payload.length < 126) head[1] = 0x80 | payload.length;
  else if (payload.length < 65536) {
    head[1] = 0x80 | 126;
    head.writeUInt16BE(payload.length, 2);
  } else {
    head[1] = 0x80 | 127;
    head.writeUInt32BE(0, 2);
    head.writeUInt32BE(payload.length, 6);
  }
  return Buffer.concat([head, Buffer.alloc(4), payload]);
}

/** @param {() => boolean} check @param {string} what */
async function waitFor(check, what) {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * A peer by hand that does not know the secret: its upgrade, then a made-up proof. Resolves with
 * everything the hub sent after its 101 once the hub closed the connection.
 * @param {number} port
 * @returns {Promise<{ head: string, after: string }>}
 */
function peerWithoutSecret(port) {
  return new Promise((resolve, reject) => {
    const nonce = randomBytes(32).toString('hex');
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET /_peer HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: cce-peer\r\nX-CCE-Nonce: ${nonce}\r\n\r\n`));
    let answer = '';
    let sent = false;
    socket.on('data', (chunk) => {
      answer += chunk.toString('latin1');
      const end = answer.indexOf('\r\n\r\n');
      if (end === -1 || sent) return;
      sent = true;
      const hubNonce = (/x-cce-nonce: *([0-9a-f]{64})/i.exec(answer) || [])[1] || '';
      const wrong = createHmac('sha256', 'f'.repeat(64)).update(`peer\n${nonce}\n${hubNonce}`).digest('hex');
      socket.write(`${JSON.stringify({ t: 'auth', proof: wrong })}\n{"t":"call","id":1,"m":"newPairingCode"}\n`);
    });
    socket.on('error', reject);
    socket.on('close', () => {
      const end = answer.indexOf('\r\n\r\n');
      resolve({ head: answer.slice(0, end), after: answer.slice(end + 4) });
    });
  });
}

/** The status line the server answers to raw request text. @param {number} port @param {string} request */
function statusLine(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let answer = '';
    socket.on('data', (chunk) => {
      answer += chunk.toString('latin1');
    });
    socket.on('error', reject);
    socket.on('close', () => resolve(answer.split('\r\n')[0]));
  });
}

async function main() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cce-hub-smoke-'));
  const env = { CCE_REMOTE_HOME: home };
  /** @type {string[]} */
  const calls = [];
  const hub = new Hub({
    state: () => loadState(env),
    updateState: (fn) => updateState(fn, env),
    tailscale: { status: async () => ({ installed: true, running: true, loginName: OWNER, dnsName: 'example-mac.tailnet-0000.ts.net' }) },
    macName: () => 'example-mac',
    projectsDebounceMs: 20,
  });
  try {
    await hub.listen(0);
    const port = hub.port;
    assert.ok(port > 0);

    /** @param {string} path @returns {Promise<any>} Node's fetch (its Response type is not in this file's types) */
    const get = (path) => fetch(`http://127.0.0.1:${port}${path}`);
    assert.deepEqual(await (await get('/health')).json(), { ok: true, app: 'cce-remote', v: 1 });
    assert.match(await (await get('/')).text(), /CCE Remote/);
    assert.equal((await get('/nope')).status, 404);
    const upgrade = 'GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n';
    assert.equal(await statusLine(port, `${upgrade}\r\n`), 'HTTP/1.1 403 Forbidden');
    assert.equal(await statusLine(port, `${upgrade}Tailscale-User-Login: other@example.com\r\n\r\n`), 'HTTP/1.1 403 Forbidden');

    const window = hub.addWindow({
      key: 'smoke',
      call: async (method, args) => {
        calls.push(method);
        if (method === 'snapshot') return { messages: [{ uuid: 'm1', type: 'assistant', content: [{ type: 'text', text: 'hi' }] }], pending: [], state: 'idle', live: false, truncatedBefore: 0 };
        if (method === 'send') return { session: args.session, uuid: 'u1' };
        return undefined;
      },
    });
    window.setProject(PROJECT);

    // A socket that pings without reading, before its hello: its pongs must not pile up in the hub.
    const flood = net.connect(port, '127.0.0.1');
    flood.on('error', () => {});
    await new Promise((resolve) => flood.once('connect', resolve));
    flood.once('data', () => flood.pause()); // the 101; nothing is read after it
    flood.write(`${upgrade}Tailscale-User-Login: ${OWNER}\r\nOrigin: ${ORIGIN}\r\n\r\n`);
    const pings = Buffer.concat(Array.from({ length: 8000 }, () => clientFrame(0x9, Buffer.alloc(125, 0x70)))); // 1 MB
    const rssBefore = process.memoryUsage().rss;
    const floodUntil = Date.now() + 1500;
    let flooded = 0;
    while (Date.now() < floodUntil && !flood.destroyed) {
      flooded += pings.length;
      if (!flood.write(pings)) await new Promise((resolve) => flood.once('drain', resolve));
      else await new Promise((resolve) => setImmediate(resolve));
    }
    const grown = process.memoryUsage().rss - rssBefore;
    assert.ok(flooded > 20 * 1024 * 1024, `the flood sent only ${flooded} bytes`);
    assert.ok(grown < 200 * 1024 * 1024, `the process grew by ${Math.round(grown / 1048576)} MB while ${Math.round(flooded / 1048576)} MB of pings came in`);
    flood.destroy();

    const big = openPhone(port, { 'Tailscale-User-Login': OWNER, Origin: ORIGIN });
    await big.opened;
    big.send({ t: 'pair', code: 'ABCD-EFGH', device: 'x'.repeat(70 * 1024) }); // over 64 KB before hello
    assert.equal(await big.closed, 1009);

    const { code } = hub.newPairingCode();
    const pairing = openPhone(port, { 'Tailscale-User-Login': OWNER, Origin: ORIGIN });
    await pairing.opened;
    pairing.send({ t: 'pair', code: 'ZZZZ-ZZZZ'.replace(/./g, (c, i) => (i === 0 && code[0] === 'Z' ? 'Y' : c)), device: 'Smoke phone' });
    assert.equal((await pairing.next()).code, 'bad_code');
    pairing.send({ t: 'pair', code, device: 'Smoke phone' });
    const paired = await pairing.next();
    assert.equal(paired.t, 'paired');
    pairing.close();

    const phone = openPhone(port, { 'Tailscale-User-Login': OWNER, Origin: ORIGIN });
    await phone.opened;
    phone.send({ t: 'hello', v: 1, deviceId: paired.deviceId, token: paired.token });
    assert.deepEqual(await phone.next(), { t: 'welcome', v: 1, mac: { name: 'example-mac' }, push: false });
    assert.deepEqual(await phone.next(), { t: 'projects', projects: [PROJECT] });
    assert.equal(hub.phoneCount(), 1);
    phone.send({ t: 'sub', project: PROJECT.id, session: 's1' });
    const snapshot = await phone.next();
    assert.equal(snapshot.t, 'snapshot');
    assert.equal(snapshot.messages[0].uuid, 'm1');
    window.sessionEvent('s1', { t: 'msg', message: { uuid: 'm2', type: 'user', content: [] } });
    assert.equal((await phone.next()).message.uuid, 'm2');
    phone.send({ t: 'send', id: 'r1', project: PROJECT.id, session: 's1', text: 'hello' });
    assert.deepEqual(await phone.next(), { t: 'ack', id: 'r1', ok: true, session: 's1', uuid: 'u1' });
    phone.send({ t: 'send', id: 'r2', project: PROJECT.id, session: 's1', text: 'x'.repeat(1024 * 1024) }); // fine after hello
    assert.deepEqual(await phone.next(), { t: 'ack', id: 'r2', ok: true, session: 's1', uuid: 'u1' });
    assert.deepEqual(calls, ['active', 'snapshot', 'send', 'send']);

    const wrong = openPhone(port, { 'Tailscale-User-Login': OWNER, Origin: 'https://evil.example.com' });
    await wrong.opened;
    wrong.send({ t: 'hello', v: 1, deviceId: paired.deviceId, token: paired.token });
    assert.equal((await wrong.next()).code, 'bad_origin');
    assert.equal(await wrong.closed, 4401);

    // Another window joins as a peer: both sides prove they know the secret, and it counts only then.
    const peerActive = [];
    const peer = await connectPeer({ port, secret: loadState(env).secret });
    peer.setHandler(async (/** @type {string} */ method, /** @type {any} */ args) => {
      if (method === 'active') peerActive.push(args.on);
    });
    await waitFor(() => hub.peerCount() === 1 && peerActive.length === 1, 'the peer to be registered and switched on');
    assert.equal(hub.info().windows, 2);
    // A program that does not know the secret gets the 101 and nothing after it, and is dropped.
    const stranger = await peerWithoutSecret(port);
    assert.match(stranger.head, /^HTTP\/1\.1 101 /);
    assert.equal(stranger.after, '');
    assert.equal(hub.peerCount(), 1);
    assert.equal(hub.info().windows, 2);

    await hub.close({ reason: 'disabled' });
    assert.deepEqual(await phone.next(), { t: 'error', code: 'disabled', message: 'Remote access was turned off on the Mac' });
    assert.equal(await phone.closed, 1001);
    const device = loadState(env).devices[0];
    assert.equal(device.origin, ORIGIN);
    console.log('hub smoke: ok');
  } finally {
    await hub.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

const guard = setTimeout(() => {
  console.error('hub smoke: timed out');
  process.exit(1);
}, 20_000);
guard.unref();

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
