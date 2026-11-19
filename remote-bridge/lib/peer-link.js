// @ts-check
'use strict';
// The link between the bridge's windows: newline-delimited JSON over a local TCP connection that
// was upgraded with `Upgrade: cce-peer`. One window is the hub and listens; the others connect to
// it. Both ends can call the other, answer, and send events:
//   {t:'call', id, m, a}       a request: method m with arguments a
//   {t:'ret', id, ok, v | e}   its answer: the value v, or the error message e
//   {t:'evt', e, d}            a one-way event: name e, data d
// JSON never holds a raw newline (it escapes them inside strings), so a line is a message.
//
// Whatever holds 127.0.0.1:<port> may be another program (another macOS account, a sandboxed app,
// a container that publishes the port), and so may whatever connects to it. So each side proves
// that it knows the secret in state.json (which only the user can read) without sending it: a
// challenge-response both ways, with HMAC-SHA256 keyed with the secret (its hex text as stored).
//   peer → hub  GET /_peer, `Upgrade: cce-peer`, `X-CCE-Nonce: <peer nonce>`
//   hub → peer  101, `X-CCE-Nonce: <hub nonce>`,
//               `X-CCE-Proof: hex(HMAC(secret, "hub\n" + peer nonce + "\n" + hub nonce))`
//   peer → hub  its first line: {t:'auth', proof: hex(HMAC(secret, "peer\n" + peer nonce + "\n" + hub nonce))}
// A nonce is 32 random bytes as hex, new for every connection; the side's name in the message
// keeps one side's proof from serving as the other's. The peer drops a hub whose proof is missing
// or wrong before it sends a single line; the hub's end reads nothing but the peer's proof, sends
// nothing, and becomes a link (`auth`) only once the proof matches.

const net = require('net');
const { EventEmitter } = require('events');
const { createHmac, randomBytes, timingSafeEqual } = require('crypto');

const UPGRADE_PROTOCOL = 'cce-peer';
// A phone can send up to 8 MB of images, which the hub passes on as one call; a line past this
// is not a message of ours, and the link is dropped instead of buffering it.
const MAX_LINE_BYTES = 64 * 1024 * 1024;
// Before its proof a peer sends one line of about a hundred bytes.
const MAX_AUTH_LINE_BYTES = 1024;
const MAX_RESPONSE_HEAD_BYTES = 16 * 1024;
// How long close() waits for the other side to close its end before the socket is dropped.
const CLOSE_TIMEOUT_MS = 3000;
// How long the hub's end waits for the peer's proof.
const AUTH_TIMEOUT_MS = 5000;
// A nonce, and a proof (a SHA-256 HMAC), as lower-case hex.
const HEX_32_BYTES_RE = /^[0-9a-f]{64}$/;

/** @typedef {{ method?: string, headers?: Record<string, string | string[] | undefined> }} UpgradeRequest */

/** An Error whose `code` is its message: the failures a caller tells apart (closed, timeout, refused, ...). @param {string} code */
function localError(code) {
  return Object.assign(new Error(code), { code });
}

/** @param {unknown} error */
function errorMessage(error) {
  return String(error && typeof error === 'object' && 'message' in error ? error.message : error);
}

/** A nonce: 32 random bytes as hex. */
function newNonce() {
  return randomBytes(32).toString('hex');
}

/** @param {unknown} value @returns {value is string} */
function isNonce(value) {
  return typeof value === 'string' && HEX_32_BYTES_RE.test(value);
}

/**
 * The proof that `side` knows the secret, for one connection: hex HMAC-SHA256, keyed with the
 * secret, of `<side>\n<peer nonce>\n<hub nonce>`.
 * @param {string} secret @param {'hub' | 'peer'} side @param {string} peerNonce @param {string} hubNonce
 */
function proofOf(secret, side, peerNonce, hubNonce) {
  return createHmac('sha256', secret).update(`${side}\n${peerNonce}\n${hubNonce}`).digest('hex');
}

/** Whether `given` is the `expected` proof, compared in constant time. @param {unknown} given @param {string} expected */
function proofMatches(given, expected) {
  if (typeof given !== 'string' || !HEX_32_BYTES_RE.test(given)) return false;
  const a = Buffer.from(given, 'latin1');
  const b = Buffer.from(expected, 'latin1');
  return a.length === b.length && timingSafeEqual(a, b); // timingSafeEqual throws on different lengths
}

/**
 * One end of a peer link. Events: `event(name, data)` for each event the other side notified,
 * `close()` once the link is gone (whoever closed it), and on the hub's end `auth()` once the peer
 * proved that it knows the secret. Attach the listeners and the handler in the same synchronous run
 * that gets the link: right after `await connectPeer(...)`, or, on the hub's end, in the `auth`
 * event. Nothing is read before the next turn of the event loop, and the lines behind the proof are
 * read right after `auth`, so whatever the other side sent first (a hello, a first call) reaches
 * them, in order.
 */
class PeerLink extends EventEmitter {
  /**
   * @param {import('net').Socket} socket  upgraded already
   * @param {Buffer} [head]  bytes that came with the upgrade
   * @param {{ proof: string, timeoutMs?: number }} [auth]  the hub's end (acceptPeer): the proof the
   *   peer's first line must carry. Until it came the link reads nothing else and sends nothing; a
   *   first line without it, one over 1 KB, or none within `timeoutMs` (5 s) closes the link.
   */
  constructor(socket, head, auth) {
    super();
    this._socket = socket;
    /** @type {((method: string, args: any) => any) | null} */
    this._handler = null;
    this._lastId = 0;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void, timer: NodeJS.Timeout }>} */
    this._pending = new Map();
    /** @type {Buffer[]} the line being received, as far as it has arrived */
    this._parts = [];
    this._partBytes = 0;
    this._closed = false;
    this._closeEmitted = false;
    /** @type {NodeJS.Timeout | undefined} */
    this._closeTimer = undefined;
    /** @type {string | null} the proof the other side's first line must carry; null once it did, or when none is asked for */
    this._expectedProof = auth ? auth.proof : null;
    /** @type {NodeJS.Timeout | undefined} */
    this._authTimer = undefined;
    if (auth) {
      this._authTimer = setTimeout(() => this._abort(), auth.timeoutMs ?? AUTH_TIMEOUT_MS);
      this._authTimer.unref();
    }

    socket.setNoDelay(true);
    // The socket can be gone already when a caller accepts after an async check: it never emits 'close' then.
    if (socket.destroyed) process.nextTick(() => this._onSocketClosed());
    // The caller needs a turn to attach its listeners and handler. acceptPeer hands the link to
    // synchronous code, but connectPeer resolves a promise, whose continuation runs after a tick
    // queued from here, so a tick would deliver the upgrade's bytes to nobody. The socket waits
    // paused instead (what it reads in the meantime is held, in order), and the next turn of the
    // event loop delivers the upgrade's bytes first and then lets the rest through.
    socket.pause();
    socket.on('data', (chunk) => this._onData(/** @type {Buffer} */ (chunk)));
    socket.on('end', () => this.close()); // the other side is done sending: finish ours too
    socket.on('close', () => this._onSocketClosed());
    socket.on('error', () => {}); // 'close' follows
    setImmediate(() => {
      try {
        if (head && head.length > 0) this._onData(head);
      } finally {
        socket.resume(); // also when a listener threw, or the link was closed already: the socket is drained, not left paused
      }
    });
  }

  /** Whether the other side may use the link: always on the peer's end, on the hub's once the peer proved itself. */
  get authenticated() {
    return this._expectedProof === null;
  }

  /**
   * Calls a method on the other side. Rejects with the handler's error message, with `no_handler`
   * when the other side has no handler, `timeout` when no answer comes in time, `closed` when the
   * link is closed (or closes first), and `not_authenticated` before the peer proved itself.
   * @param {string} method
   * @param {any} [args]  anything JSON can carry
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<any>}
   */
  call(method, args, { timeoutMs = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      if (this._closed) return reject(localError('closed'));
      if (this._expectedProof !== null) return reject(localError('not_authenticated'));
      const id = ++this._lastId;
      const line = JSON.stringify({ t: 'call', id, m: method, a: args }); // throws for what JSON cannot carry: a rejection
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(localError('timeout'));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      this._socket.write(`${line}\n`);
    });
  }

  /**
   * Sends an event. Returns false (and sends nothing) when the link is closed, the peer has not
   * proved itself yet, or `data` is not JSON.
   * @param {string} event
   * @param {any} [data]
   */
  notify(event, data) {
    return this._write({ t: 'evt', e: event, d: data });
  }

  /**
   * Answers the other side's calls: the returned (or resolved) value is the result, a throw or
   * rejection the error. Without a handler every call fails with `no_handler`.
   * @param {(method: string, args: any) => any} handler
   */
  setHandler(handler) {
    this._handler = handler;
  }

  /** Closes the link after what was written has gone out; pending calls reject with `closed`. */
  close() {
    if (this._closed) return;
    this._closed = true;
    this._rejectPending();
    // end() sends what is queued, then FIN, and the other side closes its end in answer. The socket
    // is not destroyed before that: closing it while the other side is still sending would reset
    // the connection, which can take our last lines away from it. The timer is for a side that
    // never closes.
    this._socket.end();
    this._closeTimer = setTimeout(() => this._socket.destroy(), CLOSE_TIMEOUT_MS);
    this._closeTimer.unref();
  }

  /** @private @param {object} message */
  _write(message) {
    if (this._closed || this._expectedProof !== null) return false;
    let line;
    try {
      line = JSON.stringify(message);
    } catch {
      return false;
    }
    this._socket.write(`${line}\n`);
    return true;
  }

  /** @private */
  _rejectPending() {
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      reject(localError('closed'));
    }
    this._pending.clear();
  }

  /** Drops the link at once: the other side did not prove itself. @private */
  _abort() {
    if (this._closed) return;
    this._closed = true;
    clearTimeout(this._authTimer);
    this._rejectPending();
    this._socket.destroy(); // 'close' follows
  }

  /** @private */
  _onSocketClosed() {
    this._closed = true;
    clearTimeout(this._closeTimer);
    clearTimeout(this._authTimer);
    this._rejectPending();
    if (this._closeEmitted) return;
    this._closeEmitted = true;
    this.emit('close');
  }

  /** @private @param {Buffer} chunk */
  _onData(chunk) {
    let thrown = false;
    let error;
    let start = 0;
    while (start < chunk.length && !this._closed) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) {
        this._parts.push(chunk.subarray(start));
        this._partBytes += chunk.length - start;
        if (this._expectedProof !== null ? this._partBytes > MAX_AUTH_LINE_BYTES : this._partBytes > MAX_LINE_BYTES) this._abort();
        break;
      }
      this._parts.push(chunk.subarray(start, newline));
      const line = this._parts.length === 1 ? this._parts[0] : Buffer.concat(this._parts);
      this._parts = [];
      this._partBytes = 0;
      try {
        this._onLine(line);
      } catch (e) {
        // An `event` listener threw. Keep reading: the lines behind it, answers included, must not be lost.
        if (!thrown) {
          thrown = true;
          error = e;
        }
      }
      start = newline + 1;
    }
    if (thrown) throw error; // as any listener error would surface
  }

  /** Blank lines, text that is not JSON and messages of an unknown kind are skipped. @private @param {Buffer} line */
  _onLine(line) {
    if (this._expectedProof !== null) {
      this._onProof(line);
      return;
    }
    let message;
    try {
      message = JSON.parse(line.toString('utf8'));
    } catch {
      return;
    }
    if (message === null || typeof message !== 'object') return;
    if (message.t === 'call') this._onCall(message);
    else if (message.t === 'ret') this._onRet(message);
    else if (message.t === 'evt' && typeof message.e === 'string') this.emit('event', message.e, message.d);
  }

  /**
   * The peer's first line, on the hub's end: its proof, or the end of the link. Nothing else counts
   * before it: no call is answered, no event delivered.
   * @private @param {Buffer} line
   */
  _onProof(line) {
    let message;
    try {
      message = line.length <= MAX_AUTH_LINE_BYTES ? JSON.parse(line.toString('utf8')) : null;
    } catch {
      message = null;
    }
    const expected = /** @type {string} */ (this._expectedProof);
    if (message === null || typeof message !== 'object' || message.t !== 'auth' || !proofMatches(message.proof, expected)) {
      this._abort();
      return;
    }
    this._expectedProof = null;
    clearTimeout(this._authTimer);
    this.emit('auth');
  }

  /** @private @param {{ id?: unknown, m?: unknown, a?: any }} message */
  _onCall({ id, m, a }) {
    if (typeof id !== 'number' || typeof m !== 'string') return;
    const handler = this._handler;
    if (!handler) {
      this._write({ t: 'ret', id, ok: false, e: 'no_handler' });
      return;
    }
    // An async wrapper: a handler that throws before it returns anything becomes a rejection too.
    (async () => handler(m, a))().then(
      (v) => {
        if (!this._write({ t: 'ret', id, ok: true, v })) this._write({ t: 'ret', id, ok: false, e: 'unserializable_result' });
      },
      (error) => {
        this._write({ t: 'ret', id, ok: false, e: errorMessage(error) });
      },
    );
  }

  /** @private @param {{ id?: unknown, ok?: unknown, v?: any, e?: unknown }} message */
  _onRet({ id, ok, v, e }) {
    if (typeof id !== 'number') return;
    const pending = this._pending.get(id);
    if (!pending) return; // it timed out already, or was never ours
    this._pending.delete(id);
    clearTimeout(pending.timer);
    if (ok) pending.resolve(v);
    else pending.reject(new Error(typeof e === 'string' ? e : 'error'));
  }
}

/**
 * Answers the bodyless error response, then closes the socket once it is written.
 * @param {import('net').Socket} socket
 * @param {string} status  for example '403 Forbidden'
 */
function refuse(socket, status) {
  socket.on('error', () => {});
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * `text` without the spaces and tabs around it. A loop: what holds the port may be any program, and
 * a pattern such as /[ \t]+$/ backtracks over a long run of spaces inside a value.
 * @param {string} text
 */
function trimOws(text) {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09)) start++;
  while (end > start && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end--;
  return text.slice(start, end);
}

/**
 * The status line and header fields of a response head; null when a line is not a header field.
 * @param {string} text  the head without its blank line, as latin1
 * @returns {{ status: string, fields: Map<string, string[]> } | null}  field names in lower case
 */
function responseHead(text) {
  const [status, ...lines] = text.split('\r\n');
  /** @type {Map<string, string[]>} */
  const fields = new Map();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    const name = line.slice(0, colon).toLowerCase();
    const value = trimOws(line.slice(colon + 1));
    const values = fields.get(name);
    if (values) values.push(value);
    else fields.set(name, [value]);
  }
  return { status, fields };
}

/** The field's value when the head has it exactly once. @param {Map<string, string[]>} fields @param {string} name */
function single(fields, name) {
  const values = fields.get(name);
  return values && values.length === 1 ? values[0] : undefined;
}

/**
 * Accepts a peer's `Upgrade: cce-peer` request on the hub: answers 101 with the hub's nonce and
 * proof, and returns the hub's end of the link, which waits for the peer's proof (see PeerLink):
 * attach the listeners and the handler in its `auth` event, and count the peer as one of ours only
 * then. It answers 403 and closes the socket (returning null) without a nonce (`X-CCE-Nonce`, 32
 * bytes as hex), without a secret to prove, or when any `Tailscale-*` header is present: `tailscale
 * serve` adds those to requests from the tailnet, which must never reach this path. A request with
 * another Upgrade is a 400.
 * @param {UpgradeRequest} req
 * @param {import('net').Socket} socket
 * @param {Buffer} head  the bytes the http parser read past the request head
 * @param {string} secret
 * @param {{ authTimeoutMs?: number }} [options]  how long the peer has for its proof (5 s)
 * @returns {PeerLink | null}
 */
function acceptPeer(req, socket, head, secret, { authTimeoutMs = AUTH_TIMEOUT_MS } = {}) {
  const headers = req.headers ?? {};
  if (String(headers.upgrade ?? '').toLowerCase() !== UPGRADE_PROTOCOL) {
    refuse(socket, '400 Bad Request');
    return null;
  }
  const viaTailscale = Object.keys(headers).some((name) => name.toLowerCase().startsWith('tailscale-'));
  const peerNonce = headers['x-cce-nonce'];
  if (viaTailscale || typeof secret !== 'string' || secret === '' || !isNonce(peerNonce)) {
    refuse(socket, '403 Forbidden');
    return null;
  }
  const hubNonce = newNonce();
  const proof = proofOf(secret, 'hub', peerNonce, hubNonce);
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: ${UPGRADE_PROTOCOL}\r\nConnection: Upgrade\r\nX-CCE-Nonce: ${hubNonce}\r\nX-CCE-Proof: ${proof}\r\n\r\n`);
  return new PeerLink(socket, head, { proof: proofOf(secret, 'peer', peerNonce, hubNonce), timeoutMs: authTimeoutMs });
}

/**
 * Connects to the hub, upgrades the connection and proves this side knows the secret, once the
 * hub proved it does. Rejects with an Error whose message (and `code`) is the socket error code
 * such as `ECONNREFUSED`, `refused` when the answer is anything but a 101 with the hub's proof (a
 * program that is not a hub of ours: nothing more is sent to it), `timeout` when it does not answer
 * within timeoutMs, or `bad_secret` without a secret. On success the proof is the first line on the
 * link; attach the link's listeners and handler right after the `await` (see PeerLink).
 * @param {{ port: number, secret: string, host?: string, timeoutMs?: number }} options
 * @returns {Promise<PeerLink>}
 */
function connectPeer({ port, secret, host = '127.0.0.1', timeoutMs = 3000 }) {
  return new Promise((resolve, reject) => {
    if (typeof secret !== 'string' || secret === '') {
      reject(localError('bad_secret'));
      return;
    }
    const peerNonce = newNonce();
    const socket = net.connect({ host, port });
    let answer = Buffer.alloc(0);
    let settled = false;
    const timer = setTimeout(() => fail('timeout'), timeoutMs);

    /** @param {string} code */
    function fail(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(localError(code));
    }

    /** @param {Buffer} chunk */
    function onData(chunk) {
      answer = Buffer.concat([answer, chunk]);
      const end = answer.indexOf('\r\n\r\n');
      if (end === -1) {
        if (answer.length > MAX_RESPONSE_HEAD_BYTES) fail('refused');
        return;
      }
      const response = responseHead(answer.subarray(0, end).toString('latin1'));
      const hubNonce = response ? single(response.fields, 'x-cce-nonce') : undefined;
      const upgraded = response !== null && /^HTTP\/1\.[01] 101\b/.test(response.status) && single(response.fields, 'upgrade')?.toLowerCase() === UPGRADE_PROTOCOL;
      if (!upgraded || !isNonce(hubNonce) || !proofMatches(single(response.fields, 'x-cce-proof'), proofOf(secret, 'hub', peerNonce, hubNonce))) {
        fail('refused');
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
      // The proof goes first: nothing the caller writes once it has the link can overtake it.
      socket.write(`${JSON.stringify({ t: 'auth', proof: proofOf(secret, 'peer', peerNonce, hubNonce) })}\n`);
      resolve(new PeerLink(socket, answer.subarray(end + 4)));
    }

    /** @param {Error & { code?: string }} error */
    function onError(error) {
      fail(error.code ?? 'error');
    }

    function onClose() {
      fail('refused'); // hung up without the upgrade
    }

    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
    socket.on('connect', () => {
      socket.write(`GET /_peer HTTP/1.1\r\nHost: ${host}:${port}\r\nConnection: Upgrade\r\nUpgrade: ${UPGRADE_PROTOCOL}\r\nX-CCE-Nonce: ${peerNonce}\r\n\r\n`);
    });
  });
}

module.exports = { PeerLink, acceptPeer, connectPeer, AUTH_TIMEOUT_MS };
