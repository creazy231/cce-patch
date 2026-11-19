// @ts-check
'use strict';
// The hub's HTTP: just enough HTTP/1.1 for a few GET routes and two kinds of upgrade, on a plain TCP
// server. Bun's node:http hands an 'upgrade' listener a socket that neither sends nor receives (and
// the bridge's tests run under Bun), so the request head is read here: one request per connection,
// a head of at most 16 KB that has to be complete within 10 s, GET only. Every answer closes the
// connection; an upgrade is handed over untouched, with the bytes that came after its head. The
// server listens on 127.0.0.1 and nowhere else.
//
// Whoever connects has not proven anything yet, so the parser is strict (a malformed head is a 400,
// never a guess) and costs time linear in what was sent: the head is searched only where new bytes
// came in, and nothing is matched with a pattern that can backtrack.

const net = require('net');

const HEAD_LIMIT_BYTES = 16 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 256;
// How long an answered connection may take to send the answer and close before it is dropped.
const LINGER_MS = 5000;
// How long close() waits for open connections (upgraded ones included) before it drops them.
const CLOSE_GRACE_MS = 1000;

const TERMINATOR = Buffer.from('\r\n\r\n', 'latin1');
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
// Method, origin-form target (visible ASCII only) and HTTP/1.0 or 1.1, single spaces between them.
const REQUEST_LINE_RE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\/[\x21-\x7e]*) HTTP\/(1\.[01])$/;
// A field value may hold tabs, visible ASCII and obs-text, never CR, LF, NUL or another control character.
const BAD_VALUE_RE = /[\x00-\x08\x0a-\x1f\x7f]/;

/** @type {Record<number, string>} */
const STATUS_TEXT = {
  200: 'OK',
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/**
 * @typedef {{ method: string, url: string, httpVersion: string, headers: Record<string, string> }} Request
 *   headers: lower-case names on an object without a prototype (a header named `__proto__` or
 *   `constructor` is a plain key); a repeated header's values joined with ', ', as node:http does
 */

/** `text` without the spaces and tabs around it (HTTP's OWS). A loop: a regex here could backtrack. @param {string} text */
function trimOws(text) {
  let start = 0;
  let end = text.length;
  while (start < end && (text.charCodeAt(start) === 0x20 || text.charCodeAt(start) === 0x09)) start++;
  while (end > start && (text.charCodeAt(end - 1) === 0x20 || text.charCodeAt(end - 1) === 0x09)) end--;
  return text.slice(start, end);
}

/**
 * Parses a request head (the text before the blank line, decoded as latin1). Null when it is not
 * a well-formed HTTP/1.x request: a bare CR or LF, a folded line, a space before a colon, a control
 * character in a value, a target that is not a path (`/…`).
 * @param {string} text
 * @returns {Request | null}
 */
function parseHead(text) {
  const lines = text.split('\r\n');
  const match = REQUEST_LINE_RE.exec(lines[0]);
  if (!match) return null;
  /** @type {Record<string, string>} */
  const headers = Object.create(null);
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    const name = line.slice(0, colon);
    if (!TOKEN_RE.test(name)) return null; // also a folded line, or a space before the colon
    const value = trimOws(line.slice(colon + 1));
    if (BAD_VALUE_RE.test(value)) return null;
    const key = name.toLowerCase();
    const before = headers[key];
    headers[key] = before === undefined ? value : `${before}, ${value}`;
  }
  return { method: match[1], url: match[2], httpVersion: match[3], headers };
}

/**
 * Writes a complete response, which closes the connection, and closes it once it is written. Does
 * nothing when the socket is gone already.
 * @param {import('net').Socket} socket
 * @param {number} status
 * @param {{ headers?: Record<string, string>, body?: string | Buffer }} [options]
 */
function respond(socket, status, { headers = {}, body = '' } = {}) {
  if (socket.destroyed) return;
  const payload = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  let text = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Unknown'}\r\n`;
  for (const [name, value] of Object.entries(headers)) {
    if (!TOKEN_RE.test(name) || /[\r\n]/.test(value)) throw new TypeError(`not a header: ${name}`);
    text += `${name}: ${value}\r\n`;
  }
  text += `Content-Length: ${payload.length}\r\nConnection: close\r\n\r\n`;
  socket.on('error', () => {});
  const linger = setTimeout(() => socket.destroy(), LINGER_MS);
  linger.unref();
  socket.once('close', () => clearTimeout(linger));
  socket.once('finish', () => socket.destroy()); // written out: nothing more is read from this client
  socket.end(Buffer.concat([Buffer.from(text, 'latin1'), payload]));
}

/**
 * For an upgraded connection (WebSocket, peer link): destroys the socket once both directions are
 * over, the client's side ended and ours too. Node does that by itself (autoDestroy). Bun keeps
 * such a socket open, and a write still queued when the client left (the answer to its Close
 * frame) never finishes there, so the socket would stay until a timer drops it. A client of these
 * protocols that ends its side is gone, so what is still queued for it can go.
 * @param {import('net').Socket} socket
 */
function destroyWhenEnded(socket) {
  const check = () => {
    if (!socket.destroyed && socket.readableEnded && socket.writableEnded) socket.destroy();
  };
  socket.on('end', () => setImmediate(check)); // after the owner's 'end' listener has ended our side
  socket.on('finish', check);
}

/**
 * @callback RequestHandler
 * @param {Request} req  a GET request
 * @param {import('net').Socket} socket  paused: what the client sends next waits in it until the
 *   handler resumes it (or hands it to code that does). The handler owns the socket: it answers
 *   with respond(), upgrades it or destroys it.
 * @param {Buffer} head  the bytes that came after the request head
 */

/**
 * A TCP server on 127.0.0.1 that reads one request head per connection and hands GET requests to
 * the handler. It answers by itself: 400 to a malformed head, 405 to another method, 431 to a head
 * over the limit (as soon as it is over), 408 to a head that is not complete in time. A handler that
 * throws costs only its own connection (destroyed without an answer).
 */
class LiteServer {
  /**
   * @param {RequestHandler} onRequest
   * @param {{ headTimeoutMs?: number, headLimitBytes?: number, maxConnections?: number }} [options]
   */
  constructor(onRequest, { headTimeoutMs = HEAD_TIMEOUT_MS, headLimitBytes = HEAD_LIMIT_BYTES, maxConnections = MAX_CONNECTIONS } = {}) {
    this._onRequest = onRequest;
    this._headTimeoutMs = headTimeoutMs;
    this._headLimitBytes = headLimitBytes;
    /** @type {Set<import('net').Socket>} every connection that is still open, upgraded ones included */
    this._sockets = new Set();
    /** @type {(() => void) | null} */
    this._onIdle = null;
    /** @type {Promise<void> | null} */
    this._closing = null;
    /** The TCP server (for its address). */
    this.server = net.createServer((socket) => this._onConnection(socket));
    this.server.maxConnections = maxConnections;
    this.server.on('error', () => {}); // listen() reports its own errors; an accept error leaves the server listening
  }

  /** The port it listens on; 0 before listen(). */
  get port() {
    const address = this.server.address();
    return address && typeof address === 'object' ? address.port : 0;
  }

  /**
   * Listens on 127.0.0.1:`port` (0: a free port). Rejects with the socket error, `code` EADDRINUSE
   * when the port is taken, and with `closed` after close().
   * @param {number} port
   * @returns {Promise<void>}
   */
  listen(port) {
    return new Promise((resolve, reject) => {
      if (this._closing) {
        reject(Object.assign(new Error('closed'), { code: 'closed' }));
        return;
      }
      const server = this.server;
      /** @param {Error} error */
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ port, host: '127.0.0.1' });
    });
  }

  /**
   * Stops listening, and resolves once every connection is closed: the ones still open after
   * `graceMs` (upgraded ones included) are dropped then. Calling it again returns the same promise.
   * @param {number} [graceMs]
   * @returns {Promise<void>}
   */
  close(graceMs = CLOSE_GRACE_MS) {
    if (this._closing) return this._closing;
    this._closing = new Promise((resolve) => {
      let serverClosed = false;
      const grace = setTimeout(() => {
        for (const socket of this._sockets) socket.destroy();
      }, graceMs);
      grace.unref();
      const done = () => {
        if (!serverClosed || this._sockets.size > 0) return;
        clearTimeout(grace);
        this._onIdle = null;
        resolve();
      };
      this._onIdle = done;
      const closed = () => {
        serverClosed = true;
        done();
      };
      if (this.server.listening) this.server.close(closed);
      else closed();
    });
    return this._closing;
  }

  /** @private @param {import('net').Socket} socket */
  _onConnection(socket) {
    if (this._closing) {
      socket.destroy();
      return;
    }
    this._sockets.add(socket);
    socket.on('close', () => {
      this._sockets.delete(socket);
      if (this._onIdle && this._sockets.size === 0) this._onIdle();
    });
    socket.on('error', () => {}); // 'close' follows

    // The head so far is buffer[0 .. length]; the buffer doubles as it fills, so a client that sends
    // one byte at a time costs no more copying than one that sends the head at once.
    let buffer = Buffer.allocUnsafe(1024);
    let length = 0;
    let finished = false;

    /** Stops reading the head, then `then` decides what happens to the socket. @param {() => void} then */
    const finish = (then) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.pause();
      then();
    };
    const timer = setTimeout(() => finish(() => respond(socket, 408)), this._headTimeoutMs);
    timer.unref();
    socket.once('close', () => clearTimeout(timer)); // a client that vanished mid-head (a reset brings no 'end')
    const onEnd = () => finish(() => socket.destroy()); // the client gave up before its head was complete

    /** @param {Buffer} chunk */
    const onData = (chunk) => {
      if (length + chunk.length > buffer.length) {
        const grown = Buffer.allocUnsafe(Math.max(buffer.length * 2, length + chunk.length));
        buffer.copy(grown, 0, 0, length);
        buffer = grown;
      }
      chunk.copy(buffer, length);
      const searchFrom = Math.max(0, length - (TERMINATOR.length - 1)); // a terminator may start in the bytes before this chunk
      length += chunk.length;
      const end = buffer.subarray(0, length).indexOf(TERMINATOR, searchFrom);
      if (end === -1) {
        if (length >= this._headLimitBytes) finish(() => respond(socket, 431)); // a terminator could only end past the limit
        return;
      }
      if (end + TERMINATOR.length > this._headLimitBytes) {
        finish(() => respond(socket, 431));
        return;
      }
      const req = parseHead(buffer.toString('latin1', 0, end));
      const head = buffer.subarray(end + TERMINATOR.length, length);
      finish(() => {
        if (!req) return respond(socket, 400);
        if (req.method !== 'GET') return respond(socket, 405, { headers: { Allow: 'GET' } });
        try {
          this._onRequest(req, socket, head);
        } catch {
          socket.destroy();
        }
      });
    };
    socket.on('data', onData);
    socket.on('end', onEnd);
  }
}

module.exports = { LiteServer, respond, destroyWhenEnded, parseHead, HEAD_LIMIT_BYTES, HEAD_TIMEOUT_MS };
