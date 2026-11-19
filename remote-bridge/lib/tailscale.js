// @ts-check
'use strict';
// The bridge's view of Tailscale: it reads the CLI's status, switches `tailscale serve` on and off
// for the bridge's port, and opens the Tailscale app. It runs only the CLI that ships with
// Tailscale (the app's own binary, or `tailscale` on PATH) and needs no network of its own.
//
// What the CLI does that shapes this code:
// - `status --json` lists the whole tailnet; only Self, the users and CertDomains matter here.
// - A CLI whose version differs from the daemon's prints a `Warning: client version ...` line on
//   stderr. Stdout is still clean JSON, and the line is left out of error messages.
// - `serve --bg --https=<port> <target>` returns at once when it works. When the tailnet has not
//   enabled the feature (Serve, or HTTPS certificates) it prints a `https://login.tailscale.com/...`
//   link and then waits for the user to open it, so the run is stopped when the link appears.
// - `serve --https=<port> off` fails when nothing is set up for the port.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const CLI_TIMEOUT_MS = 5000;
// `serve` may wait for the user (the consent link): it gets longer than the other commands.
const SERVE_ON_TIMEOUT_MS = 20000;
const STATUS_TTL_MS = 5000;
// How long a program that was told to stop may ignore it before it is killed for good.
const KILL_GRACE_MS = 2000;
// `status --json` holds every peer of the tailnet; this is far beyond any real one.
const MAX_OUTPUT_CHARS = 16 * 1024 * 1024;
const MAX_ERROR_CHARS = 500;
const NOT_INSTALLED_TEXT = 'Tailscale is not installed';

const KNOWN_CLIS = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/usr/local/bin/tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/bin/tailscale',
];

/**
 * @typedef {{
 *   installed: boolean,
 *   running: boolean,
 *   backendState?: string,
 *   loginName?: string,
 *   dnsName?: string,
 *   hostName?: string,
 *   httpsEnabled?: boolean,
 *   error?: string,
 *   consentUrl?: string,
 * }} Status
 *   Not installed: `{installed: false, running: false, httpsEnabled: false}`. The CLI failed:
 *   `{installed: true, running: false, error}`. Otherwise parseStatus() of the CLI's answer.
 *   running is BackendState "Running"; dnsName has no trailing dot; httpsEnabled means the tailnet
 *   has HTTPS certificates (CertDomains is not empty); consentUrl is for the caller to fill in.
 * @typedef {{
 *   code: number | null,
 *   signal?: string | null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 *   stopped: boolean,
 *   error?: Error,
 * }} RunResult
 *   code is null when the program did not end by itself; stopped means `until` ended the run;
 *   error is a program that could not be started (`code` ENOENT when it is not there) or one that
 *   printed too much.
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs: number,
 *   until?: (output: { stdout: string, stderr: string }) => boolean,
 *   killGraceMs?: number,
 *   maxOutputChars?: number,
 * }} RunOptions
 * @typedef {(command: string, args: string[], options: RunOptions) => Promise<RunResult>} Run
 */

// --- finding the CLI ------------------------------------------------------------------------

/**
 * Finds the Tailscale CLI: `$CCE_REMOTE_TAILSCALE`, the app's own binary, the usual install
 * locations, then `tailscale` on PATH. The override is final: while it is set, a path that does
 * not exist means "not installed" and never another CLI (tests point it at a fake, and a typo must
 * not end up running the real one against a real tailnet).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(file: string) => boolean} [exists]
 * @returns {string | null}
 */
function findCli(env = process.env, exists = fs.existsSync) {
  const override = env.CCE_REMOTE_TAILSCALE;
  if (override) return exists(override) ? override : null;
  for (const candidate of KNOWN_CLIS) {
    if (exists(candidate)) return candidate;
  }
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    // An empty or relative entry means the current directory: never run a `tailscale` found there.
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'tailscale');
    if (exists(candidate)) return candidate;
  }
  return null;
}

// --- reading the CLI's output ---------------------------------------------------------------

/** @param {unknown} value @returns {value is Record<string, any>} */
function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {string | undefined} the string, unless it is empty or not a string */
function nonEmptyString(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the JSON of `tailscale status --json`. Fields the CLI does not give (a logged-out node has
 * no Self and no users) are undefined; junk gives a not-running status, never a throw.
 * @param {unknown} json
 * @returns {Status}
 */
function parseStatus(json) {
  const status = isObject(json) ? json : {};
  const self = isObject(status.Self) ? status.Self : {};
  const users = isObject(status.User) ? status.User : {};
  const backendState = typeof status.BackendState === 'string' ? status.BackendState : '';
  // The login is Self's own user, found by id: the map also holds the users of every peer.
  const user = self.UserID === undefined || self.UserID === null ? undefined : users[String(self.UserID)];
  return {
    installed: true,
    running: backendState === 'Running',
    backendState,
    loginName: nonEmptyString(isObject(user) ? user.LoginName : undefined),
    dnsName: nonEmptyString(typeof self.DNSName === 'string' ? self.DNSName.replace(/\.$/, '') : undefined),
    hostName: nonEmptyString(self.HostName),
    httpsEnabled: Array.isArray(status.CertDomains) && status.CertDomains.length > 0,
  };
}

/**
 * Whether the JSON of `tailscale serve status --json` has our port: served over HTTPS, with a
 * handler on `/` that proxies to `http://127.0.0.1:<port>`. The `Web` key is `<host>:<port>`.
 * @param {unknown} json
 * @param {number} port
 * @returns {boolean}
 */
function parseServeStatus(json, port) {
  const config = isObject(json) ? json : {};
  const listener = isObject(config.TCP) ? config.TCP[String(port)] : undefined;
  if (!isObject(listener) || listener.HTTPS !== true || !isObject(config.Web)) return false;
  const target = `http://127.0.0.1:${port}`;
  for (const [hostPort, site] of Object.entries(config.Web)) {
    if (!hostPort.endsWith(`:${port}`) || !isObject(site) || !isObject(site.Handlers)) continue;
    const handler = site.Handlers['/'];
    const proxy = isObject(handler) ? handler.Proxy : undefined;
    if (proxy === target || proxy === `${target}/`) return true;
  }
  return false;
}

// The link the CLI prints when a feature has to be enabled in the admin console first.
const CONSENT_URL = /https:\/\/login\.tailscale\.com\/[^\s"'<>]*/;
// The same, but only once whitespace follows it: a link that is still arriving is not complete.
const COMPLETE_CONSENT_URL = /https:\/\/login\.tailscale\.com\/[^\s"'<>]*(?=\s)/;

/** @param {string} url the link without the punctuation of the sentence around it */
function trimLink(url) {
  return url.replace(/[.,;:!?)\]]+$/, '');
}

/**
 * The first `https://login.tailscale.com/...` link in a text, or null.
 * @param {string} text
 * @returns {string | null}
 */
function findConsentUrl(text) {
  const match = CONSENT_URL.exec(String(text));
  return match ? trimLink(match[0]) : null;
}

/** @param {string} text @returns {string | null} */
function findCompleteConsentUrl(text) {
  const match = COMPLETE_CONSENT_URL.exec(text);
  return match ? trimLink(match[0]) : null;
}

/** @param {{ stdout: string, stderr: string }} output */
function hasCompleteConsentUrl({ stdout, stderr }) {
  // Each stream on its own, so a link cut off at the end of one is not finished by the other.
  return findCompleteConsentUrl(stdout) !== null || findCompleteConsentUrl(stderr) !== null;
}

/**
 * The consent link of a finished run: a whole link first, else one at the very end of the output.
 * @param {RunResult} result
 * @returns {string | null}
 */
function consentUrlOf(result) {
  return findCompleteConsentUrl(result.stdout) ?? findCompleteConsentUrl(result.stderr)
    ?? findConsentUrl(result.stdout) ?? findConsentUrl(result.stderr);
}

/**
 * The part of a CLI's output worth showing a user: without the version warning, trimmed, cut short.
 * @param {string} text
 */
function outputText(text) {
  const kept = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('Warning: client version '))
    .join('\n')
    .trim();
  return kept.length > MAX_ERROR_CHARS ? `${kept.slice(0, MAX_ERROR_CHARS)}…` : kept;
}

/**
 * Why a run did not work, in words for the Connection tab.
 * @param {RunResult} result
 * @param {number} timeoutMs  the limit the run had
 */
function describeFailure(result, timeoutMs) {
  const error = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  if (error) return error.code === 'ENOENT' ? NOT_INSTALLED_TEXT : `Could not run Tailscale: ${error.message}`;
  if (result.timedOut) return `Tailscale did not answer within ${timeoutMs / 1000} s`;
  const text = outputText(result.stderr) || outputText(result.stdout);
  if (text) return text;
  if (result.signal) return `Tailscale was stopped by ${result.signal}`;
  return `Tailscale exited with code ${result.code}`;
}

/** @param {RunResult} result */
function succeeded(result) {
  return result.code === 0 && !result.error && !result.timedOut && !result.stopped;
}

/** @param {unknown} error @returns {Error} */
function asError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * A port as a number, or null when it is not 1-65535. Digit strings count (CCE_REMOTE_PORT is one).
 * @param {unknown} port
 * @returns {number | null}
 */
function parsePort(port) {
  const value = typeof port === 'string' && /^\d+$/.test(port) ? Number(port) : port;
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

// --- running a program ----------------------------------------------------------------------

/**
 * Runs a program and collects its output, with stdin closed. Never rejects: whatever goes wrong is
 * in the result. `until` gets everything printed so far after each chunk; when it returns true the
 * run is over at once (`stopped`). A run past `timeoutMs` ends the same way (`timedOut`). Ending a
 * run means SIGTERM, then SIGKILL after `killGraceMs`, and the result does not wait for the program.
 * @type {Run}
 */
function runCli(command, args, { env = process.env, timeoutMs, until, killGraceMs = KILL_GRACE_MS, maxOutputChars = MAX_OUTPUT_CHARS }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let stopped = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {import('child_process').ChildProcess | undefined} */
    let proc;

    /** @param {number | null} code @param {string | null} [signal] @param {Error} [error] */
    const settle = (code, signal = null, error = undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, stopped, error });
    };

    const kill = () => {
      const child = proc;
      if (!child) return;
      child.kill('SIGTERM');
      const hardKill = setTimeout(() => child.kill('SIGKILL'), killGraceMs);
      hardKill.unref();
      child.once('exit', () => clearTimeout(hardKill));
      // Release the pipes: a grandchild that keeps them open would otherwise keep the process alive.
      child.stdout?.destroy();
      child.stderr?.destroy();
    };

    /** @param {'stdout' | 'stderr'} stream */
    const collect = (stream) => (/** @type {string} */ chunk) => {
      if (settled) return;
      if (stream === 'stdout') stdout += chunk;
      else stderr += chunk;
      try {
        if (stdout.length + stderr.length > maxOutputChars) {
          kill();
          settle(null, null, new Error('tailscale printed too much output'));
        } else if (until && until({ stdout, stderr })) {
          stopped = true;
          kill();
          settle(null);
        }
      } catch (error) {
        kill();
        settle(null, null, asError(error));
      }
    };

    try {
      proc = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      settle(null, null, asError(error));
      return;
    }
    proc.on('error', (error) => settle(null, null, error)); // not found, not executable, ...
    for (const [name, stream] of /** @type {const} */ ([['stdout', proc.stdout], ['stderr', proc.stderr]])) {
      if (!stream) continue;
      stream.setEncoding('utf8');
      stream.on('data', collect(name));
      stream.on('error', () => {}); // 'close' of the process follows
    }
    proc.on('close', (code, signal) => settle(code, signal));
    timer = setTimeout(() => {
      timedOut = true;
      kill();
      settle(null);
    }, timeoutMs);
  });
}

// --- Tailscale ------------------------------------------------------------------------------

/** What a run looks like when there is no CLI to run. */
function notFound() {
  const error = Object.assign(new Error(NOT_INSTALLED_TEXT), { code: 'ENOENT' });
  return /** @type {RunResult} */ ({ code: null, signal: null, stdout: '', stderr: '', timedOut: false, stopped: false, error });
}

class Tailscale {
  /**
   * @param {{
   *   cli?: string,
   *   env?: NodeJS.ProcessEnv,
   *   run?: Run,
   *   now?: () => number,
   *   platform?: string,
   * }} [options]
   *   cli: the CLI to run. Without it findCli() looks on every read, so a Tailscale installed later
   *     is found without a reload.
   *   env: the environment for findCli() and for the CLI.
   *   run: starts a program (see runCli); tests pass a stub.
   *   now: the clock of the status cache.
   *   platform: where openApp() works (macOS).
   */
  constructor({ cli, env = process.env, run = runCli, now = Date.now, platform = process.platform } = {}) {
    this._cli = cli;
    this._env = env;
    this._run = run;
    this._now = now;
    this._platform = platform;
    /** @type {{ at: number, value: Status } | null} */
    this._cache = null;
    /** @type {Promise<Status> | null} */
    this._pending = null;
    // Counts the changes that make a status read in flight stale (see _invalidate).
    this._epoch = 0;
  }

  /**
   * The Tailscale state, cached for 5 s (errors too, so a broken CLI is not run on every poll).
   * Never rejects. Each caller gets its own copy.
   * @returns {Promise<Status>}
   */
  status() {
    if (this._cache && this._now() - this._cache.at < STATUS_TTL_MS) return Promise.resolve({ ...this._cache.value });
    if (!this._pending) {
      const epoch = this._epoch;
      const pending = this._readStatus().then((value) => {
        if (epoch === this._epoch) this._cache = { at: this._now(), value };
        if (this._pending === pending) this._pending = null;
        return value;
      });
      this._pending = pending;
    }
    return this._pending.then((value) => ({ ...value }));
  }

  /**
   * Publishes `http://127.0.0.1:<port>` on the tailnet over HTTPS at the same port. When the
   * tailnet has to enable a feature first, the CLI prints a link and waits: this stops it and
   * returns the link as `needsConsent`. Never rejects.
   * @param {number} port
   * @returns {Promise<{ ok: true } | { ok: false, needsConsent?: string, error?: string }>}
   */
  async serveOn(port) {
    const number = parsePort(port);
    if (number === null) return { ok: false, error: `invalid port: ${String(port)}` };
    const result = await this._exec(['serve', '--bg', `--https=${number}`, `http://127.0.0.1:${number}`], SERVE_ON_TIMEOUT_MS, hasCompleteConsentUrl);
    this._invalidate(); // HTTPS may have been enabled while the CLI waited
    if (succeeded(result)) return { ok: true };
    // A link in the output of a run that did not finish well (stopped by us, or failed after printing it).
    const needsConsent = result.error ? null : consentUrlOf(result);
    if (needsConsent) return { ok: false, needsConsent };
    return { ok: false, error: describeFailure(result, SERVE_ON_TIMEOUT_MS) };
  }

  /**
   * Stops publishing the port. Succeeds as well when the port was not published (`off` fails
   * then). Never rejects.
   * @param {number} port
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async serveOff(port) {
    const number = parsePort(port);
    if (number === null) return { ok: false, error: `invalid port: ${String(port)}` };
    const result = await this._exec(['serve', `--https=${number}`, 'off'], CLI_TIMEOUT_MS);
    this._invalidate();
    if (succeeded(result)) return { ok: true };
    // The goal holds when the port turns out not to be served; a CLI that cannot tell confirms nothing.
    if (!result.error && !result.timedOut && (await this._isServed(number)) === false) return { ok: true };
    return { ok: false, error: describeFailure(result, CLI_TIMEOUT_MS) };
  }

  /**
   * Whether the port is published to our own `http://127.0.0.1:<port>`. False when the CLI cannot say.
   * @param {number} port
   * @returns {Promise<{ configured: boolean }>}
   */
  async serveStatus(port) {
    const number = parsePort(port);
    if (number === null) return { configured: false };
    return { configured: (await this._isServed(number)) === true };
  }

  /**
   * Opens the Tailscale app (macOS; elsewhere it does nothing). Rejects with the reason when it
   * cannot be opened.
   * @returns {Promise<void>}
   */
  async openApp() {
    if (this._platform !== 'darwin') return;
    const result = await this._run('open', ['-a', 'Tailscale'], { env: this._env, timeoutMs: CLI_TIMEOUT_MS });
    if (!succeeded(result)) throw new Error(describeFailure(result, CLI_TIMEOUT_MS));
  }

  /** @returns {Promise<Status>} */
  async _readStatus() {
    const result = await this._exec(['status', '--json'], CLI_TIMEOUT_MS);
    if (/** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === 'ENOENT') {
      return { installed: false, running: false, httpsEnabled: false };
    }
    if (!succeeded(result)) return { installed: true, running: false, error: describeFailure(result, CLI_TIMEOUT_MS) };
    try {
      return parseStatus(JSON.parse(result.stdout));
    } catch {
      return { installed: true, running: false, error: 'Tailscale printed something that is not JSON' };
    }
  }

  /**
   * @param {number} port
   * @returns {Promise<boolean | null>} null when the CLI could not tell
   */
  async _isServed(port) {
    const result = await this._exec(['serve', 'status', '--json'], CLI_TIMEOUT_MS);
    if (!succeeded(result)) return null;
    try {
      return parseServeStatus(JSON.parse(result.stdout), port);
    } catch {
      return null;
    }
  }

  /**
   * Runs the CLI with the given arguments. Never rejects; with no CLI the result is an ENOENT error.
   * @param {string[]} args
   * @param {number} timeoutMs
   * @param {RunOptions['until']} [until]
   * @returns {Promise<RunResult>}
   */
  async _exec(args, timeoutMs, until) {
    const cli = this._cli ?? findCli(this._env);
    if (!cli) return notFound();
    try {
      return await this._run(cli, args, { env: this._env, timeoutMs, until });
    } catch (error) {
      return { code: null, signal: null, stdout: '', stderr: '', timedOut: false, stopped: false, error: asError(error) };
    }
  }

  /** Forgets the cached status and lets no read that is already running refill the cache. */
  _invalidate() {
    this._epoch += 1;
    this._cache = null;
    this._pending = null;
  }
}

module.exports = { Tailscale, findCli, parseStatus, parseServeStatus, findConsentUrl, runCli };
