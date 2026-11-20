import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { classifyPending } from "../lib/answers.js";
import { toPhoneMessage } from "../lib/transcript.js";
import { AGENT_LIMITS, WindowAgent } from "../lib/window-agent.js";
import { FakeComms, addFakePanel, createFakeComms, createFakeProvider, createFakeVscode, type Message } from "./fake-extension";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MB = 1024 * 1024;
const MARK = "…[truncated]";
const APP = "Visual Studio Code - Insiders";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const projectIdOf = (text: string) => createHash("sha1").update(text).digest("hex").slice(0, 12);

// Memory is measured in Node, the extension host's engine, where a full GC is exact (--expose-gc).
const NODE = Bun.which("node");
const AGENT_PATH = join(import.meta.dir, "../lib/window-agent.js");
// 200 messages parsed from JSON lines as the host parses the CLI's (so their strings are flat): tool results of
// 1 MB, each with the SDK's 1 MB structured copy, and every tenth a 1 MB prompt in plain string content. They go
// through a comms the agent instruments ('agent') or not ('none'). Prints the heap still used after a full GC; the
// workload alone leaves a steady few MB, so a test compares the two.
const RETENTION_PROBE = `
const { WindowAgent } = require(process.argv[1]);
const MB = 1024 * 1024;
const comms = { channels: new Map([['c1', { sessionId: 's1', atRest: true }]]), pendingChannels: new Map(), outstandingRequests: new Map(), send() {}, fromClient() {}, processRequest() {} };
const agent = new WindowAgent({ provider: { allComms: new Set([comms]) }, vscode: {} });
if (process.argv[2] === 'agent') agent.start();
const FILL = JSON.stringify('x'.repeat(MB)).slice(1, -1);
const heap = () => { global.gc(); global.gc(); return process.memoryUsage().heapUsed; };
const before = heap();
for (let i = 0; i < 200; i++) {
  const line = i % 10 === 0
    ? '{"type":"user","uuid":"u-' + i + '","session_id":"s1","isReplay":true,"message":{"role":"user","content":"' + FILL + i + '"}}'
    : '{"type":"user","uuid":"u-' + i + '","session_id":"s1","parent_tool_use_id":null,"message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_' + i + '","content":"' + FILL + i + '"}]},"tool_use_result":{"stdout":"' + FILL + i + '","stderr":""}}';
  comms.send({ type: 'io_message', channelId: 'c1', message: JSON.parse(line), done: false });
}
const retained = heap() - before;
agent.snapshot('s1').then((snapshot) => process.stdout.write(JSON.stringify({ kept: snapshot.messages.length, retainedMB: retained / MB })));
`;

// ---- SDK messages, as the host forwards them (sdk-shapes.md) -------------------------------------

/** `session` null: a message without a session_id. */
const assistant = (uuid: string, text: string, session: string | null = "s1") => ({
  type: "assistant",
  uuid,
  ...(session !== null && { session_id: session }),
  parent_tool_use_id: null,
  message: { id: `msg_${uuid}`, role: "assistant", model: "claude-test", content: [{ type: "text", text }] },
});
const user = (uuid: string, content: unknown, session = "s1") => ({
  type: "user",
  uuid,
  session_id: session,
  parent_tool_use_id: null,
  message: { role: "user", content },
});
const init = (session: string) => ({ type: "system", subtype: "init", session_id: session, uuid: `init-${session}`, model: "claude-test", tools: [] });
const result = (session: string, uuid = `result-${session}`) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  duration_ms: 1200,
  total_cost_usd: 0.01,
  num_turns: 1,
  result: "done",
  session_id: session,
  uuid,
});
const textDelta = (session: string, text: string) => ({
  type: "stream_event",
  uuid: `se-${text}`,
  session_id: session,
  parent_tool_use_id: null,
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});

// ---- prompts (the `request` of the host's request messages) ---------------------------------------

const bash = {
  type: "tool_permission_request",
  toolName: "Bash",
  inputs: { command: "npm test", description: "Run tests" },
  suggestions: [],
  toolUseId: "toolu_01",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
};
const plan = { ...bash, toolName: "ExitPlanMode", inputs: { plan: "# Plan\n\n1. Fix the test" }, toolUseId: "toolu_02" };
const editsForSession = { type: "setMode", mode: "acceptEdits", destination: "session" };
const edit = {
  ...bash,
  toolName: "Edit",
  inputs: { file_path: "/work/demo/a.ts", old_string: "a", new_string: "b" },
  suggestions: [editsForSession],
  toolUseId: "toolu_03",
};
const dialog = { type: "user_dialog_request", dialogKind: "auto_mode_server_fallback", payload: { model: "claude-test" }, toolUseID: "toolu_04" };
const allowBash = { type: "tool_permission_response", result: { behavior: "allow", updatedInput: bash.inputs, updatedPermissions: [] } };

// ---- the window of the brief: the sidebar holds s1 on c1, a tab holds s2 on c2, s3 is listed without a channel ----

const LISTED = [
  { id: "s1", summary: "Fix the flaky test", lastModified: 1_000 },
  { id: "s2", summary: "Add dark mode", lastModified: 2_000 },
  { id: "s3", summary: "Old work", lastModified: 500 },
];

interface Options {
  sessions?: Array<Record<string, any>>;
  vscode?: ReturnType<typeof createFakeVscode>;
  now?: () => number;
  channelWaitMs?: number;
  refreshEveryMs?: number;
  refreshDelayMs?: number;
  hostReadMs?: number;
  wakeWaitMs?: number;
  /** Runs before the agent instruments the comms, e.g. to put an instance method in front of the fake's. */
  before?: (comms: { sidebar: FakeComms; tab: FakeComms }) => void;
}

function windowWith(options: Options = {}) {
  const vscode = options.vscode ?? createFakeVscode();
  const provider = createFakeProvider();
  const sessions = options.sessions ?? LISTED;
  const sidebar = createFakeComms({ sessions });
  const tab = createFakeComms({ sessions });
  sidebar.openChannel("c1", "s1");
  tab.openChannel("c2", "s2");
  provider.allComms.add(sidebar);
  provider.allComms.add(tab);
  options.before?.({ sidebar, tab });
  const logs: string[] = [];
  const agent = new WindowAgent({
    provider,
    vscode,
    log: (line: string) => logs.push(line),
    now: options.now,
    channelWaitMs: options.channelWaitMs ?? 3000,
    refreshEveryMs: options.refreshEveryMs,
    refreshDelayMs: options.refreshDelayMs,
    hostReadMs: options.hostReadMs,
    wakeWaitMs: options.wakeWaitMs,
  });
  const events: Array<[string, any]> = [];
  const projects: any[] = [];
  const attention: any[] = [];
  agent.on("session", (session: string, ev: any) => events.push([session, ev]));
  agent.on("project", (project: any) => projects.push(project));
  agent.on("attention", (ev: any) => attention.push(ev));
  agent.start();
  return { vscode, provider, sidebar, tab, agent, events, projects, attention, logs };
}

// claude-vscode.editor.open(sessionId, initialPrompt, viewColumn, groupId, fullEditor, options). The extension takes
// an open without `options.programmatic` for the user's choice and saves "panel" as their preferred location
// (claude-vscode.sidebar.open saves "sidebar"); VS Code's own session list passes it, and so does the agent.
const PIN_TO_PANEL = { programmatic: "pin-to-panel" };
const HONOR_LOCATION = { programmatic: "honor-preferred-location" };
const editorOpen = (session: string | undefined, options: object) => ({
  id: "claude-vscode.editor.open",
  args: [session, undefined, undefined, undefined, undefined, options],
});

const sessionOf = (project: any, id: string) => project.sessions.find((s: any) => s.id === id);
const pendingEvents = (events: Array<[string, any]>) => events.filter(([, ev]) => ev.t === "pending");

// ---- mirroring the host's messages -----------------------------------------------------------------

describe("mirroring", () => {
  test("an assistant io_message on c1 becomes a session event for s1 with the mapped message; the webview still gets it", () => {
    const { sidebar, events } = windowWith();
    const message = assistant("a-1", "I'll run the tests.");
    sidebar.emit("c1", message);
    expect(events).toEqual([["s1", { t: "msg", message: toPhoneMessage(message) }]]);
    expect(sidebar.sent).toEqual([{ type: "io_message", channelId: "c1", message, done: false }]);
    expect(sidebar.sent[0].message).toBe(message);
  });

  test("a stream_event text delta becomes a stream event", () => {
    const { sidebar, events } = windowWith();
    sidebar.emit("c1", textDelta("s1", "I'll "));
    expect(events).toEqual([["s1", { t: "stream", event: { type: "content_block_delta", index: 0, text: "I'll " } }]]);
  });

  test("messages of the tab's channel are s2's; noise gives no event", () => {
    const { tab, events } = windowWith();
    tab.emit("c2", { type: "system", subtype: "status", permissionMode: "default", session_id: "s2" });
    tab.emit("c2", { type: "rate_limit_event", session_id: "s2" });
    expect(events).toEqual([]);
    const message = assistant("a-2", "Done.", "s2");
    tab.emit("c2", message);
    expect(events).toEqual([["s2", { t: "msg", message: toPhoneMessage(message) }]]);
  });

  test("a new channel belongs to the session its system/init names; before that a message goes by its own session_id or nowhere", () => {
    const { sidebar, events } = windowWith();
    sidebar.openChannel("c7");
    sidebar.emit("c7", assistant("a-0", "no session anywhere", null));
    expect(events).toEqual([]);
    const own = assistant("a-1", "names its own session", "s-new");
    sidebar.emit("c7", own);
    sidebar.emit("c7", assistant("a-2", "still no session", null));
    expect(events).toEqual([["s-new", { t: "msg", message: toPhoneMessage(own) }]]);

    sidebar.emit("c7", init("s-new"));
    const after = assistant("a-3", "after init", null);
    sidebar.emit("c7", after);
    expect(events.at(-1)).toEqual(["s-new", { t: "msg", message: toPhoneMessage(after) }]);
    // A host that does not keep channel.sessionId: the init seen on the channel still names it.
    sidebar.channels.get("c7")!.sessionId = undefined;
    const later = assistant("a-4", "later", null);
    sidebar.emit("c7", later);
    expect(events.at(-1)).toEqual(["s-new", { t: "msg", message: toPhoneMessage(later) }]);
  });

  test("system/init makes the session running in project(), result makes it idle", async () => {
    const { sidebar, agent } = windowWith();
    await agent.refreshProject();
    const state = () => sessionOf(agent.project(), "s1").state;
    expect(state()).toBe("idle");
    sidebar.emit("c1", init("s1"));
    expect(state()).toBe("running");
    sidebar.emit("c1", result("s1"));
    expect(state()).toBe("idle");
  });

  test("the channel's atRest decides when the host keeps it busy after a result (background work)", async () => {
    const { sidebar, agent } = windowWith();
    await agent.refreshProject();
    sidebar.emit("c1", init("s1"));
    sidebar.emit("c1", result("s1"));
    sidebar.channels.get("c1")!.atRest = false;
    expect(sessionOf(agent.project(), "s1").state).toBe("running");
  });

  test("without atRest on the channel, the turn seen in the messages decides", async () => {
    const { sidebar, agent } = windowWith();
    await agent.refreshProject();
    delete (sidebar.channels.get("c1") as any).atRest;
    const state = () => sessionOf(agent.project(), "s1").state;
    expect(state()).toBe("idle");
    sidebar.emit("c1", init("s1"));
    delete (sidebar.channels.get("c1") as any).atRest;
    expect(state()).toBe("running");
    sidebar.emit("c1", result("s1"));
    delete (sidebar.channels.get("c1") as any).atRest;
    expect(state()).toBe("idle");
  });
});

// ---- while remote access is off -------------------------------------------------------------------

/** An SDK message that records which of its fields anything reads. */
function watched(message: Record<string, any>) {
  const reads = new Set<string>();
  const proxy = new Proxy(message, {
    get(target, key, receiver) {
      reads.add(String(key));
      return Reflect.get(target, key, receiver);
    },
  });
  return { proxy, reads };
}

describe("while remote access is off", () => {
  test("enabled by default; setEnabled(false): messages and stream events are neither mapped, kept nor emitted, and the webview still gets them", async () => {
    const { agent, sidebar, events } = windowWith();
    expect(agent.enabled).toBe(true);
    agent.setEnabled(false);
    expect(agent.enabled).toBe(false);
    const message = watched(assistant("a-1", "not for the phone"));
    sidebar.emit("c1", message.proxy);
    sidebar.emit("c1", textDelta("s1", "streaming"));
    expect(events).toEqual([]);
    expect(message.reads.has("message")).toBe(false); // its content was never read: not mapped, not slimmed
    expect(sidebar.sent.map((sent) => sent.message.type)).toEqual(["assistant", "stream_event"]);
    expect((await agent.snapshot("s1")).messages).toEqual([]);
  });

  test("setEnabled(false) lets go of what was kept; setEnabled(true) mirrors again from then on", async () => {
    const { agent, sidebar, events } = windowWith();
    sidebar.emit("c1", assistant("a-1", "kept while on"));
    expect((await agent.snapshot("s1")).messages.map((m: any) => m.uuid)).toEqual(["a-1"]);
    agent.setEnabled(false);
    expect((await agent.snapshot("s1")).messages).toEqual([]);
    sidebar.emit("c1", assistant("a-2", "while off"));
    agent.setEnabled(true);
    events.length = 0;
    const after = assistant("a-3", "on again");
    sidebar.emit("c1", after);
    expect(events).toEqual([["s1", { t: "msg", message: toPhoneMessage(after) }]]);
    expect((await agent.snapshot("s1")).messages.map((m: any) => m.uuid)).toEqual(["a-3"]);
  });

  test("Connection-tab requests are answered while off, through fromClient and processRequest", async () => {
    const { agent, sidebar } = windowWith();
    agent.setEnabled(false);
    agent.onCceRequest = async (_comms: any, request: any) => ({ type: `${request.type}_response` });
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-1", request: { type: "cce_remote_status" } });
    await sidebar.flush();
    expect(sidebar.sent).toContainEqual({ type: "response", requestId: "w-1", response: { type: "cce_remote_status_response" } });
    const direct = await sidebar.processRequest({ type: "request", channelId: "", requestId: "w-2", request: { type: "cce_remote_connect" } }, new AbortController().signal);
    expect(direct).toEqual({ type: "cce_remote_connect_response" });
  });

  test("a prompt that waits when remote access is turned on can be answered: prompts and turns are still followed while off, and nothing is emitted", async () => {
    const { agent, sidebar, events } = windowWith();
    await agent.refreshProject();
    agent.setEnabled(false);
    sidebar.emit("c1", init("s1"));
    const asked = sidebar.requestPermission("c1", bash);
    expect(events).toEqual([]);
    agent.setEnabled(true);
    expect(sessionOf(agent.project(), "s1")).toMatchObject({ state: "waiting", pendingCount: 1 });
    const snapshot = await agent.snapshot("s1");
    expect(snapshot.pending).toEqual([expect.objectContaining({ requestId: asked.requestId, kind: "tool" })]);
    await agent.answer("s1", asked.requestId, { kind: "allow" });
    expect(await asked).toEqual(allowBash);
  });
});

// ---- the wrappers --------------------------------------------------------------------------------

describe("wrappers", () => {
  test("send(): a response to an injected request (cce-remote-…) is swallowed; everything else passes unchanged and in order", () => {
    const { sidebar } = windowWith();
    const first = { type: "io_message", channelId: "c1", message: assistant("a-1", "hi"), done: false };
    const swallowed = { type: "response", requestId: "cce-remote-x", response: { type: "set_permission_mode_response", success: true } };
    const other = { type: "response", requestId: "w-7", response: { type: "list_sessions_response", sessions: [] } };
    const unknown = { type: "something_new", payload: [1, 2] };
    expect(sidebar.send(first)).toBeUndefined();
    expect(sidebar.send(swallowed)).toBeUndefined();
    sidebar.send(other);
    sidebar.send(unknown);
    expect(sidebar.sent).toEqual([first, other, unknown]);
    expect(sidebar.sent[1]).toBe(other);
    expect(sidebar.webview.posted.map((posted) => posted.message)).toEqual([first, other, unknown]);
  });

  test("processRequest(): cce_remote_* goes to onCceRequest(comms, request), other types to the original", async () => {
    const { agent, sidebar } = windowWith();
    const calls: any[] = [];
    agent.onCceRequest = async (comms: any, request: any) => {
      calls.push([comms, request]);
      return { type: "cce_remote_status_response", status: { role: "off" } };
    };
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-1", request: { type: "cce_remote_status" } });
    await sidebar.fromClient({ type: "request", channelId: "c1", requestId: "w-2", request: { type: "set_permission_mode", mode: "acceptEdits", userInitiated: true } });
    await sidebar.flush();
    expect(calls).toEqual([[sidebar, { type: "cce_remote_status" }]]);
    expect(calls[0][0]).toBe(sidebar);
    const responses = sidebar.sent.filter((m) => m.type === "response");
    expect(responses).toContainEqual({ type: "response", requestId: "w-1", response: { type: "cce_remote_status_response", status: { role: "off" } } });
    expect(responses).toContainEqual({ type: "response", requestId: "w-2", response: { type: "set_permission_mode_response", success: true } });
    expect(sidebar.permissionModes.get("c1")).toBe("acceptEdits");
  });

  test("processRequest(): without a handler, or when the handler throws, the webview gets an error response", async () => {
    const { agent, sidebar } = windowWith();
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-1", request: { type: "cce_remote_status" } });
    agent.onCceRequest = () => {
      throw new Error("not ready");
    };
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-2", request: { type: "cce_remote_connect" } });
    await sidebar.flush();
    expect(sidebar.sent).toEqual([
      { type: "response", requestId: "w-1", response: { type: "error", error: "cce_remote_unavailable" } },
      { type: "response", requestId: "w-2", response: { type: "error", error: "not ready" } },
    ]);
  });

  test("fromClient(): cce_remote_* requests are answered while the host's reader waits on a launch, and only once", async () => {
    const { agent, sidebar } = windowWith();
    agent.onCceRequest = async (_comms: any, request: any) => {
      if (request.type === "cce_remote_connect") throw new Error("serve failed");
      return { type: "cce_remote_status_response", status: { role: "off" } };
    };
    const release = sidebar.holdReader(); // as while a launch waits on the folder-trust dialog
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-1", request: { type: "cce_remote_status" } });
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-2", request: { type: "cce_remote_connect" } });
    await sleep(0);
    const answers = [
      { type: "response", requestId: "w-1", response: { type: "cce_remote_status_response", status: { role: "off" } } },
      { type: "response", requestId: "w-2", response: { type: "error", error: "serve failed" } },
    ];
    expect(sidebar.sent).toEqual(answers);
    release();
    await sidebar.flush();
    expect(sidebar.sent).toEqual(answers); // the host never handles them a second time
  });

  test("processRequest(): a cce_remote_* request that reaches it is still answered by onCceRequest", async () => {
    const { agent, sidebar } = windowWith();
    agent.onCceRequest = async (comms: any, request: any) => ({ type: `${request.type}_response`, fromThisComms: comms === sidebar });
    const answer = await sidebar.processRequest({ type: "request", channelId: "", requestId: "w-9", request: { type: "cce_remote_status" } }, new AbortController().signal);
    expect(answer).toEqual({ type: "cce_remote_status_response", fromThisComms: true });
  });

  test("instrument() is idempotent and marks the comms", () => {
    const { agent, sidebar, events } = windowWith();
    const wrapped = { send: sidebar.send, fromClient: sidebar.fromClient, processRequest: sidebar.processRequest };
    expect((sidebar as any).__cceRemote).toBe(true);
    expect(agent.instrument(sidebar)).toBe(false);
    agent.start();
    expect({ send: sidebar.send, fromClient: sidebar.fromClient, processRequest: sidebar.processRequest }).toEqual(wrapped);
    sidebar.emit("c1", assistant("a-1", "once"));
    expect(events).toHaveLength(1);
  });

  test("a comms that cannot be wrapped completely is still wrapped at most once", () => {
    const provider = createFakeProvider();
    const comms = createFakeComms({ sessions: LISTED });
    Object.defineProperty(comms, "fromClient", { value: comms.fromClient, writable: false }); // wrapping it throws
    provider.allComms.add(comms);
    const logs: string[] = [];
    const agent = new WindowAgent({ provider, vscode: createFakeVscode(), log: (line: string) => logs.push(line) });
    const events: any[] = [];
    agent.on("session", (_session: string, ev: any) => events.push(ev));
    agent.start();
    expect(agent.instrument(comms)).toBe(false);
    comms.openChannel("c1", "s1");
    comms.emit("c1", assistant("a-1", "once"));
    expect(events).toHaveLength(1);
    expect(logs).toHaveLength(1);
  });

  test("start() instruments comms added later (allComms.add keeps returning the set)", () => {
    const { provider, events } = windowWith();
    const later = createFakeComms({ sessions: LISTED });
    expect(provider.allComms.add(later)).toBe(provider.allComms);
    expect(provider.allComms.has(later)).toBe(true);
    expect((later as any).__cceRemote).toBe(true);
    later.openChannel("c3", "s3");
    const message = assistant("a-3", "from a new tab", "s3");
    later.emit("c3", message);
    expect(events).toEqual([["s3", { t: "msg", message: toPhoneMessage(message) }]]);
  });

  test("a throwing listener or a broken message never keeps a message from the webview or the host", async () => {
    // Recorders stand in front of the fake host here: a broken message must reach the original methods,
    // and a real host's reader must not be fed one by a test.
    const toWebview: unknown[] = [];
    const toHost: unknown[] = [];
    const { agent, sidebar, logs } = windowWith({
      before: ({ sidebar }) => {
        sidebar.send = (message: Message) => {
          toWebview.push(message);
        };
        sidebar.fromClient = async (message: Message) => {
          toHost.push(message);
        };
      },
    });
    agent.on("session", () => {
      throw new Error("listener bug");
    });
    const message = { type: "io_message", channelId: "c1", message: assistant("a-1", "hi"), done: false };
    expect(() => sidebar.send(message)).not.toThrow();
    expect(toWebview).toEqual([message]);
    expect(logs.some((line) => line.includes("listener bug"))).toBe(true);

    const broken = {
      type: "io_message",
      channelId: "c1",
      get message(): any {
        throw new Error("broken getter");
      },
    };
    expect(() => sidebar.send(broken)).not.toThrow();
    expect(toWebview.at(-1)).toBe(broken);

    const brokenResponse = {
      type: "response",
      get requestId(): any {
        throw new Error("broken id");
      },
    };
    await sidebar.fromClient(brokenResponse);
    expect(toHost).toEqual([brokenResponse]);
    expect(logs.some((line) => line.includes("broken getter"))).toBe(true);
    expect(logs.some((line) => line.includes("broken id"))).toBe(true);
  });

  test("a throwing listener does not fail an action that was carried out", async () => {
    const { agent, sidebar } = windowWith();
    agent.on("session", () => {
      throw new Error("session listener bug");
    });
    agent.on("project", () => {
      throw new Error("project listener bug");
    });
    const asked = sidebar.requestPermission("c1", bash);
    await agent.answer("s1", asked.requestId, { kind: "allow" });
    expect(await asked).toEqual(allowBash);
    expect(sessionOf(await agent.refreshProject(), "s1").pendingCount).toBe(0);
  });
});

// ---- prompts ---------------------------------------------------------------------------------------

describe("pending prompts", () => {
  test("a tool_permission_request on c1 is a pending tool prompt of s1, which then waits; VS Code's answer removes it", async () => {
    const { agent, sidebar, events } = windowWith({ now: () => 7_000 });
    await agent.refreshProject();
    const asked = sidebar.requestPermission("c1", bash);
    const expected = classifyPending({ type: "request", channelId: "c1", requestId: asked.requestId, request: bash }, 7_000);
    expect(expected).toMatchObject({ requestId: asked.requestId, kind: "tool", toolName: "Bash", input: bash.inputs, createdAt: 7_000 });
    expect(events).toEqual([["s1", { t: "pending", pending: [expected] }]]);
    expect(sessionOf(agent.project(), "s1")).toMatchObject({ state: "waiting", pendingCount: 1 });

    await sidebar.fromClient({ type: "response", requestId: asked.requestId, response: allowBash });
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);
    expect(await asked).toEqual(allowBash);
    expect(sessionOf(agent.project(), "s1")).toMatchObject({ state: "idle", pendingCount: 0 });
  });

  test("a cancel_request of the host (the CLI withdrew the prompt) removes it", () => {
    const { sidebar, events } = windowWith();
    const controller = new AbortController();
    const asked = sidebar.requestPermission("c1", bash, controller.signal);
    asked.catch(() => {});
    expect(pendingEvents(events).at(-1)![1].pending).toHaveLength(1);
    controller.abort();
    expect(sidebar.sent.at(-1)).toEqual({ type: "cancel_request", targetRequestId: asked.requestId });
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);
  });

  test("close_channel clears every prompt of the channel, from the host and from the webview", async () => {
    const { agent, sidebar, tab, events } = windowWith();
    sidebar.requestPermission("c1", bash);
    sidebar.requestPermission("c1", edit);
    tab.requestPermission("c2", bash);
    expect(pendingEvents(events).at(-2)![1].pending).toHaveLength(2);

    sidebar.closeChannel("c1");
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);

    await tab.fromClient({ type: "close_channel", channelId: "c2" });
    expect(events.at(-1)).toEqual(["s2", { t: "pending", pending: [] }]);
    expect((await agent.snapshot("s2")).pending).toEqual([]);
  });

  test("a closed tab's prompts go with it (allComms.delete), as do prompts of a channel that closed without telling", async () => {
    const { agent, provider, sidebar, tab, events } = windowWith();
    tab.requestPermission("c2", bash);
    provider.allComms.delete(tab);
    expect(events.at(-1)).toEqual(["s2", { t: "pending", pending: [] }]);

    const asked = sidebar.requestPermission("c1", bash);
    sidebar.channels.delete("c1"); // the host closed it silently (a webview reload)
    await agent.refreshProject();
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);
    await expect(agent.answer("s1", asked.requestId, { kind: "allow" })).rejects.toThrow("not_pending");
  });

  test("requests that are not prompts are ignored", () => {
    const { sidebar, events } = windowWith();
    sidebar.send({ type: "request", channelId: "", requestId: "", request: { type: "focus_input" } });
    sidebar.send({ type: "request", channelId: "c1", requestId: "r-x", request: { type: "elicitation_request" } });
    expect(events).toEqual([]);
  });

  test("the phone gets the input with every string cut to 4 000 characters; the answer echoes the full input", async () => {
    const { agent, sidebar, events } = windowWith();
    const write = { ...bash, toolName: "Write", inputs: { file_path: "/work/demo/big.txt", content: "z".repeat(10_000) } };
    const asked = sidebar.requestPermission("c1", write);
    const shown = events.at(-1)![1].pending[0];
    expect(shown.input).toEqual({ file_path: "/work/demo/big.txt", content: "z".repeat(4000) + MARK });
    expect((await agent.snapshot("s1")).pending[0].input.content).toBe("z".repeat(4000) + MARK);

    await agent.answer("s1", asked.requestId, { kind: "allow" });
    expect(await asked).toEqual({ type: "tool_permission_response", result: { behavior: "allow", updatedInput: write.inputs, updatedPermissions: [] } });
  });
});

// ---- answering -------------------------------------------------------------------------------------

describe("answer", () => {
  test("allow: the response goes to the host, then the webview is told to drop the prompt; VS Code's late answer is dropped", async () => {
    const { agent, sidebar, events } = windowWith();
    const asked = sidebar.requestPermission("c1", bash);
    const received = sidebar.received.length;
    const sent = sidebar.sent.length;
    let receivedWhenCancelled = -1;
    const post = sidebar.webview.postMessage;
    (sidebar.webview as any).postMessage = (posted: Message) => {
      if (posted.message?.type === "cancel_request") receivedWhenCancelled = sidebar.received.length;
      return post(posted);
    };

    await agent.answer("s1", asked.requestId, { kind: "allow" });
    expect(sidebar.received.slice(received)).toEqual([{ type: "response", requestId: asked.requestId, response: allowBash }]);
    expect(sidebar.sent.slice(sent)).toEqual([{ type: "cancel_request", targetRequestId: asked.requestId }]);
    expect(receivedWhenCancelled).toBe(received + 1);
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);
    expect(await asked).toEqual(allowBash);

    await sidebar.fromClient({ type: "response", requestId: asked.requestId, response: allowBash });
    expect(sidebar.received).toHaveLength(received + 1);
    await sidebar.flush();
    expect(sidebar.logger.lines.filter((line) => line.includes("No handler"))).toEqual([]);
    expect(sidebar.readerError).toBeUndefined();
  });

  test("VS Code's late answer is dropped for 60 s only", async () => {
    let now = 1_000;
    const { agent, sidebar } = windowWith({ now: () => now });
    const asked = sidebar.requestPermission("c1", bash);
    await agent.answer("s1", asked.requestId, { kind: "allow" });
    const received = sidebar.received.length;
    now += 59_999;
    await sidebar.fromClient({ type: "response", requestId: asked.requestId, response: allowBash });
    expect(sidebar.received).toHaveLength(received);
    now += 2;
    await sidebar.fromClient({ type: "response", requestId: asked.requestId, response: allowBash });
    expect(sidebar.received).toHaveLength(received + 1);
  });

  test("plan approveManual: set_permission_mode default (cce-remote- id, userInitiated false) first, applied before the answer; its response is swallowed", async () => {
    let modeWhenAnswered: string | undefined;
    const { agent, sidebar } = windowWith();
    const asked = sidebar.requestPermission("c1", plan);
    const received = sidebar.received.length;
    const push = sidebar.received.push.bind(sidebar.received);
    sidebar.received.push = (...items: Message[]) => {
      if (items[0]?.type === "response") modeWhenAnswered = sidebar.permissionModes.get("c1");
      return push(...items);
    };

    await agent.answer("s1", asked.requestId, { kind: "approveManual" });
    const injected = sidebar.received.slice(received);
    expect(injected).toEqual([
      {
        type: "request",
        channelId: "c1",
        requestId: expect.stringMatching(/^cce-remote-/),
        request: { type: "set_permission_mode", mode: "default", userInitiated: false },
      },
      {
        type: "response",
        requestId: asked.requestId,
        response: {
          type: "tool_permission_response",
          result: { behavior: "allow", updatedInput: plan.inputs, updatedPermissions: [{ type: "setMode", mode: "default", destination: "session" }] },
        },
      },
    ]);
    expect(modeWhenAnswered).toBe("default");
    await sidebar.flush();
    expect(sidebar.permissionModeChanges).toEqual([{ channelId: "c1", mode: "default", userInitiated: false }]);
    expect(sidebar.persistedDefaultModes).toEqual([]);
    expect(sidebar.readerError).toBeUndefined();
    expect(sidebar.sent.filter((m) => m.type === "response")).toEqual([]);
    expect(sidebar.webview.posted.filter((p) => p.message.type === "response")).toEqual([]);
    expect(sidebar.sent.at(-1)).toEqual({ type: "cancel_request", targetRequestId: asked.requestId });
  });

  test("plan approveAuto switches to acceptEdits, never as the user's new default (userInitiated false)", async () => {
    const { agent, sidebar } = windowWith();
    const asked = sidebar.requestPermission("c1", plan);
    const received = sidebar.received.length;
    await agent.answer("s1", asked.requestId, { kind: "approveAuto" });
    expect(sidebar.received[received]).toEqual({
      type: "request",
      channelId: "c1",
      requestId: expect.stringMatching(/^cce-remote-/),
      request: { type: "set_permission_mode", mode: "acceptEdits", userInitiated: false },
    });
    expect(await asked).toEqual({ type: "tool_permission_response", result: { behavior: "allow", updatedInput: plan.inputs, updatedPermissions: [] } });
    await sidebar.flush();
    expect(sidebar.permissionModes.get("c1")).toBe("acceptEdits");
    expect(sidebar.persistedDefaultModes).toEqual([]); // the user's default mode is left alone
    expect(sidebar.readerError).toBeUndefined();
  });

  test("allowAlways with a session mode suggestion applies the mode (userInitiated false), then allows with the suggestions", async () => {
    const { agent, sidebar } = windowWith();
    const asked = sidebar.requestPermission("c1", edit);
    const received = sidebar.received.length;
    await agent.answer("s1", asked.requestId, { kind: "allowAlways" });
    expect(sidebar.received.slice(received).map((m) => m.type)).toEqual(["request", "response"]);
    expect(sidebar.received[received].request).toEqual({ type: "set_permission_mode", mode: "acceptEdits", userInitiated: false });
    expect(await asked).toEqual({
      type: "tool_permission_response",
      result: { behavior: "allow", updatedInput: edit.inputs, updatedPermissions: [editsForSession] },
    });
    await sidebar.flush();
    expect(sidebar.persistedDefaultModes).toEqual([]);
  });

  test("a dialog is cancelled", async () => {
    const { agent, sidebar, events } = windowWith();
    const asked = sidebar.requestPermission("c1", dialog);
    expect(events.at(-1)![1].pending[0]).toMatchObject({ kind: "dialog", dialogKind: "auto_mode_server_fallback" });
    await agent.answer("s1", asked.requestId, { kind: "cancel" });
    expect(await asked).toEqual({ type: "user_dialog_response", result: { behavior: "cancelled" } });
  });

  test("answering a request that is not pending rejects not_pending and injects nothing", async () => {
    const { agent, sidebar, tab } = windowWith();
    const counts = () => [sidebar.received.length, sidebar.sent.length, tab.received.length, tab.sent.length];
    const onS2 = tab.requestPermission("c2", bash);
    const onS1 = sidebar.requestPermission("c1", bash);
    let before = counts();
    await expect(agent.answer("s1", "r-unknown", { kind: "allow" })).rejects.toThrow("not_pending");
    await expect(agent.answer("s1", onS2.requestId, { kind: "allow" })).rejects.toThrow("not_pending");
    expect(counts()).toEqual(before);

    await sidebar.fromClient({ type: "response", requestId: onS1.requestId, response: allowBash }); // VS Code was first
    before = counts();
    await expect(agent.answer("s1", onS1.requestId, { kind: "deny" })).rejects.toThrow("not_pending");
    expect(counts()).toEqual(before);

    const controller = new AbortController();
    const withdrawn = sidebar.requestPermission("c1", bash, controller.signal);
    withdrawn.catch(() => {});
    controller.abort();
    before = counts();
    await expect(agent.answer("s1", withdrawn.requestId, { kind: "allow" })).rejects.toThrow("not_pending");
    expect(counts()).toEqual(before);

    const twice = sidebar.requestPermission("c1", bash);
    await agent.answer("s1", twice.requestId, { kind: "allow" });
    before = counts();
    await expect(agent.answer("s1", twice.requestId, { kind: "allow" })).rejects.toThrow("not_pending");
    expect(counts()).toEqual(before);
  });

  test("a prompt the host no longer waits for (a reloaded webview) is not_pending: nothing is injected, and the phone is told", async () => {
    const { agent, sidebar, events } = windowWith();
    const asked = sidebar.requestPermission("c1", bash);
    asked.catch(() => {});
    // The host's init of a fresh client rejects and forgets its outstanding requests at once; the channel closes later.
    for (const waiting of [...sidebar.outstandingRequests.values()]) waiting.reject(new Error("The client reloaded before this request was answered"));
    sidebar.outstandingRequests.clear();
    const counts = () => [sidebar.received.length, sidebar.sent.length];
    const before = counts();
    await expect(agent.answer("s1", asked.requestId, { kind: "allow" })).rejects.toThrow("not_pending");
    expect(counts()).toEqual(before);
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);
    expect(sessionOf(agent.project(), "s1").pendingCount).toBe(0);
    expect((await agent.snapshot("s1")).pending).toEqual([]);
  });

  test("a reloading webview (init) takes its prompts off the phone at once", async () => {
    const { sidebar, events } = windowWith({
      before: ({ sidebar }) => {
        const original = sidebar.processRequest.bind(sidebar);
        // The host's init of a fresh client: it rejects and forgets every outstanding request first.
        sidebar.processRequest = async (e: Message, signal: AbortSignal) => {
          if (e.request?.type !== "init") return original(e, signal);
          const waiting = [...sidebar.outstandingRequests.values()];
          sidebar.outstandingRequests.clear();
          for (const request of waiting) request.reject(new Error("The client reloaded before this request was answered"));
          return { type: "init_response" };
        };
      },
    });
    const asked = sidebar.requestPermission("c1", bash);
    asked.catch(() => {});
    expect(pendingEvents(events).at(-1)![1].pending).toHaveLength(1);
    await sidebar.fromClient({ type: "request", channelId: "", requestId: "w-init", request: { type: "init" } });
    await sidebar.flush();
    expect(events.at(-1)).toEqual(["s1", { t: "pending", pending: [] }]);
    expect(sidebar.readerError).toBeUndefined();
  });

  test("a choice that does not fit the prompt rejects invalid_choice, injects nothing and leaves it pending", async () => {
    const { agent, sidebar } = windowWith();
    const asked = sidebar.requestPermission("c1", bash);
    const received = sidebar.received.length;
    await expect(agent.answer("s1", asked.requestId, { kind: "approveAuto" })).rejects.toThrow("invalid_choice");
    expect(sidebar.received).toHaveLength(received);
    expect(sessionOf(agent.project(), "s1").pendingCount).toBe(1);
    await agent.answer("s1", asked.requestId, { kind: "allow" });
    expect(await asked).toEqual(allowBash);
  });

  test("when VS Code answers while the phone's mode change is in flight, the phone's answer is not sent", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { agent, sidebar } = windowWith({
      before: ({ sidebar }) => {
        const original = sidebar.processRequest.bind(sidebar);
        sidebar.processRequest = async (e: Message, signal: AbortSignal) => {
          if (e.request?.type === "set_permission_mode") await gate;
          return original(e, signal);
        };
      },
    });
    const asked = sidebar.requestPermission("c1", plan);
    const answering = agent.answer("s1", asked.requestId, { kind: "approveManual" });
    // A second phone answering the same prompt meanwhile is refused.
    await expect(agent.answer("s1", asked.requestId, { kind: "approveManual" })).rejects.toThrow("not_pending");
    const vscodeAnswer = { type: "tool_permission_response", result: { behavior: "deny", message: "no", interrupt: true } };
    await sidebar.fromClient({ type: "response", requestId: asked.requestId, response: vscodeAnswer });
    release();
    await expect(answering).rejects.toThrow("not_pending");
    await sidebar.flush();
    expect(await asked).toEqual(vscodeAnswer);
    expect(sidebar.received.filter((m) => m.type === "response")).toEqual([{ type: "response", requestId: asked.requestId, response: vscodeAnswer }]);
    expect(sidebar.sent.filter((m) => m.type === "cancel_request")).toEqual([]);
  });
});

// ---- attention -----------------------------------------------------------------------------------------

// What a notification is for: a prompt appears (`waiting`), a session's open prompts change (`open`), a turn ends
// (`done`). Emitted like the session events, only while remote access is on, but whether or not a phone is connected.
describe("attention", () => {
  /** The window of the brief with its session list read, so that the titles are the listed ones. */
  async function listedWindow(options?: Options) {
    const window = windowWith(options);
    await window.agent.refreshProject();
    return window;
  }
  const waitings = (attention: any[]) => attention.filter((ev) => ev.kind === "waiting");
  const opens = (attention: any[]) => attention.filter((ev) => ev.kind === "open");
  const question = {
    ...bash,
    toolName: "AskUserQuestion",
    inputs: {
      questions: [
        { question: "Which package\n manager?", header: "Manager", multiSelect: false, options: [{ label: "pnpm", description: "Fast" }] },
        { question: "Which checks?", header: "Checks", multiSelect: true, options: [] },
      ],
    },
  };

  test("a prompt emits waiting once, with its text", async () => {
    const { sidebar, attention } = await listedWindow();
    const cases: Array<[string, Record<string, any>, { kind: string; toolName: string; text: string }]> = [
      ["a Bash permission", { ...bash, inputs: { command: "npm  test", description: "Run tests" } }, { kind: "tool", toolName: "Bash", text: "npm test" }],
      ["a question", question, { kind: "question", toolName: "AskUserQuestion", text: "Which package manager?" }],
      ["an Edit", { ...edit, inputs: { file_path: "/x/y/file.ts", old_string: "a", new_string: "b" } }, { kind: "tool", toolName: "Edit", text: "file.ts" }],
      ["a plan", plan, { kind: "plan", toolName: "ExitPlanMode", text: "" }],
      ["a dialog", dialog, { kind: "dialog", toolName: "auto_mode_server_fallback", text: "" }],
    ];
    for (const [what, request, prompt] of cases) {
      attention.length = 0;
      const asked = sidebar.requestPermission("c1", request);
      expect(waitings(attention), what).toEqual([{ kind: "waiting", session: "s1", requestId: asked.requestId, title: "Fix the flaky test", prompt }]);
      // The host delivering the very same request again is not news.
      sidebar.send({ type: "request", channelId: "c1", requestId: asked.requestId, request });
      expect(waitings(attention), `${what}, delivered again`).toHaveLength(1);
    }
  });

  test("answering or losing the channel reports the open prompts", async () => {
    const { agent, sidebar, attention } = await listedWindow();
    const asked = sidebar.requestPermission("c1", bash);
    expect(opens(attention)).toEqual([{ kind: "open", session: "s1", requestIds: [asked.requestId] }]);

    await agent.answer("s1", asked.requestId, { kind: "allow" }); // from the phone
    expect(opens(attention).at(-1)).toEqual({ kind: "open", session: "s1", requestIds: [] });

    const next = sidebar.requestPermission("c1", edit);
    expect(opens(attention).at(-1)).toEqual({ kind: "open", session: "s1", requestIds: [next.requestId] });
    sidebar.closeChannel("c1");
    expect(opens(attention).at(-1)).toEqual({ kind: "open", session: "s1", requestIds: [] });
  });

  test("every way a prompt goes away reports the prompts that remain, session by session", async () => {
    const { agent, provider, sidebar, tab, attention } = await listedWindow();
    const openIds = (session: string) => opens(attention).filter((ev) => ev.session === session).at(-1)?.requestIds;
    const one = sidebar.requestPermission("c1", bash);
    const two = sidebar.requestPermission("c1", edit);
    const other = tab.requestPermission("c2", bash);
    expect(openIds("s1")).toEqual([one.requestId, two.requestId]);
    expect(openIds("s2")).toEqual([other.requestId]);

    await sidebar.fromClient({ type: "response", requestId: one.requestId, response: allowBash }); // VS Code answers
    expect(openIds("s1")).toEqual([two.requestId]);
    sidebar.send({ type: "cancel_request", targetRequestId: two.requestId }); // the CLI withdraws it
    expect(openIds("s1")).toEqual([]);
    expect(openIds("s2")).toEqual([other.requestId]); // the other session is untouched

    sidebar.requestPermission("c1", bash);
    sidebar.channels.delete("c1"); // the host closed it without a word: the next sweep finds out
    await agent.refreshProject();
    expect(openIds("s1")).toEqual([]);

    provider.allComms.delete(tab); // a closed editor tab takes its prompts with it
    expect(openIds("s2")).toEqual([]);
  });

  test("a result emits done", async () => {
    const { agent, sidebar, tab, attention } = await listedWindow();
    sidebar.emit("c1", init("s1"));
    expect(attention).toEqual([]); // a turn starting is no news
    sidebar.emit("c1", { ...result("s1"), result: "All tests pass.\n\nDetails…", duration_ms: 1234 });
    expect(attention).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 1234, text: "All tests pass. Details…" }]);

    attention.length = 0;
    sidebar.emit("c1", { type: "result", subtype: "error_during_execution", is_error: true, duration_ms: 7, errors: [], session_id: "s1", uuid: "r-err" });
    expect(attention).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: true, durationMs: 7, text: "" }]);

    attention.length = 0;
    tab.emit("c2", result("s2")); // another session of the window
    expect(attention).toEqual([{ kind: "done", session: "s2", title: "Add dark mode", isError: false, durationMs: 1200, text: "done" }]);
    // the turn the phone starts ends in a done, too (the fake CLI answers with Echo: <prompt>)
    attention.length = 0;
    await agent.send("s1", "hello");
    await sidebar.flush();
    expect(attention).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 1, text: "Echo: hello" }]);
  });

  test("stopping a turn from the phone ends it with an error result: done with isError", async () => {
    const { agent, sidebar, attention } = await listedWindow();
    sidebar.emit("c1", init("s1"));
    await agent.interrupt("s1");
    await sidebar.flush();
    expect(attention).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: true, durationMs: 1, text: "" }]);
  });

  test.each([
    ["a successful turn", { subtype: "success", is_error: false, duration_ms: 1200, result: "done" }, { isError: false, durationMs: 1200, text: "done" }],
    ["is_error on a success (an API failure)", { subtype: "success", is_error: true, result: "Credit balance is too low" }, { isError: true, durationMs: 0, text: "Credit balance is too low" }],
    ["an error subtype without is_error", { subtype: "error_max_turns", is_error: false, duration_ms: 5 }, { isError: true, durationMs: 5, text: "" }],
    ["an is_error that is not the boolean true", { subtype: "success", is_error: "yes" }, { isError: false, durationMs: 0, text: "" }],
    ["neither a subtype nor is_error", {}, { isError: false, durationMs: 0, text: "" }],
    ["a subtype that is not text", { subtype: 5 }, { isError: false, durationMs: 0, text: "" }],
    ["a duration that is not a number", { subtype: "success", duration_ms: "slow" }, { isError: false, durationMs: 0, text: "" }],
    ["a duration that is a number in a string", { subtype: "success", duration_ms: "1500" }, { isError: false, durationMs: 0, text: "" }],
    ["a duration that is not finite", { subtype: "success", duration_ms: Infinity }, { isError: false, durationMs: 0, text: "" }],
    ["a result that is not text", { subtype: "success", result: { a: 1 } }, { isError: false, durationMs: 0, text: "" }],
    ["a blank result", { subtype: "success", result: "  \n\t " }, { isError: false, durationMs: 0, text: "" }],
  ])("done for %s", async (_what, fields, expected) => {
    const { sidebar, attention } = await listedWindow();
    sidebar.emit("c1", { type: "result", session_id: "s1", uuid: "r-x", ...fields });
    expect(attention).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", ...expected }]);
  });

  test("a result that names no session is the channel's; one on a channel without a session is nobody's", async () => {
    const { sidebar, attention } = await listedWindow();
    sidebar.emit("c1", { type: "result", subtype: "success", uuid: "r-1", result: "fine" }); // no session_id: the channel's
    expect(attention).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 0, text: "fine" }]);
    attention.length = 0;
    sidebar.openChannel("c7"); // a new session has no id before its system/init
    sidebar.emit("c7", { type: "result", subtype: "success", uuid: "r-2" });
    expect(attention).toEqual([]);
  });

  test("a prompt on a channel that has no session yet is not announced", () => {
    const { sidebar, attention } = windowWith();
    sidebar.openChannel("c7");
    sidebar.requestPermission("c7", bash);
    expect(attention).toEqual([]);
  });

  test("nothing while remote access is off", async () => {
    const { agent, sidebar, tab, attention } = await listedWindow();
    agent.setEnabled(false);
    const asked = sidebar.requestPermission("c1", bash);
    sidebar.send({ type: "request", channelId: "c1", requestId: asked.requestId, request: bash }); // delivered again
    sidebar.emit("c1", init("s1"));
    sidebar.emit("c1", result("s1"));
    sidebar.emit("c1", { type: "result", subtype: "error_during_execution", is_error: true, session_id: "s1", uuid: "r-err" });
    await sidebar.fromClient({ type: "response", requestId: asked.requestId, response: allowBash }); // an answer reports no open prompts either
    sidebar.requestPermission("c1", edit);
    sidebar.closeChannel("c1");
    await agent.refreshProject();
    expect(attention).toEqual([]);

    agent.setEnabled(true); // and the events are back
    const next = tab.requestPermission("c2", bash);
    tab.emit("c2", result("s2"));
    expect(attention.map((ev) => ev.kind)).toEqual(["open", "waiting", "done"]);
    expect(attention[1]).toMatchObject({ session: "s2", requestId: next.requestId, title: "Add dark mode" });
  });

  test("replayAttention reports the open prompts", async () => {
    const { agent, sidebar, attention } = await listedWindow();
    agent.replayAttention();
    expect(attention).toEqual([]); // no prompts

    const asked = sidebar.requestPermission("c1", bash);
    attention.length = 0;
    agent.replayAttention();
    expect(attention).toEqual([{ kind: "open", session: "s1", requestIds: [asked.requestId] }]);
    expect(attention.every((ev) => ev.kind === "open")).toBe(true); // no waiting

    agent.setEnabled(false);
    attention.length = 0;
    agent.replayAttention();
    expect(attention).toEqual([]);
  });

  test("a prompt announced to a hub is only counted on replay", async () => {
    const { agent, sidebar, attention } = await listedWindow();
    const asked = sidebar.requestPermission("c1", bash);
    expect(waitings(attention)).toHaveLength(1);
    attention.length = 0;
    agent.replayAttention();
    expect(waitings(attention)).toEqual([]); // no second waiting
    expect(opens(attention)).toEqual([{ kind: "open", session: "s1", requestIds: [asked.requestId] }]);
  });

  test("a prompt that appeared while no hub listened is announced on replay", async () => {
    const { agent, sidebar } = await listedWindow();
    agent.removeAllListeners("attention");
    const asked = sidebar.requestPermission("c1", bash);
    const heard: any[] = [];
    agent.on("attention", (ev: any) => heard.push(ev));
    agent.replayAttention();
    expect(waitings(heard)).toEqual([{ kind: "waiting", session: "s1", requestId: asked.requestId, title: "Fix the flaky test", prompt: { kind: "tool", toolName: "Bash", text: "npm test" } }]);
    expect(opens(heard)).toEqual([{ kind: "open", session: "s1", requestIds: [asked.requestId] }]);
    heard.length = 0;
    agent.replayAttention();
    expect(waitings(heard)).toEqual([]); // announced once
    expect(opens(heard)).toEqual([{ kind: "open", session: "s1", requestIds: [asked.requestId] }]);
  });

  test("a prompt that appeared while remote access was off is announced when it turns on", async () => {
    const { agent, sidebar, attention } = await listedWindow();
    agent.setEnabled(false);
    const asked = sidebar.requestPermission("c1", bash);
    expect(attention).toEqual([]);
    agent.setEnabled(true);
    expect(waitings(attention)).toEqual([{ kind: "waiting", session: "s1", requestId: asked.requestId, title: "Fix the flaky test", prompt: { kind: "tool", toolName: "Bash", text: "npm test" } }]);
    expect(opens(attention)).toEqual([{ kind: "open", session: "s1", requestIds: [asked.requestId] }]);
  });

  test.each([
    ["Bash: the command, on one line", "Bash", { command: "git  status\n  --short", description: "x" }, "git status --short"],
    ["Write: the file's base name", "Write", { file_path: "/work/demo/src/new.ts", content: "x" }, "new.ts"],
    ["Read: the file's base name", "Read", { file_path: "/work/demo/README.md" }, "README.md"],
    ["MultiEdit: the file's base name", "MultiEdit", { file_path: "/work/demo/a/b.ts", edits: [] }, "b.ts"],
    ["NotebookEdit: the notebook's base name", "NotebookEdit", { notebook_path: "/work/demo/nb/analysis.ipynb", new_source: "x" }, "analysis.ipynb"],
    ["Edit: file_path before notebook_path", "Edit", { notebook_path: "/n/other.ipynb", file_path: "/x/first.ts" }, "first.ts"],
    ["WebFetch: the URL", "WebFetch", { url: "https://example.com/docs?a=1", prompt: "summarize" }, "https://example.com/docs?a=1"],
    ["WebSearch: the query", "WebSearch", { query: "bun test  watch", allowed_domains: ["example.com"] }, "bun test watch"],
    ["another tool: the first string value", "mcp__tracker__create_issue", { count: 3, project: "demo", title: "Crash on start" }, "demo"],
    ["another tool: not a blank or empty one", "Grep", { head: "", pattern: "  \n", path: "src", glob: "*.ts" }, "src"],
    ["another tool: nested strings are not looked at", "Task", { options: { deep: "x" }, list: ["y"], flag: true }, ""],
    ["Bash without a command", "Bash", { description: "x" }, ""],
    ["Bash with a command that is not text", "Bash", { command: 5 }, ""],
    ["Edit with a path that is not text", "Edit", { file_path: 5 }, ""],
    ["Edit without a path", "Edit", { old_string: "a" }, ""],
    ["a tool without input", "Bash", undefined, ""],
  ])("the key argument of a tool prompt: %s", async (_what, toolName, inputs, text) => {
    const { sidebar, attention } = await listedWindow();
    const asked = sidebar.requestPermission("c1", { ...bash, toolName, inputs });
    expect(waitings(attention)).toEqual([expect.objectContaining({ requestId: asked.requestId, prompt: { kind: "tool", toolName, text } })]);
  });

  test.each([
    ["the first question, on one line", { questions: question.inputs.questions }, "Which package manager?"],
    ["no questions", { questions: [] }, ""],
    ["no list of questions", {}, ""],
    ["a first question that is not a record", { questions: ["Which?"] }, ""],
    ["a first question that is not text", { questions: [{ question: 5 }] }, ""],
  ])("the text of a question prompt: %s", async (_what, inputs, text) => {
    const { sidebar, attention } = await listedWindow();
    sidebar.requestPermission("c1", { ...question, inputs });
    expect(waitings(attention)[0].prompt).toEqual({ kind: "question", toolName: "AskUserQuestion", text });
  });

  test("the text is cut to 140 characters and an ellipsis, never inside an emoji, and a text of 140 stays whole", async () => {
    const { sidebar, attention } = await listedWindow();
    const textOf = (inputs: Record<string, unknown>) => {
      attention.length = 0;
      sidebar.requestPermission("c1", { ...bash, inputs });
      return waitings(attention)[0].prompt.text;
    };
    expect(textOf({ command: `echo ${"x".repeat(500)}` })).toBe(`echo ${"x".repeat(135)}…`);
    expect(textOf({ command: "z".repeat(140) })).toBe("z".repeat(140));
    expect(textOf({ command: "z".repeat(141) })).toBe(`${"z".repeat(140)}…`);
    expect(textOf({ command: `${"y".repeat(139)}😀 and more` })).toBe(`${"y".repeat(139)}…`); // the pair would be cut in two
    expect(textOf({ command: `${"y".repeat(138)}😀 and more` })).toBe(`${"y".repeat(138)}😀…`); // the pair fits
    sidebar.emit("c1", { ...result("s1"), result: "R".repeat(500) });
    expect(attention.at(-1)).toMatchObject({ kind: "done", text: `${"R".repeat(140)}…` });
  });

  test("attention titles match the sessions list", async () => {
    const { provider, sidebar, tab, attention } = await listedWindow({
      sessions: [
        { id: "s1", summary: "Fix the flaky test", lastModified: 1_000 },
        { id: "s2", summary: "A summary", customTitle: "Custom title", lastModified: 2_000 },
        { id: "s3", lastModified: 500 },
      ],
    });
    const titleOf = (comms: typeof sidebar, channel: string) => {
      attention.length = 0;
      comms.requestPermission(channel, bash);
      return waitings(attention)[0].title;
    };
    expect(titleOf(sidebar, "c1")).toBe("Fix the flaky test"); // the listed summary
    expect(titleOf(tab, "c2")).toBe("Custom title"); // a custom title wins over the summary
    provider.sessionStates.set("s1", { info: { sessionId: "s1", state: "running", title: "Named by the panel" } });
    expect(titleOf(sidebar, "c1")).toBe("Named by the panel"); // and the panel's own over both
    provider.sessionStates.set("s1", { info: { sessionId: "s1", state: "running", title: "" } });
    expect(titleOf(sidebar, "c1")).toBe("Fix the flaky test");
    sidebar.openChannel("c3", "s3"); // listed, but without any title
    expect(titleOf(sidebar, "c3")).toBe("Untitled");
    sidebar.openChannel("c7", "s-unlisted"); // not listed at all
    expect(titleOf(sidebar, "c7")).toBe("New session");

    provider.sessionStates.set("s1", { info: { sessionId: "s1", state: "running", title: `first line\n\n  second   line ${"x".repeat(500)}` } });
    const long = titleOf(sidebar, "c1");
    expect(long.startsWith("first line second line xxx")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(201);
  });

  test("a window whose session list was never read still names a session by its live title, else New session", () => {
    const { provider, sidebar, attention } = windowWith();
    sidebar.requestPermission("c1", bash);
    expect(waitings(attention)[0].title).toBe("New session");
    provider.sessionStates.set("s1", { info: { sessionId: "s1", state: "waiting_input", title: "Live title" } });
    sidebar.requestPermission("c1", edit);
    expect(waitings(attention)[1].title).toBe("Live title");
  });

  test("a request id is remembered for the last 1000 requests only", async () => {
    const { sidebar, attention } = await listedWindow();
    const deliver = (n: number) => sidebar.send({ type: "request", channelId: "c1", requestId: `req-${n}`, request: bash });
    for (let n = 0; n <= 1000; n++) deliver(n); // 1001 different requests
    expect(waitings(attention)).toHaveLength(1001);
    deliver(1000); // remembered
    expect(waitings(attention)).toHaveLength(1001);
    deliver(1); // still remembered: it is the oldest of the last 1000
    expect(waitings(attention)).toHaveLength(1001);
    deliver(0); // forgotten
    expect(waitings(attention)).toHaveLength(1002);
    expect(waitings(attention).at(-1)).toMatchObject({ requestId: "req-0" });
  });

  test("a listener that throws is logged, and does not keep the agent from its other work", async () => {
    const { agent, sidebar, events, attention, logs } = await listedWindow();
    agent.on("attention", (ev: any) => {
      if (ev.kind === "open") throw new Error("listener broke");
    });
    const asked = sidebar.requestPermission("c1", bash);
    expect(waitings(attention)).toEqual([expect.objectContaining({ requestId: asked.requestId })]); // `waiting` came after the failing `open`
    expect(pendingEvents(events).at(-1)![1].pending).toHaveLength(1);
    expect(logs.filter((line) => line === "window agent: listener broke").length).toBeGreaterThan(0);
    expect((await agent.snapshot("s1")).pending).toHaveLength(1);
  });
});

// ---- sending -----------------------------------------------------------------------------------------

describe("send", () => {
  const png = { mediaType: "image/png", data: "iVBORw0KGgo=" };
  const jpeg = { mediaType: "image/jpeg", data: "/9j/4AAQSkZJRg==" };

  test("send(s1, hi) injects the webview's prompt on c1; the CLI's replay comes back with the same uuid", async () => {
    const { agent, sidebar, events } = windowWith();
    const sent = await agent.send("s1", "hi");
    expect(sent).toEqual({ session: "s1", uuid: expect.stringMatching(UUID) });
    expect(sidebar.received).toEqual([
      {
        type: "io_message",
        channelId: "c1",
        done: false,
        message: { type: "user", uuid: sent.uuid, session_id: "", parent_tool_use_id: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
      },
    ]);
    await sidebar.flush();
    expect(events).toContainEqual(["s1", { t: "msg", message: expect.objectContaining({ uuid: sent.uuid, type: "user", isReplay: true }) }]);
    expect(sidebar.readerError).toBeUndefined();
  });

  test("a session with a running and a launching channel gets the prompt on the running one", async () => {
    const { agent, sidebar, tab } = windowWith();
    tab.openChannel("c8", "s1", { pending: true });
    await agent.send("s1", "hi");
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c1"]);
    expect(tab.received).toEqual([]);
  });

  test("images go before the text; images alone send no text block", async () => {
    const { agent, sidebar } = windowWith();
    await agent.send("s1", "look", [png, jpeg]);
    expect(sidebar.received.at(-1)!.message.message.content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: png.data } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.data } },
      { type: "text", text: "look" },
    ]);
    await agent.send("s1", "", [png]);
    expect(sidebar.received.at(-1)!.message.message.content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: png.data } }]);
  });

  test("bad images reject bad_images before anything is opened or injected; 5 MB is still fine", async () => {
    const { agent, sidebar, vscode } = windowWith();
    const tooMany = [png, png, png, png, png];
    for (const images of [tooMany, [{ mediaType: "image/png", data: "A".repeat(6 * MB) }], [{ mediaType: "image/svg+xml", data: "PHN2Zz4=" }], [{ mediaType: "image/png", data: "not base64!" }], [{ mediaType: "image/png", data: "" }], [null], {}]) {
      await expect(agent.send("s3", "hi", images as any)).rejects.toThrow("bad_images");
    }
    expect(vscode.commands.calls).toEqual([]);
    expect(sidebar.received).toEqual([]);
    await agent.send("s1", "big", [{ mediaType: "image/webp", data: "A".repeat(5 * MB) }]);
    expect(sidebar.received).toHaveLength(1);
  });

  test("text: empty without images rejects empty, over 100 000 characters too_long", async () => {
    const { agent, sidebar } = windowWith();
    await expect(agent.send("s1", "")).rejects.toThrow("empty");
    await expect(agent.send("s1", "  \n ")).rejects.toThrow("empty");
    await expect(agent.send("s1", "x".repeat(100_001))).rejects.toThrow("too_long");
    expect(sidebar.received).toEqual([]);
    await agent.send("s1", "x".repeat(100_000));
    expect(sidebar.received).toHaveLength(1);
  });

  test("send(s3) (listed, no channel) opens it in an editor and sends to its channel once it appears", async () => {
    const { agent, vscode, provider } = windowWith();
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      setTimeout(() => {
        opened = createFakeComms({ sessions: LISTED });
        provider.allComms.add(opened);
        opened.openChannel("c3", "s3", { pending: true }); // still launching: the prompt waits in its input
      }, 100);
    };
    const sent = await agent.send("s3", "hi");
    expect(vscode.commands.calls).toEqual([editorOpen("s3", PIN_TO_PANEL)]);
    expect(sent).toEqual({ session: "s3", uuid: expect.stringMatching(UUID) });
    expect(opened!.received).toEqual([{ type: "io_message", channelId: "c3", done: false, message: expect.objectContaining({ uuid: sent.uuid }) }]);
    await opened!.flush();
    expect(opened!.pendingChannels.get("c3")!.in.queue.map((m) => m.uuid)).toEqual([sent.uuid]);
  });

  test("a session whose channel never opens rejects timeout after channelWaitMs", async () => {
    const { agent, vscode } = windowWith({ channelWaitMs: 300 });
    const started = Date.now();
    await expect(agent.send("s3", "hi")).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeGreaterThanOrEqual(290);
    expect(vscode.commands.calls).toEqual([editorOpen("s3", PIN_TO_PANEL)]);
  });

  test("send to a session whose tab is open but whose Claude process stopped: the tab is closed, the session reopened, the prompt sent there", async () => {
    const { agent, vscode, provider } = windowWith();
    const stale = addFakePanel(provider, "s3"); // the tab still shows s3; its channel closed when the CLI exited
    const order: string[] = [];
    const dispose = stale.dispose;
    stale.dispose = () => {
      order.push("dispose");
      dispose();
    };
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = (id) => {
      order.push(id);
      setTimeout(() => {
        opened = createFakeComms({ sessions: LISTED });
        provider.allComms.add(opened);
        opened.openChannel("c3", "s3", { pending: true }); // the fresh tab resumes s3
      }, 100);
    };
    const sent = await agent.send("s3", "hi");
    expect(order).toEqual(["dispose", "claude-vscode.editor.open"]);
    expect(stale.disposed).toBe(true);
    expect(vscode.commands.calls).toEqual([editorOpen("s3", PIN_TO_PANEL)]);
    expect(sent).toEqual({ session: "s3", uuid: expect.stringMatching(UUID) });
    expect(opened!.received).toEqual([{ type: "io_message", channelId: "c3", done: false, message: expect.objectContaining({ uuid: sent.uuid }) }]);
  });

  test("a session the sidebar shows without a Claude process gets one open, then not_running_in_vscode fast", async () => {
    const { agent, vscode, provider } = windowWith({ channelWaitMs: 3000, wakeWaitMs: 200 });
    provider.sidebarHoldsSession = (id) => id === "s3";
    const started = Date.now();
    await expect(agent.send("s3", "hi")).rejects.toThrow("not_running_in_vscode");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(vscode.commands.calls).toEqual([editorOpen("s3", PIN_TO_PANEL)]);
  });

  test("a session the sidebar shows is sent to when that one open starts a channel", async () => {
    const { agent, vscode, provider } = windowWith({ wakeWaitMs: 2000 });
    provider.sidebarHoldsSession = (id) => id === "s3";
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      setTimeout(() => {
        opened = createFakeComms({ sessions: LISTED });
        provider.allComms.add(opened);
        opened.openChannel("c3", "s3", { pending: true });
      }, 100);
    };
    const sent = await agent.send("s3", "hi");
    expect(sent).toEqual({ session: "s3", uuid: expect.stringMatching(UUID) });
    expect(opened!.received).toEqual([{ type: "io_message", channelId: "c3", done: false, message: expect.objectContaining({ uuid: sent.uuid }) }]);
  });

  test("a tab that cannot be closed gets one open, then not_running_in_vscode fast, and the failure is logged", async () => {
    const { agent, vscode, provider, logs } = windowWith({ channelWaitMs: 3000, wakeWaitMs: 200 });
    const stuck = addFakePanel(provider, "s3");
    stuck.dispose = () => {
      throw new Error("the panel is gone");
    };
    const started = Date.now();
    await expect(agent.send("s3", "hi")).rejects.toThrow("not_running_in_vscode");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(vscode.commands.calls).toEqual([editorOpen("s3", PIN_TO_PANEL)]);
    expect(logs.some((line) => line.includes("the panel is gone"))).toBe(true);
  });

  test("a failing editor.open rejects open_failed at once", async () => {
    const { agent, vscode, logs } = windowWith({ channelWaitMs: 5000 });
    vscode.commands.onCommand = () => {
      throw new Error("command 'claude-vscode.editor.open' not found");
    };
    const started = Date.now();
    await expect(agent.send("s3", "hi")).rejects.toThrow("open_failed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(logs.some((line) => line.includes("not found"))).toBe(true);
  });

  test("a session the window does not know is refused (unknown_session) without opening anything", async () => {
    const { agent, vscode } = windowWith();
    await expect(agent.send("s-unknown", "hi")).rejects.toThrow("unknown_session");
    await expect(agent.send(42 as any, "hi")).rejects.toThrow("bad_session");
    expect(vscode.commands.calls).toEqual([]);
  });

  test("send(null) opens a new session and injects into the new channel; the result names the session once init does", async () => {
    const { agent, vscode, provider, sidebar, tab } = windowWith();
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      setTimeout(() => {
        opened = createFakeComms({ sessions: LISTED });
        opened.openChannel("c-new"); // a new session: no session id yet
        provider.allComms.add(opened);
      }, 50);
    };
    const sent = await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, PIN_TO_PANEL)]);
    expect(opened!.received).toEqual([{ type: "io_message", channelId: "c-new", done: false, message: expect.objectContaining({ uuid: sent.uuid }) }]);
    const named = opened!.channels.get("c-new")!.sessionId;
    expect(named).toMatch(/^s-\d+$/);
    expect(sent).toEqual({ session: named, uuid: expect.stringMatching(UUID) });
    expect(sidebar.received).toEqual([]);
    expect(tab.received).toEqual([]);
    await opened!.flush();
    expect(opened!.readerError).toBeUndefined();
  });

  test("send(null) into a launching channel: the prompt waits for the launch, then the session is the one init names", async () => {
    const { agent, vscode, provider } = windowWith();
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      setTimeout(() => {
        opened = createFakeComms();
        opened.openChannel("c-new", undefined, { pending: true }); // the tab's CLI starts at once (preloadConnection)
        provider.allComms.add(opened);
        setTimeout(() => opened!.promoteChannel("c-new"), 50);
      }, 20);
    };
    const sent = await agent.send(null, "new");
    expect(opened!.received.map((m) => m.channelId)).toEqual(["c-new"]);
    const running = opened!.channels.get("c-new")!;
    expect(running.sessionId).toMatch(/^s-\d+$/);
    expect(sent).toEqual({ session: running.sessionId, uuid: expect.stringMatching(UUID) });
    await opened!.flush();
    expect(opened!.readerError).toBeUndefined();
  });

  test("send(null) gives session null when no init names the new session in time", async () => {
    const { agent, vscode, provider } = windowWith({ channelWaitMs: 300 });
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      opened = createFakeComms();
      provider.allComms.add(opened);
      opened.openChannel("c-new", undefined, { pending: true });
    };
    const sent = await agent.send(null, "new");
    expect(sent).toEqual({ session: null, uuid: expect.stringMatching(UUID) });
    await opened!.flush();
    expect(opened!.pendingChannels.get("c-new")!.in.queue.map((m) => m.uuid)).toEqual([sent.uuid]);
  });

  test("send(null) whose launch fails before a session is named rejects closed at once (the prompt went with it)", async () => {
    const { agent, vscode, provider } = windowWith({ channelWaitMs: 5000 });
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      opened = createFakeComms();
      opened.openChannel("c-new", undefined, { pending: true });
      provider.allComms.add(opened);
      setTimeout(() => opened!.closeChannel("c-new", true, "Claude Code could not start"), 20);
    };
    const started = Date.now();
    await expect(agent.send(null, "new")).rejects.toThrow("closed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(opened!.received.map((m) => m.type)).toEqual(["io_message"]); // it was given, and lost with the channel
  });

  test("send(null) whose channel vanishes without a word just before the wait ends rejects closed", async () => {
    // The wait looks every 250 ms and ends at 300 ms; the channel goes at 280 ms, silently (no close_channel).
    const { agent, vscode, provider } = windowWith({ channelWaitMs: 300 });
    vscode.commands.onCommand = () => {
      const opened = createFakeComms();
      opened.openChannel("c-new", undefined, { pending: true });
      provider.allComms.add(opened);
      setTimeout(() => opened.pendingChannels.delete("c-new"), 280);
    };
    await expect(agent.send(null, "new")).rejects.toThrow("closed");
  });

  test("send(null) whose running channel closes before init rejects closed", async () => {
    const { agent, vscode, provider } = windowWith({ channelWaitMs: 5000 });
    let opened: FakeComms | undefined;
    vscode.commands.onCommand = () => {
      opened = createFakeComms({ autoTurn: false }); // the CLI never answers
      opened.openChannel("c-new");
      provider.allComms.add(opened);
      setTimeout(() => opened!.closeChannel("c-new", true, "the CLI exited"), 30);
    };
    await expect(agent.send(null, "new")).rejects.toThrow("closed");
  });

  test("send(null) skips channels that existed before and channels that already belong to a session", async () => {
    const { agent, vscode, sidebar } = windowWith();
    sidebar.openChannel("c-old"); // a new-session channel that was there before the command
    vscode.commands.onCommand = () => {
      setTimeout(() => sidebar.openChannel("c-s3", "s3"), 10); // the user opened s3 meanwhile
      setTimeout(() => sidebar.openChannel("c-new"), 60);
    };
    const sent = await agent.send(null, "new");
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId);
  });

  test("two new sessions at once get a channel each", async () => {
    const { agent, vscode, provider } = windowWith();
    const opened: FakeComms[] = [];
    vscode.commands.onCommand = () => {
      setTimeout(() => {
        const comms = createFakeComms();
        comms.openChannel(`c-new-${opened.length}`);
        opened.push(comms);
        provider.allComms.add(comms);
      }, 30);
    };
    const [first, second] = await Promise.all([agent.send(null, "one"), agent.send(null, "two")]);
    expect(opened.map((comms) => comms.received.length)).toEqual([1, 1]);
    expect(new Set([first.session, second.session]).size).toBe(2);
  });
});

// ---- interrupt, open --------------------------------------------------------------------------------

describe("interrupt and open", () => {
  test("interrupt(s1) sends interrupt_claude on c1; the turn ends", async () => {
    const { agent, sidebar } = windowWith();
    await agent.refreshProject();
    sidebar.emit("c1", init("s1"));
    expect(sessionOf(agent.project(), "s1").state).toBe("running");
    await agent.interrupt("s1");
    expect(sidebar.received).toEqual([{ type: "interrupt_claude", channelId: "c1" }]);
    await sidebar.flush();
    expect(sessionOf(agent.project(), "s1").state).toBe("idle");
    expect(sidebar.readerError).toBeUndefined();
  });

  test("interrupt without a channel rejects not_running", async () => {
    const { agent, sidebar, tab } = windowWith();
    await expect(agent.interrupt("s3")).rejects.toThrow("not_running");
    expect([...sidebar.received, ...tab.received]).toEqual([]);
  });

  test("open and openClaude open where the user keeps Claude Code, without changing it; a failing command rejects open_failed", async () => {
    const { agent, vscode } = windowWith();
    await agent.open("s3");
    await agent.openClaude();
    // Not claude-vscode.sidebar.open: it saves "sidebar" as the user's preferred location.
    expect(vscode.commands.calls).toEqual([editorOpen("s3", HONOR_LOCATION), editorOpen(undefined, HONOR_LOCATION)]);
    vscode.commands.onCommand = () => Promise.reject(new Error("no"));
    await expect(agent.open("s3")).rejects.toThrow("open_failed");
    await expect(agent.openClaude()).rejects.toThrow("open_failed");
  });
});

// ---- the project -------------------------------------------------------------------------------------

describe("project", () => {
  test("id, name, folders and editor", async () => {
    const { agent } = windowWith();
    const id = projectIdOf(`${APP}\n/work/demo`);
    expect(agent.projectId()).toBe(id);
    expect(await agent.refreshProject()).toMatchObject({ id, name: "demo", folders: ["/work/demo"], editor: APP, claudeOpen: true });

    const multi = windowWith({ vscode: createFakeVscode({ folders: ["/work/a", "/work/b"], name: null, appName: "Cursor" }) });
    expect(multi.agent.project()).toMatchObject({ id: projectIdOf("Cursor\n/work/a\n/work/b"), name: "a", folders: ["/work/a", "/work/b"], editor: "Cursor" });

    const none = windowWith({ vscode: createFakeVscode({ folders: [], name: null }) });
    expect(none.agent.project()).toMatchObject({ id: projectIdOf(`${APP}\n`), name: "No folder", folders: [] });
  });

  test("sessions: the list without archived ones, most recent activity first, titles by precedence", async () => {
    const { agent, provider } = windowWith({
      sessions: [
        { id: "s1", summary: "Fix the flaky test", lastModified: 1_000, lastActivity: 5_000 },
        { id: "s2", summary: "A summary", customTitle: "Custom title", lastModified: 3_000 },
        { id: "s3", summary: "Old work", lastModified: 500, gitBranch: "main", worktree: { name: "wt-1", path: "/work/demo/.claude/worktrees/wt-1" } },
        { id: "s4", summary: "Archived", lastModified: 9_000, archived: true },
        { id: "s5", lastModified: 100 },
      ],
    });
    provider.sessionStates.set("s1", { info: { sessionId: "s1", state: "idle", title: "Live title" } });
    const project = await agent.refreshProject();
    expect(project.sessions).toEqual([
      { id: "s1", title: "Live title", lastModified: 5_000, state: "idle", live: true, pendingCount: 0 },
      { id: "s2", title: "Custom title", lastModified: 3_000, state: "idle", live: true, pendingCount: 0 },
      { id: "s3", title: "Old work", lastModified: 500, state: "idle", live: false, gitBranch: "main", worktree: "wt-1", pendingCount: 0 },
      { id: "s5", title: "Untitled", lastModified: 100, state: "idle", live: false, pendingCount: 0 },
    ]);
  });

  test("long or multi-line titles are made one short line", async () => {
    const { agent } = windowWith({ sessions: [{ id: "s1", summary: `first line\n\n  second   line ${"x".repeat(500)}`, lastModified: 1 }] });
    const title = sessionOf(await agent.refreshProject(), "s1").title;
    expect(title.startsWith("first line second line xxx")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(201);
  });

  test("state precedence: waiting > running > unread > idle", async () => {
    const { agent, provider, sidebar } = windowWith({
      sessions: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"].map((id, index) => ({ id, summary: id, lastModified: 100 - index })),
    });
    sidebar.emit("c1", init("s1"));
    sidebar.requestPermission("c1", bash); // s1: running and a prompt → waiting
    provider.sessionStates.set("s2", { info: { sessionId: "s2", state: "running", title: "" } });
    provider.unreadSessionKeys.add("s2"); // s2: running and unread → running
    provider.unreadSessionKeys.add("s3"); // s3: unread
    provider.unreadSessionKeys.add("remote:s4"); // a cloud key is not s4's
    provider.sessionStates.set("s5", { info: { sessionId: "s5", state: "waiting_input", title: "" } });
    provider.liveElsewhereSessions.push({ sessionId: "s6", holder: "terminal", activity: "waiting", sameProject: true });
    provider.liveElsewhereSessions.push({ sessionId: "s7", holder: "terminal", activity: "running", sameProject: true });
    provider.liveElsewhereSessions.push({ sessionId: "s8", holder: "terminal", activity: "idle", sameProject: true });
    const project = await agent.refreshProject();
    expect(Object.fromEntries(project.sessions.map((s: any) => [s.id, [s.state, s.pendingCount]]))).toEqual({
      s1: ["waiting", 1],
      s2: ["running", 0],
      s3: ["unread", 0],
      s4: ["idle", 0],
      s5: ["waiting", 0],
      s6: ["waiting", 0],
      s7: ["running", 0],
      s8: ["idle", 0],
    });
  });

  test("a channel whose session isn't listed appears as New session; a channel without a session does not appear", async () => {
    const { agent, tab, provider } = windowWith({ now: () => 7_000 });
    await agent.refreshProject();
    tab.openChannel("c9", "s-fresh");
    tab.openChannel("c10");
    let project = agent.project();
    expect(project.sessions[0]).toEqual({ id: "s-fresh", title: "New session", lastModified: 7_000, state: "idle", live: true, pendingCount: 0 });
    expect(project.sessions.map((s: any) => s.id)).toEqual(["s-fresh", "s2", "s1", "s3"]);
    provider.sessionStates.set("s-fresh", { info: { sessionId: "s-fresh", state: "running", title: "Named by the panel" } });
    project = agent.project();
    expect(project.sessions[0]).toMatchObject({ title: "Named by the panel", state: "running" });
  });

  test("no comms in the window: claudeOpen false and no sessions", async () => {
    const provider = createFakeProvider();
    const agent = new WindowAgent({ provider, vscode: createFakeVscode() });
    agent.start();
    expect(agent.project()).toMatchObject({ claudeOpen: false, sessions: [] });
    expect(await agent.refreshProject()).toMatchObject({ claudeOpen: false, sessions: [] });
  });

  test("refreshProject emits project only when the JSON changed", async () => {
    const { agent, sidebar, projects } = windowWith();
    const first = await agent.refreshProject();
    await agent.refreshProject();
    expect(projects).toEqual([first]);
    sidebar.emit("c1", init("s1"));
    const second = await agent.refreshProject();
    expect(projects).toEqual([first, second]);
    expect(sessionOf(second, "s1").state).toBe("running");
  });

  test("a failing session list keeps the last one", async () => {
    const { agent, sidebar, logs } = windowWith();
    await agent.refreshProject();
    sidebar.buildSessionList = async () => {
      throw new Error("disk trouble");
    };
    const project = await agent.refreshProject();
    expect(project.sessions.map((s: any) => s.id)).toEqual(["s2", "s1", "s3"]);
    expect(logs.some((line) => line.includes("disk trouble"))).toBe(true);
  });

  test("setActive(true) refreshes at once and then every refreshEveryMs; setActive(false) stops it", async () => {
    let lists = 0;
    const { agent } = windowWith({
      refreshEveryMs: 40,
      before: ({ sidebar }) => {
        const original = sidebar.buildSessionList.bind(sidebar);
        sidebar.buildSessionList = () => {
          lists++;
          return original();
        };
      },
    });
    agent.setActive(true);
    expect(lists).toBe(1);
    await sleep(200);
    expect(lists).toBeGreaterThanOrEqual(3);
    agent.setActive(false);
    const stopped = lists;
    await sleep(120);
    expect(lists).toBe(stopped);
  });

  test("while active, a change refreshes the project refreshDelayMs later; while inactive nothing does", async () => {
    const { agent, sidebar, projects } = windowWith({ refreshDelayMs: 30, refreshEveryMs: 60_000 });
    sidebar.emit("c1", init("s1"));
    await sleep(80);
    expect(projects).toEqual([]);
    agent.setActive(true);
    await sleep(20);
    expect(projects).toHaveLength(1);
    expect(sessionOf(projects[0], "s1").state).toBe("running");
    sidebar.emit("c1", result("s1"));
    expect(projects).toHaveLength(1);
    await sleep(150);
    expect(projects).toHaveLength(2);
    expect(sessionOf(projects[1], "s1").state).toBe("idle");
    agent.setActive(false);
    sidebar.emit("c1", init("s1"));
    await sleep(80);
    expect(projects).toHaveLength(2);
  });

  test("a folder change gives a new project id and, while active, a new project", async () => {
    const { agent, vscode, projects } = windowWith({ refreshDelayMs: 20, refreshEveryMs: 60_000 });
    agent.setActive(true);
    await sleep(20);
    vscode.workspace.setFolders(["/work/other"]);
    expect(agent.projectId()).toBe(projectIdOf(`${APP}\n/work/other`));
    await sleep(100);
    expect(projects.at(-1)).toMatchObject({ id: projectIdOf(`${APP}\n/work/other`), folders: ["/work/other"] });
    agent.setActive(false);
  });

  test("a provider or vscode without the expected members degrades instead of throwing", async () => {
    for (const agent of [new WindowAgent({ provider: {}, vscode: {} }), new WindowAgent({})]) {
      expect(() => agent.start()).not.toThrow();
      expect(agent.project()).toEqual({ id: projectIdOf("VS Code\n"), name: "No folder", folders: [], editor: "VS Code", claudeOpen: false, sessions: [] });
      expect(await agent.refreshProject()).toMatchObject({ claudeOpen: false, sessions: [] });
      expect(await agent.snapshot("s1")).toEqual({ messages: [], pending: [], state: "idle", live: false, truncatedBefore: 0 });
      await expect(agent.send(null, "hi")).rejects.toThrow("open_failed");
      await expect(agent.openClaude()).rejects.toThrow("open_failed");
      await expect(agent.interrupt("s1")).rejects.toThrow("not_running");
      await expect(agent.answer("s1", "r-1", { kind: "allow" })).rejects.toThrow("not_pending");
      agent.setActive(true);
      agent.setActive(false);
    }
  });
});

// ---- snapshots -------------------------------------------------------------------------------------------

describe("snapshot", () => {
  test("merges the transcript with the live messages by uuid, with the prompts and the state", async () => {
    const getSessionArgs: unknown[][] = [];
    const { agent, sidebar } = windowWith({
      before: ({ sidebar }) => {
        const original = sidebar.getSession.bind(sidebar);
        sidebar.getSession = (...args: any[]) => {
          getSessionArgs.push(args);
          return original(...(args as [string]));
        };
      },
    });
    sidebar.setHistory("s1", [user("u-1", "fix the test"), assistant("a-1", "On it.")]);
    sidebar.emit("c1", assistant("a-1", "On it."));
    sidebar.emit("c1", assistant("a-2", "Running the tests."));
    sidebar.emit("c1", textDelta("s1", "Now"));
    const asked = sidebar.requestPermission("c1", bash);

    const snapshot = await agent.snapshot("s1");
    expect(snapshot.messages.map((m: any) => m.uuid)).toEqual(["u-1", "a-1", "a-2"]);
    expect(snapshot.messages[2]).toEqual(toPhoneMessage(assistant("a-2", "Running the tests.")));
    expect(snapshot.pending).toEqual([expect.objectContaining({ requestId: asked.requestId, kind: "tool" })]);
    expect(snapshot.state).toBe("waiting");
    expect(snapshot.live).toBe(true);
    expect(snapshot.truncatedBefore).toBe(0);
    expect(getSessionArgs).toEqual([["s1"]]); // no purpose: no telemetry
    expect(sidebar.directEvents).toEqual([]);
  });

  test("reads the transcript through the comms that holds the session", async () => {
    const { agent, tab } = windowWith();
    tab.setHistory("s2", [user("u-9", "hello", "s2")]);
    expect((await agent.snapshot("s2")).messages.map((m: any) => m.uuid)).toEqual(["u-9"]);
  });

  test("a failing getSession gives an empty history", async () => {
    const { agent, sidebar } = windowWith();
    sidebar.openChannel("c7");
    sidebar.emit("c7", init("s-new")); // a new session: not on disk yet, so getSession rejects
    sidebar.emit("c7", assistant("a-1", "hello", "s-new"));
    const fresh = await agent.snapshot("s-new");
    expect(fresh.messages.map((m: any) => m.uuid)).toEqual(["a-1"]);
    expect(fresh.live).toBe(true);
    sidebar.getSession = () => {
      throw new Error("sync failure");
    };
    sidebar.emit("c1", assistant("a-2", "live only"));
    expect((await agent.snapshot("s1")).messages.map((m: any) => m.uuid)).toEqual(["a-2"]);
    expect(await agent.snapshot("s3")).toEqual({ messages: [], pending: [], state: "idle", live: false, truncatedBefore: 0 });
  });

  test("the live buffer keeps the last 500 messages of a session", async () => {
    const { agent, sidebar, tab } = windowWith();
    for (let i = 0; i < 600; i++) sidebar.emit("c1", assistant(`a-${i}`, `message ${i}`));
    tab.emit("c2", assistant("b-1", "other session", "s2"));
    const snapshot = await agent.snapshot("s1");
    expect(snapshot.messages).toHaveLength(400);
    expect(snapshot.truncatedBefore).toBe(100);
    expect(snapshot.messages[0].uuid).toBe("a-200");
    expect(snapshot.messages.at(-1).uuid).toBe("a-599");
    expect((await agent.snapshot("s2")).messages.map((m: any) => m.uuid)).toEqual(["b-1"]);
  });

  test("only the most recently active sessions keep a live buffer", async () => {
    const { agent, sidebar } = windowWith();
    sidebar.openChannel("c-many");
    const count = AGENT_LIMITS.liveSessions + 5;
    for (let i = 0; i < count; i++) sidebar.emit("c-many", assistant(`x-${i}`, "hi", `x-${i}`));
    expect((await agent.snapshot("x-0")).messages).toEqual([]);
    expect((await agent.snapshot(`x-${count - 1}`)).messages.map((m: any) => m.uuid)).toEqual([`x-${count - 1}`]);
  });

  test("live messages snapshot exactly as mapped, however bulky; the originals are untouched", async () => {
    const { agent, sidebar } = windowWith();
    const big = (char: string, length: number) => char.repeat(length);
    const messages: Message[] = [
      // A long answer, a long thinking with its signature, a call with long and nested input.
      {
        type: "assistant",
        uuid: "a-1",
        session_id: "s1",
        parent_tool_use_id: null,
        timestamp: "2026-11-19T10:00:00.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          model: "claude-test",
          usage: { input_tokens: 10 },
          content: [
            { type: "thinking", thinking: big("t", 10_000), signature: big("S", 5_000) },
            { type: "text", text: big("x", 100_000) },
            {
              type: "tool_use",
              id: "toolu_1",
              name: "MultiEdit",
              input: { file_path: "/a.ts", edits: [{ old_string: big("o", 9_000), new_string: big("n", 9_000) }, { old_string: "a", new_string: "b" }], nested: { deeper: [big("d", 5_000), 42, null, true] } },
            },
          ],
        },
      },
      // A tool result as one long string, with the SDK's structured copy of it.
      {
        type: "user",
        uuid: "u-1",
        session_id: "s1",
        parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: big("r", MB) }] },
        tool_use_result: { stdout: big("r", MB), stderr: "" },
      },
      // Results in parts (text, an image, a part the phone does not show; many small parts; many big ones), an image, a document, a server tool.
      {
        type: "user",
        uuid: "u-2",
        session_id: "s1",
        parent_tool_use_id: "toolu_task",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_2",
              is_error: true,
              content: [{ type: "text", text: big("y", 50_000) }, { type: "image", source: { type: "base64", media_type: "image/png", data: big("A", 3 * MB) } }, { type: "tool_reference", tool_name: "x" }],
            },
            { type: "tool_result", tool_use_id: "toolu_3", content: Array.from({ length: 100 }, (_, i) => ({ type: "text", text: `line ${i}` })) },
            { type: "tool_result", tool_use_id: "toolu_4", content: Array.from({ length: 50 }, () => ({ type: "text", text: big("p", 2_000) })) },
            { type: "tool_result", tool_use_id: "toolu_5", content: [{ type: "text", text: "the screenshot:" }, { type: "image", source: { type: "base64", media_type: "image/png", data: big("D", MB) } }, { type: "text", text: "done" }] },
            { type: "image", source: { type: "base64", media_type: "image/png", data: big("B", 2 * MB) } },
            { type: "document", title: "spec.pdf", source: { type: "base64", media_type: "application/pdf", data: big("C", MB) } },
            { type: "server_tool_use", id: "srv_1", name: "web_search", input: { query: big("q", 10_000) } },
          ],
        },
      },
      // A prompt as a plain string (a replay), and a text that was cut before.
      { type: "user", uuid: "u-3", session_id: "s1", isReplay: true, message: { role: "user", content: big("p", 30_000) } },
      { type: "assistant", uuid: "a-2", session_id: "s1", message: { role: "assistant", content: [{ type: "text", text: big("z", 19_993) + MARK }] } },
      // A result with a long final text, and the compaction marker.
      { type: "result", subtype: "success", is_error: false, duration_ms: 1200, total_cost_usd: 0.5, num_turns: 3, result: big("f", 100_000), session_id: "s1", uuid: "res-1", usage: { input_tokens: 1 } },
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 120000 }, uuid: "cb-1", session_id: "s1", timestamp: "2026-11-19T10:05:00.000Z" },
    ];
    const before = JSON.stringify(messages);
    for (const message of messages) sidebar.emit("c1", message);
    expect((await agent.snapshot("s1")).messages).toEqual(messages.map((message) => toPhoneMessage(message)));
    expect(JSON.stringify(messages)).toBe(before);
  });

  test.skipIf(!NODE)(
    "the live buffer keeps a few kilobytes of a big message alive, not the message (measured in Node with --expose-gc)",
    () => {
      const probe = (mode: "agent" | "none") => {
        const run = spawnSync(NODE!, ["--expose-gc", "-e", RETENTION_PROBE, AGENT_PATH, mode], { encoding: "utf8", timeout: 120_000 });
        expect(run.stderr).toBe("");
        return JSON.parse(run.stdout) as { kept: number; retainedMB: number };
      };
      const without = probe("none");
      const buffered = probe("agent");
      expect(without.kept).toBe(0);
      expect(buffered.kept).toBe(200);
      // What the 200 kept copies hold, cut to what the phone is shown: about 1 MB (measured). Slices of the
      // originals kept all of them alive: about 400 MB (measured on the first version).
      expect(buffered.retainedMB - without.retainedMB).toBeLessThan(5);
    },
    120_000,
  );

  test("a transcript read that never comes gives an empty history after hostReadMs, logged once", async () => {
    const { agent, sidebar, logs } = windowWith({ hostReadMs: 100 });
    sidebar.getSession = () => new Promise<never>(() => {});
    sidebar.emit("c1", assistant("a-1", "live"));
    const started = Date.now();
    const snapshot = await agent.snapshot("s1");
    expect(Date.now() - started).toBeGreaterThanOrEqual(90);
    expect(snapshot.messages.map((m: any) => m.uuid)).toEqual(["a-1"]);
    await agent.snapshot("s1");
    expect(logs.filter((line) => line.includes("did not come"))).toHaveLength(1);
  });

  test("a session list that never comes keeps the last list after hostReadMs, logged once", async () => {
    const { agent, sidebar, logs } = windowWith({ hostReadMs: 100 });
    await agent.refreshProject();
    sidebar.buildSessionList = () => new Promise<never>(() => {});
    expect((await agent.refreshProject()).sessions.map((s: any) => s.id)).toEqual(["s2", "s1", "s3"]);
    await agent.refreshProject();
    expect(logs.filter((line) => line.includes("did not come"))).toHaveLength(1);
    expect(logs.filter((line) => line.includes("could not list"))).toEqual([]);
  });
});
