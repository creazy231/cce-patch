// @ts-check
'use strict';
// The bridge's state file: `$CCE_REMOTE_HOME/state.json`, or `~/.cce-remote/state.json`. Every window
// of every editor reads it and the hub writes it, so a write is atomic (a temp file renamed over
// it), and the file and its directory belong to their owner alone: the file holds the secret that
// authenticates the windows to each other and the hashes of the phones' tokens.
//
// All functions are synchronous and take the environment as an argument (default process.env), so a
// test points them at a temp directory with `{ CCE_REMOTE_HOME: dir }`.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');

const DEFAULT_PORT = 47821;
const FILE_NAME = 'state.json';
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const SECRET_RE = /^[0-9a-f]{64}$/i;
// How often loadState looks again when another window creates, repairs or removes the file while it reads.
const MAX_ROUNDS = 5;

/**
 * @typedef {{ id: string, name: string, tokenHash: string, origin: string, createdAt: number, lastSeenAt: number }} Device
 * `chromeAutoAccept`: the Connection tab's Claude in Chrome switch; only `true` is on (chromeAutoAcceptOn), and
 * no repair adds it.
 * @typedef {{ version: number, enabled: boolean, port: number, secret: string, appUrl: string, devices: Device[], chromeAutoAccept?: unknown, [key: string]: unknown }} State
 * @typedef {Record<string, string | undefined>} Env
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is number} */
function isPort(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

/** A secret is 32 random bytes as hex. @param {unknown} value @returns {value is string} */
function isSecret(value) {
  return typeof value === 'string' && SECRET_RE.test(value);
}

/** Whether something is a promise or promise-like: what an async function hands back. @param {unknown} value */
function isThenable(value) {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (/** @type {any} */ (value)).then === 'function';
}

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return isRecord(error) && error.code === code;
}

/** The directory of the state file: CCE_REMOTE_HOME, else `.cce-remote` in the home directory. @param {Env} [env] */
function remoteHome(env = process.env) {
  const override = env.CCE_REMOTE_HOME;
  if (typeof override === 'string' && override !== '') return override;
  return path.join(env.HOME || os.homedir(), '.cce-remote');
}

/** @param {Env} [env] */
function statePath(env = process.env) {
  return path.join(remoteHome(env), FILE_NAME);
}

function newSecret() {
  return randomBytes(32).toString('hex');
}

/** @returns {State} */
function defaultState() {
  return { version: 1, enabled: false, port: DEFAULT_PORT, secret: newSecret(), appUrl: '', devices: [] };
}

/**
 * What the file's content makes of a state: a key that is missing or holds the wrong type gets its
 * default (a wrong `enabled` or `port` must not switch the bridge on, or make it listen somewhere
 * odd), everything else stays, unknown keys included. `changed` says whether anything was replaced,
 * that is whether the file needs a rewrite. A missing or invalid secret is made by `makeSecret`.
 * @param {Record<string, unknown>} raw
 * @param {() => string} [makeSecret]
 * @returns {{ state: State, changed: boolean }}
 */
function normalize(raw, makeSecret = newSecret) {
  /** @type {Record<string, unknown>} */
  const state = { ...raw };
  let changed = false;
  /** @param {string} key @param {boolean} valid @param {() => unknown} make */
  const need = (key, valid, make) => {
    if (valid) return;
    state[key] = make();
    changed = true;
  };
  need('version', typeof raw.version === 'number' && Number.isFinite(raw.version), () => 1);
  need('enabled', typeof raw.enabled === 'boolean', () => false);
  need('port', isPort(raw.port), () => DEFAULT_PORT);
  need('secret', isSecret(raw.secret), makeSecret);
  need('appUrl', typeof raw.appUrl === 'string', () => '');
  if (Array.isArray(raw.devices)) {
    const devices = raw.devices.filter(isRecord);
    need('devices', devices.length === raw.devices.length, () => devices);
  } else {
    need('devices', false, () => []);
  }
  return { state: /** @type {State} */ (state), changed };
}

/** The file's text without a byte order mark; null when there is no file. @param {string} file */
function readText(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return null;
    throw error;
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** @param {string} text @returns {Record<string, unknown> | null} null unless the text is a JSON object */
function parseObject(text) {
  try {
    const value = JSON.parse(text);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/** @param {object} state */
function serialize(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** A name for a temp file next to `file` (a rename has to stay on one file system). @param {string} file */
function tempPath(file) {
  return `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
}

/**
 * Writes `text` to a new file that only the owner can use, and syncs it to the disk: a crash
 * after the rename that follows must not leave an empty state file, which would cost the secret
 * and every pairing.
 * @param {string} tmp
 * @param {string} text
 */
function writeTemp(tmp, text) {
  const fd = fs.openSync(tmp, 'wx', FILE_MODE);
  try {
    fs.fchmodSync(fd, FILE_MODE); // the umask can only take permissions away; this makes the mode exact
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Creates the state directory (and its parents) and makes it the owner's alone. @param {string} dir */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if ((fs.statSync(dir).mode & 0o777) !== DIR_MODE) fs.chmodSync(dir, DIR_MODE);
}

/** @param {string} file */
function ensureFileMode(file) {
  try {
    if ((fs.statSync(file).mode & 0o777) !== FILE_MODE) fs.chmodSync(file, FILE_MODE);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error; // gone meanwhile: nothing to repair
  }
}

/**
 * Creates the file with `text` unless it exists already. The text goes to a temp file first, which
 * is then hard-linked to the real name: nobody ever sees a half-written file, and the link fails
 * when the file exists, so of several windows that start together exactly one state, and one
 * secret, wins. On a file system without hard links it renames instead, which is atomic as well
 * but would replace a file that appeared meanwhile.
 * @param {string} file
 * @param {string} text
 * @returns {boolean} false when the file exists already
 */
function createExclusive(file, text) {
  const tmp = tempPath(file);
  try {
    writeTemp(tmp, text);
    try {
      fs.linkSync(tmp, file);
    } catch (error) {
      if (hasCode(error, 'EEXIST')) return false;
      fs.renameSync(tmp, file);
    }
    return true;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Moves a file we cannot use out of the way, and keeps it for a person to look at. @param {string} file */
function moveAside(file) {
  try {
    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
  } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

/**
 * Reads the state. The directory (0700) and the file (0600, with the defaults and a new secret)
 * are created when they are missing; wider permissions are repaired. Keys this version does not
 * know stay, keys that are missing or have the wrong type get their default and the file is
 * rewritten. A file that is not a JSON object is renamed to `state.json.corrupt-<ms since
 * epoch>` and replaced by the defaults, so the person can still look at what was in it.
 * @param {Env} [env]
 * @returns {State}
 */
function loadState(env = process.env) {
  const dir = remoteHome(env);
  const file = path.join(dir, FILE_NAME);
  ensureDir(dir);
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const text = readText(file);
    if (text === null) {
      const state = defaultState();
      if (createExclusive(file, serialize(state))) return state;
      continue; // another window was first: read its file
    }
    ensureFileMode(file);
    const raw = parseObject(text);
    if (raw === null) {
      if (readText(file) === text) moveAside(file); // unless another window repaired it just now
      continue;
    }
    const { state, changed } = normalize(raw);
    if (changed) saveState(state, env);
    return state;
  }
  throw new Error(`the state file ${file} keeps changing`);
}

/**
 * Writes the state: a temp file (0600) is written, synced and renamed over the real one, so a
 * reader sees the old file or the new one and never a mix. Keys the state has are all written,
 * those it lacks are gone: pass what loadState or updateState gave you. A state that is not an
 * object, or whose `secret` is not 64 hex characters, is refused with a TypeError before anything
 * is touched: a file without its secret would cost every pairing and the link between the windows,
 * and every way of getting there by accident (a Promise, a device that a function returned, a
 * cleared secret) is a value that is not a state. Nothing else is checked.
 * @param {State} state
 * @param {Env} [env]
 */
function saveState(state, env = process.env) {
  if (!isRecord(state)) throw new TypeError('state must be an object');
  if (!isSecret(state.secret)) throw new TypeError('state.secret must be 64 hex characters: refusing to save a state without a valid secret');
  const dir = remoteHome(env);
  ensureDir(dir);
  const file = path.join(dir, FILE_NAME);
  const tmp = tempPath(file);
  try {
    writeTemp(tmp, serialize(state));
    fs.renameSync(tmp, file);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Changes the state: reads the file right now (so what other windows wrote since the caller last
 * looked is kept), runs `fn` on it and writes the result back. `fn` must be synchronous: a promise
 * (what an async function returns) is refused with a TypeError. It changes the state in place, or
 * returns an object that replaces it; any other return value (an arrow function that returns its
 * assignment, a pushed length) means the in-place change counts. What is written must have a valid
 * secret (see saveState), so a returned object that is not a state, such as a device that `fn`
 * updated, is refused with a TypeError as well, and so is a change that clears the secret. Nothing
 * is written when `fn` throws or is refused. Not locked: two windows that update at the very same
 * moment can lose one of the changes (the time between the read and the rename is a few
 * milliseconds).
 * @param {(state: State) => unknown} fn
 * @param {Env} [env]
 * @returns {State} what was written
 */
function updateState(fn, env = process.env) {
  const state = loadState(env);
  const result = fn(state);
  if (isThenable(result)) {
    // The slip is reported here, once: if the async function fails later, that must not come on top as an unhandled rejection.
    if (result instanceof Promise) result.catch(() => {});
    throw new TypeError('updateState: fn must not be async (it returned a promise); nothing was written');
  }
  const next = isRecord(result) ? /** @type {State} */ (result) : state;
  saveState(next, env);
  return next;
}

/**
 * Looks at the state file without touching it: the state as loadState would return it, and its
 * JSON. Null when the file is missing, is not a JSON object or has no usable secret: a new secret
 * is made, and stored, by loadState only. Other keys that loadState would repair are repaired in
 * the copy, so a file that loadState then rewrites with those repairs is no change.
 * @param {string} file
 * @returns {{ state: State, json: string } | null}
 */
function peekState(file) {
  const text = readText(file);
  const raw = text === null ? null : parseObject(text);
  if (raw === null) return null;
  const { state } = normalize(raw, () => '');
  return state.secret === '' ? null : { state, json: JSON.stringify(state) };
}

/**
 * Calls `cb(state)` when the state file changes to JSON it did not hold before (polled with
 * `fs.watchFile` every `intervalMs`). A rewrite with the same JSON is no change. The state is
 * what loadState would return. A file that is missing, not a JSON object or without a usable
 * secret is skipped until a good one appears (when there was none as the watching began, the first
 * good one counts as a change), and the watcher never writes: loadState (or updateState) is what
 * repairs a file. The watcher does not keep the process alive.
 * @param {(state: State) => void} cb
 * @param {Env} [env]
 * @param {number} [intervalMs]
 * @returns {() => void} stops watching
 */
function watchState(cb, env = process.env, intervalMs = 2000) {
  const file = statePath(env);
  /** @returns {{ state: State, json: string } | null} */
  const look = () => {
    try {
      return peekState(file);
    } catch {
      return null; // unreadable right now: the next poll tries again
    }
  };
  let last = look()?.json ?? null;
  const listener = () => {
    const seen = look();
    if (seen === null || seen.json === last) return;
    last = seen.json;
    cb(seen.state);
  };
  fs.watchFile(file, { interval: intervalMs, persistent: false }, listener);
  return () => fs.unwatchFile(file, listener);
}

/**
 * Whether the Connection tab's Claude in Chrome switch is on: `chromeAutoAccept: true` in the state file,
 * read now and never written (nothing is repaired, no file or secret is made). A file that is missing,
 * cannot be read or is not a JSON object is off: the switch fails closed.
 * @param {Env} [env]
 */
function chromeAutoAcceptOn(env = process.env) {
  try {
    const text = readText(statePath(env));
    const raw = text === null ? null : parseObject(text);
    return raw !== null && raw.chromeAutoAccept === true;
  } catch {
    return false;
  }
}

/**
 * The port the hub listens on: CCE_REMOTE_PORT when it holds a port (1 to 65535), else the
 * state's, else the default.
 * @param {{ port?: unknown } | null | undefined} state
 * @param {Env} [env]
 */
function effectivePort(state, env = process.env) {
  const fromEnv = typeof env.CCE_REMOTE_PORT === 'string' ? env.CCE_REMOTE_PORT.trim() : '';
  if (/^\d{1,5}$/.test(fromEnv) && isPort(Number(fromEnv))) return Number(fromEnv);
  const fromState = state ? state.port : undefined;
  return isPort(fromState) ? fromState : DEFAULT_PORT;
}

module.exports = { DEFAULT_PORT, remoteHome, statePath, loadState, saveState, updateState, watchState, effectivePort, chromeAutoAcceptOn };
