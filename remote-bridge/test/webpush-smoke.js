// @ts-check
'use strict';
// Web Push under real Node, the runtime of the extension host (the bun tests run it under Bun):
// the RFC 8291 §5 example is encrypted byte for byte, and one push goes through the real
// http.request to a loopback server standing in for a push service, where its body is decrypted
// with the subscriber's own keys. Nothing touches the real network.
//
//   node remote-bridge/test/webpush-smoke.js     → prints "webpush smoke: ok" and exits 0, or the failure and 1
//
// webpush.test.ts runs it ("under real Node").

const assert = require('assert/strict');
const crypto = require('crypto');
const http = require('http');
const { encrypt, sendPush } = require('../lib/webpush.js');

const b = (/** @type {string} */ text) => Buffer.from(text, 'base64url');

/** A push subscription's keys: a P-256 key pair and a 16-byte auth secret. */
function makeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const publicKey = ecdh.getPublicKey();
  return {
    privateKey: ecdh.getPrivateKey(),
    publicKey,
    auth,
    keys: { p256dh: publicKey.toString('base64url'), auth: auth.toString('base64url') },
  };
}

/** VAPID keys: the raw public key and the private key as a JWK. */
function makeVapid() {
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), b(privateJwk.x), b(privateJwk.y)]).toString('base64url');
  return { publicKey, privateJwk };
}

/** The browser's side of RFC 8291: opens an aes128gcm body with the subscriber's private key. */
function decrypt(body, subscriber) {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(subscriber.privateKey);
  const secret = ecdh.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), subscriber.publicKey, senderPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, subscriber.auth, info, 32));
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  assert.equal(record[record.length - 1], 0x02);
  return record.subarray(0, record.length - 1);
}

/** The RFC 8291 §5 example, byte for byte. */
function checkVector() {
  const body = encrypt(
    b('V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24'),
    { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
    { salt: b('DGv6ra1nlYgDCS1FRnbzlw'), serverPrivateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw') },
  );
  assert.equal(
    body.toString('base64url'),
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
  );
}

/** One push through http.request to a loopback server, decrypted with the subscriber's keys. */
async function checkLoopbackPush() {
  const subscriber = makeSubscriber();
  const vapid = makeVapid();
  const payload = JSON.stringify({ v: 1, kind: 'test', title: 'CCE Remote', body: 'Notifications work.', tag: 'cce-test', url: '/', mac: 'smoke-device', badge: 0 });
  /** @type {{ url: string, headers: Record<string, string>, body: Buffer } | null} */
  let received = null;
  const server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received = { url: String(req.url), headers: /** @type {Record<string, string>} */ (req.headers), body: Buffer.concat(chunks) };
      res.statusCode = 201;
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const endpoint = `http://127.0.0.1:${address.port}/push/abc`;
  try {
    const result = await sendPush(
      { endpoint, keys: subscriber.keys, vapid, subject: 'https://app.example.test', payload, ttl: 60, urgency: 'high' },
      { request: http.request, allowEndpoint: () => true },
    );
    assert.deepEqual(result, { ok: true, status: 201, gone: false });
    assert.ok(received, 'the server received the push');
    assert.equal(received.url, '/push/abc');
    assert.equal(received.headers.ttl, '60');
    assert.equal(received.headers.urgency, 'high');
    assert.match(String(received.headers.authorization), /^vapid t=/);
    assert.equal(decrypt(received.body, subscriber).toString('utf8'), payload);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(undefined)));
  }
}

async function main() {
  checkVector();
  await checkLoopbackPush();
  console.log('webpush smoke: ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
