// @ts-check
'use strict';
// A minimal RFC 6455 WebSocket server for the bridge: the handshake and the frames, nothing more.
// Text messages only (a binary frame closes the connection with 1003), no extensions, no
// subprotocols. It takes what an http server's 'upgrade' event hands over, `(req, socket, head)`,
// so it needs no dependency and runs inside the extension host.

const { createHash } = require('crypto');
const { EventEmitter } = require('events');
const { TextDecoder } = require('util');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_MAX_PAYLOAD = 8 * 1024 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 3000;
// A message split into more frames than this is refused. Phones send whole messages; the limit
// keeps a stream of one-byte fragments from costing far more memory than maxPayload suggests.
const MAX_FRAGMENTS = 4096;
// The receive buffer starts at INITIAL_CAPACITY bytes and doubles as needed. When it is empty again
// one larger than RETAINED_CAPACITY is let go, so an idle connection does not hold a big frame's worth.
const INITIAL_CAPACITY = 4096;
const RETAINED_CAPACITY = 64 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const EMPTY = Buffer.alloc(0);
// Strict, so invalid UTF-8 is an error instead of U+FFFD; ignoreBOM keeps a leading U+FEFF in the text.
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** @typedef {{ method?: string, headers?: Record<string, string | string[] | undefined> }} UpgradeRequest */

/**
 * Whether a comma-separated header such as `Connection: keep-alive, Upgrade` lists a token.
 * @param {string | string[] | undefined} header
 * @param {string} token  lower case
 */
function hasToken(header, token) {
  return String(header ?? '').split(',').some((part) => part.trim().toLowerCase() === token);
}

/** @param {UpgradeRequest} req */
function isWebSocketUpgrade(req) {
  const headers = req.headers ?? {};
  const key = headers['sec-websocket-key'];
  return req.method === 'GET'
    && hasToken(headers.upgrade, 'websocket')
    && hasToken(headers.connection, 'upgrade')
    && headers['sec-websocket-version'] === '13'
    && typeof key === 'string'
    && /^[+/0-9A-Za-z]{22}==$/.test(key); // 16 random bytes, base64 (RFC 6455 section 4.1)
}

/**
 * Answers with a bodyless error response, then closes the socket once the response is written.
 * @param {import('net').Socket} socket
 * @param {string} status  for example '400 Bad Request'
 */
function refuse(socket, status) {
  socket.on('error', () => {});
  socket.once('finish', () => socket.destroy());
  socket.end(`HTTP/1.1 ${status}\r\nSec-WebSocket-Version: 13\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/**
 * Completes the handshake for an http 'upgrade' request and returns the connection. When the
 * request is not a version 13 WebSocket upgrade it answers 400, closes the socket and returns
 * null. Attach the `message` and `close` listeners right away: frames that came with the request
 * are delivered on the next tick.
 * @param {UpgradeRequest} req
 * @param {import('net').Socket} socket
 * @param {Buffer} head  the bytes the http parser read past the request head
 * @param {{ maxPayload?: number, closeTimeoutMs?: number, maxBufferedBytes?: number }} [options]
 *   maxPayload: the largest message in bytes (a larger frame closes the connection with 1009);
 *   closeTimeoutMs: how long close() waits for the peer's answer before it drops the connection;
 *   maxBufferedBytes: a connection with more than this queued in its socket is dropped when it
 *   would write more (see WsConnection); Infinity, the default, never drops
 * @returns {WsConnection | null}
 */
function acceptWebSocket(req, socket, head, { maxPayload = DEFAULT_MAX_PAYLOAD, closeTimeoutMs = DEFAULT_CLOSE_TIMEOUT_MS, maxBufferedBytes = Infinity } = {}) {
  if (!isWebSocketUpgrade(req)) {
    refuse(socket, '400 Bad Request');
    return null;
  }
  const headers = req.headers ?? {};
  const accept = createHash('sha1').update(`${headers['sec-websocket-key']}${GUID}`).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  return new WsConnection(socket, { headers, head, maxPayload, closeTimeoutMs, maxBufferedBytes });
}

/**
 * One server frame: FIN set (this server never fragments) and no mask.
 * @param {number} opcode
 * @param {Buffer} payload
 */
function encodeFrame(opcode, payload) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeUInt32BE(Math.floor(length / 0x100000000), 2);
    header.writeUInt32BE(length % 0x100000000, 6);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

/** The reason as UTF-8, cut at a character boundary to fit a control frame next to the 2-byte code (125 - 2). */
function truncatedReason(reason) {
  const bytes = Buffer.from(reason, 'utf8');
  if (bytes.length <= 123) return bytes;
  let end = 123;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--; // bytes[end] continues a character: cut before it
  return bytes.subarray(0, end);
}

/**
 * @param {number | undefined} code  undefined sends no status at all
 * @param {Buffer} reason
 */
function closeFrame(code, reason) {
  if (code === undefined) return encodeFrame(OP_CLOSE, EMPTY);
  const payload = Buffer.allocUnsafe(2 + reason.length);
  payload.writeUInt16BE(code, 0);
  reason.copy(payload, 2);
  return encodeFrame(OP_CLOSE, payload);
}

/** The status codes a Close frame may carry (RFC 6455 section 7.4, with 1012-1014 from the IANA registry). */
function isCloseCode(code) {
  return Number.isInteger(code)
    && ((code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999));
}

/**
 * A client's WebSocket connection. Events: `message(text)` for each complete text message and
 * `close(code, reason)` once, when the connection is over: the peer answered or sent a Close frame,
 * the stream was refused as broken, or the peer went away. The code is the peer's (1005 when its
 * Close frame had no status), else the one this side sent, else 1006 (no Close frame at all). The
 * TCP connection is ended right after; a timer drops it if the peer never closes its end.
 */
class WsConnection extends EventEmitter {
  /**
   * @param {import('net').Socket} socket  its handshake response is written already
   * @param {{ headers: Record<string, string | string[] | undefined>, head?: Buffer, maxPayload: number, closeTimeoutMs: number, maxBufferedBytes?: number }} options
   */
  constructor(socket, { headers, head, maxPayload, closeTimeoutMs, maxBufferedBytes = Infinity }) {
    super();
    /** The request's headers, with lower-case names. */
    this.headers = headers;
    /** The request's Origin header, or '' when it had none. */
    this.origin = typeof headers.origin === 'string' ? headers.origin : '';
    /** @type {'open' | 'closing' | 'closed'} */
    this.readyState = 'open';
    this._socket = socket;
    this._maxPayload = maxPayload;
    this._closeTimeoutMs = closeTimeoutMs;
    this._maxBufferedBytes = maxBufferedBytes;
    /** True while the last pong is still queued in the socket: newer pings then wait (see _pong). */
    this._pongQueued = false;
    /** @type {Buffer | null} the payload of the newest ping that waits for that pong to go out */
    this._pongWaiting = null;
    // Bytes received and not parsed yet are this._buf[this._start .. this._end].
    this._buf = EMPTY;
    this._start = 0;
    this._end = 0;
    /** @type {Buffer[] | null} the frames of the message being received; null between messages */
    this._fragments = null;
    this._fragmentBytes = 0;
    /** True once a Close frame arrived or the stream was found broken: nothing more is parsed. */
    this._inputClosed = false;
    /** @type {{ code: number, reason: string } | undefined} */
    this._peerClose = undefined;
    /** @type {{ code: number, reason: string } | undefined} */
    this._sentClose = undefined;
    /** @type {NodeJS.Timeout | undefined} */
    this._closeTimer = undefined;
    /** @type {{ error: unknown } | undefined} the first error a `message` listener threw while the buffer was being read */
    this._listenerError = undefined;

    socket.setNoDelay(true);
    // The socket can be gone already when a caller accepts after an async check: it never emits 'close' then.
    if (socket.destroyed) process.nextTick(() => this._finish());
    // Scheduled before the socket's own data, so frames sent with the request keep their place.
    if (head && head.length > 0) process.nextTick(() => this._onData(head));
    socket.on('data', (chunk) => this._onData(/** @type {Buffer} */ (chunk)));
    socket.on('end', () => this._finish()); // the peer is done sending: no Close frame is coming any more
    socket.on('close', () => {
      clearTimeout(this._closeTimer);
      this._finish();
    });
    socket.on('error', () => {}); // 'close' follows
  }

  /**
   * Sends a text message. Returns false (and sends nothing) unless the connection is open.
   * @param {string} text
   */
  send(text) {
    if (typeof text !== 'string') throw new TypeError('send() takes a string');
    if (this.readyState !== 'open') return false;
    if (this._behind()) return false;
    this._socket.write(encodeFrame(OP_TEXT, Buffer.from(text, 'utf8')));
    return true;
  }

  /** Sends a ping; the peer's pong needs no handling. */
  ping() {
    if (this.readyState === 'open' && !this._behind()) this._socket.write(encodeFrame(OP_PING, EMPTY));
  }

  /**
   * Bytes handed to the socket (frames sent) that it has not written to the network yet: what a
   * client that reads too slowly lets pile up. Past maxBufferedBytes the connection is dropped at
   * its next write of its own (send(), ping(), a pong; see _behind), so send() then returns false;
   * below that a caller can decide sooner that a client is too far behind.
   */
  get bufferedAmount() {
    return this._socket.writableLength || 0;
  }

  /**
   * Changes the largest message accepted from here on (a bigger one closes the connection with
   * 1009, judged by its header before the payload is buffered). A server starts small for a client
   * that has not authenticated yet and raises the limit once it has. A frame whose payload is still
   * arriving is judged again under the new limit.
   * @param {number} maxPayload  bytes, a positive integer
   */
  setMaxPayload(maxPayload) {
    if (!Number.isSafeInteger(maxPayload) || maxPayload < 1) throw new TypeError('maxPayload must be a positive integer');
    this._maxPayload = maxPayload;
  }

  /**
   * Changes how much may wait in the socket (bufferedAmount) before the connection is dropped. It is
   * looked at before each write of this connection's own (send, ping, a pong), so one big message
   * still goes out; a client that has more than this unread is dropped at its next write instead of
   * queueing without end. Infinity never drops.
   * @param {number} maxBufferedBytes  bytes, a positive number
   */
  setMaxBufferedBytes(maxBufferedBytes) {
    if (typeof maxBufferedBytes !== 'number' || !(maxBufferedBytes > 0)) throw new TypeError('maxBufferedBytes must be a positive number');
    this._maxBufferedBytes = maxBufferedBytes;
  }

  /**
   * Whether more than maxBufferedBytes waits in the socket; if so the connection is dropped. The
   * client does not read what it is sent, so a Close frame would not reach it either: the socket is
   * destroyed at once and its queue let go, and `close` reports 1013 (try again later).
   * @private
   */
  _behind() {
    if (!(this.bufferedAmount > this._maxBufferedBytes)) return false;
    if (this.readyState !== 'closed') {
      this._sentClose ??= { code: 1013, reason: 'the client does not read what it is sent' };
      this._finish();
    }
    this._socket.destroy();
    return true;
  }

  /**
   * Answers a ping. While the last pong is still queued in the socket (the client reads slowly, or
   * not at all) a newer ping only replaces the one waiting, and the newest is answered once that pong
   * went out: RFC 6455 section 5.5.3 allows answering only the latest ping. So a client that sends
   * pings and never reads cannot make pongs pile up. A client that reads gets every pong at once.
   * @private
   * @param {Buffer} payload  a view into the receive buffer: copied when it has to wait
   */
  _pong(payload) {
    if (this.readyState !== 'open') return;
    if (this._pongQueued) {
      this._pongWaiting = Buffer.from(payload);
      return;
    }
    if (this._behind()) return;
    let written = false;
    // Whether this pong set _pongQueued: only its own callback may clear it. A pong that went out at
    // once can still have its callback called later, after a newer pong was queued and set the flag.
    let owner = false;
    this._socket.write(encodeFrame(OP_PONG, payload), () => {
      written = true;
      if (!owner) return;
      this._pongQueued = false;
      const waiting = this._pongWaiting;
      this._pongWaiting = null;
      if (waiting) this._pong(waiting);
    });
    if (!written && this.bufferedAmount > 0) {
      this._pongQueued = true; // not out yet: newer pings wait for it
      owner = true;
    }
  }

  /**
   * Starts the closing handshake: sends a Close frame, then waits for the peer's answer and drops
   * the connection when it does not come within closeTimeoutMs. The reason is cut to 123 bytes.
   * @param {number} [code]  1000-1003, 1007-1014 or 3000-4999
   * @param {string} [reason]
   */
  close(code = 1000, reason = '') {
    if (!isCloseCode(code)) throw new TypeError(`${code} is not a status code a Close frame may carry`);
    if (typeof reason !== 'string') throw new TypeError('the close reason must be a string');
    if (this.readyState !== 'open') return;
    const bytes = truncatedReason(reason);
    this.readyState = 'closing';
    this._sentClose = { code, reason: bytes.toString('utf8') };
    this._socket.write(closeFrame(code, bytes));
    this._armCloseTimer();
  }

  /** Drops the socket if the peer has not closed its end after closeTimeoutMs. @private */
  _armCloseTimer() {
    if (this._closeTimer) return;
    this._closeTimer = setTimeout(() => this._socket.destroy(), this._closeTimeoutMs);
    this._closeTimer.unref();
  }

  /** The stream cannot be parsed or trusted any more: close with `code` and do not wait for the answer. @private */
  _fail(code, reason) {
    this.close(code, reason);
    this._finish();
  }

  /** @private */
  _stopReading() {
    this._inputClosed = true;
    this._buf = EMPTY;
    this._start = 0;
    this._end = 0;
    this._fragments = null;
    this._fragmentBytes = 0;
  }

  /**
   * The connection is over as far as the application is concerned: no more messages, the TCP
   * connection is wound down and `close` is emitted. What is queued (such as the answer to a Close
   * frame) goes out ahead of the FIN. The socket is not destroyed here: while the peer is still
   * sending, closing it would reset the connection, and the reset can take our Close frame away
   * from the peer before it reads it. It stays open, its input discarded, until the peer closes
   * its end or the timer drops it, which also covers a peer that went away without the socket
   * ever reporting `close`.
   * @private
   */
  _finish() {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this._stopReading();
    if (!this._socket.destroyed) {
      this._socket.end();
      this._armCloseTimer();
    }
    const { code, reason } = this._peerClose ?? this._sentClose ?? { code: 1006, reason: '' };
    this.emit('close', code, reason);
  }

  /** @private @param {Buffer} chunk */
  _onData(chunk) {
    if (this._inputClosed || chunk.length === 0) return;
    this._append(chunk);
    this._parse();
    const thrown = this._listenerError;
    if (thrown) {
      this._listenerError = undefined;
      throw thrown.error; // as any listener error would surface, but after the frames behind that message were read
    }
  }

  /**
   * Adds a received chunk to the receive buffer: one contiguous Buffer the frames are parsed out of.
   * A list of chunks would cost every arrival time proportional to the list as soon as the first
   * chunk is shorter than a frame header (a peer can send one byte at a time, before it has
   * authenticated), and would hold an object per chunk where maxPayload only limits bytes. Here an
   * arrival costs its own length, and the buffer grows by doubling.
   * @private
   * @param {Buffer} chunk
   */
  _append(chunk) {
    const unread = this._end - this._start;
    if (this._end + chunk.length > this._buf.length) {
      if (unread + chunk.length <= this._buf.length / 2) {
        // Most of the buffer is already-read space in front: slide the unread bytes to the start.
        this._buf.copy(this._buf, 0, this._start, this._end);
      } else {
        const grown = Buffer.allocUnsafe(Math.max(2 * (unread + chunk.length), INITIAL_CAPACITY));
        this._buf.copy(grown, 0, this._start, this._end);
        this._buf = grown;
      }
      this._start = 0;
      this._end = unread;
    }
    chunk.copy(this._buf, this._end);
    this._end += chunk.length;
  }

  /** Marks the first `n` unread bytes as read. @private */
  _consume(n) {
    this._start += n;
    if (this._start === this._end) {
      this._start = 0;
      this._end = 0;
      if (this._buf.length > RETAINED_CAPACITY) this._buf = EMPTY;
    }
  }

  /**
   * Reads every complete frame out of the buffer. A frame is judged as early as its header allows,
   * so a bad or oversized one is refused before its payload has arrived.
   * @private
   */
  _parse() {
    while (!this._inputClosed) {
      const available = this._end - this._start;
      if (available < 2) return;
      const buf = this._buf;
      const at = this._start;
      const b0 = buf[at];
      const b1 = buf[at + 1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const isControl = opcode >= OP_CLOSE;
      if (b0 & 0x70) return this._fail(1002, 'reserved bits are set');
      if (opcode > OP_PONG || (opcode > OP_BINARY && !isControl)) return this._fail(1002, 'unknown opcode');
      if (!(b1 & 0x80)) return this._fail(1002, 'frames from a client must be masked');
      if (isControl && (!fin || (b1 & 0x7f) > 125)) return this._fail(1002, 'invalid control frame');
      let length = b1 & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (available < 4) return;
        length = buf.readUInt16BE(at + 2);
        offset = 4;
      } else if (length === 127) {
        if (available < 10) return;
        const high = buf.readUInt32BE(at + 2);
        if (high >= 0x80000000) return this._fail(1002, 'invalid payload length'); // the top bit must be 0
        length = high * 0x100000000 + buf.readUInt32BE(at + 6);
        offset = 10;
      }
      if (!isControl && this._fragmentBytes + length > this._maxPayload) return this._fail(1009, 'message too big');
      const frameLength = offset + 4 + length; // header, mask key, payload
      if (available < frameLength) return;
      const maskAt = at + offset;
      const payloadAt = maskAt + 4;
      for (let i = 0; i < length; i++) buf[payloadAt + i] ^= buf[maskAt + (i & 3)];
      // The payload is a view into the receive buffer, good until the next chunk arrives: _onFrame
      // uses it at once and copies what it keeps.
      const payload = buf.subarray(payloadAt, payloadAt + length);
      this._consume(frameLength);
      this._onFrame(fin, opcode, payload);
    }
  }

  /** @private @param {boolean} fin @param {number} opcode @param {Buffer} payload */
  _onFrame(fin, opcode, payload) {
    if (opcode === OP_PING) {
      this._pong(payload);
      return;
    }
    if (opcode === OP_PONG) return;
    if (opcode === OP_CLOSE) return this._onCloseFrame(payload);
    if (this.readyState !== 'open') return; // after our Close frame only the peer's answer matters
    if (opcode === OP_CONTINUATION) {
      if (!this._fragments) return this._fail(1002, 'a continuation frame without a message to continue');
    } else {
      if (this._fragments) return this._fail(1002, 'a new message started before the last one ended');
      if (opcode === OP_BINARY) return this._fail(1003, 'binary messages are not supported');
    }
    let data = payload;
    if (!fin || this._fragments) {
      // Part of a fragmented message: keep a copy, the receive buffer is reused.
      this._fragments ??= [];
      this._fragments.push(Buffer.from(payload));
      this._fragmentBytes += payload.length;
      if (this._fragments.length > MAX_FRAGMENTS) return this._fail(1009, 'too many fragments');
      if (!fin) return;
      data = Buffer.concat(this._fragments, this._fragmentBytes);
      this._fragments = null;
      this._fragmentBytes = 0;
    }
    let text;
    try {
      text = utf8.decode(data);
    } catch {
      return this._fail(1007, 'invalid UTF-8');
    }
    try {
      this.emit('message', text);
    } catch (error) {
      // Keep reading: the frames behind this message must not wait for the next packet. _onData rethrows.
      this._listenerError ??= { error };
    }
  }

  /** @private @param {Buffer} payload */
  _onCloseFrame(payload) {
    let code = 1005; // "no status code was present" (RFC 6455 section 7.1.5)
    let reason = '';
    if (payload.length === 1) return this._fail(1002, 'invalid close frame');
    if (payload.length >= 2) {
      code = payload.readUInt16BE(0);
      if (!isCloseCode(code)) return this._fail(1002, 'invalid close code');
      try {
        reason = utf8.decode(payload.subarray(2));
      } catch {
        return this._fail(1007, 'invalid UTF-8 in the close reason');
      }
    }
    this._peerClose = { code, reason };
    if (this.readyState === 'open') {
      // The peer started the closing handshake: answer with its status code.
      this.readyState = 'closing';
      this._socket.write(closeFrame(code === 1005 ? undefined : code, EMPTY));
    }
    this._finish(); // either way the handshake is complete; the server closes TCP first (RFC 6455 section 7.1.1)
  }
}

module.exports = { acceptWebSocket, WsConnection };
