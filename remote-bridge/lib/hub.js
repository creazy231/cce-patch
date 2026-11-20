// @ts-check
'use strict';
// The hub: one VS Code window's bridge listens on 127.0.0.1 (which `tailscale serve` publishes on the
// tailnet over HTTPS) and serves the phones. It authenticates them (the Tailscale identity header on
// the upgrade, a one-time pairing code once, then device token and Origin on every connection),
// routes their requests to the VS Code windows (this one, and the others connected over local peer
// links) and the windows' session events to the phones that subscribed. A peer link counts as a
// window only once its peer proved that it knows the secret (peer-link.js); until then the hub
// sends it nothing and reads nothing else from it.
//
// A paired phone can make Claude Code run commands on this Mac, so a socket is hostile until its
// hello succeeds: what it may send before that is bounded in size, number and time, a failed check
// closes it, and the answers tell nothing a pairing code or token would not. Writes to state.json
// (a device paired or removed, appUrl) are the hub's alone and always go through updateState, which
// reads the file again right before it writes. Nothing is written periodically: when a phone was
// last heard from is kept in memory (devices(), info()), since every rewrite of the whole file can
// undo what another window wrote in the meantime (a Disconnect).
//
// Phone protocol (version 1; docs/superpowers/specs/2026-11-19-phone-remote-design.md):
//   before hello: {t:"pair", code, device} → {t:"paired", deviceId, token, mac:{name}}, or
//                 {t:"error", code:"bad_code"} (the socket stays)
//                 {t:"hello", v:1, deviceId, token} → {t:"welcome", v:1, mac:{name}} + {t:"projects"}, or
//                 {t:"error", code:"bad_token"|"bad_origin"} and close 4401
//   after hello:  sub, unsub, send, answer, interrupt, open, openClaude, ping (see _onPhoneMessage)
// Close codes: 4400 no pair/hello in time or a frame that is neither, 4401 unauthorized (after an
// error frame), 4408 idle, 4409 replaced by a newer connection of the same device (after the error
// too_many_connections), 1009 a frame over 64 KB before hello or 8 MB after, 1011 state.json
// unusable, 1013 too slow (try again: more session events held back for a loading snapshot than
// limits.maxPendingFrames/maxPendingBytes, or more than limits.maxQueuedBytes unread when the hub
// sends a frame; that Close frame waits behind what is unread), 1001 the hub closes (phones past
// hello get the error `disabled` first when remote access was turned off). No Close frame at all
// when ws.js drops a client itself, at its next write (any frame past 1 MB unread before hello; a
// pong or ping past limits.maxQueuedBytes after): the socket is destroyed, and the phone sees the
// connection drop (1006).

const { EventEmitter } = require('events');
const { performance } = require('perf_hooks');
const { acceptWebSocket } = require('./ws.js');
const { acceptPeer, AUTH_TIMEOUT_MS } = require('./peer-link.js');
const { LiteServer, respond, destroyWhenEnded } = require('./http-lite.js');
const { Pairing, formatCode, createDevice, verifyToken, pairingLink } = require('./pairing.js');
const { qrSvgPath } = require('./qr.js');
const { Notifier } = require('./notifier.js');

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 8 * 1024 * 1024; // after hello: a bigger frame closes the socket with 1009 (ws.js)
// Before hello: pair and hello are a few hundred bytes. ws.js judges a frame by its header, so a bigger
// one is refused before its payload is buffered, and a socket that has not said hello costs little.
const PREAUTH_MAX_FRAME_BYTES = 64 * 1024;
// Before hello the hub sends a few small frames: a socket with more than this unread is dropped when
// it would be sent more (a client that pings and never reads included). After hello: limits.maxQueuedBytes.
const PREAUTH_MAX_QUEUED_BYTES = 1024 * 1024;
const MAX_PREAUTH_FRAME_CHARS = 16 * 1024; // pair and hello are a few hundred bytes
const MAX_ID_CHARS = 256; // project, session, request and ack ids from a phone
const MAX_PROJECT_ID_CHARS = 200; // a window's own id: leaves room for the -2, -3 suffix
const MAX_APP_URL_CHARS = 512; // keeps the pairing link small enough for a readable QR code
const STATUS_TIMEOUT_MS = 6000; // the Tailscale CLI wrapper gives up after 5 s
const STATUS_REFRESH_MS = 5000; // how often the hub asks for the Mac's DNS name at most
const DNS_NAME_RE = /^[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*$/;
/**
 * How long each window call may take. A send to a new session can take about 40 s in the window
 * (up to 20 s for the editor tab's channel, up to 20 s for the session's name); the app waits 60 s.
 * @type {Readonly<Record<string, number>>}
 */
const DEFAULT_CALL_TIMEOUTS_MS = Object.freeze({ snapshot: 20_000, send: 50_000, answer: 20_000, interrupt: 20_000, open: 20_000, openClaude: 20_000, active: 10_000 });
const FALLBACK_CALL_TIMEOUT_MS = 20_000;
const PEER_CALL_TIMEOUT_MS = 60_000; // the hub's own timeout per call decides first
const DISABLED_MESSAGE = 'Remote access was turned off on the Mac';

const CLOSE = {
  goingAway: 1001,
  internal: 1011,
  tryAgain: 1013,
  badRequest: 4400,
  unauthorized: 4401,
  idle: 4408,
  replaced: 4409,
};

/**
 * @typedef {{
 *   maxQueuedBytes: number,
 *   maxPendingFrames: number,
 *   maxPendingBytes: number,
 *   maxSubscriptions: number,
 *   maxPreauth: number,
 *   maxPreauthFrames: number,
 *   maxSocketsPerDevice: number,
 *   maxPeers: number,
 * }} Limits
 *   maxQueuedBytes: a phone with more than this waiting in its socket is closed with 1013;
 *   maxPendingFrames / maxPendingBytes: session events a phone may have held back while its
 *     snapshots load (characters, all subscriptions together); past either, 1013;
 *   maxSubscriptions: sessions one phone socket may watch at once;
 *   maxPreauth: sockets that have not said hello yet (a refused one counts until its TCP connection
 *     is closed) and upgrades being checked; more get 503;
 *   maxPreauthFrames: frames a socket may send before its hello (pair retries);
 *   maxSocketsPerDevice: a new hello closes the device's oldest socket past this (4409);
 *   maxPeers: peer links (VS Code windows) at once, those still waiting for their proof included; more get 503;
 *   lookFreshMs: a phone counts as looking only while it sent a frame this recently (40 s).
 */
/** @type {Limits} */
const DEFAULT_LIMITS = {
  maxQueuedBytes: 4 * 1024 * 1024,
  maxPendingFrames: 2000,
  maxPendingBytes: 8 * 1024 * 1024,
  maxSubscriptions: 32,
  maxPreauth: 16,
  maxPreauthFrames: 8,
  maxSocketsPerDevice: 4,
  maxPeers: 64,
  lookFreshMs: 40_000,
};

// A device that does not exist still costs a token check, so a wrong id takes as long as a wrong token.
const NO_DEVICE = { tokenHash: '0'.repeat(64) };

const BASE_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
const TEXT_HEADERS = { 'Content-Type': 'text/plain; charset=utf-8', ...BASE_HEADERS };
const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', ...BASE_HEADERS };
const HTML_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Frame-Options': 'DENY',
  ...BASE_HEADERS,
};
const HEALTH_BODY = JSON.stringify({ ok: true, app: 'cce-remote', v: PROTOCOL_VERSION });
const HOME_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CCE Remote</title>
<style>
  body { font: 17px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 30rem; margin: 18vh auto; padding: 0 1.5rem; color: #1f2328; background: #fff; }
  h1 { font-size: 1.4rem; margin: 0 0 .75rem; }
  p { margin: 0 0 .75rem; color: #57606a; }
  @media (prefers-color-scheme: dark) { body { color: #e6edf3; background: #0d1117; } p { color: #8d96a0; } }
</style>
</head>
<body>
<h1>CCE Remote</h1>
<p>This address belongs to a Mac that shares its Claude Code sessions with the CCE Remote app.</p>
<p>Open the CCE Remote app on your phone to connect. To add this Mac, use the pairing code from the Connection tab in Claude Code's sessions panel.</p>
</body>
</html>
`;

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A project, session or request id as a phone may send it. @param {unknown} value @returns {value is string} */
function isId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_CHARS;
}

/** The id a request carries for its ack: a short string or a safe integer. @param {unknown} value */
function isAckId(value) {
  return isId(value) || (typeof value === 'number' && Number.isSafeInteger(value));
}

/** An Error whose `code` is its message. @param {string} code */
function codedError(code) {
  return Object.assign(new Error(code), { code });
}

/** What an error says, for an ack or a log line. @param {unknown} error */
function errorText(error) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return message ? message.slice(0, 500) : 'failed';
}

/** Text for a log line: control and bidirectional-override characters become spaces. @param {string} value */
function printable(value) {
  return value.replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
}

/** @param {unknown} value */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** The key of a subscription: unambiguous whatever the ids hold. @param {string} project @param {string} session */
function subKey(project, session) {
  return JSON.stringify([project, session]);
}

/**
 * Whether a Host header names this machine's loopback interface (with or without a port): what a
 * peer link from another window sends. `tailscale serve` passes the Mac's tailnet name instead.
 * @param {unknown} host
 */
function isLoopbackHost(host) {
  if (typeof host !== 'string') return false;
  const name = /^(\[[^\]]*\]|[^:]*)(?::\d{1,5})?$/.exec(host.toLowerCase());
  return name !== null && (name[1] === '127.0.0.1' || name[1] === 'localhost' || name[1] === '[::1]');
}

/** @param {unknown} state @param {string} id */
function findDevice(state, id) {
  const devices = isRecord(state) && Array.isArray(state.devices) ? state.devices : [];
  return devices.find((device) => isRecord(device) && device.id === id);
}

/** Order of the projects list: by name (any case), then by id. @param {Record<string, any>} a @param {Record<string, any>} b */
function compareProjects(a, b) {
  const nameA = text(a.name).toLowerCase();
  const nameB = text(b.name).toLowerCase();
  if (nameA !== nameB) return nameA < nameB ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The app's address as it is stored: `https://host[:port][/path]` without a trailing slash, or ''
 * to clear it. Anything else (another scheme, credentials, a query or fragment, whitespace, more
 * than 512 characters, not a string) throws `bad_url`.
 * @param {unknown} input
 */
function normalizeAppUrl(input) {
  if (typeof input !== 'string') throw codedError('bad_url');
  const trimmed = input.trim();
  if (trimmed === '') return '';
  if (trimmed.length > MAX_APP_URL_CHARS || !/^https:\/\//i.test(trimmed) || /[\s\x00-\x1f\x7f?#]/.test(trimmed)) throw codedError('bad_url');
  let url;
  try {
    url = new URL(trimmed);
  } catch {
    throw codedError('bad_url');
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hostname === '') throw codedError('bad_url');
  let path = url.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  return `${url.origin}${path}`;
}

/** The stored app address if it is one setAppUrl would accept, else '' (the link's placeholder). @param {unknown} stored */
function usableAppUrl(stored) {
  try {
    return normalizeAppUrl(stored);
  } catch {
    return '';
  }
}

/** @template T @param {Promise<T>} promise @param {number} ms @returns {Promise<T>} */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(codedError('timeout')), ms);
    timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Which window call a phone request is, with its arguments; null when the request is not well
 * formed. The arguments are what the window agent takes (the Task 8 adapter maps them):
 * send {session|null, text, images}, answer {session, requestId, choice}, interrupt/open {session},
 * openClaude {}.
 * @param {Record<string, any>} frame
 * @returns {{ method: string, args: Record<string, any> } | null}
 */
function actionCall(frame) {
  if (!isId(frame.project)) return null;
  const session = frame.session;
  switch (frame.t) {
    case 'send': {
      if (session !== null && !isId(session)) return null;
      if (typeof frame.text !== 'string') return null;
      const images = frame.images === undefined ? [] : frame.images;
      if (!Array.isArray(images)) return null; // the window checks count, size and type
      return { method: 'send', args: { session, text: frame.text, images } };
    }
    case 'answer':
      if (!isId(session) || !isId(frame.requestId) || !isRecord(frame.choice)) return null;
      return { method: 'answer', args: { session, requestId: frame.requestId, choice: frame.choice } };
    case 'interrupt':
    case 'open':
      if (!isId(session)) return null;
      return { method: frame.t, args: { session } };
    case 'openClaude':
      return { method: 'openClaude', args: {} };
    default:
      return null;
  }
}

/**
 * @typedef {{
 *   key: string,
 *   call: (method: string, args: any) => any,
 *   project: Record<string, any> | null,
 *   baseId: string,
 *   publicId: string,
 *   removed: boolean,
 * }} Window
 *   baseId: the id the window gave its project; publicId: the id phones see (baseId, or baseId-2,
 *   -3 … when another window has it already); '' until the window sends a project.
 * @typedef {{ win: Window, frames: string[], bytes: number }} PendingSnapshot
 *   a snapshot call in flight, and the session events held back until its answer is sent
 * @typedef {{
 *   ws: import('./ws.js').WsConnection,
 *   deviceId: string,
 *   authed: boolean,
 *   closed: boolean,
 *   dropped: boolean,
 *   helloTimer: NodeJS.Timeout | null,
 *   preauthFrames: number,
 *   preauthCounted: boolean,
 *   visible: boolean,
 *   lastFrameAt: number,
 *   subs: Map<string, { project: string, session: string }>,
 *   pending: Map<string, PendingSnapshot>,
 *   pendingFrames: number,
 *   pendingBytes: number,
 *   lastProjects: string,
 * }} Phone
 * @typedef {{ setProject(project: unknown): void, sessionEvent(sessionId: unknown, ev: unknown): void, attention(ev: unknown): void, remove(): void }} WindowHandle
 * @typedef {{ code: string, expiresAt: number, link: string, qr: { size: number, path: string } | null }} PairingView
 *   code as XXXX-XXXX; link and qr are empty while the Mac's Tailscale DNS name is unknown
 */

/**
 * The hub. Events: `change` (no arguments) whenever something the Connection tab shows changed
 * (windows, phones, devices, the pairing code, the Mac's address); `attention` ({key, project,
 * projectName, ev}) for each attention event of a window that has a project (a prompt appeared, a
 * session's open prompts changed, a turn ended: what a notification is for; no phone needs to be
 * connected, and none is told), with the window's key, the project's public id and its name;
 * `window-removed` (key) when a window is gone; `close` once, when close() has finished and the port
 * is free. It never emits `error`; a listener that throws is logged and is not heard of by whoever
 * caused the event.
 */
class Hub extends EventEmitter {
  /**
   * @param {{
   *   state: () => import('./store.js').State,
   *   updateState: (fn: (state: import('./store.js').State) => void) => unknown,
   *   tailscale: { status(): Promise<{ loginName?: string, dnsName?: string } | undefined> },
   *   macName: () => string,
   *   log?: (message: string, level: 'info' | 'warn' | 'error') => void,
   *   now?: () => number,
   *   helloTimeoutMs?: number,
   *   projectsDebounceMs?: number,
   *   idleTimeoutMs?: number,
   *   callTimeoutMs?: number | Partial<Record<string, number>>,
   *   peerAuthTimeoutMs?: number,
   *   limits?: Partial<Limits>,
   *   notifier?: Partial<import('./notifier.js').NotifierOptions>,
   * }} options
   *   state: reads state.json now (loadState); updateState: store.updateState (fn mutates in place);
   *   log: a line without secrets, and its level; now: the clock of pairing codes and device times;
   *   helloTimeoutMs: how long a new socket has for its first frame (and between pair tries);
   *   projectsDebounceMs: project changes within this time make one `projects` frame;
   *   idleTimeoutMs: a phone that sends nothing (the app pings every 25 s) is closed after this;
   *   callTimeoutMs: how long a window call may take: one number for every method, or some methods'
   *     own (the rest keep DEFAULT_CALL_TIMEOUTS_MS: send 50 s, active 10 s, the others 20 s);
   *   peerAuthTimeoutMs: how long a peer link has to prove that it knows the secret (5 s);
   *   notifier: what tests inject into the notifier (send, idleSeconds, sendOptions, limits).
   */
  constructor({ state, updateState, tailscale, macName, log = () => {}, now = Date.now, helloTimeoutMs = 10_000, projectsDebounceMs = 300, idleTimeoutMs = 120_000, callTimeoutMs, peerAuthTimeoutMs = AUTH_TIMEOUT_MS, limits = {}, notifier }) {
    super();
    this._readState = state;
    this._updateState = updateState;
    this._tailscale = tailscale;
    this._macName = macName;
    this._logger = log;
    this._now = now;
    this._helloTimeoutMs = helloTimeoutMs;
    this._projectsDebounceMs = projectsDebounceMs;
    this._idleTimeoutMs = idleTimeoutMs;
    this._callTimeoutMs = callTimeoutMs;
    this._peerAuthTimeoutMs = peerAuthTimeoutMs;
    /** @type {Limits} */
    this._limits = { ...DEFAULT_LIMITS, ...limits };
    this._lite = new LiteServer((req, socket, head) => this._onRequest(req, socket, head));
    /** The TCP server (for its address). */
    this.server = this._lite.server;
    this._pairing = new Pairing();
    /** @type {{ code: string, expiresAt: number, link: string, view: PairingView } | null} */
    this._pairingMemo = null;
    this._closed = false;
    /** @type {Promise<void> | null} */
    this._listening = null;
    /** Whether listen() succeeded: only a hub that served says it stopped (a window that found the port taken joins as a peer). */
    this._served = false;
    /** @type {Promise<void> | null} */
    this._closing = null;

    /** @type {Set<Phone>} every phone socket, before and after hello */
    this._phones = new Set();
    /** @type {Set<Phone>} the ones past their hello, oldest first */
    this._authed = new Set();
    this._upgrading = 0; // upgrades waiting for the Tailscale check
    // Sockets that never got past hello, counted until their TCP connection is closed: a refused one
    // still holds a receive buffer while its closing handshake runs (up to 3 s).
    this._preauthOpen = 0;
    /** @type {Map<string, Set<Phone>>} subscription key → the phones that hold it */
    this._subscribers = new Map();

    /** @type {Map<string, Window>} */
    this._windows = new Map();
    /** @type {Map<string, Window>} */
    this._byPublicId = new Map();
    this._windowSeq = 0;
    /** @type {Set<import('./peer-link.js').PeerLink>} the peer links that proved themselves */
    this._peers = new Set();
    /** @type {Set<import('./peer-link.js').PeerLink>} the peer links still waiting for their proof */
    this._unproved = new Set();
    /** @type {NodeJS.Timeout | null} */
    this._projectsTimer = null;

    /** @type {Set<string>} device ids removed while this hub runs: refused even if state.json brings them back */
    this._revoked = new Set();
    /** @type {Map<string, number>} device id → when this hub last heard from it (never written to state.json) */
    this._lastSeen = new Map();

    this._dnsName = '';
    // The Mac's Tailscale login as last read; a status read that fails later does not forget it.
    this._owner = '';
    /** @type {Promise<unknown> | null} */
    this._statusRead = null;
    this._statusReadAt = -Infinity;

    /** @type {NodeJS.Timeout | null} */
    this._sweepTimer = null;
    /** @type {Set<NodeJS.Timeout>} */
    this._callTimers = new Set();

    this._notifier = new Notifier({
      ...notifier,
      state: () => this._readState(),
      updateState: (fn) => this._updateState(fn),
      isLooking: (id) => this._isLooking(id),
      macName: () => this._macNameText(),
      log: (message, level) => this._log(message, level),
      now: this._now,
    });
    this.on('attention', (event) => this._notifier.attention(event));
    this.on('window-removed', (key) => this._notifier.windowRemoved(key));
  }

  /** The port the hub listens on; 0 before listen(). */
  get port() {
    return this._lite.port;
  }

  /**
   * Listens on 127.0.0.1:`port` (0: a free port). Rejects with the socket error (`code` EADDRINUSE
   * when the port is taken, the coordinator's sign to join as a peer) or `closed` after close().
   * @param {number} port
   */
  async listen(port) {
    if (this._closed) throw codedError('closed');
    if (this._listening) throw codedError('listening');
    this._listening = this._lite.listen(port);
    try {
      await this._listening;
    } catch (error) {
      this._listening = null;
      throw error;
    }
    if (this._closed) throw codedError('closed');
    this._served = true;
    this._log(`listening on 127.0.0.1:${this.port}`);
    const every = Math.max(10, Math.min(30_000, Math.floor(this._idleTimeoutMs / 2)));
    this._sweepTimer = setInterval(() => this._closeIdlePhones(), every);
    this._sweepTimer.unref();
    this._refreshTailscale(true); // the Mac's DNS name, for pairing links
  }

  /**
   * Closes every phone (1001) and peer link, tells the windows that no phone is connected any more,
   * stops listening and clears every timer. Resolves once the port is free. Idempotent (the first
   * call's reason counts). `reason: 'disabled'` (remote access was turned off) first sends every phone
   * past its hello `{t:"error", code:"disabled"}`; without it (another window takes over, a reload)
   * the phones just reconnect. A socket before its hello never gets the error: it has not shown that
   * it is a paired phone, and the hub tells such a socket nothing beyond its answers to pair and hello
   * (it only loses the connection). The app stops for bad_token, bad_origin and revoked alone; any
   * other error it shows, and tries again.
   * @param {{ reason?: string }} [options]
   * @returns {Promise<void>}
   */
  close({ reason } = {}) {
    if (this._closing) return this._closing;
    this._closed = true;
    this._notifier.close();
    this._closing = (async () => {
      if (this._projectsTimer) clearTimeout(this._projectsTimer);
      this._projectsTimer = null;
      if (this._sweepTimer) clearInterval(this._sweepTimer);
      this._sweepTimer = null;
      for (const timer of this._callTimers) clearTimeout(timer);
      this._callTimers.clear();
      const hadPhones = this._authed.size > 0;
      for (const phone of [...this._phones]) {
        if (reason === 'disabled' && phone.authed) this._sendError(phone, 'disabled', DISABLED_MESSAGE);
        this._closePhone(phone, CLOSE.goingAway, 'the hub is closing');
      }
      if (hadPhones) for (const win of this._windows.values()) this._tellActive(win, false);
      for (const link of [...this._peers]) link.close();
      for (const link of [...this._unproved]) link.close();
      for (const win of [...this._windows.values()]) this._removeWindow(win);
      try {
        await this._listening;
      } catch {
        // it never listened
      }
      await this._lite.close();
      if (this._served) this._log('stopped');
      try {
        this.emit('close');
      } catch (error) {
        this._log(`a close listener failed: ${errorText(error)}`, 'error');
      }
    })();
    return this._closing;
  }

  // ---- windows ----------------------------------------------------------------------------------

  /**
   * Registers a VS Code window. `call(method, args)` reaches it: `snapshot {session}`, `send
   * {session|null, text, images}`, `answer {session, requestId, choice}`, `interrupt {session}`,
   * `open {session}`, `openClaude {}`, `active {on}` (whether any phone is connected; sent on every
   * change, and at once to a window added while phones are connected). A window is listed once it
   * sent a project; the hub lists it under the project's own id, or that id with -2, -3 … when another
   * window has it. A window that sends a project with another id (its folders changed) is listed
   * under the new one, and the old id is gone for the phones. A second window with the same `key`
   * replaces the first. The handle's `attention(ev)` takes the window's attention events (see
   * _attention), once it has a project.
   * @param {{ key?: string, call: (method: string, args: any) => any }} options
   * @returns {WindowHandle}
   */
  addWindow({ key, call }) {
    if (typeof call !== 'function') throw new TypeError('addWindow() needs a call function');
    const name = typeof key === 'string' && key !== '' ? key : `window:${++this._windowSeq}`;
    const old = this._windows.get(name);
    if (old) this._removeWindow(old);
    /** @type {Window} */
    const win = { key: name, call, project: null, baseId: '', publicId: '', removed: this._closed };
    if (!this._closed) {
      this._windows.set(name, win);
      if (this._authed.size > 0) this._tellActive(win, true);
      this._emitChange();
    }
    return {
      setProject: (project) => this._setProject(win, project),
      sessionEvent: (sessionId, ev) => this._sessionEvent(win, sessionId, ev),
      attention: (ev) => this._attention(win, ev),
      remove: () => this._removeWindow(win),
    };
  }

  /**
   * Registers the window behind a peer link (another VS Code window's bridge) and answers its calls
   * to the hub: `status` → info(), `newPairingCode` → newPairingCode(), `removeDevice {id}`,
   * `setAppUrl {url}`. The peer sends `project` (its Project), `session` ({session, ev}) and
   * `attention` (an attention event) events. The window goes when the link closes. Only for a link
   * whose peer proved itself (its `auth`).
   * @param {import('./peer-link.js').PeerLink} link
   */
  attachPeer(link) {
    const window = this.addWindow({ call: (method, args) => link.call(method, args, { timeoutMs: PEER_CALL_TIMEOUT_MS }) });
    this._peers.add(link);
    link.on('event', (/** @type {string} */ name, /** @type {unknown} */ data) => {
      try {
        if (name === 'project') window.setProject(data);
        else if (name === 'session' && isRecord(data)) window.sessionEvent(data.session, data.ev);
        else if (name === 'attention') window.attention(data);
      } catch (error) {
        this._log(`a peer event failed: ${errorText(error)}`, 'error');
      }
    });
    link.setHandler((method, args) => {
      const result = this._onPeerCall(method, args);
      // The link answers a rejection with an error; this only marks the promise as handled at once:
      // Bun reports a promise that is rejected before the link's wrapper adopts it as unhandled.
      result.catch(() => {});
      return result;
    });
    link.on('close', () => {
      this._peers.delete(link);
      window.remove();
    });
    if (this._closed) link.close();
  }

  /**
   * A peer's call to the hub; always a promise. `return await` (not `return`) for the async ones:
   * under Bun a rejected promise that is only adopted later counts as unhandled (see attachPeer).
   * @param {string} method @param {unknown} args
   */
  async _onPeerCall(method, args) {
    switch (method) {
      case 'status':
        return this.info();
      case 'newPairingCode':
        return this.newPairingCode();
      case 'removeDevice':
        return await this.removeDevice(isRecord(args) ? args.id : args);
      case 'setAppUrl':
        return await this.setAppUrl(isRecord(args) ? args.url : args);
      default:
        throw codedError('unknown_method');
    }
  }

  /** @param {Window} win @param {unknown} project */
  _setProject(win, project) {
    if (win.removed) return;
    if (!isRecord(project) || typeof project.id !== 'string' || project.id === '' || project.id.length > MAX_PROJECT_ID_CHARS) {
      this._log('ignored a project without a usable id', 'warn');
      return;
    }
    win.project = project;
    if (win.publicId === '' || win.baseId !== project.id) {
      if (win.publicId !== '' && this._byPublicId.get(win.publicId) === win) this._byPublicId.delete(win.publicId);
      win.baseId = project.id;
      win.publicId = this._freeId(project.id);
      this._byPublicId.set(win.publicId, win);
      this._resubscribe(win);
    }
    this._projectsChanged();
  }

  /** The id itself, or with the first free -2, -3 … @param {string} base */
  _freeId(base) {
    if (!this._byPublicId.has(base)) return base;
    for (let n = 2; ; n++) {
      const id = `${base}-${n}`;
      if (!this._byPublicId.has(id)) return id;
    }
  }

  /** A window came (back) under its public id: phones subscribed to it get a fresh snapshot. @param {Window} win */
  _resubscribe(win) {
    for (const phone of [...this._authed]) {
      for (const [key, sub] of [...phone.subs]) {
        if (sub.project === win.publicId) this._requestSnapshot(phone, key, true);
      }
    }
  }

  /** @param {Window} win */
  _removeWindow(win) {
    if (win.removed) return;
    win.removed = true;
    if (this._windows.get(win.key) === win) this._windows.delete(win.key);
    if (win.publicId !== '' && this._byPublicId.get(win.publicId) === win) this._byPublicId.delete(win.publicId);
    if (win.project) this._projectsChanged();
    this._emitChange();
    this._emitSafe('window-removed', win.key);
  }

  /**
   * A window's call, with a timeout. A call that throws, rejects or takes too long rejects (the
   * error's message is the code a phone sees in its ack).
   * @param {Window} win @param {string} method @param {Record<string, any>} args
   * @returns {Promise<any>}
   */
  _callWindow(win, method, args) {
    const timeoutMs = this._timeoutFor(method);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._callTimers.delete(timer);
        reject(codedError('timeout'));
      }, timeoutMs);
      timer.unref();
      this._callTimers.add(timer);
      /** @param {(value: any) => void} settle @param {unknown} value */
      const finish = (settle, value) => {
        clearTimeout(timer);
        this._callTimers.delete(timer);
        settle(value);
      };
      let result;
      try {
        result = win.call(method, args);
      } catch (error) {
        finish(reject, error);
        return;
      }
      Promise.resolve(result).then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error),
      );
    });
  }

  /** @param {string} method */
  _timeoutFor(method) {
    const custom = this._callTimeoutMs;
    if (typeof custom === 'number') return custom;
    if (isRecord(custom) && typeof custom[method] === 'number') return custom[method];
    return DEFAULT_CALL_TIMEOUTS_MS[method] ?? FALLBACK_CALL_TIMEOUT_MS;
  }

  /** @param {boolean} on */
  _setActive(on) {
    for (const win of [...this._windows.values()]) this._tellActive(win, on);
  }

  /** @param {Window} win @param {boolean} on */
  _tellActive(win, on) {
    this._callWindow(win, 'active', { on }).catch((error) => {
      if (!this._closed) this._log(`could not tell a window that phones are ${on ? 'connected' : 'gone'}: ${errorText(error)}`, 'warn');
    });
  }

  /**
   * A window's session event, to the phones subscribed to that session (held back for a phone whose
   * snapshot of it is still loading). `ev`: {t:"msg", message} | {t:"stream", event} |
   * {t:"pending", pending}; anything else is dropped.
   * @param {Window} win @param {unknown} sessionId @param {unknown} ev
   */
  _sessionEvent(win, sessionId, ev) {
    if (win.removed || win.publicId === '' || !isId(sessionId) || !isRecord(ev)) return;
    const key = subKey(win.publicId, sessionId);
    const phones = this._subscribers.get(key);
    if (!phones || phones.size === 0) return;
    let frame;
    if (ev.t === 'msg' && isRecord(ev.message)) frame = { t: 'msg', project: win.publicId, session: sessionId, message: ev.message };
    else if (ev.t === 'stream' && isRecord(ev.event)) frame = { t: 'stream', project: win.publicId, session: sessionId, event: ev.event };
    else if (ev.t === 'pending' && Array.isArray(ev.pending)) frame = { t: 'pending', project: win.publicId, session: sessionId, pending: ev.pending };
    else return;
    let line;
    try {
      line = JSON.stringify(frame);
    } catch (error) {
      this._log(`dropped a session event that is not JSON: ${errorText(error)}`, 'warn');
      return;
    }
    for (const phone of [...phones]) {
      const pending = phone.pending.get(key);
      if (pending) this._holdBack(phone, pending, line);
      else this._sendText(phone, line);
    }
  }

  /**
   * A window's attention event, for whoever listens to the hub: `attention` with the window's key, its
   * project's public id and name, and the event as the window sent it. Dropped for a window that is gone
   * or has no project yet, and when it is not an event: a record whose `kind` is `waiting`, `open` or
   * `done`, with a `session` id, and for `waiting` a `requestId`. Nothing goes to the phones.
   * @param {Window} win @param {unknown} ev
   */
  _attention(win, ev) {
    if (win.removed || win.project === null || win.publicId === '') return;
    if (!isRecord(ev) || !isId(ev.session)) return;
    if (ev.kind === 'waiting') {
      if (!isId(ev.requestId)) return;
    } else if (ev.kind !== 'open' && ev.kind !== 'done') {
      return;
    }
    this._emitSafe('attention', { key: win.key, project: win.publicId, projectName: text(win.project.name), ev });
  }

  _projectsChanged() {
    if (this._projectsTimer || this._closed) return;
    this._projectsTimer = setTimeout(() => {
      this._projectsTimer = null;
      const line = this._projectsLine();
      for (const phone of [...this._authed]) {
        if (phone.lastProjects === line) continue;
        phone.lastProjects = line;
        this._sendText(phone, line);
      }
    }, this._projectsDebounceMs);
    this._projectsTimer.unref();
  }

  /** The `projects` frame as JSON: every window with a project, under its public id. */
  _projectsLine() {
    const projects = [];
    for (const win of this._windows.values()) {
      if (win.project && win.publicId !== '') projects.push({ ...win.project, id: win.publicId });
    }
    projects.sort(compareProjects);
    const parts = [];
    for (const project of projects) {
      try {
        parts.push(JSON.stringify(project));
      } catch (error) {
        this._log(`left out a project that is not JSON: ${errorText(error)}`, 'warn');
      }
    }
    return `{"t":"projects","projects":[${parts.join(',')}]}`;
  }

  // ---- HTTP -------------------------------------------------------------------------------------

  /** @param {import('./http-lite.js').Request} req @param {import('net').Socket} socket @param {Buffer} head */
  _onRequest(req, socket, head) {
    if (this._closed) return respond(socket, 503, { headers: TEXT_HEADERS, body: 'Closing\n' });
    // Funnel publishes to the internet: nothing here answers it. (The tailnet may read / and /health.)
    if (req.headers['tailscale-funnel-request'] !== undefined) return this._refuse(socket, 403, 'refused a request that came through Tailscale Funnel');
    const path = req.url.split('?', 1)[0];
    if (path === '/ws') {
      this._onPhoneUpgrade(req, socket, head).catch((error) => {
        this._log(`a phone upgrade failed: ${errorText(error)}`, 'error');
        socket.destroy();
      });
      return;
    }
    if (path === '/_peer') return this._onPeerUpgrade(req, socket, head);
    if (path === '/health') return respond(socket, 200, { headers: JSON_HEADERS, body: HEALTH_BODY });
    if (path === '/') return respond(socket, 200, { headers: HTML_HEADERS, body: HOME_PAGE });
    respond(socket, 404, { headers: TEXT_HEADERS, body: 'Not found\n' });
  }

  /**
   * A phone's WebSocket upgrade: only from `tailscale serve` (its identity header, never Funnel's),
   * and from the Mac's own Tailscale user when that is known.
   * @param {import('./http-lite.js').Request} req @param {import('net').Socket} socket @param {Buffer} head
   */
  async _onPhoneUpgrade(req, socket, head) {
    const headers = req.headers;
    const login = text(headers['tailscale-user-login']);
    if (login === '') return this._refuse(socket, 403, 'refused a connection without a Tailscale identity');
    if (headers.upgrade === undefined) return respond(socket, 400, { headers: TEXT_HEADERS, body: 'Bad Request\n' });
    if (this._upgrading + this._preauthOpen >= this._limits.maxPreauth) {
      return this._refuse(socket, 503, 'refused a phone connection: too many are waiting for their hello');
    }
    this._upgrading++;
    try {
      await this._readTailscale(); // updates this._owner when Tailscale names its user
    } finally {
      this._upgrading--;
    }
    if (this._closed) {
      socket.destroy();
      return;
    }
    const owner = this._owner; // the last login read: a failed read later does not open the check again
    if (owner !== '' && owner.toLowerCase() !== login.toLowerCase()) {
      return this._refuse(socket, 403, "refused a phone connection from a Tailscale user other than this Mac's");
    }
    if (socket.destroyed) return;
    const ws = acceptWebSocket(req, socket, head, { maxPayload: PREAUTH_MAX_FRAME_BYTES, maxBufferedBytes: PREAUTH_MAX_QUEUED_BYTES }); // both raised after hello
    if (!ws) return; // not a WebSocket upgrade: answered with 400
    this._acceptPhone(ws, socket);
    destroyWhenEnded(socket);
    socket.resume(); // http-lite paused it; what came meanwhile is delivered in order
  }

  /**
   * A peer link from another VS Code window: it proves that it knows the secret in state.json (and
   * the hub proves it to the peer) before it counts; never from Tailscale.
   * @param {import('./http-lite.js').Request} req @param {import('net').Socket} socket @param {Buffer} head
   */
  _onPeerUpgrade(req, socket, head) {
    // A peer is another window on this Mac: it connects to 127.0.0.1 itself. Whatever came through a
    // proxy (`tailscale serve` adds X-Forwarded-*, even for a tagged node without an identity) or
    // names another host is not one.
    const forwarded = Object.keys(req.headers).some((name) => name.startsWith('x-forwarded-'));
    if (forwarded || !isLoopbackHost(req.headers.host)) return this._refuse(socket, 403, 'refused a peer link that did not come from this Mac');
    if (this._peers.size + this._unproved.size >= this._limits.maxPeers) return this._refuse(socket, 503, 'refused a peer link: too many');
    let secret = '';
    try {
      secret = text(this._readState().secret);
    } catch (error) {
      this._log(`could not read the state for a peer link: ${errorText(error)}`, 'error');
    }
    // 403 without a nonce, or with any Tailscale-* header; else the 101 with the hub's proof.
    const link = acceptPeer(req, socket, head, secret, { authTimeoutMs: this._peerAuthTimeoutMs });
    if (!link) {
      this._log('refused a peer link', 'warn');
      return;
    }
    destroyWhenEnded(socket);
    // Not a window yet: the link reads nothing but the peer's proof, and closes without it.
    this._unproved.add(link);
    link.once('auth', () => {
      this._unproved.delete(link);
      this.attachPeer(link); // in this same run: the lines behind the proof reach its listeners
    });
    link.once('close', () => {
      if (this._unproved.delete(link) && !this._closed) this._log('refused a peer link: it did not prove that it knows the secret', 'warn');
    });
  }

  /** @param {import('net').Socket} socket @param {number} status @param {string} why */
  _refuse(socket, status, why) {
    this._log(why, 'warn');
    respond(socket, status, { headers: TEXT_HEADERS, body: status === 403 ? 'Forbidden\n' : 'Service Unavailable\n' });
  }

  // ---- phones -----------------------------------------------------------------------------------

  /** @param {import('./ws.js').WsConnection} ws @param {import('net').Socket} socket */
  _acceptPhone(ws, socket) {
    /** @type {Phone} */
    const phone = {
      ws,
      deviceId: '',
      authed: false,
      closed: false,
      dropped: false,
      helloTimer: null,
      preauthFrames: 0,
      preauthCounted: true,
      visible: false,
      lastFrameAt: performance.now(),
      subs: new Map(),
      pending: new Map(),
      pendingFrames: 0,
      pendingBytes: 0,
      lastProjects: '',
    };
    this._phones.add(phone);
    this._preauthOpen++;
    socket.once('close', () => this._releasePreauth(phone));
    ws.on('message', (/** @type {string} */ line) => {
      try {
        this._onPhoneMessage(phone, line);
      } catch (error) {
        this._log(`a phone frame failed: ${errorText(error)}`, 'error');
      }
    });
    ws.on('close', () => this._dropPhone(phone));
    this._armHelloTimer(phone);
  }

  /** A socket stops counting against maxPreauth at its hello, or when its TCP connection is closed. @param {Phone} phone */
  _releasePreauth(phone) {
    if (!phone.preauthCounted) return;
    phone.preauthCounted = false;
    this._preauthOpen--;
  }

  /** The first frame, and each pair retry, has helloTimeoutMs. @param {Phone} phone */
  _armHelloTimer(phone) {
    if (phone.helloTimer) clearTimeout(phone.helloTimer);
    phone.helloTimer = setTimeout(() => this._closePhone(phone, CLOSE.badRequest, 'no hello in time'), this._helloTimeoutMs);
    phone.helloTimer.unref();
  }

  /** @param {Phone} phone @param {string} line */
  _onPhoneMessage(phone, line) {
    if (phone.closed) return;
    if (!phone.authed) {
      this._onPreauthMessage(phone, line);
      return;
    }
    phone.lastFrameAt = performance.now();
    this._touchDevice(phone.deviceId);
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      frame = undefined;
    }
    if (!isRecord(frame) || typeof frame.t !== 'string') return this._sendError(phone, 'bad_request', 'A frame must be a JSON object with a type.');
    switch (frame.t) {
      case 'ping':
        return this._send(phone, { t: 'pong' });
      case 'visibility':
        if (typeof frame.visible === 'boolean') phone.visible = frame.visible;
        return;
      case 'push_set':
      case 'push_clear':
      case 'push_test':
        return this._onPush(phone, frame);
      case 'sub':
        return this._onSub(phone, frame);
      case 'unsub':
        return this._onUnsub(phone, frame);
      case 'send':
      case 'answer':
      case 'interrupt':
      case 'open':
      case 'openClaude':
        return this._onAction(phone, frame);
      case 'pair':
      case 'hello':
        return this._sendError(phone, 'bad_request', 'This connection said hello already.');
      default:
        // A newer app's request: an answer at once instead of a timeout. Anything else is ignored.
        if (isAckId(frame.id)) this._send(phone, { t: 'ack', id: frame.id, ok: false, error: 'unknown_type' });
    }
  }

  /**
   * push_set, push_clear and push_test: acked with the notifier's answer. A request without an id is
   * an error frame, as for the window actions.
   * @param {Phone} phone @param {Record<string, any>} frame
   */
  _onPush(phone, frame) {
    const id = frame.id;
    if (!isAckId(id)) return this._sendError(phone, 'bad_request', 'A request needs an id.');
    /** @param {Record<string, any>} fields */
    const ack = (fields) => this._send(phone, { t: 'ack', id, ...fields });
    if (frame.t === 'push_test') {
      this._notifier.test(phone.deviceId).then(
        (result) => {
          if (result.ok) ack({ ok: true });
          else ack({ ok: false, error: result.error, ...(result.status !== undefined ? { status: result.status } : {}), ...(typeof result.reason === 'string' && result.reason !== '' ? { reason: result.reason } : {}) });
        },
        () => ack({ ok: false, error: 'push_failed' }),
      );
      return;
    }
    let result;
    try {
      result = frame.t === 'push_set' ? this._notifier.setPush(phone.deviceId, frame) : this._notifier.clearPush(phone.deviceId);
    } catch (error) {
      this._log(`a push request failed: ${errorText(error)}`, 'error');
      return ack({ ok: false, error: 'save_failed' });
    }
    if (result.ok) return ack({ ok: true });
    return ack({ ok: false, error: result.error });
  }

  /** Before hello only pair and hello count; anything else closes the socket. @param {Phone} phone @param {string} line */
  _onPreauthMessage(phone, line) {
    phone.preauthFrames++;
    if (line.length > MAX_PREAUTH_FRAME_CHARS || phone.preauthFrames > this._limits.maxPreauthFrames) {
      this._closePhone(phone, CLOSE.badRequest, 'expected pair or hello');
      return;
    }
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      frame = undefined;
    }
    const type = isRecord(frame) ? frame.t : undefined;
    if (type === 'pair' && frame) {
      this._armHelloTimer(phone);
      this._onPair(phone, frame);
    } else if (type === 'hello' && frame) {
      this._onHello(phone, frame);
    } else {
      this._closePhone(phone, CLOSE.badRequest, 'expected pair or hello');
    }
  }

  /** @param {Phone} phone @param {Record<string, any>} frame */
  _onPair(phone, frame) {
    const now = this._now();
    if (!this._pairing.consume(frame.code, now)) {
      this._log('a phone sent a pairing code that is wrong, used or expired', 'warn');
      this._sendError(phone, 'bad_code', 'That pairing code is wrong, used or expired. Make a new one on the Mac.');
      this._emitChange(); // the code may be burnt now
      return;
    }
    const { device, token } = createDevice({ name: frame.device, origin: phone.ws.origin, now });
    try {
      this._updateState((state) => {
        if (!Array.isArray(state.devices)) state.devices = [];
        state.devices.push(device);
      });
    } catch (error) {
      this._log(`could not save a paired device: ${errorText(error)}`, 'error');
      this._sendError(phone, 'server_error', 'The Mac could not save the pairing. Make a new code and try again.');
      this._closePhone(phone, CLOSE.internal, 'the pairing was not saved');
      this._emitChange();
      return;
    }
    this._log(`paired a device: ${printable(device.name)} (${device.id})`);
    this._send(phone, { t: 'paired', deviceId: device.id, token, mac: { name: this._macNameText() } });
    this._emitChange();
  }

  /** @param {Phone} phone @param {Record<string, any>} frame */
  _onHello(phone, frame) {
    if (frame.v !== PROTOCOL_VERSION) {
      this._sendError(phone, 'unsupported_version', `This Mac speaks protocol version ${PROTOCOL_VERSION}. Update the app or the patch on the Mac.`);
      this._closePhone(phone, CLOSE.badRequest, 'unsupported protocol version');
      return;
    }
    let state;
    try {
      state = this._readState();
    } catch (error) {
      this._log(`could not read the state for a hello: ${errorText(error)}`, 'error');
      this._closePhone(phone, CLOSE.internal, 'state unavailable'); // no error frame: the app tries again later
      return;
    }
    const deviceId = frame.deviceId;
    const device = typeof deviceId === 'string' && !this._revoked.has(deviceId) ? findDevice(state, deviceId) : undefined;
    const tokenMatches = verifyToken(device ?? NO_DEVICE, frame.token);
    if (!device || !tokenMatches) {
      this._log('refused a hello: unknown device or wrong token', 'warn');
      this._refusePhone(phone, 'bad_token', 'This phone is not paired with this Mac (any more). Pair it again.');
      return;
    }
    if (typeof device.origin !== 'string' || device.origin !== phone.ws.origin) {
      this._log(`refused a hello from another app origin (device ${device.id})`, 'warn');
      this._refusePhone(phone, 'bad_origin', 'This app is not the one this phone was paired from. Pair it again from this app.');
      return;
    }
    if (phone.helloTimer) clearTimeout(phone.helloTimer);
    phone.helloTimer = null;
    phone.authed = true;
    phone.deviceId = device.id;
    phone.visible = true;
    phone.lastFrameAt = performance.now();
    this._releasePreauth(phone);
    phone.ws.setMaxPayload(MAX_FRAME_BYTES); // messages with photos
    phone.ws.setMaxBufferedBytes(this._limits.maxQueuedBytes); // snapshots
    const wasIdle = this._authed.size === 0;
    this._authed.add(phone);
    // The device's oldest sockets past the limit go; this one counts, so the count never drops to 0 here.
    const same = [...this._authed].filter((other) => other !== phone && other.deviceId === device.id);
    const excess = same.length + 1 - Math.max(1, this._limits.maxSocketsPerDevice);
    for (let i = 0; i < excess; i++) {
      // The error first, so an app that keeps opening connections can tell why it lost this one.
      this._sendError(same[i], 'too_many_connections', `This phone has more than ${this._limits.maxSocketsPerDevice} connections to the Mac; the oldest was closed.`);
      this._closePhone(same[i], CLOSE.replaced, 'replaced by a newer connection');
    }
    this._send(phone, { t: 'welcome', v: PROTOCOL_VERSION, mac: { name: this._macNameText() }, push: this._notifier.hasPush(device.id) });
    phone.lastProjects = this._projectsLine();
    this._sendText(phone, phone.lastProjects);
    if (wasIdle) this._setActive(true);
    this._touchDevice(device.id);
    this._log(`a phone connected (device ${device.id})`);
    this._emitChange();
  }

  /** An auth failure: the error frame first, so the app knows it is not a network problem, then 4401. @param {Phone} phone @param {string} code @param {string} message */
  _refusePhone(phone, code, message) {
    this._sendError(phone, code, message);
    this._closePhone(phone, CLOSE.unauthorized, code);
  }

  /** Notes that the device was heard from now: in memory only (see the top of this file). @param {string} deviceId */
  _touchDevice(deviceId) {
    this._lastSeen.set(deviceId, this._now());
  }

  /** @param {Phone} phone @param {Record<string, any>} frame */
  _onSub(phone, frame) {
    const { project, session } = frame;
    if (!isId(project) || !isId(session)) return this._sendError(phone, 'bad_request', 'sub needs a project and a session.');
    const key = subKey(project, session);
    if (!phone.subs.has(key)) {
      if (phone.subs.size >= this._limits.maxSubscriptions) {
        return this._sendError(phone, 'too_many_subscriptions', `A connection can watch at most ${this._limits.maxSubscriptions} sessions at once.`);
      }
      phone.subs.set(key, { project, session });
      let phones = this._subscribers.get(key);
      if (!phones) this._subscribers.set(key, (phones = new Set()));
      phones.add(phone);
    }
    this._requestSnapshot(phone, key, false);
  }

  /** @param {Phone} phone @param {Record<string, any>} frame */
  _onUnsub(phone, frame) {
    const { project, session } = frame;
    if (!isId(project) || !isId(session)) return this._sendError(phone, 'bad_request', 'unsub needs a project and a session.');
    const key = subKey(project, session);
    if (!phone.subs.delete(key)) return;
    const pending = phone.pending.get(key);
    if (pending) this._settle(phone, key, pending);
    this._unindex(phone, key);
  }

  /** @param {Phone} phone @param {string} key */
  _unindex(phone, key) {
    const phones = this._subscribers.get(key);
    if (!phones) return;
    phones.delete(phone);
    if (phones.size === 0) this._subscribers.delete(key);
  }

  /**
   * Asks the session's window for a snapshot; the session's events wait until it is sent. Without a
   * window under that id yet, it is asked when one comes (see _resubscribe). `force` replaces a call
   * in flight (the window came back); otherwise one in flight answers.
   * @param {Phone} phone @param {string} key @param {boolean} force
   */
  _requestSnapshot(phone, key, force) {
    const sub = phone.subs.get(key);
    if (!sub || phone.closed) return;
    const inFlight = phone.pending.get(key);
    if (inFlight) {
      if (!force) return;
      this._settle(phone, key, inFlight); // its answer is dropped, and so are the events held for it
    }
    const win = this._byPublicId.get(sub.project);
    if (!win) return;
    /** @type {PendingSnapshot} */
    const pending = { win, frames: [], bytes: 0 };
    phone.pending.set(key, pending);
    this._callWindow(win, 'snapshot', { session: sub.session }).then(
      (snapshot) => this._onSnapshot(phone, key, pending, snapshot),
      (error) => this._onSnapshotFailed(phone, key, pending, error),
    );
  }

  /** @param {Phone} phone @param {string} key @param {PendingSnapshot} pending @param {unknown} snapshot */
  _onSnapshot(phone, key, pending, snapshot) {
    const sub = phone.subs.get(key);
    if (phone.pending.get(key) !== pending || !sub) return;
    let line;
    try {
      if (!isRecord(snapshot)) throw new Error('no_snapshot');
      line = JSON.stringify({
        t: 'snapshot',
        project: sub.project,
        session: sub.session,
        messages: Array.isArray(snapshot.messages) ? snapshot.messages : [],
        pending: Array.isArray(snapshot.pending) ? snapshot.pending : [],
        state: typeof snapshot.state === 'string' ? snapshot.state : 'idle',
        live: snapshot.live === true,
        truncatedBefore: Math.max(0, Math.floor(finite(snapshot.truncatedBefore))),
      });
    } catch (error) {
      this._onSnapshotFailed(phone, key, pending, error);
      return;
    }
    this._settle(phone, key, pending);
    this._sendText(phone, line);
    for (const held of pending.frames) this._sendText(phone, held);
  }

  /** @param {Phone} phone @param {string} key @param {PendingSnapshot} pending @param {unknown} error */
  _onSnapshotFailed(phone, key, pending, error) {
    const sub = phone.subs.get(key);
    if (phone.pending.get(key) !== pending || !sub) return;
    this._settle(phone, key, pending);
    // A window that went away sends a fresh snapshot when it is back; until then there is nothing to say.
    if (!pending.win.removed) {
      this._log(`a snapshot failed: ${errorText(error)}`, 'warn');
      this._send(phone, { t: 'error', code: 'snapshot_failed', message: errorText(error), project: sub.project, session: sub.session });
    }
    for (const held of pending.frames) this._sendText(phone, held);
  }

  /** The snapshot call is over (answered, failed or replaced). @param {Phone} phone @param {string} key @param {PendingSnapshot} pending */
  _settle(phone, key, pending) {
    if (phone.pending.get(key) === pending) phone.pending.delete(key);
    phone.pendingFrames -= pending.frames.length;
    phone.pendingBytes -= pending.bytes;
  }

  /** @param {Phone} phone @param {PendingSnapshot} pending @param {string} line */
  _holdBack(phone, pending, line) {
    pending.frames.push(line);
    pending.bytes += line.length;
    phone.pendingFrames++;
    phone.pendingBytes += line.length;
    if (phone.pendingFrames > this._limits.maxPendingFrames || phone.pendingBytes > this._limits.maxPendingBytes) {
      this._log(`closed a phone whose snapshot took too long to keep its events (device ${phone.deviceId})`, 'warn');
      this._closePhone(phone, CLOSE.tryAgain, 'too far behind');
    }
  }

  /** send, answer, interrupt, open, openClaude: to the project's window, answered with an ack. @param {Phone} phone @param {Record<string, any>} frame */
  _onAction(phone, frame) {
    const id = frame.id;
    if (!isAckId(id)) return this._sendError(phone, 'bad_request', 'A request needs an id.');
    /** @param {Record<string, any>} fields */
    const ack = (fields) => this._send(phone, { t: 'ack', id, ...fields });
    const call = actionCall(frame);
    if (!call) return ack({ ok: false, error: 'bad_request' });
    const win = this._byPublicId.get(frame.project);
    if (!win) return ack({ ok: false, error: 'unknown_project' });
    this._callWindow(win, call.method, call.args).then(
      (result) => {
        /** @type {Record<string, any>} */
        const fields = { ok: true };
        if (call.method === 'send' && isRecord(result)) {
          if (typeof result.session === 'string') fields.session = result.session; // null: a new session not named yet
          if (typeof result.uuid === 'string') fields.uuid = result.uuid;
        }
        ack(fields);
      },
      (error) => ack({ ok: false, error: errorText(error) }),
    );
  }

  /**
   * Whether a paired phone of this device is looking at the app: an authed, open socket that said it
   * is visible (the hello counts as visible) and sent a frame within lookFreshMs. A suspended app
   * stops pinging, so it stops counting as looking.
   * @param {string} deviceId
   */
  _isLooking(deviceId) {
    const now = performance.now();
    for (const phone of this._authed) {
      if (phone.deviceId !== deviceId || phone.closed) continue;
      if (phone.ws.readyState !== 'open') continue;
      if (phone.visible !== false && now - phone.lastFrameAt <= this._limits.lookFreshMs) return true;
    }
    return false;
  }

  /** Closes the phones past their hello that sent nothing for idleTimeoutMs. */
  _closeIdlePhones() {
    const now = performance.now();
    for (const phone of [...this._authed]) {
      if (now - phone.lastFrameAt <= this._idleTimeoutMs) continue;
      this._log(`closed an idle phone connection (device ${phone.deviceId})`);
      this._closePhone(phone, CLOSE.idle, 'idle');
    }
  }

  /** @param {Phone} phone @param {object} frame */
  _send(phone, frame) {
    let line;
    try {
      line = JSON.stringify(frame);
    } catch (error) {
      this._log(`dropped a frame that is not JSON: ${errorText(error)}`, 'warn');
      return false;
    }
    return this._sendText(phone, line);
  }

  /**
   * Sends a frame, unless the phone has more than maxQueuedBytes still waiting in its socket: such a
   * phone is closed (1013) instead, and gets a fresh snapshot when it is back. The backlog is looked
   * at before the frame goes in, so one big frame (a snapshot) alone never closes a phone.
   * @param {Phone} phone @param {string} line
   */
  _sendText(phone, line) {
    if (phone.closed || phone.ws.readyState !== 'open') return false;
    if (phone.ws.bufferedAmount > this._limits.maxQueuedBytes) {
      this._log(`closed a phone that reads too slowly (device ${phone.deviceId || 'not connected yet'})`, 'warn');
      this._closePhone(phone, CLOSE.tryAgain, 'too slow');
      return false;
    }
    phone.ws.send(line);
    return true;
  }

  /** @param {Phone} phone @param {string} code @param {string} message */
  _sendError(phone, code, message) {
    this._send(phone, { t: 'error', code, message });
  }

  /** @param {Phone} phone @param {number} code @param {string} reason */
  _closePhone(phone, code, reason) {
    if (phone.closed) return;
    this._dropPhone(phone);
    try {
      phone.ws.close(code, reason);
    } catch {
      // closing already
    }
  }

  /** Forgets a phone: its subscriptions, held-back events and timer. Idempotent. @param {Phone} phone */
  _dropPhone(phone) {
    phone.closed = true;
    if (phone.dropped) return;
    phone.dropped = true;
    if (phone.helloTimer) clearTimeout(phone.helloTimer);
    phone.helloTimer = null;
    this._phones.delete(phone);
    for (const key of phone.subs.keys()) this._unindex(phone, key);
    phone.subs.clear();
    phone.pending.clear();
    phone.pendingFrames = 0;
    phone.pendingBytes = 0;
    if (this._authed.delete(phone)) {
      this._log(`a phone disconnected (device ${phone.deviceId})`);
      if (this._authed.size === 0 && !this._closed) this._setActive(false);
      this._emitChange();
    }
  }

  // ---- pairing, devices, app address --------------------------------------------------------------

  /**
   * Makes a new pairing code (it replaces the one before): single use, 10 minutes, 5 tries. The link
   * and QR code carry the Mac's Tailscale address; while the hub has not learnt the Mac's DNS name
   * yet (it asks Tailscale in the background) they are empty, and info() has them once it is known.
   * @returns {PairingView}
   */
  newPairingCode() {
    if (this._closed) throw codedError('closed');
    this._refreshTailscale();
    const { code, expiresAt } = this._pairing.newCode(this._now());
    this._log('made a new pairing code');
    this._emitChange();
    return this._pairingView(code, expiresAt, this._appUrl());
  }

  /** The paired devices from state.json, without their token hashes; lastSeenAt as this hub heard them if that is later. */
  devices() {
    let state;
    try {
      state = this._readState();
    } catch (error) {
      this._log(`could not read the devices: ${errorText(error)}`, 'warn');
      return [];
    }
    return this._publicDevices(state);
  }

  /**
   * Removes a device: its sockets get `revoked` and 4401, state.json loses it (read back to make
   * sure), and this hub refuses it from now on. An unknown id is nothing to do. Rejects `bad_id` for
   * an id that is not a string, `remove_failed` when state.json cannot be written or read back, or
   * still holds the device after three writes (another window keeps writing an old copy). The hub
   * refuses the device either way.
   * @param {unknown} id
   * @returns {Promise<void>}
   */
  async removeDevice(id) {
    if (typeof id !== 'string' || id === '' || id.length > MAX_ID_CHARS) throw codedError('bad_id');
    this._revoked.add(id);
    for (const phone of [...this._authed]) {
      if (phone.deviceId === id) this._refusePhone(phone, 'revoked', 'This phone was removed on the Mac. Pair it again to use it.');
    }
    this._lastSeen.delete(id);
    let gone = false;
    /** @type {unknown} */
    let failure;
    for (let attempt = 0; attempt < 3 && !gone; attempt++) {
      try {
        this._updateState((state) => {
          const devices = Array.isArray(state.devices) ? state.devices : [];
          for (let i = devices.length - 1; i >= 0; i--) {
            if (isRecord(devices[i]) && devices[i].id === id) devices.splice(i, 1);
          }
        });
        gone = findDevice(this._readState(), id) === undefined;
      } catch (error) {
        failure = error;
      }
    }
    if (gone) this._log(`removed a device (${id})`);
    else this._log(`could not remove a device (${id}) from state.json${failure === undefined ? '' : `: ${errorText(failure)}`}; this hub refuses it anyway`, 'warn');
    this._emitChange();
    if (!gone) throw codedError('remove_failed');
  }

  /**
   * Saves the app's address (for the pairing link): `https://…` or '' to clear it. Throws `bad_url`
   * for anything else (see normalizeAppUrl).
   * @param {unknown} url
   * @returns {Promise<void>}
   */
  async setAppUrl(url) {
    const appUrl = normalizeAppUrl(url);
    this._updateState((state) => {
      state.appUrl = appUrl;
    });
    this._emitChange();
  }

  /**
   * What the Connection tab shows: the windows registered (with or without a project), the phones
   * past their hello, the paired devices and the pairing code while it can still be used.
   * @returns {{ windows: number, phones: number, devices: ReturnType<Hub['_publicDevices']>, pairing: PairingView | null }}
   */
  info() {
    this._refreshTailscale();
    let state;
    try {
      state = this._readState();
    } catch (error) {
      this._log(`could not read the state: ${errorText(error)}`, 'warn');
    }
    const live = this._pairing.current(this._now());
    return {
      windows: this._windows.size,
      phones: this._authed.size,
      devices: this._publicDevices(state),
      pairing: live ? this._pairingView(live.code, live.expiresAt, usableAppUrl(state ? state.appUrl : '')) : null,
    };
  }

  /** Phone sockets past their hello. */
  phoneCount() {
    return this._authed.size;
  }

  /** Peer links (other VS Code windows) that proved themselves and are still open. */
  peerCount() {
    return this._peers.size;
  }

  /** @param {unknown} state */
  _publicDevices(state) {
    const devices = isRecord(state) && Array.isArray(state.devices) ? state.devices : [];
    return devices.filter(isRecord).map((device) => ({
      id: text(device.id),
      name: text(device.name),
      origin: text(device.origin),
      createdAt: finite(device.createdAt),
      lastSeenAt: Math.max(finite(device.lastSeenAt), this._lastSeen.get(text(device.id)) ?? 0),
      push: isRecord(device.push),
    }));
  }

  _appUrl() {
    try {
      return usableAppUrl(this._readState().appUrl);
    } catch {
      return '';
    }
  }

  /** @param {string} code @param {number} expiresAt @param {string} appUrl @returns {PairingView} */
  _pairingView(code, expiresAt, appUrl) {
    const url = this._dnsName !== '' && this.port > 0 ? `https://${this._dnsName}:${this.port}` : '';
    const link = url === '' ? '' : pairingLink({ appUrl, url, code, macName: this._macNameText() });
    const memo = this._pairingMemo;
    if (!memo || memo.code !== code || memo.expiresAt !== expiresAt || memo.link !== link) {
      /** @type {PairingView['qr']} */
      let qr = null;
      if (link !== '') {
        try {
          qr = qrSvgPath(link);
        } catch (error) {
          this._log(`could not draw the pairing QR code: ${errorText(error)}`, 'warn');
        }
      }
      this._pairingMemo = { code, expiresAt, link, view: { code: formatCode(code), expiresAt, link, qr } };
    }
    const view = /** @type {NonNullable<Hub['_pairingMemo']>} */ (this._pairingMemo).view;
    return { ...view, qr: view.qr && { ...view.qr } };
  }

  // ---- Tailscale --------------------------------------------------------------------------------

  /**
   * The Tailscale status, or {} when it cannot be read in time. Learns the Mac's DNS name from it.
   * Never rejects.
   * @returns {Promise<Record<string, any>>}
   */
  async _readTailscale() {
    this._statusReadAt = performance.now();
    let status;
    try {
      status = await withTimeout(Promise.resolve().then(() => this._tailscale.status()), STATUS_TIMEOUT_MS);
    } catch {
      return {};
    }
    if (!isRecord(status)) return {};
    const login = text(status.loginName).trim();
    if (login !== '') this._owner = login;
    const dnsName = status.dnsName;
    if (typeof dnsName === 'string' && dnsName.length <= 253 && DNS_NAME_RE.test(dnsName) && dnsName !== this._dnsName) {
      this._dnsName = dnsName;
      this._emitChange();
    }
    return status;
  }

  /** Reads the status in the background, at most every 5 s (`force`: now, unless a read runs). @param {boolean} [force] */
  _refreshTailscale(force = false) {
    if (this._closed || this._statusRead) return;
    if (!force && performance.now() - this._statusReadAt < STATUS_REFRESH_MS) return;
    this._statusRead = this._readTailscale().finally(() => {
      this._statusRead = null;
    });
  }

  // ---- small things -----------------------------------------------------------------------------

  _macNameText() {
    try {
      const name = this._macName();
      if (typeof name === 'string' && name.trim() !== '') return name.trim().slice(0, 100);
    } catch {
      // fall through
    }
    return 'Mac';
  }

  _emitChange() {
    if (this._closed) return;
    try {
      this.emit('change');
    } catch (error) {
      this._log(`a change listener failed: ${errorText(error)}`, 'error');
    }
  }

  /** Emits an event for the hub's listeners; one that throws is logged. @param {string} name @param {...unknown} args */
  _emitSafe(name, ...args) {
    try {
      this.emit(name, ...args);
    } catch (error) {
      this._log(`a listener of '${name}' failed: ${errorText(error)}`, 'error');
    }
  }

  /** @param {string} message @param {'info' | 'warn' | 'error'} [level] */
  _log(message, level = 'info') {
    try {
      this._logger(message, level);
    } catch {
      // a logger that throws must not break the hub
    }
  }
}

module.exports = { Hub, PROTOCOL_VERSION, DEFAULT_CALL_TIMEOUTS_MS, normalizeAppUrl };
