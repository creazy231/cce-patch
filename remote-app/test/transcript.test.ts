import { describe, expect, test } from "bun:test";
import type { ContentBlock, PhoneMessage } from "../src/lib/protocol";
import {
  applyStreamEvent,
  buildTranscript,
  EMPTY_STREAM,
  formatDuration,
  latestTodos,
  splitIdeContext,
  streamAfterMessage,
  streamText,
  toolSummary,
  type LocalMessage,
} from "../src/lib/transcript";

const text = (t: string): ContentBlock => ({ type: "text", text: t });
const toolUse = (id: string, name: string, input: Record<string, unknown>): ContentBlock => ({
  type: "tool_use",
  id,
  name,
  input,
});
const toolResult = (toolUseId: string, t: string, isError?: boolean): ContentBlock =>
  isError === undefined ? { type: "tool_result", toolUseId, text: t } : { type: "tool_result", toolUseId, text: t, isError };
const user = (uuid: string, ...content: ContentBlock[]): PhoneMessage => ({ uuid, type: "user", content });
const assistant = (uuid: string, ...content: ContentBlock[]): PhoneMessage => ({ uuid, type: "assistant", content });

const SELECTION =
  "<ide_selection>The user selected the lines 3 to 9 from /a/b.ts:\nconst x = 1;\nconst y = 2;\n\nThis may or may not be related to the current task.</ide_selection>";
const OPENED =
  "<ide_opened_file>The user opened the file /a/b/x.ts in the IDE. This may or may not be related to the current task.</ide_opened_file>";

describe("buildTranscript: messages", () => {
  test("a user prompt and Claude's answer become two items", () => {
    expect(buildTranscript([user("u1", text("Fix the bug")), assistant("a1", text("Done."))])).toEqual([
      { kind: "user", id: "u1", text: "Fix the bug", chips: [], images: 0 },
      { kind: "assistant-text", id: "a1#0", text: "Done." },
    ]);
  });

  test("a tool_use and its tool_result pair into one tool item, matched by toolUseId", () => {
    const items = buildTranscript([
      assistant("a1", text("Running the tests"), toolUse("t1", "Bash", { command: "npm test" })),
      user("u2", toolResult("t1", "12 passed")),
      assistant("a2", text("All green.")),
    ]);
    expect(items).toEqual([
      { kind: "assistant-text", id: "a1#0", text: "Running the tests" },
      {
        kind: "tool",
        id: "t1",
        name: "Bash",
        summary: "npm test",
        input: { command: "npm test" },
        result: { text: "12 passed", isError: false },
        children: [],
      },
      { kind: "assistant-text", id: "a2#0", text: "All green." },
    ]);
  });

  test("the result's message does not become a user bubble", () => {
    const items = buildTranscript([
      assistant("a1", toolUse("t1", "Read", { file_path: "/a/b.ts" })),
      user("u2", toolResult("t1", "contents")),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool"]);
  });

  test("an error result is marked, a call without a result yet has none", () => {
    const items = buildTranscript([
      assistant("a1", toolUse("t1", "Bash", { command: "false" }), toolUse("t2", "Bash", { command: "sleep 1" })),
      user("u2", toolResult("t1", "exit 1", true)),
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", id: "t1", result: { text: "exit 1", isError: true } });
    expect(items[1]).toMatchObject({ kind: "tool", id: "t2" });
    expect((items[1] as { result?: unknown }).result).toBeUndefined();
  });

  test("a result whose call was cut off (truncatedBefore) is ignored", () => {
    expect(buildTranscript([user("u1", toolResult("gone", "late result"))])).toEqual([]);
  });

  test("text next to a tool_result still shows as a user bubble", () => {
    const items = buildTranscript([
      assistant("a1", toolUse("t1", "Bash", { command: "ls" })),
      user("u2", toolResult("t1", "a b c"), text("and then?")),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool", "user"]);
    expect(items[1]).toMatchObject({ text: "and then?" });
  });

  test("the CLI's interrupt marker becomes a thin line, not a user bubble", () => {
    const items = buildTranscript([
      assistant("a1", toolUse("t1", "Bash", { command: "sleep 60" })),
      user("u2", toolResult("t1", "[Request interrupted by user for tool use]", true), text("[Request interrupted by user for tool use]")),
      user("u3", text("[Request interrupted by user]")),
      user("u4", text("[Request interrupted by user] but I typed more")),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["tool", "result", "result", "user"]);
    expect(items[1]).toEqual({ kind: "result", id: "u2", ok: false, subtype: "interrupted", label: "Tool interrupted" });
    expect(items[2]).toEqual({ kind: "result", id: "u3", ok: false, subtype: "interrupted", label: "Interrupted" });
    expect(items[3]).toMatchObject({ kind: "user", text: "[Request interrupted by user] but I typed more" });
  });

  test("system reminders the CLI appends to a tool result are not shown", () => {
    const [tool] = buildTranscript([
      assistant("a1", toolUse("t1", "Read", { file_path: "/a/b.ts" })),
      user("u2", toolResult("t1", "const x = 1;\n<system-reminder>\nWhenever you read a file, consider...\n</system-reminder>")),
    ]);
    expect(tool).toMatchObject({ kind: "tool", result: { text: "const x = 1;", isError: false } });
  });

  test("thinking becomes its own item; empty text and empty thinking are skipped", () => {
    const items = buildTranscript([
      assistant(
        "a1",
        { type: "thinking", text: "Let me look at the files" },
        { type: "thinking", text: "" },
        text("   "),
        text("Found it"),
      ),
    ]);
    expect(items).toEqual([
      { kind: "thinking", id: "a1#0", text: "Let me look at the files" },
      { kind: "assistant-text", id: "a1#3", text: "Found it" },
    ]);
  });

  test("images are counted, documents become chips", () => {
    const items = buildTranscript([
      user("u1", { type: "image", omitted: true }, { type: "document", title: "spec.pdf" }, { type: "document" }, text("what is this?")),
      user("u2", { type: "image", omitted: true }),
    ]);
    expect(items).toEqual([
      {
        kind: "user",
        id: "u1",
        text: "what is this?",
        chips: [
          { kind: "attachment", label: "spec.pdf" },
          { kind: "attachment", label: "Document" },
        ],
        images: 1,
      },
      { kind: "user", id: "u2", text: "", chips: [], images: 1 },
    ]);
  });

  test("a message with the same uuid is shown once, with the latest content, at the first position", () => {
    const items = buildTranscript([
      assistant("a1", text("v1")),
      user("u1", text("hi")),
      assistant("a1", text("v2")),
    ]);
    expect(items).toEqual([
      { kind: "assistant-text", id: "a1#0", text: "v2" },
      { kind: "user", id: "u1", text: "hi", chips: [], images: 0 },
    ]);
  });

  test("messages without a uuid are never merged", () => {
    const a = { uuid: "", type: "result", result: { subtype: "success", isError: false } } as PhoneMessage;
    expect(buildTranscript([a, a]).length).toBe(2);
  });
});

describe("buildTranscript: malformed messages", () => {
  const bad = (m: unknown) => m as PhoneMessage;

  test("a message the bridge got wrong never breaks the screen", () => {
    const items = buildTranscript([
      bad({ uuid: "m1", type: "assistant" }),
      bad({ uuid: "m2", type: "assistant", content: "just a string" }),
      bad({ uuid: "m3", type: "user", content: [null, 5, "x", {}, { type: "text" }, { type: "tool_result" }, { type: "document", title: 7 }] }),
      bad({ uuid: "m4", type: "assistant", content: [{ type: "text" }, { type: "thinking", text: 5 }, { type: "tool_use" }, { type: "tool_use", id: "t1", name: "Bash" }] }),
      bad({ uuid: "m5", type: "result" }),
      bad({ uuid: "m6", type: "assistant", parent: 42, content: [{ type: "text", text: "kept" }] }),
      bad(null),
      bad({ type: "assistant", content: [{ type: "text", text: "no uuid" }] }),
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "tool", "assistant-text", "assistant-text"]);
    expect(items[0]).toMatchObject({ kind: "user", text: "", chips: [{ kind: "attachment", label: "Document" }] });
    expect(items[1]).toMatchObject({ kind: "tool", id: "t1", name: "Bash", summary: "", input: {} });
  });

  test("latestTodos skips malformed messages", () => {
    expect(latestTodos([bad({ uuid: "a", type: "assistant", content: "x" }), bad(null)])).toBeNull();
  });
});

describe("buildTranscript: IDE context in user messages", () => {
  test("<ide_selection> becomes a chip b.ts:3-9 and the prompt stays", () => {
    const items = buildTranscript([user("u1", text(SELECTION), text("Why does this fail?"))]);
    expect(items).toEqual([
      {
        kind: "user",
        id: "u1",
        text: "Why does this fail?",
        chips: [{ kind: "selection", label: "b.ts:3-9" }],
        images: 0,
      },
    ]);
  });

  test("<ide_opened_file> becomes a chip x.ts", () => {
    const [item] = buildTranscript([user("u1", text(OPENED), text("Explain this file"))]);
    expect(item).toMatchObject({ kind: "user", text: "Explain this file", chips: [{ kind: "file", label: "x.ts" }] });
  });

  test("<system-reminder> is removed, and a message with nothing else is hidden", () => {
    const reminder = "<system-reminder>\nAs you answer the user's questions, you can use this context.\n</system-reminder>";
    expect(buildTranscript([user("u1", text(reminder))])).toEqual([]);
    const [item] = buildTranscript([user("u2", text(`${reminder}\nhello`))]);
    expect(item).toMatchObject({ kind: "user", text: "hello", chips: [] });
  });

  test("a message that is only IDE context keeps its chips", () => {
    const [item] = buildTranscript([user("u1", text(OPENED))]);
    expect(item).toEqual({ kind: "user", id: "u1", text: "", chips: [{ kind: "file", label: "x.ts" }], images: 0 });
  });
});

describe("splitIdeContext", () => {
  test("selection with lines becomes b.ts:3-9; the selected code is dropped from the text", () => {
    expect(splitIdeContext(`${SELECTION}\nWhy does this fail?`)).toEqual({
      text: "Why does this fail?",
      chips: [{ kind: "selection", label: "b.ts:3-9" }],
    });
  });

  test("a one-line selection shows one line number; paths with spaces keep only the file name", () => {
    const one = "<ide_selection>The user selected the lines 5 to 5 from /a/my project/b.ts:\nfoo()\n\nThis may or may not be related to the current task.</ide_selection>";
    expect(splitIdeContext(one).chips).toEqual([{ kind: "selection", label: "b.ts:5" }]);
  });

  test("the tags are read leniently: no newline after the colon, or only a path in the tag", () => {
    expect(splitIdeContext("<ide_selection>The user selected the lines 3 to 9 from /a/b.ts:…</ide_selection>").chips).toEqual([
      { kind: "selection", label: "b.ts:3-9" },
    ]);
    expect(splitIdeContext("<ide_selection>The user selected the lines 3 to 9 from C:\\proj\\b.ts:\nconst a: number = 1;</ide_selection>").chips).toEqual([
      { kind: "selection", label: "b.ts:3-9" },
    ]);
    expect(splitIdeContext("<ide_opened_file>…/x.ts…</ide_opened_file>").chips).toEqual([{ kind: "file", label: "x.ts" }]);
    expect(splitIdeContext("<ide_opened_file>The user opened file /a/b/x.ts in IDE</ide_opened_file>").chips).toEqual([
      { kind: "file", label: "x.ts" },
    ]);
    expect(splitIdeContext("<ide_opened_file>The user opened the file /a/b/x.ts in the editor.</ide_opened_file>").chips).toEqual([
      { kind: "file", label: "x.ts" },
    ]);
    expect(splitIdeContext("<ide_opened_file>something else entirely</ide_opened_file>").chips).toEqual([{ kind: "file", label: "File" }]);
  });

  test("an unreadable selection tag still becomes a chip", () => {
    expect(splitIdeContext("<ide_selection>something new</ide_selection>").chips).toEqual([
      { kind: "selection", label: "Selection" },
    ]);
  });

  test("opened file becomes x.ts", () => {
    expect(splitIdeContext(OPENED)).toEqual({ text: "", chips: [{ kind: "file", label: "x.ts" }] });
  });

  test("chips keep the order of the tags", () => {
    const { chips } = splitIdeContext(`${OPENED}${SELECTION}`);
    expect(chips.map((c) => c.label)).toEqual(["x.ts", "b.ts:3-9"]);
  });

  test("system reminders vanish, however many lines they have", () => {
    expect(splitIdeContext("<system-reminder>\nline 1\n\nline 2\n</system-reminder>\nhello\n<system-reminder>x</system-reminder>")).toEqual({
      text: "hello",
      chips: [],
    });
  });

  test("slash commands become one chip with their arguments", () => {
    const cmd = "<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the tests</command-args>";
    expect(splitIdeContext(cmd)).toEqual({ text: "", chips: [{ kind: "command", label: "/compact keep the tests" }] });
    expect(
      splitIdeContext("<command-name>/clear</command-name><command-message>clear</command-message><command-args></command-args>").chips,
    ).toEqual([{ kind: "command", label: "/clear" }]);
  });

  test("local command output keeps its text, the caveat disappears", () => {
    const out = "<local-command-caveat>Caveat: do not respond to these messages.</local-command-caveat>\n<local-command-stdout>Compacted</local-command-stdout>";
    expect(splitIdeContext(out)).toEqual({ text: "Compacted", chips: [] });
  });

  test("a terminal mention becomes a chip with the terminal's name", () => {
    expect(splitIdeContext('<terminal name="dev server">\nlistening on 3000\n</terminal>\nwhy is it slow?')).toEqual({
      text: "why is it slow?",
      chips: [{ kind: "terminal", label: "dev server" }],
    });
  });

  test("a background task notice becomes a chip with its summary", () => {
    const note = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "npm test" completed (exit code 0)</summary>\n</task-notification>';
    expect(splitIdeContext(note)).toEqual({
      text: "",
      chips: [{ kind: "notification", label: 'Background command "npm test" completed (exit code 0)' }],
    });
    expect(splitIdeContext("<task-notification><task-id>b1</task-id></task-notification>").chips).toEqual([
      { kind: "notification", label: "Background task" },
    ]);
  });

  test("plain text, including unrelated angle brackets, is left alone", () => {
    expect(splitIdeContext("use <div> in html and a < b")).toEqual({ text: "use <div> in html and a < b", chips: [] });
    // only trimmed: the user's own blank lines stay
    expect(splitIdeContext("  line 1\n\n\n\nline 2  ")).toEqual({ text: "line 1\n\n\n\nline 2", chips: [] });
  });

  test("blank lines left behind by a removed tag are tidied", () => {
    expect(splitIdeContext("a\n<system-reminder>x</system-reminder>\n\n\nb")).toEqual({ text: "a\n\nb", chips: [] });
  });
});

describe("toolSummary", () => {
  test("Bash shows the command", () => {
    expect(toolSummary("Bash", { command: "npm test" })).toBe("npm test");
  });

  test("a long or multi-line command is collapsed onto one clipped line", () => {
    expect(toolSummary("Bash", { command: "cd /tmp &&\n  ls -la" })).toBe("cd /tmp && ls -la");
    const long = toolSummary("Bash", { command: `echo ${"x".repeat(400)}` });
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.endsWith("…")).toBe(true);
  });

  test("file tools show the file name", () => {
    expect(toolSummary("Read", { file_path: "/a/b/c.ts" })).toBe("c.ts");
    expect(toolSummary("Edit", { file_path: "/a/b/c.ts", old_string: "x", new_string: "y" })).toBe("c.ts");
    expect(toolSummary("Write", { file_path: "C:\\proj\\notes.md", content: "x" })).toBe("notes.md");
    expect(toolSummary("NotebookEdit", { notebook_path: "/a/nb.ipynb" })).toBe("nb.ipynb");
  });

  test("Grep and Glob show the pattern", () => {
    expect(toolSummary("Grep", { pattern: "TODO\\(", path: "/a" })).toBe("TODO\\(");
    expect(toolSummary("Glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  });

  test("WebFetch shows the host, WebSearch the query", () => {
    expect(toolSummary("WebFetch", { url: "https://docs.example.com/a/b?x=1", prompt: "summarise" })).toBe("docs.example.com");
    expect(toolSummary("WebFetch", { url: "not a url" })).toBe("not a url");
    expect(toolSummary("WebSearch", { query: "preact 11 release notes" })).toBe("preact 11 release notes");
  });

  test("Task and Agent show the task description", () => {
    expect(toolSummary("Task", { description: "Explore auth", prompt: "…", subagent_type: "Explore" })).toBe("Explore auth");
    expect(toolSummary("Agent", { subagent_type: "Explore", prompt: "…" })).toBe("Explore");
  });

  test("questions and plans have a short summary", () => {
    expect(toolSummary("AskUserQuestion", { questions: [{ question: "Which library?" }, { question: "Which format?" }] })).toBe(
      "Which library?",
    );
    expect(toolSummary("ExitPlanMode", { plan: "# Plan" })).toBe("Plan");
  });

  test("unknown and MCP tools fall back to their first useful string argument", () => {
    expect(toolSummary("mcp__files__search", { query: "invoice" })).toBe("invoice");
    expect(toolSummary("Mystery", { count: 3, label: "hello" })).toBe("hello");
    expect(toolSummary("Mystery", {})).toBe("");
    expect(toolSummary("Read", {})).toBe("");
  });
});

describe("latestTodos / todos items", () => {
  const todo = (content: string, status: string) => ({ content, status, activeForm: `${content}…` });
  const write = (uuid: string, id: string, todos: unknown[], extra: Partial<PhoneMessage> = {}): PhoneMessage => ({
    ...assistant(uuid, toolUse(id, "TodoWrite", { todos })),
    ...extra,
  });

  test("the latest TodoWrite wins: {done: 2, total: 5}", () => {
    const messages = [
      write("a1", "t1", [todo("one", "pending")]),
      assistant("a2", text("working")),
      write("a3", "t3", [
        todo("one", "completed"),
        todo("two", "completed"),
        todo("three", "in_progress"),
        todo("four", "pending"),
        todo("five", "pending"),
      ]),
      assistant("a4", text("still working")),
    ];
    const todos = latestTodos(messages);
    expect(todos).toMatchObject({ done: 2, total: 5 });
    expect(todos?.items.map((i) => i.content)).toEqual(["one", "two", "three", "four", "five"]);
    expect(todos?.items[2]).toEqual({ content: "three", status: "in_progress", activeForm: "three…" });
  });

  test("no TodoWrite, an empty list, or only subagent todos → null", () => {
    expect(latestTodos([])).toBeNull();
    expect(latestTodos([assistant("a1", text("hi"))])).toBeNull();
    expect(latestTodos([write("a1", "t1", [])])).toBeNull();
    expect(latestTodos([write("a1", "t1", [todo("x", "pending")], { parent: "T9" })])).toBeNull();
  });

  test("unknown statuses count as pending; malformed entries are dropped", () => {
    const todos = latestTodos([write("a1", "t1", [todo("a", "weird"), { nope: true }, todo("b", "completed")])]);
    expect(todos).toMatchObject({ done: 1, total: 2 });
    expect(todos?.items[0]?.status).toBe("pending");
  });

  test("a TodoWrite call is a todos item in the transcript, not a tool row; its result is hidden", () => {
    const items = buildTranscript([
      write("a1", "t1", [todo("one", "completed"), todo("two", "pending")]),
      user("u2", toolResult("t1", "Todos have been modified successfully")),
    ]);
    expect(items).toEqual([
      {
        kind: "todos",
        id: "t1",
        done: 1,
        total: 2,
        items: [
          { content: "one", status: "completed", activeForm: "one…" },
          { content: "two", status: "pending", activeForm: "two…" },
        ],
      },
    ]);
  });
});

describe("buildTranscript: turn boundaries", () => {
  test("a result becomes a thin line: Done in 1m 12s", () => {
    const items = buildTranscript([
      { uuid: "r1", type: "result", result: { subtype: "success", isError: false, durationMs: 72_000, costUsd: 0.12, numTurns: 3 } },
    ]);
    expect(items).toEqual([
      { kind: "result", id: "r1", ok: true, subtype: "success", label: "Done in 1m 12s", durationMs: 72_000, costUsd: 0.12 },
    ]);
  });

  test("result labels for success without a duration and for the failures", () => {
    const label = (subtype: string, isError: boolean, durationMs?: number) =>
      (buildTranscript([{ uuid: "r", type: "result", result: { subtype, isError, durationMs } }])[0] as { label: string }).label;
    expect(label("success", false)).toBe("Done");
    expect(label("error_max_turns", true, 4000)).toBe("Stopped: turn limit reached");
    expect(label("error_max_budget_usd", true)).toBe("Stopped: budget limit reached");
    expect(label("error_during_execution", true, 3000)).toBe("Stopped after 3s");
    expect(label("error_during_execution", true)).toBe("Stopped");
  });

  test("a compact boundary becomes a compact item; the summary message that follows folds into it", () => {
    const summary = "This session is being continued from a previous conversation that ran out of context. Summary: ...";
    const items = buildTranscript([
      { uuid: "c1", type: "system", subtype: "compact_boundary" },
      user("u1", text(summary)),
      user("u2", text("go on")),
    ]);
    expect(items).toEqual([
      { kind: "compact", id: "c1", summary },
      { kind: "user", id: "u2", text: "go on", chips: [], images: 0 },
    ]);
  });

  test("other system messages are ignored", () => {
    expect(buildTranscript([{ uuid: "s1", type: "system", subtype: "init" }])).toEqual([]);
  });
});

describe("buildTranscript: subagents", () => {
  test("messages with a parent fold under their Task call", () => {
    const items = buildTranscript([
      assistant("a1", toolUse("T1", "Task", { description: "Explore auth", subagent_type: "Explore", prompt: "Look at auth" })),
      { ...user("s0", text("Look at auth")), parent: "T1" },
      { ...assistant("s1", toolUse("t2", "Read", { file_path: "/a/auth.ts" })), parent: "T1" },
      { ...user("s2", toolResult("t2", "file contents")), parent: "T1" },
      { ...assistant("s3", text("Found it")), parent: "T1" },
      user("u3", toolResult("T1", "The auth lives in auth.ts")),
      assistant("a4", text("Thanks")),
    ]);
    expect(items).toEqual([
      {
        kind: "tool",
        id: "T1",
        name: "Task",
        summary: "Explore auth",
        input: { description: "Explore auth", subagent_type: "Explore", prompt: "Look at auth" },
        result: { text: "The auth lives in auth.ts", isError: false },
        children: [
          {
            kind: "tool",
            id: "t2",
            name: "Read",
            summary: "auth.ts",
            input: { file_path: "/a/auth.ts" },
            result: { text: "file contents", isError: false },
            children: [],
          },
          { kind: "assistant-text", id: "s3#0", text: "Found it" },
        ],
      },
      { kind: "assistant-text", id: "a4#0", text: "Thanks" },
    ]);
  });

  test("a subagent message whose Task call is not in view is dropped", () => {
    expect(buildTranscript([{ ...assistant("s1", text("orphan")), parent: "missing" }])).toEqual([]);
  });
});

describe("buildTranscript: optimistic messages and the replay", () => {
  const sending = (uuid: string, t: string): LocalMessage => ({ ...user(uuid, text(t)), local: "sending" });

  test("an unconfirmed message shows as sending, after everything else", () => {
    const items = buildTranscript([sending("local-1", "run the tests"), assistant("a1", text("Hi"))]);
    expect(items).toEqual([
      { kind: "assistant-text", id: "a1#0", text: "Hi" },
      { kind: "user", id: "local-1", text: "run the tests", chips: [], images: 0, status: "sending" },
    ]);
  });

  test("a failed send is marked failed", () => {
    const failed: LocalMessage = { ...user("local-1", text("x")), local: "failed" };
    expect(buildTranscript([failed])[0]).toMatchObject({ kind: "user", status: "failed" });
  });

  test("the replayed user message with the same uuid replaces the optimistic one", () => {
    const replay: PhoneMessage = { ...user("u9", text("run the tests")), isReplay: true };
    const items = buildTranscript([sending("u9", "run the tests"), assistant("a1", text("Hi")), replay]);
    expect(items).toEqual([
      { kind: "assistant-text", id: "a1#0", text: "Hi" },
      { kind: "user", id: "u9", text: "run the tests", chips: [], images: 0 },
    ]);
  });

  test("a replay with the same uuid also replaces an optimistic message that comes later in the array", () => {
    const replay: PhoneMessage = { ...user("u9", text("go")), isReplay: true };
    const items = buildTranscript([replay, sending("u9", "go")]);
    expect(items).toEqual([{ kind: "user", id: "u9", text: "go", chips: [], images: 0 }]);
  });

  test("the same uuid twice without a local marker also collapses to one bubble", () => {
    const items = buildTranscript([user("u9", text("go")), { ...user("u9", text("go")), isReplay: true }]);
    expect(items.length).toBe(1);
  });

  test("streaming text goes after the real messages and before unconfirmed ones", () => {
    const items = buildTranscript([assistant("a1", text("Hi")), sending("local-1", "next")], "Partial answer");
    expect(items.map((i) => i.kind)).toEqual(["assistant-text", "streaming", "user"]);
    expect(items[1]).toEqual({ kind: "streaming", id: "streaming", text: "Partial answer" });
  });
});

describe("buildTranscript: streaming text", () => {
  const history = [user("u1", text("hi")), assistant("a1", text("hello"))];

  test("streaming text is appended as the last item", () => {
    const items = buildTranscript(history, "Let me che");
    expect(items.length).toBe(3);
    expect(items.at(-1)).toEqual({ kind: "streaming", id: "streaming", text: "Let me che" });
  });

  test("no stream, an empty stream or whitespace adds nothing", () => {
    for (const s of [undefined, null, "", "  \n "]) expect(buildTranscript(history, s).length).toBe(2);
  });
});

describe("stream state", () => {
  test("deltas of one block accumulate", () => {
    let s = EMPTY_STREAM;
    s = applyStreamEvent(s, { type: "message_start" });
    s = applyStreamEvent(s, { type: "content_block_start", index: 0 });
    s = applyStreamEvent(s, { type: "content_block_delta", index: 0, text: "Hel" });
    s = applyStreamEvent(s, { type: "content_block_delta", index: 0, text: "lo" });
    expect(streamText(s)).toBe("Hello");
    s = applyStreamEvent(s, { type: "content_block_stop", index: 0 });
    s = applyStreamEvent(s, { type: "message_stop" });
    expect(streamText(s)).toBe("Hello"); // stays until the complete message replaces it
  });

  test("several text blocks are separated by a blank line, in block order", () => {
    let s = EMPTY_STREAM;
    s = applyStreamEvent(s, { type: "content_block_delta", index: 2, text: "More" });
    s = applyStreamEvent(s, { type: "content_block_delta", index: 0, text: "First" });
    expect(streamText(s)).toBe("First\n\nMore");
  });

  test("events with a wrong text or index are ignored or put in block 0", () => {
    let s = applyStreamEvent(EMPTY_STREAM, { type: "content_block_delta", index: 0, text: 5 as unknown as string });
    expect(streamText(s)).toBe("");
    s = applyStreamEvent(s, { type: "content_block_delta", index: "x" as unknown as number, text: "hi" });
    expect(streamText(s)).toBe("hi");
  });

  test("a delta without an index goes to block 0; blocks that never got text show nothing", () => {
    let s = applyStreamEvent(EMPTY_STREAM, { type: "content_block_start", index: 1 });
    expect(streamText(s)).toBe("");
    s = applyStreamEvent(s, { type: "content_block_delta", text: "hi" });
    expect(streamText(s)).toBe("hi");
  });

  test("message_start begins a new message", () => {
    let s = applyStreamEvent(EMPTY_STREAM, { type: "content_block_delta", index: 0, text: "old" });
    s = applyStreamEvent(s, { type: "message_start" });
    expect(streamText(s)).toBe("");
  });

  test("applying an event never changes the previous state", () => {
    const before = applyStreamEvent(EMPTY_STREAM, { type: "content_block_delta", index: 0, text: "a" });
    applyStreamEvent(before, { type: "content_block_delta", index: 0, text: "b" });
    expect(streamText(before)).toBe("a");
    expect(streamText(EMPTY_STREAM)).toBe("");
  });

  test("a complete assistant message with text, or the end of the turn, ends the streamed text; other messages do not", () => {
    const streaming = applyStreamEvent(EMPTY_STREAM, { type: "content_block_delta", index: 0, text: "partial" });
    expect(streamAfterMessage(streaming, assistant("a1", toolUse("t0", "Read", {}), text("partial text, complete")))).toBe(EMPTY_STREAM);
    expect(streamAfterMessage(streaming, { uuid: "r1", type: "result" })).toBe(EMPTY_STREAM);
    // the text of this message is still on its way, so a message without text must not erase it
    expect(streamAfterMessage(streaming, assistant("a2", { type: "thinking", text: "hm" }))).toBe(streaming);
    expect(streamAfterMessage(streaming, assistant("a3", toolUse("t1", "Bash", { command: "ls" })))).toBe(streaming);
    expect(streamAfterMessage(streaming, user("u1", toolResult("t1", "x")))).toBe(streaming);
    expect(streamAfterMessage(streaming, { ...assistant("s1", text("sub")), parent: "T1" })).toBe(streaming);
  });
});

describe("formatDuration", () => {
  test("formats milliseconds the way a person says them", () => {
    expect(formatDuration(400)).toBe("400ms");
    expect(formatDuration(5000)).toBe("5s");
    expect(formatDuration(1500)).toBe("2s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(59_600)).toBe("1m");
    expect(formatDuration(72_000)).toBe("1m 12s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_723_000)).toBe("1h 2m");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});
