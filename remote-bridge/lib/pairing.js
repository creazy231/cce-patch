// @ts-check
'use strict';
// Pairing a phone: a short code that the person types or scans, then a long token that the phone
// keeps. The code is single use, runs out after ten minutes and is burnt by five wrong tries. The
// token is 32 random bytes; the state file keeps only its SHA-256, so a copy of that file is no
// token. Nothing here touches the disk or the network: the hub owns when a code is made and
// where a device is stored.

const { createHash, randomBytes, randomInt, timingSafeEqual } = require('crypto');

// 31 characters: no 0, 1, I, L or O, which look alike on a phone screen
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const DEVICE_NAME_MAX_CHARS = 60;
const DEFAULT_DEVICE_NAME = 'Phone';
// A real token is 43 characters; anything much longer is not worth hashing.
const MAX_TOKEN_LENGTH = 256;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/i;
// The origin of a link without an app URL: reserved by RFC 2606, so it never resolves.
const PLACEHOLDER_APP_URL = 'https://cce-remote.invalid';
const NOT_IN_ALPHABET = new RegExp(`[^${CODE_ALPHABET}]`, 'g');

/**
 * What a person typed, as a code: upper case, everything outside the alphabet dropped (spaces, the
 * dash of `XXXX-XXXX`, and the look-alikes 0 1 I L O, which no code holds). Only ASCII letters are
 * folded: the German sharp s upper-cases to 'SS', which must not turn into a code. Anything but
 * text is empty.
 * @param {unknown} input
 */
function normalizeCode(input) {
  if (typeof input !== 'string') return '';
  return input.replace(/[a-z]/g, (letter) => letter.toUpperCase()).replace(NOT_IN_ALPHABET, '');
}

/** `ABCDEFGH` as `ABCD-EFGH`, the way the code is shown. @param {string} code */
function formatCode(code) {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Whether two strings are equal, without telling through timing where they first differ. @param {string} a @param {string} b */
function safeEqual(a, b) {
  const digest = (/** @type {string} */ text) => createHash('sha256').update(text).digest(); // equal lengths, whatever the inputs
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * The one pairing code a hub shows at a time. Times are milliseconds since the epoch and are
 * passed in (default: now) so that a test can move the clock.
 */
class Pairing {
  constructor() {
    /** @type {{ code: string, expiresAt: number, attempts: number } | null} */
    this._code = null;
  }

  /**
   * Makes a new code, which replaces the one before it (and its count of wrong tries).
   * @param {number} [now]
   * @returns {{ code: string, expiresAt: number }}
   */
  newCode(now = Date.now()) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = now + CODE_TTL_MS;
    this._code = { code, expiresAt, attempts: 0 };
    return { code, expiresAt };
  }

  /**
   * The code that can still be used, or null: none was made, it was used, it ran out of tries or
   * `now` is past its expiry.
   * @param {number} [now]
   * @returns {{ code: string, expiresAt: number } | null}
   */
  current(now = Date.now()) {
    const live = this._live(now);
    return live ? { code: live.code, expiresAt: live.expiresAt } : null;
  }

  /**
   * Whether `input` (as typed, see normalizeCode) is the current code. The right code is used up
   * by this: it works once. Every other try, including input that is no text, counts as wrong, and
   * the fifth wrong one burns the code for good, so that the right one fails afterwards.
   * @param {unknown} input
   * @param {number} [now]
   */
  consume(input, now = Date.now()) {
    const live = this._live(now);
    if (live === null) return false;
    if (safeEqual(normalizeCode(input), live.code)) {
      this._code = null;
      return true;
    }
    live.attempts++;
    if (live.attempts >= MAX_ATTEMPTS) this._code = null;
    return false;
  }

  /** The code if it is still good (an expired one is dropped for good). @private @param {number} now */
  _live(now) {
    const live = this._code;
    if (live === null) return null;
    // Written as a negation so that a `now` that is no number counts as expired: a check on the clock fails closed.
    if (!(now <= live.expiresAt)) {
      this._code = null;
      return null;
    }
    return live;
  }
}

/** The token's SHA-256 as hex: what the state file keeps instead of the token. @param {string} token */
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * A device name as the phone sent it: trimmed, at most 60 characters (counted by code point, so a
 * cut never leaves half a surrogate pair), 'Phone' when nothing is left.
 * @param {unknown} name
 */
function deviceName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  // Two UTF-16 units per character at most, so the string is cut before it is split into characters.
  const cut = Array.from(trimmed.slice(0, DEVICE_NAME_MAX_CHARS * 2)).slice(0, DEVICE_NAME_MAX_CHARS).join('').trim();
  return cut || DEFAULT_DEVICE_NAME;
}

/**
 * A newly paired device. `token` goes to the phone, once; the device record (what the state file
 * keeps) holds only its hash.
 * @param {{ name?: unknown, origin?: unknown, now?: number }} [options]  `origin` is the WebSocket Origin of the pairing, which later connections must repeat
 * @returns {{ device: import('./store.js').Device, token: string }}
 */
function createDevice({ name, origin, now = Date.now() } = {}) {
  const token = randomBytes(32).toString('base64url');
  const device = {
    id: randomBytes(8).toString('hex'),
    name: deviceName(name),
    tokenHash: hashToken(token),
    origin: typeof origin === 'string' ? origin : '',
    createdAt: now,
    lastSeenAt: now,
  };
  return { device, token };
}

/**
 * Whether `token` is the token the device was made with: its hash against the stored one, compared
 * in constant time. False (never a throw) for a token of any other length or type, and for a
 * device without a usable hash.
 * @param {{ tokenHash?: unknown } | null | undefined} device
 * @param {unknown} token
 */
function verifyToken(device, token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) return false;
  const stored = device ? device.tokenHash : undefined;
  if (typeof stored !== 'string' || !SHA256_HEX_RE.test(stored)) return false;
  return timingSafeEqual(Buffer.from(stored, 'hex'), createHash('sha256').update(token).digest());
}

/**
 * The link the Connection tab shows as a QR code: the app's address, and in its fragment (which no
 * server ever sees) the Mac's URL, the code and the Mac's name as base64url JSON. Without an app
 * URL the origin is a placeholder that does not resolve; the app can still read the fragment from
 * a pasted link.
 * @param {{ appUrl?: string, url: string, code: string, macName: string }} options
 */
function pairingLink({ appUrl, url, code, macName }) {
  const base = (typeof appUrl === 'string' && appUrl !== '' ? appUrl : PLACEHOLDER_APP_URL).replace(/\/+$/, '');
  const payload = JSON.stringify({ v: 1, u: url, c: code, n: macName });
  return `${base}/#pair=${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

module.exports = { CODE_ALPHABET, CODE_TTL_MS, MAX_ATTEMPTS, Pairing, formatCode, normalizeCode, createDevice, hashToken, verifyToken, pairingLink };
