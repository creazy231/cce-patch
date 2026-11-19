// @ts-check
'use strict';
// How long the Mac's keyboard, mouse and trackpad have been idle, for the notifier's "only when I'm
// away" rule. macOS keeps it as `HIDIdleTime` in the IOHIDSystem registry entry, in nanoseconds since
// the last input event, and `ioreg` prints it (in a few milliseconds).
//
// When the idle time can't be told, the answer is Infinity: not macOS, no `ioreg`, a read that fails
// or times out, output without the field. The user then counts as away, so a notification goes out
// rather than being held back on a guess.

const { execFile } = require('child_process');

const IOREG = '/usr/sbin/ioreg'; // the system's own, not whatever PATH finds first
const IOREG_ARGS = ['-c', 'IOHIDSystem', '-d', '4'];
const CACHE_MS = 5000;
const TIMEOUT_MS = 2000;
// The output is a few KB; this is far beyond any real one.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const IDLE_TIME = /"HIDIdleTime"\s*=\s*(\d+)/;

/**
 * @typedef {(file: string, args: string[], options: { timeoutMs: number }) => Promise<string | Buffer | { stdout: string | Buffer }>} Run
 *   Runs a program and resolves with what it printed (a promisified execFile's `{ stdout }` will do
 *   as well as the text). Rejects when the program fails or runs past `timeoutMs`.
 */

/**
 * The idle time in `ioreg`'s output: the first `"HIDIdleTime" = <digits>`, which is nanoseconds, in
 * seconds. Null when there is none.
 * @param {string} text
 * @returns {number | null}
 */
function parseIdleSeconds(text) {
  const match = typeof text === 'string' ? IDLE_TIME.exec(text) : null;
  return match ? Number(match[1]) / 1e9 : null;
}

/** @type {Run} */
function execFileText(file, args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, encoding: 'utf8', maxBuffer: MAX_OUTPUT_BYTES, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** @param {unknown} result what a Run resolved with @returns {string} */
function outputText(result) {
  const out = result !== null && typeof result === 'object' && !Buffer.isBuffer(result) ? /** @type {{ stdout?: unknown }} */ (result).stdout : result;
  if (typeof out === 'string') return out;
  return Buffer.isBuffer(out) ? out.toString('utf8') : '';
}

/**
 * Reads the idle time from ioreg. Never rejects: whatever goes wrong is Infinity.
 * @param {Run} run
 * @param {number} timeoutMs
 * @returns {Promise<number>}
 */
async function readIoreg(run, timeoutMs) {
  try {
    return parseIdleSeconds(outputText(await run(IOREG, IOREG_ARGS, { timeoutMs }))) ?? Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * A reader of the idle time: a function that gives the seconds since the last keyboard, mouse or
 * trackpad input. It never rejects, and gives Infinity when it can't tell (see above). A result,
 * Infinity included, is reused for `cacheMs`, and callers that ask while ioreg is running share
 * that one run, so a polling caller doesn't start a program each time.
 * @param {{
 *   platform?: string,
 *   run?: Run,
 *   now?: () => number,
 *   cacheMs?: number,
 *   timeoutMs?: number,
 * }} [options]
 *   platform: anything but 'darwin' gives Infinity without running anything.
 *   run: starts ioreg (the default is execFile with the timeout; tests pass a stub).
 *   now: the clock of the cache.
 * @returns {() => Promise<number>}
 */
function createIdleReader({ platform = process.platform, run = execFileText, now = Date.now, cacheMs = CACHE_MS, timeoutMs = TIMEOUT_MS } = {}) {
  /** @type {{ at: number, value: number } | null} */
  let cache = null;
  /** @type {Promise<number> | null} */
  let pending = null;
  return () => {
    if (platform !== 'darwin') return Promise.resolve(Infinity);
    if (cache) {
      const age = now() - cache.at;
      // A negative age is a clock set back: it would keep an old result for as long as it was set back.
      if (age >= 0 && age < cacheMs) return Promise.resolve(cache.value);
    }
    if (!pending) {
      pending = readIoreg(run, timeoutMs).then((value) => {
        cache = { at: now(), value };
        pending = null;
        return value;
      });
    }
    return pending;
  };
}

/** The idle time of this Mac in seconds (Infinity where it can't be told), at most 5 s old. */
const userIdleSeconds = createIdleReader();

module.exports = { createIdleReader, parseIdleSeconds, userIdleSeconds };
