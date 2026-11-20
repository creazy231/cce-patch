// @ts-check
'use strict';
// Web Push for the hub's notifier, on Node's built-ins alone: the message encryption (RFC 8291, with
// the aes128gcm content coding of RFC 8188), the VAPID signature (RFC 8292) and the POST to the push
// service (RFC 8030). Nothing here sends by itself and nothing is logged: sendPush is handed a stored
// subscription and answers with a status, and the notifier decides what is worth a log line.
//
// What shapes this code:
// - A message body is a 21-byte header (salt, record size, key id length), the sender's public key
//   as the key id, and one record: the payload and a 0x02 delimiter, sealed with AES-128-GCM. Push
//   services take 4096 bytes of body, which leaves 3993 bytes for the payload.
// - The key schedule is two HKDF steps. The first mixes the ECDH secret with the subscription's auth
//   secret and both public keys into one key; the second turns that and the salt into the content
//   key and the nonce.
// - A VAPID JWT is ES256 with the signature as raw r || s (`dsaEncoding: 'ieee-p1363'`), not the DER
//   that a plain sign() gives.
// - The phone names the endpoint, so the Mac must not POST wherever it says: only https, to the
//   push services' own hosts (isAllowedEndpoint). TLS checks stay on and redirects are not followed.

const crypto = require('crypto');
const https = require('https');

const RECORD_SIZE = 4096; // rs of the one record every message has
const SALT_BYTES = 16;
const TAG_BYTES = 16; // AES-GCM
const DELIMITER = 0x02; // the padding delimiter of the last record; no padding follows it
const POINT_BYTES = 65; // an uncompressed P-256 point: 0x04, x, y
const SCALAR_BYTES = 32; // x, y and d of a P-256 key
const AUTH_BYTES = 16;
// A record holds rs bytes: the payload, the delimiter and the tag.
const MAX_PAYLOAD_BYTES = RECORD_SIZE - TAG_BYTES - 1;
// What every push service accepts as a request body (RFC 8030), header and key included.
const MAX_BODY_BYTES = 4096;
// Far above the longest key (87 characters), so junk is turned away before it is decoded.
const MAX_KEY_CHARS = 200;
const MAX_ENDPOINT_CHARS = 1024;
const DEFAULT_TIMEOUT_MS = 10000;
// RFC 8292 allows a day; half of that leaves room for a clock that is off.
const DEFAULT_EXP_SECONDS = 43200;

const PUSH_HOSTS = ['fcm.googleapis.com'];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.push.services.mozilla.com', '.notify.windows.com'];
// A DNS name: non-empty labels of letters, digits and hyphens. The URL parser also lets through
// empty labels, a trailing dot and characters such as `$` and `_`; none of them is a push host.
const DNS_NAME = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;

/**
 * @typedef {{ p256dh: string, auth: string }} SubscriptionKeys
 *   What a PushSubscription's toJSON() holds: the browser's public key (the 65-byte point) and the
 *   auth secret (16 bytes), both base64url without padding.
 * @typedef {{
 *   endpoint: string,
 *   keys: SubscriptionKeys,
 *   vapid: { publicKey: string, privateJwk: import('crypto').JsonWebKey },
 *   subject: string,
 *   payload: string | Uint8Array,
 *   ttl: number,
 *   urgency?: string,
 *   topic?: string,
 * }} Push
 *   vapid is the application server key pair: the raw public key as base64url and the private key
 *   as a JWK. subject is the `https:` or `mailto:` contact. ttl is in seconds.
 * @typedef {{ ok: boolean, status: number, gone: boolean }} PushResult
 *   status is 0 when no answer came. gone means the subscription is dead (404 or 410).
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Bytes as base64url without padding.
 * @param {Uint8Array | string} bytes  text is taken as UTF-8
 * @returns {string}
 */
function b64url(bytes) {
  return Buffer.from(/** @type {any} */ (bytes)).toString('base64url');
}

/**
 * The bytes of a base64url string that holds exactly `length` of them, or null. Only the plain
 * spelling counts: Buffer's decoder skips characters it does not know and takes the other alphabet
 * and padding as well, and a browser sends none of that.
 * @param {unknown} value
 * @param {number} length
 * @returns {Buffer | null}
 */
function decodeKey(value, length) {
  if (typeof value !== 'string' || value.length > MAX_KEY_CHARS) return null;
  const bytes = Buffer.from(value, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : null;
}

/**
 * @param {unknown} keys
 * @returns {{ point: Buffer, auth: Buffer } | null}
 */
function subscriberKeys(keys) {
  if (!isRecord(keys)) return null;
  const point = decodeKey(keys.p256dh, POINT_BYTES);
  const auth = decodeKey(keys.auth, AUTH_BYTES);
  return point && auth && point[0] === 0x04 ? { point, auth } : null;
}

/**
 * Whether a subscription's keys are the shape a browser makes: p256dh decodes to 65 bytes that start
 * with 0x04 (an uncompressed point) and auth to 16 bytes, both as base64url strings of at most 200
 * characters. Whether the point lies on the curve is left to encrypt().
 * @param {unknown} keys
 * @returns {boolean}
 */
function validSubscriptionKeys(keys) {
  return subscriberKeys(keys) !== null;
}

/**
 * Whether VAPID keys are usable: publicKey decodes to a 65-byte point starting with 0x04, and
 * privateJwk is a P-256 JWK (`kty` EC, `crv` P-256, `x`, `y` and `d` of 32 bytes each; other members
 * are ignored) whose x and y are that point and whose d is its private key, and which createPrivateKey
 * takes.
 * @param {unknown} vapid
 * @returns {boolean}
 */
function validVapid(vapid) {
  if (!isRecord(vapid)) return false;
  const publicKey = decodeKey(vapid.publicKey, POINT_BYTES);
  const jwk = vapid.privateJwk;
  if (!publicKey || publicKey[0] !== 0x04 || !isRecord(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return false;
  const x = decodeKey(jwk.x, SCALAR_BYTES);
  const y = decodeKey(jwk.y, SCALAR_BYTES);
  const d = decodeKey(jwk.d, SCALAR_BYTES);
  if (!x || !y || !d || !publicKey.equals(Buffer.concat([Buffer.from([0x04]), x, y]))) return false;
  try {
    // d must belong to that public key, or every JWT signed with it would fail at the push service.
    // Node's createPrivateKey refuses a JWK whose d does not match x and y; Bun's does not.
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.setPrivateKey(d);
    if (!ecdh.getPublicKey().equals(publicKey)) return false;
    crypto.createPrivateKey({ key: /** @type {import('crypto').JsonWebKey} */ (jwk), format: 'jwk' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a push service's endpoint may be POSTed to: a string of at most 1024 characters that is an
 * https URL without a user name or password, on the default port, whose host is a DNS name under
 * `.push.apple.com`, `.push.services.mozilla.com` or `.notify.windows.com`, or is exactly
 * `fcm.googleapis.com`. The phone picks the endpoint; this is what keeps a paired phone from making
 * the Mac request an address on its network. The check reads the parsed URL, so `@`, `\`, `#` and
 * `?` in the string cannot move the host.
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedEndpoint(url) {
  if (typeof url !== 'string' || url.length > MAX_ENDPOINT_CHARS) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '') return false;
  if (parsed.port !== '' && parsed.port !== '443') return false;
  const host = parsed.hostname;
  if (!DNS_NAME.test(host)) return false;
  return PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

/**
 * Encrypts a payload for a subscription (RFC 8291 with RFC 8188's aes128gcm): the body to POST, as
 * salt (16) | rs (4, big-endian, 4096) | key id length (1, 65) | the sender's public key (65) | the
 * sealed record. The record is the payload and a 0x02 delimiter, with no padding, so a payload of
 * more than 4079 bytes does not fit and is a RangeError. Without `options` the salt and the
 * sender's key pair are fresh; they are options only so that the RFC's example can be reproduced.
 * @param {string | Uint8Array} payload  text is taken as UTF-8
 * @param {SubscriptionKeys} keys
 * @param {{ salt?: Uint8Array, serverPrivateKey?: Uint8Array }} [options]
 * @returns {Buffer}
 * @throws {TypeError} for a payload that is not text or bytes, a salt that is not 16 bytes, and keys
 *   that are not a 65-byte point starting with 0x04 and a 16-byte secret, as base64url
 * @throws {RangeError} for a payload that does not fit the record
 */
function encrypt(payload, keys, { salt, serverPrivateKey } = {}) {
  if (typeof payload !== 'string' && !(payload instanceof Uint8Array)) throw new TypeError('payload must be a string or a Buffer');
  const plaintext = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (plaintext.length > MAX_PAYLOAD_BYTES) throw new RangeError(`payload is ${plaintext.length} bytes; one record holds ${MAX_PAYLOAD_BYTES}`);
  if (salt !== undefined && (!(salt instanceof Uint8Array) || salt.length !== SALT_BYTES)) throw new TypeError(`salt must be ${SALT_BYTES} bytes`);
  const subscriber = subscriberKeys(keys);
  if (!subscriber) throw new TypeError('keys must be a p256dh of 65 bytes starting with 0x04 and an auth of 16 bytes, as base64url');

  const saltBytes = salt ? Buffer.from(salt) : crypto.randomBytes(SALT_BYTES);
  const ecdh = crypto.createECDH('prime256v1');
  if (serverPrivateKey) ecdh.setPrivateKey(serverPrivateKey);
  else ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey(); // uncompressed: 65 bytes
  const secret = ecdh.computeSecret(subscriber.point); // throws when the point is not on the curve

  /** @param {Buffer} ikm @param {Buffer} hkdfSalt @param {Buffer} info @param {number} length */
  const hkdf = (ikm, hkdfSalt, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, hkdfSalt, info, length));
  const ikm = hkdf(secret, subscriber.auth, Buffer.concat([Buffer.from('WebPush: info\0'), subscriber.point, senderPublic]), 32);
  const contentKey = hkdf(ikm, saltBytes, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(ikm, saltBytes, Buffer.from('Content-Encoding: nonce\0'), 12);

  const cipher = crypto.createCipheriv('aes-128-gcm', contentKey, nonce);
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([DELIMITER])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(SALT_BYTES + 4 + 1);
  saltBytes.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, SALT_BYTES);
  header[SALT_BYTES + 4] = senderPublic.length;
  return Buffer.concat([header, senderPublic, sealed]);
}

/**
 * The Authorization header of a push request (RFC 8292): `vapid t=<jwt>, k=<publicKey>`. The JWT is
 * ES256 over `{"typ":"JWT","alg":"ES256"}` and the claims `aud` (the endpoint's origin), `exp`
 * (`expSeconds` after `now`, 12 hours by default) and `sub`; the signature is the raw r || s.
 * @param {{
 *   endpoint: string,
 *   publicKey: string,
 *   privateJwk: import('crypto').JsonWebKey,
 *   subject: string,
 *   now?: number,
 *   expSeconds?: number,
 * }} options
 *   now is in ms since the epoch (default Date.now()). publicKey is the raw point as base64url.
 * @returns {string}
 * @throws when the endpoint is not a URL or the JWK is not a key to sign with
 */
function vapidAuthorization({ endpoint, publicKey, privateJwk, subject, now = Date.now(), expSeconds = DEFAULT_EXP_SECONDS }) {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + expSeconds, sub: subject }));
  const key = crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${publicKey}`;
}

/** @returns {PushResult} */
function failed() {
  return { ok: false, status: 0, gone: false };
}

/**
 * Sends one push: encrypts the payload for the subscription, signs for the endpoint and POSTs to it.
 * Never rejects. No answer is status 0 with `ok` and `gone` false: an endpoint the allowlist refuses
 * (nothing is requested), a push that is not usable (bad keys, a ttl that is not a whole number of
 * seconds), a body of more than 4096 bytes (also not requested), a network error and a timeout. An
 * answer is its status: `ok` for 2xx, `gone` for 404 and 410. A redirect is an answer, not followed.
 * `timeoutMs` bounds the wait for the answer, and a request still open then is destroyed.
 * @param {Push} push
 * @param {{
 *   request?: typeof https.request,
 *   timeoutMs?: number,
 *   allowEndpoint?: (url: unknown) => boolean,
 * }} [options]
 *   request: how the POST is made (tests stub it, or hand in http.request for a local server).
 *   allowEndpoint: replaces isAllowedEndpoint (same reason).
 * @returns {Promise<PushResult>}
 */
function sendPush(push, { request = https.request, timeoutMs = DEFAULT_TIMEOUT_MS, allowEndpoint = isAllowedEndpoint } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {import('http').ClientRequest | undefined} */
    let req;

    /** @param {PushResult} result */
    const settle = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    // The timer stays armed after an answer: a response whose body stalls still has to be destroyed.
    const stopTimer = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };

    try {
      const { endpoint, keys, vapid, subject, payload, ttl, urgency, topic } = push;
      if (!allowEndpoint(endpoint) || !Number.isInteger(ttl) || ttl < 0) return settle(failed());
      const body = encrypt(payload, keys);
      if (body.length > MAX_BODY_BYTES) return settle(failed());

      /** @type {Record<string, string>} */
      const headers = {
        Authorization: vapidAuthorization({ endpoint, publicKey: vapid.publicKey, privateJwk: vapid.privateJwk, subject }),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.length),
        TTL: String(ttl),
      };
      if (typeof urgency === 'string' && urgency !== '') headers.Urgency = urgency;
      if (typeof topic === 'string' && topic !== '') headers.Topic = topic;

      // Armed before the request exists, so that an answer which comes at once still stops it.
      timer = setTimeout(() => {
        settle(failed());
        req?.destroy();
      }, timeoutMs);
      timer.unref();
      req = request(new URL(endpoint), { method: 'POST', headers }, (res) => {
        res.on('error', () => {}); // the connection dropping while the body is read; the status stands
        res.on('end', stopTimer); // the answer and its body are complete
        res.on('close', stopTimer); // or the connection closed before the body ended
        res.resume(); // the body is of no use, and reading it off lets the connection go
        const status = Number(res.statusCode) || 0;
        settle({ ok: status >= 200 && status < 300, status, gone: status === 404 || status === 410 });
      });
      req.on('error', () => {
        stopTimer(); // no response will come
        settle(failed());
      });
      req.end(body);
    } catch {
      stopTimer();
      settle(failed());
    }
  });
}

module.exports = { encrypt, vapidAuthorization, sendPush, isAllowedEndpoint, validSubscriptionKeys, validVapid, b64url };
