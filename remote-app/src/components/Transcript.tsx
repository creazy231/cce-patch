// The transcript of a session: the view model from lib/transcript.ts drawn as a phone-sized reading column.
// Nothing here turns message content into a link or an image source: only sanitised Markdown has links.

import type { ComponentChildren, JSX } from "preact";
import { useMemo, useState } from "preact/hooks";
import type { Chip, TodoItem, Todos, ToolItem, ToolResult, TranscriptItem } from "../lib/transcript";
import { errorText, isUnconfirmed, shortPath, toolLabel } from "../state/format";
import type { Outgoing } from "../state/store";
import { renderMarkdown } from "./markdown";
import {
  Agent,
  Bell,
  Check,
  ChevronRight,
  Cube,
  FileIcon,
  Globe,
  Layers,
  ListCheck,
  Paperclip,
  Pencil,
  Photo,
  PlanIcon,
  Plug,
  Question,
  Search,
  SelectionIcon,
  Slash,
  SpeakerIcon,
  Stop,
  Terminal,
  Thinking,
} from "./icons";
import { Spinner, memo, useApp } from "./ui";

// ---- Markdown ----

export const Markdown = memo(function Markdown({ text, live = false }: { text: string; live?: boolean }) {
  const html = useMemo(() => renderMarkdown(text, { cacheable: !live }), [text, live]);
  return <div class="md" dir="auto" dangerouslySetInnerHTML={{ __html: html }} />;
});

// ---- the list ----

/** What the session is doing: tool calls without a result show a spinner only while it runs. */
export type Activity = "running" | "waiting" | "idle";

export interface TranscriptProps {
  items: TranscriptItem[];
  stream: string;
  activity: Activity;
  outgoing: Record<string, Outgoing>;
  onRetry: (uuid: string) => void;
  onDiscard: (uuid: string) => void;
}

export function Transcript({ items, stream, activity, outgoing, onRetry, onDiscard }: TranscriptProps) {
  // buildTranscript puts unconfirmed local messages last; the streaming text goes just before them.
  const split = items.findIndex((item) => item.kind === "user" && item.status !== undefined);
  const settled = split < 0 ? items : items.slice(0, split);
  const outbox = split < 0 ? [] : items.slice(split);
  return (
    <>
      {settled.map((item) => (
        <Item key={item.id} item={item} activity={activity} />
      ))}
      {stream.trim() && (
        <div class="t-item t-text streaming" aria-live="off">
          <Markdown text={stream} live />
        </div>
      )}
      {outbox.map((item) =>
        item.kind === "user" ? (
          <OutgoingMessage key={item.id} item={item} entry={outgoing[item.id]} onRetry={onRetry} onDiscard={onDiscard} />
        ) : null,
      )}
    </>
  );
}

const Item = memo(function Item({ item, activity }: { item: TranscriptItem; activity: Activity }) {
  switch (item.kind) {
    case "user":
      return (
        <div class="t-item t-user">
          <Bubble text={item.text} chips={item.chips} images={item.images} />
        </div>
      );
    case "assistant-text":
      return (
        <div class="t-item t-text">
          <Markdown text={item.text} />
          <SpeakButton id={item.id} text={item.text} />
        </div>
      );
    case "thinking":
      return <ThinkingItem text={item.text} />;
    case "tool":
      return <ToolRow tool={item} activity={activity} />;
    case "todos":
      return (
        <div class="t-item t-todos">
          <TodoList todos={item} />
        </div>
      );
    case "result":
      return (
        <div class={`t-item t-result ${item.ok ? "ok" : "fail"}`} role="note">
          <span class="rule" aria-hidden="true" />
          <span class="t-result-label">
            {item.ok ? <Check size={13} stroke={2.4} /> : null}
            {item.label}
          </span>
          <span class="rule" aria-hidden="true" />
        </div>
      );
    case "compact":
      return <CompactItem summary={item.summary} />;
    case "streaming":
      return (
        <div class="t-item t-text streaming">
          <Markdown text={item.text} live />
        </div>
      );
  }
});

// ---- read aloud ----

/** Reads a reply aloud, or stops it while it is the one being read. Hidden where the browser can't speak. */
function SpeakButton({ id, text }: { id: string; text: string }) {
  const { state, store } = useApp();
  if (!state.speech.supported) return null;
  const speaking = state.speech.current === id;
  return (
    <button
      type="button"
      class={speaking ? "t-speak on" : "t-speak"}
      aria-label={speaking ? "Stop reading" : "Read aloud"}
      aria-pressed={speaking}
      onClick={() => store.toggleSpeak(id, text)}
    >
      {speaking ? <Stop size={14} /> : <SpeakerIcon size={16} />}
    </button>
  );
}

// ---- user messages ----

const CHIP_ICON: Record<Chip["kind"], (props: { size?: number }) => JSX.Element> = {
  selection: SelectionIcon,
  file: FileIcon,
  command: Slash,
  terminal: Terminal,
  notification: Bell,
  attachment: Paperclip,
};

const LONG_TEXT = 700;

function Bubble({ text, chips, images }: { text: string; chips: Chip[]; images: number }) {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > LONG_TEXT;
  return (
    <div class="bubble">
      {(chips.length > 0 || images > 0) && (
        <div class="chips">
          {chips.map((chip, index) => {
            const Icon = CHIP_ICON[chip.kind];
            return (
              <span key={index} class={`chip chip-${chip.kind}`}>
                <Icon size={12} />
                <span class="chip-label">{chip.label}</span>
              </span>
            );
          })}
          {images > 0 && (
            <span class="chip chip-photo">
              <Photo size={12} />
              <span class="chip-label">{images === 1 ? "1 photo" : `${images} photos`}</span>
            </span>
          )}
        </div>
      )}
      {text && (
        <div class={`bubble-text ${long && !expanded ? "clamped" : ""}`} dir="auto">
          {text}
        </div>
      )}
      {long && (
        <button type="button" class="bubble-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

function OutgoingMessage(props: {
  item: Extract<TranscriptItem, { kind: "user" }>;
  entry: Outgoing | undefined;
  onRetry: (uuid: string) => void;
  onDiscard: (uuid: string) => void;
}) {
  const { item, entry } = props;
  const failed = item.status === "failed" || entry?.status === "failed";
  const code = entry?.error ?? "failed";
  let label: string;
  if (!failed) label = entry?.status === "sent" ? "Sent" : "Sending…";
  else if (code === "not_connected") label = "Not sent: not connected.";
  else if (isUnconfirmed(code)) label = "Not confirmed. It may have reached the Mac.";
  else label = `Not sent. ${errorText(code)}`;
  return (
    <div class={`t-item t-user outgoing ${failed ? "failed" : ""}`}>
      <Bubble text={item.text} chips={item.chips} images={item.images} />
      <div class="msg-status" role={failed ? "alert" : "status"}>
        {!failed && entry?.status !== "sent" && <Spinner size={11} />}
        <span>{label}</span>
        {failed && entry && (
          <span class="msg-actions">
            <button type="button" class="link-btn" onClick={() => props.onRetry(item.id)}>
              Send again
            </button>
            <button type="button" class="link-btn quiet" onClick={() => props.onDiscard(item.id)}>
              Discard
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

// ---- folded things ----

function ThinkingItem({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`t-item t-fold ${open ? "open" : ""}`}>
      <button type="button" class="fold-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Thinking size={16} />
        <span>Thinking</span>
        <ChevronRight size={14} stroke={2.2} class="fold-chevron" />
      </button>
      {open && (
        <div class="fold-body thinking-text" dir="auto">
          {text}
        </div>
      )}
    </div>
  );
}

function CompactItem({ summary }: { summary?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div class={`t-item t-compact ${open ? "open" : ""}`}>
      <div class="compact-line">
        <span class="rule" aria-hidden="true" />
        {summary ? (
          <button type="button" class="compact-label" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Layers size={14} />
            Context compacted
            <ChevronRight size={12} stroke={2.4} class="fold-chevron" />
          </button>
        ) : (
          <span class="compact-label">
            <Layers size={14} />
            Context compacted
          </span>
        )}
        <span class="rule" aria-hidden="true" />
      </div>
      {open && summary && <div class="fold-body compact-summary">{summary}</div>}
    </div>
  );
}

// ---- todos ----

function TodoMark({ status }: { status: TodoItem["status"] }) {
  if (status === "completed")
    return (
      <span class="todo-mark done" aria-label="Done">
        <Check size={12} stroke={2.8} />
      </span>
    );
  if (status === "in_progress") return <span class="todo-mark active" aria-label="In progress" />;
  return <span class="todo-mark" aria-label="To do" />;
}

export function TodoList({ todos, bare = false }: { todos: Todos; bare?: boolean }) {
  return (
    <div class={bare ? "todos bare" : "todos"}>
      {!bare && (
        <div class="todos-head">
          <ListCheck size={16} />
          <span>Todos</span>
          <span class="todos-count">
            {todos.done}/{todos.total}
          </span>
        </div>
      )}
      <ul class="todo-list">
        {todos.items.map((item, index) => (
          <li key={index} class={`todo ${item.status}`}>
            <TodoMark status={item.status} />
            <span class="todo-text">{item.status === "in_progress" && item.activeForm ? item.activeForm : item.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- tool rows ----

function toolIcon(name: string) {
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return <Terminal size={15} />;
    case "Read":
      return <FileIcon size={15} />;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return <Pencil size={15} />;
    case "Grep":
    case "Glob":
      return <Search size={15} />;
    case "WebFetch":
    case "WebSearch":
      return <Globe size={15} />;
    case "Task":
    case "Agent":
      return <Agent size={15} />;
    case "TodoWrite":
      return <ListCheck size={15} />;
    case "AskUserQuestion":
      return <Question size={15} />;
    case "ExitPlanMode":
      return <PlanIcon size={15} />;
    default:
      return name.startsWith("mcp__") ? <Plug size={15} /> : <Cube size={15} />;
  }
}

/** Summaries that are code or paths read better in monospace. */
const MONO_SUMMARY = new Set(["Bash", "Read", "Edit", "MultiEdit", "Write", "NotebookEdit", "Glob", "Grep"]);

const ToolRow = memo(function ToolRow({ tool, activity, nested = false }: { tool: ToolItem; activity: Activity; nested?: boolean }) {
  const [open, setOpen] = useState(false);
  const status = tool.result ? (tool.result.isError ? "error" : "done") : activity;
  const steps = tool.children.filter((child) => child.kind === "tool").length;
  return (
    <div class={`t-item t-tool st-${status} ${open ? "open" : ""} ${nested ? "nested" : ""}`}>
      <button type="button" class="tool-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span class="tool-icon">{toolIcon(tool.name)}</span>
        <span class="tool-name">{toolLabel(tool.name)}</span>
        <span class={`tool-summary ${MONO_SUMMARY.has(tool.name) ? "mono" : ""}`}>{tool.summary}</span>
        {steps > 0 && <span class="tool-steps">{steps === 1 ? "1 step" : `${steps} steps`}</span>}
        <span
          class="tool-status"
          aria-label={status === "error" ? "Failed" : status === "running" ? "Running" : status === "waiting" ? "Waiting for you" : status === "done" ? "Done" : undefined}
        >
          {status === "running" ? (
            <Spinner size={13} />
          ) : status === "waiting" ? (
            <span class="wait-mark" />
          ) : status === "error" ? (
            <span class="err-mark">!</span>
          ) : status === "done" ? (
            <Check size={14} stroke={2.2} />
          ) : null}
        </span>
      </button>
      {open && <ToolDetails tool={tool} activity={activity} />}
    </div>
  );
});

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string) : "");

function PathLine({ path }: { path: string }) {
  if (!path) return null;
  return <div class="td-path mono">{shortPath(path)}</div>;
}

function Code({ text, tone }: { text: string; tone?: "error" }) {
  if (!text) return null;
  return (
    <pre class={`code ${tone ?? ""}`}>
      <code>{text}</code>
    </pre>
  );
}

function Diff({ before, after }: { before: string; after: string }) {
  const lines = (text: string) => (text === "" ? [] : text.replace(/\n$/, "").split("\n"));
  return (
    <pre class="code diff">
      <code>
        {lines(before).map((line, i) => (
          <span key={`d${i}`} class="del">
            {line || " "}
            {"\n"}
          </span>
        ))}
        {lines(after).map((line, i) => (
          <span key={`a${i}`} class="add">
            {line || " "}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

function Fields({ input, keys }: { input: Record<string, unknown>; keys: string[] }) {
  const rows = keys.filter((key) => input[key] !== undefined && input[key] !== "" && input[key] !== null);
  if (rows.length === 0) return null;
  return (
    <dl class="td-fields">
      {rows.map((key) => (
        <div key={key} class="td-field">
          <dt>{key.replace(/_/g, " ")}</dt>
          <dd class={key === "pattern" || key === "path" || key === "glob" || key === "url" ? "mono" : ""}>{String(input[key])}</dd>
        </div>
      ))}
    </dl>
  );
}

function ResultBlock({ result }: { result: ToolResult }) {
  if (!result.text.trim()) return <div class="td-label">{result.isError ? "Failed, no output" : "No output"}</div>;
  return (
    <div class="td-result">
      <div class="td-label">{result.isError ? "Error" : "Result"}</div>
      <Code text={result.text} tone={result.isError ? "error" : undefined} />
    </div>
  );
}

function ToolDetails({ tool, activity }: { tool: ToolItem; activity: Activity }) {
  const input = tool.input;
  let body: ComponentChildren;
  switch (tool.name) {
    case "Bash":
      body = (
        <>
          {str(input, "description") && <p class="td-note">{str(input, "description")}</p>}
          <Code text={str(input, "command")} />
        </>
      );
      break;
    case "Edit":
      body = (
        <>
          <PathLine path={str(input, "file_path")} />
          <Diff before={str(input, "old_string")} after={str(input, "new_string")} />
        </>
      );
      break;
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Array<Record<string, unknown>>) : [];
      body = (
        <>
          <PathLine path={str(input, "file_path")} />
          {edits.map((edit, i) => (edit && typeof edit === "object" ? <Diff key={i} before={str(edit, "old_string")} after={str(edit, "new_string")} /> : null))}
        </>
      );
      break;
    }
    case "Write":
      body = (
        <>
          <PathLine path={str(input, "file_path")} />
          <Code text={str(input, "content")} />
        </>
      );
      break;
    case "Read":
    case "NotebookEdit":
      body = (
        <>
          <PathLine path={str(input, "file_path") || str(input, "notebook_path")} />
          <Fields input={input} keys={["offset", "limit"]} />
        </>
      );
      break;
    case "Grep":
    case "Glob":
      body = <Fields input={input} keys={["pattern", "path", "glob", "type", "output_mode"]} />;
      break;
    case "WebFetch":
    case "WebSearch":
      // Shown as text: a URL from a message never becomes a link here.
      body = <Fields input={input} keys={["url", "query", "prompt"]} />;
      break;
    case "Task":
    case "Agent":
      body = (
        <>
          {str(input, "prompt") && <p class="td-prompt">{str(input, "prompt")}</p>}
          {tool.children.length > 0 && (
            <div class="td-children">
              {tool.children.map((child) =>
                child.kind === "tool" ? <ToolRow key={child.id} tool={child} activity={activity} nested /> : <Item key={child.id} item={child} activity={activity} />,
              )}
            </div>
          )}
        </>
      );
      break;
    case "ExitPlanMode":
      body = <Markdown text={str(input, "plan")} />;
      break;
    case "AskUserQuestion": {
      const questions = Array.isArray(input.questions) ? (input.questions as Array<Record<string, unknown>>) : [];
      body = (
        <ul class="td-questions">
          {questions.map((q, i) => (q && typeof q === "object" ? <li key={i}>{str(q, "question")}</li> : null))}
        </ul>
      );
      break;
    }
    default:
      body = Object.keys(input).length > 0 ? <Code text={JSON.stringify(input, null, 2)} /> : null;
  }
  return (
    <div class="tool-body">
      {body}
      {tool.result ? (
        <ResultBlock result={tool.result} />
      ) : activity === "running" ? (
        <div class="td-label">Running…</div>
      ) : activity === "waiting" ? (
        <div class="td-label">Waiting for you</div>
      ) : null}
    </div>
  );
}
