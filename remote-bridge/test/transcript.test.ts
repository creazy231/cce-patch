import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { CAPS, LIMITS, mergeHistory, toPhoneMessage, toStreamEvent } from "../lib/transcript.js";

const MARK = "…[truncated]";
const MB = 1024 * 1024;

/** What a snapshot is measured in: the bytes of its JSON, as they go over the wire. */
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
/** What a cut identifier looks like. */
const idCut = (value: string) => value.slice(0, CAPS.identifier) + MARK;

// SDK messages as the extension host sends them (docs/superpowers/specs/2026-11-19-phone-remote-design.md,
// "What exists today"); a builder only sets what the mapping reads.
const userMsg = (uuid: string, content: unknown, extra: Record<string, unknown> = {}) => ({
  type: "user",
  uuid,
  session_id: "s-1",
  parent_tool_use_id: null,
  message: { role: "user", content },
  ...extra,
});
const assistantMsg = (uuid: string, content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  uuid,
  session_id: "s-1",
  parent_tool_use_id: null,
  message: { id: "msg_01", role: "assistant", model: "claude-test", content },
  ...extra,
});
const toolResultBlock = (toolUseId: string, content: unknown, isError = false) => ({
  type: "tool_result",
  tool_use_id: toolUseId,
  is_error: isError,
  content,
});
const streamEvent = (event: unknown, extra: Record<string, unknown> = {}) => ({
  type: "stream_event",
  uuid: "u-7",
  session_id: "s-1",
  parent_tool_use_id: null,
  event,
  ...extra,
});

describe("LIMITS", () => {
  test("are the trimming limits of the phone protocol", () => {
    expect(LIMITS).toEqual({ text: 20000, toolResult: 3000, thinking: 2000, inputString: 4000, messages: 400 });
  });
});

describe("CAPS", () => {
  test("are the caps that keep a message and a snapshot bounded", () => {
    expect(CAPS).toEqual({ blocks: 100, messageChars: 100000, identifier: 200, snapshotBytes: 2 * MB });
  });
});

describe("toPhoneMessage: what stays out", () => {
  const dropped: Record<string, unknown> = {
    stream_event: streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
    "system/init": { type: "system", subtype: "init", session_id: "s-1", uuid: "u-0", model: "claude-test", tools: ["Bash", "Read", "Edit"] },
    "system/status": { type: "system", subtype: "status", permissionMode: "default", session_id: "s-1", uuid: "u-s" },
    rate_limit_event: { type: "rate_limit_event", uuid: "u-r", session_id: "s-1" },
    prompt_suggestion: { type: "prompt_suggestion", uuid: "u-p", session_id: "s-1", suggestion: "run the tests" },
    "an isMeta user message": userMsg("u-5", "<command-name>/clear</command-name>", { isMeta: true }),
    "a user message without a uuid": { type: "user", session_id: "s-1", message: { role: "user", content: "hi" } },
    "an assistant message without a uuid": { type: "assistant", session_id: "s-1", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
    "a compact_boundary without a uuid": { type: "system", subtype: "compact_boundary", session_id: "s-1" },
    "a type nobody knows": { type: "something_new", uuid: "u-x", session_id: "s-1" },
    "a user message without a message": { type: "user", uuid: "u-y", session_id: "s-1" },
    "a user message with an empty string": userMsg("u-e1", ""),
    "a user message with no content blocks": userMsg("u-e2", []),
    "an assistant message with only a redacted thinking block": assistantMsg("u-e3", [{ type: "redacted_thinking", data: "abc" }]),
    null: null,
    undefined: undefined,
    "a string": "user",
    "an array": [],
  };
  for (const [name, sdk] of Object.entries(dropped)) {
    test(`${name} -> null`, () => {
      expect(toPhoneMessage(sdk)).toBeNull();
    });
  }
});

describe("toPhoneMessage: system", () => {
  test("keeps compact_boundary and nothing of its metadata", () => {
    const sdk = { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 120000 }, uuid: "u-c", session_id: "s-1" };
    expect(toPhoneMessage(sdk)).toStrictEqual({ uuid: "u-c", type: "system", subtype: "compact_boundary" });
  });

  test("carries the timestamp as ts", () => {
    const sdk = { type: "system", subtype: "compact_boundary", uuid: "u-c", session_id: "s-1", timestamp: "2026-11-19T10:05:00.000Z" };
    expect(toPhoneMessage(sdk)).toStrictEqual({ uuid: "u-c", type: "system", subtype: "compact_boundary", ts: "2026-11-19T10:05:00.000Z" });
  });
});

describe("toPhoneMessage: user", () => {
  test("a string content becomes one text block", () => {
    expect(toPhoneMessage(userMsg("u-1b", "hello"))).toStrictEqual({ uuid: "u-1b", type: "user", content: [{ type: "text", text: "hello" }] });
  });

  test("a replayed prompt keeps isReplay and its timestamp (as ts)", () => {
    const sdk = userMsg(
      "u-1",
      [
        { type: "text", text: "<ide_opened_file>The user opened the file /a/b.ts in the IDE.</ide_opened_file>" },
        { type: "text", text: "fix the test" },
      ],
      { isReplay: true, timestamp: "2026-11-19T10:00:00.000Z" },
    );
    expect(toPhoneMessage(sdk)).toStrictEqual({
      uuid: "u-1",
      type: "user",
      ts: "2026-11-19T10:00:00.000Z",
      isReplay: true,
      content: [
        { type: "text", text: "<ide_opened_file>The user opened the file /a/b.ts in the IDE.</ide_opened_file>" },
        { type: "text", text: "fix the test" },
      ],
    });
  });

  test("isReplay is only there when it is true", () => {
    expect(toPhoneMessage(userMsg("u-1", "hi", { isReplay: false }))).not.toHaveProperty("isReplay");
    expect(toPhoneMessage(userMsg("u-1", "hi"))).not.toHaveProperty("isReplay");
  });

  test("text is cut to 20 000 characters", () => {
    const mapped = toPhoneMessage(userMsg("u-1", [{ type: "text", text: "x".repeat(30000) }]))!;
    expect(mapped.content).toEqual([{ type: "text", text: "x".repeat(20000) + MARK }]);
    // a string content gets the same cut
    expect(toPhoneMessage(userMsg("u-2", "y".repeat(25000)))!.content).toEqual([{ type: "text", text: "y".repeat(20000) + MARK }]);
  });

  test("a long text is cut even when it happens to end with the marker", () => {
    const mapped = toPhoneMessage(userMsg("u-1", [{ type: "text", text: "x".repeat(30000) + MARK }]))!;
    expect(mapped.content).toEqual([{ type: "text", text: "x".repeat(LIMITS.text) + MARK }]);
  });

  test("text of exactly the limit is left alone", () => {
    const text = "z".repeat(LIMITS.text);
    expect(toPhoneMessage(userMsg("u-1", [{ type: "text", text }]))!.content).toEqual([{ type: "text", text }]);
  });

  test("the cut never leaves half of a surrogate pair", () => {
    const text = "a".repeat(LIMITS.text - 1) + "😀" + "b".repeat(50); // the emoji straddles the limit
    const cut = (toPhoneMessage(userMsg("u-1", text))!.content as any[])[0].text as string;
    expect(cut).toBe("a".repeat(LIMITS.text - 1) + MARK);
    expect(() => encodeURIComponent(cut)).not.toThrow(); // a lone surrogate would throw
  });

  test("an image becomes an omitted marker and its data is not forwarded", () => {
    const sdk = userMsg("u-1", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "SECRETPIXELS" } },
      { type: "text", text: "what is this?" },
    ]);
    const mapped = toPhoneMessage(sdk)!;
    expect(mapped.content).toStrictEqual([{ type: "image", omitted: true }, { type: "text", text: "what is this?" }]);
    expect(JSON.stringify(mapped)).not.toContain("SECRETPIXELS");
  });

  test("a document keeps its title only", () => {
    const sdk = userMsg("u-1", [
      { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: "SECRETPDF" } },
      { type: "document", source: { type: "text", media_type: "text/plain", data: "plain" } },
    ]);
    const mapped = toPhoneMessage(sdk)!;
    expect(mapped.content).toStrictEqual([{ type: "document", title: "spec.pdf" }, { type: "document" }]);
    expect(JSON.stringify(mapped)).not.toContain("SECRETPDF");
  });

  test("a document title is cut to 200 characters", () => {
    const mapped = toPhoneMessage(userMsg("u-1", [{ type: "document", title: "t".repeat(500) }]))!;
    expect(mapped.content).toStrictEqual([{ type: "document", title: "t".repeat(200) + MARK }]);
  });

  test("unknown block types are left out", () => {
    const sdk = userMsg("u-1", [{ type: "something_new", payload: 1 }, { type: "text", text: "kept" }]);
    expect(toPhoneMessage(sdk)!.content).toEqual([{ type: "text", text: "kept" }]);
  });

  test("parent_tool_use_id becomes parent", () => {
    const sdk = userMsg("u-1", [toolResultBlock("toolu_9", "ok")], { parent_tool_use_id: "toolu_task" });
    expect(toPhoneMessage(sdk)!.parent).toBe("toolu_task");
    expect(toPhoneMessage(userMsg("u-2", "hi"))).not.toHaveProperty("parent");
  });
});

describe("toPhoneMessage: tool results", () => {
  const resultBlock = (sdk: unknown) => (toPhoneMessage(sdk)!.content as any[])[0];

  test("a short string result", () => {
    const sdk = userMsg("u-3", [toolResultBlock("toolu_01", "…stdout…")]);
    expect(toPhoneMessage(sdk)).toStrictEqual({
      uuid: "u-3",
      type: "user",
      content: [{ type: "tool_result", toolUseId: "toolu_01", text: "…stdout…", isError: false }],
    });
  });

  test("is_error is forwarded as isError", () => {
    expect(resultBlock(userMsg("u-3", [toolResultBlock("toolu_01", "boom", true)]))).toEqual({ type: "tool_result", toolUseId: "toolu_01", text: "boom", isError: true });
    // a block without is_error is not an error
    expect(resultBlock(userMsg("u-3", [{ type: "tool_result", tool_use_id: "toolu_01", content: "ok" }])).isError).toBe(false);
  });

  test("a 10 000-character string is cut to 3 000", () => {
    const block = resultBlock(userMsg("u-3", [toolResultBlock("toolu_01", "o".repeat(10000))]));
    expect(block.text).toBe("o".repeat(3000) + MARK);
    expect(block.text.length).toBe(LIMITS.toolResult + MARK.length);
  });

  test("an array of text parts is flattened, one part per line, and cut to 3 000", () => {
    const short = resultBlock(userMsg("u-3", [toolResultBlock("toolu_01", [{ type: "text", text: "line one" }, { type: "text", text: "line two" }])]));
    expect(short.text).toBe("line one\nline two");

    const parts = [
      { type: "text", text: "a".repeat(2000) },
      { type: "text", text: "b".repeat(2000) },
    ];
    const long = resultBlock(userMsg("u-3", [toolResultBlock("toolu_01", parts)]));
    expect(long.text).toBe("a".repeat(2000) + "\n" + "b".repeat(999) + MARK);
  });

  test("an image inside a result is left out, with a note, and its data is not forwarded", () => {
    const parts = [
      { type: "text", text: "screenshot taken" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "SECRETPIXELS" } },
    ];
    const mapped = toPhoneMessage(userMsg("u-3", [toolResultBlock("toolu_01", parts)]))!;
    expect((mapped.content as any[])[0].text).toBe("screenshot taken\n[image omitted]");
    expect(JSON.stringify(mapped)).not.toContain("SECRETPIXELS");
  });

  test("a result without content has empty text and is still kept", () => {
    expect(resultBlock(userMsg("u-3", [{ type: "tool_result", tool_use_id: "toolu_01" }]))).toEqual({ type: "tool_result", toolUseId: "toolu_01", text: "", isError: false });
  });

  test("a result that names no tool call is left out", () => {
    const sdk = userMsg("u-3", [{ type: "tool_result", content: "orphan" }, { type: "text", text: "kept" }]);
    expect(toPhoneMessage(sdk)!.content).toEqual([{ type: "text", text: "kept" }]);
  });

  test("one user message can hold several results", () => {
    const sdk = userMsg("u-3", [toolResultBlock("toolu_01", "one"), toolResultBlock("toolu_02", "two", true)]);
    expect(toPhoneMessage(sdk)!.content).toEqual([
      { type: "tool_result", toolUseId: "toolu_01", text: "one", isError: false },
      { type: "tool_result", toolUseId: "toolu_02", text: "two", isError: true },
    ]);
  });
});

describe("toPhoneMessage: assistant", () => {
  test("maps thinking, text and tool_use, without signatures", () => {
    const sdk = assistantMsg("u-2", [
      { type: "thinking", thinking: "let me look", signature: "SIGNATURE" },
      { type: "text", text: "I'll run the tests." },
      { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test", description: "Run tests" } },
    ]);
    const mapped = toPhoneMessage(sdk)!;
    expect(mapped).toStrictEqual({
      uuid: "u-2",
      type: "assistant",
      content: [
        { type: "thinking", text: "let me look" },
        { type: "text", text: "I'll run the tests." },
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test", description: "Run tests" } },
      ],
    });
    expect(JSON.stringify(mapped)).not.toContain("SIGNATURE");
  });

  test("thinking is cut to 2 000 characters", () => {
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "thinking", thinking: "t".repeat(5000), signature: "s" }]))!;
    expect(mapped.content).toEqual([{ type: "thinking", text: "t".repeat(2000) + MARK }]);
  });

  test("an empty thinking block and a redacted one are left out", () => {
    const sdk = assistantMsg("u-2", [
      { type: "thinking", thinking: "", signature: "s" },
      { type: "redacted_thinking", data: "x" },
      { type: "text", text: "answer" },
    ]);
    expect(toPhoneMessage(sdk)!.content).toEqual([{ type: "text", text: "answer" }]);
  });

  test("text is cut to 20 000 characters", () => {
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "text", text: "w".repeat(20001) }]))!;
    expect(mapped.content).toEqual([{ type: "text", text: "w".repeat(20000) + MARK }]);
  });

  test("a Write body of 9 000 characters is cut to 4 000, the other keys stay as they are", () => {
    const input = { file_path: "/work/demo/out.txt", content: "c".repeat(9000) };
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "tool_use", id: "toolu_w", name: "Write", input }]))!;
    expect(mapped.content).toEqual([
      { type: "tool_use", id: "toolu_w", name: "Write", input: { file_path: "/work/demo/out.txt", content: "c".repeat(4000) + MARK } },
    ]);
    expect(input.content.length).toBe(9000); // the SDK message is not changed
  });

  test("every string of an input is cut, at any depth; other values stay", () => {
    const input = {
      file_path: "/work/demo/a.ts",
      edits: [
        { old_string: "o".repeat(5000), new_string: "n".repeat(4000), replace_all: false },
        { old_string: "short", new_string: "p".repeat(4001), count: 2 },
      ],
      options: { nested: { deep: "d".repeat(6000), nothing: null, flag: true } },
      list: ["x".repeat(4500), 7, null],
    };
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "tool_use", id: "toolu_m", name: "MultiEdit", input }]))!;
    expect((mapped.content as any[])[0].input).toEqual({
      file_path: "/work/demo/a.ts",
      edits: [
        { old_string: "o".repeat(4000) + MARK, new_string: "n".repeat(4000), replace_all: false },
        { old_string: "short", new_string: "p".repeat(4000) + MARK, count: 2 },
      ],
      options: { nested: { deep: "d".repeat(4000) + MARK, nothing: null, flag: true } },
      list: ["x".repeat(4000) + MARK, 7, null],
    });
  });

  test("an input nested absurdly deep is cut instead of overflowing the stack", () => {
    let input: any = { leaf: "x" };
    for (let i = 0; i < 20000; i++) input = { next: input };
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "tool_use", id: "toolu_d", name: "Deep", input }]))!;
    expect(mapped.content).toHaveLength(1);
    expect(JSON.stringify(mapped).length).toBeLessThan(10000);
  });

  test("an input key named __proto__ stays a plain key", () => {
    const input = JSON.parse('{"__proto__": {"polluted": "yes"}, "command": "ls"}');
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "tool_use", id: "toolu_p", name: "Bash", input }]))!;
    const out = (mapped.content as any[])[0].input;
    expect(Object.keys(out)).toEqual(["__proto__", "command"]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as any).polluted).toBeUndefined();
  });

  test("a tool_use input that is not an object becomes an empty one", () => {
    const mapped = toPhoneMessage(assistantMsg("u-2", [{ type: "tool_use", id: "toolu_s", name: "Odd", input: "oops" }]))!;
    expect(mapped.content).toEqual([{ type: "tool_use", id: "toolu_s", name: "Odd", input: {} }]);
  });

  test("a tool_use without an id or a name is left out", () => {
    const sdk = assistantMsg("u-2", [
      { type: "tool_use", name: "Bash", input: {} },
      { type: "tool_use", id: "toolu_x", input: {} },
      { type: "text", text: "kept" },
    ]);
    expect(toPhoneMessage(sdk)!.content).toEqual([{ type: "text", text: "kept" }]);
  });

  test("a subagent message keeps the Task call it belongs to as parent", () => {
    const sdk = assistantMsg("u-4", [{ type: "text", text: "looking" }], { parent_tool_use_id: "toolu_task" });
    expect(toPhoneMessage(sdk)).toStrictEqual({ uuid: "u-4", type: "assistant", parent: "toolu_task", content: [{ type: "text", text: "looking" }] });
  });

  test("the timestamp becomes ts, anything but a string is ignored", () => {
    expect(toPhoneMessage(assistantMsg("u-2", [{ type: "text", text: "hi" }], { timestamp: "2026-11-19T10:00:01.000Z" }))!.ts).toBe("2026-11-19T10:00:01.000Z");
    expect(toPhoneMessage(assistantMsg("u-2", [{ type: "text", text: "hi" }], { timestamp: 1763550000000 }))).not.toHaveProperty("ts");
  });

  test("does not change the message it maps", () => {
    const sdk = assistantMsg("u-2", [
      { type: "thinking", thinking: "t".repeat(5000), signature: "s" },
      { type: "tool_use", id: "toolu_01", name: "Write", input: { content: "c".repeat(9000) } },
    ]);
    const before = JSON.stringify(sdk);
    toPhoneMessage(sdk);
    expect(JSON.stringify(sdk)).toBe(before);
  });
});

describe("toPhoneMessage: a message is bounded as a whole", () => {
  const toolUse = (input: unknown, id = "toolu_1", name = "Odd") => ({ type: "tool_use", id, name, input });
  const inputOf = (mapped: any) => mapped.content[0].input;

  test("keeps at most CAPS.blocks blocks, the first ones", () => {
    const blocks = Array.from({ length: 500 }, (_, i) => ({ type: "text", text: `block ${i}` }));
    const content = toPhoneMessage(assistantMsg("u-2", blocks))!.content!;
    expect(content).toHaveLength(CAPS.blocks);
    expect(content[0]).toEqual({ type: "text", text: "block 0" });
    expect(content[CAPS.blocks - 1]).toEqual({ type: "text", text: `block ${CAPS.blocks - 1}` });
  });

  test("a block that shows nothing takes no slot", () => {
    const blocks = [...Array.from({ length: 150 }, () => ({ type: "text", text: "" })), { type: "text", text: "a" }, { type: "something_new" }, { type: "text", text: "b" }];
    expect(toPhoneMessage(assistantMsg("u-2", blocks))!.content).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b" }]);
  });

  test("keeps at most CAPS.messageChars characters of content: the first blocks whole, the last one cut", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => ({ type: "text", text: String(i).repeat(LIMITS.text) }));
    const content = toPhoneMessage(assistantMsg("u-2", blocks))!.content as any[];
    const chars = content.reduce((sum, block) => sum + block.text.length, 0);
    expect(content.length).toBeGreaterThan(3);
    expect(content.length).toBeLessThan(10);
    expect(content[0].text).toBe("0".repeat(LIMITS.text));
    expect(content[content.length - 1].text.endsWith(MARK)).toBe(true);
    expect(chars).toBeLessThanOrEqual(CAPS.messageChars + MARK.length);
  });

  test("the budget is shared by every kind of content", () => {
    const blocks = [
      { type: "thinking", thinking: "t".repeat(LIMITS.thinking) },
      toolUse({ file_path: "/work/demo/a.ts", content: "c".repeat(LIMITS.inputString) }),
      ...Array.from({ length: 8 }, (_, i) => ({ type: "text", text: String(i).repeat(LIMITS.text) })),
    ];
    const content = toPhoneMessage(assistantMsg("u-2", blocks))!.content as any[];
    expect(content.length).toBeLessThan(blocks.length);
    expect(content[0].type).toBe("thinking");
    expect(content[1].type).toBe("tool_use");
    expect(bytes(content)).toBeLessThan(CAPS.messageChars + 1000);
  });

  test("ordinary heavy messages are not touched", () => {
    // ten parallel results of 3 000 characters, and three whole text blocks with thinking and a Write
    const results = Array.from({ length: 10 }, (_, i) => toolResultBlock(`toolu_${i}`, String(i).repeat(LIMITS.toolResult)));
    const resultsMapped = toPhoneMessage(userMsg("u-3", results))!;
    expect(resultsMapped.content).toHaveLength(10);
    expect(JSON.stringify(resultsMapped)).not.toContain(MARK);

    const blocks = [
      { type: "thinking", thinking: "t".repeat(LIMITS.thinking) },
      ...Array.from({ length: 3 }, (_, i) => ({ type: "text", text: String(i).repeat(LIMITS.text) })),
      toolUse({ file_path: "/work/demo/a.ts", content: "c".repeat(LIMITS.inputString) }),
    ];
    const mapped = toPhoneMessage(assistantMsg("u-2", blocks))!;
    expect(mapped.content).toHaveLength(5);
    expect(JSON.stringify(mapped)).not.toContain(MARK);
  });

  test("tool inputs share that budget: 5 000 strings of 3 999 characters are cut, not forwarded", () => {
    const input = { list: Array.from({ length: 5000 }, () => "y".repeat(3999)) };
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(input)]))!;
    const list = inputOf(mapped).list as string[];
    expect(bytes(mapped)).toBeLessThan(2 * CAPS.messageChars);
    expect(list.length).toBeGreaterThan(10);
    expect(list.length).toBeLessThan(40);
    expect(list[0]).toBe("y".repeat(3999));
    expect(list[list.length - 1]!.endsWith(MARK)).toBe(true);
  });

  test("a very wide input is cut, not copied: a million numbers, then a million empty strings", () => {
    const input = { numbers: Array.from({ length: 1000000 }, (_, i) => i), blanks: Array.from({ length: 1000000 }, () => "") };
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(input)]))!;
    expect(bytes(mapped)).toBeLessThan(2 * CAPS.messageChars);
    expect(inputOf(mapped).numbers.length).toBeGreaterThan(1000);
    expect(inputOf(mapped).numbers.slice(0, 3)).toEqual([0, 1, 2]);
    const blanks = toPhoneMessage(assistantMsg("u-2", [toolUse({ blanks: input.blanks })]))!;
    expect(bytes(blanks)).toBeLessThan(2 * CAPS.messageChars);
  });

  test("an object with a million keys is cut", () => {
    const input = Object.fromEntries(Array.from({ length: 1000000 }, (_, i) => [`key${i}`, i]));
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(input)]))!;
    expect(bytes(mapped)).toBeLessThan(2 * CAPS.messageChars);
    expect(Object.keys(inputOf(mapped))[0]).toBe("key0");
  });

  test("an input that shares nodes cannot blow up the copy", () => {
    // 20 levels that each hold the level below twice: 2^20 paths, tens of megabytes when every path is copied
    let node: any = { leaf: "x" };
    for (let i = 0; i < 20; i++) node = { a: node, b: node };
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(node)]))!;
    expect(bytes(mapped)).toBeLessThan(2 * CAPS.messageChars);
  });

  test("an input with two references to itself is cut, not walked 2^32 times", () => {
    // Walked in this process, a regression would hang the whole run, so it runs in a child that is killed after 10 s.
    const lib = path.resolve(import.meta.dir, "../lib/transcript.js");
    const code = `
      const { toPhoneMessage } = require(${JSON.stringify(lib)});
      const input = {}; input.x = input; input.y = input;
      const mapped = toPhoneMessage({ type: "assistant", uuid: "u", message: { content: [{ type: "tool_use", id: "i", name: "n", input }] } });
      console.log(JSON.stringify({ bytes: Buffer.byteLength(JSON.stringify(mapped)) }));
    `;
    const child = spawnSync(process.execPath, ["-e", code], { timeout: 10000, encoding: "utf8" });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout).bytes).toBeLessThan(2 * CAPS.messageChars);
  });

  test("an input that holds itself is cut at the depth cap", () => {
    const input: any = { name: "loop" };
    input.self = input;
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(input)]))!;
    expect(inputOf(mapped).name).toBe("loop");
    expect(bytes(mapped)).toBeLessThan(10000);
  });

  test("only JSON values come out of an input", () => {
    const input = { fine: [1, "two", true, null], gone: undefined, fn: () => 1, big: 10n, sym: Symbol("x") };
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(input)]))!;
    expect(inputOf(mapped)).toEqual({ fine: [1, "two", true, null], gone: null, fn: null, big: null, sym: null });
    expect(() => JSON.stringify(mapped)).not.toThrow();
  });

  test("long keys are paid for like text: five thousand keys of 150 characters", () => {
    const input = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => [String(i).padStart(4, "0") + "k".repeat(146), i]));
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse(input)]))!;
    expect(bytes(mapped)).toBeLessThan(2 * CAPS.messageChars);
    expect(Object.keys(inputOf(mapped)).length).toBeGreaterThan(100);
  });

  test("a deeply nested array is cut at the depth cap, not by the stack", () => {
    let nested: any = "end";
    for (let i = 0; i < 50000; i++) nested = [nested];
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse({ nested })]))!;
    expect(bytes(mapped)).toBeLessThan(1000);
  });

  test("where the budget runs out inside an object, only markers are left of what follows, however much is left", () => {
    // four whole text blocks and a fifth that leaves between 40 and 1 characters of the budget, then a call
    // whose key and values all want more than that
    for (let extra = 0; extra < 40; extra++) {
      const blocks = [
        ...Array.from({ length: 4 }, () => ({ type: "text", text: "a".repeat(LIMITS.text) })),
        { type: "text", text: "b".repeat(19920 + extra) },
        toolUse({ longkey: "v".repeat(LIMITS.inputString), another: "w".repeat(LIMITS.inputString) }),
      ];
      const mapped = toPhoneMessage(assistantMsg("u-2", blocks))!;
      expect(bytes(mapped.content), `extra ${extra}`).toBeLessThan(CAPS.messageChars + 1000);
    }
  });

  test("blocks and content of the wrong type are skipped, not fatal", () => {
    const sdk = assistantMsg("u-2", [null, 5, "text", [], { type: 7 }, { type: "text", text: "kept" }]);
    expect(toPhoneMessage(sdk)!.content).toEqual([{ type: "text", text: "kept" }]);
    for (const content of [42, {}, null, undefined, true]) expect(toPhoneMessage(userMsg("u-1", content))).toBeNull();
  });

  test("keys are cut to CAPS.identifier and paid for like text", () => {
    const key = "k".repeat(MB);
    const mapped = toPhoneMessage(assistantMsg("u-2", [toolUse({ [key]: "v", other: 1 })]))!;
    expect(Object.keys(inputOf(mapped))).toEqual([idCut(key), "other"]);
    expect(bytes(mapped)).toBeLessThan(2000);
  });

  test("identifiers are cut to CAPS.identifier: uuid, ts, parent, tool id and name, result id", () => {
    const long = (char: string) => char.repeat(MB);
    const sdk = assistantMsg(
      long("u"),
      [
        toolUse({}, long("i"), long("n")),
        toolResultBlock(long("t"), "ok"),
        { type: "document", title: long("d") },
      ],
      { timestamp: "2026-11-19T10:00:00.000Z".padEnd(MB, "0"), parent_tool_use_id: long("p") },
    );
    const mapped = toPhoneMessage(sdk)!;
    expect(mapped.uuid).toBe(idCut(long("u")));
    expect(mapped.ts).toBe(idCut("2026-11-19T10:00:00.000Z".padEnd(MB, "0")));
    expect(mapped.parent).toBe(idCut(long("p")));
    expect(mapped.content).toStrictEqual([
      { type: "tool_use", id: idCut(long("i")), name: idCut(long("n")), input: {} },
      { type: "tool_result", toolUseId: idCut(long("t")), text: "ok", isError: false },
      { type: "document", title: idCut(long("d")) },
    ]);
    expect(bytes(mapped)).toBeLessThan(3000);
  });

  test("a compaction marker's uuid and timestamp are cut too", () => {
    const mapped = toPhoneMessage({ type: "system", subtype: "compact_boundary", uuid: "c".repeat(MB), timestamp: "t".repeat(MB) })!;
    expect(mapped).toStrictEqual({ uuid: idCut("c".repeat(MB)), type: "system", subtype: "compact_boundary", ts: idCut("t".repeat(MB)) });
  });

  test("a result's subtype and uuid are cut too", () => {
    const mapped = toPhoneMessage({ type: "result", subtype: "s".repeat(MB), is_error: false, uuid: "r".repeat(MB) })!;
    expect(mapped.uuid).toBe(idCut("r".repeat(MB)));
    expect(mapped.result!.subtype).toBe(idCut("s".repeat(MB)));
    expect(bytes(mapped)).toBeLessThan(1000);
  });

  test("a tool id that is cut is cut the same way in the call and in its result, so they still pair up", () => {
    const id = "toolu_" + "x".repeat(500);
    const call = toPhoneMessage(assistantMsg("a", [toolUse({}, id, "Bash")]))!;
    const result = toPhoneMessage(userMsg("r", [toolResultBlock(id, "ok")]))!;
    expect((call.content as any[])[0].id).toBe((result.content as any[])[0].toolUseId);
  });

  test("identifiers that are short are left as they are", () => {
    const mapped = toPhoneMessage(assistantMsg("3f2a9c1e-0b7d-4c55-9d1e-0a1b2c3d4e5f", [toolUse({ command: "ls" }, "toolu_01ABCdefGHIjklMNOpqrSTU", "mcp__claude-in-chrome__computer")]))!;
    expect(mapped.uuid).toBe("3f2a9c1e-0b7d-4c55-9d1e-0a1b2c3d4e5f");
    expect(mapped.content).toEqual([{ type: "tool_use", id: "toolu_01ABCdefGHIjklMNOpqrSTU", name: "mcp__claude-in-chrome__computer", input: { command: "ls" } }]);
  });
});

describe("toPhoneMessage: result", () => {
  test("a finished turn", () => {
    const sdk = { type: "result", subtype: "success", is_error: false, duration_ms: 72000, total_cost_usd: 0.12, num_turns: 3, result: "All tests pass.", session_id: "s-1", uuid: "u-6" };
    expect(toPhoneMessage(sdk)).toStrictEqual({
      uuid: "u-6",
      type: "result",
      result: { subtype: "success", isError: false, durationMs: 72000, costUsd: 0.12, numTurns: 3 },
    });
  });

  test("an interrupted turn is an error, and absent numbers stay absent", () => {
    const sdk = { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s-1", uuid: "u-8", timestamp: "2026-11-19T10:10:00.000Z" };
    expect(toPhoneMessage(sdk)).toStrictEqual({
      uuid: "u-8",
      type: "result",
      ts: "2026-11-19T10:10:00.000Z",
      result: { subtype: "error_during_execution", isError: true },
    });
  });

  test("isError is the CLI's is_error, whatever the subtype says", () => {
    // an API error at the end of a turn arrives as a "success" that is an error; a limit is not an error to the CLI
    const apiError = { type: "result", subtype: "success", is_error: true, uuid: "u-6" };
    const limit = { type: "result", subtype: "error_max_turns", is_error: false, uuid: "u-7" };
    expect((toPhoneMessage(apiError) as any).result).toEqual({ subtype: "success", isError: true });
    expect((toPhoneMessage(limit) as any).result).toEqual({ subtype: "error_max_turns", isError: false });
  });

  test("an is_error that is not a boolean is no error", () => {
    for (const is_error of ["true", 1, "yes", null]) {
      expect((toPhoneMessage({ type: "result", subtype: "success", is_error, uuid: "u-6" }) as any).result.isError).toBe(false);
    }
  });

  test("a result without a subtype has the subtype unknown", () => {
    expect((toPhoneMessage({ type: "result", is_error: true, uuid: "u-6" }) as any).result).toEqual({ subtype: "unknown", isError: true });
  });

  test("zero is a value", () => {
    const sdk = { type: "result", subtype: "success", is_error: false, duration_ms: 0, total_cost_usd: 0, num_turns: 0, uuid: "u-6" };
    expect((toPhoneMessage(sdk) as any).result).toEqual({ subtype: "success", isError: false, durationMs: 0, costUsd: 0, numTurns: 0 });
  });

  test("is kept without a uuid, which then is empty", () => {
    const mapped = toPhoneMessage({ type: "result", subtype: "success", is_error: false, session_id: "s-1" })!;
    expect(mapped.uuid).toBe("");
    expect(mapped.type).toBe("result");
  });

  test("the final text of the turn is not forwarded (it is the last assistant message)", () => {
    const mapped = toPhoneMessage({ type: "result", subtype: "success", is_error: false, result: "SECRETFINALTEXT", uuid: "u-6" })!;
    expect(JSON.stringify(mapped)).not.toContain("SECRETFINALTEXT");
  });
});

describe("toStreamEvent", () => {
  test("a text delta", () => {
    const sdk = streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I'll " } });
    expect(toStreamEvent(sdk)).toStrictEqual({ type: "content_block_delta", index: 1, text: "I'll " });
  });

  test("other deltas are not forwarded", () => {
    for (const delta of [
      { type: "input_json_delta", partial_json: '{"comm' },
      { type: "thinking_delta", thinking: "hmm" },
      { type: "signature_delta", signature: "abc" },
      { type: "citations_delta", citation: {} },
    ]) {
      expect(toStreamEvent(streamEvent({ type: "content_block_delta", index: 0, delta }))).toBeNull();
    }
  });

  test("only a text_delta carries text, whatever else has a text field", () => {
    expect(toStreamEvent(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", text: "sneaky" } }))).toBeNull();
    expect(toStreamEvent(streamEvent({ type: "content_block_delta", index: 0, delta: { text: "no type" } }))).toBeNull();
  });

  test("a text_delta without text is not forwarded", () => {
    expect(toStreamEvent(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta" } }))).toBeNull();
    expect(toStreamEvent(streamEvent({ type: "content_block_delta", index: 0 }))).toBeNull();
  });

  test("a text delta is cut like text", () => {
    const delta = (text: string) => streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    expect(toStreamEvent(delta("z".repeat(3 * MB)))).toStrictEqual({ type: "content_block_delta", index: 0, text: "z".repeat(LIMITS.text) + MARK });
    expect(toStreamEvent(delta("z".repeat(LIMITS.text)))!.text).toBe("z".repeat(LIMITS.text));
  });

  test("an empty text delta is still forwarded (the app ignores it)", () => {
    expect(toStreamEvent(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "" } }))).toStrictEqual({ type: "content_block_delta", index: 0, text: "" });
  });

  test("the start and the end of a message and of a block", () => {
    expect(toStreamEvent(streamEvent({ type: "message_start", message: { id: "msg_01", role: "assistant", content: [] } }))).toStrictEqual({ type: "message_start" });
    expect(toStreamEvent(streamEvent({ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }))).toStrictEqual({ type: "content_block_start", index: 1 });
    expect(toStreamEvent(streamEvent({ type: "content_block_stop", index: 1 }))).toStrictEqual({ type: "content_block_stop", index: 1 });
    expect(toStreamEvent(streamEvent({ type: "message_stop" }))).toStrictEqual({ type: "message_stop" });
  });

  test("message_delta and unknown events are not forwarded", () => {
    expect(toStreamEvent(streamEvent({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: {} }))).toBeNull();
    expect(toStreamEvent(streamEvent({ type: "ping" }))).toBeNull();
    expect(toStreamEvent(streamEvent(undefined))).toBeNull();
  });

  test("an index that is not a number is left out", () => {
    expect(toStreamEvent(streamEvent({ type: "content_block_stop" }))).toStrictEqual({ type: "content_block_stop" });
    expect(toStreamEvent(streamEvent({ type: "content_block_stop", index: "1" }))).toStrictEqual({ type: "content_block_stop" });
  });

  test("any event with a parent_tool_use_id (a subagent's) is dropped", () => {
    const delta = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } };
    expect(toStreamEvent(streamEvent(delta, { parent_tool_use_id: "toolu_task" }))).toBeNull();
    expect(toStreamEvent(streamEvent({ type: "message_start" }, { parent_tool_use_id: "toolu_task" }))).toBeNull();
    expect(toStreamEvent(streamEvent({ type: "message_stop" }, { parent_tool_use_id: "toolu_task" }))).toBeNull();
  });

  test("a message that is not a stream_event is not an event", () => {
    expect(toStreamEvent(assistantMsg("u-2", [{ type: "text", text: "hi" }]))).toBeNull();
    const looksLikeOne = assistantMsg("u-2", [], { event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "x" } } });
    expect(toStreamEvent(looksLikeOne)).toBeNull();
    expect(toStreamEvent(null)).toBeNull();
    expect(toStreamEvent("stream_event")).toBeNull();
  });
});

describe("mergeHistory", () => {
  const messageCount = (n: number, from = 0) => Array.from({ length: n }, (_, i) => userMsg(`h${from + i}`, `message ${from + i}`));
  const uuids = (messages: { uuid: string }[]) => messages.map((m) => m.uuid);

  test("maps the history and appends live messages with unknown uuids, in order", () => {
    const history = [userMsg("u1", "first"), assistantMsg("u2", [{ type: "text", text: "second" }])];
    const live = [assistantMsg("u2", [{ type: "text", text: "second" }]), userMsg("l1", "third"), assistantMsg("l2", [{ type: "text", text: "fourth" }])];
    const { messages, truncatedBefore } = mergeHistory(history, live);
    expect(uuids(messages)).toEqual(["u1", "u2", "l1", "l2"]);
    expect(truncatedBefore).toBe(0);
    expect(messages[0]).toStrictEqual({ uuid: "u1", type: "user", content: [{ type: "text", text: "first" }] });
    expect(messages[3]).toStrictEqual({ uuid: "l2", type: "assistant", content: [{ type: "text", text: "fourth" }] });
  });

  test("the history's version of a known uuid wins, and a live uuid is taken once", () => {
    const history = [userMsg("u1", "from the history")];
    const live = [userMsg("u1", "from the live buffer", { isReplay: true }), userMsg("l1", "new"), userMsg("l1", "new again")];
    const { messages } = mergeHistory(history, live);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toStrictEqual({ uuid: "u1", type: "user", content: [{ type: "text", text: "from the history" }] });
    expect((messages[1] as any).content[0].text).toBe("new");
  });

  test("keeps the last 400 of 2 000 and counts what it cut", () => {
    const { messages, truncatedBefore } = mergeHistory(messageCount(2000), []);
    expect(messages).toHaveLength(400);
    expect(messages[0]!.uuid).toBe("h1600");
    expect(messages[399]!.uuid).toBe("h1999");
    expect(truncatedBefore).toBe(1600);
  });

  test("live messages count in the total", () => {
    const { messages, truncatedBefore } = mergeHistory(messageCount(399), messageCount(3, 1000));
    expect(messages).toHaveLength(400);
    expect(messages[0]!.uuid).toBe("h2");
    expect(messages[399]!.uuid).toBe("h1002");
    expect(truncatedBefore).toBe(2);
  });

  test("exactly the limit cuts nothing", () => {
    const { messages, truncatedBefore } = mergeHistory(messageCount(400), []);
    expect(messages).toHaveLength(400);
    expect(truncatedBefore).toBe(0);
  });

  test("takes a limit", () => {
    expect(mergeHistory(messageCount(10), [], 3)).toEqual({ messages: expect.any(Array), truncatedBefore: 7 });
    expect(uuids(mergeHistory(messageCount(10), [], 3).messages)).toEqual(["h7", "h8", "h9"]);
    expect(uuids(mergeHistory(messageCount(10), [], 2.5).messages)).toEqual(["h8", "h9"]); // a whole number of messages
    const none = mergeHistory(messageCount(10), [], 0);
    expect(none.messages).toEqual([]); // not slice(-0), which would be everything
    expect(none.truncatedBefore).toBe(10);
  });

  test("a limit that is no usable number is the default", () => {
    for (const limit of [-1, Number.NaN, "3", null]) {
      const { messages, truncatedBefore } = mergeHistory(messageCount(500), [], limit as any);
      expect(messages).toHaveLength(400);
      expect(truncatedBefore).toBe(100);
    }
    expect(mergeHistory(messageCount(500), [], Infinity).messages).toHaveLength(500);
  });

  test("what the mapping drops does not count", () => {
    const history = [
      { type: "system", subtype: "init", session_id: "s-1", uuid: "u-0", tools: [] },
      userMsg("u1", "hello"),
      streamEvent({ type: "message_start" }),
      userMsg("m1", "meta", { isMeta: true }),
      assistantMsg("u2", [{ type: "text", text: "hi" }]),
    ];
    const { messages, truncatedBefore } = mergeHistory(history, [], 2);
    expect(uuids(messages)).toEqual(["u1", "u2"]);
    expect(truncatedBefore).toBe(0);
  });

  test("takes messages that are already mapped, next to raw ones", () => {
    const mapped = toPhoneMessage(assistantMsg("u2", [{ type: "text", text: "second" }]))!;
    const mappedResult = toPhoneMessage({ type: "result", subtype: "success", is_error: false, uuid: "u-6", num_turns: 1 })!;
    const mappedBoundary = toPhoneMessage({ type: "system", subtype: "compact_boundary", uuid: "u-c", session_id: "s-1", timestamp: "2026-11-19T10:05:00.000Z" })!;
    const { messages } = mergeHistory([userMsg("u1", "first"), mapped, mappedBoundary], [mapped, mappedResult, userMsg("l1", "raw live")]);
    // The live result and the message after it follow u2, the live message before them.
    expect(uuids(messages)).toEqual(["u1", "u2", "u-6", "l1", "u-c"]);
    const byId = (uuid: string) => messages.find((m) => m.uuid === uuid);
    expect(byId("u2")).toStrictEqual(mapped);
    expect(byId("u-c")).toStrictEqual(mappedBoundary);
    expect(byId("u-c")!.ts).toBe("2026-11-19T10:05:00.000Z");
    expect(byId("u-6")).toStrictEqual(mappedResult);
    expect((byId("l1") as any).content[0].text).toBe("raw live");
  });

  test("raw system messages are filtered however their session id is spelled", () => {
    // the transcript on disk says sessionId, the live stream session_id, and some have neither
    const raw = [
      { type: "system", subtype: "status", uuid: "s1", sessionId: "s-1", permissionMode: "default" },
      { type: "system", subtype: "init", uuid: "s2", model: "claude-test", tools: ["Bash"] },
      { type: "system", subtype: "status", uuid: "s3", session_id: "s-1" },
      { type: "system", subtype: "status", uuid: "s4" }, // as bare as a phone message, but not the compaction marker
    ];
    expect(mergeHistory(raw, []).messages).toEqual([]);
    expect(mergeHistory([], raw).messages).toEqual([]);
  });

  test("a raw compaction marker is mapped without its metadata, however its session id is spelled", () => {
    const metadata = { trigger: "auto", pre_tokens: 120000 };
    for (const sessionKey of ["session_id", "sessionId", "other"]) {
      const raw = { type: "system", subtype: "compact_boundary", uuid: "s2", [sessionKey]: "s-1", compact_metadata: metadata, timestamp: "2026-11-19T10:05:00.000Z" };
      expect(mergeHistory([raw], []).messages).toStrictEqual([{ uuid: "s2", type: "system", subtype: "compact_boundary", ts: "2026-11-19T10:05:00.000Z" }]);
    }
    const bare = { type: "system", subtype: "compact_boundary", uuid: "s3" };
    expect(mergeHistory([bare], []).messages).toStrictEqual([{ uuid: "s3", type: "system", subtype: "compact_boundary" }]);
  });

  test("an SDK message is mapped even when it has a stray content field", () => {
    const raw = { ...userMsg("u1", "hello"), content: [{ type: "text", text: "STRAY" }] };
    const { messages } = mergeHistory([raw], []);
    expect(messages).toStrictEqual([{ uuid: "u1", type: "user", content: [{ type: "text", text: "hello" }] }]);
  });

  test("a mapped message is not trimmed or changed a second time", () => {
    const mapped = toPhoneMessage(userMsg("u1", [toolResultBlock("toolu_01", "o".repeat(10000))]))!;
    expect(mergeHistory([mapped], []).messages[0]).toStrictEqual(mapped);
  });

  test("a mapped message without a uuid is dropped, like a raw one", () => {
    const { messages } = mergeHistory([{ type: "user", content: [{ type: "text", text: "no uuid" }] }, { type: "user", uuid: "", content: [{ type: "text", text: "empty uuid" }] }] as any, []);
    expect(messages).toEqual([]);
  });

  test("results without a uuid are never taken for duplicates of each other", () => {
    const first = { type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s-1" };
    const second = { type: "result", subtype: "success", is_error: false, num_turns: 2, session_id: "s-1" };
    const { messages } = mergeHistory([], [first, second]);
    expect(messages).toHaveLength(2);
  });

  test("takes missing or odd lists as empty", () => {
    expect(mergeHistory(undefined as any, undefined as any)).toEqual({ messages: [], truncatedBefore: 0 });
    expect(mergeHistory(null as any, [userMsg("l1", "x")]).messages).toHaveLength(1);
    expect(mergeHistory([userMsg("h1", "x")], "nope" as any).messages).toHaveLength(1);
    expect(mergeHistory([null, 5, "x", userMsg("h1", "x")] as any, []).messages).toHaveLength(1);
  });

  test("a 2 000-message history with a 5 MB tool result serialises below 2 MB", () => {
    const history: unknown[] = [];
    for (let i = 0; i < 1000; i++) {
      history.push(assistantMsg(`a${i}`, [{ type: "tool_use", id: `toolu_${i}`, name: "Read", input: { file_path: `/work/demo/file-${i}.txt` } }]));
      // the 5 MB file read is among the last 400 messages, where it would end up in the snapshot
      const output = i === 990 ? "R".repeat(5 * MB) : `contents of file ${i}`;
      history.push(userMsg(`r${i}`, [toolResultBlock(`toolu_${i}`, output)]));
    }
    expect(history).toHaveLength(2000);
    const { messages, truncatedBefore } = mergeHistory(history, []);
    expect(messages).toHaveLength(400);
    expect(truncatedBefore).toBe(1600);
    const big = messages.find((m) => m.uuid === "r990")!;
    expect((big.content as any[])[0].text).toBe("R".repeat(LIMITS.toolResult) + MARK);
    expect(JSON.stringify(messages).length).toBeLessThan(2 * MB);
  });
});

describe("mergeHistory: where the live messages the history lacks go", () => {
  // The transcript on disk (comms.getSession) never holds a turn's result: only the live buffer has them.
  const result = (uuid: string, extra: Record<string, unknown> = {}) => ({
    type: "result",
    subtype: "success",
    is_error: false,
    uuid,
    session_id: "s-1",
    duration_ms: 1000,
    num_turns: 1,
    ...extra,
  });
  const at = (minute: number) => ({ timestamp: `2026-11-19T10:${String(minute).padStart(2, "0")}:00.000Z` });
  const text = (value: string) => [{ type: "text", text: value }];
  const uuids = (messages: { uuid: string }[]) => messages.map((m) => m.uuid);

  test("each turn's result follows that turn, not the whole history", () => {
    // Three turns as they ran in the E2E run: the history from disk, the live buffer since attach.
    const history = [
      userMsg("u1", "Reply with exactly: pong", at(1)),
      assistantMsg("a1", text("pong"), at(2)),
      userMsg("u2", "red or green?", at(3)),
      assistantMsg("a2", text("You prefer green."), at(4)),
      userMsg("u3", "Count slowly", at(5)),
      assistantMsg("a3", text("1\n2\n3"), at(6)),
      userMsg("u4", "[Request interrupted by user]", at(6)),
    ];
    const live = [
      userMsg("u1", "Reply with exactly: pong", { ...at(1), isReplay: true }),
      assistantMsg("a1", text("pong"), at(2)),
      result("r1"),
      userMsg("u2", "red or green?", { ...at(3), isReplay: true }),
      assistantMsg("a2", text("You prefer green."), at(4)),
      result("r2"),
      userMsg("u3", "Count slowly", { ...at(5), isReplay: true }),
      assistantMsg("a3", text("1\n2\n3"), at(6)),
      userMsg("u4", "[Request interrupted by user]", at(6)),
      result("r3", { subtype: "error_during_execution", is_error: true }),
    ];
    expect(uuids(mergeHistory(history, live).messages)).toEqual(["u1", "a1", "r1", "u2", "a2", "r2", "u3", "a3", "u4", "r3"]);
  });

  test("consecutive live-only messages keep their order after the message they follow", () => {
    const history = [userMsg("u1", "first"), assistantMsg("a1", text("second")), userMsg("u2", "third")];
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "c1", session_id: "s-1" };
    const live = [assistantMsg("a1", text("second")), result("r1"), boundary, userMsg("u2", "third")];
    expect(uuids(mergeHistory(history, live).messages)).toEqual(["u1", "a1", "r1", "c1", "u2"]);
  });

  test("a live-only message that follows nothing the history has goes where its timestamp sorts", () => {
    const history = [userMsg("u1", "a", at(1)), assistantMsg("a1", text("b"), at(2)), userMsg("u2", "c", at(5))];
    expect(uuids(mergeHistory(history, [userMsg("l3", "between", at(3))]).messages)).toEqual(["u1", "a1", "l3", "u2"]);
    expect(uuids(mergeHistory(history, [userMsg("l0", "before all", at(0))]).messages)).toEqual(["l0", "u1", "a1", "u2"]);
    expect(uuids(mergeHistory(history, [userMsg("l9", "after all", at(9))]).messages)).toEqual(["u1", "a1", "u2", "l9"]);
  });

  test("the live-only messages after one placed by its timestamp follow it", () => {
    const history = [userMsg("u1", "a", at(1)), assistantMsg("a1", text("b"), at(2)), userMsg("u2", "c", at(5))];
    const live = [userMsg("l3", "between", at(3)), result("r3")];
    expect(uuids(mergeHistory(history, live).messages)).toEqual(["u1", "a1", "l3", "r3", "u2"]);
  });

  test("a live-only message with neither a message before it nor a timestamp goes at the end", () => {
    const history = [userMsg("u1", "a", at(1)), assistantMsg("a1", text("b"), at(2))];
    expect(uuids(mergeHistory(history, [result("r0"), userMsg("l1", "next")]).messages)).toEqual(["u1", "a1", "r0", "l1"]);
  });

  test("the 400-message limit is applied after placing, and drops the oldest", () => {
    const history = Array.from({ length: 400 }, (_, i) => userMsg(`h${i}`, `message ${i}`));
    const { messages, truncatedBefore } = mergeHistory(history, [userMsg("h0", "message 0"), result("r0")]);
    expect(messages).toHaveLength(400);
    expect(uuids(messages.slice(0, 2))).toEqual(["r0", "h1"]);
    expect(messages[399]!.uuid).toBe("h399");
    expect(truncatedBefore).toBe(1);
  });

  test("the byte budget is applied after placing, and drops the oldest", () => {
    const history = Array.from({ length: 3 }, (_, i) => assistantMsg(`a${i}`, text(String(i).repeat(5000))));
    const live = [assistantMsg("a0", text("0".repeat(5000))), result("r0")];
    // Room for the three newest messages of the four, not for all four.
    const sizes = ["a1", "a2"].map((uuid) => bytes(toPhoneMessage(history[Number(uuid[1])]!)));
    const room = 2 + sizes[0]! + sizes[1]! + bytes(toPhoneMessage(result("r0"))) + 2;
    const { messages, truncatedBefore } = mergeHistory(history, live, 400, room);
    expect(uuids(messages)).toEqual(["r0", "a1", "a2"]);
    expect(truncatedBefore).toBe(1);
  });
});

describe("mergeHistory: the size of a snapshot", () => {
  const long = (count: number, size = 20000, content: (i: number) => unknown[] = () => [{ type: "text", text: "t".repeat(size) }]) =>
    Array.from({ length: count }, (_, i) => assistantMsg(`a${i}`, content(i)));
  const small = (count: number) => Array.from({ length: count }, (_, i) => userMsg(`h${i}`, `message ${i}`));
  const uuids = (messages: { uuid: string }[]) => messages.map((m) => m.uuid);

  test("400 messages of 20 000 characters stay within 2 MB: the oldest are dropped and counted", () => {
    const { messages, truncatedBefore } = mergeHistory(long(400), []);
    expect(bytes(messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    expect(JSON.stringify(messages).length).toBeLessThanOrEqual(2 * MB);
    expect(truncatedBefore).toBeGreaterThan(0);
    expect(messages.length + truncatedBefore).toBe(400);
    // the newest are kept, in order, and the budget is used up: one more message would not have fit
    expect(uuids(messages)).toEqual(Array.from({ length: messages.length }, (_, i) => `a${truncatedBefore + i}`));
    expect(messages[messages.length - 1]!.uuid).toBe("a399");
    expect(bytes(messages) + bytes(messages[0]) + 1).toBeGreaterThan(CAPS.snapshotBytes);
  });

  test("a heavy editing session, 200 Edit calls with 4 000-character strings and 200 results, fits", () => {
    const history: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      history.push(assistantMsg(`a${i}`, [{ type: "tool_use", id: `t${i}`, name: "Edit", input: { file_path: "/a/b.ts", old_string: "o".repeat(4000), new_string: "n".repeat(4000) } }]));
      history.push(userMsg(`r${i}`, [toolResultBlock(`t${i}`, "x".repeat(10000))]));
    }
    const { messages, truncatedBefore } = mergeHistory(history, []);
    expect(bytes(messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    expect(truncatedBefore).toBeGreaterThan(0);
    expect(messages.length + truncatedBefore).toBe(400);
    expect(messages[messages.length - 1]!.uuid).toBe("r199");
  });

  test("400 messages of 10 text blocks of 20 000 characters fit", () => {
    const { messages, truncatedBefore } = mergeHistory(long(400, 0, () => Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(20000) }))), []);
    expect(bytes(messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    expect(truncatedBefore).toBeGreaterThan(300);
  });

  test("messages are measured in bytes, not characters: multi-byte text takes more room", () => {
    const ascii = mergeHistory(long(400), []);
    const cjk = mergeHistory(long(400, 0, () => [{ type: "text", text: "あ".repeat(20000) }]), []);
    expect(bytes(cjk.messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    expect(cjk.messages.length).toBeLessThan(ascii.messages.length / 2);
    const emoji = mergeHistory(long(400, 0, () => [{ type: "text", text: "😀".repeat(10000) }]), []);
    expect(bytes(emoji.messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    // and text that JSON escapes is measured as it is sent: a control character takes six bytes
    const escaped = mergeHistory(long(400, 0, () => [{ type: "text", text: "\u0001".repeat(20000) }]), []);
    expect(bytes(escaped.messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    expect(escaped.messages.length).toBeLessThan(ascii.messages.length / 4);
  });

  test("small messages are not touched by the budget", () => {
    const { messages, truncatedBefore } = mergeHistory(small(400), []);
    expect(messages).toHaveLength(400);
    expect(truncatedBefore).toBe(0);
  });

  test("takes a byte budget of its own, and keeps exactly the newest messages that fit it", () => {
    const all = mergeHistory(small(10), [], 400, Infinity).messages;
    expect(all).toHaveLength(10);
    const needs = (k: number) => bytes(all.slice(all.length - k));
    for (const k of [1, 3, 10]) {
      const result = mergeHistory(small(10), [], 400, needs(k));
      expect(uuids(result.messages)).toEqual(uuids(all.slice(10 - k)));
      expect(result.truncatedBefore).toBe(10 - k);
    }
    // one byte short of what 3 messages need: 2 messages
    const short = mergeHistory(small(10), [], 400, needs(3) - 1);
    expect(uuids(short.messages)).toEqual(["h8", "h9"]);
    expect(short.truncatedBefore).toBe(8);
  });

  test("a budget that no message fits leaves nothing", () => {
    expect(mergeHistory(small(10), [], 400, 5)).toEqual({ messages: [], truncatedBefore: 10 });
    expect(mergeHistory(small(10), [], 400, 0)).toEqual({ messages: [], truncatedBefore: 10 });
    expect(mergeHistory([], [], 400, 0)).toEqual({ messages: [], truncatedBefore: 0 });
  });

  test("a byte budget that is no usable number is the default; Infinity is no budget", () => {
    for (const maxBytes of [-1, Number.NaN, "5", null]) {
      const { messages, truncatedBefore } = mergeHistory(long(400), [], 400, maxBytes as any);
      expect(bytes(messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
      expect(truncatedBefore).toBeGreaterThan(0);
    }
    expect(mergeHistory(long(400), [], 400, Infinity).messages).toHaveLength(400);
  });

  test("the count limit and the byte budget add up in truncatedBefore", () => {
    const { messages, truncatedBefore } = mergeHistory(long(300), [], 200);
    expect(messages.length).toBeLessThan(200); // the budget cut more than the count limit did
    expect(messages.length + truncatedBefore).toBe(300);
    expect(messages[messages.length - 1]!.uuid).toBe("a299");
    const roomy = mergeHistory(small(300), [], 200);
    expect(roomy.messages).toHaveLength(200);
    expect(roomy.truncatedBefore).toBe(100);
  });

  test("live messages are cut by the budget with the rest", () => {
    const { messages, truncatedBefore } = mergeHistory(long(300), long(300).map((m, i) => ({ ...m, uuid: `l${i}` })));
    expect(bytes(messages)).toBeLessThanOrEqual(CAPS.snapshotBytes);
    expect(messages[messages.length - 1]!.uuid).toBe("l299");
    expect(messages.length + truncatedBefore).toBe(600);
  });
});

describe("mergeHistory: messages that were mapped before are bounded again", () => {
  test("a phone-shaped entry is cut however large it says it is", () => {
    const entry = {
      type: "user",
      uuid: "p1",
      content: [
        { type: "text", text: "q".repeat(5 * MB) },
        { type: "tool_result", toolUseId: "x", text: "r".repeat(5 * MB), isError: false },
      ],
    };
    expect(mergeHistory([entry], []).messages).toStrictEqual([
      {
        uuid: "p1",
        type: "user",
        content: [
          { type: "text", text: "q".repeat(LIMITS.text) + MARK },
          { type: "tool_result", toolUseId: "x", text: "r".repeat(LIMITS.toolResult) + MARK, isError: false },
        ],
      },
    ]);
  });

  test("it is cut in the live list too", () => {
    const entry = { type: "assistant", uuid: "p1", content: [{ type: "thinking", text: "t".repeat(5 * MB) }, { type: "text", text: "w".repeat(5 * MB) }] };
    const { messages } = mergeHistory([], [entry]);
    expect(bytes(messages)).toBeLessThan(LIMITS.text + LIMITS.thinking + 1000);
  });

  test("blocks, characters, inputs and identifiers are bounded as for an SDK message", () => {
    const manyBlocks = { type: "assistant", uuid: "p1", content: Array.from({ length: 1000 }, (_, i) => ({ type: "text", text: `block ${i}` })) };
    expect(mergeHistory([manyBlocks], []).messages[0]!.content).toHaveLength(CAPS.blocks);

    const fat = { type: "assistant", uuid: "p2", content: Array.from({ length: 10 }, () => ({ type: "text", text: "x".repeat(LIMITS.text) })) };
    expect(bytes(mergeHistory([fat], []).messages)).toBeLessThan(CAPS.messageChars + 2000);

    const input = { list: Array.from({ length: 5000 }, () => "y".repeat(3999)), ["k".repeat(MB)]: 1 };
    const wide = { type: "assistant", uuid: "p3", content: [{ type: "tool_use", id: "i".repeat(MB), name: "n".repeat(MB), input }] };
    expect(bytes(mergeHistory([wide], []).messages)).toBeLessThan(2 * CAPS.messageChars);

    const longUuid = { type: "user", uuid: "u".repeat(MB), ts: "t".repeat(MB), parent: "p".repeat(MB), content: [{ type: "text", text: "hi" }] };
    const [mapped] = mergeHistory([longUuid], []).messages;
    expect([mapped!.uuid, mapped!.ts, mapped!.parent]).toEqual([idCut("u".repeat(MB)), idCut("t".repeat(MB)), idCut("p".repeat(MB))]);
  });

  test("it is sent with the fields we send and none else", () => {
    const entry = {
      type: "user",
      uuid: "p1",
      ts: "2026-11-19T10:00:00.000Z",
      parent: "toolu_task",
      isReplay: true,
      secret: "SECRETFIELD",
      content: [
        { type: "text", text: "hi", extra: "SECRETFIELD" },
        { type: "image", omitted: true, source: { data: "SECRETPIXELS" } },
        { type: "document", title: "spec.pdf", source: "SECRETFIELD" },
        { type: "tool_result", toolUseId: "toolu_1", text: "ok", isError: true, extra: "SECRETFIELD" },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" }, extra: "SECRETFIELD" },
        { type: "thinking", text: "hm", signature: "SECRETFIELD" },
        { type: "mystery", text: "SECRETFIELD" },
      ],
    };
    const [mapped] = mergeHistory([entry], []).messages;
    expect(mapped).toStrictEqual({
      uuid: "p1",
      type: "user",
      ts: "2026-11-19T10:00:00.000Z",
      parent: "toolu_task",
      isReplay: true,
      content: [
        { type: "text", text: "hi" },
        { type: "image", omitted: true },
        { type: "document", title: "spec.pdf" },
        { type: "tool_result", toolUseId: "toolu_1", text: "ok", isError: true },
        { type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "ls" } },
        { type: "thinking", text: "hm" },
      ],
    });
    expect(JSON.stringify(mapped)).not.toContain("SECRET");
  });

  test("a result and a compaction marker are rebuilt from their fields too", () => {
    const result = { type: "result", uuid: "r1", ts: "2026-11-19T10:00:00.000Z", secret: "SECRETFIELD", result: { subtype: "success", isError: false, durationMs: 5, costUsd: 0.5, numTurns: 2, extra: "SECRETFIELD" } };
    const boundary = { type: "system", subtype: "compact_boundary", uuid: "c1", ts: "2026-11-19T10:05:00.000Z" };
    const { messages } = mergeHistory([result, boundary], []);
    expect(messages).toStrictEqual([
      { uuid: "r1", type: "result", ts: "2026-11-19T10:00:00.000Z", result: { subtype: "success", isError: false, durationMs: 5, costUsd: 0.5, numTurns: 2 } },
      { uuid: "c1", type: "system", subtype: "compact_boundary", ts: "2026-11-19T10:05:00.000Z" },
    ]);
  });

  test("a result with odd fields is cleaned up", () => {
    const odd = { type: "result", uuid: "r1", result: { subtype: "s".repeat(MB), isError: "yes", durationMs: "5", costUsd: Number.NaN } };
    const [mapped] = mergeHistory([odd], []).messages;
    expect(mapped).toStrictEqual({ uuid: "r1", type: "result", result: { subtype: idCut("s".repeat(MB)), isError: false } });
  });

  test("blocks with fields of the wrong type are left out", () => {
    const entry = {
      type: "user",
      uuid: "p1",
      content: [
        { type: "tool_result", toolUseId: 5, text: "x" },
        { type: "tool_use", id: "toolu_1", name: 7, input: {} },
        { type: "text", text: 42 },
        { type: "tool_result", toolUseId: "toolu_2", text: { not: "text" }, isError: "yes" },
        null,
        "text",
      ],
    };
    expect(mergeHistory([entry], []).messages[0]!.content).toStrictEqual([{ type: "tool_result", toolUseId: "toolu_2", text: "", isError: false }]);
  });

  test("an entry that is left with nothing to show is dropped", () => {
    expect(mergeHistory([{ type: "assistant", uuid: "p1", content: [{ type: "thinking", text: "" }] }, { type: "user", uuid: "p2", content: [] }], []).messages).toEqual([]);
  });

  test("bounding twice changes nothing, wherever the budget runs out", () => {
    // an input whose depth marker and tail sit where the budget ends, for every alignment of it
    let deep: any = "end";
    for (let i = 0; i < 40; i++) deep = { n: deep }; // cut at the depth cap
    for (let extra = 0; extra < 700; extra++) {
      const blocks = [
        ...Array.from({ length: 4 }, () => ({ type: "text", text: "a".repeat(LIMITS.text) })),
        { type: "text", text: "b".repeat(18800 + extra) },
        { type: "tool_use", id: "toolu_1", name: "Odd", input: { deep, tail1: "x".repeat(30), tail2: "y".repeat(30), tail3: "z".repeat(30) } },
      ];
      const once = toPhoneMessage(assistantMsg("u-2", blocks))!;
      expect(mergeHistory([once], []).messages, `extra ${extra}`).toStrictEqual([once]);
    }
  });

  test("bounding a message that is bounded already changes nothing", () => {
    const surrogate = "a".repeat(LIMITS.text - 1) + "😀" + "b".repeat(50); // the cut falls inside the emoji
    let nested: any = { leaf: "x" };
    for (let i = 0; i < 20; i++) nested = { a: nested, b: nested };
    const fixtures: Record<string, unknown> = {
      "a long text": assistantMsg("f1", [{ type: "text", text: "x".repeat(25000) }]),
      "a cut that falls inside a surrogate pair": userMsg("f2", surrogate),
      "thinking": assistantMsg("f3", [{ type: "thinking", thinking: "t".repeat(5000) }]),
      "a long result": userMsg("f4", [toolResultBlock("toolu_1", "o".repeat(10000))]),
      "a Write": assistantMsg("f5", [{ type: "tool_use", id: "toolu_2", name: "Write", input: { file_path: "/a/b.ts", content: "c".repeat(9000) } }]),
      "500 blocks": assistantMsg("f6", Array.from({ length: 500 }, (_, i) => ({ type: "text", text: `block ${i}` }))),
      "ten whole blocks, the last ones cut by the budget": assistantMsg("f7", Array.from({ length: 10 }, (_, i) => ({ type: "text", text: String(i).repeat(LIMITS.text) }))),
      "5 000 strings in an input": assistantMsg("f8", [{ type: "tool_use", id: "toolu_3", name: "Odd", input: { list: Array.from({ length: 5000 }, () => "y".repeat(3999)) } }]),
      "a very deep input": assistantMsg("f9", [{ type: "tool_use", id: "toolu_4", name: "Odd", input: (() => { let n: any = { leaf: "x" }; for (let i = 0; i < 100; i++) n = { next: n }; return n; })() }]),
      "an input that shares nodes": assistantMsg("f10", [{ type: "tool_use", id: "toolu_5", name: "Odd", input: nested }]),
      "long identifiers": assistantMsg("u".repeat(500), [{ type: "tool_use", id: "i".repeat(500), name: "n".repeat(500), input: { ["k".repeat(500)]: 1 } }], { timestamp: "t".repeat(500), parent_tool_use_id: "p".repeat(500) }),
      "a long result subtype": { type: "result", subtype: "s".repeat(500), is_error: true, uuid: "r".repeat(500) },
      "an image and a document": userMsg("f11", [{ type: "image", source: {} }, { type: "document", title: "d".repeat(500) }]),
    };
    for (const [name, sdk] of Object.entries(fixtures)) {
      const once = toPhoneMessage(sdk)!;
      expect(once, name).not.toBeNull();
      expect(mergeHistory([once], []).messages, name).toStrictEqual([once]);
      expect(mergeHistory([], [once]).messages, name).toStrictEqual([once]);
    }
  });
});

describe("a whole turn", () => {
  test("maps the messages of one turn the way the phone shows them", () => {
    const turn = [
      { type: "system", subtype: "init", session_id: "s-1", uuid: "u-0", model: "claude-test", tools: ["Bash"] },
      userMsg("u-1", [{ type: "text", text: "fix the test" }], { isReplay: true, timestamp: "2026-11-19T10:00:00.000Z" }),
      streamEvent({ type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "I'll " } }),
      assistantMsg("u-2", [
        { type: "text", text: "I'll run the tests." },
        { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test", description: "Run tests" } },
      ]),
      userMsg("u-3", [toolResultBlock("toolu_01", "3 passed")]),
      userMsg("u-5", "<system-reminder>…</system-reminder>", { isMeta: true }),
      { type: "result", subtype: "success", is_error: false, duration_ms: 72000, total_cost_usd: 0.12, num_turns: 3, result: "Done", session_id: "s-1", uuid: "u-6" },
    ];
    expect(mergeHistory(turn, []).messages).toStrictEqual([
      { uuid: "u-1", type: "user", ts: "2026-11-19T10:00:00.000Z", isReplay: true, content: [{ type: "text", text: "fix the test" }] },
      {
        uuid: "u-2",
        type: "assistant",
        content: [
          { type: "text", text: "I'll run the tests." },
          { type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "npm test", description: "Run tests" } },
        ],
      },
      { uuid: "u-3", type: "user", content: [{ type: "tool_result", toolUseId: "toolu_01", text: "3 passed", isError: false }] },
      { uuid: "u-6", type: "result", result: { subtype: "success", isError: false, durationMs: 72000, costUsd: 0.12, numTurns: 3 } },
    ]);
  });
});
