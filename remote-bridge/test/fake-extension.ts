// Test support for the window agent; not a test file itself.
//
// The bridge runs inside the Claude Code extension host and instruments three kinds of objects: the
// webview provider (one per window), one "comms" object per Claude webview, and the `vscode` module.
// These are stand-ins for them, built from what extension.js 2.1.327 does, so the agent can be tested
// without VS Code. Where the fake models the host it follows it: the member names, the shapes of the
// messages, the order things happen in, and what makes the host's reader or loop fail. What it leaves
// out is listed at the end of this comment.
//
// What the agent relies on, and what the fake therefore keeps:
//  - `send`, `fromClient`, `processRequest` are prototype methods. The agent wraps them on the
//    instance and calls the originals with the comms as `this`. Everything the fake host sends goes
//    through `this.send`, and every webview request through `this.processRequest`, so a wrapper sees
//    all of it. `send` records into `sent` and posts to the webview at once.
//  - `fromClient` only queues, like the host: the call is recorded in `received` at once and the
//    host's reader handles it later, one message after another (`await comms.flush()` waits for that).
//    The reader is as brittle as the host's: a handler that throws (a `response` without `response`
//    for a request that waits, an `io_message` without `message` for a channel that exists) ends it
//    for good. Later messages are still recorded in `received` but never handled, and `readerError`
//    holds the error. Requests are handled without holding up the reader.
//  - The CLI is simulated apart from the reader. Dispatching a prompt only hands it to the channel's
//    input (`channel.in.queue`: the prompts the CLI has not read) and clears the turn flags. With
//    `autoTurn` on (the default) the CLI reads it later, in its own task, and answers through the
//    host's loop with a whole turn: the replay, `system/init`, an assistant text, a `result`. A new
//    session's channel learns its id from that `system/init`, not before. If that loop throws (a
//    failing `send`), the host closes the channel with the error. With `autoTurn` off nothing
//    answers: the prompt stays on `channel.in.queue` and the test answers with `emit`.
//  - A launching channel is `{in, sessionId}` in `pendingChannels`; the running one is a new object
//    made when the launch completes (`promoteChannel`), around the same input. `launch_claude`
//    registers a pending channel.
//  - Ids: the host's request ids are random, so these are unique too, across every fake in the
//    process: requests `r-<n>`, generated uuids `fake-<n>`, new sessions `s-<n>` (never one the comms
//    already lists or holds). Read ids from the messages instead of predicting them.
//  - The log lines (`comms.logger`, and the provider's `output`) are kept in `lines`; the fake logs
//    the warnings and errors the host logs for the same situation.
//  - The usage meter (2.1.325+, read from 2.1.329), with `createFakeProvider({ usage: true })` and
//    `wireUsage`: the provider's `panelUsageRelay` merges each update into `merged` (a new object
//    whenever the update holds a window) and sends the update itself to every webview as a
//    `panel_usage_update` request; `seed` sends `merged` again, unchanged. A comms reads usage through
//    a channel's `query` (`relayUsageWindowsFromProcess`) and hands the converted numbers to the relay.
//    The fake has no CLI to ask: a test sets `channel.query`.
//  - The signed-in account (read from 2.1.330): each comms keeps what `claude auth status --json` answered
//    and reports its email with `cliReportedAccountEmail()`. The fake asks nothing: a test gives the answer
//    with `answerAuthStatus`. A change of account goes as in the host, in one go: the provider's
//    `refreshEveryHost()` (a switch made outside the window), `notifyLogout()` and `notifyLogin(comms)` clear
//    the relay's numbers and make the comms forget the answer (`invalidateConfigCache()`), which the host
//    then asks again.
//  - The window's config (read from 2.1.330), as far as its slash commands go: each comms holds `config` (a
//    promise while it loads), `settledConfig` (once loaded; `commands` is the list VS Code's `/` menu shows),
//    `configCwd` (the folder it is for) and `storedStartupConfig.read(cwd)` (the stored copy the webview shows
//    while the live one loads); `surfaceCwd()` is the folder its sessions start in. A test sets them. The host
//    loads a config through `loadConfig()` or a webview's `get_claude_state`, which can start a Claude process;
//    both count into `configLoads`, so a test can check that the agent never caused one. A channel's `query`
//    can answer `supportedCommands()`, a running session's own list.
//
// Not modelled (the host differs here):
//  - `atRest`/`turnComplete` follow a simplified rule, without the host's outstanding-send and queued-command
//    counters. A `rate_limit_event` after a `result`, for one, leaves `turnComplete` true here and makes it
//    false in the host. The background-task counter is kept (`runningBackgroundTasks`, read from 2.1.330): a
//    result with tasks running is not at rest, and the list emptying does not bring it back. Any word from a
//    task (`system/task_*`) clears both flags, as in the host, even one from an ambient task; other messages
//    outside the host's keep lists (a `system/status` that is not `status: null`, say) leave them alone here.
//    A result for a task notification that ran no turn counts like any other here; the host counts it only
//    after a turn.
//  - `closeChannel` removes the channel at once; the host removes it after the CLI has shut down.
//  - `fromClient` is the base class's. The concrete class puts a classifier for panel-load-failure
//    messages in front of it and holds the first messages back until the shell path has been read.
//  - `buildSessionList` has none of the host's side effects (`onSessionsListed`, per-session permission
//    modes). A tool-permission response is resolved as the webview sent it, where the host drops the
//    `updatedPermissions` the prompt did not offer. A webview reload (`init`, which makes the host reject
//    its outstanding requests and close its channels) is not modelled: it gets "Unknown request type.".
//  - A turn is one task, so a `running` state between its messages cannot be observed. History is only
//    what `setHistory` set (the fake does not persist what it emits). `io_message` has no `hostForwardedAt`.
import { basename, posix } from "node:path";

/** Protocol and SDK messages are plain JSON; the bridge sees them untyped, so the fake does too. */
export type Message = Record<string, any>;
type LogFn = (...args: unknown[]) => void;

// ---- ids -------------------------------------------------------------------------------------------

const counters = { request: 0, uuid: 0, session: 0 };
const nextRequestId = () => `r-${++counters.request}`;
const nextUuid = () => `fake-${++counters.uuid}`;
const MODEL = "claude-fake";

/** The modes the host's `set_permission_mode` accepts (`bypassPermissions` is refused unless a setting allows it). */
const PERMISSION_MODES = ["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"];

// ---- logging ---------------------------------------------------------------------------------------

/** The provider's `output` channel, a VS Code LogOutputChannel; `lines` has one `[level] text` line per call. */
export interface FakeOutput {
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  readonly lines: string[];
}

/** The comms' own logger: `log`, `warn` and `error`, as the host uses them. */
export interface FakeLogger {
  log: LogFn;
  warn: LogFn;
  error: LogFn;
  readonly lines: string[];
}

function lineWriter(lines: string[]) {
  return (level: string): LogFn =>
    (...args) => {
      lines.push(`[${level}] ${args.map(String).join(" ")}`);
    };
}

// ---- comms -----------------------------------------------------------------------------------------

/** The input stream of a channel's CLI process. `queue` holds what the CLI has not read yet, like the host's `Up` stream. */
export class FakeInput {
  readonly queue: Message[] = [];
  isDone = false;
  enqueue(message: Message): void {
    this.queue.push(message);
  }
  done(): void {
    this.isDone = true;
  }
}

/** What the host holds for a channel that is still launching. */
export interface FakePendingChannel {
  in: FakeInput;
  /** The session to resume; undefined for a new one. */
  sessionId: string | undefined;
}

/** One running CLI: made when the launch completes, around the input the pending channel had. A new session has no `sessionId` until its `system/init`. */
export interface FakeChannel extends FakePendingChannel {
  cwd: string;
  atRest: boolean;
  turnComplete: boolean;
  /** The non-ambient tasks the CLI's last `background_tasks_changed` listed (the host's jWe); a result is at rest only at 0. */
  runningBackgroundTasks: number;
  /** The CLI's SDK query, as far as a usage read and a command list use it; the test sets it (the fake has no CLI process to ask). */
  query?: Partial<FakeUsageQuery> & Partial<FakeCommandsQuery>;
}

/** The part of the SDK query that answers a running session's slash commands: `latestCommands ?? initialization.commands`. */
export interface FakeCommandsQuery {
  supportedCommands(): Promise<unknown[]>;
}

/** A login as the host keeps `claude auth status --json`'s answer (its gJn): how, the account's email, the plan. */
export interface FakeAuthStatus {
  authMethod: "claudeai" | "console" | "api-key" | "3p" | "not-specified";
  email: string | null;
  subscriptionType: string | null;
}

/** The part of the SDK query a usage read calls: the CLI's `get_usage` control request (Anthropic's usage endpoint). */
export interface FakeUsageQuery {
  usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(options?: { skipBehaviors?: boolean }): Promise<any>;
}

/** A session as the test configures it; `archived` and `lastModified` default to what a listed session always has. */
export interface SessionEntry {
  id: string;
  archived?: boolean;
  lastModified?: number;
  lastActivity?: number;
  summary?: string;
  customTitle?: string;
  gitBranch?: string;
  worktree?: { name: string; path: string };
}

export type ListedSession = SessionEntry & { archived: boolean; lastModified: number };

export type RequestPromise = Promise<any> & { requestId: string };

export interface FakeCommsOptions {
  cwd?: string;
  sessions?: SessionEntry[];
  /** Whether the simulated CLI answers prompts and interrupts; default on. */
  autoTurn?: boolean;
  /** What the host's `getInitialPermissionMode()` returns; default undefined, as with nothing configured. */
  initialPermissionMode?: string;
}

export class FakeComms {
  cwd: string;
  /** What `buildSessionList()` returns; edit it freely, e.g. `comms.sessions.push({ id: "s3" })`. */
  sessions: SessionEntry[];
  /** Whether the simulated CLI answers prompts and interrupts. Off: prompts wait on `channel.in.queue` and the test answers with `emit`. */
  autoTurn: boolean;
  /** The default mode the host would start sessions in; a user-initiated `set_permission_mode` overwrites it (see `persistDefaultPermissionMode`). */
  initialPermissionMode: string | undefined;
  /** Running channels, by channel id. */
  channels = new Map<string, FakeChannel>();
  /** Channels that are still launching, by channel id: `{in, sessionId}` until `promoteChannel`. */
  pendingChannels = new Map<string, FakePendingChannel>();
  /** Requests the host made of the webview and waits for, by request id. */
  outstandingRequests = new Map<string, { resolve(response: any): void; reject(error: Error): void }>();
  /** The signal of each webview request that is being processed, by request id. */
  abortControllers = new Map<string, AbortController>();
  readonly webview: { postMessage(message: Message): Promise<boolean>; readonly posted: Message[] };
  readonly logger: FakeLogger;
  /** Everything that went through `send`, oldest first: what the webview was told. */
  readonly sent: Message[] = [];
  /** Everything that went through `fromClient`, oldest first: what the webview said, before the host reads it (or after its reader died). */
  readonly received: Message[] = [];
  /** Telemetry the host would have emitted (`emitDirectEvent`). */
  readonly directEvents: Array<{ name: string; data: Message }> = [];
  /** The last mode each channel was told by `set_permission_mode`. */
  readonly permissionModes = new Map<string, string>();
  /** Every `set_permission_mode` the host accepted, oldest first, with the `userInitiated` flag it received. */
  readonly permissionModeChanges: Array<{ channelId: string; mode: string; userInitiated: boolean }> = [];
  /** The default modes the host wrote to the user's settings, oldest first: what a user-initiated `set_permission_mode` leaves behind. */
  readonly persistedDefaultModes: string[] = [];
  /** Where this comms' usage numbers go (the host's `onRateLimitWindows`): the provider's relay once `wireUsage` ran. */
  onRateLimitWindows?: (windows: Record<string, any>) => void;
  /** How long a usage read may take (the host's `usageReadTimeoutMs`). */
  usageReadTimeoutMs = 10_000;
  /** What `claude auth status --json` answered, as the host keeps it: the login, or undefined when signed out. */
  cachedCliAuthStatus: FakeAuthStatus | undefined = undefined;
  /** Whether `claude auth status` has answered (the host asks when a webview starts and after an account change). */
  cachedCliAuthStatusFetched = false;
  /** The window's config once loaded (the host's `settledConfig`); its `commands` is the list VS Code's `/` menu shows. */
  settledConfig: Record<string, any> | undefined = undefined;
  /** The config while it loads, and once loaded (the host's `config`, a promise). */
  config: Promise<Record<string, any>> | undefined = undefined;
  /** The folder the config is for (the host's `configCwd`). */
  configCwd: string | undefined = undefined;
  /** The stored copy of a folder's config, which the webview shows while the live one loads (the host's `storedStartupConfig`). */
  storedStartupConfig: { read(cwd: string): Record<string, any> | undefined } | undefined = undefined;
  /** How often the host was made to load a config (`loadConfig()`, `get_claude_state`); the agent must never cause one. */
  configLoads = 0;
  /** Set when a handler threw: the host's reader is dead, and later `fromClient` messages are recorded but never handled. */
  readerError: unknown = undefined;
  private readerDead = false;
  private readonly histories = new Map<string, Message[]>();
  private readonly launchCwds = new Map<string, string>();
  private readonly pendingChannelOps = new Map<string, Array<(channel: FakeChannel | Error) => void>>();
  private queue: Promise<void> = Promise.resolve();
  private readonly background = new Set<Promise<void>>();

  constructor({ cwd = "/work/demo", sessions = [], autoTurn = true, initialPermissionMode }: FakeCommsOptions = {}) {
    this.cwd = cwd;
    this.sessions = sessions.map((entry) => ({ ...entry }));
    this.autoTurn = autoTurn;
    this.initialPermissionMode = initialPermissionMode;
    const posted: Message[] = [];
    this.webview = {
      posted,
      postMessage: (message) => {
        posted.push(message);
        return Promise.resolve(true);
      },
    };
    const lines: string[] = [];
    const at = lineWriter(lines);
    this.logger = { log: at("log"), warn: at("warn"), error: at("error"), lines };
  }

  // -- the host's side of the wire ---------------------------------------------------------------

  /** Host → webview. */
  send(message: Message): void {
    this.sent.push(message);
    void this.webview.postMessage({ type: "from-extension", message });
  }

  /** The usage meter's numbers for this webview: a request without a channel, as the host sends it. */
  sendPanelUsageUpdate(windows: Record<string, any>): void {
    this.send({ type: "request", channelId: "", requestId: nextRequestId(), request: { type: "panel_usage_update", unifiedWindows: windows } });
  }

  /**
   * Reads the usage through a Claude process (`query`) and relays what it got, as the host does: at most
   * `usageReadTimeoutMs`, then the numbers converted like the host's t9e, handed to `onRateLimitWindows`
   * when there is any. Never throws: a timeout or a failure is a logged warning.
   */
  async relayUsageWindowsFromProcess(query: FakeUsageQuery): Promise<void> {
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.usageReadTimeoutMs);
      });
      const result = await Promise.race([query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), timedOut]);
      clearTimeout(timer);
      if (result === undefined) {
        this.logger.warn("usage meter read timed out");
        return;
      }
      const windows = toUsageWindows(result?.rate_limits);
      if (windows) this.onRateLimitWindows?.(windows);
    } catch (error) {
      this.logger.warn(`usage meter read failed: ${error}`);
    }
  }

  /** `claude auth status --json` answered: the login as the host keeps it (its gJn), or undefined when signed out. */
  answerAuthStatus(status: FakeAuthStatus | undefined): void {
    this.cachedCliAuthStatus = status;
    this.cachedCliAuthStatusFetched = true;
  }

  /** The host's `invalidateConfigCache()`, as far as the account goes: the answer is forgotten until asked again. */
  invalidateConfigCache(): void {
    this.cachedCliAuthStatus = undefined;
    this.cachedCliAuthStatusFetched = false;
  }

  /**
   * The signed-in account's email, as the host's `cliReportedAccountEmail()` reports it: undefined until `claude
   * auth status` has answered, null when signed out, the email, or undefined for a login without one (an API key).
   * (The host also says undefined with a third-party provider, which the fake doesn't model.)
   */
  cliReportedAccountEmail(): string | null | undefined {
    if (!this.cachedCliAuthStatusFetched) return undefined;
    const status = this.cachedCliAuthStatus;
    if (status === undefined) return null;
    return typeof status.email === "string" && status.email !== "" ? status.email : undefined;
  }

  /** The folder this webview's sessions start in (the host's `surfaceCwd()`: the last launch's folder, else its own). */
  surfaceCwd(): string {
    return this.cwd;
  }

  /** Loads the config (the host's `loadConfig()`, which can start a Claude process): counted; answers the settled one. */
  async loadConfig(): Promise<Record<string, any> | undefined> {
    this.configLoads++;
    return this.settledConfig;
  }

  /** Webview → host. The host queues what it is given; its reader handles it later, in order, for as long as it lives. */
  async fromClient(message: Message): Promise<void> {
    this.received.push(message);
    this.queue = this.queue.then(() => this.read(message));
  }

  /**
   * Handles a webview request; `e` is the whole `{type:"request", channelId, requestId, request}` message.
   * Answers `set_permission_mode`, `list_sessions_request`, `get_session_request` and `get_claude_state` (a counted
   * config load); any other type fails
   * with "Unknown request type.", which `handleRequest` sends back as an error response, as the host does.
   */
  async processRequest(e: Message, _signal: AbortSignal): Promise<Message> {
    switch (e.request.type) {
      case "set_permission_mode":
        return this.setPermissionMode(e.channelId, e.request.mode, e.request.userInitiated);
      case "list_sessions_request":
        return this.listSessions(e.request.entryPoint);
      case "get_session_request":
        return this.getSession(e.request.sessionId, e.request.purpose);
      case "get_claude_state": // a webview asking for the config: the host loads it when it has none (counted)
        this.configLoads++;
        return { type: "get_claude_state_response", config: this.settledConfig, cached: this.settledConfig !== undefined };
      default:
        throw new Error("Unknown request type.");
    }
  }

  /** The transcript, `{type:"get_session_response", messages}`; rejects for a session it does not know. */
  async getSession(id: string, purpose?: string): Promise<Message> {
    const loading = purpose === "transcript_open";
    if (loading) this.emitDirectEvent("session_load_initiated", {});
    const history = this.histories.get(id);
    if (history === undefined && !this.sessions.some((entry) => entry.id === id)) throw new Error(`Session not found: ${id}`);
    const messages = [...(history ?? [])];
    if (loading) this.emitDirectEvent("session_load_completed", { message_count: messages.length });
    return { type: "get_session_response", messages };
  }

  /** The session list, an array of entries (the host's own call, without telemetry). */
  async buildSessionList(): Promise<ListedSession[]> {
    return this.sessions.map((entry) => ({ ...entry, archived: entry.archived ?? false, lastModified: entry.lastModified ?? 0 }));
  }

  /** The list in the host's response, with its telemetry: the agent should call `buildSessionList` instead. */
  async listSessions(entryPoint?: string): Promise<Message> {
    const sessions = await this.buildSessionList();
    this.emitDirectEvent("session_list_loaded", { entry_point: entryPoint, session_count: sessions.filter((s) => !s.archived).length });
    return { type: "list_sessions_response", sessions, folderKey: this.cwd };
  }

  // -- the host's internals, with the real names -----------------------------------------------------

  /** One step of the host's reader loop. A handler that throws ends it: the host's loop has no try/catch, and its stream can be read only once. */
  private read(message: Message): void {
    if (this.readerDead) return;
    try {
      this.dispatch(message);
    } catch (error) {
      this.readerDead = true;
      this.readerError = error;
    }
  }

  /** What the reader does with one message, as the host's `readFromClient` switch. Reads fields the way the host does, without guards. */
  private dispatch(message: Message): void {
    switch (message.type) {
      case "launch_claude":
        this.launchClaude(message.channelId, message.resume, message.cwd);
        break;
      case "close_channel":
        this.closeChannel(message.channelId, false);
        break;
      case "interrupt_claude":
        this.interruptClaude(message.channelId);
        break;
      case "io_message":
        this.transportMessage(message.channelId, message.message, message.done);
        break;
      case "request": {
        // Not awaited, so a slow request does not hold up the messages behind it; `handleRequest` has its own catch.
        const run: Promise<void> = this.handleRequest(message).finally(() => this.background.delete(run));
        this.background.add(run);
        break;
      }
      case "response": {
        const waiting = this.outstandingRequests.get(message.requestId);
        if (!waiting) this.logger.warn(`No handler for response with requestId: ${message.requestId}`);
        else if (message.response.type === "error") waiting.reject(new Error(message.response.error));
        else waiting.resolve(message.response);
        break;
      }
      case "cancel_request":
        this.handleCancellation(message.targetRequestId);
        break;
      default:
        this.logger.error(`Unknown message: ${message.type}`);
    }
  }

  /** Runs a webview request and sends its answer, or an error response, back. */
  async handleRequest(e: Message): Promise<void> {
    const controller = new AbortController();
    try {
      this.abortControllers.set(e.requestId, controller);
      const response = await this.processRequest(e, controller.signal);
      this.send({ type: "response", requestId: e.requestId, response });
    } catch (error) {
      this.logger.error(`Error processing client request: ${error}`);
      this.send({ type: "response", requestId: e.requestId, response: { type: "error", error: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.abortControllers.delete(e.requestId);
    }
  }

  handleCancellation(requestId: string): void {
    this.abortControllers.get(requestId)?.abort();
  }

  /** The host's request to the webview; resolves with the response, rejects for an error response or an abort. */
  sendRequest(channelId: string, request: Message, signal?: AbortSignal): RequestPromise {
    const requestId = nextRequestId();
    let onAbort: (() => void) | undefined;
    const promise = new Promise<any>((resolve, reject) => {
      this.outstandingRequests.set(requestId, { resolve, reject });
      if (signal) {
        onAbort = () => {
          this.outstandingRequests.delete(requestId);
          this.send({ type: "cancel_request", targetRequestId: requestId });
          reject(new Error(String(signal.reason || "aborted")));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.send({ type: "request", channelId, requestId, request });
    }).finally(() => {
      this.outstandingRequests.delete(requestId);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    });
    return Object.assign(promise, { requestId });
  }

  /**
   * A prompt for the CLI: handed to the channel's input and nothing more. The turn flags clear on a running
   * channel; what the CLI answers is its own business (`autoTurn`), later.
   */
  transportMessage(channelId: string, message: Message, done?: boolean): void {
    const running = this.channels.get(channelId);
    const channel = running ?? this.pendingChannels.get(channelId);
    if (!channel) {
      this.logger.warn(`Channel not found for io_message: ${channelId}`);
      return;
    }
    if (message.type === "user") {
      if (running) {
        running.turnComplete = false;
        running.atRest = false;
      }
      channel.in.enqueue(message);
      if (running && this.autoTurn) this.scheduleTurn(channelId, running);
    }
    if (done) channel.in.done();
  }

  /** A launch starts: the channel is pending until the test completes it with `promoteChannel`. */
  launchClaude(channelId: string, resume?: string, cwd?: string): void {
    if (this.channels.has(channelId) || this.pendingChannels.has(channelId)) {
      this.logger.error(`Channel already exists: ${channelId}`);
      return;
    }
    this.openChannel(channelId, resume, { pending: true, cwd });
  }

  /** Closes the channel; `notify` tells the webview first (the host does that when it is the one closing). */
  closeChannel(channelId: string, notify = true, error?: string): void {
    const running = this.channels.get(channelId);
    const channel = running ?? this.pendingChannels.get(channelId);
    if (!channel) return;
    if (notify) this.send({ type: "close_channel", channelId, ...(error !== undefined && { error }) });
    channel.in.done();
    this.channels.delete(channelId);
    this.pendingChannels.delete(channelId);
    this.launchCwds.delete(channelId);
    if (!running) this.drainPendingChannelOps(channelId, new Error(error ?? "Channel closed mid-launch"));
  }

  interruptClaude(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (!channel) {
      if (this.pendingChannels.has(channelId)) this.closeChannel(channelId, true, "Interrupted during launch");
      else this.logger.warn(`Channel not found: ${channelId}`);
      return;
    }
    if (!this.autoTurn) return;
    // The CLI ends the turn, later and on its own.
    this.startCliWork(() => {
      if (this.channels.get(channelId) !== channel) return;
      this.emit(channelId, {
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        errors: [],
        uuid: nextUuid(),
        ...(channel.sessionId !== undefined && { session_id: channel.sessionId }),
      });
    });
  }

  emitDirectEvent(name: string, data: Message): void {
    this.directEvents.push({ name, data });
  }

  /** Runs `fn` on the running channel; waits for a launching one to start, fails for one that is closed mid-launch or unknown. */
  private async withChannel<T>(channelId: string, fn: (channel: FakeChannel) => Promise<T>): Promise<T> {
    const running = this.channels.get(channelId);
    if (running) return fn(running);
    if (this.pendingChannels.has(channelId)) {
      return new Promise<T>((resolve, reject) => {
        const ops = this.pendingChannelOps.get(channelId) ?? [];
        this.pendingChannelOps.set(channelId, ops);
        ops.push((channel) => {
          if (channel instanceof Error) reject(channel);
          else fn(channel).then(resolve, reject);
        });
      });
    }
    throw new Error(`Channel not found: ${channelId}`);
  }

  private drainPendingChannelOps(channelId: string, channel: FakeChannel | Error): void {
    const ops = this.pendingChannelOps.get(channelId);
    if (!ops) return;
    this.pendingChannelOps.delete(channelId);
    for (const op of ops) op(channel);
  }

  private async setPermissionMode(channelId: string, mode: unknown, userInitiated: unknown): Promise<Message> {
    const refused = { type: "set_permission_mode_response", success: false };
    if (typeof mode !== "string" || !PERMISSION_MODES.includes(mode)) {
      this.logger.warn(`Refusing set_permission_mode on channel ${channelId}: mode is not a recognized mode (${typeof mode})`);
      return refused;
    }
    return this.withChannel(channelId, async () => {
      if (mode === "bypassPermissions") {
        this.logger.warn(`Refusing set_permission_mode on channel ${channelId}: allowDangerouslySkipPermissions is off`);
        return refused;
      }
      this.permissionModes.set(channelId, mode);
      this.permissionModeChanges.push({ channelId, mode, userInitiated: Boolean(userInitiated) });
      if (userInitiated) this.persistDefaultPermissionMode(mode);
      return { type: "set_permission_mode_response", success: true };
    });
  }

  /**
   * What a user-initiated mode change leaves in the user's settings: the new default, for `default`, `auto` and
   * `acceptEdits` only, and only when it is not the default already. The webview sends `userInitiated: false`
   * when a permission request changes the mode (a plan approval); a picker click sends `true`.
   */
  persistDefaultPermissionMode(mode: string): void {
    if (mode !== "default" && mode !== "auto" && mode !== "acceptEdits") return;
    if (mode === this.initialPermissionMode) return;
    this.initialPermissionMode = mode;
    this.persistedDefaultModes.push(mode);
  }

  // -- the CLI, simulated ------------------------------------------------------------------------

  /** Work of the CLI process: it happens later, apart from the reader, and `flush()` waits for it. */
  private startCliWork(work: () => void): void {
    const done: Promise<void> = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        try {
          work();
          resolve();
        } catch (error) {
          reject(error);
        }
      }, 0);
    }).finally(() => this.background.delete(done));
    this.background.add(done);
  }

  /** The CLI reads the oldest prompt on the channel's input and answers it. */
  private scheduleTurn(channelId: string, channel: FakeChannel): void {
    this.startCliWork(() => {
      if (this.channels.get(channelId) !== channel) return; // closed or replaced meanwhile: the process is gone
      const prompt = channel.in.queue.shift();
      if (prompt !== undefined) this.runTurn(channelId, channel, prompt);
    });
  }

  /**
   * One turn: the CLI replays the prompt, announces the turn, answers, and ends it. The CLI knows the session
   * id from the start (a new session gets one here); the host's channel learns it at the `system/init`.
   */
  private runTurn(channelId: string, channel: FakeChannel, prompt: Message): void {
    const sessionId = channel.sessionId ?? this.newSessionId();
    const reply = `Echo: ${promptText(prompt)}`;
    const turn: Message[] = [
      { ...prompt, isReplay: true, session_id: sessionId },
      {
        type: "system",
        subtype: "init",
        uuid: nextUuid(),
        session_id: sessionId,
        cwd: channel.cwd,
        model: MODEL,
        tools: ["Bash", "Edit", "Read", "Write"],
        permissionMode: this.permissionModes.get(channelId) ?? "default",
      },
      {
        type: "assistant",
        uuid: nextUuid(),
        session_id: sessionId,
        parent_tool_use_id: null,
        message: { id: `msg_fake_${++counters.uuid}`, role: "assistant", model: MODEL, content: [{ type: "text", text: reply }] },
      },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        duration_ms: 1,
        duration_api_ms: 1,
        num_turns: 1,
        total_cost_usd: 0,
        result: reply,
        session_id: sessionId,
        uuid: nextUuid(),
        ...(typeof prompt.uuid === "string" && { user_message_uuid: prompt.uuid }),
      },
    ];
    try {
      for (const message of turn) {
        if (this.channels.get(channelId) !== channel) return; // closed meanwhile: the CLI is gone
        this.forward(channelId, message);
      }
    } catch (error) {
      this.closeAfterLoopError(channelId, error);
    }
  }

  /** One message through the host's loop over a channel's CLI output: the channel notes it, then it is forwarded. */
  private forward(channelId: string, message: Message): void {
    const running = this.channels.get(channelId);
    if (running) {
      noteTurnState(running, message);
      if (message.type === "system" && message.subtype === "init" && typeof message.session_id === "string") running.sessionId = message.session_id;
    }
    this.send({ type: "io_message", channelId, message, done: false });
  }

  /** What the host does when that loop throws (a failing `send`, say): it closes the channel with the error and logs it. */
  private closeAfterLoopError(channelId: string, error: unknown): void {
    this.closeChannel(channelId, true, String(error));
    this.logger.error(`Error from Claude (on channel ${channelId}): ${error}`);
  }

  private newSessionId(): string {
    const taken = new Set<string | undefined>([
      ...this.sessions.map((entry) => entry.id),
      ...this.histories.keys(),
      ...[...this.channels.values(), ...this.pendingChannels.values()].map((channel) => channel.sessionId),
    ]);
    let id = `s-${++counters.session}`;
    while (taken.has(id)) id = `s-${++counters.session}`;
    return id;
  }

  // -- helpers for the test --------------------------------------------------------------------------

  /** Registers a running channel (or, with `pending: true`, a launching one) and returns it; a new session has no `sessionId`. */
  openChannel(channelId: string, sessionId?: string, options?: { pending?: false; cwd?: string }): FakeChannel;
  openChannel(channelId: string, sessionId: string | undefined, options: { pending: true; cwd?: string }): FakePendingChannel;
  openChannel(channelId: string, sessionId?: string, { pending = false, cwd }: { pending?: boolean; cwd?: string } = {}): FakeChannel | FakePendingChannel {
    if (this.channels.has(channelId) || this.pendingChannels.has(channelId)) throw new Error(`Channel already exists: ${channelId}`);
    if (pending) {
      const launching: FakePendingChannel = { in: new FakeInput(), sessionId };
      this.pendingChannels.set(channelId, launching);
      if (cwd !== undefined) this.launchCwds.set(channelId, cwd);
      return launching;
    }
    const channel: FakeChannel = { in: new FakeInput(), sessionId, cwd: posix.resolve(this.cwd, cwd ?? this.cwd), atRest: true, turnComplete: false, runningBackgroundTasks: 0 };
    this.channels.set(channelId, channel);
    return channel;
  }

  /**
   * The launch of a pending channel completes: a new, running channel object (same input, same session) replaces it,
   * and anything that waited for the launch continues. It is not at rest if prompts are waiting; with `autoTurn` the
   * CLI answers them now.
   */
  promoteChannel(channelId: string): FakeChannel {
    const launching = this.pendingChannels.get(channelId);
    if (!launching) throw new Error(`Channel is not launching: ${channelId}`);
    const channel: FakeChannel = {
      in: launching.in,
      sessionId: launching.sessionId,
      cwd: posix.resolve(this.cwd, this.launchCwds.get(channelId) ?? this.cwd),
      atRest: launching.in.queue.length === 0,
      turnComplete: false,
      runningBackgroundTasks: 0,
    };
    this.channels.set(channelId, channel);
    this.pendingChannels.delete(channelId);
    this.launchCwds.delete(channelId);
    this.drainPendingChannelOps(channelId, channel);
    if (this.autoTurn) for (let waiting = 0; waiting < channel.in.queue.length; waiting++) this.scheduleTurn(channelId, channel);
    return channel;
  }

  /**
   * The CLI on a channel produced an SDK message: it reaches the webview as an `io_message`. As in the host's loop,
   * the channel notes the message first (its turn flags move, and a `system/init` names its session), and a failing
   * `send` closes the channel with the error instead of reaching the caller.
   */
  emit(channelId: string, message: Message): void {
    if (!this.channels.has(channelId) && !this.pendingChannels.has(channelId)) throw new Error(`emit: channel ${channelId} is not open`);
    try {
      this.forward(channelId, message);
    } catch (error) {
      this.closeAfterLoopError(channelId, error);
    }
  }

  /** The host asks the webview something (a tool permission, or a `user_dialog_request`); `request` is the inner request object. */
  requestPermission(channelId: string, request: Message, signal?: AbortSignal): RequestPromise {
    return this.sendRequest(channelId, request, signal);
  }

  /** What `getSession(id)` returns, until set again; the array is read afresh on every call. */
  setHistory(id: string, messages: Message[]): void {
    this.histories.set(id, messages);
  }

  /**
   * Resolves when this comms' host has handled everything it was given so far, including what that caused, and its CLI
   * has finished its work. It is per comms: with several, flush each one that has work.
   */
  /**
   * Keeps the host's reader busy, as 2.1.328's `readFromClient` is while it awaits a `launch_claude` (one that
   * waits on the folder-trust dialog, say): later `fromClient` messages wait in the queue until the returned
   * function is called. Call it before `flush()`, which waits for the queue.
   */
  holdReader(): () => void {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    this.queue = this.queue.then(() => held);
    return release;
  }

  async flush(): Promise<void> {
    for (;;) {
      const queue = this.queue;
      await Promise.allSettled([queue, ...this.background]);
      if (queue === this.queue && this.background.size === 0) return;
    }
  }
}

/**
 * A result ends the turn (an error result is at rest but not complete), unless background tasks run on: then neither
 * flag is set, and the list emptying leaves them as they are (the next result sets them). A list that names a running
 * task clears both, as anything the CLI does within a turn does, and so does any word from a task (`system/task_*`,
 * an ambient one's too); other messages leave the flags alone.
 */
function noteTurnState(channel: FakeChannel, message: Message): void {
  const fromTask = message.type === "system" && typeof message.subtype === "string" && message.subtype.startsWith("task_");
  if (message.type === "system" && message.subtype === "background_tasks_changed") {
    const tasks = message.tasks;
    channel.runningBackgroundTasks = Array.isArray(tasks) ? tasks.filter((task) => task === null || typeof task !== "object" || task.ambient !== true).length : 1;
    if (channel.runningBackgroundTasks > 0) {
      channel.atRest = false;
      channel.turnComplete = false;
    }
  } else if (message.type === "result") {
    channel.atRest = channel.runningBackgroundTasks === 0;
    channel.turnComplete = message.is_error !== true && channel.runningBackgroundTasks === 0;
  } else if (message.type === "user" || message.type === "assistant" || message.type === "stream_event" || (message.type === "system" && message.subtype === "init") || fromTask) {
    channel.atRest = false;
    channel.turnComplete = false;
  }
}

/** The text blocks of a prompt, joined; content may also be a plain string. */
function promptText(prompt: Message): string {
  const content = prompt.message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

/**
 * The host's stored startup configs (its `storedStartupConfig`): `read(cwd)` gives the folder's own copy, or else the copy
 * kept for any folder (2.1.330 keeps that one with `commands: []`), the way the host falls back when the folder's copy
 * is missing, old or another login's.
 */
export function createStoredStartupConfig(
  folders: Record<string, Record<string, any>> = {},
  anyFolder: Record<string, any> | undefined = { models: [{ value: "default" }], commands: [] },
): { read(cwd: string): Record<string, any> | undefined } {
  return { read: (cwd: string) => folders[cwd] ?? anyFolder };
}

export function createFakeComms(options?: FakeCommsOptions): FakeComms {
  return new FakeComms(options);
}

// ---- the usage meter -------------------------------------------------------------------------------

const USAGE_WINDOWS = ["five_hour", "seven_day", "seven_day_overage_included"];

/**
 * The host's merge of a usage update into what it holds (e9e): `null` removes a window, a window without
 * `resetsAt` doesn't replace one that has it, anything else replaces it. Any replacement makes a new object,
 * even with the same numbers; an update that changes nothing gives `prev` back.
 */
export function mergeWindows(prev: Record<string, any> | null, update: Record<string, any> | null | undefined): Record<string, any> | null {
  if (!update) return prev;
  const next: Record<string, any> = { ...prev };
  let changed = false;
  for (const key of USAGE_WINDOWS) {
    const w = update[key];
    if (w === null) {
      if (next[key] !== undefined) {
        delete next[key];
        changed = true;
      }
      continue;
    }
    if (!w || (w.resetsAt === undefined && next[key]?.resetsAt !== undefined)) continue;
    next[key] = w;
    changed = true;
  }
  if (!changed) return prev;
  return Object.keys(next).length === 0 ? null : next;
}

/** One window of the usage endpoint's answer, as the host converts it (IX): undefined when unusable or already reset. */
function toUsageWindow(window: any, now: number): Record<string, any> | undefined {
  if (!window || window.utilization === null || !Number.isFinite(window.utilization)) return undefined;
  if (window.resets_at === null) return { utilization: window.utilization / 100 };
  const at = Date.parse(window.resets_at);
  if (!Number.isFinite(at) || at <= now) return undefined;
  return { utilization: window.utilization / 100, resetsAt: Math.round(at / 1000) };
}

/** The usage endpoint's `rate_limits` as the meter's windows (the host's t9e), or null when there is none. */
export function toUsageWindows(limits: any, now = Date.now()): Record<string, any> | null {
  if (!limits) return null;
  const week = toUsageWindow(limits.seven_day, now);
  const fiveHour = limits.five_hour === null && week ? null : toUsageWindow(limits.five_hour, now);
  let model: Record<string, any> | null | undefined;
  if (Array.isArray(limits.model_scoped)) {
    if (limits.model_scoped.length === 0) model = null;
    else if (limits.model_scoped.length === 1) model = toUsageWindow(limits.model_scoped[0], now);
  }
  if (fiveHour === undefined && !week && model === undefined) return null;
  return {
    ...(fiveHour !== undefined && { five_hour: fiveHour }),
    ...(week && { seven_day: week }),
    ...(model !== undefined && { seven_day_overage_included: model }),
  };
}

/** The provider's usage relay (`panelUsageRelay`): what the window's usage meter shows, sent to every webview. */
export class FakeUsageRelay {
  merged: Record<string, any> | null = null;
  /** Signed out: updates still go to the webviews, but nothing is kept until the next login or account change. */
  signedOut = false;

  /** New numbers: merged into `merged` first (unless signed out), then the update itself goes to every webview. */
  broadcast(allComms: Set<FakeComms>, update: Record<string, any>): void {
    if (!this.signedOut) this.merged = mergeWindows(this.merged, update);
    for (const comms of allComms) comms.sendPanelUsageUpdate(update);
  }

  /** A webview that starts gets what is held, unchanged (`merged` stays the same object). */
  seed(comms: FakeComms): void {
    if (this.merged !== null) comms.sendPanelUsageUpdate(this.merged);
  }

  /** The account's numbers are dropped, without telling the webviews (the host's three resets; its initial-read flag isn't modelled). */
  onLogout(): void {
    this.merged = null;
    this.signedOut = true;
  }

  onLogin(): void {
    this.merged = null;
    this.signedOut = false;
  }

  onAccountChangedOutside(): void {
    this.merged = null;
    this.signedOut = false;
  }
}

// ---- provider --------------------------------------------------------------------------------------

export interface FakeProvider {
  /** One comms per Claude webview of the window: the sidebar, each editor tab, the Session Manager. */
  allComms: Set<FakeComms>;
  /** What the panels report: `state` is `idle`, `running` or `waiting_input`. */
  sessionStates: Map<string, { info: { sessionId: string; state: "idle" | "running" | "waiting_input"; title: string }; author?: unknown }>;
  unreadSessionKeys: Set<string>;
  liveElsewhereSessions: Array<{ sessionId: string; holder: string; activity: "running" | "waiting" | "idle"; sameProject: boolean }>;
  output: FakeOutput;
  /** The editor tab (WebviewPanel) that shows each session. The host keeps a tab here after its Claude process exits; closing the tab takes it out. */
  sessionPanels: Map<string, FakePanel>;
  /** Whether the sidebar shows the session or has a channel on it (the host's `sidebarHoldsSession`); false unless a test says otherwise. */
  sidebarHoldsSession(sessionId: string): boolean;
  /** The usage meter's relay; only with `createFakeProvider({ usage: true })` (extensions before 2.1.325 have none). */
  panelUsageRelay?: FakeUsageRelay;
  /** Another account signed in outside this window (a terminal, another window): the relay's numbers go, and every comms forgets its `claude auth status` answer. */
  refreshEveryHost(): void;
  /** Signed out: as refreshEveryHost, and the relay keeps no numbers until the next login. */
  notifyLogout(): void;
  /** A login in this window, through `comms` (which has already asked again): the relay's numbers go, and the other comms forget their answer. */
  notifyLogin(comms: FakeComms): void;
}

/** An editor tab's WebviewPanel, as far as the agent uses it. */
export interface FakePanel {
  disposed: boolean;
  /** Closes the tab: the host's onDidDispose takes it out of `sessionPanels` at once. */
  dispose(): void;
}

/** Puts a tab that shows `sessionId` into the provider's `sessionPanels`. */
export function addFakePanel(provider: FakeProvider, sessionId: string): FakePanel {
  const panel: FakePanel = {
    disposed: false,
    dispose() {
      panel.disposed = true;
      if (provider.sessionPanels.get(sessionId) === panel) provider.sessionPanels.delete(sessionId);
    },
  };
  provider.sessionPanels.set(sessionId, panel);
  return panel;
}

export function createFakeProvider({ usage = false }: { usage?: boolean } = {}): FakeProvider {
  const lines: string[] = [];
  const at = lineWriter(lines);
  const provider: FakeProvider = {
    allComms: new Set(),
    sessionStates: new Map(),
    unreadSessionKeys: new Set(),
    liveElsewhereSessions: [],
    output: { trace: at("trace"), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error"), lines },
    sessionPanels: new Map(),
    sidebarHoldsSession: () => false,
    ...(usage && { panelUsageRelay: new FakeUsageRelay() }),
    // The host's account changes, each in one go (no webview hears of the numbers going).
    refreshEveryHost() {
      provider.panelUsageRelay?.onAccountChangedOutside();
      for (const comms of provider.allComms) comms.invalidateConfigCache();
    },
    notifyLogout() {
      provider.panelUsageRelay?.onLogout();
      for (const comms of provider.allComms) comms.invalidateConfigCache();
    },
    notifyLogin(loggedIn) {
      provider.panelUsageRelay?.onLogin();
      for (const comms of provider.allComms) if (comms !== loggedIn) comms.invalidateConfigCache();
    },
  };
  return provider;
}

/** Wires every comms of the provider to its usage relay, as the host does when it makes a comms (`onRateLimitWindows`). */
export function wireUsage(provider: FakeProvider): void {
  const relay = provider.panelUsageRelay;
  if (!relay) throw new Error("wireUsage: the provider has no usage relay");
  for (const comms of provider.allComms) comms.onRateLimitWindows = (windows) => relay.broadcast(provider.allComms, windows);
}

// ---- vscode ----------------------------------------------------------------------------------------

export interface FakeWorkspaceFolder {
  uri: { scheme: "file"; path: string; fsPath: string; toString(): string };
  name: string;
  index: number;
}

export interface FakeVscode {
  workspace: {
    name: string | undefined;
    /** Undefined when no folder is open, as in VS Code. */
    workspaceFolders: FakeWorkspaceFolder[] | undefined;
    onDidChangeWorkspaceFolders(listener: (event: { added: FakeWorkspaceFolder[]; removed: FakeWorkspaceFolder[] }) => void): { dispose(): void };
    /** For the test: opens other folders and fires `onDidChangeWorkspaceFolders`. */
    setFolders(folders: string[]): void;
  };
  env: { appName: string };
  commands: {
    executeCommand(id: string, ...args: any[]): Promise<any>;
    /** Every call, oldest first. */
    calls: Array<{ id: string; args: any[] }>;
    /** Runs after the call is recorded; what it returns (or rejects with) is what `executeCommand` resolves (or rejects) with. */
    onCommand?: (id: string, args: any[]) => unknown;
  };
  /** The same hook as `commands.onCommand`. */
  onCommand?: (id: string, args: any[]) => unknown;
}

export function createFakeVscode({
  folders = ["/work/demo"],
  appName = "Visual Studio Code - Insiders",
  name = "demo",
}: { folders?: string[]; appName?: string; name?: string | null } = {}): FakeVscode {
  const toFolders = (paths: string[]): FakeWorkspaceFolder[] =>
    paths.map((path, index) => ({ uri: { scheme: "file", path, fsPath: path, toString: () => `file://${path}` }, name: basename(path), index }));
  const listeners = new Set<(event: { added: FakeWorkspaceFolder[]; removed: FakeWorkspaceFolder[] }) => void>();

  const workspace: FakeVscode["workspace"] = {
    name: name ?? undefined,
    workspaceFolders: folders.length ? toFolders(folders) : undefined,
    onDidChangeWorkspaceFolders(listener) {
      listeners.add(listener);
      return {
        dispose() {
          listeners.delete(listener);
        },
      };
    },
    setFolders(next) {
      const before = workspace.workspaceFolders ?? [];
      const after = toFolders(next);
      workspace.workspaceFolders = after.length ? after : undefined;
      const known = (list: FakeWorkspaceFolder[], folder: FakeWorkspaceFolder) => list.some((other) => other.uri.fsPath === folder.uri.fsPath);
      const event = { added: after.filter((folder) => !known(before, folder)), removed: before.filter((folder) => !known(after, folder)) };
      for (const listener of [...listeners]) listener(event);
    },
  };

  const commands: FakeVscode["commands"] = {
    calls: [],
    executeCommand: async (id, ...args) => {
      commands.calls.push({ id, args });
      return commands.onCommand?.(id, args);
    },
  };

  return {
    workspace,
    env: { appName },
    commands,
    get onCommand() {
      return commands.onCommand;
    },
    set onCommand(hook) {
      commands.onCommand = hook;
    },
  };
}
