// The view model of a session: turns the bridge's flat list of messages into the items the
// session screen draws. Pure functions, no DOM.

import type { ContentBlock, PhoneMessage, PhoneResult, StreamEvent } from "./protocol";

// ---- types --------------------------------------------------------------------------------------

export interface Chip {
  kind: "selection" | "file" | "command" | "terminal" | "notification" | "attachment";
  label: string;
}

export interface TodoItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

export interface Todos {
  done: number;
  total: number;
  items: TodoItem[];
}

export interface ToolResult {
  text: string;
  isError: boolean;
}

/**
 * A message the app made itself while it waits for the bridge to confirm it: shown as "sending…",
 * or "failed" when the send was rejected. The state layer gives it the uuid the bridge returned in
 * the ack, so that the CLI's replay (same uuid) replaces it.
 */
export type LocalMessage = PhoneMessage & { local?: "sending" | "failed" };

export type ToolItem = {
  kind: "tool";
  /** The tool_use id. */
  id: string;
  name: string;
  /** One line: the command, file name, pattern, host or task description. */
  summary: string;
  input: Record<string, unknown>;
  /** Attached when the tool_result arrives; undefined while the tool runs. */
  result?: ToolResult;
  /** A Task/Agent call's subagent messages, folded under it. */
  children: TranscriptItem[];
};

export type TranscriptItem =
  | { kind: "user"; id: string; text: string; chips: Chip[]; images: number; status?: "sending" | "failed" }
  | { kind: "assistant-text"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string }
  | ToolItem
  | ({ kind: "todos"; id: string } & Todos)
  | { kind: "result"; id: string; ok: boolean; subtype: string; label: string; durationMs?: number; costUsd?: number }
  | { kind: "compact"; id: string; summary?: string }
  | { kind: "streaming"; id: string; text: string };

// ---- small text helpers -------------------------------------------------------------------------

const SUMMARY_MAX = 120;

/** One line, whitespace collapsed, cut with an ellipsis. */
function clip(text: string, max = SUMMARY_MAX): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  return `${[...flat].slice(0, max - 1).join("").trimEnd()}…`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

// The bridge maps whatever the CLI emits, so a message may be odd. These keep one bad message from
// breaking the whole screen: anything of the wrong shape is skipped.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function blocksOf(message: PhoneMessage): ContentBlock[] {
  return Array.isArray(message.content) ? message.content.filter((block) => isRecord(block)) : [];
}

function parentOf(message: PhoneMessage): string | undefined {
  return typeof message.parent === "string" && message.parent ? message.parent : undefined;
}

// ---- tool rows ----------------------------------------------------------------------------------

const GENERIC_KEYS = ["command", "file_path", "path", "pattern", "query", "url", "description", "subject", "prompt"];

/** The key argument of a tool call, short enough for one row. */
export function toolSummary(name: string, input: Record<string, unknown>): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : "");
  switch (name) {
    case "Bash":
      return clip(str("command"));
    case "Read":
    case "Edit":
    case "MultiEdit":
    case "Write":
      return baseName(str("file_path"));
    case "NotebookEdit":
      return baseName(str("notebook_path"));
    case "Glob":
    case "Grep":
      return clip(str("pattern"));
    case "WebFetch": {
      const url = str("url");
      try {
        return new URL(url).host || clip(url);
      } catch {
        return clip(url);
      }
    }
    case "WebSearch":
      return clip(str("query"));
    case "Task":
    case "Agent":
      return clip(str("description") || str("subagent_type"));
    case "AskUserQuestion": {
      const first = Array.isArray(input.questions) ? (input.questions[0] as { question?: unknown } | undefined) : undefined;
      return typeof first?.question === "string" ? clip(first.question) : "";
    }
    case "ExitPlanMode":
      return "Plan";
    default: {
      for (const key of GENERIC_KEYS) if (str(key)) return clip(str(key));
      const first = Object.values(input).find((value): value is string => typeof value === "string" && value !== "");
      return first ? clip(first) : "";
    }
  }
}

// ---- IDE context in user messages ---------------------------------------------------------------

// Tags the extension and the CLI put into user messages.
const WRAPPER =
  /<(system-reminder|ide_selection|ide_opened_file|local-command-caveat|local-command-stdout|local-command-stderr|task-notification|command-name|command-message|command-args|terminal)((?:\s[^>]*)?)>([\s\S]*?)<\/\1>/g;

function selectionLabel(inner: string): string {
  // "The user selected the lines 3 to 9 from /a/b.ts:\n<code>\n\nThis may or may not be related…"
  // `.` stops at the line end: only the first line is read, up to its last colon, so the code below cannot confuse the path.
  const match = /^The user selected the lines (\d+) to (\d+) from (.+):/.exec(inner.trimStart());
  if (!match) return "Selection";
  const [, from = "", to = "", path = ""] = match;
  return `${baseName(path)}:${from === to ? from : `${from}-${to}`}`;
}

function openedFileLabel(inner: string): string {
  // "The user opened the file /a/b/x.ts in the IDE. This may or may not be related…"
  const text = inner.trim();
  const match = /^The user opened (?:the )?file (.+?) in (?:the )?(?:IDE|editor)\b/.exec(text);
  // Other wording: the first thing that looks like a path.
  const path = match?.[1] ?? /\S*[\\/]\S+/.exec(text)?.[0];
  const name = path ? baseName(path).replace(/[^\p{L}\p{N}]+$/u, "") : "";
  return name || "File";
}

/**
 * Takes the IDE's context tags out of a user message's text. `<ide_selection>`, `<ide_opened_file>`,
 * `<terminal>`, slash commands and background-task notices become chips; `<system-reminder>` and the
 * local-command caveat are dropped; local command output keeps its text.
 */
export function splitIdeContext(input: string): { text: string; chips: Chip[] } {
  const chips: Chip[] = [];
  let touched = false;
  const stripped = input.replace(WRAPPER, (_all, tag: string, attrs: string, inner: string) => {
    touched = true;
    switch (tag) {
      case "ide_selection":
        chips.push({ kind: "selection", label: selectionLabel(inner) });
        return "";
      case "ide_opened_file":
        chips.push({ kind: "file", label: openedFileLabel(inner) });
        return "";
      case "terminal":
        chips.push({ kind: "terminal", label: /name="([^"]*)"/.exec(attrs)?.[1] || "Terminal" });
        return "";
      case "task-notification":
        chips.push({
          kind: "notification",
          label: clip(/<summary>([\s\S]*?)<\/summary>/.exec(inner)?.[1] ?? "") || "Background task",
        });
        return "";
      case "command-name":
        chips.push({ kind: "command", label: inner.trim() || "Command" });
        return "";
      case "command-args": {
        const args = inner.trim();
        const command = chips[chips.length - 1];
        if (args && command?.kind === "command") command.label += ` ${args}`;
        return "";
      }
      case "local-command-stdout":
      case "local-command-stderr":
        return inner;
      default: // system-reminder, command-message, local-command-caveat
        return "";
    }
  });
  // Only text that had tags removed is tidied; what the user typed keeps its blank lines.
  return { text: touched ? stripped.replace(/\n{3,}/g, "\n\n").trim() : input.trim(), chips };
}

// ---- todos --------------------------------------------------------------------------------------

function parseTodos(input: Record<string, unknown>): Todos | null {
  if (!Array.isArray(input.todos)) return null;
  const items: TodoItem[] = [];
  for (const raw of input.todos) {
    if (!raw || typeof raw !== "object") continue;
    const { content, status, activeForm } = raw as Record<string, unknown>;
    if (typeof content !== "string") continue;
    const item: TodoItem = { content, status: status === "completed" || status === "in_progress" ? status : "pending" };
    if (typeof activeForm === "string") item.activeForm = activeForm;
    items.push(item);
  }
  return { items, done: items.filter((i) => i.status === "completed").length, total: items.length };
}

/** The most recent TodoWrite of the main conversation (subagents don't count); null when there is none or it is empty. */
export function latestTodos(messages: readonly PhoneMessage[]): Todos | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.type !== "assistant" || parentOf(message)) continue;
    const blocks = blocksOf(message);
    for (let j = blocks.length - 1; j >= 0; j--) {
      const block = blocks[j];
      if (block?.type !== "tool_use" || block.name !== "TodoWrite" || !isRecord(block.input)) continue;
      const todos = parseTodos(block.input);
      if (todos) return todos.total > 0 ? todos : null;
    }
  }
  return null;
}

// ---- durations and turn results -----------------------------------------------------------------

/** 400ms, 5s, 1m 12s, 1h 2m. */
export function formatDuration(ms: number): string {
  if (!(ms > 0)) return "0s";
  if (ms < 1000) return `${Math.floor(ms)}ms`;
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return m ? `${h}h ${m}m` : `${h}h`;
  if (m) return s ? `${m}m ${s}s` : `${m}m`;
  return `${s}s`;
}

function resultLabel(result: PhoneResult): { ok: boolean; label: string } {
  const took = typeof result.durationMs === "number" ? formatDuration(result.durationMs) : "";
  if (result.subtype === "error_max_turns") return { ok: false, label: "Stopped: turn limit reached" };
  if (result.subtype === "error_max_budget_usd") return { ok: false, label: "Stopped: budget limit reached" };
  if (result.isError || result.subtype !== "success") return { ok: false, label: took ? `Stopped after ${took}` : "Stopped" };
  return { ok: true, label: took ? `Done in ${took}` : "Done" };
}

// ---- streaming text -----------------------------------------------------------------------------

/** The text of the assistant message that is being written right now, per content block. */
export interface StreamState {
  readonly blocks: Readonly<Record<number, string>>;
}

export const EMPTY_STREAM: StreamState = Object.freeze({ blocks: Object.freeze({}) });

const blockIndex = (event: StreamEvent): number => (Number.isInteger(event.index) ? (event.index as number) : 0);

/** Folds one `stream` event into the state (returns a new state, never changes the old one). */
export function applyStreamEvent(state: StreamState, event: StreamEvent): StreamState {
  switch (event.type) {
    case "message_start":
      return EMPTY_STREAM;
    case "content_block_start": {
      const index = blockIndex(event);
      return index in state.blocks ? state : { blocks: { ...state.blocks, [index]: "" } };
    }
    case "content_block_delta": {
      if (typeof event.text !== "string" || event.text === "") return state;
      const index = blockIndex(event);
      return { blocks: { ...state.blocks, [index]: (state.blocks[index] ?? "") + event.text } };
    }
    default: // content_block_stop, message_stop: the text stays until the complete message replaces it
      return state;
  }
}

export function streamText(state: StreamState): string {
  return Object.keys(state.blocks)
    .map(Number)
    .sort((a, b) => a - b)
    .map((index) => state.blocks[index] ?? "")
    .filter((text) => text !== "")
    .join("\n\n");
}

/**
 * What the streamed text becomes when a message arrives: a complete assistant message with text, or
 * the end of the turn, replaces it. Subagent messages and tool results leave it alone.
 */
export function streamAfterMessage(state: StreamState, message: PhoneMessage): StreamState {
  if (parentOf(message)) return state;
  if (message.type === "result") return EMPTY_STREAM;
  if (message.type === "assistant" && blocksOf(message).some((block) => block.type === "text")) return EMPTY_STREAM;
  return state;
}

// ---- building the list --------------------------------------------------------------------------

const COMPACT_SUMMARY = /^This session is being continued from a previous conversation/;

// What the CLI writes into the transcript when a turn is stopped; the extension shows it as a notice, not as a message.
const INTERRUPTS = new Map([
  ["[Request interrupted by user]", "Interrupted"],
  ["[Request interrupted by user for tool use]", "Tool interrupted"],
]);

const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

/** What a user message shows: its text and chips, the number of images; tool results are attached to their tool rows. */
function readUser(message: PhoneMessage, tools: Map<string, ToolItem> | null) {
  const chips: Chip[] = [];
  const texts: string[] = [];
  let images = 0;
  for (const block of blocksOf(message)) {
    switch (block.type) {
      case "tool_result": {
        const tool = typeof block.toolUseId === "string" ? tools?.get(block.toolUseId) : undefined;
        if (tool) {
          const raw = typeof block.text === "string" ? block.text : "";
          // The CLI appends reminders to some results; they are for Claude, not for the person.
          tool.result = { text: raw.includes("<system-reminder>") ? raw.replace(REMINDER, "").trim() : raw, isError: block.isError === true };
        }
        break;
      }
      case "text": {
        if (typeof block.text !== "string") break;
        const part = splitIdeContext(block.text);
        chips.push(...part.chips);
        if (part.text) texts.push(part.text);
        break;
      }
      case "image":
        images++;
        break;
      case "document":
        chips.push({ kind: "attachment", label: (typeof block.title === "string" && block.title.trim()) || "Document" });
        break;
      default:
        break;
    }
  }
  return { text: texts.join("\n\n"), chips, images };
}

function addAssistant(target: TranscriptItem[], tools: Map<string, ToolItem>, message: PhoneMessage, base: string) {
  blocksOf(message).forEach((block: ContentBlock, index: number) => {
    const id = `${base}#${index}`;
    switch (block.type) {
      case "text":
        if (typeof block.text === "string" && block.text.trim()) target.push({ kind: "assistant-text", id, text: block.text });
        break;
      case "thinking":
        if (typeof block.text === "string" && block.text.trim()) target.push({ kind: "thinking", id, text: block.text });
        break;
      case "tool_use": {
        if (typeof block.id !== "string" || typeof block.name !== "string") break;
        const input = isRecord(block.input) ? block.input : {};
        const todos = block.name === "TodoWrite" ? parseTodos(input) : null;
        if (todos) {
          // A checklist, not a tool row; clearing the list shows nothing.
          if (todos.total > 0) target.push({ kind: "todos", id: block.id, ...todos });
          break;
        }
        const tool: ToolItem = {
          kind: "tool",
          id: block.id,
          name: block.name,
          summary: toolSummary(block.name, input),
          input,
          children: [],
        };
        tools.set(block.id, tool);
        target.push(tool);
        break;
      }
      default:
        break;
    }
  });
}

function addUser(target: TranscriptItem[], tools: Map<string, ToolItem>, message: PhoneMessage, id: string, isSubagent: boolean) {
  const { text, chips, images } = readUser(message, tools);
  // A subagent's prompt repeats the Task call's input; only its tool results (attached above) matter.
  if (isSubagent) return;
  if (!text && chips.length === 0 && images === 0) return;
  const interruption = INTERRUPTS.get(text);
  if (interruption && chips.length === 0 && images === 0) {
    target.push({ kind: "result", id, ok: false, subtype: "interrupted", label: interruption });
    return;
  }
  if (COMPACT_SUMMARY.test(text)) {
    const previous = target[target.length - 1];
    if (previous?.kind === "compact" && previous.summary === undefined) previous.summary = text;
    else target.push({ kind: "compact", id, summary: text });
    return;
  }
  target.push({ kind: "user", id, text, chips, images });
}

function addMessage(root: TranscriptItem[], tools: Map<string, ToolItem>, message: PhoneMessage, index: number) {
  if (!isRecord(message)) return;
  const id = (typeof message.uuid === "string" && message.uuid) || `message-${index}`;
  const parentId = parentOf(message);
  let target = root;
  if (parentId) {
    const parent = tools.get(parentId);
    if (!parent) return; // the Task call is not in view (cut off by truncatedBefore)
    target = parent.children;
  }
  switch (message.type) {
    case "assistant":
      addAssistant(target, tools, message, id);
      break;
    case "user":
      addUser(target, tools, message, id, parentId !== undefined);
      break;
    case "result": {
      const result = message.result;
      if (!isRecord(result) || typeof result.subtype !== "string" || parentId) break;
      const { ok, label } = resultLabel(result);
      const item: TranscriptItem = { kind: "result", id, ok, subtype: result.subtype, label };
      if (typeof result.durationMs === "number") item.durationMs = result.durationMs;
      if (typeof result.costUsd === "number") item.costUsd = result.costUsd;
      target.push(item);
      break;
    }
    case "system":
      if (message.subtype === "compact_boundary") target.push({ kind: "compact", id });
      break;
    default:
      break;
  }
}

/** Splits the messages into the confirmed ones (one per uuid, the latest content) and the local ones nobody confirmed yet. */
function settle(messages: readonly LocalMessage[]) {
  const position = new Map<string, number>();
  const real: PhoneMessage[] = [];
  const locals = new Map<string, LocalMessage>();
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.local) {
      locals.set(message.uuid, message);
      continue;
    }
    const known = message.uuid ? position.get(message.uuid) : undefined;
    if (known !== undefined) {
      real[known] = message;
      continue;
    }
    if (message.uuid) position.set(message.uuid, real.length);
    real.push(message);
  }
  const outbox = [...locals.values()].filter((message) => !position.has(message.uuid));
  return { real, outbox };
}

/**
 * The items of a session screen, top to bottom.
 *
 * - A tool_use and its tool_result become one `tool` item (attached by tool_use id); `TodoWrite`
 *   becomes a `todos` item; messages with a `parent` fold under that Task call.
 * - Messages with the same uuid show once, with the latest content (the CLI's replay of a prompt
 *   carries the uuid of the message the phone sent). A `local` message nobody has confirmed yet goes
 *   to the very end with its status, and disappears when the real message with its uuid arrives.
 * - `stream` is the text being written right now (see `streamText`); it follows the real messages.
 */
export function buildTranscript(messages: readonly LocalMessage[], stream?: string | null): TranscriptItem[] {
  const { real, outbox } = settle(messages);
  const items: TranscriptItem[] = [];
  const tools = new Map<string, ToolItem>();
  real.forEach((message, index) => addMessage(items, tools, message, index));

  if (stream && stream.trim()) items.push({ kind: "streaming", id: "streaming", text: stream });

  for (const message of outbox) {
    const { text, chips, images } = readUser(message, null);
    if (!text && chips.length === 0 && images === 0) continue;
    items.push({ kind: "user", id: message.uuid, text, chips, images, status: message.local });
  }
  return items;
}
