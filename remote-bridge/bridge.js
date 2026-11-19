// @ts-check
'use strict';
// The phone remote bridge's entry point. patch.ts copies remote-bridge/ into the Claude Code
// extension as `cce-remote/` and hooks the webview provider's `allComms` field initializer:
//
//   allComms=(function(p){try{require("./cce-remote/bridge.js").attach(p)}catch(e){…}})(this)||new Set
//
// so attach() runs at the start of the provider's construction, before `allComms`, `output` or
// `context` exist. It only remembers the provider and does the rest on the next turn of the event
// loop (setImmediate), when the constructor is done:
//   - a WindowAgent for the provider (window-agent.js), which instruments every comms of the window
//     and the ones that come later (it wraps `allComms.add`/`delete` itself), and sends the
//     Connection tab's `cce_remote_*` requests to connection-ui.js;
//   - one Coordinator per extension host (coordinator.js), which turns remote access on and off and
//     makes this window the hub or a peer of the hub.
// The bridge stops when the window closes: inside the provider's shutdownAll(), which the extension's
// deactivate() awaits (for at most 5 s), with a budget of 2 s of its own; and when the extension's
// subscriptions are disposed, which nobody awaits. The log is the provider's output channel, every
// line prefixed `[cce-remote] `. Nothing written to it holds a token, a pairing code, the secret or
// session content.

const os = require('os');
const { WindowAgent } = require('./lib/window-agent.js');
const { Coordinator } = require('./lib/coordinator.js');
const { Tailscale } = require('./lib/tailscale.js');
const { handleConnectionRequest } = require('./lib/connection-ui.js');

const VERSION = '1.0.0';
const PREFIX = '[cce-remote] ';
// How long the extension's shutdown waits for the bridge to stop (the last window's serve-off).
const SHUTDOWN_BUDGET_MS = 2000;

/**
 * @typedef {InstanceType<typeof import('./lib/window-agent.js').WindowAgent>} Agent
 * @typedef {InstanceType<typeof import('./lib/coordinator.js').Coordinator>} Coord
 * @typedef {{ provider: object, env: object, agent: Agent | null, coordinator: Coord | null, detached: boolean }} Bridge
 * @typedef {{ coordinator: Coord, providers: Set<object> }} Shared
 * @typedef {((line: string) => void) & { warn: (line: string) => void, error: (line: string) => void }} Log
 */

/** @type {WeakMap<object, Bridge>} one bridge per provider */
const bridges = new WeakMap();
/** @type {WeakMap<object, Shared>} one coordinator per extension host, that is per environment object */
const shared = new WeakMap();

/** @param {unknown} error */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The provider's output channel (a LogOutputChannel), read at each call: it is set only once the
 * constructor has run. Lines without an output channel are dropped.
 * @param {any} provider
 * @returns {Log}
 */
function makeLog(provider) {
  /** @param {'info' | 'warn' | 'error'} level @param {string} line */
  const write = (level, line) => {
    try {
      const output = provider.output;
      const method = output && output[level];
      if (typeof method === 'function') method.call(output, PREFIX + String(line));
    } catch {
      // the log is best effort
    }
  };
  const log = /** @type {Log} */ ((/** @type {string} */ line) => write('info', line));
  log.warn = (line) => write('warn', line);
  log.error = (line) => write('error', line);
  return log;
}

/** This machine's host name without `.local`: the Mac's name while Tailscale does not know it. */
function localName() {
  try {
    return os.hostname().replace(/\.local\.?$/i, '') || 'Mac';
  } catch {
    return 'Mac';
  }
}

/**
 * Starts the bridge for the provider (the webview provider of one VS Code window). Idempotent per
 * provider; never throws; returns nothing (the hook's `||new Set` must still make the field).
 * @param {any} provider
 * @param {{ vscode?: any, env?: Record<string, string | undefined> }} [options]
 *   vscode: the `vscode` module (required from the extension host when not given); env: the
 *   environment (CCE_REMOTE_HOME, CCE_REMOTE_PORT, CCE_REMOTE_TAILSCALE)
 * @returns {undefined}
 */
function attach(provider, options = {}) {
  try {
    if ((typeof provider !== 'object' && typeof provider !== 'function') || provider === null || bridges.has(provider)) return undefined;
    const env = (options && options.env) || process.env;
    /** @type {Bridge} */
    const bridge = { provider, env, agent: null, coordinator: null, detached: false };
    bridges.set(provider, bridge);
    const vscode = options ? options.vscode : undefined;
    setImmediate(() => start(bridge, vscode));
  } catch (error) {
    try {
      console.error('[cce-remote]', errorText(error));
    } catch {
      // nothing left to tell
    }
  }
  return undefined;
}

/**
 * The deferred part of attach(): the constructor is done.
 * @param {Bridge} bridge
 * @param {any} vscodeOption
 */
function start(bridge, vscodeOption) {
  if (bridge.detached) return;
  const provider = /** @type {any} */ (bridge.provider);
  const log = makeLog(provider);
  try {
    // @ts-ignore -- the vscode module exists only inside the extension host
    const vscode = vscodeOption !== undefined ? vscodeOption : require('vscode');
    const agent = new WindowAgent({ provider, vscode, log });
    bridge.agent = agent;
    const entry = sharedFor(bridge, agent, log);
    bridge.coordinator = entry.coordinator;
    const deps = {
      openExternal: (/** @type {string} */ url) => vscode.env.openExternal(vscode.Uri.parse(url)),
      copy: (/** @type {string} */ text) => vscode.env.clipboard.writeText(text),
    };
    agent.onCceRequest = (comms, request) => handleConnectionRequest(entry.coordinator, request, deps);
    agent.start();
    entry.coordinator.start();
    onShutdown(provider, () => detach(provider));
    onDispose(provider, () => detach(provider));
    log(`bridge ${VERSION} attached`);
  } catch (error) {
    log.error(`the bridge could not start: ${errorText(error)}`);
  }
}

/**
 * The extension host's coordinator: made by the first provider, shared by any other (there should
 * be none; one with its own agent still gets the Connection tab, but only the first agent's window
 * reaches the phone).
 * @param {Bridge} bridge
 * @param {Agent} agent
 * @param {Log} log
 * @returns {Shared}
 */
function sharedFor(bridge, agent, log) {
  let entry = shared.get(bridge.env);
  if (!entry) {
    const env = /** @type {Record<string, string | undefined>} */ (bridge.env);
    const tailscale = new Tailscale({ env: /** @type {NodeJS.ProcessEnv} */ (env) });
    const coordinator = new Coordinator({ agent, tailscale, env, log, macName: localName });
    entry = { coordinator, providers: new Set() };
    shared.set(bridge.env, entry);
  } else {
    agent.setEnabled(false); // its window never reaches the phone: nothing to mirror
  }
  entry.providers.add(bridge.provider);
  return entry;
}

/**
 * Runs `fn` inside the provider's shutdownAll(), next to the extension's own shutdown, for at most
 * SHUTDOWN_BUDGET_MS: the extension's deactivate() awaits shutdownAll(), and the extension host may
 * end right after it. What shutdownAll() resolves with, or rejects with, stays the extension's. A
 * provider without shutdownAll (an older extension) is left as it is: its subscriptions stop the
 * bridge.
 * @param {any} provider
 * @param {() => unknown} fn
 */
function onShutdown(provider, fn) {
  try {
    const original = provider.shutdownAll;
    if (typeof original !== 'function') return;
    provider.shutdownAll = function cceRemoteShutdownAll(/** @type {unknown[]} */ ...args) {
      const ours = withinBudget(fn, SHUTDOWN_BUDGET_MS);
      /** @type {unknown} */
      let theirs;
      try {
        theirs = original.apply(this, args);
      } catch (error) {
        theirs = Promise.reject(error);
      }
      return Promise.all([ours, theirs]).then(([, value]) => value);
    };
  } catch {
    // a provider that cannot be changed: its subscriptions stop the bridge
  }
}

/**
 * Runs `fn` and resolves when it is done or after `ms`, whichever comes first; never rejects.
 * @param {() => unknown} fn
 * @param {number} ms
 * @returns {Promise<void>}
 */
function withinBudget(fn, ms) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const work = Promise.resolve()
    .then(fn)
    .catch(() => {});
  const late = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
    timer.unref();
  });
  return Promise.race([work, late]).then(() => clearTimeout(timer));
}

/**
 * Runs `fn` when the extension is deactivated: `provider.context.subscriptions` is disposed then.
 * @param {any} provider
 * @param {() => unknown} fn
 */
function onDispose(provider, fn) {
  try {
    const subscriptions = provider.context && provider.context.subscriptions;
    if (subscriptions && typeof subscriptions.push === 'function') subscriptions.push({ dispose: fn });
  } catch {
    // no context: the bridge lives as long as the extension host
  }
}

/**
 * Stops the provider's bridge: its agent no longer answers the Connection tab, and the coordinator
 * stops when no provider uses it any more (the hub closes; the other windows take over). The
 * agent's instrumentation stays (the comms are not unwrapped), so a detached provider is not
 * attached again.
 * @param {any} provider
 * @returns {Promise<void>}
 */
async function detach(provider) {
  const bridge = bridges.get(provider);
  if (!bridge || bridge.detached) return;
  bridge.detached = true;
  const agent = bridge.agent;
  if (agent) {
    agent.onCceRequest = null;
    try {
      agent.setActive(false);
    } catch {
      // nothing to stop
    }
  }
  const entry = shared.get(bridge.env);
  if (!entry || !entry.providers.has(provider)) return;
  entry.providers.delete(provider);
  if (entry.providers.size > 0) return;
  shared.delete(bridge.env);
  await entry.coordinator.stop();
}

/**
 * What attach() made for the provider: `{agent, coordinator}` (null until the next turn), or
 * undefined. For tests and diagnostics.
 * @param {any} provider
 */
function bridgeOf(provider) {
  const bridge = provider !== null && (typeof provider === 'object' || typeof provider === 'function') ? bridges.get(provider) : undefined;
  return bridge ? { agent: bridge.agent, coordinator: bridge.coordinator, detached: bridge.detached } : undefined;
}

module.exports = { VERSION, attach, detach, bridgeOf };
