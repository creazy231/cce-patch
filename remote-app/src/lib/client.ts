// The phone's side of the WebSocket protocol: one RemoteClient per paired Mac.
// Browser APIs (WebSocket, timers, document/window events) are injectable so that everything here
// runs under Bun with fakes.

import type { Mac } from "./macs";
import { PROTOCOL_VERSION } from "./protocol";
import type { PushSetup } from "./push";
import type {
  Ack,
  Choice,
  ClientMsg,
  ErrorFrame,
  ImageUpload,
  MessageFrame,
  PendingFrame,
  Project,
  ServerMsg,
  SnapshotFrame,
  StreamFrame,
  WelcomeFrame,
} from "./protocol";

// ---- injectable environment ---------------------------------------------------------------------

/** The part of the browser's WebSocket the client uses. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type WebSocketCtor = new (url: string) => WebSocketLike;

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

// Wrappers, not the bare functions: `window.setTimeout` called as a method of another object throws "Illegal invocation".
export const realTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  setInterval: (fn, ms) => globalThis.setInterval(fn, ms),
  clearInterval: (handle) => globalThis.clearInterval(handle as number),
};

interface WakeTarget {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}
/** Where `visibilitychange` and `online` come from; the browser's document and window by default. */
export interface WakeEnv {
  document?: WakeTarget & { visibilityState?: string };
  window?: WakeTarget;
}

// ---- errors, state, events ----------------------------------------------------------------------

/**
 * A request that did not succeed. `code` is the bridge's error (not_pending, no_channel, bad_code, …)
 * or one of ours: not_connected, connection_lost, closed, timeout, unreachable, bad_response.
 */
export class RemoteError extends Error {
  readonly code: string;
  /** push_test: the push service's HTTP status, when the Mac got one. */
  readonly status?: number;
  constructor(code: string, message = code, status?: number) {
    super(message);
    this.name = "RemoteError";
    this.code = code;
    this.status = status;
  }
}

export type ClientState = "connecting" | "open" | "offline" | "unauthorized";

export interface ClientEvents {
  state: ClientState;
  welcome: WelcomeFrame;
  projects: Project[];
  // snapshot, msg, stream and pending: only for the session subscribed at that moment.
  snapshot: SnapshotFrame;
  msg: MessageFrame;
  stream: StreamFrame;
  pending: PendingFrame;
  error: ErrorFrame;
}

export interface ClientOptions {
  WebSocketImpl?: WebSocketCtor;
  timers?: Timers;
  env?: WakeEnv;
}

// ---- constants ----------------------------------------------------------------------------------

const OPEN = 1;
const RETRY_MIN_MS = 500;
const RETRY_MAX_MS = 10_000;
const PING_EVERY_MS = 25_000;
/** How long after a ping any frame may take before the connection counts as dead. */
const PONG_WITHIN_MS = 10_000;
/** The same, when the app has just come back to the foreground (a sleeping phone leaves half-open sockets). */
const PROBE_WITHIN_MS = 4_000;
const ACK_TIMEOUT_MS = 30_000;
/** Starting a session waits on the Mac for VS Code's new tab and then for the session's name: up to ~40 s. */
const NEW_SESSION_ACK_TIMEOUT_MS = 60_000;
const PAIR_TIMEOUT_MS = 15_000;
/**
 * The Mac's refusals of this phone itself: unknown or wrong token, paired from another app address, removed
 * on the Mac. Retrying can't help; pairing again can. Every other error is no reason to stop.
 */
const UNAUTHORIZED = new Set(["bad_token", "bad_origin", "revoked"]);

/** https://host:47821 → wss://host:47821/ws (http → ws, for local development). */
function toWsUrl(url: string): string {
  return `${url.replace(/\/+$/, "").replace(/^http/i, "ws")}/ws`;
}

function globalWebSocket(): WebSocketCtor | undefined {
  return (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
}

function detach(ws: WebSocketLike): void {
  ws.onopen = null;
  ws.onmessage = null;
  ws.onclose = null;
  ws.onerror = null;
}

function parseFrame(data: unknown): ServerMsg | null {
  if (typeof data !== "string") return null;
  try {
    const frame: unknown = JSON.parse(data);
    return frame && typeof frame === "object" && !Array.isArray(frame) ? (frame as ServerMsg) : null;
  } catch {
    return null;
  }
}

// ---- the client ---------------------------------------------------------------------------------

interface PendingAck {
  resolve(ack: Ack): void;
  reject(error: Error): void;
  timer: unknown;
}

/**
 * One WebSocket to one paired Mac, kept alive.
 *
 * - `connect()` opens it and sends `hello`; `welcome` makes the state "open". An error `bad_token`,
 *   `bad_origin` or `revoked` (before or after the welcome) ends in "unauthorized" and stops: re-pair instead
 *   of retrying. Any other error is passed on; a connection the Mac then closes (`unsupported_version`, …)
 *   is retried like any other.
 * - A lost connection is retried after 500 ms, doubling up to 10 s (reset by a welcome). Coming back to
 *   the foreground or getting network again retries at once, and checks an open connection with a ping.
 * - `ping` goes out every 25 s; a connection that stays silent for 10 s afterwards is replaced.
 * - The subscribed session is subscribed again after every welcome (the fresh snapshot replaces the view).
 *   `snapshot`, `msg`, `stream` and `pending` frames are passed on only for the session subscribed at that
 *   moment: late frames of a previous session, or after `unsubscribe()`, are dropped.
 * - Requests (`send`, `answer`, …) resolve with the bridge's ack, reject with a RemoteError when the bridge
 *   says no, the connection drops or 30 s pass (60 s for a send that starts a new session), and reject at once
 *   while not connected (nothing is queued).
 */
export class RemoteClient {
  private currentState: ClientState = "offline";
  private currentProjects: Project[] = [];
  private currentMacName: string;

  private readonly mac: Mac;
  private readonly WebSocketImpl: WebSocketCtor | undefined;
  private readonly timers: Timers;
  private readonly env: WakeEnv | undefined;

  private ws: WebSocketLike | null = null;
  private wanted = false;
  private backoff = RETRY_MIN_MS;
  private retryTimer: unknown = null;
  private pingTimer: unknown = null;
  private pongTimer: unknown = null;
  private stopWakeListeners: (() => void) | null = null;
  private subscription: { project: string; session: string } | null = null;
  private sequence = 0;
  private readonly acks = new Map<string, PendingAck>();
  private readonly listeners = new Map<keyof ClientEvents, Set<(payload: never) => void>>();

  constructor(mac: Mac, options: ClientOptions = {}) {
    this.mac = mac;
    this.currentMacName = mac.name;
    this.WebSocketImpl = options.WebSocketImpl;
    this.timers = options.timers ?? realTimers;
    this.env = options.env;
  }

  /** "offline" until connect() is called, and again after close(). */
  get state(): ClientState {
    return this.currentState;
  }

  /** The latest list from the Mac; kept while offline. */
  get projects(): Project[] {
    return this.currentProjects;
  }

  /** The Mac's name as of the last welcome (the paired name before that). */
  get macName(): string {
    return this.currentMacName;
  }

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    const existing = this.listeners.get(event);
    const set = existing ?? new Set<(payload: never) => void>();
    if (!existing) this.listeners.set(event, set);
    set.add(listener);
    return () => {
      set.delete(listener);
    };
  }

  /** Starts connecting (and keeps trying). Also the way to try again after "unauthorized". */
  connect(): void {
    this.wanted = true;
    this.listenForWakeUps();
    if (this.currentState === "connecting" || this.currentState === "open") return;
    this.clearRetry();
    this.backoff = RETRY_MIN_MS;
    this.openSocket();
  }

  /** Stops for good: closes the socket, cancels retries and timers, fails requests in flight. */
  close(): void {
    this.wanted = false;
    this.stopWakeListeners?.();
    this.stopWakeListeners = null;
    this.clearRetry();
    this.teardown(new RemoteError("closed"));
    this.setState("offline");
  }

  /**
   * Watches one session: the Mac answers with a snapshot and then live events. Replaces the previous
   * subscription (frames of the old session still on their way are dropped); asking for the one that is
   * already subscribed does nothing.
   */
  subscribe(project: string, session: string): void {
    const current = this.subscription;
    if (current && current.project === project && current.session === session) return;
    if (current) this.sendFrame({ t: "unsub", ...current });
    this.subscription = { project, session };
    this.sendFrame({ t: "sub", project, session }); // not sent before the welcome; then after it
  }

  unsubscribe(): void {
    const current = this.subscription;
    if (!current) return;
    this.subscription = null;
    this.sendFrame({ t: "unsub", ...current });
  }

  /** Sends a message to a session, or starts a new session in the project when `session` is null. */
  send(project: string, session: string | null, text: string, images?: ImageUpload[]): Promise<Ack> {
    return this.request(
      (id) => ({
        t: "send",
        id,
        project,
        session,
        text,
        ...(images && images.length > 0 ? { images } : {}),
      }),
      session === null ? NEW_SESSION_ACK_TIMEOUT_MS : ACK_TIMEOUT_MS,
    );
  }

  answer(project: string, session: string, requestId: string, choice: Choice): Promise<Ack> {
    return this.request((id) => ({ t: "answer", id, project, session, requestId, choice }));
  }

  interrupt(project: string, session: string): Promise<Ack> {
    return this.request((id) => ({ t: "interrupt", id, project, session }));
  }

  /** Opens the session in an editor tab on the Mac. */
  open(project: string, session: string): Promise<Ack> {
    return this.request((id) => ({ t: "open", id, project, session }));
  }

  /** Opens Claude Code's panel in that project's window. */
  openClaude(project: string): Promise<Ack> {
    return this.request((id) => ({ t: "openClaude", id, project }));
  }

  /** Gives the Mac this phone's push subscription, VAPID keys, app origin and notification prefs. */
  pushSet(setup: PushSetup): Promise<Ack> {
    return this.request((id) => ({
      t: "push_set",
      id,
      subscription: setup.subscription,
      vapid: setup.vapid,
      subject: setup.subject,
      prefs: setup.prefs,
    }));
  }

  /** Tells the Mac to forget this phone's push subscription. */
  pushClear(): Promise<Ack> {
    return this.request((id) => ({ t: "push_clear", id }));
  }

  /** Asks the Mac to send a test notification now. */
  pushTest(): Promise<Ack> {
    return this.request((id) => ({ t: "push_test", id }));
  }

  // ---- connection lifecycle ----

  private openSocket(): void {
    const Impl = this.WebSocketImpl ?? globalWebSocket();
    this.setState("connecting");
    let ws: WebSocketLike;
    try {
      if (!Impl) throw new Error("WebSocket is not available");
      ws = new Impl(toWsUrl(this.mac.url));
    } catch {
      this.setState("offline");
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      try {
        // The first frame must be hello; nothing else is sent before the welcome.
        const hello: ClientMsg = { t: "hello", v: PROTOCOL_VERSION, deviceId: this.mac.deviceId, token: this.mac.token };
        ws.send(JSON.stringify(hello));
      } catch {
        this.lost(ws);
      }
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.onFrame(event.data);
    };
    ws.onclose = () => this.lost(ws);
    ws.onerror = () => this.lost(ws); // the close event follows; whichever comes first wins
  }

  /** The socket ended by itself. A socket that was already replaced or closed on purpose is ignored. */
  private lost(ws: WebSocketLike): void {
    if (this.ws !== ws) return;
    this.teardown(new RemoteError("connection_lost"));
    if (!this.wanted || this.currentState === "unauthorized") return;
    this.setState("offline");
    this.scheduleRetry();
  }

  /** Drops the current socket without letting its events cause anything, stops the heartbeat, fails requests. */
  private teardown(reason: RemoteError): void {
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      detach(ws);
      try {
        ws.close(1000);
      } catch {
        // already closed
      }
    }
    this.stopHeartbeat();
    this.failAcks(reason);
  }

  private scheduleRetry(): void {
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, RETRY_MAX_MS);
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      if (this.wanted) this.openSocket();
    }, delay);
  }

  private clearRetry(): void {
    if (this.retryTimer === null) return;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Replaces the connection now, with the first delay if it fails again. */
  private reconnectNow(): void {
    if (!this.wanted || this.currentState === "unauthorized") return;
    this.clearRetry();
    this.teardown(new RemoteError("connection_lost"));
    this.backoff = RETRY_MIN_MS;
    this.openSocket();
  }

  private listenForWakeUps(): void {
    if (this.stopWakeListeners) return;
    const doc = this.env ? this.env.document : (globalThis as { document?: WakeEnv["document"] }).document;
    const win = this.env ? this.env.window : (globalThis as { window?: WakeEnv["window"] }).window;
    const onVisibility = () => {
      if (this.currentState === "open") this.sendVisibility();
      if (doc?.visibilityState === "visible") this.wake();
    };
    const onOnline = () => this.wake();
    doc?.addEventListener("visibilitychange", onVisibility);
    win?.addEventListener("online", onOnline);
    this.stopWakeListeners = () => {
      doc?.removeEventListener("visibilitychange", onVisibility);
      win?.removeEventListener("online", onOnline);
    };
  }

  /** Tells the Mac whether the app is in front, so it knows when the phone is looking. */
  private sendVisibility(): void {
    const doc = this.env ? this.env.document : (globalThis as { document?: WakeEnv["document"] }).document;
    this.sendFrame({ t: "visibility", visible: doc?.visibilityState === "visible" });
  }

  /** The app is in front again, or the network came back. */
  private wake(): void {
    if (!this.wanted || this.currentState === "unauthorized") return;
    if (this.currentState === "open") this.ping(PROBE_WITHIN_MS);
    else this.reconnectNow(); // waiting for a retry, or stuck connecting
  }

  // ---- heartbeat ----

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pingTimer = this.timers.setInterval(() => this.ping(PONG_WITHIN_MS), PING_EVERY_MS);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) this.timers.clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.clearPong();
  }

  private clearPong(): void {
    if (this.pongTimer !== null) this.timers.clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }

  /** Pings, and replaces the connection if nothing at all arrives within `within` ms. */
  private ping(within: number): void {
    if (!this.sendFrame({ t: "ping" })) return;
    this.clearPong();
    this.pongTimer = this.timers.setTimeout(() => {
      this.pongTimer = null;
      this.reconnectNow();
    }, within);
  }

  // ---- incoming frames ----

  private onFrame(data: unknown): void {
    const frame = parseFrame(data);
    if (!frame) return;
    this.clearPong(); // any frame proves the connection is alive
    switch (frame.t) {
      case "welcome":
        this.backoff = RETRY_MIN_MS;
        if (typeof frame.mac?.name === "string" && frame.mac.name) this.currentMacName = frame.mac.name;
        this.setState("open");
        this.startHeartbeat();
        // The Mac counts this socket as looking from the welcome until visibility says otherwise.
        this.sendVisibility();
        if (this.subscription) this.sendFrame({ t: "sub", ...this.subscription });
        this.emit("welcome", frame);
        break;
      case "projects":
        if (!Array.isArray(frame.projects)) break;
        this.currentProjects = frame.projects;
        this.emit("projects", frame.projects);
        break;
      // Session frames reach the listeners only for the session subscribed right now. A bridge of another
      // version may also send frames that lack parts; those are dropped instead of reaching the screens.
      case "snapshot":
        if (this.isSubscribed(frame) && Array.isArray(frame.messages)) {
          this.emit("snapshot", Array.isArray(frame.pending) ? frame : { ...frame, pending: [] });
        }
        break;
      case "msg":
        if (this.isSubscribed(frame) && frame.message && typeof frame.message === "object") this.emit("msg", frame);
        break;
      case "stream":
        if (this.isSubscribed(frame) && frame.event && typeof frame.event === "object") this.emit("stream", frame);
        break;
      case "pending":
        if (this.isSubscribed(frame) && Array.isArray(frame.pending)) this.emit("pending", frame);
        break;
      case "ack":
        this.onAck(frame);
        break;
      case "error":
        this.onError(frame);
        break;
      default: // pong, and frames of a newer protocol
        break;
    }
  }

  /**
   * Whether a session frame is about the session subscribed right now. The Mac answers `sub` asynchronously,
   * so a late snapshot of the previous session can arrive after the new one's, or after `unsubscribe()`;
   * passing it on would put that session's messages and prompts on the wrong screen.
   */
  private isSubscribed(frame: { project?: unknown; session?: unknown }): boolean {
    const current = this.subscription;
    return current !== null && frame.project === current.project && frame.session === current.session;
  }

  private onError(frame: ErrorFrame): void {
    const error: ErrorFrame = {
      ...frame,
      code: typeof frame.code === "string" && frame.code ? frame.code : "failed",
      message: typeof frame.message === "string" ? frame.message : "",
    };
    // The Mac won't take this phone: stop, the screens say to pair again. (The state changes first, so the
    // error's listeners see "unauthorized".)
    if (UNAUTHORIZED.has(error.code)) {
      this.setState("unauthorized");
      if (this.ws) this.lost(this.ws);
    }
    this.emit("error", error);
  }

  private onAck(ack: Ack): void {
    const pending = this.acks.get(ack.id);
    if (!pending) return;
    this.acks.delete(ack.id);
    this.timers.clearTimeout(pending.timer);
    if (ack.ok) pending.resolve(ack);
    else pending.reject(new RemoteError(ack.error || "failed", ack.error || "failed", typeof ack.status === "number" ? ack.status : undefined));
  }

  // ---- outgoing ----

  /** Sends a frame if the connection is open (welcomed); false otherwise. */
  private sendFrame(frame: ClientMsg): boolean {
    const ws = this.ws;
    if (!ws || this.currentState !== "open" || ws.readyState !== OPEN) return false;
    try {
      ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private request(build: (id: string) => ClientMsg, timeoutMs = ACK_TIMEOUT_MS): Promise<Ack> {
    return new Promise<Ack>((resolve, reject) => {
      if (this.currentState !== "open") {
        reject(new RemoteError("not_connected"));
        return;
      }
      const id = `r${++this.sequence}`;
      const timer = this.timers.setTimeout(() => {
        this.acks.delete(id);
        reject(new RemoteError("timeout"));
      }, timeoutMs);
      this.acks.set(id, { resolve, reject, timer });
      if (!this.sendFrame(build(id))) {
        this.acks.delete(id);
        this.timers.clearTimeout(timer);
        reject(new RemoteError("not_connected"));
      }
    });
  }

  private failAcks(reason: RemoteError): void {
    const pending = [...this.acks.values()];
    this.acks.clear();
    for (const ack of pending) {
      this.timers.clearTimeout(ack.timer);
      ack.reject(reason);
    }
  }

  // ---- events ----

  private setState(next: ClientState): void {
    if (this.currentState === next) return;
    this.currentState = next;
    this.emit("state", next);
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try {
        (listener as (payload: ClientEvents[K]) => void)(payload);
      } catch (error) {
        console.error(`[cce-remote] a "${event}" listener failed`, error);
      }
    }
  }
}

// ---- pairing ------------------------------------------------------------------------------------

export interface PairOptions {
  WebSocketImpl?: WebSocketCtor;
  timers?: Timers;
  /** Default 15 000. */
  timeoutMs?: number;
}

export interface PairResult {
  deviceId: string;
  token: string;
  macName: string;
}

/**
 * Pairs this phone with a Mac: sends the one-time code and gets the credentials back.
 * Rejects with a RemoteError: `bad_code` (and the other codes the Mac sends), `unreachable` (could not
 * connect: is Tailscale on?), `connection_lost`, `timeout`.
 */
export function pairWithMac(url: string, code: string, device: string, options: PairOptions = {}): Promise<PairResult> {
  const timers = options.timers ?? realTimers;
  const Impl = options.WebSocketImpl ?? globalWebSocket();
  return new Promise<PairResult>((resolve, reject) => {
    let ws: WebSocketLike | undefined;
    let timer: unknown;
    let opened = false;
    let settled = false;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      timers.clearTimeout(timer);
      if (ws) {
        detach(ws);
        try {
          ws.close(1000);
        } catch {
          // already closed
        }
      }
      settle();
    };

    timer = timers.setTimeout(() => finish(() => reject(new RemoteError("timeout"))), options.timeoutMs ?? PAIR_TIMEOUT_MS);
    try {
      if (!Impl) throw new Error("WebSocket is not available");
      ws = new Impl(toWsUrl(url));
    } catch {
      finish(() => reject(new RemoteError("unreachable")));
      return;
    }

    const socket = ws;
    socket.onopen = () => {
      opened = true;
      try {
        const pair: ClientMsg = { t: "pair", code, device };
        socket.send(JSON.stringify(pair));
      } catch {
        finish(() => reject(new RemoteError("connection_lost")));
      }
    };
    socket.onmessage = (event) => {
      const frame = parseFrame(event.data);
      if (!frame) return;
      if (frame.t === "paired") {
        const { deviceId, token, mac } = frame;
        if (typeof deviceId === "string" && deviceId && typeof token === "string" && token) {
          finish(() => resolve({ deviceId, token, macName: typeof mac?.name === "string" ? mac.name : "" }));
        } else {
          finish(() => reject(new RemoteError("bad_response")));
        }
      } else if (frame.t === "error") {
        finish(() => reject(new RemoteError(frame.code, frame.message)));
      }
    };
    const failed = () => finish(() => reject(new RemoteError(opened ? "connection_lost" : "unreachable")));
    socket.onclose = failed;
    socket.onerror = failed;
  });
}
