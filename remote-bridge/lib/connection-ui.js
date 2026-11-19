// @ts-check
'use strict';
// The Connection tab's requests (`cce_remote_*`), which the window agent hands over from the
// webview's processRequest. Each answer is `{type: request.type + "_response", ...}`; all but
// `copy` and `open_tailscale` carry a fresh `status` (the coordinator's ConnectionStatus), also
// when the action failed, so the tab always shows where things stand. A failure is `error`: the
// code `bad_url` as the tab knows it, otherwise a sentence the tab can show as it is.

const TAILSCALE_DOWNLOAD_URL = 'https://tailscale.com/download';
const MAX_COPY_CHARS = 64 * 1024;

/** What a failure code means, in words for the tab. `bad_url` stays a code: the tab words it itself. */
const MESSAGES = {
  not_connected: "This window isn't connected to the VS Code window that serves the phone yet. Try again in a moment.",
  timeout: "The VS Code window that serves the phone didn't answer in time. Try again.",
  closed: 'The VS Code window that served the phone went away. Another window takes over in a moment; try again then.',
  no_handler: "The VS Code window that serves the phone can't do that. Reload the windows after patching.",
  unknown_method: "The VS Code window that serves the phone can't do that. Reload the windows after patching.",
  bad_device: "That phone isn't paired.",
  bad_pairing: "The pairing code couldn't be made. Try again.",
};

/** @param {unknown} value @returns {value is Record<string, any>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error as the tab shows it. @param {unknown} error */
function describe(error) {
  const message = error instanceof Error ? error.message : String(error);
  return Object.prototype.hasOwnProperty.call(MESSAGES, message) ? MESSAGES[/** @type {keyof typeof MESSAGES} */ (message)] : message;
}

/**
 * Runs an action, then answers with a fresh status: the one the action resolved with when it gives
 * one (connect, disconnect), else the coordinator's.
 * @param {any} coordinator
 * @param {string} type
 * @param {() => Promise<unknown>} action
 * @param {boolean} [givesStatus]
 */
async function withStatus(coordinator, type, action, givesStatus = false) {
  /** @type {string | undefined} */
  let error;
  /** @type {unknown} */
  let status;
  try {
    const value = await action();
    if (givesStatus && isRecord(value)) status = value;
  } catch (failure) {
    error = describe(failure);
  }
  if (status === undefined) status = await coordinator.status();
  return error === undefined ? { type, status } : { type, status, error };
}

/**
 * Answers one Connection-tab request.
 * @param {any} coordinator  a Coordinator (coordinator.js)
 * @param {any} request  the webview's request: `{type, ...}`
 * @param {{ openExternal?: (url: string) => unknown, copy?: (text: string) => unknown }} [deps]
 *   openExternal opens a URL in the browser; copy puts text on the clipboard
 * @returns {Promise<object>}
 */
async function handleConnectionRequest(coordinator, request, { openExternal, copy } = {}) {
  const kind = isRecord(request) && typeof request.type === 'string' ? request.type : '';
  const type = `${kind || 'cce_remote_unknown'}_response`;
  switch (kind) {
    case 'cce_remote_status':
      return { type, status: await coordinator.status() };
    case 'cce_remote_connect':
      return withStatus(coordinator, type, () => coordinator.connect(), true);
    case 'cce_remote_disconnect':
      return withStatus(coordinator, type, () => coordinator.disconnect(), true);
    case 'cce_remote_new_code':
      return withStatus(coordinator, type, () => coordinator.newPairingCode());
    case 'cce_remote_remove_device': {
      const id = request.id;
      if (typeof id !== 'string' || id === '') return { type, status: await coordinator.status(), error: MESSAGES.bad_device };
      return withStatus(coordinator, type, () => coordinator.removeDevice(id));
    }
    case 'cce_remote_set_app_url': {
      const url = request.url;
      if (typeof url !== 'string') return { type, status: await coordinator.status(), error: 'bad_url' };
      return withStatus(coordinator, type, () => coordinator.setAppUrl(url));
    }
    case 'cce_remote_open_tailscale':
      try {
        await coordinator.openTailscale();
        return { type };
      } catch (failure) {
        // `open -a Tailscale` fails when the app is not there: the next step is to get it.
        if (typeof openExternal === 'function') {
          try {
            await openExternal(TAILSCALE_DOWNLOAD_URL);
            return { type };
          } catch {
            // no browser either: say why the app did not open
          }
        }
        return { type, error: `Couldn't open Tailscale: ${describe(failure)}` };
      }
    case 'cce_remote_copy': {
      const text = request.text;
      if (typeof text !== 'string' || text === '' || text.length > MAX_COPY_CHARS) return { type, error: 'Nothing to copy.' };
      if (typeof copy !== 'function') return { type, error: "The clipboard isn't available." };
      try {
        await copy(text);
        return { type };
      } catch (failure) {
        return { type, error: `Couldn't copy: ${describe(failure)}` };
      }
    }
    default:
      return { type, error: 'unknown_request' };
  }
}

module.exports = { handleConnectionRequest };
