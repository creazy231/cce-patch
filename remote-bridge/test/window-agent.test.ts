import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { classifyPending } from "../lib/answers.js";
import { toPhoneMessage } from "../lib/transcript.js";
import { AGENT_LIMITS, WindowAgent } from "../lib/window-agent.js";
import { FakeComms, addFakePanel, createFakeComms, createFakeProvider, createFakeVscode, createStoredStartupConfig, wireUsage, type FakeAuthStatus, type FakeProvider, type Message } from "./fake-extension";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits until `check` holds, looking every 10 ms; throws after `ms`. */
async function until(what: string, check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}
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
  /** The provider has Claude Code's usage meter (`panelUsageRelay`), wired to both comms. */
  usage?: boolean;
  usageReadMs?: number;
  /** How long a new channel in the sidebar must stay the newest before send(null) takes it; 0 here unless a test says otherwise. */
  sidebarSettleMs?: number;
  /** Runs before the agent instruments the comms, e.g. to put an instance method in front of the fake's. */
  before?: (comms: { sidebar: FakeComms; tab: FakeComms; provider: FakeProvider }) => void;
}

function windowWith(options: Options = {}) {
  const vscode = options.vscode ?? createFakeVscode();
  const provider = createFakeProvider({ usage: options.usage });
  const sessions = options.sessions ?? LISTED;
  const sidebar = createFakeComms({ sessions });
  const tab = createFakeComms({ sessions });
  sidebar.openChannel("c1", "s1");
  tab.openChannel("c2", "s2");
  provider.allComms.add(sidebar);
  provider.allComms.add(tab);
  if (options.usage) wireUsage(provider);
  options.before?.({ sidebar, tab, provider });
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
    usageReadMs: options.usageReadMs,
    sidebarSettleMs: options.sidebarSettleMs ?? 0,
  });
  const events: Array<[string, any]> = [];
  const projects: any[] = [];
  const attention: any[] = [];
  const usage: any[] = [];
  agent.on("session", (session: string, ev: any) => events.push([session, ev]));
  agent.on("project", (project: any) => projects.push(project));
  agent.on("attention", (ev: any) => attention.push(ev));
  agent.on("usage", (reading: any) => usage.push(reading));
  agent.start();
  return { vscode, provider, sidebar, tab, agent, events, projects, attention, usage, logs };
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

// The user keeps Claude Code in the sidebar.
const SIDEBAR = { "claudeCode.preferredLocation": "sidebar" };

/** A host that can open sessions in the sidebar (2.1.328+), for a user who keeps Claude Code there. */
function sidebarWindow(options: Options = {}) {
  return windowWith({
    ...options,
    vscode: options.vscode ?? createFakeVscode({ settings: { ...SIDEBAR } }),
    before: (parts) => {
      parts.provider.activateInSidebar = () => {};
      options.before?.(parts);
    },
  });
}

/** What the host does when a sidebar that hadn't started resolves: its webview's comms joins `allComms`. */
function bringUpSidebar(provider: FakeProvider): FakeComms {
  const comms = createFakeComms({ sessions: LISTED });
  provider.allComms.add(comms);
  return comms;
}

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

  // A turn that leaves work running in the background ends in a result like any other, and the CLI tells what still
  // runs in `background_tasks_changed` (shapes from a 2.1.330 CLI's stream). `done` is for a session that is done:
  // VS Code's dot green, nothing running, nothing open.
  describe("done waits until the session is done", () => {
    const dones = (attention: any[]) => attention.filter((ev) => ev.kind === "done");
    const tasksChanged = (session: string, uuid: string, tasks: Array<Record<string, any>>) => ({ type: "system", subtype: "background_tasks_changed", tasks, uuid, session_id: session });
    const agentTask = { task_id: "a845c61a5f2d86c55", run_id: "0mwt2afl1-cd8406b0", task_type: "local_agent", subagent_type: "general-purpose", description: "Background sleep-and-echo task" };
    const shellTask = { task_id: "bad009hyp", run_id: "0mwt29810-c93de79f", task_type: "local_bash", description: "Sleep 8 seconds then echo ready, in background" };
    const finished = (session: string, task: Record<string, any>, uuid: string) => ({
      type: "system",
      subtype: "task_notification",
      task_id: task.task_id,
      run_id: task.run_id,
      status: "completed",
      summary: `Background command "${task.description}" completed (exit code 0)`,
      uuid,
      session_id: session,
    });
    const turnEnd = (session: string, uuid: string, text: string, fields: Record<string, any> = {}) => ({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 2344,
      num_turns: 1,
      stop_reason: "end_turn",
      result: text,
      session_id: session,
      uuid,
      ...fields,
    });
    /** What the CLI ends a task notification with when it ran no turn for it. */
    const noTurn = (session: string, uuid: string, runId: string) => ({
      type: "result",
      subtype: "success",
      is_error: false,
      duration_ms: 5,
      num_turns: 0,
      stop_reason: null,
      result: "",
      origin: { kind: "task-notification", producer: "session-task", runId },
      session_id: session,
      uuid,
    });

    test("a turn that ends while a background agent works is not done; the turn after it is, once", async () => {
      const { sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [agentTask]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "launched", { num_turns: 2 }));
      expect(dones(attention)).toEqual([]); // VS Code's dot is still blue

      sidebar.emit("c1", finished("s1", agentTask, "n-1"));
      sidebar.emit("c1", tasksChanged("s1", "t-2", []));
      expect(dones(attention)).toEqual([]);
      sidebar.emit("c1", init("s1")); // the CLI takes up the agent's report
      sidebar.emit("c1", turnEnd("s1", "r-2", "complete", { origin: { kind: "peer", from: agentTask.task_id, handback: true } }));
      expect(dones(attention)).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 2344, text: "complete" }]);

      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", noTurn("s1", "r-3", agentTask.run_id)); // the agent's notification, with nothing left to do
      expect(dones(attention)).toHaveLength(1);
    });

    test("a background shell holds done back until the turn that follows it, though VS Code's dot leaves shells out", async () => {
      const { sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [shellTask]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "started", { num_turns: 2 }));
      sidebar.emit("c1", finished("s1", shellTask, "n-1"));
      sidebar.emit("c1", tasksChanged("s1", "t-2", [])); // the host stays busy until the next result
      expect(dones(attention)).toEqual([]);
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", turnEnd("s1", "r-2", "finished", { origin: { kind: "task-notification", producer: "session-task", runId: shellTask.run_id } }));
      expect(dones(attention)).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 2344, text: "finished" }]);
    });

    test.each(["local_agent", "local_workflow"])("an ambient %s keeps VS Code's dot blue while the host is at rest: done waits for the result after it", async (taskType) => {
      const { sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [{ task_id: "f1", run_id: "0mwt-f1", task_type: taskType, description: "/review", ambient: true }]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "forked"));
      expect(sidebar.channels.get("c1")!.atRest).toBe(true);
      expect(dones(attention)).toEqual([]);
      sidebar.emit("c1", tasksChanged("s1", "t-2", [])); // gone, but a turn may still take up its report
      expect(dones(attention)).toEqual([]);
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", turnEnd("s1", "r-2", "reported"));
      expect(dones(attention)).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 2344, text: "reported" }]);
    });

    test("whatever else keeps the host from rest holds done back too (a queued prompt, say)", async () => {
      const { sidebar, attention } = await listedWindow();
      let queued = true;
      Object.defineProperty(sidebar.channels.get("c1")!, "atRest", { get: () => !queued, set: () => {}, configurable: true });
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", turnEnd("s1", "r-1", "first"));
      expect(dones(attention)).toEqual([]);
      sidebar.emit("c1", init("s1"));
      queued = false;
      sidebar.emit("c1", turnEnd("s1", "r-2", "second", { is_error: true, subtype: "error_during_execution", duration_ms: 9 }));
      expect(dones(attention)).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: true, durationMs: 9, text: "second" }]);
    });

    test("without atRest (an older host), the task list decides, at the next result", async () => {
      const { sidebar, attention } = await listedWindow();
      Object.defineProperty(sidebar.channels.get("c1")!, "atRest", { get: () => undefined, set: () => {}, configurable: true });
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", turnEnd("s1", "r-1", "plain"));
      expect(dones(attention)).toHaveLength(1); // nothing in the background: done at once

      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [shellTask]));
      sidebar.emit("c1", turnEnd("s1", "r-2", "started"));
      sidebar.emit("c1", tasksChanged("s1", "t-2", []));
      expect(dones(attention)).toHaveLength(1);
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", turnEnd("s1", "r-3", "finished"));
      expect(dones(attention).at(-1)).toMatchObject({ kind: "done", text: "finished" });
      expect(dones(attention)).toHaveLength(2);

      sidebar.emit("c1", init("s1")); // an ambient task that is not an agent holds nothing back
      sidebar.emit("c1", tasksChanged("s1", "t-3", [{ task_id: "w1", run_id: "0mwt-w1", task_type: "monitor_ws", description: "watch", ambient: true }]));
      sidebar.emit("c1", turnEnd("s1", "r-4", "watching"));
      expect(dones(attention).at(-1)).toMatchObject({ kind: "done", text: "watching" });
    });

    test("a prompt still open when a turn ends: the session waits, it is not done", async () => {
      const { agent, sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      const asked = sidebar.requestPermission("c1", dialog);
      sidebar.emit("c1", turnEnd("s1", "r-1", "over to you"));
      expect(dones(attention)).toEqual([]);
      await agent.answer("s1", asked.requestId, { kind: "cancel" });
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", turnEnd("s1", "r-2", "all set"));
      expect(dones(attention)).toEqual([{ kind: "done", session: "s1", title: "Fix the flaky test", isError: false, durationMs: 2344, text: "all set" }]);
    });

    test("a channel that closes takes the done it owed with it: the session opened again starts afresh", async () => {
      const { sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [agentTask]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "launched"));
      sidebar.closeChannel("c1");
      sidebar.openChannel("c9", "s1");
      sidebar.emit("c9", init("s1"));
      sidebar.emit("c9", noTurn("s1", "r-2", agentTask.run_id));
      expect(dones(attention)).toEqual([]);
    });

    test("so does a channel the host drops without a word, once the next sweep finds out", async () => {
      const { agent, sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [agentTask]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "launched"));
      sidebar.channels.delete("c1");
      await agent.refreshProject();
      sidebar.openChannel("c9", "s1");
      sidebar.emit("c9", init("s1"));
      sidebar.emit("c9", noTurn("s1", "r-2", agentTask.run_id));
      expect(dones(attention)).toEqual([]);
    });

    test("a turn that ended while remote access was off, or before it was turned off, says nothing once it is on", async () => {
      const { agent, sidebar, attention } = await listedWindow();
      agent.setEnabled(false);
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [agentTask]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "while off"));
      agent.setEnabled(true);
      sidebar.emit("c1", tasksChanged("s1", "t-2", []));
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", noTurn("s1", "r-2", agentTask.run_id)); // the session is done now, but its turn ended while off
      expect(dones(attention)).toEqual([]);

      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-3", [agentTask]));
      sidebar.emit("c1", turnEnd("s1", "r-3", "before off"));
      agent.setEnabled(false);
      agent.setEnabled(true);
      sidebar.emit("c1", tasksChanged("s1", "t-4", []));
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", noTurn("s1", "r-4", agentTask.run_id));
      expect(dones(attention)).toEqual([]);
    });

    test("a session that /clear replaces on the channel keeps what it owed to itself", async () => {
      const { sidebar, attention } = await listedWindow();
      sidebar.emit("c1", init("s1"));
      sidebar.emit("c1", tasksChanged("s1", "t-1", [agentTask]));
      sidebar.emit("c1", turnEnd("s1", "r-1", "launched")); // s1 is not done
      sidebar.emit("c1", tasksChanged("s1", "t-2", []));
      sidebar.emit("c1", init("s-new")); // /clear: a new session on the same channel
      sidebar.emit("c1", turnEnd("s-new", "r-2", "cleared"));
      expect(dones(attention)).toEqual([expect.objectContaining({ kind: "done", session: "s-new", text: "cleared" })]);
    });
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
    tab.emit("c2", result("s2"));
    const next = tab.requestPermission("c2", bash);
    expect(attention.map((ev) => ev.kind)).toEqual(["done", "open", "waiting"]);
    expect(attention[0]).toMatchObject({ session: "s2", title: "Add dark mode" });
    expect(attention[2]).toMatchObject({ session: "s2", requestId: next.requestId, title: "Add dark mode" });
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
    const { sidebar, tab, attention } = await listedWindow();
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
    tab.emit("c2", { ...result("s2"), result: "R".repeat(500) }); // s1 still waits for its prompts: not done
    expect(attention.at(-1)).toMatchObject({ kind: "done", session: "s2", text: `${"R".repeat(140)}…` });
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
        message: {
          type: "user",
          uuid: sent.uuid,
          session_id: "",
          parent_tool_use_id: null,
          origin: { kind: "human" },
          message: { role: "user", content: [{ type: "text", text: "hi" }] },
        },
      },
    ]);
    await sidebar.flush();
    expect(events).toContainEqual(["s1", { t: "msg", message: expect.objectContaining({ uuid: sent.uuid, type: "user", isReplay: true }) }]);
    expect(sidebar.readerError).toBeUndefined();
  });

  test("a phone message carries origin human, as VS Code's typed ones do: Claude Code runs plugin-provided local commands only then", async () => {
    const { agent, sidebar } = windowWith();
    await agent.send("s1", "/compact");
    expect(sidebar.received[0].message.origin).toEqual({ kind: "human" });
    expect(sidebar.received[0].message.message.content).toEqual([{ type: "text", text: "/compact" }]);
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

  test("send(s3) (listed, no channel) opens it where the user keeps Claude Code and sends to its channel once it appears", async () => {
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
    expect(vscode.commands.calls).toEqual([editorOpen("s3", HONOR_LOCATION)]);
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
    expect(vscode.commands.calls).toEqual([editorOpen("s3", HONOR_LOCATION)]);
  });

  test("send(s3) for a user who keeps Claude Code in the sidebar: the sidebar resumes s3, and s1 there is left alone", async () => {
    const { agent, vscode, sidebar } = sidebarWindow();
    vscode.commands.onCommand = () => void setTimeout(() => sidebar.openChannel("c3", "s3", { pending: true }), 50);
    const sent = await agent.send("s3", "hi");
    expect(vscode.commands.calls).toEqual([editorOpen("s3", HONOR_LOCATION)]);
    expect(sent).toEqual({ session: "s3", uuid: expect.stringMatching(UUID) });
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c3"]);
    expect(sidebar.channels.get("c1")?.sessionId).toBe("s1");
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
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
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

// ---- where a new session opens: where the user keeps Claude Code -------------------------------------

describe("where a new session opens", () => {
  const tabOnOpen = (provider: FakeProvider) => () =>
    void setTimeout(() => {
      const opened = createFakeComms({ sessions: LISTED });
      opened.openChannel("c-new");
      provider.allComms.add(opened);
    }, 30);

  test("the sidebar takes the new session where the user keeps Claude Code, and the prompt goes there", async () => {
    const { agent, vscode, sidebar, tab } = sidebarWindow();
    vscode.commands.onCommand = () => void setTimeout(() => sidebar.openChannel("c-new"), 50);
    const sent = await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toMatch(/^s-\d+$/);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId!);
    expect(tab.received).toEqual([]);
  });

  // Seen in a real 2.1.330 sidebar: the start-up chat launches when the sidebar finishes booting, right before the new
  // session becomes active, and the webview closes it 51 ms later (an unused empty chat) before launching the new one.
  // Claude Code's folder-trust prompt held the host meanwhile, so the start-up chat's channel stayed in its maps.
  test("the sidebar's start-up chat, launched with the new session and closed by the webview, is never taken (even while the host is held)", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ sidebarSettleMs: 300, channelWaitMs: 2000 });
    vscode.commands.onCommand = () =>
      void setTimeout(async () => {
        sidebar.fromClient({ type: "launch_claude", channelId: "c-startup" });
        await sidebar.flush();
        const release = sidebar.holdReader(); // the first launch waits on the folder-trust prompt
        sidebar.fromClient({ type: "close_channel", channelId: "c-startup" });
        sidebar.fromClient({ type: "launch_claude", channelId: "c-new" });
        setTimeout(async () => {
          release(); // the folder is trusted: the host goes on
          await sidebar.flush();
          sidebar.promoteChannel("c-new");
        }, 400);
      }, 30);
    const sent = await agent.send(null, "new");
    expect(sidebar.received.filter((m) => m.type === "io_message").map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId!);
  });

  /** A host message to the webview: the agent looks at its waits again (as when the host answers the boot session list). */
  const look = (comms: FakeComms) => comms.send({ type: "request", channelId: "", requestId: "", request: { type: "visibility_changed", isVisible: true } });

  test("a start-up chat the agent looks at before the webview closes it (host not held) is kept from being taken by the settle alone", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ sidebarSettleMs: 300, channelWaitMs: 3000 });
    vscode.commands.onCommand = () =>
      void setTimeout(async () => {
        sidebar.fromClient({ type: "launch_claude", channelId: "c-startup" });
        await sidebar.flush();
        look(sidebar);
        setTimeout(async () => {
          sidebar.fromClient({ type: "close_channel", channelId: "c-startup" });
          sidebar.fromClient({ type: "launch_claude", channelId: "c-new" });
          await sidebar.flush();
          sidebar.promoteChannel("c-new");
        }, 100);
      }, 30);
    const sent = await agent.send(null, "new");
    expect(sidebar.received.filter((m) => m.type === "io_message").map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId!);
  });

  test("a start-up chat the webview closed but the host lists for longer than the settle is kept from being taken by the closing mark alone", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ sidebarSettleMs: 200, channelWaitMs: 4000 });
    vscode.commands.onCommand = () =>
      void setTimeout(async () => {
        sidebar.fromClient({ type: "launch_claude", channelId: "c-startup" });
        await sidebar.flush();
        const release = sidebar.holdReader();
        look(sidebar);
        setTimeout(() => {
          sidebar.fromClient({ type: "close_channel", channelId: "c-startup" });
          sidebar.fromClient({ type: "launch_claude", channelId: "c-new" });
        }, 50);
        setTimeout(async () => {
          release();
          await sidebar.flush();
          sidebar.promoteChannel("c-new");
        }, 1200);
      }, 30);
    const sent = await agent.send(null, "new");
    expect(sidebar.received.filter((m) => m.type === "io_message").map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId!);
  });

  // The start-up chat launches while the sidebar's first session list loads; the parked new session follows only
  // once that list is answered, which takes long in a project with many sessions.
  test("a booting sidebar's start-up chat is never taken while its session list is still loading, however long that takes", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ sidebarSettleMs: 300, channelWaitMs: 4000 });
    const list = sidebar.listSessions.bind(sidebar);
    sidebar.listSessions = async (entryPoint?: string) => {
      await sleep(900);
      return list(entryPoint);
    };
    vscode.commands.onCommand = () =>
      void setTimeout(async () => {
        sidebar.fromClient({ type: "request", channelId: "", requestId: "boot-list", request: { type: "list_sessions_request", entryPoint: "panel_boot" } });
        sidebar.fromClient({ type: "launch_claude", channelId: "c-startup" });
        await until("the boot list's answer", () => sidebar.sent.some((m) => m.type === "response" && m.requestId === "boot-list"));
        sidebar.fromClient({ type: "close_channel", channelId: "c-startup" });
        sidebar.fromClient({ type: "launch_claude", channelId: "c-new" });
        await sidebar.flush();
        sidebar.promoteChannel("c-new");
      }, 30);
    const sent = await agent.send(null, "new");
    expect(sidebar.received.filter((m) => m.type === "io_message").map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(sidebar.channels.get("c-new")!.sessionId!);
  });

  // In the sidebar, the session that becomes active ends every other unused empty chat, and the phone's session
  // counts as unused until its Claude process has started and replayed the prompt.
  test("while a phone session is still starting in the sidebar, the next new session opens in a tab, so the first keeps its prompt", async () => {
    const { agent, vscode, sidebar, provider } = sidebarWindow({ channelWaitMs: 3000 });
    let sidebarOpens = 0;
    let tab: FakeComms | undefined;
    vscode.commands.onCommand = (_id, args) => {
      if (args[5]?.programmatic === "honor-preferred-location") {
        const n = ++sidebarOpens;
        // the first one's Claude is still starting (launching, no name); later ones start at once
        setTimeout(() => (n === 1 ? sidebar.openChannel("c-first", undefined, { pending: true }) : sidebar.openChannel(`c-side-${n}`)), 30);
      } else {
        setTimeout(() => {
          tab = createFakeComms({ sessions: LISTED });
          tab.openChannel("c-tab");
          provider.allComms.add(tab);
        }, 30);
      }
    };
    const first = agent.send(null, "first");
    await until("the first prompt", () => sidebar.received.some((m) => m.type === "io_message"));
    const second = await agent.send(null, "second");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION), editorOpen(undefined, PIN_TO_PANEL)]);
    expect(tab!.received.filter((m) => m.type === "io_message").map((m) => m.channelId)).toEqual(["c-tab"]);
    expect(second.session).toBe(tab!.channels.get("c-tab")!.sessionId!);
    sidebar.promoteChannel("c-first"); // the first session's Claude is up, and names it
    expect((await first).session).toBe(sidebar.channels.get("c-first")!.sessionId!);
    await agent.send(null, "third"); // nothing is starting any more: the sidebar again
    expect(vscode.commands.calls.at(-1)).toEqual(editorOpen(undefined, HONOR_LOCATION));
  });

  test("while a phone session is still starting in the sidebar, waking or opening another session goes to a tab", async () => {
    const { agent, vscode, sidebar, provider } = sidebarWindow({ channelWaitMs: 3000 });
    let firstOpened = false;
    vscode.commands.onCommand = (_id, args) => {
      const [session, , , , , options] = args;
      if (session === undefined && options?.programmatic === "honor-preferred-location" && !firstOpened) {
        firstOpened = true;
        setTimeout(() => sidebar.openChannel("c-first", undefined, { pending: true }), 30);
      }
      if (session === "s3")
        setTimeout(() => {
          const opened = createFakeComms({ sessions: LISTED });
          opened.openChannel("c3", "s3", { pending: true });
          provider.allComms.add(opened);
        }, 30);
    };
    const first = agent.send(null, "first");
    await until("the first prompt", () => sidebar.received.some((m) => m.type === "io_message"));
    await agent.send("s3", "hi");
    await agent.open("s2");
    await agent.openClaude();
    expect(vscode.commands.calls.slice(1)).toEqual([editorOpen("s3", PIN_TO_PANEL), editorOpen("s2", PIN_TO_PANEL), editorOpen(undefined, PIN_TO_PANEL)]);
    sidebar.promoteChannel("c-first");
    await first;
  });

  test("a sidebar that hasn't started comes up through editor.open, and its start-up chat is never taken", async () => {
    const { agent, vscode, provider } = sidebarWindow({ sidebarSettleMs: 300 });
    let up: FakeComms | undefined;
    vscode.commands.onCommand = () =>
      void setTimeout(() => {
        up = bringUpSidebar(provider);
        up.fromClient({ type: "launch_claude", channelId: "c-startup" });
        setTimeout(() => {
          up!.fromClient({ type: "close_channel", channelId: "c-startup" });
          up!.fromClient({ type: "launch_claude", channelId: "c-new" });
          void up!.flush().then(() => up!.promoteChannel("c-new"));
        }, 50);
      }, 30);
    const sent = await agent.send(null, "new");
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]); // editor.open reveals the sidebar itself
    expect(up!.received.filter((m) => m.type === "io_message").map((m) => m.channelId)).toEqual(["c-new"]);
    expect(sent.session).toBe(up!.channels.get("c-new")!.sessionId!);
  });

  test("of two new channels in the sidebar, the newer one is taken once it has settled", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ sidebarSettleMs: 300 });
    vscode.commands.onCommand = () =>
      void setTimeout(() => {
        sidebar.openChannel("c-first");
        setTimeout(() => sidebar.openChannel("c-second"), 100);
      }, 30);
    await agent.send(null, "new");
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-second"]);
  });

  test("an editor.open that fails rejects open_failed at once, and nothing is sent", async () => {
    const { agent, vscode, sidebar, tab, logs } = sidebarWindow({ channelWaitMs: 5000 });
    vscode.commands.onCommand = () => {
      throw new Error("command 'claudeVSCodeSidebarSecondary.focus' not found");
    };
    const started = Date.now();
    await expect(agent.send(null, "new")).rejects.toThrow("open_failed");
    expect(Date.now() - started).toBeLessThan(1000);
    expect([...sidebar.received, ...tab.received]).toEqual([]);
    expect(logs.some((line) => line.includes("not found"))).toBe(true);
  });

  test("no settling where the host can't open sessions in the sidebar, or where the user keeps tabs: the new channel is taken at once", async () => {
    const olderHost = windowWith({ vscode: createFakeVscode({ settings: { ...SIDEBAR } }), sidebarSettleMs: 1000 });
    const keepsTabs = windowWith({ before: ({ provider }) => void (provider.activateInSidebar = () => {}), sidebarSettleMs: 1000 });
    for (const { agent, vscode, provider } of [olderHost, keepsTabs]) {
      vscode.commands.onCommand = tabOnOpen(provider);
      const started = Date.now();
      await agent.send(null, "new");
      expect(Date.now() - started).toBeLessThan(900);
      expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
    }
  });

  // The plan's Review Focus 1, 3 and 5.

  test("an empty chat the sidebar shows with its own Claude process is left alone: the prompt goes to the new session", async () => {
    const { agent, vscode, sidebar } = sidebarWindow({ before: (parts) => void parts.sidebar.openChannel("c-blank") });
    vscode.commands.onCommand = () => void setTimeout(() => sidebar.openChannel("c-new"), 50);
    await agent.send(null, "new");
    expect(sidebar.received.map((m) => m.channelId)).toEqual(["c-new"]);
  });

  test("the preferred location is read at each send: a switch to tabs while VS Code runs counts at once", async () => {
    const { agent, vscode, provider } = sidebarWindow({ sidebarSettleMs: 1000 });
    vscode.settings["claudeCode.preferredLocation"] = "panel";
    vscode.commands.onCommand = tabOnOpen(provider);
    const started = Date.now();
    await agent.send(null, "new");
    expect(Date.now() - started).toBeLessThan(900); // no settling: a tab's channel is taken at once
  });

  test("a sidebar that never comes up rejects timeout within channelWaitMs", async () => {
    const { agent, vscode } = sidebarWindow({ channelWaitMs: 400 });
    const started = Date.now();
    await expect(agent.send(null, "new")).rejects.toThrow("timeout");
    expect(Date.now() - started).toBeLessThan(900);
    expect(vscode.commands.calls).toEqual([editorOpen(undefined, HONOR_LOCATION)]);
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

// ---- usage: Claude Code's usage meter (the provider's panelUsageRelay) ------------------------------

describe("usage", () => {
  const W = { utilization: 0.5, resetsAt: 2_000_000_000 };
  const WEEK = { utilization: 0.1, resetsAt: 2_000_100_000 };
  const relayOf = (provider: FakeProvider) => provider.panelUsageRelay!;
  const usageSends = (comms: FakeComms) => comms.sent.filter((m) => m.type === "request" && m.request?.type === "panel_usage_update");

  /** A query that answers the usage read with `rate_limits`, and records what it was called with. */
  function usageQuery(rateLimits: unknown) {
    const calls: unknown[] = [];
    return {
      calls,
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options?: unknown) => {
        calls.push(options);
        return { rate_limits: rateLimits };
      },
    };
  }

  test("numbers found at start are the reading, without at", () => {
    const { agent, usage } = windowWith({
      usage: true,
      now: () => 5_000,
      before: ({ provider }) => {
        relayOf(provider).merged = { five_hour: W };
      },
    });
    expect(agent.usageReading()).toEqual({ supported: true, fiveHour: W });
    expect(usage).toEqual([]);
  });

  test("a real update becomes the reading with at, and emits once", () => {
    const { provider, sidebar, tab, usage } = windowWith({ usage: true, now: () => 5_000 });
    relayOf(provider).broadcast(provider.allComms, { five_hour: W, seven_day: WEEK });
    expect(usage).toEqual([{ supported: true, fiveHour: W, week: WEEK, at: 5_000 }]);
    expect(usageSends(sidebar)).toHaveLength(1);
    expect(usageSends(tab)).toHaveLength(1);
  });

  test("a seed re-send changes nothing", () => {
    let t = 5_000;
    const { agent, provider, sidebar, usage } = windowWith({ usage: true, now: () => t });
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    t = 9_000;
    relayOf(provider).seed(sidebar);
    expect(usageSends(sidebar)).toHaveLength(2);
    expect(usage).toHaveLength(1);
    expect(agent.usageReading().at).toBe(5_000);
  });

  test("an update with the same numbers moves at", () => {
    let t = 5_000;
    const { provider, usage } = windowWith({ usage: true, now: () => t });
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    t = 9_000;
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    expect(usage).toEqual([
      { supported: true, fiveHour: W, at: 5_000 },
      { supported: true, fiveHour: W, at: 9_000 },
    ]);
  });

  test("a logout's null is noticed at the next refreshProject", async () => {
    const { agent, provider, usage } = windowWith({ usage: true, now: () => 5_000 });
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    relayOf(provider).merged = null; // the host's onLogout: nothing is sent
    await agent.refreshProject();
    expect(usage.at(-1)).toEqual({ supported: true });
  });

  test("without a relay, usage is unsupported", async () => {
    const { agent } = windowWith();
    expect(agent.usageReading()).toEqual({ supported: false });
    expect(await agent.refreshUsage()).toEqual({ refreshed: false, reason: "not_supported", reading: { supported: false } });
  });

  test("refreshUsage reads through a running channel", async () => {
    const { agent, sidebar } = windowWith({ usage: true });
    const query = usageQuery({ five_hour: { utilization: 42, resets_at: "2033-05-18T03:33:20Z" } });
    sidebar.channels.get("c1")!.query = query;
    const result = await agent.refreshUsage();
    expect(result.refreshed).toBe(true);
    expect(result.reading.fiveHour).toEqual({ utilization: 0.42, resetsAt: 2_000_000_000 });
    expect(query.calls).toEqual([{ skipBehaviors: true }]);
  });

  test("a channel at rest is preferred", async () => {
    const { agent, sidebar, tab } = windowWith({ usage: true });
    const busy = usageQuery({ five_hour: { utilization: 10, resets_at: null } });
    const idle = usageQuery({ five_hour: { utilization: 20, resets_at: null } });
    const c1 = sidebar.channels.get("c1")!;
    const c2 = tab.channels.get("c2")!;
    c1.atRest = false;
    c1.query = busy;
    c2.atRest = true;
    c2.query = idle;
    const result = await agent.refreshUsage();
    expect(busy.calls).toEqual([]);
    expect(idle.calls).toHaveLength(1);
    expect(result).toMatchObject({ refreshed: true, reading: { fiveHour: { utilization: 0.2 } } });
  });

  test("no running channel: no_session", async () => {
    const { agent } = windowWith({ usage: true });
    expect(await agent.refreshUsage()).toEqual({ refreshed: false, reason: "no_session", reading: { supported: true } });
  });

  test("a read that never answers ends after usageReadMs", async () => {
    const { agent, sidebar } = windowWith({ usage: true, usageReadMs: 50 });
    sidebar.usageReadTimeoutMs = 200; // the host's own bound, so nothing outlives the test
    sidebar.channels.get("c1")!.query = { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => new Promise(() => {}) };
    const started = Date.now();
    const result = await agent.refreshUsage();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result).toEqual({ refreshed: false, reading: { supported: true } });
  });

  test("a read without numbers is not refreshed", async () => {
    const { agent, sidebar } = windowWith({ usage: true });
    sidebar.channels.get("c1")!.query = usageQuery(null);
    const result = await agent.refreshUsage();
    expect(result.refreshed).toBe(false);
  });

  // ---- the account the numbers belong to: Claude Code's own `claude auth status` answer ----

  const login = (email: string): FakeAuthStatus => ({ authMethod: "claudeai", email, subscriptionType: "team" });

  test("the reading names the account Claude Code is signed in to", () => {
    const { provider, sidebar, tab, usage } = windowWith({ usage: true, now: () => 5_000 });
    sidebar.answerAuthStatus(login("ada@example.com"));
    tab.answerAuthStatus(login("ada@example.com"));
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    expect(usage).toEqual([{ supported: true, fiveHour: W, at: 5_000, account: "ada@example.com" }]);
  });

  test("an account learned after the numbers is noticed at the next refreshProject, and at stays", async () => {
    let t = 5_000;
    const { agent, provider, sidebar, usage } = windowWith({ usage: true, now: () => t });
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    t = 9_000;
    sidebar.answerAuthStatus(login("ada@example.com"));
    await agent.refreshProject();
    expect(usage).toEqual([
      { supported: true, fiveHour: W, at: 5_000 },
      { supported: true, fiveHour: W, at: 5_000, account: "ada@example.com" },
    ]);
  });

  test("a webview whose Claude Code hasn't answered yet is passed over", () => {
    const { agent, tab } = windowWith({ usage: true });
    tab.answerAuthStatus(login("ada@example.com")); // the sidebar's hasn't answered
    expect(agent.usageReading()).toEqual({ supported: true, account: "ada@example.com" });
  });

  // An account change, as the host makes it: the numbers go and every webview's answer is forgotten in one go,
  // then `claude auth status` answers again. The old account must never be named next to the new one's numbers.
  const W_B = { utilization: 0.05, resetsAt: 2_000_000_500 };

  test("a switch outside the window: no numbers and no account, then the new account, then its numbers", async () => {
    let t = 5_000;
    const { agent, provider, sidebar, tab, usage } = windowWith({ usage: true, now: () => t });
    sidebar.answerAuthStatus(login("ada@example.com"));
    tab.answerAuthStatus(login("ada@example.com"));
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    provider.refreshEveryHost(); // say, another account signed in from a terminal
    await agent.refreshProject();
    sidebar.answerAuthStatus(login("bob@example.com"));
    await agent.refreshProject();
    t = 9_000;
    relayOf(provider).broadcast(provider.allComms, { five_hour: W_B });
    expect(usage).toEqual([
      { supported: true, fiveHour: W, at: 5_000, account: "ada@example.com" },
      { supported: true },
      { supported: true, account: "bob@example.com" },
      { supported: true, fiveHour: W_B, at: 9_000, account: "bob@example.com" },
    ]);
  });

  test("the new account's numbers before Claude Code knows the account come without one, not with the old", () => {
    let t = 5_000;
    const { provider, sidebar, tab, usage } = windowWith({ usage: true, now: () => t });
    sidebar.answerAuthStatus(login("ada@example.com"));
    tab.answerAuthStatus(login("ada@example.com"));
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    provider.refreshEveryHost();
    t = 9_000;
    relayOf(provider).broadcast(provider.allComms, { five_hour: W_B }); // before `claude auth status` answers again
    expect(usage.at(-1)).toEqual({ supported: true, fiveHour: W_B, at: 9_000 });
  });

  test("a login in this window names the new account, without the old numbers", () => {
    const { agent, provider, sidebar, tab } = windowWith({ usage: true, now: () => 5_000 });
    sidebar.answerAuthStatus(login("ada@example.com"));
    tab.answerAuthStatus(login("ada@example.com"));
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    tab.answerAuthStatus(login("bob@example.com")); // the tab logged in and asked again,
    provider.notifyLogin(tab); // then the provider drops the numbers and the others' answers
    expect(agent.usageReading()).toEqual({ supported: true, account: "bob@example.com" });
  });

  test("signing out takes the numbers and the account away", async () => {
    const { agent, provider, sidebar, tab, usage } = windowWith({ usage: true, now: () => 5_000 });
    sidebar.answerAuthStatus(login("ada@example.com"));
    tab.answerAuthStatus(login("ada@example.com"));
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    provider.notifyLogout();
    sidebar.answerAuthStatus(undefined); // asked again: signed out
    tab.answerAuthStatus(undefined);
    await agent.refreshProject();
    expect(usage).toEqual([{ supported: true, fiveHour: W, at: 5_000, account: "ada@example.com" }, { supported: true }]);
  });

  test("without cliReportedAccountEmail (an older extension), or when it throws, the numbers still come", () => {
    const { provider, usage } = windowWith({
      usage: true,
      now: () => 5_000,
      before: ({ sidebar, tab }) => {
        (sidebar as any).cliReportedAccountEmail = undefined;
        (tab as any).cliReportedAccountEmail = () => {
          throw new Error("not yet");
        };
      },
    });
    relayOf(provider).broadcast(provider.allComms, { five_hour: W });
    expect(usage).toEqual([{ supported: true, fiveHour: W, at: 5_000 }]);
  });
});

// ---- slash commands: the list VS Code's `/` menu shows (the window's config, read from 2.1.330) -----------

describe("commands", () => {
  const A = [{ name: "compact", description: "Compact" }, { name: "init" }];
  /** The agent read what the host holds and never made it load a config (that can start a Claude process). */
  const noLoads = (...all: FakeComms[]) => expect(all.map((comms) => comms.configLoads)).toEqual(all.map(() => 0));

  test("the settled config: VS Code's list", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.settledConfig = { commands: A };
    expect(await agent.commands()).toEqual([{ name: "compact", description: "Compact" }, { name: "init" }]);
    noLoads(sidebar, tab);
  });

  test("the comms for the window's folder comes first", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.configCwd = "/elsewhere";
    sidebar.settledConfig = { commands: [{ name: "other" }] };
    tab.configCwd = "/work/demo";
    tab.settledConfig = { commands: A };
    expect((await agent.commands()).map((c) => c.name)).toEqual(["compact", "init"]);
    noLoads(sidebar, tab);
  });

  test("the stored copy while the live list loads", async () => {
    const { agent, sidebar, tab } = windowWith();
    const asked: string[] = [];
    sidebar.storedStartupConfig = {
      read: (cwd: string) => {
        asked.push(cwd);
        return cwd === "/work/demo" ? { commands: [{ name: "stored" }] } : undefined;
      },
    };
    expect(await agent.commands()).toEqual([{ name: "stored" }]);
    expect(asked).toEqual(["/work/demo"]);
    noLoads(sidebar, tab);
  });

  test("a running session's supportedCommands()", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.channels.get("c1")!.query = { supportedCommands: async () => [{ name: "live" }] };
    expect(await agent.commands()).toEqual([{ name: "live" }]);
    noLoads(sidebar, tab);
  });

  test("the pending config promise", async () => {
    const { agent, sidebar, tab } = windowWith();
    tab.config = Promise.resolve({ commands: [{ name: "later" }] });
    expect(await agent.commands()).toEqual([{ name: "later" }]);
    noLoads(sidebar, tab);
  });

  test("the sources in order: settled, stored, a running session's, the pending config", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.settledConfig = { commands: [{ name: "settled" }] };
    sidebar.storedStartupConfig = { read: () => ({ commands: [{ name: "stored" }] }) };
    tab.channels.get("c2")!.query = { supportedCommands: async () => [{ name: "live" }] };
    tab.config = Promise.resolve({ commands: [{ name: "pending" }] });
    const names = async () => (await agent.commands()).map((c) => c.name);
    expect(await names()).toEqual(["settled"]);
    sidebar.settledConfig = { output_style: "default" }; // a config without a list is no list
    expect(await names()).toEqual(["stored"]);
    sidebar.storedStartupConfig = undefined;
    expect(await names()).toEqual(["live"]);
    tab.channels.get("c2")!.query = {};
    expect(await names()).toEqual(["pending"]);
    noLoads(sidebar, tab);
  });

  test("a supportedCommands() that fails moves on to the pending config", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.channels.get("c1")!.query = { supportedCommands: async () => Promise.reject(new Error("closed")) };
    tab.config = Promise.resolve({ commands: [{ name: "pending" }] });
    expect(await agent.commands()).toEqual([{ name: "pending" }]);
  });

  test("a host read that hangs: [] after hostReadMs", async () => {
    const { agent, sidebar, tab } = windowWith({ hostReadMs: 50 });
    sidebar.channels.get("c1")!.query = { supportedCommands: () => new Promise(() => {}) };
    const late = new Promise((resolve) => setTimeout(() => resolve("late"), 1000));
    expect(await Promise.race([agent.commands(), late])).toEqual([]);
    noLoads(sidebar, tab);
  });

  test("no comms: []", async () => {
    expect(await new WindowAgent({ provider: { allComms: new Set() }, vscode: {} }).commands()).toEqual([]);
    expect(await new WindowAgent({}).commands()).toEqual([]);
  });

  test("the copy kept for any folder (always without commands) is no list: a running session's list wins", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.storedStartupConfig = createStoredStartupConfig(); // no copy for this folder: read() gives the any-folder copy
    tab.channels.get("c2")!.query = { supportedCommands: async () => [{ name: "live" }] };
    expect(await agent.commands()).toEqual([{ name: "live" }]);
    noLoads(sidebar, tab);
  });

  test("an empty list is no list, from any source: the next one is asked", async () => {
    const { agent, sidebar, tab } = windowWith();
    sidebar.settledConfig = { commands: [] };
    tab.config = Promise.resolve({ commands: [{ name: "pending" }] });
    expect(await agent.commands()).toEqual([{ name: "pending" }]);
  });

  test("names as VS Code shows them: a shared name takes its plugin-prefixed alias", async () => {
    const { agent, sidebar } = windowWith();
    sidebar.settledConfig = { commands: [{ name: "deploy" }, { name: "deploy", plugin: "ops", aliases: ["ops:deploy"] }] };
    expect((await agent.commands()).map((c) => c.name)).toEqual(["deploy", "ops:deploy"]);
  });
});

// ---- Claude in Chrome auto-accept (the Connection tab's switch) --------------------------------------

// A tool prompt for one of Claude in Chrome's tools, as the host sends it; its "always" would write the project's
// local settings.
const chromeNavigate = {
  type: "tool_permission_request",
  toolName: "mcp__claude-in-chrome__navigate",
  inputs: { url: "https://example.com/docs", tabId: 7 },
  suggestions: [{ type: "addRules", rules: [{ toolName: "mcp__claude-in-chrome__navigate" }], behavior: "allow", destination: "localSettings" }],
  toolUseId: "toolu_05",
  defaultToNo: false,
  suppressAlwaysAllowRule: false,
};
// The site card: Chrome's extension wants the site approved; "always" allows the site for this session. Its reason
// ("Claude in Chrome action on example.com") is of type "other", which the host does not pass on.
const siteForSession = { type: "addRules", rules: [{ toolName: "ClaudeInChromeDomain", ruleContent: "example.com" }], behavior: "allow", destination: "session" };
const chromeSite = {
  ...chromeNavigate,
  toolName: "mcp__claude-in-chrome__computer",
  inputs: { action: "left_click", coordinate: [10, 20], tabId: 7 },
  suggestions: [siteForSession],
  toolUseId: "toolu_06",
};
const allowOnce = (request: { inputs: object }) => ({ type: "tool_permission_response", result: { behavior: "allow", updatedInput: request.inputs, updatedPermissions: [] } });
const reachedVsCode = (comms: FakeComms, requestId: string) => comms.sent.some((message) => message.type === "request" && message.requestId === requestId);

describe("Claude in Chrome auto-accept", () => {
  test("on: a Claude in Chrome tool prompt gets a plain allow; neither VS Code nor the phone sees it", async () => {
    const { agent, sidebar, events, attention, logs } = windowWith();
    agent.chromeAutoAccept = () => true;
    const asked = sidebar.requestPermission("c1", chromeNavigate);
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(false);
    expect(await asked).toEqual(allowOnce(chromeNavigate));
    expect(sidebar.received).toEqual([{ type: "response", requestId: asked.requestId, response: allowOnce(chromeNavigate) }]);
    expect(pendingEvents(events)).toEqual([]);
    expect(attention).toEqual([]);
    expect(logs.filter((line) => line.includes("Claude in Chrome"))).toEqual(["window agent: Claude in Chrome auto-accept allowed mcp__claude-in-chrome__navigate"]);
    await sidebar.flush();
    expect(sidebar.logger.lines.filter((line) => line.includes("No handler"))).toEqual([]);
  });

  test("on: the site card is answered with its always, so the site is allowed for the rest of the session", async () => {
    const { agent, sidebar, events, logs } = windowWith();
    agent.chromeAutoAccept = () => true;
    const asked = sidebar.requestPermission("c1", chromeSite);
    expect(await asked).toEqual({ type: "tool_permission_response", result: { behavior: "allow", updatedInput: chromeSite.inputs, updatedPermissions: [siteForSession] } });
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(false);
    expect(pendingEvents(events)).toEqual([]);
    expect(logs).toContain("window agent: Claude in Chrome auto-accept allowed mcp__claude-in-chrome__computer and example.com for the session");
  });

  test("on: an always for several sites is taken; one that allows a whole tool for the session is not", async () => {
    const { agent, sidebar } = windowWith();
    agent.chromeAutoAccept = () => true;
    const sites = { ...siteForSession, rules: [{ toolName: "ClaudeInChromeDomain", ruleContent: "example.com" }, { toolName: "ClaudeInChromeDomain", ruleContent: "example.org" }] };
    const both = sidebar.requestPermission("c1", { ...chromeSite, suggestions: [sites] });
    expect(await both).toEqual({ type: "tool_permission_response", result: { behavior: "allow", updatedInput: chromeSite.inputs, updatedPermissions: [sites] } });
    // The tool prompt's session "always" (what VS Code offers in auto mode) would outlast the switch: a plain allow.
    const toolForSession = { type: "addRules", rules: [{ toolName: "mcp__claude-in-chrome__tabs_context_mcp" }], behavior: "allow", destination: "session" };
    const tool = { ...chromeNavigate, toolName: "mcp__claude-in-chrome__tabs_context_mcp", inputs: { createIfEmpty: true }, suggestions: [toolForSession] };
    expect(await sidebar.requestPermission("c1", tool)).toEqual(allowOnce(tool));
  });

  test("on: a prompt Claude Code wants a person to answer reaches VS Code and the phone", async () => {
    const { agent, sidebar, events } = windowWith();
    agent.chromeAutoAccept = () => true;
    // defaultToNo: the auto-mode safety check blocked the action, had no verdict, or another safety check asks;
    // reason: a safety check's own words (a file upload, say); hookReason: a hook asked; personOnly, should a host pass it on.
    const flags: Array<Record<string, unknown>> = [
      { defaultToNo: true, suppressAlwaysAllowRule: true, suggestions: [] },
      { personOnly: true },
      { reason: "Claude wants to upload a file to example.com — approval must come from the user" },
      { hookReason: "A PreToolUse hook asked for confirmation" },
    ];
    const asked = flags.flatMap((flag) => [chromeNavigate, chromeSite].map((request) => sidebar.requestPermission("c1", { ...request, ...flag })));
    for (const one of asked) expect(reachedVsCode(sidebar, one.requestId)).toBe(true);
    await sidebar.flush();
    expect(sidebar.received).toEqual([]);
    expect(pendingEvents(events).at(-1)?.[1].pending.map((p: any) => p.requestId)).toEqual(asked.map((one) => one.requestId));
  });

  test("on: a prompt the host withdrew before the answer went out is neither answered nor shown", async () => {
    const { agent, sidebar, logs } = windowWith();
    agent.chromeAutoAccept = () => true;
    const controller = new AbortController();
    const asked = sidebar.requestPermission("c1", chromeNavigate, controller.signal);
    asked.catch(() => {});
    controller.abort(); // the CLI took the prompt back (a hook answered it, the turn was stopped) at once
    await sleep(0);
    await sidebar.flush();
    expect(sidebar.received).toEqual([]);
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(false);
    expect(sidebar.logger.lines.filter((line) => line.includes("No handler"))).toEqual([]);
    expect(logs.filter((line) => line.includes("auto-accept allowed"))).toEqual([]);
  });

  test("an always that does more than allow Claude in Chrome for the session gives way to a plain allow", async () => {
    const { agent, sidebar } = windowWith();
    agent.chromeAutoAccept = () => true;
    const variants: Array<Record<string, any>> = [
      { suggestions: [siteForSession, { type: "setMode", mode: "acceptEdits", destination: "session" }] },
      { suggestions: [{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf:*" }], behavior: "allow", destination: "session" }] },
      { suggestions: [{ ...siteForSession, rules: [{ toolName: "ClaudeInChromeDomain", ruleContent: "example.com" }, { toolName: "Bash" }] }] },
      { suggestions: [{ ...siteForSession, rules: [{ toolName: "ClaudeInChromeDomain" }] }] },
      { suggestions: [{ ...siteForSession, rules: [{ toolName: "ClaudeInChromeDomain", ruleContent: "" }] }] },
      { suggestions: [{ ...siteForSession, rules: [] }] },
      { suggestions: [{ ...siteForSession, behavior: "deny" }] },
      { suggestions: [{ ...siteForSession, destination: "userSettings" }] },
      { suggestions: [{ ...siteForSession, type: "replaceRules" }] },
      { suggestions: [null] },
      { suppressAlwaysAllowRule: true },
      { plugin: "browser-tools" },
    ];
    for (const variant of variants) {
      const request = { ...chromeSite, ...variant };
      const asked = sidebar.requestPermission("c1", request);
      expect({ variant, answer: await asked }).toEqual({ variant, answer: allowOnce(request) });
    }
  });

  test("off: without the switch, with it off, or with one that fails, the prompt reaches VS Code and the phone as before", async () => {
    const switches: Array<(() => unknown) | null | undefined> = [
      undefined,
      null,
      () => false,
      () => "yes",
      () => {
        throw new Error("the state file is gone");
      },
    ];
    for (const chromeAutoAccept of switches) {
      const { agent, sidebar, events } = windowWith();
      if (chromeAutoAccept !== undefined) (agent as any).chromeAutoAccept = chromeAutoAccept;
      const asked = sidebar.requestPermission("c1", chromeSite);
      expect(reachedVsCode(sidebar, asked.requestId)).toBe(true);
      await sidebar.flush();
      expect(sidebar.received).toEqual([]);
      expect(pendingEvents(events).at(-1)?.[1].pending.map((p: any) => p.requestId)).toEqual([asked.requestId]);
    }
  });

  test("on: every other prompt is left alone", async () => {
    const { agent, sidebar, tab, events } = windowWith();
    agent.chromeAutoAccept = () => true;
    const others = [
      bash,
      edit,
      plan,
      { ...chromeNavigate, toolName: "mcp__claude-in-chrome-x__navigate" },
      { ...chromeNavigate, toolName: "mcp__claude-in-chrome__x__run_shell" }, // a server named claude-in-chrome__x
      { ...chromeNavigate, toolName: "mcp__claude-in-chrome__" },
      { ...chromeNavigate, toolName: "mcp__claude-in-chrome" },
      { ...chromeNavigate, toolName: "Mcp__claude-in-chrome__navigate" },
      { ...chromeNavigate, type: undefined },
      { type: "tool_permission_request", toolName: "AskUserQuestion", inputs: { questions: [{ question: "Which?", options: [] }] }, suggestions: [] },
    ];
    const asked = others.map((request) => sidebar.requestPermission("c1", request));
    const dialogAsked = tab.requestPermission("c2", dialog);
    for (const one of asked) expect(reachedVsCode(sidebar, one.requestId)).toBe(true);
    expect(reachedVsCode(tab, dialogAsked.requestId)).toBe(true);
    await sidebar.flush();
    expect(sidebar.received).toEqual([]);
    expect(tab.received).toEqual([]);
    const pendingIds = (session: string) => pendingEvents(events).filter(([s]) => s === session).at(-1)?.[1].pending.map((p: any) => p.requestId);
    expect(pendingIds("s1")).toEqual(asked.map((one) => one.requestId));
    expect(pendingIds("s2")).toEqual([dialogAsked.requestId]);
  });

  test("the switch is read as each prompt comes: turned off, the next one is VS Code's again", async () => {
    let on = true;
    const { agent, sidebar } = windowWith();
    agent.chromeAutoAccept = () => on;
    const first = sidebar.requestPermission("c1", chromeNavigate);
    expect(await first).toEqual(allowOnce(chromeNavigate));
    on = false;
    const second = sidebar.requestPermission("c1", chromeNavigate);
    expect(reachedVsCode(sidebar, second.requestId)).toBe(true);
    on = true;
    const third = sidebar.requestPermission("c1", chromeNavigate);
    expect(reachedVsCode(sidebar, third.requestId)).toBe(false);
    expect(await third).toEqual(allowOnce(chromeNavigate));
  });

  test("an answer that can't go out: the prompt reaches VS Code and the phone after all", async () => {
    const { agent, sidebar, events, logs } = windowWith({
      before: ({ sidebar }) => {
        const fromClient = sidebar.fromClient.bind(sidebar);
        (sidebar as any).fromClient = (message: Message) => {
          if (message.type === "response") throw new Error("the host went away");
          return fromClient(message);
        };
      },
    });
    agent.chromeAutoAccept = () => true;
    const asked = sidebar.requestPermission("c1", chromeNavigate);
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(false);
    await sleep(0);
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(true);
    expect(pendingEvents(events).at(-1)?.[1].pending.map((p: any) => p.requestId)).toEqual([asked.requestId]);
    expect(logs.some((line) => line.includes("could not answer a Claude in Chrome prompt") && line.includes("the host went away"))).toBe(true);
  });

  test("an answer that fails once the host no longer waits for it: nothing is shown again", async () => {
    const { agent, sidebar, events } = windowWith({
      before: ({ sidebar }) => {
        const fromClient = sidebar.fromClient.bind(sidebar);
        (sidebar as any).fromClient = (message: Message) => {
          if (message.type !== "response") return fromClient(message);
          sidebar.outstandingRequests.delete(message.requestId); // the host let go of it, then failed
          throw new Error("the reader stopped");
        };
      },
    });
    agent.chromeAutoAccept = () => true;
    const asked = sidebar.requestPermission("c1", chromeNavigate);
    await sleep(0);
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(false);
    expect(pendingEvents(events)).toEqual([]);
  });

  test("an answer the host rejects: the prompt reaches VS Code and the phone after all", async () => {
    const { agent, sidebar, events, logs } = windowWith({
      before: ({ sidebar }) => {
        const fromClient = sidebar.fromClient.bind(sidebar);
        (sidebar as any).fromClient = (message: Message) => (message.type === "response" ? Promise.reject(new Error("the reader stopped")) : fromClient(message));
      },
    });
    agent.chromeAutoAccept = () => true;
    const asked = sidebar.requestPermission("c1", chromeNavigate);
    await sleep(0);
    expect(reachedVsCode(sidebar, asked.requestId)).toBe(true);
    expect(pendingEvents(events).at(-1)?.[1].pending.map((p: any) => p.requestId)).toEqual([asked.requestId]);
    expect(logs.some((line) => line.includes("could not answer a Claude in Chrome prompt") && line.includes("the reader stopped"))).toBe(true);
    expect(logs.some((line) => line.includes("auto-accept allowed"))).toBe(false);
  });
});
