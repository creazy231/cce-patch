// @ts-check
'use strict';
// SDK messages -> what the phone gets. Pure functions, no I/O.
//
//   toPhoneMessage(sdk)  one SDK message (io_message.message, or an entry of comms.getSession(id).messages)
//                        -> a compact transcript entry, or null when the phone does not show it
//   toStreamEvent(sdk)   a stream_event -> the live partial-output event, or null
//   mergeHistory(...)    history + live buffer -> the messages of a snapshot: the last 400 that fit in 2 MB
//
// Whatever the CLI sends, what reaches the phone is bounded, so that no transcript can make a frame large:
//   - a message keeps at most CAPS.blocks blocks and CAPS.messageChars characters of content (its text,
//     thinking, results, and the strings and keys of a tool input), each piece also cut to its LIMITS;
//   - identifiers (uuid, ids, names, keys, timestamps, subtypes, titles) are cut to CAPS.identifier;
//   - images, signatures and every field the phone does not use are left out;
//   - the text of a stream event is cut like a text block;
//   - a snapshot keeps the last LIMITS.messages messages, and of those the newest that fit CAPS.snapshotBytes
//     once serialised; the older ones are counted in `truncatedBefore`.
// A 5 MB file read becomes a 3 000 character result. A message that was mapped before is bounded again
// when it comes back through mergeHistory: it is rebuilt from its fields, not trusted.

const LIMITS = Object.freeze({ text: 20000, toolResult: 3000, thinking: 2000, inputString: 4000, messages: 400 });

// What keeps a message and a snapshot bounded as a whole, whatever their parts are. Real sessions stay far below
// them: in the transcripts measured no message had more than 4 blocks or 21 000 characters of content, and no
// identifier was longer than 60.
const CAPS = Object.freeze({
  blocks: 100, // content blocks one message keeps
  messageChars: 100000, // characters of content one message keeps (five whole text blocks)
  identifier: 200, // characters of an id, a name, a key, a timestamp, a subtype or a title
  snapshotBytes: 2 * 1024 * 1024, // bytes of the JSON of a snapshot's messages
});

const TRUNCATED = '…[truncated]';
// What stands where an image was inside a tool result (a result is flattened to text, so a marker block has no place).
const IMAGE_NOTE = '[image omitted]';
// What a value costs a message's budget besides its text: its place in the JSON (quotes, colon, comma). It makes
// numbers, empty strings and keys count too, so that a wide structure is cut instead of copied.
const NODE_COST = 8;
// Tool inputs are shallow; the cap only keeps a pathological nesting from overflowing the stack.
const MAX_INPUT_DEPTH = 32;

/**
 * @typedef {{ type: 'text', text: string }
 *   | { type: 'thinking', text: string }
 *   | { type: 'tool_use', id: string, name: string, input: Record<string, unknown> }
 *   | { type: 'tool_result', toolUseId: string, text: string, isError: boolean }
 *   | { type: 'image', omitted: true }
 *   | { type: 'document', title?: string }} ContentBlock
 */
/** @typedef {{ subtype: string, isError: boolean, durationMs?: number, costUsd?: number, numTurns?: number }} PhoneResult */
/**
 * One transcript entry for the phone. `uuid` is the SDK's, so a phone can match the CLI's replay of a
 * prompt it sent (it is '' only for a `result` that came without one).
 * @typedef {{ uuid: string, type: 'user' | 'assistant' | 'result' | 'system', ts?: string,
 *   content?: ContentBlock[], subtype?: string, isReplay?: boolean, parent?: string, result?: PhoneResult }} PhoneMessage
 */
/** @typedef {{ type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_stop', index?: number, text?: string }} StreamEvent */
/** @typedef {{ left: number }} Budget  the characters a message may still keep */

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

/**
 * The first `max` characters and a marker, when the text is longer. A surrogate pair is never split, and
 * text that this function cut before is left as it is, so that cutting twice is cutting once.
 * @param {string} text
 * @param {number} max
 */
function cut(text, max) {
  if (text.length <= max) return text;
  if (text.length <= max + TRUNCATED.length && text.endsWith(TRUNCATED)) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--; // the pair straddles the limit: leave out its first half
  return text.slice(0, end) + TRUNCATED;
}

/** An identifier, cut to CAPS.identifier. @param {string} value */
function ident(value) {
  return cut(value, CAPS.identifier);
}

/**
 * A text as it goes out: cut to `max` and to what is left of the message's budget, which pays for it.
 * @param {Budget} budget
 * @param {string} text
 * @param {number} max
 */
function spend(budget, text, max) {
  const out = cut(text, Math.min(max, Math.max(0, budget.left)));
  budget.left -= out.length + NODE_COST;
  return out;
}

/**
 * A copy of a tool input that holds JSON values only (anything else is null) and costs the message's budget
 * what it weighs: strings are cut to LIMITS.inputString and keys to CAPS.identifier, and when the budget is gone
 * the rest of the input is left out. A structure that is wide, deep or full of shared nodes is copied only that far.
 * @param {unknown} value
 * @param {Budget} budget
 * @param {number} depth
 * @returns {any}
 */
function boundInput(value, budget, depth) {
  if (typeof value === 'string') return spend(budget, value, LIMITS.inputString);
  budget.left -= NODE_COST;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return null; // undefined, functions, symbols, bigints: not JSON
  if (depth >= MAX_INPUT_DEPTH) {
    budget.left -= TRUNCATED.length; // what the marker costs when it is bounded again as the string it now is
    return TRUNCATED;
  }
  if (Array.isArray(value)) {
    const items = [];
    for (let i = 0; i < value.length && budget.left > 0; i++) items.push(boundInput(value[i], budget, depth + 1));
    return items;
  }
  const record = /** @type {Record<string, unknown>} */ (value);
  /** @type {[string, any][]} */
  const entries = [];
  for (const key of Object.keys(record)) {
    if (budget.left <= 0) break;
    entries.push([spend(budget, key, CAPS.identifier), boundInput(record[key], budget, depth + 1)]);
  }
  return Object.fromEntries(entries); // own keys as data: a `__proto__` key stays a key
}

/**
 * A tool result's content as one text: the string itself, or the text parts of an array, one per line.
 * @param {unknown} content
 */
function flattenResult(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const lines = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    if (part.type === 'text' && isText(part.text)) lines.push(part.text);
    else if (part.type === 'image') lines.push(IMAGE_NOTE);
  }
  return lines.join('\n');
}

/**
 * An SDK content block in the shape of a phone block, its values as they came. An image and a document
 * already have the fields that are read (`type`, `title`); the rest of them is never copied.
 * @param {Record<string, any>} block
 * @returns {Record<string, any> | null}
 */
function readSdkBlock(block) {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text };
    case 'thinking':
      return { type: 'thinking', text: block.thinking };
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input };
    case 'tool_result':
      return { type: 'tool_result', toolUseId: block.tool_use_id, text: flattenResult(block.content), isError: block.is_error === true };
    case 'image':
    case 'document':
      return block;
    default:
      return null;
  }
}

/** A block of a message that was mapped before is in the phone's shape already. @param {Record<string, any>} block */
function readPhoneBlock(block) {
  return block;
}

/**
 * One block of a phone message, bounded: its pieces are cut to their LIMITS and paid for from the message's
 * budget. Null when there is nothing to show (an empty text, a call without an id, a type nobody knows).
 * @param {Record<string, any>} block  in the phone's shape
 * @param {Budget} budget
 * @returns {ContentBlock | null}
 */
function boundBlock(block, budget) {
  switch (block.type) {
    case 'text':
      return isText(block.text) ? { type: 'text', text: spend(budget, block.text, LIMITS.text) } : null;
    case 'thinking': // redacted thinking has nothing to show, and neither has an empty one
      return isText(block.text) ? { type: 'thinking', text: spend(budget, block.text, LIMITS.thinking) } : null;
    case 'tool_use':
      if (!isText(block.id) || !isText(block.name)) return null;
      return { type: 'tool_use', id: ident(block.id), name: ident(block.name), input: isRecord(block.input) ? boundInput(block.input, budget, 0) : {} };
    case 'tool_result':
      if (!isText(block.toolUseId)) return null;
      return {
        type: 'tool_result',
        toolUseId: ident(block.toolUseId),
        text: spend(budget, typeof block.text === 'string' ? block.text : '', LIMITS.toolResult),
        isError: block.isError === true,
      };
    case 'image':
      return { type: 'image', omitted: true };
    case 'document':
      return isText(block.title) ? { type: 'document', title: ident(block.title) } : { type: 'document' };
    default:
      return null;
  }
}

/**
 * The blocks of one message, bounded: at most CAPS.blocks that show something, within the message's budget.
 * @param {unknown} blocks
 * @param {(block: Record<string, any>) => Record<string, any> | null} read  turns a block of the source into the phone's shape
 * @returns {ContentBlock[]}
 */
function boundContent(blocks, read) {
  /** @type {ContentBlock[]} */
  const out = [];
  if (!Array.isArray(blocks)) return out;
  /** @type {Budget} */
  const budget = { left: CAPS.messageChars };
  for (const block of blocks) {
    if (out.length >= CAPS.blocks || budget.left <= 0) break;
    const shaped = isRecord(block) ? read(block) : null;
    const bounded = shaped ? boundBlock(shaped, budget) : null;
    if (bounded) out.push(bounded);
  }
  return out;
}

/**
 * The fields every entry shares: when it happened, and the Task call a subagent's message belongs to.
 * @param {PhoneMessage} out
 * @param {Record<string, any>} message  in the phone's shape
 */
function addEnvelope(out, message) {
  if (isText(message.ts)) out.ts = ident(message.ts);
  if (isText(message.parent)) out.parent = ident(message.parent);
}

/**
 * A message in the phone's shape (`uuid`, `type`, `ts`, `parent`, `isReplay`, and `content`, `result` or
 * `subtype` by type), bounded. Only the fields the phone uses are copied, and each is typed and cut. Null when
 * there is nothing to show: no uuid (a `result` is kept without one), no content, a `system` but the compaction
 * marker, a type nobody knows.
 * @param {Record<string, any>} message
 * @param {(block: Record<string, any>) => Record<string, any> | null} read  how the blocks of `message.content` are read
 * @returns {PhoneMessage | null}
 */
function boundMessage(message, read) {
  switch (message.type) {
    case 'user':
    case 'assistant': {
      if (!isText(message.uuid)) return null;
      const content = boundContent(message.content, read);
      if (content.length === 0) return null;
      /** @type {PhoneMessage} */
      const out = { uuid: ident(message.uuid), type: message.type, content };
      addEnvelope(out, message);
      if (message.isReplay === true) out.isReplay = true;
      return out;
    }
    case 'result': {
      const details = message.result; // an object: toPhoneMessage builds one, and isPhoneShaped asks for one
      /** @type {PhoneResult} */
      const result = { subtype: isText(details.subtype) ? ident(details.subtype) : 'unknown', isError: details.isError === true };
      if (Number.isFinite(details.durationMs)) result.durationMs = details.durationMs;
      if (Number.isFinite(details.costUsd)) result.costUsd = details.costUsd;
      if (Number.isFinite(details.numTurns)) result.numTurns = details.numTurns;
      /** @type {PhoneMessage} */
      const out = { uuid: isText(message.uuid) ? ident(message.uuid) : '', type: 'result', result };
      addEnvelope(out, message);
      return out;
    }
    case 'system': {
      if (message.subtype !== 'compact_boundary' || !isText(message.uuid)) return null;
      /** @type {PhoneMessage} */
      const out = { uuid: ident(message.uuid), type: 'system', subtype: 'compact_boundary' };
      addEnvelope(out, message);
      return out;
    }
    default:
      return null;
  }
}

/**
 * One SDK message as the phone shows it, or null for what it does not: partial output, `system`
 * messages except `compact_boundary`, rate limits, prompt suggestions, `isMeta` rows, and anything
 * without a uuid (a `result` is kept without one) or without anything to show. Bounded, see the top of this file.
 * @param {any} sdk
 * @returns {PhoneMessage | null}
 */
function toPhoneMessage(sdk) {
  if (!isRecord(sdk)) return null;
  switch (sdk.type) {
    case 'user':
    case 'assistant': {
      if (sdk.isMeta || !isRecord(sdk.message)) return null; // meta rows are hidden in VS Code too
      const content = sdk.message.content;
      return boundMessage(
        {
          uuid: sdk.uuid,
          type: sdk.type,
          ts: sdk.timestamp,
          parent: sdk.parent_tool_use_id,
          isReplay: sdk.isReplay,
          content: typeof content === 'string' ? [{ type: 'text', text: content }] : content,
        },
        readSdkBlock,
      );
    }
    case 'result':
      return boundMessage(
        {
          uuid: sdk.uuid,
          type: 'result',
          ts: sdk.timestamp,
          parent: sdk.parent_tool_use_id,
          result: { subtype: sdk.subtype, isError: sdk.is_error === true, durationMs: sdk.duration_ms, costUsd: sdk.total_cost_usd, numTurns: sdk.num_turns },
        },
        readSdkBlock,
      );
    case 'system':
      return boundMessage({ uuid: sdk.uuid, type: 'system', subtype: sdk.subtype, ts: sdk.timestamp, parent: sdk.parent_tool_use_id }, readSdkBlock);
    default:
      return null;
  }
}

const STREAM_TYPES = new Set(['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_stop']);

/**
 * The live part of an assistant message: where a message and its blocks start and stop, and the text
 * deltas (cut like a text block). Tool input, thinking and signature deltas, `message_delta`, and everything a
 * subagent writes (`parent_tool_use_id`) stay out.
 * @param {any} sdk
 * @returns {StreamEvent | null}
 */
function toStreamEvent(sdk) {
  if (!isRecord(sdk) || sdk.type !== 'stream_event' || sdk.parent_tool_use_id) return null;
  const event = sdk.event;
  if (!isRecord(event) || !STREAM_TYPES.has(event.type)) return null;
  /** @type {StreamEvent} */
  const out = { type: event.type };
  if (event.type === 'content_block_delta') {
    const delta = event.delta;
    if (!isRecord(delta) || delta.type !== 'text_delta' || typeof delta.text !== 'string') return null;
    out.text = cut(delta.text, LIMITS.text);
  }
  if (Number.isInteger(event.index)) out.index = event.index;
  return out;
}

// The keys of a phone `system` message; a raw one has more (a session id, compact_metadata, ...).
const PHONE_SYSTEM_KEYS = new Set(['uuid', 'type', 'subtype', 'ts']);

/**
 * Whether an entry is a phone message that was mapped before, as opposed to a raw SDK message: an SDK user
 * or assistant message nests its blocks in `message`, an SDK result keeps its final text (or nothing) in
 * `result`, and an SDK system message has other keys than ours. It decides which way an entry is read
 * (`ts` or `timestamp`, `content` or `message.content`); the entry is bounded and filtered either way.
 * @param {Record<string, any>} entry
 */
function isPhoneShaped(entry) {
  switch (entry.type) {
    case 'user':
    case 'assistant':
      return Array.isArray(entry.content) && !('message' in entry);
    case 'result':
      return isRecord(entry.result);
    case 'system':
      return Object.keys(entry).every((key) => PHONE_SYSTEM_KEYS.has(key));
    default:
      return false;
  }
}

/**
 * @param {unknown} entry  an SDK message or a phone message
 * @returns {PhoneMessage | null}
 */
function asPhoneMessage(entry) {
  if (!isRecord(entry)) return null;
  return isPhoneShaped(entry) ? boundMessage(entry, readPhoneBlock) : toPhoneMessage(entry);
}

/** A message's time in ms, or NaN when it has no usable `ts`. @param {PhoneMessage} message */
function timeOf(message) {
  return typeof message.ts === 'string' ? Date.parse(message.ts) : Number.NaN;
}

/**
 * Where a live-only message that follows nothing placed goes: after the last history message that is not
 * newer than it, before the whole history when every timed one is newer, at the end without a time to go by.
 * @param {PhoneMessage} message
 * @param {PhoneMessage[]} base  the history
 * @param {PhoneMessage[][]} after  the live-only messages after each history message
 * @param {PhoneMessage[]} head
 * @param {PhoneMessage[]} tail
 * @returns {PhoneMessage[]}
 */
function byTime(message, base, after, head, tail) {
  const time = timeOf(message);
  if (Number.isNaN(time)) return tail;
  let timed = false;
  for (let i = base.length - 1; i >= 0; i--) {
    const at = timeOf(/** @type {PhoneMessage} */ (base[i]));
    if (Number.isNaN(at)) continue;
    if (at <= time) return /** @type {PhoneMessage[]} */ (after[i]);
    timed = true;
  }
  return timed ? head : tail;
}

/**
 * The messages of a snapshot, mapped for the phone: the history, with the live messages whose uuid the
 * history does not have put where they happened. The transcript on disk never holds a turn's `result`, so
 * the live buffer is the only source of those. A live-only message goes right after the live message before
 * it (one the history has, or one placed already), so consecutive live-only messages keep their order; one
 * that follows nothing placed goes where its timestamp sorts among the history's, or at the end when it has
 * none. Then the last `limit` messages, and of those the newest that fit `maxBytes` once serialised (as the
 * JSON array goes over the wire, in UTF-8): what is dropped is the oldest. Entries may be SDK messages (as
 * `comms.getSession(id)` and the live stream give them) or phone messages that were mapped before; the SDK
 * ones are mapped here, so what the mapping drops does not count, and the mapped ones are bounded again.
 * Messages without a uuid (a `result`) are never taken for duplicates.
 * @param {unknown[]} history
 * @param {unknown[]} live
 * @param {number} [limit]
 * @param {number} [maxBytes]
 * @returns {{ messages: PhoneMessage[], truncatedBefore: number }}  `truncatedBefore`: how many older messages were cut off
 */
function mergeHistory(history, live, limit = LIMITS.messages, maxBytes = CAPS.snapshotBytes) {
  /** @type {PhoneMessage[]} the history, mapped */
  const base = [];
  for (const entry of Array.isArray(history) ? history : []) {
    const message = asPhoneMessage(entry);
    if (message) base.push(message);
  }
  // Where live-only messages go: before the history (`head`), after base[i] (`after[i]`), or at the end.
  /** @type {PhoneMessage[]} */
  const head = [];
  /** @type {PhoneMessage[][]} */
  const after = base.map(() => []);
  /** @type {PhoneMessage[]} */
  const tail = [];
  /** @type {Map<string, PhoneMessage[]>} uuid → the list the next live-only message after it joins */
  const placed = new Map();
  base.forEach((message, i) => {
    if (message.uuid && !placed.has(message.uuid)) placed.set(message.uuid, /** @type {PhoneMessage[]} */ (after[i]));
  });
  /** @type {PhoneMessage[] | null} the list the next live-only message joins: after the last live message seen */
  let slot = null;
  for (const entry of Array.isArray(live) ? live : []) {
    const message = asPhoneMessage(entry);
    if (!message) continue;
    const known = message.uuid ? placed.get(message.uuid) : undefined;
    if (known) {
      slot = known;
      continue;
    }
    if (!slot) slot = byTime(message, base, after, head, tail);
    slot.push(message);
    if (message.uuid) placed.set(message.uuid, slot);
  }
  /** @type {PhoneMessage[]} */
  const messages = [...head];
  base.forEach((message, i) => messages.push(message, .../** @type {PhoneMessage[]} */ (after[i])));
  messages.push(...tail);

  const keep = typeof limit === 'number' && limit >= 0 ? Math.floor(limit) : LIMITS.messages;
  const room = typeof maxBytes === 'number' && maxBytes >= 0 ? maxBytes : CAPS.snapshotBytes;
  const start = Math.max(0, messages.length - keep); // not slice(-keep): that is everything for 0
  // From the newest message backwards while the array still fits: `[` and `]`, and a comma between messages.
  let first = messages.length;
  let size = 2;
  while (first > start) {
    const next = Buffer.byteLength(JSON.stringify(messages[first - 1])) + (first < messages.length ? 1 : 0);
    if (size + next > room) break;
    size += next;
    first--;
  }
  return { messages: messages.slice(first), truncatedBefore: first };
}

module.exports = { LIMITS, CAPS, toPhoneMessage, toStreamEvent, mergeHistory };
