import { describe, expect, test } from "bun:test";
import { FakeComms, createFakeComms, createFakeProvider, createFakeVscode } from "./fake-extension";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What the webview sends for a prompt (webview → host in sdk-shapes.md).
function prompt(channelId: string, text: string, uuid = "u-1") {
  return {
    type: "io_message",
    channelId,
    message: { type: "user", uuid, session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text }] } },
    done: false,
  };
}

/** A comms like the sidebar's: session `s1` is listed and runs on channel `c1`. */
function sidebar() {
  const comms = createFakeComms({ sessions: [{ id: "s1", summary: "Fix the test" }] });
  const channel = comms.openChannel("c1", "s1");
  return { comms, channel };
}

/** One word per host → webview message: `user`, `system/init`, `result/success` for io_messages, the type for the rest. */
const kinds = (sent: any[]) =>
  sent.map((m) => (m.type === "io_message" ? [m.message.type, m.message.subtype].filter(Boolean).join("/") : m.type));

const TURN = ["user", "system/init", "assistant", "result/success"];

const toolRequest = {
  type: "tool_permission_request",
  toolName: "Bash",
  inputs: { command: "npm test", description: "Run tests" },
  suggestions: [],
  toolUseId: "toolu_01",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
};

const allowResponse = {
  type: "tool_permission_response",
  result: { behavior: "allow", updatedInput: { command: "npm test", description: "Run tests" }, updatedPermissions: [] },
};

describe("createFakeVscode", () => {
  test("by default describes one folder of a VS Code Insiders window", () => {
    const vscode = createFakeVscode();
    expect(vscode.env.appName).toBe("Visual Studio Code - Insiders");
    expect(vscode.workspace.name).toBe("demo");
    expect(vscode.workspace.workspaceFolders).toEqual([
      { uri: expect.objectContaining({ scheme: "file", path: "/work/demo", fsPath: "/work/demo" }), name: "demo", index: 0 },
    ]);
    expect(vscode.workspace.workspaceFolders?.[0].uri.toString()).toBe("file:///work/demo");
    expect(vscode.commands.calls).toEqual([]);
  });

  test("takes folders, app name and workspace name", () => {
    const vscode = createFakeVscode({ folders: ["/work/a", "/work/b"], appName: "Cursor", name: "multi" });
    expect(vscode.env.appName).toBe("Cursor");
    expect(vscode.workspace.name).toBe("multi");
    expect(vscode.workspace.workspaceFolders?.map((f) => [f.uri.fsPath, f.name, f.index])).toEqual([
      ["/work/a", "a", 0],
      ["/work/b", "b", 1],
    ]);
  });

  test("a window without a folder has workspaceFolders undefined, and name: null leaves the name undefined", () => {
    const vscode = createFakeVscode({ folders: [], name: null });
    expect(vscode.workspace.workspaceFolders).toBeUndefined();
    expect(vscode.workspace.name).toBeUndefined();
  });

  test("setFolders changes the folders and fires onDidChangeWorkspaceFolders until the subscription is disposed", () => {
    const vscode = createFakeVscode();
    const events: any[] = [];
    const subscription = vscode.workspace.onDidChangeWorkspaceFolders((event: any) => events.push(event));

    vscode.workspace.setFolders(["/work/demo", "/work/b"]);
    expect(vscode.workspace.workspaceFolders?.map((f) => f.uri.fsPath)).toEqual(["/work/demo", "/work/b"]);
    expect(events).toHaveLength(1);
    expect(events[0].added.map((f: any) => f.uri.fsPath)).toEqual(["/work/b"]);
    expect(events[0].removed).toEqual([]);

    vscode.workspace.setFolders(["/work/b"]);
    expect(events).toHaveLength(2);
    expect(events[1].added).toEqual([]);
    expect(events[1].removed.map((f: any) => f.uri.fsPath)).toEqual(["/work/demo"]);

    subscription.dispose();
    vscode.workspace.setFolders([]);
    expect(vscode.workspace.workspaceFolders).toBeUndefined();
    expect(events).toHaveLength(2);
  });

  test("executeCommand records each call, then runs the onCommand hook and resolves with its result", async () => {
    const vscode = createFakeVscode();
    expect(await vscode.commands.executeCommand("claude-vscode.sidebar.open")).toBeUndefined();

    const seen: any[] = [];
    vscode.commands.onCommand = (id, args) => {
      seen.push([id, args, vscode.commands.calls.length]);
      return Promise.resolve("opened");
    };
    expect(await vscode.commands.executeCommand("claude-vscode.editor.open", "s3", "hello")).toBe("opened");

    expect(vscode.commands.calls).toEqual([
      { id: "claude-vscode.sidebar.open", args: [] },
      { id: "claude-vscode.editor.open", args: ["s3", "hello"] },
    ]);
    // The call was already on record when the hook ran.
    expect(seen).toEqual([["claude-vscode.editor.open", ["s3", "hello"], 2]]);
  });

  test("the hook can be set on the fake itself too, and a failing hook rejects the command but keeps the record", async () => {
    const vscode = createFakeVscode();
    vscode.onCommand = () => {
      throw new Error("command 'x' not found");
    };
    expect(vscode.commands.onCommand).toBe(vscode.onCommand);
    await expect(vscode.commands.executeCommand("x", 1)).rejects.toThrow("command 'x' not found");
    expect(vscode.commands.calls).toEqual([{ id: "x", args: [1] }]);
  });
});

describe("createFakeProvider", () => {
  test("has the members the bridge reads, all empty", () => {
    const provider = createFakeProvider();
    expect(provider.allComms).toBeInstanceOf(Set);
    expect(provider.sessionStates).toBeInstanceOf(Map);
    expect(provider.unreadSessionKeys).toBeInstanceOf(Set);
    expect(provider.liveElsewhereSessions).toEqual([]);
    expect(provider.output.lines).toEqual([]);
    expect(provider.allComms.size + provider.sessionStates.size + provider.unreadSessionKeys.size).toBe(0);
  });

  test("output records one tagged line per call", () => {
    const { output } = createFakeProvider();
    output.info("started", 3);
    output.warn("careful");
    output.error(new Error("broken"));
    output.debug("details");
    output.trace("fine detail");
    expect(output.lines).toEqual(["[info] started 3", "[warn] careful", "[error] Error: broken", "[debug] details", "[trace] fine detail"]);
  });

  test("output has the members of a VS Code LogOutputChannel and no others (a call to anything else would fail in the host)", () => {
    expect(Object.keys(createFakeProvider().output).sort()).toEqual(["debug", "error", "info", "lines", "trace", "warn"]);
    expect(Object.keys(createFakeComms().logger).sort()).toEqual(["error", "lines", "log", "warn"]);
  });

  test("two providers share nothing", () => {
    const [one, two] = [createFakeProvider(), createFakeProvider()];
    one.allComms.add(createFakeComms());
    one.unreadSessionKeys.add("s1");
    one.output.info("x");
    expect(two.allComms.size + two.unreadSessionKeys.size + two.output.lines.length).toBe(0);
  });

  test("an instance-level wrapper on allComms.add works, as the bridge needs", () => {
    const provider = createFakeProvider();
    const added: FakeComms[] = [];
    const add = provider.allComms.add;
    provider.allComms.add = function (this: Set<FakeComms>, comms: FakeComms) {
      added.push(comms);
      return add.call(this, comms);
    };
    const comms = createFakeComms();
    provider.allComms.add(comms);
    expect([...provider.allComms]).toEqual([comms]);
    expect(added).toEqual([comms]);
  });
});

describe("FakeComms, as the bridge finds it", () => {
  test("starts empty, in /work/demo, with its CLI simulation on", () => {
    const comms = createFakeComms();
    expect(comms).toBeInstanceOf(FakeComms);
    expect(comms.cwd).toBe("/work/demo");
    expect(comms.channels).toBeInstanceOf(Map);
    expect(comms.pendingChannels).toBeInstanceOf(Map);
    expect(comms.outstandingRequests).toBeInstanceOf(Map);
    expect([comms.channels.size, comms.pendingChannels.size, comms.outstandingRequests.size]).toEqual([0, 0, 0]);
    expect([comms.sent, comms.received, comms.webview.posted]).toEqual([[], [], []]);
    expect([comms.autoTurn, comms.readerError, comms.initialPermissionMode]).toEqual([true, undefined, undefined]);
    expect([comms.persistedDefaultModes, comms.permissionModeChanges]).toEqual([[], []]);
    expect(createFakeComms({ cwd: "/work/other" }).cwd).toBe("/work/other");
    expect(createFakeComms({ autoTurn: false }).autoTurn).toBe(false);
    expect(createFakeComms({ initialPermissionMode: "acceptEdits" }).initialPermissionMode).toBe("acceptEdits");
  });

  test("send, fromClient, processRequest, getSession and buildSessionList are prototype methods", () => {
    const comms = createFakeComms();
    for (const name of ["send", "fromClient", "processRequest", "getSession", "buildSessionList"] as const) {
      expect(typeof FakeComms.prototype[name]).toBe("function");
      expect(Object.hasOwn(comms, name)).toBe(false);
    }
  });

  test("send records the message and posts it to the webview in the from-extension envelope", () => {
    const comms = createFakeComms();
    const message = { type: "cancel_request", targetRequestId: "r-9" };
    expect(comms.send(message)).toBeUndefined();
    expect(comms.sent).toEqual([message]);
    expect(comms.webview.posted).toEqual([{ type: "from-extension", message }]);
  });

  test("webview.postMessage works detached and resolves true, like the real one", async () => {
    const { webview } = createFakeComms();
    const { postMessage } = webview;
    expect(await postMessage({ type: "x" })).toBe(true);
    expect(webview.posted).toEqual([{ type: "x" }]);
  });

  test("an instance-level send wrapper sees every message the fake host sends, and what it swallows never gets out", async () => {
    const { comms } = sidebar();
    const seen: any[] = [];
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      seen.push(message);
      if (message.type === "io_message" && message.message.type === "system") return; // swallow
      return original.call(this, message);
    };

    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();

    expect(kinds(seen)).toEqual(TURN);
    expect(kinds(comms.sent)).toEqual(["user", "assistant", "result/success"]);
    expect(comms.webview.posted).toHaveLength(3);
  });

  test("an instance-level fromClient wrapper may drop a message: the host never sees it", async () => {
    const { comms } = sidebar();
    const original = comms.fromClient;
    comms.fromClient = function (this: FakeComms, message: any) {
      if (message.type === "response") return Promise.resolve();
      return original.call(this, message);
    };
    const answer = comms.requestPermission("c1", toolRequest);
    await comms.fromClient({ type: "response", requestId: answer.requestId, response: allowResponse });
    await comms.flush();
    expect(comms.received).toEqual([]);
    expect(comms.outstandingRequests.has(answer.requestId)).toBe(true);
  });
});

describe("fromClient simulates the host", () => {
  test("records the message at once and reacts later, in order", async () => {
    const { comms } = sidebar();
    const first = prompt("c1", "one", "u-1");
    const second = prompt("c1", "two", "u-2");

    const queued = [comms.fromClient(first), comms.fromClient(second)];
    expect(comms.received).toEqual([first, second]);
    expect(comms.sent).toEqual([]);
    expect(queued.every((p) => p instanceof Promise)).toBe(true);

    await comms.flush();
    expect(kinds(comms.sent)).toEqual([...TURN, ...TURN]);
    const replays = comms.sent.filter((m) => m.message.type === "user").map((m) => m.message.uuid);
    expect(replays).toEqual(["u-1", "u-2"]);
    expect(comms.sent[3].message.result).toContain("one");
    expect(comms.sent[7].message.result).toContain("two");
  });

  test("a prompt's dispatch only hands it to the CLI: nothing is answered when await fromClient returns, nor a few microtasks later", async () => {
    const { comms, channel } = sidebar();
    const message = prompt("c1", "hi");

    const queued = comms.fromClient(message);
    // Recorded at once, but the host's reader has not got to it: it is not on the CLI's input and the flags are untouched.
    expect(comms.received).toEqual([message]);
    expect(channel.in.queue).toEqual([]);
    expect([channel.atRest, channel.turnComplete]).toEqual([true, false]);
    expect(comms.sent).toEqual([]);
    await queued;
    expect(comms.sent).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(comms.sent).toEqual([]);

    // The prompt is on the CLI's input and the turn is open, but the CLI has not said a word.
    expect(channel.in.queue).toEqual([message.message]);
    expect([channel.atRest, channel.turnComplete]).toEqual([false, false]);

    await comms.flush();
    expect(kinds(comms.sent)).toEqual(TURN);
    expect(channel.in.queue).toEqual([]);
    expect([channel.atRest, channel.turnComplete]).toEqual([true, true]);
  });

  test("a prompt produces the replay, system/init, an assistant text and a result on sent", async () => {
    const { comms } = sidebar();
    const message = prompt("c1", "fix the test", "u-10");
    await comms.fromClient(message);
    await comms.flush();

    expect(kinds(comms.sent)).toEqual(TURN);
    for (const sent of comms.sent) expect(sent).toMatchObject({ type: "io_message", channelId: "c1", done: false });
    const [replay, init, assistant, result] = comms.sent.map((m) => m.message);

    expect(replay).toEqual({ ...message.message, isReplay: true, session_id: "s1" });
    expect(init).toMatchObject({ type: "system", subtype: "init", session_id: "s1", cwd: "/work/demo" });
    expect(init.uuid).toEqual(expect.any(String));
    expect(init.tools).toEqual(expect.any(Array));
    expect(assistant).toMatchObject({
      type: "assistant",
      session_id: "s1",
      parent_tool_use_id: null,
      message: { role: "assistant", content: [{ type: "text", text: expect.stringContaining("fix the test") }] },
    });
    expect(result).toMatchObject({ type: "result", subtype: "success", is_error: false, num_turns: 1, session_id: "s1", user_message_uuid: "u-10" });
    expect(new Set([init.uuid, assistant.uuid, result.uuid]).size).toBe(3);
    expect(comms.webview.posted).toEqual(comms.sent.map((m) => ({ type: "from-extension", message: m })));
  });

  test("the prompt text can be plain string content, several blocks, or images only", async () => {
    const { comms } = sidebar();
    const send = (content: unknown) =>
      comms.fromClient({ type: "io_message", channelId: "c1", message: { type: "user", uuid: "u-x", message: { role: "user", content } }, done: false });
    await send("plain words");
    await send([
      { type: "text", text: "<ide_opened_file>…</ide_opened_file>" },
      { type: "text", text: "the question" },
    ]);
    await send([{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } }]);
    await comms.flush();

    const replies = comms.sent.filter((m) => m.message.type === "assistant").map((m) => m.message.message.content[0].text);
    expect(replies[0]).toContain("plain words");
    expect(replies[1]).toContain("<ide_opened_file>…</ide_opened_file>\nthe question");
    expect(typeof replies[2]).toBe("string");
  });

  test("with autoTurn off nothing answers: the prompt waits on the channel's input for the test, and done closes the input", async () => {
    const comms = createFakeComms({ autoTurn: false });
    const channel = comms.openChannel("c1", "s1");
    const first = prompt("c1", "hi", "u-1");
    const second = { ...prompt("c1", "bye", "u-2"), done: true };

    await comms.fromClient(first);
    await comms.flush();
    expect(comms.sent).toEqual([]);
    expect(channel.in.queue).toEqual([first.message]);
    expect(channel.in.isDone).toBe(false);
    expect([channel.atRest, channel.turnComplete]).toEqual([false, false]);

    await comms.fromClient(second);
    await comms.flush();
    expect(comms.sent).toEqual([]);
    expect(channel.in.queue).toEqual([first.message, second.message]);
    expect(channel.in.isDone).toBe(true);

    // The test plays the CLI.
    comms.emit("c1", { type: "result", subtype: "success", is_error: false, session_id: "s1", uuid: "u-9" });
    expect(kinds(comms.sent)).toEqual(["result/success"]);
    expect([channel.atRest, channel.turnComplete]).toEqual([true, true]);
  });

  test("with autoTurn on the CLI reads the prompts off its input, oldest first, as it answers them", async () => {
    const { comms, channel } = sidebar();
    await comms.fromClient(prompt("c1", "one", "u-1"));
    await comms.fromClient(prompt("c1", "two", "u-2"));
    expect(channel.in.queue.map((m) => m.uuid)).toEqual(["u-1", "u-2"]);

    await comms.flush();
    expect(channel.in.queue).toEqual([]);
    expect(kinds(comms.sent)).toEqual([...TURN, ...TURN]);
    expect(comms.sent.filter((m) => m.message.isReplay).map((m) => m.message.uuid)).toEqual(["u-1", "u-2"]);
  });

  test("a new session's id is on the replay from the start, but the channel only learns it at system/init", async () => {
    const comms = createFakeComms();
    const channel = comms.openChannel("c9");
    expect(channel.sessionId).toBeUndefined();

    // What an agent that reads the channel would see as each message goes out.
    const onChannel: Array<string | undefined> = [];
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      onChannel.push(channel.sessionId);
      return original.call(this, message);
    };

    await comms.fromClient(prompt("c9", "first", "u-1"));
    await comms.flush();
    const id = comms.sent[0].message.session_id as string;
    expect(id).toMatch(/^s-\d+$/);
    expect(comms.sent.map((m) => m.message.session_id)).toEqual([id, id, id, id]);
    expect(onChannel).toEqual([undefined, id, id, id]);
    expect(channel.sessionId).toBe(id);

    await comms.fromClient(prompt("c9", "second", "u-2"));
    await comms.flush();
    expect(comms.sent.slice(4).map((m) => m.message.session_id)).toEqual([id, id, id, id]);
    expect(onChannel.slice(4)).toEqual([id, id, id, id]);
  });

  test("new session ids are never reused: not across comms, and not for a session the comms lists, has a history for or has a channel on", async () => {
    const one = createFakeComms();
    one.openChannel("c1");
    await one.fromClient(prompt("c1", "a"));
    await one.flush();
    const n = Number((one.channels.get("c1")?.sessionId as string).slice(2));

    const two = createFakeComms({ sessions: [{ id: `s-${n + 1}` }] });
    two.setHistory(`s-${n + 2}`, []);
    two.openChannel("c0", `s-${n + 3}`, { pending: true });
    two.openChannel("c1", `s-${n + 4}`);
    two.openChannel("c2");
    await two.fromClient(prompt("c2", "b"));
    await two.flush();
    expect(two.channels.get("c2")?.sessionId).toBe(`s-${n + 5}`);
  });

  test("the turn flags follow the host's: a prompt clears them, the result sets them", async () => {
    const { comms, channel } = sidebar();
    expect([channel.atRest, channel.turnComplete]).toEqual([true, false]);

    const flagsAtReplay: boolean[][] = [];
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      if (message.message?.isReplay) flagsAtReplay.push([channel.atRest, channel.turnComplete]);
      return original.call(this, message);
    };
    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();

    expect(flagsAtReplay).toEqual([[false, false]]);
    expect([channel.atRest, channel.turnComplete]).toEqual([true, true]);
  });

  test("a prompt for a channel that does not exist is logged and gets no answer", async () => {
    const { comms } = sidebar();
    await comms.fromClient(prompt("c404", "hi"));
    await comms.flush();
    expect(comms.sent).toEqual([]);
    expect(comms.logger.lines).toEqual(["[warn] Channel not found for io_message: c404"]);
  });

  test("a prompt on a channel that is still launching waits on its input; once the launch completes the CLI answers it", async () => {
    const comms = createFakeComms();
    const launching = comms.openChannel("c2", "s2", { pending: true });
    const message = prompt("c2", "hi");
    await comms.fromClient(message);
    await comms.flush();
    expect(comms.sent).toEqual([]);
    expect(launching.in.queue).toEqual([message.message]);
    expect(Object.keys(launching).sort()).toEqual(["in", "sessionId"]);

    const running = comms.promoteChannel("c2");
    expect(running.atRest).toBe(false); // a prompt is waiting
    await comms.flush();
    expect(kinds(comms.sent)).toEqual(TURN);
    expect(comms.sent[0].message.session_id).toBe("s2");
    expect(running.in.queue).toEqual([]);
    expect([running.atRest, running.turnComplete]).toEqual([true, true]);
  });

  test("io_messages that are not prompts are ignored", async () => {
    const { comms, channel } = sidebar();
    await comms.fromClient({ type: "io_message", channelId: "c1", message: { type: "assistant", uuid: "u-2" }, done: false });
    await comms.flush();
    expect(comms.sent).toEqual([]);
    expect(channel.in.queue).toEqual([]);
  });

  test("a message type it does not know is logged as an error", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "teleport" });
    await comms.flush();
    expect(comms.logger.lines).toEqual(["[error] Unknown message: teleport"]);
  });

  test("a message the host cannot read kills its reader: later messages are recorded but never handled, and readerError says why", async () => {
    const { comms } = sidebar();
    const answer = comms.requestPermission("c1", toolRequest);
    expect(comms.readerError).toBeUndefined();

    // The result sits under the wrong key: the host reads response.type of a request that waits, and throws.
    const wrong = { type: "response", requestId: answer.requestId, result: allowResponse.result };
    const later = [wrong, prompt("c1", "after the bad one"), { type: "response", requestId: answer.requestId, response: allowResponse }];
    for (const message of later) await comms.fromClient(message);
    await comms.flush();

    expect(comms.readerError).toBeInstanceOf(TypeError);
    expect(comms.received).toEqual(later); // still recorded
    expect(kinds(comms.sent)).toEqual(["request"]); // the host's own request; nothing was answered
    expect(comms.outstandingRequests.has(answer.requestId)).toBe(true); // and the request waits for ever
    expect(comms.logger.lines).toEqual([]); // the host logs nothing about its reader dying
    expect(comms.channels.get("c1")?.in.queue).toEqual([]); // the prompt never reached the CLI
  });

  test("an io_message without a message kills the reader when its channel exists; for a channel that does not exist it is only a warning", async () => {
    const quiet = sidebar().comms;
    await quiet.fromClient({ type: "io_message", channelId: "c404", done: false });
    await quiet.fromClient(prompt("c1", "still handled"));
    await quiet.flush();
    expect(quiet.readerError).toBeUndefined();
    expect(quiet.logger.lines).toEqual(["[warn] Channel not found for io_message: c404"]);
    expect(kinds(quiet.sent)).toEqual(TURN);

    const { comms } = sidebar();
    await comms.fromClient({ type: "io_message", channelId: "c1", done: false });
    await comms.fromClient(prompt("c1", "after the bad one"));
    await comms.flush();
    expect(comms.readerError).toBeInstanceOf(TypeError);
    expect(comms.sent).toEqual([]);
    expect(comms.received).toHaveLength(2);
  });

  test("a response without a response is only the warning when nobody waits for it, as the host reads it only for a waiting request", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "response", requestId: "nope" });
    await comms.fromClient(prompt("c1", "still handled"));
    await comms.flush();
    expect(comms.readerError).toBeUndefined();
    expect(comms.logger.lines).toEqual(["[warn] No handler for response with requestId: nope"]);
    expect(kinds(comms.sent)).toEqual(TURN);
  });

  test("a message that is not an object kills the reader too", async () => {
    for (const bad of [null, undefined]) {
      const { comms } = sidebar();
      await comms.fromClient(bad as any);
      await comms.fromClient(prompt("c1", "hi"));
      await comms.flush();
      expect(comms.readerError).toBeInstanceOf(TypeError);
      expect(comms.sent).toEqual([]);
    }
  });

  test("a failing request, an unknown message and a cancel for nothing leave the reader alive", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "no_such_request" } });
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-2" });
    await comms.fromClient({ type: "teleport" });
    await comms.fromClient({ type: "cancel_request", targetRequestId: "w-unknown" });
    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();
    expect(comms.readerError).toBeUndefined();
    expect(kinds(comms.sent.slice(-4))).toEqual(TURN);
  });

  test("a dead reader does not stop the host's own traffic: its requests go out, the CLI's messages are forwarded, channels close", async () => {
    const { comms } = sidebar();
    await comms.fromClient(null as any);
    await comms.flush();
    expect(comms.readerError).toBeInstanceOf(TypeError);

    const answer = comms.requestPermission("c1", toolRequest);
    comms.emit("c1", { type: "assistant", uuid: "u-2" });
    comms.closeChannel("c1");
    expect(kinds(comms.sent)).toEqual(["request", "assistant", "close_channel"]);
    expect(comms.channels.size).toBe(0);
    expect(comms.outstandingRequests.has(answer.requestId)).toBe(true); // no answer can be read any more
  });

  test("a throw while the CLI's turn is forwarded closes the channel with the error and ends the turn; the reader lives on", async () => {
    const { comms, channel } = sidebar();
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      if (message.message?.subtype === "init") throw new Error("webview disposed");
      return original.call(this, message);
    };

    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();
    expect(comms.sent).toEqual([
      expect.objectContaining({ type: "io_message", message: expect.objectContaining({ type: "user", isReplay: true }) }),
      { type: "close_channel", channelId: "c1", error: "Error: webview disposed" },
    ]);
    expect(comms.channels.size).toBe(0);
    expect(channel.in.isDone).toBe(true);
    expect(comms.logger.lines).toEqual(["[error] Error from Claude (on channel c1): Error: webview disposed"]);
    expect(comms.readerError).toBeUndefined();

    // The reader still reads: a prompt for the closed channel gets the host's warning.
    await comms.fromClient(prompt("c1", "again"));
    await comms.flush();
    expect(comms.logger.lines.at(-1)).toBe("[warn] Channel not found for io_message: c1");
  });

  test("flush also waits for messages that other messages cause", async () => {
    const { comms } = sidebar();
    const original = comms.send;
    let followedUp = false;
    comms.send = function (this: FakeComms, message: any) {
      original.call(this, message);
      if (!followedUp && message.message?.type === "result") {
        followedUp = true;
        void this.fromClient(prompt("c1", "again", "u-2"));
      }
    };
    await comms.fromClient(prompt("c1", "first", "u-1"));
    await comms.flush();
    expect(kinds(comms.sent)).toEqual([...TURN, ...TURN]);
  });

  test("flush also waits for a request that is still running, even one a later message started", async () => {
    const { comms } = sidebar();
    const process = comms.processRequest;
    comms.processRequest = async function (this: FakeComms, e: any, signal: AbortSignal) {
      if (e.request.type !== "slow") return process.call(this, e, signal);
      await sleep(20);
      return { type: "slow_response" };
    };
    const send = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      send.call(this, message);
      if (message.message?.isReplay) void this.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "slow" } });
    };

    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();
    expect(comms.sent.at(-1)).toEqual({ type: "response", requestId: "w-1", response: { type: "slow_response" } });
  });

  test("interrupt_claude ends the turn, a moment later, with an error_during_execution result", async () => {
    const { comms, channel } = sidebar();
    await comms.fromClient({ type: "interrupt_claude", channelId: "c1" });
    expect(comms.sent).toEqual([]); // the CLI has not answered yet
    await comms.flush();
    expect(comms.sent).toHaveLength(1);
    expect(comms.sent[0]).toMatchObject({
      type: "io_message",
      channelId: "c1",
      done: false,
      message: { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1" },
    });
    expect([channel.atRest, channel.turnComplete]).toEqual([true, false]);
  });

  test("an interrupt gets no answer with autoTurn off, nor when the channel is closed before the CLI gets to it", async () => {
    const quiet = createFakeComms({ autoTurn: false });
    quiet.openChannel("c1", "s1");
    await quiet.fromClient({ type: "interrupt_claude", channelId: "c1" });
    await quiet.flush();
    expect(quiet.sent).toEqual([]);

    const { comms, channel } = sidebar();
    await comms.fromClient(prompt("c1", "hi"));
    await comms.fromClient({ type: "interrupt_claude", channelId: "c1" });
    await comms.fromClient({ type: "close_channel", channelId: "c1" });
    await comms.flush();
    expect(comms.sent).toEqual([]); // the process is gone: no turn and no result
    expect(channel.in.queue).toHaveLength(1); // and it never read the prompt
  });

  test("a channel closed in the middle of a turn gets no more of it", async () => {
    const { comms } = sidebar();
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      original.call(this, message);
      if (message.message?.isReplay) this.closeChannel("c1", false); // the panel is closed as the replay goes out
    };
    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();
    expect(kinds(comms.sent)).toEqual(["user"]);
  });

  test("interrupt_claude on an unknown channel is only logged; on a launching one it closes the channel", async () => {
    const comms = createFakeComms();
    await comms.fromClient({ type: "interrupt_claude", channelId: "c404" });
    comms.openChannel("c2", undefined, { pending: true });
    await comms.fromClient({ type: "interrupt_claude", channelId: "c2" });
    await comms.flush();
    expect(comms.logger.lines).toEqual(["[warn] Channel not found: c404"]);
    expect(comms.sent).toEqual([{ type: "close_channel", channelId: "c2", error: "Interrupted during launch" }]);
    expect(comms.pendingChannels.size).toBe(0);
  });

  test("launch_claude registers a launching channel on the session to resume; promoteChannel makes the running one", async () => {
    const comms = createFakeComms();
    await comms.fromClient({ type: "launch_claude", channelId: "c7", resume: "s5", cwd: "/work/demo/sub", permissionMode: "default" });
    await comms.fromClient({ type: "launch_claude", channelId: "c8" });
    await comms.fromClient({ type: "launch_claude", channelId: "c7", resume: "s6" });
    await comms.flush();
    expect(comms.channels.size).toBe(0);
    expect([...comms.pendingChannels.keys()]).toEqual(["c7", "c8"]);
    expect(comms.pendingChannels.get("c7")?.sessionId).toBe("s5");
    expect(comms.pendingChannels.get("c8")?.sessionId).toBeUndefined();
    expect(comms.logger.lines).toEqual(["[error] Channel already exists: c7"]);

    const launching = comms.pendingChannels.get("c7") as NonNullable<ReturnType<typeof comms.pendingChannels.get>>;
    const running = comms.promoteChannel("c7");
    expect(running).toEqual({ in: launching.in, sessionId: "s5", cwd: "/work/demo/sub", atRest: true, turnComplete: false, runningBackgroundTasks: 0 });
    expect(comms.promoteChannel("c8").cwd).toBe("/work/demo");
    expect(comms.pendingChannels.size).toBe(0);
  });

  test("close_channel from the webview drops the channel without telling the webview back", async () => {
    const { comms, channel } = sidebar();
    await comms.fromClient({ type: "close_channel", channelId: "c1" });
    await comms.flush();
    expect(comms.channels.size).toBe(0);
    expect(channel.in.isDone).toBe(true);
    expect(comms.sent).toEqual([]);
  });

  test("close_channel from the webview also drops a launching channel, and says nothing back", async () => {
    const comms = createFakeComms();
    const launching = comms.openChannel("c2", "s2", { pending: true });
    await comms.fromClient({ type: "close_channel", channelId: "c2" });
    await comms.flush();
    expect(comms.pendingChannels.size).toBe(0);
    expect(launching.in.isDone).toBe(true);
    expect(comms.sent).toEqual([]);
  });
});

describe("requests, in both directions", () => {
  test("requestPermission sends the real request message and resolves with the webview's response", async () => {
    const { comms } = sidebar();
    const answer = comms.requestPermission("c1", toolRequest);

    expect(answer.requestId).toEqual(expect.any(String));
    expect(comms.sent).toEqual([{ type: "request", channelId: "c1", requestId: answer.requestId, request: toolRequest }]);
    expect(comms.outstandingRequests.has(answer.requestId)).toBe(true);

    await comms.fromClient({ type: "response", requestId: answer.requestId, response: allowResponse });
    expect(await answer).toEqual(allowResponse);
    expect(comms.outstandingRequests.size).toBe(0);
    expect(comms.logger.lines).toEqual([]);
  });

  test("an error response rejects the request with its message", async () => {
    const { comms } = sidebar();
    const answer = comms.requestPermission("c1", toolRequest);
    await comms.fromClient({ type: "response", requestId: answer.requestId, response: { type: "error", error: "the webview went away" } });
    await expect(answer).rejects.toThrow("the webview went away");
    expect(comms.outstandingRequests.size).toBe(0);
  });

  test("user dialogs use the same path, and every request gets its own id, across comms too", async () => {
    const [one, two] = [sidebar().comms, sidebar().comms];
    const dialog = { type: "user_dialog_request", dialogKind: "auto_mode_server_fallback", payload: {}, toolUseID: "toolu_02" };
    const tool = one.requestPermission("c1", toolRequest);
    const dialogAnswer = one.requestPermission("c1", dialog);
    const other = two.requestPermission("c1", toolRequest);
    expect(new Set([tool.requestId, dialogAnswer.requestId, other.requestId]).size).toBe(3);
    expect(one.sent[1]).toEqual({ type: "request", channelId: "c1", requestId: dialogAnswer.requestId, request: dialog });

    const cancelled = { type: "user_dialog_response", result: { behavior: "cancelled" } };
    await one.fromClient({ type: "response", requestId: dialogAnswer.requestId, response: cancelled });
    expect(await dialogAnswer).toEqual(cancelled);
    expect([...one.outstandingRequests.keys()]).toEqual([tool.requestId]);
    expect(two.outstandingRequests.size).toBe(1);
  });

  test("a response nobody waits for is logged the way the host logs it, also a second answer for the same request", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "response", requestId: "nope", response: { type: "x" } });
    const answer = comms.requestPermission("c1", toolRequest);
    await comms.fromClient({ type: "response", requestId: answer.requestId, response: allowResponse });
    await answer;
    await comms.fromClient({ type: "response", requestId: answer.requestId, response: allowResponse });
    await comms.flush();
    expect(comms.logger.lines).toEqual([
      "[warn] No handler for response with requestId: nope",
      `[warn] No handler for response with requestId: ${answer.requestId}`,
    ]);
  });

  test("aborting the signal withdraws the prompt: cancel_request goes to the webview and the request rejects", async () => {
    const { comms } = sidebar();
    const controller = new AbortController();
    const answer = comms.requestPermission("c1", toolRequest, controller.signal);
    controller.abort("the CLI withdrew the prompt");
    await expect(answer).rejects.toThrow("the CLI withdrew the prompt");
    expect(kinds(comms.sent)).toEqual(["request", "cancel_request"]);
    expect(comms.sent[1]).toEqual({ type: "cancel_request", targetRequestId: answer.requestId });
    expect(comms.outstandingRequests.size).toBe(0);
  });

  test("a signal that is already aborted sends the cancel only, never the request", async () => {
    const { comms } = sidebar();
    const controller = new AbortController();
    controller.abort();
    const answer = comms.requestPermission("c1", toolRequest, controller.signal);
    await expect(answer).rejects.toThrow(/abort/i);
    expect(kinds(comms.sent)).toEqual(["cancel_request"]);
    expect(comms.outstandingRequests.size).toBe(0);
  });

  test("a request from the webview runs through processRequest and its answer goes back as a response", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "list_sessions_request", entryPoint: "x" } });
    await comms.flush();
    expect(comms.sent).toEqual([
      { type: "response", requestId: "w-1", response: { type: "list_sessions_response", sessions: [expect.objectContaining({ id: "s1" })], folderKey: expect.any(String) } },
    ]);
    expect(comms.abortControllers.size).toBe(0);
  });

  test("handleRequest calls processRequest through the instance, so a wrapper can take a request over", async () => {
    const { comms } = sidebar();
    const seen: any[] = [];
    const original = comms.processRequest;
    comms.processRequest = function (this: FakeComms, e: any, signal: AbortSignal) {
      seen.push([e.request.type, signal instanceof AbortSignal]);
      if (e.request.type.startsWith("cce_remote_")) return Promise.resolve({ type: "cce_remote_status_response", ok: true });
      return original.call(this, e, signal);
    };
    await comms.fromClient({ type: "request", channelId: "", requestId: "w-1", request: { type: "cce_remote_status" } });
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-2", request: { type: "get_session_request", sessionId: "s1" } });
    await comms.flush();

    expect(seen).toEqual([["cce_remote_status", true], ["get_session_request", true]]);
    // Requests run side by side, so the answers are matched by id, not by position.
    expect(Object.fromEntries(comms.sent.map((m) => [m.requestId, m.response.type]))).toEqual({
      "w-1": "cce_remote_status_response",
      "w-2": "get_session_response",
    });
  });

  test("a request that fails answers with an error response, like the host", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "no_such_request" } });
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-2", request: { type: "get_session_request", sessionId: "s404" } });
    await comms.flush();
    const responses = Object.fromEntries(comms.sent.map((m) => [m.requestId, m.response]));
    expect(comms.sent.every((m) => m.type === "response")).toBe(true);
    expect(responses["w-1"]).toEqual({ type: "error", error: "Unknown request type." });
    expect(responses["w-2"]).toEqual({ type: "error", error: expect.stringContaining("s404") });
    expect(comms.logger.lines).toHaveLength(2);
    expect(comms.logger.lines.every((line) => line.startsWith("[error] Error processing client request: "))).toBe(true);
  });

  test("a request without a request is answered with an error response, as the host's processRequest throws on it; the reader lives on", async () => {
    const { comms } = sidebar();
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1" });
    await comms.fromClient(prompt("c1", "hi"));
    await comms.flush();
    expect(comms.sent[0]).toEqual({ type: "response", requestId: "w-1", response: { type: "error", error: expect.any(String) } });
    expect(comms.logger.lines).toEqual([expect.stringMatching(/^\[error\] Error processing client request: TypeError/)]);
    expect(comms.readerError).toBeUndefined();
    expect(kinds(comms.sent.slice(1))).toEqual(TURN);
  });

  test("a request whose answer cannot be sent is answered with an error response instead, as the host's catch does", async () => {
    const { comms } = sidebar();
    const original = comms.send;
    let failed = false;
    comms.send = function (this: FakeComms, message: any) {
      if (!failed && message.type === "response") {
        failed = true;
        throw new Error("webview disposed");
      }
      return original.call(this, message);
    };
    await comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "list_sessions_request" } });
    await comms.flush();
    expect(comms.sent).toEqual([{ type: "response", requestId: "w-1", response: { type: "error", error: "webview disposed" } }]);
    expect(comms.logger.lines).toEqual(["[error] Error processing client request: Error: webview disposed"]);
    expect(comms.readerError).toBeUndefined();
    expect(comms.abortControllers.size).toBe(0);
  });

  test("a slow request does not hold up the messages behind it", async () => {
    const { comms } = sidebar();
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = comms.processRequest;
    comms.processRequest = async function (this: FakeComms, e: any, signal: AbortSignal) {
      if (e.request.type === "slow") {
        await gate;
        return { type: "slow_response" };
      }
      return original.call(this, e, signal);
    };

    void comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "slow" } });
    void comms.fromClient(prompt("c1", "hi"));
    await sleep(10);
    expect(kinds(comms.sent)).toEqual(TURN);

    release();
    await comms.flush();
    expect(comms.sent.at(-1)).toEqual({ type: "response", requestId: "w-1", response: { type: "slow_response" } });
  });

  test("cancel_request from the webview aborts the signal of the request it names", async () => {
    const { comms } = sidebar();
    comms.processRequest = function (e: any, signal: AbortSignal) {
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("cancelled by the webview"))));
    } as any;
    void comms.fromClient({ type: "request", channelId: "c1", requestId: "w-1", request: { type: "slow" } });
    void comms.fromClient({ type: "cancel_request", targetRequestId: "w-1" });
    void comms.fromClient({ type: "cancel_request", targetRequestId: "w-unknown" });
    await comms.flush();
    expect(comms.sent).toEqual([{ type: "response", requestId: "w-1", response: { type: "error", error: "cancelled by the webview" } }]);
    expect(comms.abortControllers.size).toBe(0);
    // A cancel for a request that is not running (any more) is ignored without a word, as in the host.
    expect(comms.logger.lines).toEqual(["[error] Error processing client request: Error: cancelled by the webview"]);
  });

  test("set_permission_mode succeeds on an open channel and remembers the mode, with the flag it came with", async () => {
    const { comms } = sidebar();
    const request = (id: string, mode: unknown, userInitiated: boolean, channelId = "c1") =>
      comms.fromClient({ type: "request", channelId, requestId: id, request: { type: "set_permission_mode", mode, userInitiated } });
    await request("cce-remote-1", "acceptEdits", false);
    await request("cce-remote-2", "plan", false);
    await comms.flush();

    expect(comms.sent.map((m) => m.response)).toEqual([
      { type: "set_permission_mode_response", success: true },
      { type: "set_permission_mode_response", success: true },
    ]);
    expect(comms.sent.map((m) => m.requestId)).toEqual(["cce-remote-1", "cce-remote-2"]);
    expect(comms.permissionModes.get("c1")).toBe("plan");
    expect(comms.permissionModeChanges).toEqual([
      { channelId: "c1", mode: "acceptEdits", userInitiated: false },
      { channelId: "c1", mode: "plan", userInitiated: false },
    ]);
  });

  test("userInitiated decides whether the host rewrites the user's default mode: false, as a plan approval sends it, leaves it alone", async () => {
    const { comms } = sidebar();
    const request = (id: string, mode: string, userInitiated: boolean) =>
      comms.fromClient({ type: "request", channelId: "c1", requestId: id, request: { type: "set_permission_mode", mode, userInitiated } });

    for (const [id, mode] of [["w-1", "acceptEdits"], ["w-2", "auto"], ["w-3", "default"], ["w-4", "plan"]]) await request(id, mode, false);
    await comms.flush();
    expect(comms.sent.every((m) => m.response.success === true)).toBe(true);
    expect(comms.permissionModes.get("c1")).toBe("plan");
    expect(comms.persistedDefaultModes).toEqual([]);
    expect(comms.initialPermissionMode).toBeUndefined();

    // true is a picker click: the new mode becomes the user's default, once, and only for the three modes the host keeps.
    for (const [id, mode] of [["w-5", "acceptEdits"], ["w-6", "acceptEdits"], ["w-7", "plan"], ["w-8", "dontAsk"], ["w-9", "auto"], ["w-10", "default"]]) await request(id, mode, true);
    await comms.flush();
    expect(comms.persistedDefaultModes).toEqual(["acceptEdits", "auto", "default"]);
    expect(comms.initialPermissionMode).toBe("default");
    expect(comms.permissionModeChanges.map((c) => c.userInitiated)).toEqual([false, false, false, false, true, true, true, true, true, true]);
  });

  test("a user-initiated change to the mode the user already starts in writes nothing", async () => {
    const comms = createFakeComms({ initialPermissionMode: "default" });
    comms.openChannel("c1", "s1");
    const request = (id: string, mode: string) =>
      comms.fromClient({ type: "request", channelId: "c1", requestId: id, request: { type: "set_permission_mode", mode, userInitiated: true } });
    await request("w-1", "default");
    await comms.flush();
    expect(comms.persistedDefaultModes).toEqual([]);
    await request("w-2", "auto");
    await comms.flush();
    expect(comms.persistedDefaultModes).toEqual(["auto"]);
  });

  test("set_permission_mode refuses unknown modes and bypassPermissions, writing nothing, and fails for a channel that is not there", async () => {
    const { comms } = sidebar();
    const request = (id: string, mode: unknown, channelId = "c1") =>
      comms.fromClient({ type: "request", channelId, requestId: id, request: { type: "set_permission_mode", mode, userInitiated: true } });
    await request("w-1", "yolo");
    await request("w-2", "bypassPermissions");
    await request("w-3", "default", "c404");
    await comms.flush();

    expect(comms.sent.map((m) => m.response)).toEqual([
      { type: "set_permission_mode_response", success: false },
      { type: "set_permission_mode_response", success: false },
      { type: "error", error: "Channel not found: c404" },
    ]);
    expect(comms.permissionModes.size).toBe(0);
    expect(comms.permissionModeChanges).toEqual([]);
    expect(comms.persistedDefaultModes).toEqual([]);
  });

  test("set_permission_mode on a launching channel waits for the launch, and fails if the channel is closed mid-launch", async () => {
    const comms = createFakeComms();
    comms.openChannel("c2", undefined, { pending: true });
    comms.openChannel("c3", undefined, { pending: true });
    const request = (id: string, channelId: string) =>
      comms.fromClient({ type: "request", channelId, requestId: id, request: { type: "set_permission_mode", mode: "plan", userInitiated: false } });
    await request("w-1", "c2");
    await request("w-2", "c3");
    await sleep(10);
    expect(comms.sent).toEqual([]); // both wait for their launch

    comms.promoteChannel("c2");
    comms.closeChannel("c3", false);
    await comms.flush();
    expect(Object.fromEntries(comms.sent.map((m) => [m.requestId, m.response]))).toEqual({
      "w-1": { type: "set_permission_mode_response", success: true },
      "w-2": { type: "error", error: "Channel closed mid-launch" },
    });
    expect(comms.permissionModes.get("c2")).toBe("plan");
  });
});

describe("the window's config (2.1.330)", () => {
  // The agent reads the config the host already holds and must never make it load one (that can start a Claude
  // process): both ways the host loads it count, so a test can check that none happened.
  test("loadConfig() and get_claude_state count as config loads and answer with the settled config", async () => {
    const comms = createFakeComms();
    comms.settledConfig = { commands: [{ name: "compact" }] };
    expect(comms.configLoads).toBe(0);
    expect(await comms.loadConfig()).toEqual({ commands: [{ name: "compact" }] });
    const answer = await comms.processRequest({ type: "request", channelId: "", requestId: "r-x", request: { type: "get_claude_state" } }, new AbortController().signal);
    expect(answer).toEqual({ type: "get_claude_state_response", config: { commands: [{ name: "compact" }] }, cached: true });
    expect(comms.configLoads).toBe(2);
  });
});

describe("helpers for the test", () => {
  test("openChannel registers a channel shaped like the host's and returns it", () => {
    const comms = createFakeComms();
    const channel = comms.openChannel("c1", "s1");
    expect(comms.channels.get("c1")).toBe(channel);
    expect(channel).toEqual({ in: expect.anything(), sessionId: "s1", cwd: "/work/demo", atRest: true, turnComplete: false, runningBackgroundTasks: 0 });
    expect(typeof channel.in.enqueue).toBe("function");
    expect(typeof channel.in.done).toBe("function");
    expect(comms.sent).toEqual([]);

    expect(comms.openChannel("c2", "s2", { cwd: "/work/demo/sub" }).cwd).toBe("/work/demo/sub");
    expect(comms.openChannel("c3").sessionId).toBeUndefined();
  });

  test("openChannel with pending: true registers what the host holds while launching, {in, sessionId}, and an id can be opened once", () => {
    const comms = createFakeComms();
    const launching = comms.openChannel("c1", "s1", { pending: true });
    expect(comms.pendingChannels.get("c1")).toBe(launching);
    expect(comms.channels.size).toBe(0);
    expect(launching).toEqual({ in: expect.anything(), sessionId: "s1" });
    expect(Object.keys(launching).sort()).toEqual(["in", "sessionId"]);
    expect(() => comms.openChannel("c1", "s1")).toThrow("Channel already exists: c1");
    comms.openChannel("c2");
    expect(() => comms.openChannel("c2", undefined, { pending: true })).toThrow("Channel already exists: c2");
  });

  test("promoteChannel replaces the launching channel with a running one: a new object around the same input, with the cwd of the launch", () => {
    const comms = createFakeComms();
    const launching = comms.openChannel("c1", "s1", { pending: true, cwd: "/work/demo/sub" });
    const running = comms.promoteChannel("c1");
    expect(comms.pendingChannels.size).toBe(0);
    expect(comms.channels.get("c1")).toBe(running);
    expect(running).not.toBe(launching);
    expect(running.in).toBe(launching.in);
    expect(running).toEqual({ in: launching.in, sessionId: "s1", cwd: "/work/demo/sub", atRest: true, turnComplete: false, runningBackgroundTasks: 0 });
    expect(comms.sent).toEqual([]);
  });

  test("promoteChannel is only for a channel that is launching", () => {
    const comms = createFakeComms();
    comms.openChannel("c1", "s1");
    expect(() => comms.promoteChannel("c1")).toThrow("Channel is not launching: c1");
    expect(() => comms.promoteChannel("c404")).toThrow("Channel is not launching: c404");
  });

  test("a launch that was closed leaves nothing behind for the next launch of the same id", () => {
    const comms = createFakeComms();
    comms.openChannel("c1", "s1", { pending: true, cwd: "/work/demo/sub" });
    comms.closeChannel("c1", false);
    comms.openChannel("c1", "s1", { pending: true });
    expect(comms.promoteChannel("c1").cwd).toBe("/work/demo");
  });

  test("emit sends an io_message envelope for an SDK message", () => {
    const { comms } = sidebar();
    const message = { type: "assistant", uuid: "u-2", session_id: "s1", parent_tool_use_id: null, message: { role: "assistant", content: [] } };
    comms.emit("c1", message);
    expect(comms.sent).toEqual([{ type: "io_message", channelId: "c1", message, done: false }]);
    expect(comms.received).toEqual([]);
  });

  test("emit refuses a channel that is not open, so a typo in a test is loud", () => {
    const { comms } = sidebar();
    expect(() => comms.emit("c404", { type: "result" })).toThrow("emit: channel c404 is not open");
    expect(comms.sent).toEqual([]);
  });

  test("a send that throws while the CLI's message is forwarded closes the channel with the error, as the host's loop does; emit does not throw", () => {
    const { comms, channel } = sidebar();
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      if (message.message?.type === "assistant") throw new Error("webview disposed");
      return original.call(this, message);
    };

    expect(() => comms.emit("c1", { type: "assistant", uuid: "u-2" })).not.toThrow();
    expect(comms.sent).toEqual([{ type: "close_channel", channelId: "c1", error: "Error: webview disposed" }]);
    expect(comms.channels.size).toBe(0);
    expect(channel.in.isDone).toBe(true);
    expect(comms.logger.lines).toEqual(["[error] Error from Claude (on channel c1): Error: webview disposed"]);
    expect(() => comms.emit("c1", { type: "result" })).toThrow("emit: channel c1 is not open");
  });

  test("emit moves the turn flags: a turn clears them, a result sets them, noise leaves them", () => {
    const { comms, channel } = sidebar();
    const flags = () => [channel.atRest, channel.turnComplete];
    comms.emit("c1", { type: "system", subtype: "init", session_id: "s1" });
    expect(flags()).toEqual([false, false]);
    comms.emit("c1", { type: "rate_limit_event" });
    comms.emit("c1", { type: "prompt_suggestion" });
    comms.emit("c1", { type: "system", subtype: "status", permissionMode: "default" });
    expect(flags()).toEqual([false, false]);
    comms.emit("c1", { type: "result", subtype: "success", is_error: false });
    expect(flags()).toEqual([true, true]);
    comms.emit("c1", { type: "rate_limit_event" });
    expect(flags()).toEqual([true, true]);
    comms.emit("c1", { type: "stream_event", event: { type: "message_start" } });
    expect(flags()).toEqual([false, false]);
    comms.emit("c1", { type: "result", subtype: "error_during_execution", is_error: true });
    expect(flags()).toEqual([true, false]);
  });

  test("background tasks keep the channel from rest past a result; the list emptying does not bring it back, the next result does", () => {
    const { comms, channel } = sidebar();
    const flags = () => [channel.atRest, channel.turnComplete, channel.runningBackgroundTasks];
    expect(flags()).toEqual([true, false, 0]);
    comms.emit("c1", { type: "system", subtype: "init", session_id: "s1" });
    comms.emit("c1", { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "b1", task_type: "local_bash" }] });
    expect(flags()).toEqual([false, false, 1]);
    comms.emit("c1", { type: "result", subtype: "success", is_error: false, num_turns: 2 });
    expect(flags()).toEqual([false, false, 1]); // the turn ended, the shell runs on
    comms.emit("c1", { type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(flags()).toEqual([false, false, 0]); // the host keeps what it had
    comms.emit("c1", { type: "system", subtype: "init", session_id: "s1" });
    comms.emit("c1", { type: "result", subtype: "success", is_error: false, num_turns: 1 });
    expect(flags()).toEqual([true, true, 0]);
    // an ambient task is not counted, but any word from a task clears the flags, as the host's BWe/QY do
    comms.emit("c1", { type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: "a1", task_type: "local_agent", ambient: true }] });
    expect(flags()).toEqual([true, true, 0]);
    for (const subtype of ["task_started", "task_progress", "task_updated", "task_notification"]) {
      comms.emit("c1", { type: "system", subtype: "init", session_id: "s1" });
      comms.emit("c1", { type: "result", subtype: "success", is_error: false, num_turns: 1 });
      comms.emit("c1", { type: "system", subtype, task_id: "a1" });
      expect([subtype, ...flags()]).toEqual([subtype, false, false, 0]);
    }
    comms.emit("c1", { type: "system", subtype: "background_tasks_changed", tasks: [] });
    expect(flags()).toEqual([false, false, 0]);
    // an entry that is not an object is counted; a list that is not an array counts as one
    comms.emit("c1", { type: "system", subtype: "background_tasks_changed", tasks: [null, { task_id: "m1", task_type: "monitor_ws", ambient: false }] });
    expect(flags()).toEqual([false, false, 2]);
    comms.emit("c1", { type: "system", subtype: "background_tasks_changed" });
    expect(flags()).toEqual([false, false, 1]);
  });

  test("emit of a system/init names the session of the channel before the message goes out, as the host's loop does", () => {
    const comms = createFakeComms();
    const fresh = comms.openChannel("c1");
    const resumed = comms.openChannel("c2", "s1");
    const launching = comms.openChannel("c3", undefined, { pending: true });
    const seen: Array<string | undefined> = [];
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      seen.push(this.channels.get(message.channelId)?.sessionId);
      return original.call(this, message);
    };

    comms.emit("c1", { type: "system", subtype: "init", session_id: "s7" });
    comms.emit("c1", { type: "assistant", session_id: "s8" });
    comms.emit("c2", { type: "system", subtype: "init", session_id: "s2" });
    comms.emit("c3", { type: "system", subtype: "init", session_id: "s9" });

    expect(seen).toEqual(["s7", "s7", "s2", undefined]);
    expect([fresh.sessionId, resumed.sessionId, launching.sessionId]).toEqual(["s7", "s2", undefined]);
  });

  test("closeChannel tells the webview first and drops the channel after, with the error only when given", () => {
    const { comms, channel } = sidebar();
    comms.openChannel("c2", undefined, { pending: true });
    const stillThere: boolean[] = [];
    const original = comms.send;
    comms.send = function (this: FakeComms, message: any) {
      stillThere.push(this.channels.has(message.channelId) || this.pendingChannels.has(message.channelId));
      return original.call(this, message);
    };

    comms.closeChannel("c1");
    comms.closeChannel("c2", true, "the CLI exited");
    comms.closeChannel("c404");

    expect(comms.sent).toEqual([
      { type: "close_channel", channelId: "c1" },
      { type: "close_channel", channelId: "c2", error: "the CLI exited" },
    ]);
    expect(stillThere).toEqual([true, true]);
    expect(comms.channels.size + comms.pendingChannels.size).toBe(0);
    expect(channel.in.isDone).toBe(true);
  });

  test("closeChannel leaves the requests of that channel waiting, as the host does", async () => {
    const { comms } = sidebar();
    const answer = comms.requestPermission("c1", toolRequest);
    comms.closeChannel("c1");
    expect(comms.outstandingRequests.has(answer.requestId)).toBe(true);
    await comms.fromClient({ type: "response", requestId: answer.requestId, response: allowResponse });
    expect(await answer).toEqual(allowResponse);
  });
});

describe("sessions", () => {
  test("getSession returns the history the test set, as a fresh copy in the host's response", async () => {
    const comms = createFakeComms();
    const history = [{ type: "user", uuid: "u-1" }, { type: "assistant", uuid: "u-2" }];
    comms.setHistory("s1", history);

    const response = await comms.getSession("s1");
    expect(response).toEqual({ type: "get_session_response", messages: history });
    expect(response.messages).not.toBe(history);
    response.messages.push({ type: "result" });
    expect((await comms.getSession("s1")).messages).toHaveLength(2);

    history.push({ type: "result", uuid: "u-3" } as any);
    expect((await comms.getSession("s1")).messages).toHaveLength(3);
  });

  test("getSession of a listed session without a history is empty; of an unknown one it rejects", async () => {
    const comms = createFakeComms({ sessions: [{ id: "s1" }] });
    expect(await comms.getSession("s1")).toEqual({ type: "get_session_response", messages: [] });
    const failed = comms.getSession("s404");
    expect(failed).toBeInstanceOf(Promise);
    await expect(failed).rejects.toThrow("Session not found: s404");
  });

  test("getSession without a purpose emits no telemetry; transcript_open emits the load events, as the host does", async () => {
    const comms = createFakeComms({ sessions: [{ id: "s1" }] });
    comms.setHistory("s1", [{ type: "user", uuid: "u-1" }]);
    await comms.getSession("s1");
    await comms.getSession("s1", "diff_refresh");
    expect(comms.directEvents).toEqual([]);

    await comms.getSession("s1", "transcript_open");
    expect(comms.directEvents.map((e) => e.name)).toEqual(["session_load_initiated", "session_load_completed"]);
    expect(comms.directEvents[1].data).toMatchObject({ message_count: 1 });
  });

  test("buildSessionList returns the configured entries, async, as copies, with the host's always-present fields", async () => {
    const comms = createFakeComms({
      sessions: [
        { id: "s1" },
        { id: "s2", archived: true, lastModified: 1_763_550_000_000, lastActivity: 1_763_550_100_000, summary: "Old", customTitle: "Renamed", gitBranch: "main", worktree: { name: "wt", path: "/work/wt" } },
      ],
    });
    const list = comms.buildSessionList();
    expect(list).toBeInstanceOf(Promise);
    const sessions = await list;
    expect(sessions).toEqual([
      { id: "s1", archived: false, lastModified: 0 },
      { id: "s2", archived: true, lastModified: 1_763_550_000_000, lastActivity: 1_763_550_100_000, summary: "Old", customTitle: "Renamed", gitBranch: "main", worktree: { name: "wt", path: "/work/wt" } },
    ]);

    sessions[0].archived = true;
    sessions.pop();
    comms.sessions.push({ id: "s3", summary: "New" });
    expect((await comms.buildSessionList()).map((s) => [s.id, s.archived])).toEqual([["s1", false], ["s2", true], ["s3", false]]);
  });

  test("the sessions a comms is given are copied: comms built from one list do not share entries", async () => {
    const shared = [{ id: "s1", summary: "Shared" }];
    const [one, two] = [createFakeComms({ sessions: shared }), createFakeComms({ sessions: shared })];
    one.sessions[0].archived = true;
    one.sessions.push({ id: "s2" });
    expect(shared).toEqual([{ id: "s1", summary: "Shared" }]);
    expect((await two.buildSessionList()).map((s) => [s.id, s.archived])).toEqual([["s1", false]]);
  });

  test("listSessions wraps the list in the host's response and emits its telemetry; buildSessionList does not", async () => {
    const comms = createFakeComms({ sessions: [{ id: "s1" }, { id: "s2", archived: true }] });
    await comms.buildSessionList();
    expect(comms.directEvents).toEqual([]);

    const response = await comms.listSessions("sidebar");
    expect(response).toEqual({ type: "list_sessions_response", sessions: await comms.buildSessionList(), folderKey: expect.any(String) });
    expect(comms.directEvents).toEqual([{ name: "session_list_loaded", data: { entry_point: "sidebar", session_count: 1 } }]);
  });
});
