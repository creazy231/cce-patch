// @ts-check
'use strict';
// The coordinator: one per VS Code window (extension host). Remote access is on or off for every
// window at once: `enabled` in state.json, which the Connection tab of any window sets and every
// window watches. While it is on, one window is the hub: it listens on 127.0.0.1:<port>, where
// `tailscale serve` sends the phone, and the other windows join it as local peers over a peer link
// (peer-link.js). Whoever binds the port first is the hub; a window that finds the port taken joins
// what answers there. When the hub's window closes, its peers lose their links, wait a random
// moment and race for the port again, so one of them takes over within about 2 s; the phones
// reconnect to it with their tokens, since the devices live in state.json and not in the hub.
//
// Roles: off (remote access is off, or the window stopped), starting (looking for the hub), hub,
// peer, error (the port is held by another program, or cannot be bound: tried again every few
// seconds, and the role stays error until a try works).
//
// The window joins the hub through its WindowAgent: the hub calls the agent (snapshot, send, answer,
// interrupt, open, openClaude, active), and the agent's project and session events go to the hub.
// A peer passes session events on only while a phone is connected (the hub's `active`), so the
// stream of an unwatched session does not cross the link. The agent's attention events (a prompt
// appeared, a turn ended: what a notification is for) go to the hub at all times, since they matter
// exactly when no phone is looking.
//
// It also answers the Connection tab (connection-ui.js): status(), connect(), disconnect(), and the
// hub's business (a pairing code, a device's removal, the app's address), which a peer asks the hub
// for over its link. While no hub runs at all, removing a device and setting the address write the
// state file directly: the hub is the one writer of those only while it exists.
//
// Tailscale serve publishes 127.0.0.1:<port> to the whole tailnet, so it is on only while the port is
// ours: connect() looks at what answers there first (free, or a hub's /health), and a window that
// finds another program on the port turns serve off and pauses until the port is free again. A
// serve-off that fails (Tailscale's service is not reachable) is tried again until it works, and
// the Connection tab says so meanwhile. The last window to close (the hub, with no peer left to
// take over) turns serve off as well, and leaves remote access on: the next start serves again.
//
// Nothing logged here holds the secret, a token, a pairing code or link, or a consent link.

const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const os = require('os');
const { EventEmitter } = require('events');
const store = require('./store.js');
const { connectPeer } = require('./peer-link.js');
const { formatCode, normalizeCode } = require('./pairing.js');
const { Hub, normalizeAppUrl } = require('./hub.js');

const DEFAULT_RETRY_MS = [300, 1500];
const DEFAULT_ERROR_RETRY_MS = [4000, 8000];
const WATCH_INTERVAL_MS = 2000;
// How long the window at the port may take to accept a peer: a hub answers at once.
const PEER_TIMEOUT_MS = 3000;
// How long a peer waits for the hub to answer the Connection tab.
const CALL_TIMEOUT_MS = 5000;
// How long connect() waits for the first election to end.
const SETTLE_MS = 8000;
// How long a `tailscale serve status` answer is reused (the Connection tab asks every 2 s).
const SERVE_CHECK_MS = 5000;
// While remote access is on but serve is not set up (consent pending, Tailscale was off), how often
// serve is tried again when the Connection tab or a new hub looks.
const SERVE_RETRY_MS = 30000;
// How often a serve-off that failed is tried again.
const SERVE_OFF_RETRY_MS = 30000;
const CLOSE_TIMEOUT_MS = 3000;
const MAX_PROBE_ANSWER_CHARS = 16 * 1024;
// Failures that are probably passing (the hub closed between our listen and our connect) are tried
// again quickly this many times before they count as an error.
const QUICK_TRIES = 5;
// A pairing code with less time than this left is replaced rather than shown.
const PAIRING_MARGIN_MS = 1000;
const LOGGED_FAILURES = 20;
const MAX_DEVICE_ID_CHARS = 128;
const CONSENT_URL_RE = /^https:\/\/login\.tailscale\.com\//;

/** @typedef {import('./store.js').State} State */
/** @typedef {'off' | 'starting' | 'hub' | 'peer' | 'error'} Role */
/**
 * @typedef {{ installed: boolean, running: boolean, loginName?: string, dnsName?: string,
 *   httpsEnabled: boolean, consentUrl?: string }} TailscaleView
 * @typedef {{ code: string, expiresAt: number, link: string, qr?: { size: number, path: string } }} PairingView
 * @typedef {{ id: string, name: string, createdAt: number, lastSeenAt: number, push: boolean }} DeviceView
 * @typedef {{ enabled: boolean, role: Role, error?: string, port: number, url?: string, macName: string,
 *   tailscale: TailscaleView, serve: { configured: boolean }, windows: number, devices: DeviceView[],
 *   pairing?: PairingView, appUrl: string, chromeAutoAccept: boolean }} ConnectionStatus
 * @typedef {{ project(project: object): void, session(sessionId: string, ev: object): void, attention(ev: object): void, usage(reading: object): void, dispose(): void }} Sink
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} */
function isText(value) {
  return typeof value === 'string' && value !== '';
}

/** @param {string} code */
function codeError(code) {
  return Object.assign(new Error(code), { code });
}

/** @param {unknown} error */
function errorText(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** @param {unknown} error */
function codeOf(error) {
  if (isRecord(error) && isText(error.code)) return error.code;
  return errorText(error);
}

/** @template {{ unref?: () => unknown }} T @param {T} timer @returns {T} */
function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/** A whole number of milliseconds between the two ends of `range`. @param {unknown} range @param {number[]} fallback */
function randomIn(range, fallback) {
  const [low, high] = Array.isArray(range) && range.length === 2 && range.every((n) => typeof n === 'number' && n >= 0) ? range : fallback;
  return Math.round(Math.min(low, high) + Math.random() * Math.abs(high - low));
}

/** This machine's name: its host name without `.local`. */
function localName() {
  try {
    const name = os.hostname().replace(/\.local\.?$/i, '');
    return name || 'Mac';
  } catch {
    return 'Mac';
  }
}

/** @param {unknown} id */
function isDeviceId(id) {
  return isText(id) && id.length <= MAX_DEVICE_ID_CHARS;
}

/**
 * What holds the port while the window is paused, for the log and the Connection tab.
 * @param {'program' | 'bridge'} kind
 */
function foreignHolder(kind) {
  if (kind === 'program') return 'another program';
  return 'a program that answers like a CCE Remote bridge but cannot prove it is one of your VS Code windows (a window not reloaded since the patch was updated looks the same)';
}

/** The peer windows joined to a hub; a hub that cannot say counts as having none. @param {any} hub */
function peerCountOf(hub) {
  try {
    return typeof hub.peerCount === 'function' ? count(hub.peerCount()) : 0;
  } catch {
    return 0;
  }
}

/** @param {unknown} value */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** @param {unknown} value */
function time(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Devices as the Connection tab shows them: never the token hash or the origin. lastSeenAt is the
 * hub's when it is later than the file's: the hub keeps it in memory (hub.js).
 * @param {unknown} devices
 * @param {Map<string, number>} [seen]  device id → lastSeenAt, as the hub knows it
 * @returns {DeviceView[]}
 */
function publicDevices(devices, seen) {
  if (!Array.isArray(devices)) return [];
  /** @type {DeviceView[]} */
  const out = [];
  for (const device of devices) {
    if (!isRecord(device) || !isText(device.id)) continue;
    const lastSeenAt = Math.max(time(device.lastSeenAt), seen?.get(device.id) ?? 0);
    out.push({ id: device.id, name: isText(device.name) ? device.name : 'Phone', createdAt: time(device.createdAt), lastSeenAt, push: isRecord(device.push) });
  }
  return out;
}

/**
 * When the hub last heard from each device, from its info() (or its answer to a peer's status).
 * @param {unknown} info
 * @returns {Map<string, number>}
 */
function lastSeenOf(info) {
  /** @type {Map<string, number>} */
  const seen = new Map();
  const devices = isRecord(info) && Array.isArray(info.devices) ? info.devices : [];
  for (const device of devices) {
    if (isRecord(device) && isText(device.id)) seen.set(device.id, time(device.lastSeenAt));
  }
  return seen;
}

/**
 * A pairing code as the hub made it, checked and shown `XXXX-XXXX`; undefined unless it is valid for
 * a while yet (the tab asks for a new one when it runs out, so it must never get one that has). The
 * link (and the QR code) are empty while the hub does not know the Mac's Tailscale name yet: the
 * code is good all the same, and is not replaced for that.
 * @param {unknown} pairing
 * @param {number} now
 * @returns {PairingView | undefined}
 */
function livePairing(pairing, now) {
  if (!isRecord(pairing)) return undefined;
  const code = normalizeCode(pairing.code);
  if (code.length !== 8 || typeof pairing.expiresAt !== 'number' || !(pairing.expiresAt - now > PAIRING_MARGIN_MS)) return undefined;
  /** @type {PairingView} */
  const view = { code: formatCode(code), expiresAt: pairing.expiresAt, link: typeof pairing.link === 'string' ? pairing.link : '' };
  const qr = pairing.qr;
  if (isRecord(qr) && Number.isInteger(qr.size) && qr.size > 0 && isText(qr.path)) view.qr = { size: qr.size, path: qr.path };
  return view;
}

/**
 * The hub's call to a window, carried out by its agent. Whatever the agent throws (its error codes)
 * is the answer; the hub passes the message on to the phone. Each call is awaited here, not just
 * returned: the agent's rejected promise then has a handler before this turn ends (Bun, which runs
 * the tests, reports one that gets it a microtask later as unhandled).
 * @param {any} agent
 * @param {string} method
 * @param {unknown} args
 */
async function callAgent(agent, method, args) {
  const a = isRecord(args) ? args : {};
  switch (method) {
    case 'snapshot':
      return await agent.snapshot(a.session);
    case 'send':
      return await agent.send(a.session === undefined ? null : a.session, a.text, a.images === undefined || a.images === null ? undefined : a.images);
    case 'answer':
      return await agent.answer(a.session, a.requestId, a.choice);
    case 'interrupt':
      return await agent.interrupt(a.session);
    case 'open':
      return await agent.open(a.session);
    case 'openClaude':
      return await agent.openClaude();
    case 'active':
      agent.setActive(a.on === true);
      return undefined;
    case 'usage':
      return await agent.refreshUsage();
    case 'commands':
      // An agent without it is an older window's: it answers as one would.
      if (typeof agent.commands !== 'function') throw codeError('unknown_method');
      return await agent.commands();
    default:
      throw codeError('unknown_method');
  }
}

/**
 * The promise itself, with a handler attached at once. The hub, or the peer link, handles the
 * failure (it answers the call with it), but only a microtask later, which Bun reports as an
 * unhandled rejection.
 * @template T
 * @param {Promise<T>} promise
 * @returns {Promise<T>}
 */
function answered(promise) {
  promise.catch(() => {});
  return promise;
}

/**
 * The hub's close(), never rejecting and never waiting more than `ms`.
 * @param {any} hub
 * @param {number} ms
 * @param {{ reason?: string }} [options]  `reason: 'disabled'` when remote access was turned off: the phones are told
 */
function closeQuietly(hub, ms, options) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const closing = Promise.resolve()
    .then(() => (options ? hub.close(options) : hub.close()))
    .catch(() => {});
  const late = new Promise((resolve) => {
    timer = unref(setTimeout(resolve, ms));
  });
  return Promise.race([closing, late]).then(() => clearTimeout(timer));
}

/** @param {any} options */
function defaultCreateHub(options) {
  return new Hub(options);
}

/**
 * What a `GET /health` answer says: 'ours' when it is a hub's (200, JSON with app "cce-remote"),
 * 'other' for anything else, undefined while it may still be arriving.
 * @param {string} text  the answer so far
 * @param {boolean} complete  the connection has ended
 * @returns {'ours' | 'other' | undefined}
 */
function readHealth(text, complete) {
  const end = text.indexOf('\r\n\r\n');
  if (end === -1) return complete ? 'other' : undefined;
  if (!/^HTTP\/1\.[01] 200[ \r]/.test(text)) return 'other';
  try {
    const body = JSON.parse(text.slice(end + 4));
    return isRecord(body) && body.app === 'cce-remote' ? 'ours' : 'other';
  } catch {
    return complete ? 'other' : undefined;
  }
}

/**
 * Who has 127.0.0.1:`port`: 'free' (nothing listens), 'ours' (a hub: `GET /health` says so),
 * 'other' (any other answer: another status or body, a reset, a hang-up, garbage) or 'unknown' (no
 * answer in time: a hub whose window is busy looks the same as a program that never answers).
 * Never rejects.
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<'free' | 'ours' | 'other' | 'unknown'>}
 */
function probePort(port, timeoutMs) {
  return new Promise((resolve) => {
    let text = '';
    let settled = false;
    const socket = net.connect({ host: '127.0.0.1', port });
    /** @param {'free' | 'ours' | 'other' | 'unknown'} owner */
    const finish = (owner) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(owner);
    };
    const timer = unref(setTimeout(() => finish('unknown'), timeoutMs));
    socket.on('connect', () => socket.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`));
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1');
      const owner = text.length > MAX_PROBE_ANSWER_CHARS ? 'other' : readHealth(text, false);
      if (owner) finish(owner);
    });
    socket.on('end', () => finish(readHealth(text, true) ?? 'other'));
    socket.on('close', () => finish(readHealth(text, true) ?? 'other'));
    socket.on('error', (error) => finish(/** @type {NodeJS.ErrnoException} */ (error).code === 'ECONNREFUSED' ? 'free' : 'other'));
  });
}

/**
 * The state file: missing (remote access was never turned on here), read, or there but not
 * readable right now (permissions, I/O). Only "missing" means off; an unreadable file keeps what
 * was last read.
 * @param {Record<string, string | undefined>} env
 * @returns {{ kind: 'missing' } | { kind: 'ok', state: State } | { kind: 'unreadable', error: unknown }}
 */
function readState(env) {
  const file = store.statePath(/** @type {any} */ (env));
  try {
    fs.statSync(file);
  } catch (error) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    return { kind: 'unreadable', error };
  }
  try {
    return { kind: 'ok', state: store.loadState(/** @type {any} */ (env)) };
  } catch (error) {
    return { kind: 'unreadable', error };
  }
}

class Coordinator extends EventEmitter {
  /**
   * @param {{
   *   agent?: any,
   *   tailscale?: any,
   *   env?: Record<string, string | undefined>,
   *   log?: ((line: string) => void) & { warn?: (line: string) => void },
   *   macName?: string | (() => string),
   *   retryMs?: number[],
   *   errorRetryMs?: number[],
   *   watchIntervalMs?: number,
   *   peerTimeoutMs?: number,
   *   callTimeoutMs?: number,
   *   serveRetryMs?: number,
   *   serveOffRetryMs?: number,
   *   createHub?: (options: object) => any,
   *   now?: () => number,
   * }} [options]
   *   agent: this window's WindowAgent. tailscale: a Tailscale (tailscale.js). env: where the state
   *   lives and which port to use (CCE_REMOTE_HOME, CCE_REMOTE_PORT). log: one line per call, with
   *   `log.warn` for problems. macName: the Mac's name when Tailscale does not know it (Tailscale's
   *   host name wins). retryMs: the pause before looking for the hub again after losing it;
   *   errorRetryMs: the pause between tries while the port is held by another program. The rest is
   *   for tests: the state file's polling interval, the peer upgrade, probe and call timeouts, how
   *   often a missing serve is set up again and a failed serve-off tried again, the hub's maker and
   *   the clock.
   */
  constructor({
    agent,
    tailscale,
    env = process.env,
    log = () => {},
    macName,
    retryMs = DEFAULT_RETRY_MS,
    errorRetryMs = DEFAULT_ERROR_RETRY_MS,
    watchIntervalMs = WATCH_INTERVAL_MS,
    peerTimeoutMs = PEER_TIMEOUT_MS,
    callTimeoutMs = CALL_TIMEOUT_MS,
    serveRetryMs = SERVE_RETRY_MS,
    serveOffRetryMs = SERVE_OFF_RETRY_MS,
    createHub = defaultCreateHub,
    now = Date.now,
  } = {}) {
    super();
    this.agent = agent;
    this.tailscale = tailscale;
    this.env = env;
    this.retryMs = retryMs;
    /** @type {Role} */
    this.role = 'off';
    this._log = log;
    this._macName = macName;
    this._errorRetryMs = errorRetryMs;
    this._watchIntervalMs = watchIntervalMs;
    this._peerTimeoutMs = peerTimeoutMs;
    this._callTimeoutMs = callTimeoutMs;
    this._serveRetryMs = serveRetryMs;
    this._serveOffRetryMs = serveOffRetryMs;
    this._createHub = createHub;
    this._now = now;
    // The window's key with the hub: its own, so two windows of one project never share one.
    this._key = crypto.randomBytes(8).toString('hex');

    this._started = false;
    // What the window last saw in the state file: a change of anything else is no reason to act.
    this._enabled = false;
    this._port = store.effectivePort(null, env);
    // Bumped whenever the window stops being what it was: work begun for an older value is dropped.
    this._gen = 0;
    /** @type {any} */
    this._hub = null;
    /** @type {any} */
    this._link = null;
    /** @type {{ dispose(): void } | null} the agent's tie to the hub */
    this._binding = null;
    /** @type {NodeJS.Timeout | undefined} */
    this._retryTimer = undefined;
    /** @type {Promise<unknown>} the last hub's close */
    this._closing = Promise.resolve();
    this._failures = 0;
    /** @type {string | undefined} why the role is error (but see _foreignPort) */
    this._error = undefined;
    /** @type {number | undefined} the port another program holds, while the role is error for it */
    this._foreignPort = undefined;
    /** @type {'program' | 'bridge'} what holds it: any program, or one that answers /health like a hub but refuses this window */
    this._foreignKind = 'program';
    /** @type {State | null} the state last read, for a moment when the file cannot be read */
    this._lastState = null;
    // The Connection tab's Claude in Chrome switch (`chromeAutoAccept: true` in the state file), as last read.
    this._chromeAutoAccept = false;
    /** @type {(() => void) | null} */
    this._unwatch = null;

    /** @type {string | undefined} the link Tailscale gave for enabling serve, until serve works */
    this._consentUrl = undefined;
    /** @type {string | undefined} why serve could not be set up, while remote access is on */
    this._serveError = undefined;
    this._serve = { port: 0, at: -Infinity, configured: false };
    /** @type {Promise<boolean> | null} */
    this._serveCheck = null;
    this._lastServeAttempt = -Infinity;
    /** @type {Promise<void> | null} */
    this._serving = null;
    // This window turned serve off because another program held the port: on again once a hub of ours has it.
    this._servePaused = false;
    // connect() is running: it sets serve up itself once the election is over.
    this._connecting = false;
    // stop() ran: nothing of this window runs on (a serve-off try in flight does not arm another).
    this._stopped = false;
    /**
     * Serve-offs that failed, one per port, tried again until they work: `disabled` (wanted while
     * remote access is off, or for a port that is not the current one), `foreign` (wanted while
     * another program holds the port).
     * @type {Map<number, { port: number, cause: 'disabled' | 'foreign', reason: string, at: number, timer: NodeJS.Timeout | undefined, running: boolean }>}
     */
    this._serveOffs = new Map();
    /** @type {string | undefined} Tailscale's name for this machine */
    this._hostName = undefined;
    this._installed = true;
    /** @type {{ windows: number, pairing: unknown, seen: Map<string, number> } | null} the hub's answer a peer last got */
    this._remote = null;
    /** @type {{ link: any, promise: Promise<unknown> } | null} a peer's request for a code, while it runs */
    this._codeRequest = null;
    this._failuresLogged = 0;
  }

  // ---- lifecycle ------------------------------------------------------------------------------------

  /** Reads the state, watches it, and looks for the hub when remote access is on. Idempotent. */
  start() {
    if (this._started) return this;
    this._started = true;
    this._stopped = false;
    const read = this._read();
    this._setEnabled(read.kind === 'ok' && read.state.enabled === true);
    this._port = store.effectivePort(read.kind === 'ok' ? read.state : null, this.env);
    try {
      this._unwatch = store.watchState(
        (next) => {
          this._onState(next);
          this._retryServeOff();
        },
        /** @type {any} */ (this.env),
        this._watchIntervalMs,
      );
    } catch (error) {
      this._warn(`cannot watch the state file (${errorText(error)})`);
    }
    if (read.kind === 'unreadable') {
      // Whether remote access is on is not known: the election reads the file again, until it can.
      this._warn(`can't read the remote access settings (${errorText(read.error)}); trying again`);
      this._restart(randomIn(this.retryMs, DEFAULT_RETRY_MS));
    } else if (this._enabled) {
      this._say('remote access is on: looking for the window that serves the phone');
      this._restart(0);
    } else if (read.kind === 'ok') {
      this._cleanStaleServe(this._port);
    }
    return this;
  }

  /**
   * Lets go of everything (the window closes): the hub or the link, the agent's tie to it, the
   * watching and every timer. Remote access stays on for the other windows, and for the next start.
   * When this window is the hub and no other window is joined to it, nothing takes the port over:
   * serve goes off too (one try; a failure is left to the next start), so nothing is published
   * while no window listens. Resolves once the hub this window ran is closed and that try is over.
   * @returns {Promise<void>}
   */
  async stop() {
    const lastWindow = this.role === 'hub' && this._hub !== null && peerCountOf(this._hub) === 0;
    const port = this._port;
    this._started = false;
    if (this._unwatch) {
      try {
        this._unwatch();
      } catch (error) {
        this._quiet(error);
      }
      this._unwatch = null;
    }
    this._stopped = true; // a serve-off try in flight does not arm another
    this._clearServeOffs(); // the window closes: nothing of it runs on
    this._tellAgent(false); // and its agent mirrors nothing any more
    this._chromeAutoAccept = false; // nor answers a prompt
    const serveOff = lastWindow ? this._serveOffAtExit(port) : Promise.resolve(); // first: it is what matters if time runs out
    await this._shutdown();
    await serveOff;
  }

  /** The last window closes: serve off for its port, once. Never rejects. @param {number} port */
  async _serveOffAtExit(port) {
    this._say(`the last window that serves the phone closes: turning tailscale serve off for port ${port} (remote access stays on, and the next start serves again)`);
    try {
      if (!(await this._turnServeOff(port, 'disabled'))) {
        this._warn(`tailscale serve could not be turned off for port ${port} as the last window closed; the next start of VS Code turns it off, or on again`);
      }
    } catch (error) {
      this._quiet(error);
    }
  }

  // ---- the Connection tab ------------------------------------------------------------------------------

  /**
   * Turns remote access on: sets `enabled` for every window, looks for the hub, and publishes the
   * port on the tailnet (`tailscale serve`) once this window is the hub or a peer of it: serve
   * publishes whatever answers on the port, so it goes on only when the port is known to be ours.
   * With another program on the port, remote access is on but paused (the status says so, serve
   * stays off) until the port is free. When serve fails (Tailscale stopped, …) and remote access was
   * off before, it is turned off again and this rejects with the reason. When the tailnet has to
   * allow serve first, remote access stays on and the status carries the consent link (serve is set
   * up again once it works).
   * @returns {Promise<ConnectionStatus>}
   */
  async connect() {
    this.start();
    const before = this._read();
    const wasOn = before.kind === 'ok' && before.state.enabled === true;
    this._consentUrl = undefined; // a fresh try: what an earlier one left does not count
    this._serveError = undefined;
    this._lastServeAttempt = -Infinity; // an election that ends after connect() still sets serve up at once
    this._connecting = true;
    try {
      store.updateState((state) => {
        state.enabled = true;
      }, /** @type {any} */ (this.env));
      this._setEnabled(true);
      const now = this._read();
      this._port = store.effectivePort(now.kind === 'ok' ? now.state : null, this.env);
      if (this.role === 'off' || this.role === 'error') this._restart(0);
      await this._settle(SETTLE_MS);
      if (this._serving) await this._serving; // a background attempt goes first
      const port = this._port;
      const served = await this._serveForUs(port);
      if (!served.ok && !served.needsConsent && !served.skipped && !wasOn) {
        const reason = this._serveError ?? 'tailscale serve failed';
        store.updateState((state) => {
          state.enabled = false;
        }, /** @type {any} */ (this.env));
        this._setEnabled(false);
        await this._shutdown();
        this._serveError = undefined;
        throw new Error(reason);
      }
    } finally {
      this._connecting = false;
    }
    return this.status();
  }

  /**
   * Turns remote access off for every window: `enabled` false, this window's hub (and with it every
   * phone's connection) or link closed, then serve off. The other windows follow through the state
   * file. A serve-off that fails (Tailscale's service cannot be reached) is tried again until it
   * works, and the status says so meanwhile; remote access is off all the same. Rejects, changing
   * nothing, when the state file cannot be written.
   * @returns {Promise<ConnectionStatus>}
   */
  async disconnect() {
    const read = this._read();
    const port = read.kind === 'unreadable' ? this._port : store.effectivePort(read.kind === 'ok' ? read.state : null, this.env);
    if (read.kind !== 'missing') {
      store.updateState((next) => {
        next.enabled = false;
      }, /** @type {any} */ (this.env));
    }
    this._setEnabled(false);
    await this._shutdown({ reason: 'disabled' }); // the phones are told it was turned off
    this._consentUrl = undefined;
    this._serveError = undefined;
    this._lastServeAttempt = -Infinity;
    await this._turnServeOff(port, 'disabled');
    return this.status();
  }

  /**
   * Where things stand, for the Connection tab, which asks every 2 s while it is open: so this is
   * cheap (Tailscale's status is cached, serve's status too). While remote access is on and this
   * window is the hub or a peer, it also makes the pairing code when there is none.
   * @returns {Promise<ConnectionStatus>}
   */
  async status() {
    const read = this._read();
    if (read.kind === 'ok' && this._started) this._onState(read.state); // a change the watcher has not seen yet
    // A file that cannot be read right now changes nothing: what was read last stands.
    const state = read.kind === 'ok' ? read.state : read.kind === 'unreadable' ? this._lastState : null;
    const enabled = read.kind === 'ok' ? read.state.enabled === true : read.kind === 'unreadable' && this._enabled;
    const port = read.kind === 'unreadable' ? this._port : store.effectivePort(state, this.env);
    this._retryServeOff();
    const ts = await this._tailscaleStatus();
    // A CLI that failed gives a status without httpsEnabled: that is HTTPS off, not missing.
    /** @type {TailscaleView} */
    const tailscale = { installed: ts.installed !== false, running: ts.running === true, httpsEnabled: ts.httpsEnabled === true };
    if (isText(ts.loginName)) tailscale.loginName = ts.loginName;
    if (isText(ts.dnsName)) tailscale.dnsName = ts.dnsName;

    let configured = false;
    if (enabled && tailscale.running) {
      configured = await this._serveConfigured(port);
      if (configured) {
        this._consentUrl = undefined;
        this._serveError = undefined;
      } else {
        this._ensureServe(port);
      }
    }
    if (this._consentUrl) tailscale.consentUrl = this._consentUrl;

    const fromHub = enabled ? await this._hubView() : { windows: 0, pairing: undefined, seen: new Map() };
    /** @type {ConnectionStatus} */
    const status = { enabled, role: this.role, port, macName: this.macName(), tailscale, serve: { configured }, windows: fromHub.windows, devices: publicDevices(state?.devices, fromHub.seen), appUrl: isText(state?.appUrl) ? state.appUrl : '', chromeAutoAccept: this._chromeAutoAccept };
    const error = this._errorText(enabled, configured, read.kind === 'unreadable' ? read.error : undefined);
    if (error) status.error = error;
    if (tailscale.dnsName) status.url = `https://${tailscale.dnsName}:${port}`;
    if (fromHub.pairing) status.pairing = fromHub.pairing;
    return status;
  }

  /**
   * A new pairing code (it replaces the one before). Needs the hub: rejects `not_connected` unless
   * this window is the hub or one of its peers.
   * @returns {Promise<PairingView>}
   */
  async newPairingCode() {
    /** @type {unknown} */
    let made;
    if (this.role === 'hub' && this._hub) made = this._hub.newPairingCode();
    else if (this.role === 'peer' && this._link) made = await this._link.call('newPairingCode', {}, { timeoutMs: this._callTimeoutMs });
    else throw codeError('not_connected');
    const pairing = livePairing(made, this._now());
    if (!pairing) throw codeError('bad_pairing');
    return pairing;
  }

  /**
   * Forgets a paired phone (and drops its connection). The hub does it; while no hub runs, this
   * window writes the state file itself.
   * @param {unknown} id
   */
  async removeDevice(id) {
    if (!isDeviceId(id)) throw codeError('bad_device');
    const deviceId = /** @type {string} */ (id);
    if (this.role === 'hub' && this._hub) {
      await this._hub.removeDevice(deviceId);
      return;
    }
    if (this.role === 'peer' && this._link) {
      await this._link.call('removeDevice', { id: deviceId }, { timeoutMs: this._callTimeoutMs });
      return;
    }
    if (this._read().kind === 'missing') return; // no state file: nothing is paired (an unreadable one makes updateState throw)
    store.updateState((state) => {
      const index = state.devices.findIndex((device) => isRecord(device) && device.id === deviceId);
      if (index !== -1) state.devices.splice(index, 1); // in place: the devices array is never replaced
    }, /** @type {any} */ (this.env));
    this._say('removed a paired phone');
  }

  /**
   * Sets the address of the phone app (for the pairing link): https:// without credentials, query or
   * fragment, or '' for none (the hub's normalizeAppUrl, so the rule is one). Rejects `bad_url` for
   * anything else. The hub does it; while no hub runs, this window.
   * @param {unknown} url
   */
  async setAppUrl(url) {
    const appUrl = normalizeAppUrl(url); // the hub's own rule; throws bad_url
    if (this.role === 'hub' && this._hub) {
      await this._hub.setAppUrl(appUrl);
      return;
    }
    if (this.role === 'peer' && this._link) {
      await this._link.call('setAppUrl', { url: appUrl }, { timeoutMs: this._callTimeoutMs });
      return;
    }
    store.updateState((state) => {
      state.appUrl = appUrl;
    }, /** @type {any} */ (this.env));
  }

  /**
   * Whether Claude in Chrome's permission prompts are answered for the user: the Connection tab's switch,
   * `chromeAutoAccept: true` in the state file, as read at start, by status() and by the watcher (off
   * before start and without a file; a file that cannot be read keeps what was read last). Cheap and
   * synchronous: the window agent asks it as each such prompt passes.
   */
  chromeAutoAccept() {
    return this._chromeAutoAccept;
  }

  /**
   * Turns the Claude in Chrome switch on or off for every window (the others follow the state file),
   * whether remote access is on or not; this window follows at once. The state file is written here,
   * not by the hub: the switch is nothing a phone may change. Rejects `bad_value` for anything but a
   * boolean, and rejects, changing nothing, when the state file cannot be written.
   * @param {unknown} on
   */
  async setChromeAutoAccept(on) {
    if (typeof on !== 'boolean') throw codeError('bad_value');
    const state = store.updateState((next) => {
      next.chromeAutoAccept = on;
    }, /** @type {any} */ (this.env));
    this._lastState = state;
    this._chromeAutoAccept = on;
    this._say(`Claude in Chrome auto-accept was turned ${on ? 'on' : 'off'}`);
  }

  /** Opens the Tailscale app (macOS). Rejects with the reason when it cannot. */
  async openTailscale() {
    await this.tailscale.openApp();
  }

  /** The Mac's name for the phone: Tailscale's name for it when known, else the given one, else the host name. */
  macName() {
    if (this._hostName) return this._hostName;
    try {
      const given = typeof this._macName === 'function' ? this._macName() : this._macName;
      if (isText(given)) return given;
    } catch (error) {
      this._quiet(error);
    }
    return localName();
  }

  // ---- watching the state ----------------------------------------------------------------------------

  /**
   * The state file changed (or status() read it). Only `enabled` and the port matter: a device
   * paired or removed, or the app's address, must not restart anything.
   * @param {State} state
   */
  _onState(state) {
    if (!this._started) return;
    this._lastState = state;
    this._chromeAutoAccept = state.chromeAutoAccept === true;
    const enabled = state.enabled === true;
    const port = store.effectivePort(state, this.env);
    if (enabled === this._enabled && port === this._port) return;
    const portChanged = port !== this._port;
    this._setEnabled(enabled);
    this._port = port;
    if (!enabled) {
      this._say('remote access was turned off');
      this._shutdown({ reason: 'disabled' }); // the phones are told it was turned off
      return;
    }
    this._say(portChanged && this.role !== 'off' ? `the port changed to ${port}` : 'remote access was turned on');
    this._restart(0);
  }

  // ---- the election -------------------------------------------------------------------------------------

  /**
   * Ends what the window is now and looks for the hub after `delayMs`.
   * @param {number} delayMs
   */
  _restart(delayMs) {
    this._teardown();
    this._failures = 0;
    this._error = undefined;
    this._foreignPort = undefined;
    this._setRole('starting');
    this._schedule(delayMs);
  }

  /** @param {number} delayMs */
  _schedule(delayMs) {
    clearTimeout(this._retryTimer);
    const gen = this._gen;
    this._retryTimer = unref(
      setTimeout(() => {
        this._retryTimer = undefined;
        if (gen === this._gen) this._elect(gen);
      }, delayMs),
    );
  }

  /**
   * One try: listen on the port (this window becomes the hub), else join what listens there.
   * @param {number} gen
   */
  async _elect(gen) {
    try {
      await this._closing; // the port of this window's last hub must be free first
      if (gen !== this._gen) return;
      const read = this._read();
      if (read.kind === 'unreadable') {
        // Not "off": what was read last stands, and the next try reads it again.
        this._fail(gen, `Can't read the remote access settings (${errorText(read.error)}). Trying again.`, false);
        return;
      }
      if (read.kind === 'missing' || read.state.enabled !== true) {
        this._setEnabled(false);
        this._shutdown({ reason: 'disabled' });
        return;
      }
      const state = read.state;
      const port = store.effectivePort(state, this.env);
      this._setEnabled(true);
      this._port = port;
      const hub = this._newHub();
      /** @type {unknown} */
      let listenError;
      try {
        await hub.listen(port);
      } catch (error) {
        listenError = error === undefined ? new Error('listen failed') : error;
      }
      if (listenError === undefined) {
        if (gen !== this._gen) {
          // Stale: the next election must wait for this port to be free again.
          this._closing = Promise.all([this._closing, closeQuietly(hub, CLOSE_TIMEOUT_MS)]);
          return;
        }
        this._becomeHub(gen, hub, port);
        return;
      }
      closeQuietly(hub, CLOSE_TIMEOUT_MS);
      if (gen !== this._gen) return;
      if (codeOf(listenError) !== 'EADDRINUSE') {
        this._fail(gen, `Remote access can't listen on 127.0.0.1:${port} (${errorText(listenError)}). It tries again by itself.`, true);
        return;
      }
      await this._joinOrPause(gen, port, state.secret);
    } catch (error) {
      if (gen === this._gen) this._fail(gen, `Remote access could not start (${errorText(error)}). It tries again by itself.`, true);
    }
  }

  /**
   * @param {number} gen
   * @param {string} message  for the Connection tab
   * @param {boolean} persistent  the port is held by something else, or cannot be bound: try slowly
   */
  _fail(gen, message, persistent) {
    if (gen !== this._gen) return;
    this._failures += 1;
    if (persistent || this._failures > QUICK_TRIES) {
      if (this._error !== message) this._warn(message);
      this._error = message;
      this._foreignPort = undefined;
      this._setRole('error');
      this._schedule(randomIn(this._errorRetryMs, DEFAULT_ERROR_RETRY_MS));
    } else {
      this._schedule(randomIn(this.retryMs, DEFAULT_RETRY_MS));
    }
  }

  /**
   * The port is taken. What holds it is asked first (`GET /health`):
   * - nothing any more (connection refused): it just left; try again soon;
   * - no answer in time: unknown (a hub whose window is busy looks the same): serve stays as it is,
   *   and the window waits;
   * - any other answer (another status or body, a reset, a hang-up): another program; pause;
   * - a hub: join it. The join proves both ways that each side knows the secret, which never goes
   *   on the wire (peer-link.js): one that cannot prove it (a program that only says it is a hub,
   *   another user's bridge, a window of an older bridge) or refuses this window counts as another
   *   program too, and is sent nothing; a join that fails otherwise is tried again.
   * @param {number} gen @param {number} port @param {string} secret
   */
  async _joinOrPause(gen, port, secret) {
    const owner = await probePort(port, this._peerTimeoutMs);
    if (gen !== this._gen) return;
    if (owner === 'free') {
      this._fail(gen, "Can't reach the VS Code window that serves the phone. Trying again.", false);
      return;
    }
    if (owner === 'unknown') {
      this._fail(gen, `Waiting for the VS Code window that serves the phone (port ${port} doesn't answer).`, false);
      return;
    }
    if (owner === 'other') {
      await this._pauseForForeign(gen, port, 'program');
      return;
    }
    let link;
    try {
      link = await connectPeer({ port, secret, timeoutMs: this._peerTimeoutMs });
    } catch (error) {
      if (gen !== this._gen) return;
      const code = codeOf(error);
      if (code === 'refused') await this._pauseForForeign(gen, port, 'bridge');
      else this._fail(gen, `Can't reach the VS Code window that serves the phone (${code}). Trying again.`, false);
      return;
    }
    // Attached in this same turn: what the hub sent along with the upgrade is delivered next turn.
    if (gen !== this._gen) {
      link.close();
      return;
    }
    this._becomePeer(gen, link, port);
  }

  /**
   * Something that is not a hub this window can join holds the port: `tailscale serve` must not
   * publish it to the tailnet. Serve goes off when the window enters this state (a failure is tried
   * again until it works), and back on once a hub of ours has the port (_resumeServe). Each later
   * try looks at serve again (not from the cache), and turns it off again when something turned it
   * on meanwhile (a window of an older bridge that joined that program, a person).
   * @param {number} gen @param {number} port @param {'program' | 'bridge'} kind
   */
  async _pauseForForeign(gen, port, kind) {
    const entering = !(this.role === 'error' && this._foreignPort === port && this._foreignKind === kind);
    const what = foreignHolder(kind);
    if (entering) {
      this._servePaused = true;
      const off = await this._turnServeOff(port, 'foreign');
      if (gen !== this._gen) return;
      this._warn(`port ${port} is used by ${what}: remote access is paused, and tailscale serve ${off ? 'is off for it' : 'could not be turned off yet (retrying)'}`);
    } else if (!this._serveOffs.has(port)) {
      // (A serve-off that failed is tried again on its own timer.)
      const configured = await this._serveConfigured(port, true);
      if (gen !== this._gen) return;
      if (configured) {
        this._warn(`tailscale serve was on again for port ${port}, which ${what} holds: turning it off`);
        await this._turnServeOff(port, 'foreign');
        if (gen !== this._gen) return;
      }
    }
    this._failures += 1;
    this._error = undefined;
    this._foreignPort = port;
    this._foreignKind = kind;
    this._setRole('error');
    this._schedule(randomIn(this._errorRetryMs, DEFAULT_ERROR_RETRY_MS));
  }

  /** A hub of ours has the port again after a pause: serve goes back on at once, not after the throttle. */
  _resumeServe() {
    this._servePaused = false;
    for (const entry of [...this._serveOffs.values()]) if (entry.cause === 'foreign') this._clearServeOff(entry.port);
    this._lastServeAttempt = -Infinity;
    this._serve = { port: 0, at: -Infinity, configured: false };
  }

  _newHub() {
    const env = /** @type {any} */ (this.env);
    return this._createHub({
      state: () => store.loadState(env),
      updateState: (/** @type {(state: State) => unknown} */ fn) => store.updateState(fn, env),
      tailscale: this.tailscale,
      macName: () => this.macName(),
      log: (/** @type {string} */ message, /** @type {string} */ level) => {
        if (level === 'warn' || level === 'error') this._warn(`hub: ${message}`);
        else this._say(`hub: ${message}`);
      },
    });
  }

  /** @param {number} gen @param {any} hub @param {number} port */
  _becomeHub(gen, hub, port) {
    let window;
    try {
      window = hub.addWindow({ key: this._key, call: (/** @type {string} */ method, /** @type {unknown} */ args) => answered(callAgent(this.agent, method, args)) });
    } catch (error) {
      closeQuietly(hub, CLOSE_TIMEOUT_MS);
      this._fail(gen, `Remote access could not start (${errorText(error)}). It tries again by itself.`, true);
      return;
    }
    this._hub = hub;
    this._failures = 0;
    this._error = undefined;
    this._foreignPort = undefined;
    this._remote = null;
    if (typeof hub.on === 'function') {
      hub.on('error', (/** @type {unknown} */ error) => this._warn(`hub: ${errorText(error)}`));
      hub.on('close', () => {
        if (this._hub === hub) this._lost(gen, 'the hub stopped');
      });
    }
    this._bind(gen, {
      project: (project) => window.setProject(project),
      session: (sessionId, ev) => window.sessionEvent(sessionId, ev),
      attention: (ev) => window.attention(ev),
      usage: (reading) => window.usage(reading),
      dispose: () => window.remove(),
    });
    this._setRole('hub');
    this._say(`this window serves the phone (127.0.0.1:${port})`);
    this._tailscaleStatus(); // Tailscale's name for the Mac, which the phones are told
    if (this._servePaused) this._resumeServe();
    // A new hub looks at serve afresh, past the cache and the throttle: the hub before it may have
    // turned serve off as it closed, taking itself for the last window.
    this._lastServeAttempt = -Infinity;
    this._serve = { port: 0, at: -Infinity, configured: false };
    if (!this._connecting) this._ensureServe(port); // connect() sets serve up itself
  }

  /** @param {number} gen @param {any} link @param {number} port */
  _becomePeer(gen, link, port) {
    this._link = link;
    this._failures = 0;
    this._error = undefined;
    this._foreignPort = undefined;
    // Whether a phone is connected, as the hub last said: session events cross the link only then.
    let active = false;
    link.setHandler((/** @type {string} */ method, /** @type {unknown} */ args) => {
      if (method === 'active') active = isRecord(args) && args.on === true;
      return answered(callAgent(this.agent, method, args));
    });
    link.on('close', () => {
      if (this._link === link) this._lost(gen, 'lost the VS Code window that served the phone');
    });
    this._bind(gen, {
      project: (project) => link.notify('project', project),
      session: (sessionId, ev) => {
        if (active) link.notify('session', { session: sessionId, ev });
      },
      attention: (ev) => link.notify('attention', ev), // always: it is for when no phone is connected
      usage: (reading) => link.notify('usage', reading), // always: small, and wanted the moment a phone connects
      dispose: () => {},
    });
    this._setRole('peer');
    this._say(`joined the VS Code window that serves the phone (port ${port})`);
    if (this._servePaused) this._resumeServe(); // it turned serve off while the port was not ours
    if (!this._connecting) this._ensureServe(port); // connect() sets serve up itself
  }

  /** The hub or the link went away by itself: look again after a random pause. @param {number} gen @param {string} reason */
  _lost(gen, reason) {
    if (gen !== this._gen || !this._started) return;
    const delay = randomIn(this.retryMs, DEFAULT_RETRY_MS);
    this._say(`${reason}; looking again in ${delay} ms`);
    this._teardown();
    this._setRole('starting');
    this._schedule(delay);
  }

  /**
   * Closes the hub or the link and cuts the agent loose; any election under way is dropped.
   * @param {{ reason?: string }} [closeOptions]  `reason: 'disabled'`: the hub tells its phones that remote access was turned off
   */
  _teardown(closeOptions) {
    this._gen += 1;
    clearTimeout(this._retryTimer);
    this._retryTimer = undefined;
    this._unbind();
    const link = this._link;
    const hub = this._hub;
    this._link = null;
    this._hub = null;
    this._remote = null;
    if (link) {
      try {
        link.close();
      } catch (error) {
        this._quiet(error);
      }
    }
    if (hub) this._closing = closeQuietly(hub, CLOSE_TIMEOUT_MS, closeOptions);
    return this._closing;
  }

  /**
   * Off: nothing runs, nothing is looked for.
   * @param {{ reason?: string }} [closeOptions]  `reason: 'disabled'` when remote access was turned off (not for a window that closes)
   */
  _shutdown(closeOptions) {
    const closing = this._teardown(closeOptions);
    this._failures = 0;
    this._error = undefined;
    this._foreignPort = undefined;
    this._servePaused = false;
    // A serve-off for a foreign holder ends here; one after Disconnect goes on until it works.
    for (const entry of [...this._serveOffs.values()]) if (entry.cause === 'foreign') this._clearServeOff(entry.port);
    this._setRole('off');
    return closing.then(() => undefined);
  }

  /** @param {number} ms */
  _settle(ms) {
    if (this.role !== 'starting') return Promise.resolve();
    return new Promise((resolve) => {
      /** @param {Role} role */
      const onRole = (role) => {
        if (role !== 'starting') done();
      };
      const done = () => {
        clearTimeout(timer);
        this.off('role', onRole);
        resolve(undefined);
      };
      const timer = unref(setTimeout(done, ms));
      this.on('role', onRole);
    });
  }

  /** @param {Role} role */
  _setRole(role) {
    if (this.role === role) return;
    this.role = role;
    try {
      this.emit('role', role);
    } catch (error) {
      this._quiet(error);
    }
  }

  // ---- the agent's tie to the hub ------------------------------------------------------------------------

  /**
   * What the window last saw of `enabled`. The agent follows it: it mirrors the sessions only while
   * remote access is on.
   * @param {boolean} on
   */
  _setEnabled(on) {
    this._enabled = on;
    this._tellAgent(on);
  }

  /** @param {boolean} on */
  _tellAgent(on) {
    const agent = this.agent;
    if (!agent || typeof agent.setEnabled !== 'function') return;
    try {
      agent.setEnabled(on);
    } catch (error) {
      this._quiet(error);
    }
  }

  /**
   * Passes the agent's project, session, attention and usage events to the hub. The project goes at once (the
   * agent emits one only when it changes, and may have sent this one to an earlier hub), then again
   * once the session list is read; so does the usage reading (usageReading()). Right after the listeners are registered, the prompts that are open
   * are reported again (`replayAttention`), so a hub that has just taken over learns about them.
   * @param {number} gen
   * @param {Sink} sink
   */
  _bind(gen, sink) {
    const agent = this.agent;
    if (!agent || typeof agent.on !== 'function') return;
    /** @type {string | undefined} */
    let last;
    /** @param {unknown} project */
    const onProject = (project) => {
      try {
        if (!isRecord(project)) return;
        const json = JSON.stringify(project);
        if (json === last) return;
        last = json;
        sink.project(project);
      } catch (error) {
        this._quiet(error);
      }
    };
    /** @param {string} sessionId @param {object} ev */
    const onSession = (sessionId, ev) => {
      try {
        sink.session(sessionId, ev);
      } catch (error) {
        this._quiet(error);
      }
    };
    /** @param {object} ev */
    const onAttention = (ev) => {
      try {
        sink.attention(ev);
      } catch (error) {
        this._quiet(error);
      }
    };
    /** @param {object} reading */
    const onUsage = (reading) => {
      try {
        sink.usage(reading);
      } catch (error) {
        this._quiet(error);
      }
    };
    agent.on('project', onProject);
    agent.on('session', onSession);
    agent.on('attention', onAttention);
    agent.on('usage', onUsage);
    const binding = {
      dispose: () => {
        agent.off('project', onProject);
        agent.off('session', onSession);
        agent.off('attention', onAttention);
        agent.off('usage', onUsage);
        sink.dispose();
      },
    };
    this._binding = binding;
    try {
      onProject(agent.project());
    } catch (error) {
      this._quiet(error);
    }
    if (typeof agent.usageReading === 'function') {
      try {
        onUsage(agent.usageReading());
      } catch (error) {
        this._quiet(error);
      }
    }
    // A new hub (a takeover, say) learns the prompts that were already open, now that it has the
    // window's project: a prompt that was never announced (remote access was off, or no hub listened) is
    // announced now; prompts already announced are only counted.
    if (typeof agent.replayAttention === 'function') {
      try {
        agent.replayAttention();
      } catch (error) {
        this._quiet(error);
      }
    }
    Promise.resolve()
      .then(() => agent.refreshProject())
      .then(
        (project) => {
          if (this._binding === binding && gen === this._gen) onProject(project);
        },
        (error) => this._quiet(error),
      );
  }

  _unbind() {
    const binding = this._binding;
    this._binding = null;
    if (!binding) return;
    try {
      binding.dispose();
    } catch (error) {
      this._quiet(error);
    }
    try {
      this.agent.setActive(false); // no hub, no phone: the agent stops refreshing
    } catch (error) {
      this._quiet(error);
    }
  }

  /**
   * What only the hub knows: how many windows it has, the pairing code (made when there is none),
   * and when it last heard from each device. A peer asks over its link; a hub that does not answer
   * leaves the last answer.
   * @returns {Promise<{ windows: number, pairing: PairingView | undefined, seen: Map<string, number> }>}
   */
  async _hubView() {
    const now = this._now();
    if (this.role === 'hub' && this._hub) {
      const hub = this._hub;
      try {
        const info = hub.info();
        let pairing = livePairing(isRecord(info) ? info.pairing : undefined, now);
        if (!pairing) pairing = livePairing(hub.newPairingCode(), now);
        return { windows: count(isRecord(info) ? info.windows : 0), pairing, seen: lastSeenOf(info) };
      } catch (error) {
        this._quiet(error);
        return { windows: 0, pairing: undefined, seen: new Map() };
      }
    }
    if (this.role === 'peer' && this._link) {
      const link = this._link;
      try {
        const info = await link.call('status', {}, { timeoutMs: this._callTimeoutMs });
        /** @type {unknown} */
        let pairing = isRecord(info) ? info.pairing : undefined;
        if (!livePairing(pairing, now)) pairing = await this._codeOnDemand(link);
        const seen = lastSeenOf(info);
        if (this._link === link) this._remote = { windows: count(isRecord(info) ? info.windows : 0), pairing, seen };
        return { windows: count(isRecord(info) ? info.windows : 0), pairing: livePairing(pairing, now), seen };
      } catch (error) {
        this._quiet(error);
        const last = this._link === link ? this._remote : null;
        return { windows: last ? last.windows : 0, pairing: last ? livePairing(last.pairing, this._now()) : undefined, seen: last ? last.seen : new Map() };
      }
    }
    return { windows: 0, pairing: undefined, seen: new Map() };
  }

  /**
   * The hub's new code for the Connection tab that found none. One request at a time: two tabs
   * that poll together must not make two codes, the second replacing the first.
   * @param {any} link
   * @returns {Promise<unknown>}
   */
  _codeOnDemand(link) {
    const pending = this._codeRequest;
    if (pending && pending.link === link) return pending.promise;
    /** @type {Promise<unknown>} */
    const promise = link.call('newPairingCode', {}, { timeoutMs: this._callTimeoutMs }).finally(() => {
      if (this._codeRequest && this._codeRequest.promise === promise) this._codeRequest = null;
    });
    this._codeRequest = { link, promise };
    return promise;
  }

  // ---- tailscale ---------------------------------------------------------------------------------------

  /** Tailscale's status (cached by tailscale.js); it also learns Tailscale's name for this machine. */
  async _tailscaleStatus() {
    /** @type {any} */
    let ts;
    try {
      ts = await this.tailscale.status();
    } catch (error) {
      this._quiet(error);
    }
    if (!isRecord(ts)) ts = { installed: true, running: false };
    if (isText(ts.hostName)) this._hostName = ts.hostName;
    this._installed = ts.installed !== false;
    return ts;
  }

  /**
   * Whether serve publishes the port, asked at most every SERVE_CHECK_MS (`fresh`: asked now, unless
   * a question is under way).
   * @param {number} port @param {boolean} [fresh]
   */
  async _serveConfigured(port, fresh = false) {
    const cached = this._serve;
    if (!fresh && cached.port === port && this._now() - cached.at < SERVE_CHECK_MS) return cached.configured;
    if (!this._serveCheck) {
      this._serveCheck = (async () => {
        let configured = false;
        try {
          const answer = await this.tailscale.serveStatus(port);
          configured = isRecord(answer) && answer.configured === true;
        } catch (error) {
          this._quiet(error);
        }
        this._serve = { port, at: this._now(), configured };
        return configured;
      })().finally(() => {
        this._serveCheck = null;
      });
    }
    return this._serveCheck;
  }

  /**
   * Sets serve up again while remote access is on but serve is missing (consent was pending,
   * Tailscale was off): in the background, at most every serveRetryMs, and only while a hub of ours
   * has the port (this window is the hub or a peer). Never while anything else holds it.
   * @param {number} port
   * @returns {Promise<void> | null} the attempt, while one runs
   */
  _ensureServe(port) {
    if (this._serving || !this._started || !this._enabled || !this._portIsOurs()) return this._serving;
    const now = this._now();
    if (now - this._lastServeAttempt < this._serveRetryMs) return null;
    this._lastServeAttempt = now;
    this._serving = this._serveIfMissing(port)
      .catch((error) => this._quiet(error))
      .finally(() => {
        this._serving = null;
      });
    return this._serving;
  }

  /** @param {number} port */
  async _serveIfMissing(port) {
    const ts = await this._tailscaleStatus();
    if (ts.running !== true) return;
    if (await this._serveConfigured(port)) {
      this._consentUrl = undefined;
      this._serveError = undefined;
      return;
    }
    await this._serveForUs(port);
  }

  /**
   * `tailscale serve` on for the port, but only while a hub of ours has it and remote access is on;
   * when that stops being so while serve is set up (another program got the port, remote access
   * was turned off), serve goes off again. Never rejects.
   * @param {number} port
   * @returns {Promise<{ ok: boolean, needsConsent?: string, skipped?: boolean }>}  skipped: the port is not ours (now)
   */
  async _serveForUs(port) {
    if (!this._portIsOurs() || !this._enabledNow()) return { ok: false, skipped: true };
    const result = await this._serveOn(port);
    if (!result.ok) return result;
    if (!this._portIsOurs() && this.role === 'error' && this._foreignPort === port) await this._turnServeOff(port, 'foreign');
    else if (!this._enabledNow()) await this._turnServeOff(port, 'disabled');
    return result;
  }

  /** Whether a hub of ours has the port: this window is the hub, or a peer of it. */
  _portIsOurs() {
    return this.role === 'hub' || this.role === 'peer';
  }

  /**
   * Remote access is off, but serve may still publish the port (an earlier session could not turn
   * it off): turn it off. In the background, when the window starts.
   * @param {number} port
   */
  _cleanStaleServe(port) {
    (async () => {
      const ts = await this._tailscaleStatus();
      if (ts.running !== true || !(await this._serveConfigured(port))) return;
      if (this._enabledNow() || this._stopped) return; // turned on meanwhile, or the window closed
      this._say(`tailscale serve was still on for port ${port} although remote access is off: turning it off`);
      await this._turnServeOff(port, 'disabled');
    })().catch((error) => this._quiet(error));
  }

  /**
   * `tailscale serve` on for the port. Never rejects. Callers make sure the port is ours (_serveForUs).
   * @param {number} port
   * @returns {Promise<{ ok: boolean, needsConsent?: string }>}
   */
  async _serveOn(port) {
    /** @type {unknown} */
    let result;
    try {
      result = await this.tailscale.serveOn(port);
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    this._lastServeAttempt = this._now();
    if (isRecord(result) && result.ok === true) {
      this._consentUrl = undefined;
      this._serveError = undefined;
      this._serve = { port, at: this._now(), configured: true };
      this._clearServeOff(port); // on on purpose: a serve-off still being retried for this port is not wanted any more
      this._say(`tailscale serve is on for port ${port}`);
      return { ok: true };
    }
    if (isRecord(result) && typeof result.needsConsent === 'string' && CONSENT_URL_RE.test(result.needsConsent)) {
      this._consentUrl = result.needsConsent;
      this._serveError = undefined;
      this._serve = { port, at: this._now(), configured: false };
      this._say('tailscale serve has to be allowed for this tailnet first: the Connection tab shows the link');
      return { ok: false, needsConsent: result.needsConsent };
    }
    const reason = isRecord(result) && isText(result.error) ? result.error : 'unknown error';
    this._serveError = `Couldn't publish port ${port} on your tailnet: ${reason}`;
    this._warn(this._serveError);
    return { ok: false };
  }

  /**
   * `tailscale serve` off for the port, once. Nothing to do without Tailscale. Never rejects; a
   * failure is the caller's to report (see _turnServeOff).
   * @param {number} port
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async _serveOff(port) {
    await this._tailscaleStatus();
    if (!this._installed) return { ok: true };
    /** @type {unknown} */
    let result;
    try {
      result = await this.tailscale.serveOff(port);
    } catch (error) {
      result = { ok: false, error: errorText(error) };
    }
    if (isRecord(result) && result.ok === true) {
      this._serve = { port, at: this._now(), configured: false };
      this._say(`tailscale serve is off for port ${port}`);
      return { ok: true };
    }
    const error = isRecord(result) && isText(result.error) ? result.error : 'unknown error';
    return { ok: false, error };
  }

  /**
   * Serve off for the port; when that fails, it is tried again every serveOffRetryMs (and when the
   * Connection tab or the state watch looks) for as long as it is still wanted, and the status says
   * so meanwhile. One serve-off per port. A failure is logged when its reason changes, not on every
   * try. After stop() a failure arms nothing. Never rejects.
   * @param {number} port
   * @param {'disabled' | 'foreign'} cause  remote access was turned off; another program holds the port
   * @returns {Promise<boolean>} whether serve is off now
   */
  async _turnServeOff(port, cause) {
    const result = await this._serveOff(port);
    if (result.ok) {
      this._clearServeOff(port);
      return true;
    }
    if (this._stopped) return false; // the window closed while this ran: nothing is tried again
    const reason = result.error ?? 'unknown error';
    const before = this._serveOffs.get(port);
    if (!before || before.reason !== reason) this._warn(`tailscale serve could not be turned off for port ${port}: ${reason} (retrying)`);
    if (before) clearTimeout(before.timer);
    const timer = unref(setTimeout(() => this._retryServeOff(port, true), this._serveOffRetryMs));
    this._serveOffs.set(port, { port, cause, reason, at: this._now(), timer, running: false });
    return false;
  }

  /**
   * Tries failed serve-offs again (the one for `port`, or all): at most every serveOffRetryMs
   * unless `now`, and only while still wanted: `disabled` while remote access is off or the port is
   * not the current one, `foreign` while another program still holds it.
   * @param {number} [port]
   * @param {boolean} [now]
   */
  _retryServeOff(port, now = false) {
    if (this._stopped) return;
    const entries = port === undefined ? [...this._serveOffs.values()] : [this._serveOffs.get(port)];
    for (const entry of entries) {
      if (!entry || entry.running) continue;
      if (!now && this._now() - entry.at < this._serveOffRetryMs) continue;
      const wanted = entry.cause === 'foreign' ? this.role === 'error' && this._foreignPort === entry.port : !this._enabledNow() || entry.port !== this._port;
      if (!wanted) {
        this._clearServeOff(entry.port);
        continue;
      }
      entry.running = true;
      entry.at = this._now();
      this._turnServeOff(entry.port, entry.cause)
        .catch((error) => this._quiet(error))
        .finally(() => {
          entry.running = false;
        });
    }
  }

  /** @param {number} port */
  _clearServeOff(port) {
    const entry = this._serveOffs.get(port);
    if (!entry) return;
    clearTimeout(entry.timer);
    this._serveOffs.delete(port);
  }

  _clearServeOffs() {
    for (const port of [...this._serveOffs.keys()]) this._clearServeOff(port);
  }

  /**
   * What the Connection tab shows in red, if anything.
   * @param {boolean} enabled
   * @param {boolean} configured  serve publishes the port
   * @param {unknown} readError  why the state file cannot be read right now, if it cannot
   * @returns {string | undefined}
   */
  _errorText(enabled, configured, readError) {
    const pending = this._serveOffs.get(this._foreignPort ?? this._port) ?? this._serveOffs.values().next().value;
    const offFailed = pending ? `Turning off Tailscale serve failed — retrying (${pending.reason}).` : '';
    if (this.role === 'error' && this._foreignPort !== undefined) {
      const head = `Port ${this._foreignPort} is used by ${foreignHolder(this._foreignKind)}, so remote access is paused`;
      return offFailed ? `${head}. ${offFailed}` : `${head} and nothing is exposed. It starts again by itself once the port is free.`;
    }
    /** @type {string[]} */
    const parts = [];
    if (this.role === 'error' && this._error) parts.push(this._error);
    else if (readError !== undefined) parts.push(`Can't read the remote access settings (${errorText(readError)}).`);
    else if (enabled && !configured && this._serveError) parts.push(this._serveError);
    if (offFailed) parts.push(offFailed);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }

  // ---- the state file ----------------------------------------------------------------------------------

  /**
   * The state file (readState): a file is made only when remote access is turned on (or a device or
   * the address is changed), never just because a window opened. What it reads is kept, for a moment
   * when the file cannot be read.
   */
  _read() {
    const read = readState(this.env);
    if (read.kind === 'ok') this._lastState = read.state;
    // A file that cannot be read right now keeps the switch as it was; no file at all is off.
    if (read.kind !== 'unreadable' && this._started) this._chromeAutoAccept = read.kind === 'ok' && read.state.chromeAutoAccept === true;
    return read;
  }

  /** Whether remote access is on now: the file says so, or said so last when it cannot be read now. */
  _enabledNow() {
    const read = this._read();
    if (read.kind === 'ok') return read.state.enabled === true;
    return read.kind === 'unreadable' && this._enabled;
  }

  // ---- the log -----------------------------------------------------------------------------------------

  /** @param {string} line */
  _say(line) {
    try {
      this._log(line);
    } catch {
      // the log is not ours to fix
    }
  }

  /** @param {string} line */
  _warn(line) {
    try {
      if (typeof this._log.warn === 'function') this._log.warn(line);
      else this._log(line);
    } catch {
      // the log is not ours to fix
    }
  }

  /** Something that should not go wrong did; the first few are logged. @param {unknown} error */
  _quiet(error) {
    this._failuresLogged += 1;
    if (this._failuresLogged <= LOGGED_FAILURES) this._warn(`coordinator: ${errorText(error)}`);
  }
}

module.exports = { Coordinator, callAgent };
