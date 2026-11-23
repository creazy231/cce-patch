// @ts-check
'use strict';
// The window agent: one per VS Code window. It mirrors every Claude Code session of the window for the
// phone and carries out what the phone asks, through the extension's webview "comms" objects (one per
// Claude webview: the sidebar, each editor tab, the Session Manager view):
//
//   comms.send(msg)              host -> webview: SDK messages, prompts and their withdrawal, closed channels
//   comms.fromClient(msg)        webview -> host: VS Code answering a prompt, closing a channel; a
//                                `cce_remote_*` request (the Connection tab) is answered here by onCceRequest,
//                                ahead of the host's ordered queue (which waits for every launch)
//   comms.processRequest(e, s)   a webview request: `cce_remote_*` that gets this far goes to onCceRequest too
//
// Each is wrapped on the instance (the class stays as it is). A wrapper observes, then calls the original
// with the comms as `this`. Whatever goes wrong in the agent is caught and logged, and the message goes on
// as if the agent were not there. Two kinds of message are held back on purpose: the host's response to a
// request the agent injected (`cce-remote-` ids; the webview does not know them), and, for 60 s, VS Code's
// late answer to a prompt the phone answered.
//
// The phone's actions are injected through the ORIGINAL methods, so the agent never takes its own
// messages for webview traffic. The payloads are the webview's own (answers.js builds the answers), so
// neither the host nor the CLI can tell the phone from VS Code; a prompt is marked typed by a person
// (`origin: {kind: 'human'}`) as the webview marks it. commands() lists the window's slash commands, the
// Claude Code ones VS Code's `/` menu shows, from what the extension already holds, never by asking it to
// load anything.
//
// Events:
//   'project' (project)        the window's project, whenever refreshProject() finds it changed
//   'session' (sessionId, ev)  ev = {t:'msg', message} | {t:'stream', event} | {t:'pending', pending}
//   'attention' (ev)           the moments a notification is for, whether or not a phone is connected:
//                              ev = {kind:'waiting', session, requestId, title, prompt:{kind, toolName, text}}
//                                     (a prompt appeared: once per request id)
//                                 | {kind:'open', session, requestIds}
//                                     (the session's live prompts, every time they may have changed)
//                                 | {kind:'done', session, title, isError, durationMs, text}
//                                     (the session is done: its last turn ended and nothing runs on in the
//                                     background, is queued or waits; said once, with that turn's result)
//   'usage' (reading)          Claude Code's usage meter changed: {supported, fiveHour?, week?, at?, account?}
//                              (see UsageReading; refreshUsage() reads it afresh through a Claude process)
//
// Every window of every patched editor runs an agent, so while remote access is off (the coordinator
// says so: setEnabled) it maps, keeps and emits no session messages at all; it only follows the few
// small things a phone needs the moment remote access is turned on (prompts, turns, background tasks,
// which channel holds which session), and answers the Connection tab.
//
// With the Connection tab's "Claude in Chrome" switch on (`chromeAutoAccept`, which bridge.js points at
// the coordinator), the agent also answers Claude in Chrome's routine permission prompts itself, as VS
// Code's "Allow" would, whether remote access is on or off: VS Code never shows them. Those that Claude
// Code marks for a person still reach VS Code and the phone (_autoAcceptChrome).
//
// State is kept in memory only, and bounded: AGENT_LIMITS.

const crypto = require('crypto');
const path = require('path');
const { EventEmitter } = require('events');
const { LIMITS, CAPS, toPhoneMessage, toStreamEvent, mergeHistory } = require('./transcript.js');
const { toSlashCommands } = require('./commands.js');
const { classifyPending, buildAnswer } = require('./answers.js');

/** @typedef {import('./answers.js').Pending} Pending */
/** @typedef {'waiting' | 'running' | 'unread' | 'idle'} SessionState */
/**
 * @typedef {{ id: string, title: string, lastModified: number, state: SessionState, live: boolean,
 *   gitBranch?: string, worktree?: string, pendingCount: number }} SessionSummary
 */
/**
 * One window as the phone sees it. `claudeOpen` is false when the window has no Claude webview.
 * @typedef {{ id: string, name: string, folders: string[], editor: string, claudeOpen: boolean,
 *   sessions: SessionSummary[] }} Project
 */
/**
 * @typedef {{ t: 'msg', message: import('./transcript.js').PhoneMessage }
 *   | { t: 'stream', event: import('./transcript.js').StreamEvent }
 *   | { t: 'pending', pending: Pending[] }} SessionEvent
 */
/**
 * A prompt the host is waiting on. `pending` is the full prompt (its input is answered back as it
 * came), `phone` the copy the phone gets. `sessionId` is the session of the channel when it asked.
 * @typedef {{ pending: Pending, phone: Pending, comms: any, channelId: string, sessionId: string | undefined,
 *   answering: boolean }} PendingEntry
 */
/** @typedef {{ comms: any, channelId: string, channel: any, key: string }} ChannelRef */
/**
 * What the `attention` event carries. `title` is the session's, as project() shows it; `text` is one short line
 * (a prompt's key argument, a result's start), '' when there is none.
 * @typedef {{ kind: 'waiting', session: string, requestId: string, title: string,
 *   prompt: { kind: Pending['kind'], toolName: string, text: string } }
 *   | { kind: 'open', session: string, requestIds: string[] }
 *   | { kind: 'done', session: string, title: string, isError: boolean, durationMs: number, text: string }} AttentionEvent
 */
/**
 * A session of buildSessionList(), cut down to what a project shows.
 * @typedef {{ id: string, archived: boolean, at: number, customTitle?: string, summary?: string,
 *   gitBranch?: string, worktree?: string }} ListEntry
 */
/**
 * One limit of Claude Code's usage meter: `utilization` is a fraction (0.42 is 42 %), `resetsAt` epoch seconds.
 * @typedef {{ utilization: number, resetsAt?: number }} UsageWindow
 */
/**
 * The window's usage meter as the phone needs it: `supported` when the extension has the meter (its
 * `panelUsageRelay`), the 5-hour and weekly limits when it has numbers, and `at` (epoch ms) when the agent
 * saw those numbers arrive; no `at` for numbers that were there when the agent started. `account`: the email
 * of the Claude account Claude Code is signed in to, whose limits these are, when it knows one.
 * @typedef {{ supported: boolean, fiveHour?: UsageWindow, week?: UsageWindow, at?: number, account?: string }} UsageReading
 */
/**
 * The numbers part of a reading, kept from the last time the relay's `merged` changed.
 * @typedef {{ fiveHour?: UsageWindow, week?: UsageWindow, at?: number }} UsageNumbers
 */

const INJECTED_ID_PREFIX = 'cce-remote-';
/** The usage relay's `merged` before the agent first looked at it. */
const UNSEEN = Symbol('unseen');
const CCE_REQUEST_PREFIX = 'cce_remote_';
// Claude in Chrome's tools (the MCP server Claude Code adds for it), and the rule that allows it a site.
const CHROME_TOOL_PREFIX = 'mcp__claude-in-chrome__';
const CHROME_SITE_RULE = 'ClaudeInChromeDomain';
const OPEN_EDITOR = 'claude-vscode.editor.open';
// editor.open's options (its sixth argument): an open a program asks for, as VS Code's own session list does.
// Without them the extension takes the open for the user's choice and saves "panel" as their preferred location
// (and claude-vscode.sidebar.open saves "sidebar"), so the phone never opens Claude Code any other way.
/** Always an editor tab: where the phone's prompt can go. */
const PIN_TO_PANEL = Object.freeze({ programmatic: 'pin-to-panel' });
/** Where the user keeps Claude Code: an editor tab, or the sidebar. */
const HONOR_LOCATION = Object.freeze({ programmatic: 'honor-preferred-location' });

const AGENT_LIMITS = Object.freeze({
  liveMessages: 500, // live (non-stream) messages kept per session, for snapshots
  liveSessions: 20, // sessions with a live buffer; the one active longest ago loses it first
  answeredMs: 60_000, // how long VS Code's late answer to a prompt the phone answered is dropped
  pollMs: 250, // how often a wait looks again (it also looks after every message)
  modeWaitMs: 5_000, // how long an answer waits for its permission mode to be applied
  sessions: 200, // sessions in a project
  title: 200, // characters of a session title
  attentionText: 140, // characters of the text an attention event carries
  announced: 1000, // request ids remembered as announced (the attention event `waiting`): a request the host delivers twice is news once
  text: 100_000, // characters of a message from the phone
  images: 4, // images in a message from the phone
  imageChars: 5 * 1024 * 1024, // base64 characters of one image
  hostReadMs: 10_000, // how long a transcript or session list read of the host may take
  usageReadMs: 15_000, // how long refreshUsage() waits for a usage read through a Claude process
});

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
// What the live buffer keeps of a string: what transcript.js can show of it (its LIMITS or CAPS) and a margin
// past its cut marker, so a kept message maps exactly like the original.
const KEEP_MARGIN = 64;
const KEEP = Object.freeze({
  text: LIMITS.text + KEEP_MARGIN,
  thinking: LIMITS.thinking + KEEP_MARGIN,
  toolResult: LIMITS.toolResult + KEEP_MARGIN,
  input: LIMITS.inputString + KEEP_MARGIN,
  identifier: CAPS.identifier + KEEP_MARGIN,
});
// The fields of an SDK message that toPhoneMessage reads (and `session_id`), the ones the live buffer keeps.
const KEPT_FIELDS = ['type', 'subtype', 'uuid', 'session_id', 'timestamp', 'parent_tool_use_id', 'isReplay', 'isMeta', 'is_error', 'duration_ms', 'total_cost_usd', 'num_turns'];
// Tool inputs nest a few levels; past this a value is kept as it is.
const SLIM_DEPTH = 32;
// Failures inside the agent that are written to the log; the rest are only counted.
const LOGGED_FAILURES = 20;

// ---- helpers -----------------------------------------------------------------------------------------

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is string} a string with something in it */
function isText(value) {
  return typeof value === 'string' && value !== '';
}

/** An Error whose `code` is its message: what a caller tells apart (not_pending, timeout, ...). @param {string} code */
function codeError(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * The arguments of claude-vscode.editor.open: (sessionId, initialPrompt, viewColumn, groupId, fullEditor, options).
 * @param {string | undefined} sessionId  undefined: a new session
 * @param {Readonly<{ programmatic: string }>} options
 */
function editorArgs(sessionId, options) {
  return [sessionId, undefined, undefined, undefined, undefined, options];
}

/** @param {unknown} error */
function errorText(error) {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return 'unprintable error';
  }
}

/**
 * One of Claude in Chrome's tools: `mcp__claude-in-chrome__<tool>`, where the tool's name has no `__` (a server
 * named `claude-in-chrome__x` would otherwise pass for it).
 * @param {unknown} name
 */
function isChromeTool(name) {
  if (!isText(name) || !name.startsWith(CHROME_TOOL_PREFIX)) return false;
  const tool = name.slice(CHROME_TOOL_PREFIX.length);
  return tool !== '' && !tool.includes('__');
}

/**
 * Whether the prompt carries a sign that Claude Code wants a person to answer it: `defaultToNo` (the auto-mode
 * safety check blocked the action or had no verdict, or another safety check asks), the words of a safety check
 * (`reason`), a hook that asked (`hookReason`), or `personOnly`, should a host ever pass it on.
 * @param {Record<string, any>} request
 */
function wantsPerson(request) {
  return request.defaultToNo === true || request.personOnly === true || isText(request.reason) || isText(request.hookReason);
}

/** @param {unknown} rule  one rule of an `addRules` suggestion: a site, never every site */
function isSiteRule(rule) {
  return isRecord(rule) && rule.toolName === CHROME_SITE_RULE && isText(rule.ruleContent);
}

/**
 * Whether the "always" of a Claude in Chrome prompt does nothing but allow sites for this session: VS Code
 * offers it, and every suggestion adds allow rules for the session, each for one site. That is the site card's
 * "always allow this site". A rule for a whole tool would outlast the switch, so it never counts.
 * @param {import('./answers.js').Pending} pending
 */
function onlySitesForSession(pending) {
  if (!pending.canAlwaysAllow || pending.suggestions.length === 0) return false;
  return pending.suggestions.every(
    (suggestion) =>
      isRecord(suggestion) &&
      suggestion.type === 'addRules' &&
      suggestion.behavior === 'allow' &&
      suggestion.destination === 'session' &&
      Array.isArray(suggestion.rules) &&
      suggestion.rules.length > 0 &&
      suggestion.rules.every(isSiteRule),
  );
}

/** The site a suggestion allows, for the log. @param {any[]} suggestions */
function chromeSiteOf(suggestions) {
  for (const suggestion of suggestions) {
    const rule = isRecord(suggestion) && Array.isArray(suggestion.rules) ? suggestion.rules.find((r) => isRecord(r) && r.toolName === CHROME_SITE_RULE) : undefined;
    if (rule && isText(rule.ruleContent)) return rule.ruleContent.slice(0, 200);
  }
  return undefined;
}

/**
 * The value `read` gets, or `fallback` when it throws or gets undefined: the extension's objects are
 * read this way, since a newer or older extension may lack a member.
 * @template T
 * @param {() => T} read
 * @param {T} [fallback]
 * @returns {T | undefined}
 */
function guard(read, fallback) {
  try {
    const value = read();
    return value === undefined ? fallback : value;
  } catch {
    return fallback;
  }
}

/** A Map's entries as an array, or none when it is not a Map. @param {any} map @returns {Array<[any, any]>} */
function entriesOf(map) {
  try {
    return map && typeof map.entries === 'function' ? Array.from(map.entries()) : [];
  } catch {
    return [];
  }
}

/** @param {any} map @param {unknown} key */
function getFrom(map, key) {
  try {
    return map && typeof map.get === 'function' ? map.get(key) : undefined;
  } catch {
    return undefined;
  }
}

/** @template {NodeJS.Timeout} T @param {T} timer @returns {T} */
function unref(timer) {
  if (timer && typeof timer.unref === 'function') timer.unref();
  return timer;
}

/**
 * One limit of the usage relay's numbers, as a reading keeps it: undefined unless `utilization` is a finite
 * number; `resetsAt` only when it is one too.
 * @param {unknown} window
 * @returns {UsageWindow | undefined}
 */
function usageWindow(window) {
  if (!isRecord(window) || typeof window.utilization !== 'number' || !Number.isFinite(window.utilization)) return undefined;
  /** @type {UsageWindow} */
  const out = { utilization: window.utilization };
  if (typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt)) out.resetsAt = window.resetsAt;
  return out;
}

/** @param {UsageReading} reading @returns {UsageReading} a copy nobody else holds */
function copyReading(reading) {
  return {
    ...reading,
    ...(reading.fiveHour && { fiveHour: { ...reading.fiveHour } }),
    ...(reading.week && { week: { ...reading.week } }),
  };
}

/**
 * Text on one line: whitespace runs become one space, and past `max` characters (a session title's, by default)
 * it is cut (never inside a surrogate pair) and ends in an ellipsis. Undefined for no text.
 * @param {unknown} value
 * @param {number} [max]
 */
function oneLine(value, max = AGENT_LIMITS.title) {
  if (typeof value !== 'string') return undefined;
  const line = value.slice(0, max * 4).replace(/\s+/g, ' ').trim();
  if (line === '') return undefined;
  if (line.length <= max) return line;
  let end = max;
  const last = line.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return line.slice(0, end).trimEnd() + '…';
}

/** @param {string} editor @param {string[]} folders */
function projectIdOf(editor, folders) {
  return crypto.createHash('sha1').update(`${editor}\n${folders.join('\n')}`).digest('hex').slice(0, 12);
}

/**
 * Sets a key on a copy as data: a `__proto__` key stays a key.
 * @param {Record<string, any>} target @param {string} key @param {unknown} value
 */
function setData(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * The first `max` characters of a string, in memory of their own. A slice is a view that keeps the whole
 * original alive (V8 and JSC both slice long strings that way), so the cut is copied, as UTF-16 code units
 * so that a lone surrogate survives. Anything else is returned as it is.
 * @template T
 * @param {T} value
 * @param {number} max
 * @returns {T}
 */
function keptString(value, max) {
  if (typeof value !== 'string' || value.length <= max) return value;
  return /** @type {T} */ (Buffer.from(value.slice(0, max), 'utf16le').toString('utf16le'));
}

/** A tool input with every string cut to KEEP.input; its shape stays as it is. @param {unknown} value @param {number} depth @returns {any} */
function slimInput(value, depth) {
  if (typeof value === 'string') return keptString(value, KEEP.input);
  if (typeof value !== 'object' || value === null || depth >= SLIM_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => slimInput(item, depth + 1));
  /** @type {Record<string, any>} */
  const out = {};
  for (const [key, item] of Object.entries(value)) setData(out, key, slimInput(item, depth + 1));
  return out;
}

/**
 * A tool result's content, as far as the phone can see it: a string cut to KEEP.toolResult; of an array, the
 * text parts (each cut so) and the images (without their data), until the text so far is longer than the phone
 * is shown. The parts transcript.js skips are left out.
 * @param {unknown} content
 */
function slimResultContent(content) {
  if (!Array.isArray(content)) return keptString(content, KEEP.toolResult);
  const parts = [];
  let shown = 0; // the characters of text kept so far: at most what the phone's flattened text has
  for (const part of content) {
    if (shown >= KEEP.toolResult) break;
    if (!isRecord(part)) continue;
    if (part.type === 'text') {
      const text = keptString(part.text, KEEP.toolResult);
      parts.push({ type: 'text', text });
      if (typeof text === 'string') shown += text.length;
    } else if (part.type === 'image') {
      parts.push({ type: 'image' });
    }
  }
  return parts;
}

/** A content block with the fields transcript.js reads, cut to what it shows. @param {unknown} block */
function slimBlock(block) {
  if (!isRecord(block)) return null; // skipped by the mapping too
  switch (block.type) {
    case 'text':
      return { type: 'text', text: keptString(block.text, KEEP.text) };
    case 'thinking':
      return { type: 'thinking', thinking: keptString(block.thinking, KEEP.thinking) };
    case 'tool_use':
      return { type: 'tool_use', id: keptString(block.id, KEEP.identifier), name: keptString(block.name, KEEP.identifier), input: slimInput(block.input, 0) };
    case 'tool_result':
      return { type: 'tool_result', tool_use_id: keptString(block.tool_use_id, KEEP.identifier), is_error: block.is_error, content: slimResultContent(block.content) };
    case 'image':
      return { type: 'image' };
    case 'document':
      return { type: 'document', title: keptString(block.title, KEEP.identifier) };
    default:
      return { type: keptString(block.type, KEEP.identifier) }; // shows nothing
  }
}

/**
 * An SDK message as the live buffer keeps it: what toPhoneMessage reads of it, each string cut to what the
 * phone can be shown and copied, so the original is not kept alive. transcript.js maps the copy exactly like
 * the original (a test pins it); everything else is left out: a tool's structured result (`tool_use_result`,
 * a whole file for Read or Edit), a result's final text, usage, signatures, image and document data.
 * Keep in step with what transcript.js reads.
 * @param {Record<string, any>} sdk
 */
function slimMessage(sdk) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const key of KEPT_FIELDS) if (sdk[key] !== undefined) out[key] = keptString(sdk[key], KEEP.identifier);
  const message = sdk.message;
  if (isRecord(message)) {
    const content = message.content;
    out.message = {
      role: keptString(message.role, KEEP.identifier),
      content: Array.isArray(content) ? content.map(slimBlock) : keptString(content, KEEP.text),
    };
  }
  return out;
}

/**
 * A prompt's input as the phone gets it: every string cut as transcript.js cuts a tool's input (the
 * mapping itself does it, so the rule is the same). The agent keeps the full input to answer with.
 * @param {Record<string, any>} input
 * @returns {Record<string, any>}
 */
function trimmedInput(input) {
  const mapped = toPhoneMessage({ type: 'assistant', uuid: 'pending', message: { content: [{ type: 'tool_use', id: 'pending', name: 'pending', input }] } });
  const block = mapped && mapped.content && mapped.content[0];
  return block && block.type === 'tool_use' ? block.input : {};
}

/** The text an attention event carries: one line of at most AGENT_LIMITS.attentionText characters, '' for none. @param {unknown} value */
function attentionText(value) {
  return oneLine(value, AGENT_LIMITS.attentionText) ?? '';
}

/**
 * What a prompt is about, as one short line for a notification. A question: its first question. A tool: its key
 * argument (Bash the command; Edit, Write, Read, MultiEdit and NotebookEdit the file's base name; WebFetch the
 * URL; WebSearch the query; any other tool its first text field). A plan or a dialog has none. '' when the input
 * does not have it.
 * @param {Pending} pending
 */
function promptText(pending) {
  const input = pending.input;
  if (pending.kind === 'question') {
    const first = Array.isArray(input.questions) ? input.questions[0] : undefined;
    return attentionText(isRecord(first) ? first.question : undefined);
  }
  if (pending.kind !== 'tool') return '';
  switch (pending.toolName) {
    case 'Bash':
      return attentionText(input.command);
    case 'WebFetch':
      return attentionText(input.url);
    case 'WebSearch':
      return attentionText(input.query);
    case 'Edit':
    case 'Write':
    case 'Read':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = input.file_path ?? input.notebook_path;
      return attentionText(typeof file === 'string' ? path.basename(file) : undefined);
    }
    default:
      for (const value of Object.values(input)) {
        const line = attentionText(value);
        if (line !== '') return line;
      }
      return '';
  }
}

/** @param {unknown} entry @returns {ListEntry | undefined} */
function listEntry(entry) {
  if (!isRecord(entry) || !isText(entry.id)) return undefined;
  const at = [entry.lastActivity, entry.lastModified].find((n) => Number.isFinite(n));
  /** @type {ListEntry} */
  const out = { id: entry.id, archived: entry.archived === true, at: at ?? 0 };
  const customTitle = oneLine(entry.customTitle);
  if (customTitle) out.customTitle = customTitle;
  const summary = oneLine(entry.summary);
  if (summary) out.summary = summary;
  const gitBranch = oneLine(entry.gitBranch);
  if (gitBranch) out.gitBranch = gitBranch;
  const worktree = oneLine(isRecord(entry.worktree) ? entry.worktree.name : entry.worktree);
  if (worktree) out.worktree = worktree;
  return out;
}

/** @param {unknown} image */
function imageBlock(image) {
  const mediaType = isRecord(image) ? image.mediaType : undefined;
  const data = isRecord(image) ? image.data : undefined;
  if (
    typeof mediaType !== 'string' ||
    !IMAGE_TYPES.has(mediaType) ||
    typeof data !== 'string' ||
    data === '' ||
    data.length > AGENT_LIMITS.imageChars ||
    !BASE64.test(data)
  ) {
    throw codeError('bad_images');
  }
  return { type: 'image', source: { type: 'base64', media_type: mediaType, data } };
}

/**
 * The user message the webview builds for a prompt: images first, then the text (left out when there
 * is none, as the API refuses an empty text block).
 * @param {unknown} text
 * @param {unknown} images  `[{mediaType, data}]`, base64 without a `data:` prefix
 */
function userMessage(text, images) {
  const body = typeof text === 'string' ? text : '';
  if (body.length > AGENT_LIMITS.text) throw codeError('too_long');
  const list = images === undefined || images === null ? [] : images;
  if (!Array.isArray(list) || list.length > AGENT_LIMITS.images) throw codeError('bad_images');
  /** @type {Array<Record<string, any>>} */
  const content = list.map(imageBlock);
  if (body.trim() !== '') content.push({ type: 'text', text: body });
  if (content.length === 0) throw codeError('empty');
  return {
    type: 'user',
    uuid: crypto.randomUUID(),
    session_id: '',
    parent_tool_use_id: null,
    // Typed by a person, as the webview marks what the user types. Claude Code (2.1.330) runs a plugin's local slash
    // command only from a message marked so; everywhere else it takes an unmarked message for a person's too.
    origin: { kind: 'human' },
    message: { role: 'user', content },
  };
}

// ---- the agent -------------------------------------------------------------------------------------------

class WindowAgent extends EventEmitter {
  /**
   * @param {{ provider?: any, vscode?: any, log?: (line: string) => void, now?: () => number,
   *   channelWaitMs?: number, wakeWaitMs?: number, refreshEveryMs?: number, refreshDelayMs?: number, hostReadMs?: number,
   *   usageReadMs?: number }} [options]
   *   provider: the extension's webview provider (`allComms`, `sessionStates`, `unreadSessionKeys`,
   *   `liveElsewhereSessions`); vscode: the `vscode` module; log: one line of text per call (no
   *   secrets are ever in it); channelWaitMs: how long send() waits for a channel to open, and for a new
   *   session to be named; wakeWaitMs: how long it waits for one after opening a session that VS Code shows
   *   without a Claude Code process; refreshEveryMs / refreshDelayMs: while active, the project is refreshed this
   *   often, and this long after a change; hostReadMs: how long a transcript or session list read may take
   *   before the agent goes on without it; usageReadMs: how long refreshUsage() waits for its read.
   */
  constructor({
    provider,
    vscode,
    log = () => {},
    now = Date.now,
    channelWaitMs = 20_000,
    wakeWaitMs = 5_000,
    refreshEveryMs = 15_000,
    refreshDelayMs = 1_000,
    hostReadMs = AGENT_LIMITS.hostReadMs,
    usageReadMs = AGENT_LIMITS.usageReadMs,
  } = {}) {
    super();
    this.provider = provider;
    this.vscode = vscode;
    this.log = log;
    this.now = now;
    this.channelWaitMs = channelWaitMs;
    this.wakeWaitMs = wakeWaitMs;
    this.refreshEveryMs = refreshEveryMs;
    this.refreshDelayMs = refreshDelayMs;
    this.hostReadMs = hostReadMs;
    this.usageReadMs = usageReadMs;
    /** @type {Set<string>} host reads that took too long once already (each is logged once) */
    this._slowReads = new Set();
    /**
     * Answers the Connection tab's `cce_remote_*` requests; what it resolves with is the response.
     * @type {((comms: any, request: any) => Promise<object>) | null}
     */
    this.onCceRequest = null;
    /**
     * Whether Claude in Chrome's permission prompts are answered for the user (the Connection tab's switch):
     * read as each one comes, and only `true` counts. bridge.js points it at the coordinator.
     * @type {(() => unknown) | null}
     */
    this.chromeAutoAccept = null;

    /** @type {WeakMap<object, { send?: Function, fromClient?: Function, processRequest?: Function }>} the unwrapped methods */
    this._originals = new WeakMap();
    /** @type {WeakMap<object, Map<string, string>>} per comms: the session the last system/init on a channel named */
    this._channelInits = new WeakMap();
    /** @type {WeakMap<object, number>} */
    this._commsKeys = new WeakMap();
    this._lastCommsKey = 0;
    /** @type {Map<string, PendingEntry>} prompts by request id */
    this._pending = new Map();
    /** @type {Map<string, number>} request id -> until when VS Code's answer to it is dropped */
    this._answered = new Map();
    /** @type {Map<string, (response: unknown) => void>} the agent's own requests, waiting for the host's response */
    this._injected = new Map();
    /** @type {Map<string, Map<string, unknown>>} session -> its live messages (slimmed SDK messages) by uuid */
    this._live = new Map();
    this._liveKeys = 0;
    /** @type {Map<string, boolean>} sessions whose turn is open (system/init seen, no result yet) */
    this._turns = new Map();
    /** @type {WeakMap<object, Map<string, { running: number, agents: boolean }>>} per comms: per channel, what the CLI's last background_tasks_changed listed */
    this._tasks = new WeakMap();
    /** @type {Map<string, { isError: boolean, durationMs: number, text: string }>} sessions whose last turn ended before they were done: what their `done` says */
    this._owed = new Map();
    /** @type {Set<string>} the last AGENT_LIMITS.announced request ids that an attention event announced, oldest first */
    this._announced = new Set();
    /** @type {Map<string, number>} sessions shown as "New session": when they were first shown */
    this._firstSeen = new Map();
    /** @type {ListEntry[] | null} the last session list */
    this._listed = null;
    /** @type {unknown} the usage relay's `merged` the agent last looked at (UNSEEN before the first look) */
    this._usageRef = UNSEEN;
    /** @type {UsageNumbers} what `_usageRef` held, as the reading has it */
    this._usageNumbers = {};
    /** @type {UsageReading} */
    this._usage = { supported: false };
    /** @type {string | undefined} the reading as JSON, once there is one */
    this._usageJson = undefined;
    this._listSeq = 0;
    this._listApplied = 0;
    /** @type {string | undefined} the last project emitted, as JSON */
    this._projectJson = undefined;
    /** @type {Set<() => void>} waits in progress; each looks again after every message */
    this._waiters = new Set();
    /** @type {Map<string, { comms: any, channelId: string }>} new channels send(null) has taken */
    this._claimed = new Map();
    this._active = false;
    // Remote access is on (the coordinator says): only then are session messages mapped, kept and emitted.
    this._enabled = true;
    /** @type {NodeJS.Timeout | undefined} */
    this._refreshTimer = undefined;
    /** @type {NodeJS.Timeout | undefined} */
    this._delayTimer = undefined;
    this._started = false;
    /** @type {unknown} */
    this._folderSubscription = undefined;
    this._failures = 0;
  }

  // ---- instrumentation ---------------------------------------------------------------------------------

  /**
   * Instruments every comms of the window, and those that come later (`provider.allComms.add` is
   * wrapped on the instance; `delete` too, so a closed tab's prompts go with it), and follows the
   * workspace folders. Idempotent.
   */
  start() {
    if (this._started) return this;
    this._started = true;
    const set = this._commsSet();
    if (set) {
      for (const comms of this._commsList()) this.instrument(comms);
      this._wrapCommsSet(set);
    } else {
      this._say('window agent: the provider has no allComms, so there is nothing to mirror');
    }
    const workspace = guard(() => this.vscode.workspace);
    const subscribe = guard(() => workspace.onDidChangeWorkspaceFolders);
    if (typeof subscribe === 'function') {
      try {
        this._folderSubscription = subscribe.call(workspace, () => this._changed());
      } catch (error) {
        this._failed(error);
      }
    }
    // The first look at the usage meter: the bridge starts once the provider is built, so whatever changes
    // after this is an update the agent sees arrive.
    this._lookAtUsage();
    return this;
  }

  /**
   * Wraps the comms' `send`, `fromClient` and `processRequest` on the instance and marks it with
   * `__cceRemote`. Returns false when it was instrumented already (or is not a comms).
   * @param {any} comms
   */
  instrument(comms) {
    if (typeof comms !== 'object' || comms === null || comms.__cceRemote) return false;
    try {
      comms.__cceRemote = true; // first: whatever fails below, no method is ever wrapped twice
    } catch (error) {
      this._failed(error);
      return false;
    }
    const agent = this;
    /** @type {{ send?: Function, fromClient?: Function, processRequest?: Function }} */
    const originals = {};
    for (const name of /** @type {const} */ (['send', 'fromClient', 'processRequest'])) {
      const method = guard(() => comms[name]);
      if (typeof method === 'function') originals[name] = method;
    }
    this._originals.set(comms, originals);
    const { send, fromClient, processRequest } = originals;
    try {
      if (send) {
        comms.send = function cceRemoteSend(/** @type {any} */ message) {
          let swallow = false;
          try {
            swallow = agent._fromHost(comms, message);
            agent._notify();
          } catch (error) {
            agent._failed(error);
          }
          if (swallow) return undefined;
          return send.apply(comms, arguments);
        };
      }
      if (fromClient) {
        comms.fromClient = function cceRemoteFromClient(/** @type {any} */ message) {
          let drop = false;
          try {
            if (agent._answerCceRequest(comms, message, send)) return Promise.resolve();
            drop = agent._fromWebview(comms, message);
            agent._notify();
          } catch (error) {
            agent._failed(error);
          }
          if (drop) return Promise.resolve();
          return fromClient.apply(comms, arguments);
        };
      }
      if (processRequest) {
        comms.processRequest = function cceRemoteProcessRequest(/** @type {any} */ e) {
          let request;
          let type;
          try {
            request = isRecord(e) ? e.request : undefined;
            type = isRecord(request) ? request.type : undefined;
            if (type === 'update_session_state') agent._changed(); // a panel reported a title or a state
          } catch (error) {
            agent._failed(error);
          }
          if (typeof type === 'string' && type.startsWith(CCE_REQUEST_PREFIX)) return agent._cceRequest(comms, request);
          const result = processRequest.apply(comms, arguments);
          if (type === 'init') {
            // A webview that (re)loads: the host has just dropped the prompts it waited for; the phone is told now.
            try {
              agent._sweep();
            } catch (error) {
              agent._failed(error);
            }
          }
          return result;
        };
      }
    } catch (error) {
      this._failed(error);
    }
    return true;
  }

  /** @param {any} set */
  _wrapCommsSet(set) {
    const agent = this;
    const add = set.add;
    const remove = set.delete;
    try {
      if (typeof add === 'function') {
        set.add = function cceRemoteAdd(/** @type {any} */ comms) {
          const result = add.call(set, comms);
          try {
            agent.instrument(comms);
            agent._changed();
            agent._notify();
          } catch (error) {
            agent._failed(error);
          }
          return result;
        };
      }
      if (typeof remove === 'function') {
        set.delete = function cceRemoteDelete(/** @type {any} */ comms) {
          const result = remove.call(set, comms);
          try {
            if (result) {
              agent._sweep();
              agent._changed();
            }
          } catch (error) {
            agent._failed(error);
          }
          return result;
        };
      }
    } catch (error) {
      this._failed(error);
    }
  }

  /**
   * Answers a Connection-tab request (`cce_remote_*`) at once, through the comms' original `send`, as the
   * host's `handleRequest` would. The host reads webview messages one after another and waits for each
   * `launch_claude`, so a launch that waits (on the folder-trust dialog, say) would hold the tab's requests
   * up. True when it took the message (the host never sees it).
   * @param {any} comms
   * @param {unknown} message
   * @param {Function | undefined} send  the comms' original send
   */
  _answerCceRequest(comms, message, send) {
    if (typeof send !== 'function' || !isRecord(message) || message.type !== 'request') return false;
    const request = message.request;
    if (!isRecord(request) || typeof request.type !== 'string' || !request.type.startsWith(CCE_REQUEST_PREFIX)) return false;
    const requestId = message.requestId;
    const reply = (/** @type {unknown} */ response) => {
      try {
        send.call(comms, { type: 'response', requestId, response });
      } catch (error) {
        this._failed(error);
      }
    };
    this._cceRequest(comms, request).then(reply, (error) => reply({ type: 'error', error: error instanceof Error ? error.message : String(error) }));
    return true;
  }

  /** @param {any} comms @param {any} request */
  _cceRequest(comms, request) {
    const handler = this.onCceRequest;
    if (typeof handler !== 'function') return Promise.reject(codeError('cce_remote_unavailable'));
    return new Promise((resolve) => resolve(handler(comms, request))); // a handler that throws rejects
  }

  // ---- what the host tells the webview -------------------------------------------------------------------

  /**
   * @param {any} comms
   * @param {unknown} message
   * @returns {boolean} true to swallow the message
   */
  _fromHost(comms, message) {
    if (!isRecord(message)) return false;
    switch (message.type) {
      case 'io_message':
        this._onIoMessage(comms, message.channelId, message.message);
        return false;
      case 'request':
        if (isRecord(message.request) && message.request.type === 'panel_usage_update') {
          this._lookAtUsage(); // the usage meter's numbers, sent to every webview: not a prompt
          return false;
        }
        if (this._autoAcceptChrome(comms, message)) return true; // answered for the user: VS Code never shows it
        this._onRequest(comms, message);
        return false;
      case 'cancel_request': // the CLI withdrew the prompt
        this._removePending(message.targetRequestId);
        return false;
      case 'close_channel':
        this._onChannelClosed(comms, message.channelId);
        return false;
      case 'response': {
        const requestId = message.requestId;
        if (typeof requestId !== 'string' || !requestId.startsWith(INJECTED_ID_PREFIX)) return false;
        const settle = this._injected.get(requestId);
        this._injected.delete(requestId);
        if (settle) settle(message.response);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * One SDK message of a channel. It belongs to the session it names, or else to the channel's session
   * (`channel.sessionId`, or what the channel's last system/init named): a new channel has none until
   * its first system/init, and its other messages go nowhere until then.
   * @param {any} comms
   * @param {unknown} channelId
   * @param {unknown} sdk
   */
  _onIoMessage(comms, channelId, sdk) {
    if (!isText(channelId) || !isRecord(sdk)) return;
    const init = sdk.type === 'system' && sdk.subtype === 'init';
    if (init && isText(sdk.session_id)) this._initsOf(comms).set(channelId, sdk.session_id);
    const sessionId = isText(sdk.session_id) ? sdk.session_id : this._sessionOfChannel(comms, channelId);
    if (!sessionId) return;
    if (sdk.type === 'stream_event') {
      if (!this._enabled) return;
      const event = toStreamEvent(sdk);
      if (event) this._emitSession(sessionId, { t: 'stream', event });
      return;
    }
    if (init) {
      this._turns.set(sessionId, true);
      this._changed();
    } else if (sdk.type === 'result') {
      this._turns.delete(sessionId);
      this._changed();
      this._turnEnded(comms, channelId, sessionId, sdk);
    } else if (sdk.type === 'system' && sdk.subtype === 'background_tasks_changed') {
      this._noteTasks(comms, channelId, sdk.tasks); // a result reads it (_settle)
    } else if (sdk.type === 'system' && sdk.subtype === 'session_title_changed') {
      this._changed();
    }
    if (!this._enabled) return; // remote access is off: nothing is mapped or kept
    const message = toPhoneMessage(sdk);
    if (!message) return;
    this._keep(sessionId, sdk);
    this._emitSession(sessionId, { t: 'msg', message });
  }

  /** @param {any} comms @param {Record<string, any>} message  `{type:'request', channelId, requestId, request}` */
  _onRequest(comms, message) {
    const pending = classifyPending(message, this.now());
    if (!pending) return; // not a prompt
    this._sweep();
    const channelId = isText(message.channelId) ? message.channelId : '';
    const sessionId = this._sessionOfChannel(comms, channelId);
    this._pending.set(pending.requestId, { pending, phone: { ...pending, input: trimmedInput(pending.input) }, comms, channelId, sessionId, answering: false });
    if (sessionId) {
      this._emitPending(sessionId);
      this._emitWaiting(sessionId, pending);
    }
    this._changed();
  }

  /**
   * A routine Claude in Chrome prompt while the switch is on: answered as VS Code's "Allow" would answer it,
   * and swallowed, so neither VS Code nor the phone shows it. A prompt that Claude Code wants a person to
   * answer (wantsPerson) is never answered. The answer goes out on the next microtask, once the host's send
   * is over (the host waits for it from before it sends), unless the host has withdrawn the prompt by then.
   * It is the prompt's "always" when that only allows sites for this session (the site card's "always allow
   * this site": a site then asks once a session), else a plain allow, which writes no settings file and
   * changes no mode. When the answer cannot go out, VS Code and the phone get the prompt after all.
   * @param {any} comms
   * @param {Record<string, any>} message  `{type:'request', channelId, requestId, request}`
   * @returns {boolean} true when the agent answers it
   */
  _autoAcceptChrome(comms, message) {
    const request = message.request;
    if (!isRecord(request) || request.type !== 'tool_permission_request') return false;
    if (!isChromeTool(request.toolName) || wantsPerson(request)) return false;
    if (!this._chromeAutoAcceptOn()) return false;
    const pending = classifyPending(message, this.now());
    if (!pending || pending.kind !== 'tool') return false;
    const always = onlySitesForSession(pending);
    const { response, mode } = buildAnswer(pending, { kind: always ? 'allowAlways' : 'allow' }, { autoMode: false });
    if (mode) return false; // a mode change is never the switch's to make (chromeOnlyForSession takes rules only)
    const { requestId, toolName } = pending;
    const site = always ? chromeSiteOf(pending.suggestions) : undefined;
    const answered = () => this._say(`window agent: Claude in Chrome auto-accept allowed ${toolName}${site ? ` and ${site} for the session` : ''}`);
    const failed = (/** @type {unknown} */ error) => {
      if (!this._hostWaitsFor(comms, requestId)) return; // withdrawn meanwhile: nothing to show
      this._say(`window agent: could not answer a Claude in Chrome prompt (${errorText(error)}); VS Code asks instead`);
      this._showAfterAll(comms, message);
    };
    queueMicrotask(() => {
      try {
        if (!this._hostWaitsFor(comms, requestId)) return; // withdrawn before the answer went out
        let queued;
        try {
          queued = this._inject(comms, { type: 'response', requestId, response });
        } catch (error) {
          failed(error);
          return;
        }
        if (isRecord(queued) && typeof queued.then === 'function') queued.then(answered, failed);
        else answered();
      } catch (error) {
        this._failed(error);
      }
    });
    return true;
  }

  /**
   * Whether the comms' host still waits for the request: true unless its `outstandingRequests` shows it does not.
   * @param {any} comms
   * @param {string} requestId
   */
  _hostWaitsFor(comms, requestId) {
    const outstanding = guard(() => comms.outstandingRequests);
    return outstanding instanceof Map ? guard(() => outstanding.has(requestId), false) === true : true;
  }

  /** Whether the Claude in Chrome switch is on: only `true` counts, and a getter that throws is off. */
  _chromeAutoAcceptOn() {
    const on = this.chromeAutoAccept;
    if (typeof on !== 'function') return false;
    try {
      return on() === true;
    } catch (error) {
      this._failed(error);
      return false;
    }
  }

  /**
   * A prompt the agent took but could not answer: VS Code gets it (the original send), and the phone too.
   * @param {any} comms
   * @param {Record<string, any>} message
   */
  _showAfterAll(comms, message) {
    try {
      this._post(comms, message);
    } catch (error) {
      this._failed(error);
    }
    try {
      this._onRequest(comms, message);
      this._notify();
    } catch (error) {
      this._failed(error);
    }
  }

  /** The channel is gone, and so are its prompts. @param {any} comms @param {unknown} channelId */
  _onChannelClosed(comms, channelId) {
    if (!isText(channelId)) return;
    const sessionId = this._sessionOfChannel(comms, channelId);
    /** @type {Set<string>} */
    const affected = new Set();
    for (const [requestId, entry] of this._pending) {
      if (entry.comms !== comms || entry.channelId !== channelId) continue;
      this._pending.delete(requestId);
      const owner = this._entrySession(entry);
      if (owner) affected.add(owner);
    }
    if (sessionId) {
      this._turns.delete(sessionId);
      this._owed.delete(sessionId); // the process is gone: nothing more will end
    }
    this._channelInits.get(comms)?.delete(channelId);
    this._tasks.get(comms)?.delete(channelId);
    this._claimed.delete(this._channelKey(comms, channelId));
    for (const owner of affected) this._emitPending(owner);
    this._changed();
  }

  // ---- what the webview tells the host -------------------------------------------------------------------

  /**
   * @param {any} comms
   * @param {unknown} message
   * @returns {boolean} true to drop the message
   */
  _fromWebview(comms, message) {
    if (!isRecord(message)) return false;
    switch (message.type) {
      case 'response': {
        const requestId = message.requestId;
        if (!isText(requestId)) return false;
        if (this._answeredByPhone(requestId)) return true;
        this._removePending(requestId); // VS Code answered it
        return false;
      }
      case 'close_channel':
        this._onChannelClosed(comms, message.channelId);
        return false;
      case 'launch_claude':
        this._changed();
        return false;
      default:
        return false;
    }
  }

  /** @param {string} requestId */
  _answeredByPhone(requestId) {
    const until = this._answered.get(requestId);
    if (until === undefined) return false;
    if (this.now() < until) return true;
    this._answered.delete(requestId);
    return false;
  }

  /** @param {string} requestId */
  _noteAnswered(requestId) {
    const now = this.now();
    for (const [id, until] of this._answered) if (until <= now) this._answered.delete(id);
    this._answered.set(requestId, now + AGENT_LIMITS.answeredMs);
  }

  // ---- channels and sessions -----------------------------------------------------------------------------

  /** The provider's `allComms`, when it is there. */
  _commsSet() {
    const set = guard(() => this.provider.allComms);
    return set && typeof set[Symbol.iterator] === 'function' ? set : undefined;
  }

  /** @returns {any[]} */
  _commsList() {
    const set = this._commsSet();
    if (!set) return [];
    try {
      return Array.from(set).filter((comms) => typeof comms === 'object' && comms !== null);
    } catch {
      return [];
    }
  }

  /** @param {any} comms */
  _initsOf(comms) {
    let inits = this._channelInits.get(comms);
    if (!inits) {
      inits = new Map();
      this._channelInits.set(comms, inits);
    }
    return inits;
  }

  /** @param {any} comms @param {string} channelId */
  _channelKey(comms, channelId) {
    let key = this._commsKeys.get(comms);
    if (key === undefined) {
      key = ++this._lastCommsKey;
      this._commsKeys.set(comms, key);
    }
    return `${key}\u0000${channelId}`;
  }

  /** The channel, running or still launching; looked up afresh (a launching channel is replaced when it runs). @param {any} comms @param {string} channelId */
  _channelAt(comms, channelId) {
    return getFrom(guard(() => comms.channels), channelId) ?? getFrom(guard(() => comms.pendingChannels), channelId);
  }

  /** @param {any} comms @param {string} channelId @param {any} channel @returns {string | undefined} */
  _sessionOf(comms, channelId, channel) {
    const own = guard(() => channel.sessionId);
    if (isText(own)) return own;
    return this._channelInits.get(comms)?.get(channelId);
  }

  /** @param {any} comms @param {string} channelId */
  _sessionOfChannel(comms, channelId) {
    return this._sessionOf(comms, channelId, this._channelAt(comms, channelId));
  }

  /** Every channel of the window: the running ones of every comms first, then the launching ones. @returns {ChannelRef[]} */
  _allChannels() {
    /** @type {ChannelRef[]} */
    const out = [];
    const list = this._commsList();
    for (const field of ['channels', 'pendingChannels']) {
      for (const comms of list) {
        for (const [channelId, channel] of entriesOf(guard(() => comms[field]))) {
          if (isText(channelId)) out.push({ comms, channelId, channel, key: this._channelKey(comms, channelId) });
        }
      }
    }
    return out;
  }

  /** @param {unknown} sessionId */
  _findChannel(sessionId) {
    if (!isText(sessionId)) return undefined;
    return this._allChannels().find((ref) => this._sessionOf(ref.comms, ref.channelId, ref.channel) === sessionId);
  }

  /**
   * A channel that is new since `before` and has no session yet: the one a new session opened. It is
   * taken at once, so two new sessions opened together never share one.
   * @param {Set<string>} before
   */
  _takeNewChannel(before) {
    for (const ref of this._allChannels()) {
      if (before.has(ref.key) || this._claimed.has(ref.key)) continue;
      if (this._sessionOf(ref.comms, ref.channelId, ref.channel)) continue; // a session that exists, opened meanwhile
      this._claimed.set(ref.key, { comms: ref.comms, channelId: ref.channelId });
      return ref;
    }
    return undefined;
  }

  /**
   * The session a new channel's system/init named; undefined while it waits. Throws `closed` when the channel
   * is gone before that: it did not start, and the prompt it was given went with it.
   * @param {ChannelRef} ref
   */
  _namedSession(ref) {
    const channel = this._channelAt(ref.comms, ref.channelId);
    const sessionId = this._sessionOf(ref.comms, ref.channelId, channel);
    if (sessionId) return sessionId;
    if (channel === undefined) throw codeError('closed');
    return undefined;
  }

  // ---- prompts -----------------------------------------------------------------------------------------

  /** @param {PendingEntry} entry */
  _entrySession(entry) {
    return entry.sessionId ?? this._sessionOfChannel(entry.comms, entry.channelId);
  }

  /**
   * Whether the host still waits for the prompt: its comms and channel are there (a channel can close without a
   * word), and the host still holds the request. The host forgets a request at once when it is answered or
   * withdrawn, and when a reloaded webview starts afresh, while its channel closes only later.
   * @param {PendingEntry} entry
   */
  _isLive(entry) {
    const set = this._commsSet();
    if (!set || guard(() => set.has(entry.comms), false) !== true) return false;
    if (this._channelAt(entry.comms, entry.channelId) === undefined) return false;
    const outstanding = guard(() => entry.comms.outstandingRequests);
    return outstanding instanceof Map ? guard(() => outstanding.has(entry.pending.requestId), false) === true : true;
  }

  /** @param {unknown} sessionId @returns {PendingEntry[]} */
  _pendingFor(sessionId) {
    if (!isText(sessionId)) return [];
    /** @type {PendingEntry[]} */
    const out = [];
    for (const entry of this._pending.values()) if (this._entrySession(entry) === sessionId && this._isLive(entry)) out.push(entry);
    return out;
  }

  /** The session's live prompts, to the phone (`session` event) and as the ids that are still open (`attention` event). @param {string} sessionId */
  _emitPending(sessionId) {
    if (!this._enabled) return;
    const live = this._pendingFor(sessionId);
    this._emitSession(sessionId, { t: 'pending', pending: live.map((entry) => entry.phone) });
    this._emitAttention({ kind: 'open', session: sessionId, requestIds: live.map((entry) => entry.pending.requestId) });
  }

  /** @param {unknown} requestId */
  _removePending(requestId) {
    if (!isText(requestId)) return false;
    const entry = this._pending.get(requestId);
    if (!entry) return false;
    this._pending.delete(requestId);
    const sessionId = this._entrySession(entry);
    if (sessionId) this._emitPending(sessionId);
    this._changed();
    return true;
  }

  /** Drops what belongs to channels that are gone: prompts (the phone is told), turn and init records, taken channels. */
  _sweep() {
    /** @type {Set<string>} */
    const affected = new Set();
    for (const [requestId, entry] of this._pending) {
      if (entry.answering || this._isLive(entry)) continue;
      this._pending.delete(requestId);
      const sessionId = this._entrySession(entry);
      if (sessionId) affected.add(sessionId);
    }
    for (const [key, claim] of this._claimed) if (this._channelAt(claim.comms, claim.channelId) === undefined) this._claimed.delete(key);
    /** @type {Set<string>} */
    const withChannel = new Set();
    for (const ref of this._allChannels()) {
      const sessionId = this._sessionOf(ref.comms, ref.channelId, ref.channel);
      if (sessionId) withChannel.add(sessionId);
    }
    for (const sessionId of this._turns.keys()) if (!withChannel.has(sessionId)) this._turns.delete(sessionId);
    for (const sessionId of this._owed.keys()) if (!withChannel.has(sessionId)) this._owed.delete(sessionId);
    for (const comms of this._commsList()) {
      for (const byChannel of [this._channelInits.get(comms), this._tasks.get(comms)]) {
        if (byChannel) for (const channelId of byChannel.keys()) if (this._channelAt(comms, channelId) === undefined) byChannel.delete(channelId);
      }
    }
    for (const sessionId of affected) this._emitPending(sessionId);
    if (affected.size > 0) this._changed();
  }

  // ---- the live buffer ----------------------------------------------------------------------------------

  /** @param {string} sessionId @param {Record<string, any>} sdk */
  _keep(sessionId, sdk) {
    let buffer = this._live.get(sessionId);
    if (buffer) this._live.delete(sessionId);
    else buffer = new Map();
    this._live.set(sessionId, buffer); // the most recently active session is last
    for (const oldest of this._live.keys()) {
      if (this._live.size <= AGENT_LIMITS.liveSessions) break;
      this._live.delete(oldest);
    }
    const key = isText(sdk.uuid) ? keptString(sdk.uuid, KEEP.identifier) : `\u0000${++this._liveKeys}`; // a result may come without a uuid
    buffer.set(key, slimMessage(sdk));
    for (const oldest of buffer.keys()) {
      if (buffer.size <= AGENT_LIMITS.liveMessages) break;
      buffer.delete(oldest);
    }
  }

  /** @param {unknown} sessionId */
  _liveMessages(sessionId) {
    const buffer = isText(sessionId) ? this._live.get(sessionId) : undefined;
    return buffer ? Array.from(buffer.values()) : [];
  }

  // ---- state ---------------------------------------------------------------------------------------------

  /** What project() and snapshot() read about every session, read once. */
  _context() {
    /** @type {Map<string, any[]>} sessions with a channel (running or launching) */
    const channels = new Map();
    for (const ref of this._allChannels()) {
      const sessionId = this._sessionOf(ref.comms, ref.channelId, ref.channel);
      if (!sessionId) continue;
      const list = channels.get(sessionId);
      if (list) list.push(ref.channel);
      else channels.set(sessionId, [ref.channel]);
    }
    /** @type {Map<string, number>} */
    const pending = new Map();
    for (const entry of this._pending.values()) {
      if (!this._isLive(entry)) continue;
      const sessionId = this._entrySession(entry);
      if (sessionId) pending.set(sessionId, (pending.get(sessionId) ?? 0) + 1);
    }
    /** @type {Map<string, unknown>} sessions other processes hold (a CLI in a terminal), by activity */
    const elsewhere = new Map();
    const held = guard(() => this.provider.liveElsewhereSessions);
    if (Array.isArray(held)) for (const item of held) if (isRecord(item) && isText(item.sessionId)) elsewhere.set(item.sessionId, item.activity);
    return {
      channels,
      pending,
      elsewhere,
      states: guard(() => this.provider.sessionStates),
      unread: guard(() => this.provider.unreadSessionKeys),
    };
  }

  /**
   * waiting (a prompt, `waiting_input` reported by a panel, or waiting elsewhere) > running (an open
   * turn here, or running per a panel or elsewhere) > unread > idle.
   * @param {string} sessionId
   * @param {ReturnType<WindowAgent['_context']>} context
   * @returns {SessionState}
   */
  _state(sessionId, context) {
    const reported = guard(() => context.states.get(sessionId).info.state);
    const elsewhere = context.elsewhere.get(sessionId);
    if ((context.pending.get(sessionId) ?? 0) > 0 || reported === 'waiting_input' || elsewhere === 'waiting') return 'waiting';
    if (this._turnOpen(sessionId, context.channels.get(sessionId)) || reported === 'running' || elsewhere === 'running') return 'running';
    if (guard(() => context.unread.has(sessionId), false) === true) return 'unread';
    return 'idle';
  }

  /**
   * Whether a turn is open on the session's channels: `atRest` is the host's word for it (it also counts
   * queued prompts and background tasks); a channel without it goes by system/init and result.
   * @param {string} sessionId
   * @param {any[] | undefined} channels
   */
  _turnOpen(sessionId, channels) {
    if (!channels || channels.length === 0) return false;
    let unknown = false;
    for (const channel of channels) {
      const atRest = guard(() => channel.atRest);
      if (typeof atRest !== 'boolean') unknown = true;
      else if (!atRest) return true;
    }
    return unknown && this._turns.get(sessionId) === true;
  }

  /** @param {string} sessionId @param {ReturnType<WindowAgent['_context']>} context */
  _liveTitle(sessionId, context) {
    return oneLine(guard(() => context.states.get(sessionId).info.title));
  }

  /**
   * @param {string} sessionId
   * @param {number} lastModified
   * @param {string} title
   * @param {{ gitBranch?: string, worktree?: string }} extra
   * @param {ReturnType<WindowAgent['_context']>} context
   * @returns {SessionSummary}
   */
  _summary(sessionId, lastModified, title, extra, context) {
    return {
      id: sessionId,
      title,
      lastModified,
      state: this._state(sessionId, context),
      live: context.channels.has(sessionId),
      ...(extra.gitBranch ? { gitBranch: extra.gitBranch } : {}),
      ...(extra.worktree ? { worktree: extra.worktree } : {}),
      pendingCount: context.pending.get(sessionId) ?? 0,
    };
  }

  // ---- the project ----------------------------------------------------------------------------------------

  /**
   * The title an attention event names a session by, as project() shows it: the panel's live title, else the
   * listed custom title or summary, else "Untitled" for a listed session without either, else "New session"
   * for one that is not listed yet. One line, at most AGENT_LIMITS.title characters (and the ellipsis).
   * @param {string} sessionId
   */
  _titleOf(sessionId) {
    const listed = this._listed?.find((entry) => entry.id === sessionId);
    const listedTitle = listed ? listed.customTitle ?? listed.summary ?? 'Untitled' : 'New session';
    return this._liveTitle(sessionId, this._context()) ?? listedTitle;
  }

  /** First 12 hex of sha1(appName + "\n" + folders joined by "\n"): stable across reloads. */
  projectId() {
    return projectIdOf(this._editor(), this._folders());
  }

  /** @returns {string[]} */
  _folders() {
    const folders = guard(() => this.vscode.workspace.workspaceFolders);
    /** @type {string[]} */
    const out = [];
    try {
      if (folders && typeof folders[Symbol.iterator] === 'function') {
        for (const folder of folders) {
          const fsPath = guard(() => folder.uri.fsPath);
          if (isText(fsPath)) out.push(fsPath);
        }
      }
    } catch {
      // a folder list that cannot be read is no folder
    }
    return out;
  }

  _editor() {
    const appName = guard(() => this.vscode.env.appName);
    return isText(appName) ? appName : 'VS Code';
  }

  /** @param {string[]} folders */
  _name(folders) {
    const name = guard(() => this.vscode.workspace.name);
    if (isText(name)) return name;
    if (folders.length > 0) return path.basename(folders[0]) || folders[0];
    return 'No folder';
  }

  /**
   * The window's project, from the last session list (refreshProject() reads it) and the live state.
   * Sessions: the list without archived ones, plus sessions that have a channel but are not listed yet
   * ("New session"), most recent activity first, at most AGENT_LIMITS.sessions.
   * @returns {Project}
   */
  project() {
    const folders = this._folders();
    const editor = this._editor();
    const base = { id: projectIdOf(editor, folders), name: this._name(folders), folders, editor };
    if (this._commsList().length === 0) return { ...base, claudeOpen: false, sessions: [] };
    const context = this._context();
    /** @type {Array<{ at: number, summary: SessionSummary }>} */
    const rows = [];
    /** @type {Set<string>} */
    const listed = new Set();
    for (const entry of this._listed ?? []) {
      if (listed.has(entry.id) || (entry.archived && !context.channels.has(entry.id))) continue;
      listed.add(entry.id);
      const title = this._liveTitle(entry.id, context) ?? entry.customTitle ?? entry.summary ?? 'Untitled';
      rows.push({ at: entry.at, summary: this._summary(entry.id, entry.at, title, entry, context) });
    }
    for (const sessionId of context.channels.keys()) {
      if (listed.has(sessionId)) continue;
      let since = this._firstSeen.get(sessionId);
      if (since === undefined) {
        since = this.now();
        this._firstSeen.set(sessionId, since);
      }
      const title = this._liveTitle(sessionId, context) ?? 'New session';
      rows.push({ at: since, summary: this._summary(sessionId, since, title, {}, context) });
    }
    for (const sessionId of this._firstSeen.keys()) if (listed.has(sessionId) || !context.channels.has(sessionId)) this._firstSeen.delete(sessionId);
    rows.sort((a, b) => b.at - a.at);
    return { ...base, claudeOpen: true, sessions: rows.slice(0, AGENT_LIMITS.sessions).map((row) => row.summary) };
  }

  /**
   * Reads the session list again (`buildSessionList()`, or `listSessions()` on an extension without
   * it) and emits 'project' when the project changed. A list that cannot be read leaves the last one.
   * @returns {Promise<Project>}
   */
  async refreshProject() {
    this._lookAtUsage(); // a logout clears the meter without sending anything: this is when it is noticed
    this._sweep();
    await this._loadList();
    const project = this.project();
    const json = JSON.stringify(project);
    if (json !== this._projectJson) {
      this._projectJson = json;
      this._emitSafe('project', project);
    }
    return project;
  }

  /**
   * The session list; undefined when it cannot be read. Of lists read at the same time, the one asked
   * for last is kept.
   * @returns {Promise<ListEntry[] | undefined>}
   */
  async _loadList() {
    const seq = ++this._listSeq;
    const source = this._commsList().find(
      (comms) => typeof guard(() => comms.buildSessionList) === 'function' || typeof guard(() => comms.listSessions) === 'function',
    );
    if (!source) return [];
    /** @type {unknown} */
    let raw;
    try {
      if (typeof source.buildSessionList === 'function') raw = await this._hostRead('the session list', () => source.buildSessionList());
      else {
        // Only an extension without buildSessionList: this one emits telemetry.
        const response = await this._hostRead('the session list', () => source.listSessions());
        raw = isRecord(response) ? response.sessions : undefined;
      }
    } catch (error) {
      if (!isRecord(error) || error.code !== 'timeout') this._say(`window agent: could not list the sessions (${errorText(error)})`);
      return undefined;
    }
    if (!Array.isArray(raw)) return undefined;
    /** @type {ListEntry[]} */
    const list = [];
    for (const entry of raw) {
      const kept = listEntry(entry);
      if (kept) list.push(kept);
    }
    if (seq > this._listApplied) {
      this._listApplied = seq;
      this._listed = list;
    }
    return list;
  }

  /** Whether the agent mirrors the window's sessions: remote access is on (true until the coordinator says otherwise). */
  get enabled() {
    return this._enabled;
  }

  /**
   * Remote access on or off, as the coordinator reads it. While off, no session message is mapped,
   * kept or emitted, and what was kept is let go; prompts, turns and the channels' sessions are
   * still followed, so a prompt that waits when remote access is turned on can be answered from the
   * phone. The Connection tab's requests are answered either way.
   * @param {boolean} on
   */
  setEnabled(on) {
    const enabled = on === true;
    if (enabled === this._enabled) return;
    this._enabled = enabled;
    if (!enabled) {
      this._live.clear();
      this._owed.clear();
    } else this.replayAttention();
  }

  /**
   * Reports the prompts that are open right now, so a hub that has just taken over (or remote access that
   * was just turned on) knows what is already waiting. A live prompt that was never announced (remote
   * access was off, or no hub listened) is emitted as `waiting` first, with the same title and prompt as a
   * fresh one, and marked; prompts already announced to a hub are only counted. Then `open` per session.
   * Nothing while remote access is off.
   */
  replayAttention() {
    if (!this._enabled) return;
    /** @type {Map<string, PendingEntry[]>} session id → its live prompts */
    const open = new Map();
    for (const entry of this._pending.values()) {
      if (!this._isLive(entry)) continue;
      const sessionId = this._entrySession(entry);
      if (!sessionId) continue;
      const entries = open.get(sessionId);
      if (entries) entries.push(entry);
      else open.set(sessionId, [entry]);
    }
    for (const [sessionId, entries] of open) {
      for (const entry of entries) if (!this._announced.has(entry.pending.requestId)) this._emitWaiting(sessionId, entry.pending);
    }
    for (const [sessionId, entries] of open) this._emitAttention({ kind: 'open', session: sessionId, requestIds: entries.map((entry) => entry.pending.requestId) });
  }

  /**
   * While a phone is connected: refreshes now and every refreshEveryMs, and refreshDelayMs after a
   * change of channels, titles, turns or prompts. Off stops all of it.
   * @param {boolean} on
   */
  setActive(on) {
    if (on) {
      if (!this._active) {
        this._active = true;
        this._refreshTimer = unref(setInterval(() => this._refreshQuietly(), this.refreshEveryMs));
      }
      this._refreshQuietly();
      return;
    }
    this._active = false;
    clearInterval(this._refreshTimer);
    clearTimeout(this._delayTimer);
    this._refreshTimer = undefined;
    this._delayTimer = undefined;
  }

  /** Something the project shows changed: while active, refresh it a little later (once for a burst). */
  _changed() {
    if (!this._active || this._delayTimer !== undefined) return;
    this._delayTimer = unref(
      setTimeout(() => {
        this._delayTimer = undefined;
        this._refreshQuietly();
      }, this.refreshDelayMs),
    );
  }

  _refreshQuietly() {
    this.refreshProject().catch((error) => this._failed(error));
  }

  // ---- the usage meter ------------------------------------------------------------------------------------

  /**
   * Looks at Claude Code's usage meter (the provider's `panelUsageRelay.merged`). The relay makes `merged` a new
   * object for every real update, even one with the same numbers, and leaves it as it is when it only sends the
   * numbers again (to a webview that starts): so a new object is numbers that just arrived, stamped `at` now, and
   * the same object is nothing new. The first look (start) takes what is there without `at` and without an event.
   * `null` (nothing known yet, signed out) is a reading without limits. The account is read at every look: Claude
   * Code learns it on its own schedule, apart from the numbers. Emits `usage` when the reading changed.
   */
  _lookAtUsage() {
    try {
      const relay = guard(() => this.provider.panelUsageRelay);
      /** @type {UsageReading} */
      let reading;
      if (!isRecord(relay)) {
        reading = { supported: false };
      } else {
        const merged = guard(() => relay.merged, null);
        if (merged !== this._usageRef) {
          const first = this._usageRef === UNSEEN;
          this._usageRef = merged;
          /** @type {UsageNumbers} */
          const numbers = {};
          if (isRecord(merged)) {
            const fiveHour = usageWindow(merged.five_hour);
            const week = usageWindow(merged.seven_day);
            if (fiveHour) numbers.fiveHour = fiveHour;
            if (week) numbers.week = week;
            if (!first && (fiveHour || week)) numbers.at = this.now();
          }
          this._usageNumbers = numbers;
        }
        reading = { supported: true, ...this._usageNumbers };
        const account = this._signedInAccount();
        if (account !== undefined) reading.account = account;
      }
      const json = JSON.stringify(reading);
      if (json === this._usageJson) return;
      const baseline = this._usageJson === undefined;
      this._usage = reading;
      this._usageJson = json;
      if (!baseline) this._emitSafe('usage', copyReading(reading));
    } catch (error) {
      this._failed(error);
    }
  }

  /**
   * The email of the Claude account this window's Claude Code is signed in to, as `claude auth status` told it
   * (each comms' `cliReportedAccountEmail()`, 2.1.330). The first comms that knows decides, as the provider's own
   * account-change check has it; one that hasn't heard yet is passed over. Undefined when signed out, for a login
   * without an account (an API key, a third-party provider) and in an extension without the method.
   * @returns {string | undefined}
   */
  _signedInAccount() {
    for (const comms of this._commsList()) {
      const report = guard(() => comms.cliReportedAccountEmail);
      if (typeof report !== 'function') continue;
      const email = guard(() => report.call(comms));
      if (email === undefined) continue;
      return typeof email === 'string' && email !== '' ? email : undefined;
    }
    return undefined;
  }

  /** The window's usage meter, as the agent last saw it (a copy). @returns {UsageReading} */
  usageReading() {
    this._lookAtUsage();
    return copyReading(this._usage);
  }

  /**
   * Has Claude Code read the usage afresh, through the Claude process of a running session of this window (one at
   * rest first): `relayUsageWindowsFromProcess`, which asks Anthropic and relays the answer like any update. At
   * most usageReadMs. `refreshed` is true when new numbers arrived meanwhile. Without the meter (or the read) in
   * this extension the reason is `not_supported`; without a running session, `no_session`. Never rejects.
   * @returns {Promise<{ refreshed: boolean, reason?: 'no_session' | 'not_supported', reading: UsageReading }>}
   */
  async refreshUsage() {
    try {
      const relay = guard(() => this.provider.panelUsageRelay);
      const readers = this._commsList().filter((comms) => typeof guard(() => comms.relayUsageWindowsFromProcess) === 'function');
      if (!isRecord(relay) || readers.length === 0) return { refreshed: false, reason: 'not_supported', reading: this.usageReading() };
      const candidates = this._allChannels().filter(
        (ref) => readers.includes(ref.comms) && typeof guard(() => ref.channel.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) === 'function',
      );
      if (candidates.length === 0) return { refreshed: false, reason: 'no_session', reading: this.usageReading() };
      const chosen = candidates.find((ref) => guard(() => ref.channel.atRest) === true) ?? candidates[0];
      this._lookAtUsage();
      const before = this._usageRef;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      const gaveUp = new Promise((resolve) => {
        timer = unref(setTimeout(resolve, this.usageReadMs));
      });
      try {
        await Promise.race([Promise.resolve().then(() => chosen.comms.relayUsageWindowsFromProcess(chosen.channel.query)), gaveUp]);
      } finally {
        clearTimeout(timer);
      }
      this._lookAtUsage();
      const refreshed = this._usageRef !== before && Boolean(this._usage.fiveHour || this._usage.week);
      return { refreshed, reading: copyReading(this._usage) };
    } catch (error) {
      this._failed(error);
      return { refreshed: false, reading: copyReading(this._usage) };
    }
  }

  // ---- slash commands -------------------------------------------------------------------------------------

  /**
   * The window's slash commands, as VS Code's `/` menu lists Claude Code's own (named by commands.js). They are read
   * from what the extension already holds, the first list that has commands in this order (an empty one is no list:
   * the stored copy falls back to the one kept for any folder, which 2.1.330 keeps without commands):
   *  1. a comms' loaded config (`settledConfig`), the comms for the window's first folder first;
   *  2. the stored copy the webview shows while that loads (`storedStartupConfig.read(surfaceCwd())`);
   *  3. a running session's own list (`query.supportedCommands()`), the window's folder first;
   *  4. a comms' config still loading (`config`).
   * 3 and 4 wait at most hostReadMs each. The host is never asked for a config (`get_claude_state`, `loadConfig()`):
   * that can start a Claude process. [] when nothing has a list. Never rejects.
   * @returns {Promise<import('./commands.js').SlashCommand[]>}
   */
  async commands() {
    try {
      const folder = this._folders()[0];
      const home = folder === undefined ? undefined : path.resolve(folder);
      const atHome = (/** @type {unknown} */ dir) => home !== undefined && isText(dir) && path.resolve(dir) === home;
      /** @template T @param {T[]} list @param {(item: T) => unknown} dirOf */
      const homeFirst = (list, dirOf) => [...list.filter((item) => atHome(dirOf(item))), ...list.filter((item) => !atHome(dirOf(item)))];
      const comms = homeFirst(this._commsList(), (c) => guard(() => c.configCwd));
      for (const c of comms) {
        const list = guard(() => c.settledConfig.commands);
        if (Array.isArray(list) && list.length > 0) return toSlashCommands(list);
      }
      for (const c of comms) {
        const list = guard(() => (typeof c.storedStartupConfig.read === 'function' && typeof c.surfaceCwd === 'function' ? c.storedStartupConfig.read(c.surfaceCwd()).commands : undefined));
        if (Array.isArray(list) && list.length > 0) return toSlashCommands(list);
      }
      const running = this._allChannels().filter((ref) => typeof guard(() => ref.channel.query.supportedCommands) === 'function');
      for (const ref of homeFirst(running, (r) => guard(() => r.channel.cwd))) {
        const list = await this._hostRead('the command list', () => ref.channel.query.supportedCommands()).catch(() => undefined);
        if (Array.isArray(list) && list.length > 0) return toSlashCommands(list);
      }
      for (const c of comms) {
        const loading = guard(() => c.config);
        if (!loading || typeof loading.then !== 'function') continue;
        const config = await this._hostRead('the command list', () => loading).catch(() => undefined);
        const list = guard(() => config.commands);
        if (Array.isArray(list) && list.length > 0) return toSlashCommands(list);
      }
    } catch (error) {
      this._failed(error);
    }
    return [];
  }

  // ---- the phone's actions --------------------------------------------------------------------------------

  /**
   * The transcript (`getSession(id)`, without a purpose, so without telemetry) merged with the live
   * messages, and the session's prompts and state. A session without a transcript (a new one) has an
   * empty history.
   * @param {string} sessionId
   */
  async snapshot(sessionId) {
    /** @type {unknown[]} */
    let history = [];
    const source = this._historySource(sessionId);
    if (source) {
      try {
        const loaded = await this._hostRead('the transcript', () => source.getSession(sessionId));
        if (isRecord(loaded) && Array.isArray(loaded.messages)) history = loaded.messages;
      } catch (error) {
        if (!isRecord(error) || error.code !== 'timeout') this._say(`window agent: no transcript for the session (${errorText(error)})`);
      }
    }
    const { messages, truncatedBefore } = mergeHistory(history, this._liveMessages(sessionId));
    const context = this._context();
    return {
      messages,
      pending: this._pendingFor(sessionId).map((entry) => entry.phone),
      state: isText(sessionId) ? this._state(sessionId, context) : 'idle',
      live: isText(sessionId) && context.channels.has(sessionId),
      truncatedBefore,
    };
  }

  /** The comms that holds the session, or any that can read a transcript. @param {unknown} sessionId */
  _historySource(sessionId) {
    if (!isText(sessionId)) return undefined;
    const holder = this._findChannel(sessionId);
    if (holder && typeof guard(() => holder.comms.getSession) === 'function') return holder.comms;
    return this._commsList().find((comms) => typeof guard(() => comms.getSession) === 'function');
  }

  /**
   * Sends a prompt as the webview would. `sessionId` null starts a new session in an editor tab; a
   * session without a channel is opened in one first. Rejects `empty`, `too_long`, `bad_images`,
   * `bad_session`, `unknown_session`, `open_failed`, `timeout` or `not_running_in_vscode` (nothing was sent then), or `closed` (a new
   * session's channel closed before it started: the prompt was lost with it).
   * @param {string | null} sessionId
   * @param {string} text
   * @param {Array<{ mediaType: string, data: string }>} [images]
   * @returns {Promise<{ session: string | null, uuid: string }>}  session: null when a new session runs but was not named within channelWaitMs
   */
  async send(sessionId, text, images = []) {
    const message = userMessage(text, images);
    if (sessionId === null) return this._sendToNewSession(message);
    if (!isText(sessionId)) throw codeError('bad_session');
    const target = await this._channelFor(sessionId);
    this._inject(target.comms, { type: 'io_message', channelId: target.channelId, message, done: false });
    return { session: sessionId, uuid: message.uuid };
  }

  /**
   * The channel of a session, opened when it has none. A session that VS Code shows without a Claude Code
   * process (the CLI exited, or the host closed it) does not start one when it is shown again; only a prompt
   * typed there would. So its editor tab is closed and the session opened again (the fresh tab resumes it).
   * The sidebar is never closed: a session it shows gets one open, then `not_running_in_vscode` after
   * wakeWaitMs, as does a tab that cannot be closed.
   * @param {string} sessionId
   * @returns {Promise<ChannelRef>}
   */
  async _channelFor(sessionId) {
    const found = this._findChannel(sessionId);
    if (found) return found;
    if (!(await this._isKnownSession(sessionId))) throw codeError('unknown_session');
    const find = () => this._findChannel(sessionId);
    const open = editorArgs(sessionId, PIN_TO_PANEL);
    const panel = this._panelOf(sessionId);
    if (panel !== undefined && (await this._closePanel(sessionId, panel))) {
      this._say('window agent: closed the editor tab of a session whose Claude Code process had stopped, to open it again');
      return this._openAndWait(find, OPEN_EDITOR, ...open);
    }
    if (panel === undefined && !this._sidebarHolds(sessionId)) return this._openAndWait(find, OPEN_EDITOR, ...open);
    try {
      return await this._openAndWaitMs(this.wakeWaitMs, find, OPEN_EDITOR, ...open);
    } catch (error) {
      if (isRecord(error) && error.code === 'timeout') throw codeError('not_running_in_vscode');
      throw error;
    }
  }

  /** The editor tab (WebviewPanel) the host keeps for the session, if any. @param {string} sessionId */
  _panelOf(sessionId) {
    const panels = guard(() => this.provider.sessionPanels);
    const panel = panels && typeof panels.get === 'function' ? guard(() => panels.get(sessionId)) : undefined;
    return isRecord(panel) && typeof panel.dispose === 'function' ? panel : undefined;
  }

  /** Whether the sidebar shows the session (the host's own test). @param {string} sessionId */
  _sidebarHolds(sessionId) {
    const provider = this.provider;
    return guard(() => typeof provider.sidebarHoldsSession === 'function' && provider.sidebarHoldsSession(sessionId) === true) === true;
  }

  /**
   * Closes the session's editor tab, then waits (at most a moment) until the host has let go of it.
   * False when it could not be closed.
   * @param {string} sessionId
   * @param {any} panel
   */
  async _closePanel(sessionId, panel) {
    try {
      panel.dispose();
    } catch (error) {
      this._say(`window agent: could not close the editor tab of a stopped session (${errorText(error)})`);
      return false;
    }
    await this._waitFor(() => (this._panelOf(sessionId) === panel ? undefined : true), 2_000).catch(() => undefined);
    return true;
  }

  /**
   * Whether the window lists the session (a fresh list is read when the last one does not have it). A
   * list that cannot be read lets VS Code try.
   * @param {string} sessionId
   */
  async _isKnownSession(sessionId) {
    if (this._listed && this._listed.some((entry) => entry.id === sessionId)) return true;
    const list = await this._loadList();
    return list === undefined || list.some((entry) => entry.id === sessionId);
  }

  /** @param {Record<string, any>} message */
  async _sendToNewSession(message) {
    const before = new Set(this._allChannels().map((ref) => ref.key));
    const target = await this._openAndWait(() => this._takeNewChannel(before), OPEN_EDITOR, ...editorArgs(undefined, PIN_TO_PANEL));
    this._inject(target.comms, { type: 'io_message', channelId: target.channelId, message, done: false });
    try {
      return { session: await this._waitFor(() => this._namedSession(target), this.channelWaitMs), uuid: message.uuid };
    } catch (error) {
      if (!isRecord(error) || error.code !== 'timeout') throw error; // closed: the prompt is lost
      if (this._channelAt(target.comms, target.channelId) === undefined) throw codeError('closed');
      return { session: null, uuid: message.uuid }; // sent and running, not named yet: the phone finds it in the project
    }
  }

  /**
   * Runs an open command and waits up to channelWaitMs for `find` to find something; a command that
   * fails ends the wait at once.
   * @template T
   * @param {() => T | undefined} find
   * @param {string} id
   * @param {...unknown} args
   * @returns {Promise<T>}
   */
  _openAndWait(find, id, ...args) {
    return this._openAndWaitMs(this.channelWaitMs, find, id, ...args);
  }

  /**
   * _openAndWait with its own wait.
   * @template T
   * @param {number} ms
   * @param {() => T | undefined} find
   * @param {string} id
   * @param {...unknown} args
   * @returns {Promise<T>}
   */
  _openAndWaitMs(ms, find, id, ...args) {
    /** @type {unknown} */
    let failure;
    this._command(id, ...args).catch((error) => {
      failure = error;
      this._notify();
    });
    return this._waitFor(() => {
      const found = find();
      if (found !== undefined) return found;
      if (failure) throw failure;
      return undefined;
    }, ms);
  }

  /**
   * Answers a prompt pending on the session with the phone's choice (answers.js builds the payload).
   * A mode change goes first and is waited for, as VS Code does, never as the user's new default.
   * Then the answer, then `cancel_request` so VS Code drops its prompt; VS Code's own answer to it
   * is dropped for the next 60 s. Rejects `not_pending` (nothing injected), or `invalid_choice`.
   * @param {string} sessionId
   * @param {string} requestId
   * @param {import('./answers.js').Choice} choice
   */
  async answer(sessionId, requestId, choice) {
    const entry = this._answerable(sessionId, requestId);
    if (!entry) {
      const stale = isText(requestId) ? this._pending.get(requestId) : undefined;
      if (stale && !stale.answering && !this._isLive(stale)) this._removePending(requestId); // the host no longer waits for it: the phone is told
      throw codeError('not_pending');
    }
    const { response, mode } = buildAnswer(entry.pending, choice, { autoMode: false });
    entry.answering = true;
    try {
      if (mode) {
        await this._setMode(entry, mode);
        if (this._pending.get(requestId) !== entry) throw codeError('not_pending'); // VS Code answered, or the CLI withdrew it
        if (!this._isLive(entry)) {
          this._removePending(requestId);
          throw codeError('not_pending');
        }
      }
      this._inject(entry.comms, { type: 'response', requestId, response });
      this._noteAnswered(requestId);
    } finally {
      entry.answering = false;
    }
    try {
      this._post(entry.comms, { type: 'cancel_request', targetRequestId: requestId });
    } catch (error) {
      this._failed(error);
    }
    this._removePending(requestId);
  }

  /** @param {unknown} sessionId @param {unknown} requestId */
  _answerable(sessionId, requestId) {
    if (!isText(sessionId) || !isText(requestId)) return undefined;
    const entry = this._pending.get(requestId);
    if (!entry || entry.answering || this._entrySession(entry) !== sessionId || !this._isLive(entry)) return undefined;
    return entry;
  }

  /**
   * `set_permission_mode` on the prompt's channel, with userInitiated false as VS Code sends it for a
   * prompt (true would make the mode the user's default). Resolves with the host's response, or
   * undefined after AGENT_LIMITS.modeWaitMs; the answer goes ahead either way, as in VS Code.
   * @param {PendingEntry} entry
   * @param {string} mode
   */
  _setMode(entry, mode) {
    const requestId = INJECTED_ID_PREFIX + crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = unref(
        setTimeout(() => {
          this._injected.delete(requestId);
          this._say(`window agent: no answer to the permission mode change (${mode}); answering anyway`);
          resolve(undefined);
        }, AGENT_LIMITS.modeWaitMs),
      );
      this._injected.set(requestId, (response) => {
        clearTimeout(timer);
        if (!isRecord(response) || response.success !== true) this._say(`window agent: the permission mode ${mode} was not applied`);
        resolve(response);
      });
      try {
        this._inject(entry.comms, {
          type: 'request',
          channelId: entry.channelId,
          requestId,
          request: { type: 'set_permission_mode', mode, userInitiated: false },
        });
      } catch (error) {
        clearTimeout(timer);
        this._injected.delete(requestId);
        reject(error);
      }
    });
  }

  /**
   * Stops the session's turn, as the webview's stop button does. Rejects `not_running` without a channel.
   * @param {string} sessionId
   */
  async interrupt(sessionId) {
    const target = this._findChannel(sessionId);
    if (!target) throw codeError('not_running');
    this._inject(target.comms, { type: 'interrupt_claude', channelId: target.channelId });
  }

  /** Opens the session where the user keeps Claude Code, as the session list does. Rejects `bad_session` or `open_failed`. @param {string} sessionId */
  async open(sessionId) {
    if (!isText(sessionId)) throw codeError('bad_session');
    await this._command(OPEN_EDITOR, ...editorArgs(sessionId, HONOR_LOCATION));
  }

  /** Opens Claude Code (a new session) where the user keeps it: an editor tab or the sidebar. Rejects `open_failed`. */
  async openClaude() {
    await this._command(OPEN_EDITOR, ...editorArgs(undefined, HONOR_LOCATION));
  }

  /**
   * A VS Code command; rejects `open_failed` (the reason goes to the log).
   * @param {string} id
   * @param {...unknown} args
   * @returns {Promise<void>}
   */
  _command(id, ...args) {
    /** @type {unknown} */
    let run;
    try {
      run = this.vscode.commands.executeCommand(id, ...args);
    } catch (error) {
      run = Promise.reject(error);
    }
    return Promise.resolve(run).then(
      () => undefined,
      (error) => {
        this._say(`window agent: ${id} failed (${errorText(error)})`);
        throw codeError('open_failed');
      },
    );
  }

  // ---- injection ------------------------------------------------------------------------------------------

  /**
   * Webview -> host, through the original fromClient, so the agent does not observe it. Returns what
   * fromClient returned (a failure it rejects with is logged).
   * @param {any} comms
   * @param {Record<string, any>} message
   * @returns {unknown}
   */
  _inject(comms, message) {
    const original = this._originals.get(comms)?.fromClient ?? guard(() => comms.fromClient);
    if (typeof original !== 'function') throw codeError('not_supported');
    const queued = original.call(comms, message);
    if (queued && typeof queued.then === 'function') queued.then(undefined, (/** @type {unknown} */ error) => this._failed(error));
    return queued;
  }

  /** Host -> webview, through the original send. @param {any} comms @param {Record<string, any>} message */
  _post(comms, message) {
    const original = this._originals.get(comms)?.send ?? guard(() => comms.send);
    if (typeof original !== 'function') return;
    const posted = original.call(comms, message);
    if (posted && typeof posted.then === 'function') posted.then(undefined, (/** @type {unknown} */ error) => this._failed(error));
  }

  /**
   * A read of the host (`getSession`, `buildSessionList`), called at once; rejects `timeout` when it has not
   * answered within hostReadMs, so a host that hangs holds up neither a snapshot nor the project. The first
   * time a kind of read is late is logged; what it answers later is ignored.
   * @template T
   * @param {string} kind  what is read, for the log
   * @param {() => T | Promise<T>} read
   * @returns {Promise<T>}
   */
  _hostRead(kind, read) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = unref(
        setTimeout(() => {
          settled = true;
          if (!this._slowReads.has(kind)) {
            this._slowReads.add(kind);
            this._say(`window agent: ${kind} did not come within ${this.hostReadMs} ms; going on without it (logged once)`);
          }
          reject(codeError('timeout'));
        }, this.hostReadMs),
      );
      /** @type {Promise<T>} */
      let answer;
      try {
        answer = Promise.resolve(read());
      } catch (error) {
        answer = Promise.reject(error);
      }
      answer.then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  // ---- waiting --------------------------------------------------------------------------------------------

  /**
   * Resolves with the first value `check` gives other than undefined: at once, after every message the
   * agent sees, and every AGENT_LIMITS.pollMs. Rejects with what `check` throws, or `timeout` after `ms`.
   * Its timers end with it.
   * @template T
   * @param {() => T | undefined} check
   * @param {number} ms
   * @returns {Promise<T>}
   */
  _waitFor(check, ms) {
    return new Promise((resolve, reject) => {
      let done = false;
      /** @type {NodeJS.Timeout | undefined} */
      let poll;
      /** @type {NodeJS.Timeout | undefined} */
      let timer;
      /** @param {(value: any) => void} settle @param {unknown} value */
      const finish = (settle, value) => {
        if (done) return;
        done = true;
        clearInterval(poll);
        clearTimeout(timer);
        this._waiters.delete(attempt);
        settle(value);
      };
      const attempt = () => {
        if (done) return;
        /** @type {T | undefined} */
        let value;
        try {
          value = check();
        } catch (error) {
          finish(reject, error);
          return;
        }
        if (value !== undefined) finish(resolve, value);
      };
      attempt();
      if (done) return;
      this._waiters.add(attempt);
      poll = unref(setInterval(attempt, AGENT_LIMITS.pollMs));
      timer = unref(setTimeout(() => finish(reject, codeError('timeout')), ms));
    });
  }

  _notify() {
    if (this._waiters.size === 0) return;
    for (const attempt of Array.from(this._waiters)) attempt();
  }

  // ---- events and the log -------------------------------------------------------------------------------

  /** @param {string} sessionId @param {SessionEvent} ev */
  _emitSession(sessionId, ev) {
    if (this._enabled) this._emitSafe('session', sessionId, ev);
  }

  /** @param {AttentionEvent} ev */
  _emitAttention(ev) {
    if (this._enabled) this._emitSafe('attention', ev);
  }

  /**
   * A prompt appeared in a session: `waiting`, once per request id (a request the host delivers twice is news
   * once), while remote access is on and at least one `attention` listener is there. A prompt that appeared
   * while remote access was off, or while no hub listened, is not marked: replayAttention() announces it.
   * @param {string} sessionId @param {Pending} pending
   */
  _emitWaiting(sessionId, pending) {
    if (!this._enabled || this._announced.has(pending.requestId)) return;
    if (this.listenerCount('attention') === 0) return;
    this._announced.add(pending.requestId);
    for (const oldest of this._announced) {
      if (this._announced.size <= AGENT_LIMITS.announced) break;
      this._announced.delete(oldest);
    }
    this._emitAttention({
      kind: 'waiting',
      session: sessionId,
      requestId: pending.requestId,
      title: this._titleOf(sessionId),
      prompt: { kind: pending.kind, toolName: pending.toolName, text: promptText(pending) },
    });
  }

  /**
   * A turn ended. What its `done` says is kept for the session, the last turn's over an earlier one: an error is a
   * result that says so (`is_error`) or whose subtype is anything but `success`; `text` is the start of the result's
   * own text. The result the CLI ends a task notification with when it ran no turn for it is no turn (the host does
   * not count it either), so it keeps nothing. `done` goes out once the session is done (_settle). Nothing is kept
   * while remote access is off.
   * @param {any} comms @param {string} channelId @param {string} sessionId @param {Record<string, any>} sdk  the SDK `result` message
   */
  _turnEnded(comms, channelId, sessionId, sdk) {
    const noTurn = sdk.num_turns === 0 && isRecord(sdk.origin) && sdk.origin.kind === 'task-notification';
    if (this._enabled && !noTurn) {
      this._owed.set(sessionId, {
        isError: sdk.is_error === true || (typeof sdk.subtype === 'string' && sdk.subtype !== 'success'),
        durationMs: Number.isFinite(sdk.duration_ms) ? sdk.duration_ms : 0,
        text: attentionText(sdk.result),
      });
    }
    this._settle(comms, channelId, sessionId);
  }

  /**
   * What the CLI's background_tasks_changed lists for the channel: how many tasks the host counts against rest (all
   * but the ambient ones; a list that is not an array counts as one, as the host has it), and whether one is an
   * agent or a workflow, ambient or not: what keeps VS Code's dot blue.
   * @param {any} comms @param {string} channelId @param {unknown} tasks
   */
  _noteTasks(comms, channelId, tasks) {
    const list = Array.isArray(tasks) ? tasks : undefined;
    let byChannel = this._tasks.get(comms);
    if (!byChannel) {
      byChannel = new Map();
      this._tasks.set(comms, byChannel);
    }
    byChannel.set(channelId, {
      running: list ? list.filter((task) => !isRecord(task) || task.ambient !== true).length : 1,
      agents: list ? list.some((task) => isRecord(task) && (task.task_type === 'local_agent' || task.task_type === 'local_workflow')) : false,
    });
  }

  /**
   * `done`, at a result, once the session it ended a turn in is done: the host is at rest (`atRest`: no turn, nothing
   * queued, no background task; a host without it goes by the CLI's last task list), no agent or workflow runs, ambient
   * or not (VS Code's dot would be blue), and no prompt is open (the session waits). A turn that ends while work goes
   * on in the background says nothing yet. Work that ends is taken up by a turn of the CLI's own (its task
   * notification), and that turn's result says it, once. The list emptying is not enough: the host is not at rest
   * after any word from a task until the next result, and a turn may still follow.
   * @param {any} comms @param {string} channelId @param {string} sessionId
   */
  _settle(comms, channelId, sessionId) {
    const owed = this._owed.get(sessionId);
    if (!owed) return;
    const tasks = this._tasks.get(comms)?.get(channelId);
    const atRest = guard(() => this._channelAt(comms, channelId).atRest);
    if (typeof atRest === 'boolean' ? !atRest : (tasks?.running ?? 0) > 0) return;
    if (tasks?.agents === true || this._pendingFor(sessionId).length > 0) return;
    this._owed.delete(sessionId);
    this._emitAttention({ kind: 'done', session: sessionId, title: this._titleOf(sessionId), ...owed });
  }

  /** A listener that throws is logged; the message it came with goes on. @param {string} name @param {...unknown} args */
  _emitSafe(name, ...args) {
    try {
      this.emit(name, ...args);
    } catch (error) {
      this._failed(error);
    }
  }

  /** @param {unknown} error */
  _failed(error) {
    this._failures++;
    if (this._failures <= LOGGED_FAILURES) this._say(`window agent: ${errorText(error)}`);
  }

  /** @param {string} line */
  _say(line) {
    try {
      this.log(line);
    } catch {
      // the log is not the agent's to fix
    }
  }
}

module.exports = { WindowAgent, AGENT_LIMITS };
