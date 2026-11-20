// @ts-check
'use strict';
// The hub's notifier: it decides which paired phones get a Web Push when a Claude Code session waits
// for input or finishes, builds the end-to-end encrypted payload, and hands it to webpush.js. It owns
// the per-session open prompts (for the badge and the grace period) and the per-device flood cap and
// failure logs. The hub creates one and forwards its `attention` and `window-removed` events to it.
//
// What shapes this code:
// - A prompt waits `graceMs` before a push, and an `open` event that no longer lists it cancels that
//   push: a prompt answered right away on the Mac sends nothing.
// - Looking, away and the cap are checked when the push would go out, not when the prompt appeared.
// - A device is only pushed to when it has a subscription and the pref for that kind is on. The
//   subscription never leaves the hub; the Connection tab sees `push: true` only.
// - Payloads are at most 3000 bytes before encryption. Titles, lines and the body are cut by code
//   point with an ellipsis, never inside a surrogate pair.
// - A send's promise is always caught. After close() no timer fires and no send result is acted on.

const crypto = require('crypto');
const { isAllowedEndpoint, sendPush, validSubscriptionKeys, validVapid, b64url } = require('./webpush.js');
const { userIdleSeconds } = require('./idle.js');

const NOTIFIER_LIMITS = Object.freeze({
  graceMs: 4000,
  awayAfterS: 120,
  capPerMinute: 12,
  failLogEveryMs: 3_600_000,
  maxPayloadBytes: 3000,
  dedupeKeep: 1000,
  ttl: Object.freeze({ waiting: 3600, done: 600, test: 60 }),
  urgency: Object.freeze({ waiting: 'high', done: 'normal', test: 'high' }),
});

const IDLE_TIMEOUT_MS = 3000; // a stalled idle read counts as away
const CAP_WINDOW_MS = 60_000; // the flood cap's window
const CAP_LOG_MS = 60_000; // at most one cap log line per device per minute
const MAX_SUBJECT_CHARS = 1024;
const TITLE_CHARS = 60;
const SESSION_TITLE_CHARS = 80;
const LINE_CHARS = 160;

/**
 * @typedef {{
 *   endpoint: string,
 *   keys: { p256dh: string, auth: string },
 *   vapid: { publicKey: string, privateJwk: { kty: string, crv: string, x: string, y: string, d: string } },
 *   subject: string,
 *   prefs: { waiting: boolean, done: boolean, onlyAway: boolean, details: boolean },
 *   createdAt: number,
 * }} PushRecord
 * @typedef {{ ok: true } | { ok: false, error: string }} SetResult
 * @typedef {{ ok: true } | { ok: false, error: string, status?: number, reason?: string }} TestResult
 * @typedef {{
 *   state: () => any,
 *   updateState: (fn: (state: any) => void) => unknown,
 *   isLooking: (deviceId: string) => boolean,
 *   macName: () => string,
 *   log?: (message: string, level: 'info' | 'warn' | 'error') => void,
 *   now?: () => number,
 *   idleSeconds?: () => Promise<number>,
 *   send?: (push: any, options: any) => Promise<{ ok: boolean, status: number, gone: boolean }>,
 *   sendOptions?: Record<string, any>,
 *   timers?: { setTimeout: (fn: () => void, ms: number) => any, clearTimeout: (timer: any) => void },
 *   limits?: Record<string, any>,
 * }} NotifierOptions
 */

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {string} */
function text(value) {
  return typeof value === 'string' ? value : '';
}

/** @param {unknown} value @returns {number} */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Cuts text to at most `max` code points, with an ellipsis as the last one when it was longer.
 * @param {string} value @param {number} max @returns {string}
 */
function cut(value, max) {
  const points = Array.from(value);
  if (points.length <= max) return value;
  if (max <= 0) return '';
  return `${points.slice(0, max - 1).join('')}…`;
}

/** The host of an endpoint, for a log line; never the path. @param {unknown} endpoint */
function hostOf(endpoint) {
  try {
    return new URL(text(endpoint)).host;
  } catch {
    return '';
  }
}

/** A pref: a missing or non-boolean one counts as on, as the app's defaults do. @param {unknown} prefs @param {string} key */
function prefOn(prefs, key) {
  return isRecord(prefs) && typeof prefs[key] === 'boolean' ? prefs[key] : true;
}

/** @param {string} kind @param {string} project @param {string} session */
function topicOf(kind, project, session) {
  return b64url(crypto.createHash('sha256').update(`${kind}\n${project}\n${session}`).digest()).slice(0, 32);
}

/** @param {unknown} state @param {string} id @returns {Record<string, any> | undefined} */
function findDevice(state, id) {
  const devices = isRecord(state) && Array.isArray(state.devices) ? state.devices : [];
  return devices.find((device) => isRecord(device) && device.id === id);
}

/** The fields of a stored push that push_set may change, as stable JSON. @param {Record<string, any>} push */
function pushFields(push) {
  const keys = isRecord(push.keys) ? push.keys : {};
  const vapid = isRecord(push.vapid) ? push.vapid : {};
  const jwk = isRecord(vapid.privateJwk) ? vapid.privateJwk : {};
  const prefs = isRecord(push.prefs) ? push.prefs : {};
  return JSON.stringify({
    endpoint: text(push.endpoint),
    keys: { p256dh: text(keys.p256dh), auth: text(keys.auth) },
    vapid: { publicKey: text(vapid.publicKey), privateJwk: { kty: text(jwk.kty), crv: text(jwk.crv), x: text(jwk.x), y: text(jwk.y), d: text(jwk.d) } },
    subject: text(push.subject),
    prefs: { waiting: prefOn(prefs, 'waiting'), done: prefOn(prefs, 'done'), onlyAway: prefOn(prefs, 'onlyAway'), details: prefOn(prefs, 'details') },
  });
}

/**
 * Validates a push_set frame and normalizes what it stores. The endpoint is checked with the same
 * function sendPush uses (`allowEndpoint` in sendOptions, else the production allowlist).
 * @param {unknown} frame
 * @param {(url: unknown) => boolean} allowEndpoint
 * @returns {{ ok: true, push: Omit<PushRecord, 'createdAt'> } | { ok: false, error: 'bad_request' | 'bad_endpoint' | 'bad_keys' }}
 */
function normalizePushFrame(frame, allowEndpoint) {
  if (!isRecord(frame)) return { ok: false, error: 'bad_request' };
  const subscription = frame.subscription;
  if (!isRecord(subscription)) return { ok: false, error: 'bad_request' };
  const endpoint = subscription.endpoint;
  let allowed = false;
  try {
    allowed = allowEndpoint(endpoint) === true;
  } catch {
    allowed = false;
  }
  if (!allowed) return { ok: false, error: 'bad_endpoint' };

  const keys = subscription.keys;
  if (!validSubscriptionKeys(keys) || !isRecord(keys)) return { ok: false, error: 'bad_keys' };
  try {
    // validSubscriptionKeys checks the shape only; an off-curve point would fail every send.
    const ecdh = crypto.createECDH('prime256v1');
    ecdh.generateKeys();
    ecdh.computeSecret(Buffer.from(keys.p256dh, 'base64url'));
  } catch {
    return { ok: false, error: 'bad_keys' };
  }

  const vapid = frame.vapid;
  if (!validVapid(vapid) || !isRecord(vapid) || !isRecord(vapid.privateJwk)) return { ok: false, error: 'bad_keys' };

  const subject = frame.subject;
  if (typeof subject !== 'string' || subject.length > MAX_SUBJECT_CHARS || !/^(?:https:\/\/|mailto:)\S+$/i.test(subject)) {
    return { ok: false, error: 'bad_request' };
  }

  const prefs = { waiting: true, done: true, onlyAway: true, details: true };
  if (frame.prefs !== undefined) {
    if (!isRecord(frame.prefs)) return { ok: false, error: 'bad_request' };
    for (const key of /** @type {const} */ (['waiting', 'done', 'onlyAway', 'details'])) {
      const value = frame.prefs[key];
      if (value === undefined) continue;
      if (typeof value !== 'boolean') return { ok: false, error: 'bad_request' };
      prefs[key] = value;
    }
  }

  return {
    ok: true,
    push: {
      endpoint: /** @type {string} */ (endpoint),
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      vapid: { publicKey: vapid.publicKey, privateJwk: { kty: 'EC', crv: 'P-256', x: vapid.privateJwk.x, y: vapid.privateJwk.y, d: vapid.privateJwk.d } },
      subject,
      prefs,
    },
  };
}

/**
 * Builds a push payload as JSON. With `details`, the first body line is the session title and the
 * second says what happened; without it both are generic. The test payload is fixed. Every cut is by
 * code point, and an over-long body is shortened until the JSON fits `maxPayloadBytes`.
 * @param {{
 *   kind: 'waiting' | 'done' | 'test',
 *   details?: boolean,
 *   mac?: unknown,
 *   project?: unknown,
 *   projectName?: unknown,
 *   session?: unknown,
 *   ev?: any,
 *   badge?: unknown,
 *   macName?: unknown,
 *   maxPayloadBytes?: number,
 * }} input
 * @returns {string}
 */
function buildPayload({ kind, details, mac, project, projectName, session, ev, badge, macName, maxPayloadBytes }) {
  const macText = text(mac);
  const badgeText = Number.isSafeInteger(badge) && /** @type {number} */ (badge) >= 0 ? /** @type {number} */ (badge) : 0;
  /** @type {Record<string, any>} */
  let payload;
  if (kind === 'test') {
    payload = {
      v: 1,
      kind,
      title: 'CCE Remote',
      body: `Notifications from ${text(macName) || 'Mac'} work.`,
      tag: 'cce-test',
      url: '/',
      mac: macText,
      badge: badgeText,
    };
  } else {
    const projectText = text(project);
    const sessionText = text(session);
    const title = details === true ? cut(text(projectName).trim(), TITLE_CHARS) || 'Claude Code' : 'Claude Code';
    let body;
    if (details === true) {
      const event = isRecord(ev) ? ev : {};
      const sessionTitle = cut(text(event.title).trim(), SESSION_TITLE_CHARS) || 'Untitled';
      let line;
      if (kind === 'done') {
        line = event.isError === true ? 'Stopped with an error' : text(event.text) ? `Finished: ${text(event.text)}` : 'Finished';
      } else {
        const prompt = isRecord(event.prompt) ? event.prompt : {};
        const promptKind = text(prompt.kind);
        const promptText = text(prompt.text);
        if (promptKind === 'question') line = promptText ? `Claude asks: ${promptText}` : 'Claude has a question';
        else if (promptKind === 'tool') line = promptText ? `Allow ${text(prompt.toolName)}: ${promptText}?` : `Allow ${text(prompt.toolName)}?`;
        else if (promptKind === 'plan') line = 'Plan ready for your approval';
        else line = 'Claude needs your input';
      }
      body = `${sessionTitle}\n${cut(line, LINE_CHARS)}`;
    } else {
      body = kind === 'done' ? 'A session finished' : 'A session needs your input';
    }
    payload = {
      v: 1,
      kind,
      title,
      body,
      tag: `${macText}:${projectText}:${sessionText}`,
      url: `/?mac=${encodeURIComponent(macText)}&project=${encodeURIComponent(projectText)}&session=${encodeURIComponent(sessionText)}`,
      mac: macText,
      badge: badgeText,
    };
  }

  let json = JSON.stringify(payload);
  const max = maxPayloadBytes ?? NOTIFIER_LIMITS.maxPayloadBytes;
  // The body is what is shortened first. If the identifiers alone are too big for that, the other
  // fields follow in the same way, so the payload always fits.
  for (const field of /** @type {const} */ (['body', 'title', 'tag', 'url'])) {
    if (Buffer.byteLength(json) <= max) break;
    let length = Array.from(payload[field]).length;
    while (Buffer.byteLength(json) > max && length > 0) {
      length--;
      payload[field] = cut(payload[field], length);
      json = JSON.stringify(payload);
    }
  }
  return json;
}

/**
 * The notifier. Events come from the hub as `attention({key, project, projectName, ev})` and
 * `windowRemoved(key)`. It never emits anything itself; it logs through `log` and sends through
 * `send` (sendPush by default, with `sendOptions`).
 */
class Notifier {
  /** @param {NotifierOptions} options */
  constructor({ state, updateState, isLooking, macName, log = () => {}, now = Date.now, idleSeconds = userIdleSeconds, send = sendPush, sendOptions = {}, timers = { setTimeout, clearTimeout }, limits = {} }) {
    this._state = state;
    this._updateState = updateState;
    this._isLooking = isLooking;
    this._macName = macName;
    this._logger = log;
    this._now = now;
    this._idleSeconds = idleSeconds;
    this._send = send;
    this._sendOptions = isRecord(sendOptions) ? sendOptions : {};
    this._timers = timers;
    this._limits = {
      ...NOTIFIER_LIMITS,
      ...limits,
      ttl: { ...NOTIFIER_LIMITS.ttl, ...(isRecord(limits.ttl) ? limits.ttl : {}) },
      urgency: { ...NOTIFIER_LIMITS.urgency, ...(isRecord(limits.urgency) ? limits.urgency : {}) },
    };
    this._closed = false;
    // Every send gets its signal; close() aborts the ones in flight.
    this._abort = new AbortController();
    /** @type {Map<string, { key: string, project: string, session: string, ids: Set<string>, timers: Map<string, any> }>} */
    this._sessions = new Map();
    /** @type {Set<string>} */
    this._seen = new Set();
    /** @type {string[]} */
    this._seenOrder = [];
    /** @type {Map<string, number[]>} device id → send times in the cap window */
    this._cap = new Map();
    /** @type {Map<string, number>} */
    this._capLogged = new Map();
    /** @type {Map<string, number>} */
    this._failLogged = new Map();
  }

  /**
   * A window's attention event. `waiting` records the prompt and schedules a push after the grace;
   * `open` replaces the session's open set and drops the pushes of prompts no longer in it; `done`
   * pushes now. Fields beyond the hub's checks are read defensively.
   * @param {{ key: unknown, project: unknown, projectName: unknown, ev: unknown }} event
   */
  attention(event) {
    if (this._closed || !isRecord(event)) return;
    const key = text(event.key);
    const project = text(event.project);
    const projectName = text(event.projectName);
    const ev = event.ev;
    if (key === '' || project === '' || !isRecord(ev)) return;
    const session = text(ev.session);
    if (session === '') return;
    if (ev.kind === 'waiting') {
      const requestId = text(ev.requestId);
      if (requestId === '') return;
      const entry = this._session(key, project, session);
      const seenKey = JSON.stringify([key, project, session, requestId]);
      if (this._seen.has(seenKey)) return;
      this._remember(seenKey);
      entry.ids.add(requestId);
      const timer = this._timers.setTimeout(() => {
        entry.timers.delete(requestId);
        if (this._closed || !entry.ids.has(requestId)) return;
        this._deliver({ key, project, projectName, session, kind: 'waiting', ev }).catch(() => {});
      }, this._limits.graceMs);
      if (typeof timer?.unref === 'function') timer.unref();
      entry.timers.set(requestId, timer);
      return;
    }
    if (ev.kind === 'open') {
      const entry = this._session(key, project, session);
      const requestIds = Array.isArray(ev.requestIds) ? ev.requestIds.filter((id) => typeof id === 'string' && id !== '') : [];
      entry.ids = new Set(requestIds);
      for (const [requestId, timer] of [...entry.timers]) {
        if (entry.ids.has(requestId)) continue;
        this._timers.clearTimeout(timer);
        entry.timers.delete(requestId);
      }
      // Nothing is open in this session anymore: its entry would only linger.
      if (entry.ids.size === 0) this._sessions.delete(JSON.stringify([key, project, session]));
      return;
    }
    if (ev.kind === 'done') {
      this._deliver({ key, project, projectName, session, kind: 'done', ev }).catch(() => {});
    }
  }

  /** Drops a window's open sets and pending grace timers. @param {unknown} key */
  windowRemoved(key) {
    const name = text(key);
    for (const [id, entry] of [...this._sessions]) {
      if (entry.key !== name) continue;
      for (const timer of entry.timers.values()) this._timers.clearTimeout(timer);
      this._sessions.delete(id);
    }
  }

  /** The number of sessions with at least one open prompt (the badge). */
  waitingCount() {
    let count = 0;
    for (const entry of this._sessions.values()) if (entry.ids.size > 0) count++;
    return count;
  }

  /** Whether state.json holds a subscription for this device. @param {string} deviceId */
  hasPush(deviceId) {
    try {
      const device = findDevice(this._state(), deviceId);
      return device !== undefined && isRecord(device.push);
    } catch {
      return false;
    }
  }

  /**
   * Validates and stores a push_set frame. The subscription is written only when something changed;
   * the original createdAt is kept. @param {string} deviceId @param {unknown} frame
   * @returns {SetResult}
   */
  setPush(deviceId, frame) {
    const allowEndpoint = typeof this._sendOptions.allowEndpoint === 'function' ? this._sendOptions.allowEndpoint : isAllowedEndpoint;
    const normalized = normalizePushFrame(frame, allowEndpoint);
    if (!normalized.ok) return normalized;
    let state;
    try {
      state = this._state();
    } catch {
      return { ok: false, error: 'save_failed' };
    }
    const device = findDevice(state, deviceId);
    if (!device) return { ok: false, error: 'save_failed' };
    const existing = isRecord(device.push) ? device.push : null;
    const desired = normalized.push;
    if (existing && pushFields(existing) === pushFields(desired)) return { ok: true };
    const createdAt = existing && Number.isFinite(existing.createdAt) ? existing.createdAt : this._now();
    /** @type {PushRecord} */
    const record = { ...desired, createdAt };
    try {
      this._updateState((next) => {
        const target = findDevice(next, deviceId);
        if (target) target.push = record;
      });
    } catch {
      return { ok: false, error: 'save_failed' };
    }
    return { ok: true };
  }

  /** Removes a device's subscription, if it has one. @param {string} deviceId @returns {SetResult} */
  clearPush(deviceId) {
    let state;
    try {
      state = this._state();
    } catch {
      return { ok: false, error: 'save_failed' };
    }
    const device = findDevice(state, deviceId);
    if (!device || !isRecord(device.push)) return { ok: true };
    try {
      this._updateState((next) => {
        const target = findDevice(next, deviceId);
        if (target) delete target.push;
      });
    } catch {
      return { ok: false, error: 'save_failed' };
    }
    return { ok: true };
  }

  /**
   * Sends a test notification, ignoring looking, away and the cap. @param {string} deviceId
   * @returns {Promise<TestResult>}
   */
  async test(deviceId) {
    let device;
    try {
      device = findDevice(this._state(), deviceId);
    } catch {
      device = undefined;
    }
    if (!device || !isRecord(device.push)) return { ok: false, error: 'push_off' };
    const record = device.push;
    const payload = buildPayload({ kind: 'test', mac: deviceId, macName: this._macNameText(), badge: this.waitingCount(), maxPayloadBytes: this._limits.maxPayloadBytes });
    const push = {
      endpoint: record.endpoint,
      keys: record.keys,
      vapid: record.vapid,
      subject: record.subject,
      payload,
      ttl: this._limits.ttl.test,
      urgency: this._limits.urgency.test,
    };
    const result = await this._sendPush(push);
    if (result.ok) return { ok: true };
    if (result.gone) {
      this._removeGone(deviceId, record.endpoint);
      return { ok: false, error: 'push_gone' };
    }
    return { ok: false, error: 'push_failed', status: result.status, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
  }

  /** Stops every timer and aborts the sends in flight; no send result is acted on afterwards. */
  close() {
    this._closed = true;
    this._abort.abort();
    for (const entry of this._sessions.values()) {
      for (const timer of entry.timers.values()) this._timers.clearTimeout(timer);
    }
    this._sessions.clear();
  }

  /** @param {string} key @param {string} project @param {string} session */
  _session(key, project, session) {
    const id = JSON.stringify([key, project, session]);
    let entry = this._sessions.get(id);
    if (!entry) {
      entry = { key, project, session, ids: new Set(), timers: new Map() };
      this._sessions.set(id, entry);
    }
    return entry;
  }

  /** Remembers a request id for the dedupe, keeping the last `dedupeKeep`. @param {string} key */
  _remember(key) {
    this._seen.add(key);
    this._seenOrder.push(key);
    while (this._seenOrder.length > this._limits.dedupeKeep) {
      const oldest = this._seenOrder.shift();
      if (oldest !== undefined) this._seen.delete(oldest);
    }
  }

  /** @param {string} deviceId */
  _looking(deviceId) {
    try {
      return this._isLooking(deviceId) === true;
    } catch {
      return false;
    }
  }

  /** The Mac's idle time, bounded by 3 s; a timeout or failure counts as away (Infinity). @returns {Promise<number>} */
  _idle() {
    return new Promise((resolve) => {
      let done = false;
      /** @param {number} value */
      const finish = (value) => {
        if (done) return;
        done = true;
        this._timers.clearTimeout(timer);
        resolve(value);
      };
      const timer = this._timers.setTimeout(() => finish(Infinity), IDLE_TIMEOUT_MS);
      if (typeof timer?.unref === 'function') timer.unref();
      Promise.resolve()
        .then(() => this._idleSeconds())
        .then(
          (value) => finish(typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : Infinity),
          () => finish(Infinity),
        );
    });
  }

  /** @param {string} deviceId */
  _underCap(deviceId) {
    const now = this._now();
    const times = (this._cap.get(deviceId) ?? []).filter((at) => now - at < CAP_WINDOW_MS);
    this._cap.set(deviceId, times);
    if (times.length < this._limits.capPerMinute) return true;
    const logged = this._capLogged.get(deviceId);
    if (logged === undefined || now - logged >= CAP_LOG_MS) {
      this._capLogged.set(deviceId, now);
      this._log(`push cap reached for device ${deviceId}; dropping a push`, 'info');
    }
    return false;
  }

  /** @param {string} deviceId */
  _recordPush(deviceId) {
    const times = this._cap.get(deviceId) ?? [];
    times.push(this._now());
    this._cap.set(deviceId, times);
  }

  /** @param {string} deviceId @param {unknown} endpoint @param {number} status @param {string} [reason] */
  _logFailure(deviceId, endpoint, status, reason) {
    const now = this._now();
    const logged = this._failLogged.get(deviceId);
    if (logged !== undefined && now - logged < this._limits.failLogEveryMs) return;
    this._failLogged.set(deviceId, now);
    const host = hostOf(endpoint);
    const detail = status === 0 && typeof reason === 'string' && reason !== '' ? reason : `status ${status}`;
    this._log(`push to ${host || 'the push service'} failed (${detail})`, 'warn');
  }

  /** Removes a subscription the push service no longer knows, if the stored endpoint is still that one. @param {string} deviceId @param {unknown} endpoint */
  _removeGone(deviceId, endpoint) {
    try {
      this._updateState((state) => {
        const device = findDevice(state, deviceId);
        if (!device || !isRecord(device.push) || device.push.endpoint !== endpoint) return;
        delete device.push;
      });
    } catch {
      this._log(`could not remove a gone push subscription (device ${deviceId})`, 'warn');
    }
  }

  /** Sends one push and normalizes what comes back; never rejects. @param {any} push */
  async _sendPush(push) {
    try {
      const result = await this._send(push, { ...this._sendOptions, signal: this._abort.signal });
      if (!isRecord(result)) return { ok: false, status: 0, gone: false };
      const status = finite(result.status);
      const reason = status === 0 && typeof result.reason === 'string' && result.reason !== '' ? result.reason : undefined;
      return { ok: result.ok === true, status, gone: result.gone === true, ...(reason !== undefined ? { reason } : {}) };
    } catch {
      return { ok: false, status: 0, gone: false };
    }
  }

  /**
   * The pushes for one attention event: each device that has a subscription and passes its pref,
   * looking, away and cap rules. @param {{ key: string, project: string, projectName: string, session: string, kind: 'waiting' | 'done', ev: any }} info
   */
  async _deliver({ key, project, projectName, session, kind, ev }) {
    if (this._closed) return;
    let devices;
    try {
      const state = this._state();
      devices = isRecord(state) && Array.isArray(state.devices) ? state.devices.filter(isRecord) : [];
    } catch {
      return;
    }
    for (const device of devices) {
      if (this._closed) return;
      const deviceId = text(device.id);
      if (deviceId === '' || !isRecord(device.push)) continue;
      const record = device.push;
      if (!prefOn(record.prefs, kind)) continue;
      if (this._looking(deviceId)) continue;
      if (prefOn(record.prefs, 'onlyAway')) {
        const idle = await this._idle();
        if (this._closed) return;
        if (idle < this._limits.awayAfterS) continue;
      }
      if (!this._underCap(deviceId)) continue;
      this._recordPush(deviceId);
      const payload = buildPayload({
        kind,
        details: prefOn(record.prefs, 'details'),
        mac: deviceId,
        project,
        projectName,
        session,
        ev,
        badge: this.waitingCount(),
        macName: this._macNameText(),
        maxPayloadBytes: this._limits.maxPayloadBytes,
      });
      const push = {
        endpoint: record.endpoint,
        keys: record.keys,
        vapid: record.vapid,
        subject: record.subject,
        payload,
        ttl: this._limits.ttl[kind],
        urgency: this._limits.urgency[kind],
        topic: topicOf(kind, project, session),
      };
      const result = await this._sendPush(push);
      if (this._closed) continue;
      if (result.gone) {
        this._removeGone(deviceId, record.endpoint);
        continue;
      }
      if (!result.ok) this._logFailure(deviceId, record.endpoint, result.status, result.reason);
    }
  }

  _macNameText() {
    try {
      const name = this._macName();
      if (typeof name === 'string' && name.trim() !== '') return name.trim().slice(0, 100);
    } catch {
      // fall through
    }
    return 'Mac';
  }

  /** @param {string} message @param {'info' | 'warn' | 'error'} [level] */
  _log(message, level = 'info') {
    try {
      this._logger(message, level);
    } catch {
      // a logger that throws must not break the notifier
    }
  }
}

module.exports = { Notifier, NOTIFIER_LIMITS, buildPayload };
