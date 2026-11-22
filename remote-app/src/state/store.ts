// The app's state and everything that changes it. The screens read `store.state` and call the methods;
// live data comes from a Source: RemoteClient for a paired Mac, DemoSource for `?demo`.

import { RemoteClient, RemoteError, pairWithMac, type ClientState } from "../lib/client";
import { loadMacs, removeMac as forgetMac, selectMac, selectedMacId, upsertMac, type Mac } from "../lib/macs";
import { defaultDeviceName, parsePairingInput, type PairingInput } from "../lib/pairing";
import { forgetReadState, loadReadState, markSeen, saveReadState, type ReadState } from "../lib/readstate";
import {
  currentSetup,
  isPushOn,
  loadPushPrefs,
  parseOpenLink,
  pushSupport,
  savePushPrefs,
  setBadgeCount,
  setPushOn,
  subscribePush,
  unsubscribePush,
  type PushEnv,
  type PushPrefs,
  type PushSetup,
  type PushSupport,
} from "../lib/push";
import type {
  Choice,
  ContentBlock,
  ErrorFrame,
  ImageUpload,
  MessageFrame,
  Pending,
  PendingFrame,
  PhoneMessage,
  Project,
  SessionState,
  SessionSummary,
  SlashCommand,
  SnapshotFrame,
  StreamFrame,
  UsageFrame,
  WelcomeFrame,
} from "../lib/protocol";
import { parseCommands } from "../lib/commands";
import { EMPTY_STREAM, applyStreamEvent, streamAfterMessage, type LocalMessage, type StreamState } from "../lib/transcript";
import { DEMO_MAC_ID, DEMO_MAC_NAME, DEMO_MAC_URL, DemoSource, type DemoOptions } from "./demo-source";
import { cleanName, errorCode, errorMessage, errorText, hostOf, isUnconfirmed } from "./format";
import type { Source } from "./source";

// ---- shapes -------------------------------------------------------------------------------------

export type Route =
  | { name: "home" }
  | { name: "session"; project: string; session: string }
  | { name: "new"; project: string }
  | { name: "pair" }
  | { name: "settings" }
  | { name: "readme" };

export type Nav = "push" | "pop" | "replace";

/** A message this phone sent, until the CLI's replay of it arrives. */
export interface Outgoing {
  text: string;
  images: ImageUpload[];
  /** sending: no ack yet; sent: the Mac took it; failed: see `error`. */
  status: "sending" | "sent" | "failed";
  error?: string;
}

export interface SessionView {
  /** Unique per view, so a late ack never lands in another session's view. */
  key: number;
  project: string;
  /** null for a new session until the Mac has created it. */
  session: string | null;
  loaded: boolean;
  messages: LocalMessage[];
  pending: Pending[];
  state: SessionState;
  live: boolean;
  truncatedBefore: number;
  stream: StreamState;
  outgoing: Record<string, Outgoing>;
  /** requestId → the choice being sent. */
  answering: Record<string, Choice["kind"]>;
  /** requestId → error code of the last failed answer. */
  answerErrors: Record<string, string>;
  /** A new session on its way: the first message went out, the session has no id here yet. */
  starting?: Starting;
}

/**
 * The new-session screen between its first message and the session's id. While "sending" or "started"
 * the composer holds: every message sent from here would start another session on the Mac.
 */
export interface Starting {
  /** sending: no ack yet; started: acked, but without the session's id; unconfirmed: the ack never came. */
  status: "sending" | "started" | "unconfirmed";
  /** The project's sessions before the first message: the new one is the first that isn't among them. */
  known: string[];
}

export interface PairFlow {
  input: PairingInput | null;
  /** The input came from the page's own `#pair=` link (opened in Safari, maybe outside the home-screen app). */
  fromLink: boolean;
  /** The person chose to pair in this browser although it isn't the home-screen app. */
  inBrowser: boolean;
  busy: boolean;
  error: string | null;
  /** The Mac's own text for `error`, when it sent one. */
  errorMessage: string;
}

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error" | "success";
}

/** Notifications on this phone and on the connected Mac. */
export interface PushState {
  support: PushSupport;
  /** Notifications are turned on on this phone. */
  on: boolean;
  busy: boolean;
  prefs: PushPrefs;
  /** Whether the connected Mac holds this phone's subscription. */
  mac: "on" | "off" | "unknown" | "unsupported";
  /** The Mac's error code for the last push_set. */
  error: string | null;
}

/** How a window's slash commands stand on this phone: being fetched, here, not to be had, or not offered by its Mac. */
export type CommandsStatus = "loading" | "ready" | "failed" | "unsupported";

/** A window's slash commands as this phone holds them; `at` is when they came (this phone's clock), 0 when stale. */
export interface CommandsEntry {
  status: CommandsStatus;
  list: SlashCommand[];
  at: number;
}

/** How long a window's slash commands count as fresh; older ones are asked for again, and shown meanwhile. */
export const COMMANDS_FRESH_MS = 60_000;
/** How long after a /clear (or /reset, /new) from the phone the screen follows Claude Code into the session it starts. */
const FOLLOW_CLEAR_MS = 30_000;
/** The commands that start a new session in the same VS Code tab: the phone follows them (the text, trimmed). */
const CLEARS = new Set(["/clear", "/reset", "/new"]);

export interface AppState {
  demo: boolean;
  macs: Mac[];
  macId: string | null;
  conn: ClientState;
  /** The Mac said remote access was turned off there (error "disabled"); cleared once the app is connected again. */
  remoteOff: boolean;
  /**
   * Why the Mac ended the last connection attempt: a refusal of this phone (bad_token, bad_origin, revoked:
   * then `conn` is "unauthorized") or another error before the welcome (unsupported_version, …). The
   * connection banner shows it; cleared once connected, or when an attempt ends without a word from the Mac.
   */
  refusal: { code: string; message: string } | null;
  projects: Project[];
  /** What this phone has read of the selected Mac's sessions; null until the Mac's first project list (and with no Mac). */
  read: ReadState | null;
  /** Claude Code's usage meter on the selected Mac, as last heard; null until the Mac sent one (an older Mac never does). */
  usage: UsageFrame | null;
  /** The selected Mac's windows' slash commands, by project id, as far as they were asked for. */
  commands: Record<string, CommandsEntry>;
  push: PushState;
  route: Route;
  nav: Nav;
  view: SessionView | null;
  pair: PairFlow;
  toasts: Toast[];
}

/** How often the app asks the Mac for fresh usage numbers while it is open and in front. */
export const USAGE_REFRESH_MS = 300_000;
/** Coming back to the front asks again only when the last ask is at least this old. */
export const USAGE_VISIBLE_MIN_MS = 60_000;
/** How often the refresh schedule looks whether an ask is due. */
const USAGE_TICK_MS = 30_000;

const EMPTY_PAIR: PairFlow = { input: null, fromLink: false, inBrowser: false, busy: false, error: null, errorMessage: "" };

/** Messages kept in memory per session view; older ones are dropped (the Mac sends the last 400 anyway). */
const MAX_MESSAGES = 800;
const KEEP_MESSAGES = 600;

export interface StoreOptions {
  demo: boolean;
  demoOptions?: DemoOptions;
  /** Makes the source for a Mac (tests); RemoteClient for a paired Mac, DemoSource for the demo by default. */
  createSource?: (mac: Mac, demo: boolean) => Source;
  /** The browser's push APIs (tests); the real ones by default. */
  pushEnv?: PushEnv;
  /** This phone's clock (tests); Date.now by default. */
  now?: () => number;
}

// ---- helpers ------------------------------------------------------------------------------------

export function findSession(projects: readonly Project[], project: string, session: string | null): SessionSummary | undefined {
  if (!session) return undefined;
  return projects.find((p) => p.id === project)?.sessions.find((s) => s.id === session);
}

export function waitingCount(projects: readonly Project[]): number {
  let count = 0;
  for (const project of projects) for (const session of project.sessions) if (session.state === "waiting") count++;
  return count;
}

function isRoute(value: unknown): value is Route {
  if (!value || typeof value !== "object") return false;
  const route = value as Record<string, unknown>;
  switch (route.name) {
    case "home":
    case "pair":
    case "settings":
    case "readme":
      return true;
    case "session":
      return typeof route.project === "string" && typeof route.session === "string";
    case "new":
      return typeof route.project === "string";
    default:
      return false;
  }
}

function newView(key: number, project: string, session: string | null): SessionView {
  return {
    key,
    project,
    session,
    loaded: session === null,
    messages: [],
    pending: [],
    state: "idle",
    live: false,
    truncatedBefore: 0,
    stream: EMPTY_STREAM,
    outgoing: {},
    answering: {},
    answerErrors: {},
  };
}

/** Text and photo count: how a replay is matched to a sent message when the ack named no uuid. */
function signatureOf(item: PhoneMessage | Outgoing): string {
  if ("status" in item) return `${item.images.length}|${item.text.trim()}`;
  const blocks = Array.isArray(item.content) ? item.content : [];
  const text = blocks
    .filter((b): b is Extract<ContentBlock, { type: "text" }> => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n\n")
    .trim();
  return `${blocks.filter((b) => b?.type === "image").length}|${text}`;
}

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** The text of a `#pair=` fragment, or null. */
export function pairFragment(hash: string): string | null {
  return /(?:^#|[#&])pair=/.test(hash) ? hash : null;
}

export function isStandalone(): boolean {
  try {
    if (window.matchMedia?.("(display-mode: standalone)").matches) return true;
  } catch {
    // no matchMedia
  }
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Whether the page is in front (no document: not). */
function pageVisible(): boolean {
  try {
    return typeof document !== "undefined" && document.visibilityState === "visible";
  } catch {
    return false;
  }
}

const demoMac = (): Mac => ({ id: DEMO_MAC_ID, name: DEMO_MAC_NAME, url: DEMO_MAC_URL, deviceId: DEMO_MAC_ID, token: "demo" });

// ---- the store ----------------------------------------------------------------------------------

export class Store {
  state: AppState;
  private readonly listeners = new Set<() => void>();
  private readonly demoOptions: DemoOptions | undefined;
  private readonly createSource: ((mac: Mac, demo: boolean) => Source) | undefined;
  private readonly pushEnv: PushEnv | undefined;
  private source: Source | null = null;
  private unwire: Array<() => void> = [];
  private readonly drafts = new Map<string, string>();
  private historyIndex = 0;
  /** Set while history.go() walks back to the first entry; applied on the next popstate. */
  private rootRoute: Route | null = null;
  private seq = 0;
  private toastSeq = 0;
  private viewSeq = 0;
  private started = false;
  /** The Mac sent an error during the current connection attempt (see AppState.refusal). */
  private refusedThisAttempt = false;
  /** This phone's clock. */
  private readonly now: () => number;
  /** The Mac's clock minus this phone's, from the last welcome (0 without one, or from an older Mac). */
  private skew = 0;
  /** When this phone last asked the Mac for fresh usage numbers (this phone's clock). */
  private usageAskedAt = -Infinity;
  /** When the last frame with content (projects, snapshot, message, stream, prompts) arrived (this phone's clock). */
  private lastFrameAt = -Infinity;
  private usageTimer: ReturnType<typeof setInterval> | null = null;
  /** The projects whose slash commands are being asked for (one request at a time each). */
  private readonly commandsInFlight = new Set<string>();
  /** Counts the Macs connected to: an answer about slash commands that comes after a switch is not this Mac's. */
  private connection = 0;
  /** After a /clear from the phone: the view, its window, the window's sessions then, and until when to follow. */
  private following: { key: number; project: string; known: Set<string>; until: number } | null = null;

  constructor(options: StoreOptions) {
    this.demoOptions = options.demoOptions;
    this.createSource = options.createSource;
    this.pushEnv = options.pushEnv;
    this.now = options.now ?? Date.now;
    const macs = options.demo ? [demoMac()] : loadMacs();
    const macId = options.demo ? DEMO_MAC_ID : selectedMacId();
    this.state = {
      demo: options.demo,
      macs,
      macId,
      conn: "offline",
      remoteOff: false,
      refusal: null,
      projects: [],
      read: null,
      usage: null,
      commands: {},
      push: {
        support: pushSupport(options.pushEnv),
        on: isPushOn(options.pushEnv),
        busy: false,
        prefs: loadPushPrefs(options.pushEnv),
        mac: "unknown",
        error: null,
      },
      route: macs.length ? { name: "home" } : { name: "pair" },
      nav: "replace",
      view: null,
      pair: EMPTY_PAIR,
      toasts: [],
    };
  }

  // ---- observing ----

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of [...this.listeners]) listener();
  }

  /** Changes the session view if it is still the one with `key` (the person may have moved on). */
  private patchView(key: number, change: (view: SessionView) => SessionView): void {
    const view = this.state.view;
    if (view && view.key === key) this.set({ view: change(view) });
  }

  get mac(): Mac | undefined {
    return this.state.macs.find((m) => m.id === this.state.macId);
  }

  /** The name to show for the selected Mac. */
  get macName(): string {
    return this.mac?.name ?? "your Mac";
  }

  /** The connected Mac's clock as this phone estimates it (from the welcome): what read state and ages are measured in. */
  macNow(): number {
    return this.now() + this.skew;
  }

  // ---- start and stop ----

  /** Reads the URL (`#pair=`, a notification's link, demo deep links), restores the route after a reload and connects. */
  start(): void {
    if (this.started) return;
    this.started = true;
    window.addEventListener("popstate", this.onPopState);
    document.addEventListener("visibilitychange", this.onVisibility);
    this.usageTimer = setInterval(() => this.usageTick(), USAGE_TICK_MS);

    const pairText = pairFragment(location.hash);
    const link = parseOpenLink(location.search);
    const saved: unknown = history.state?.cce;
    let route: Route = this.state.route;
    if (!pairText && isRoute(saved) && this.state.macs.length) route = saved;
    this.historyIndex = typeof history.state?.i === "number" ? history.state.i : 0;
    // The fragment carries a one-time code and a notification's link carries the session: neither stays
    // in the address or the history.
    history.replaceState({ cce: route, i: this.historyIndex }, "", link ? location.pathname : location.pathname + location.search);
    this.applyRoute(route, "replace");

    if (this.state.macId) this.connectTo(this.state.macId);
    if (link) this.openFromLink(link);
    if (pairText) this.beginPair(pairText, true);
    if (this.state.demo) this.demoDeepLink(new URLSearchParams(location.search));
  }

  stop(): void {
    window.removeEventListener("popstate", this.onPopState);
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.usageTimer !== null) clearInterval(this.usageTimer);
    this.usageTimer = null;
    this.dropSource();
    this.started = false;
  }

  /** `?demo&session=<id>`, `?demo&new=<project>`, `?demo&screen=pair|settings|readme` (screenshots, UI tests). */
  private demoDeepLink(params: URLSearchParams): void {
    const session = params.get("session");
    const project = params.get("new");
    const screen = params.get("screen");
    if (session) {
      const owner = this.source?.projects.find((p) => p.sessions.some((s) => s.id === session));
      if (owner) this.navigate({ name: "session", project: owner.id, session });
    } else if (project) {
      this.navigate({ name: "new", project });
    } else if (screen === "pair" || screen === "settings" || screen === "readme") {
      this.navigate({ name: screen });
    }
  }

  // ---- navigation ----

  navigate(route: Route, mode: "push" | "replace" = "push"): void {
    const url = location.pathname + location.search;
    if (mode === "push") {
      this.historyIndex++;
      history.pushState({ cce: route, i: this.historyIndex }, "", url);
    } else {
      history.replaceState({ cce: route, i: this.historyIndex }, "", url);
    }
    this.applyRoute(route, mode);
  }

  /** One screen back (the browser's back, so gestures and the back button agree). */
  back(): void {
    if (this.historyIndex > 0) history.back();
    else this.navigate(this.state.macs.length ? { name: "home" } : { name: "pair" }, "replace");
  }

  /** Goes to `route` as the first screen, dropping the screens in between (after pairing, removing a Mac). */
  navigateRoot(route: Route): void {
    if (this.historyIndex > 0) {
      this.rootRoute = route;
      history.go(-this.historyIndex);
    } else {
      this.navigate(route, "replace");
    }
  }

  private readonly onVisibility = (): void => {
    if (document.visibilityState === "visible") {
      this.refreshPushSupport();
      this.noteSeen();
      if (this.state.conn === "open" && this.now() - this.usageAskedAt >= USAGE_VISIBLE_MIN_MS) this.askUsage();
      return;
    }
    // Hidden now: the session on screen was seen until this moment.
    const shown = this.viewing(false);
    if (shown) this.markRead(shown);
  };

  private readonly onPopState = (event: PopStateEvent): void => {
    const state = event.state as { cce?: unknown; i?: unknown } | null;
    const index = typeof state?.i === "number" ? state.i : 0;
    const direction: Nav = index < this.historyIndex ? "pop" : "push";
    this.historyIndex = index;
    if (this.rootRoute) {
      const route = this.rootRoute;
      this.rootRoute = null;
      history.replaceState({ cce: route, i: this.historyIndex }, "", location.pathname + location.search);
      this.applyRoute(route, "pop");
      return;
    }
    const route = isRoute(state?.cce) ? state.cce : { name: "home" as const };
    this.applyRoute(route, direction);
  };

  private applyRoute(route: Route, nav: Nav): void {
    if (this.state.route.name === "session") this.noteSeen(); // the session on screen was seen until it goes
    let view = this.state.view;
    const keep = route.name === "session" && view !== null && view.project === route.project && view.session === route.session;
    if (!keep) {
      if (view?.session) this.source?.unsubscribe();
      view = null;
      if (route.name === "session") view = newView(++this.viewSeq, route.project, route.session);
      else if (route.name === "new") view = newView(++this.viewSeq, route.project, null);
    }
    const pair = route.name === "pair" ? this.state.pair : EMPTY_PAIR;
    this.set({ route, nav, view, pair });
    if (route.name === "session") this.source?.subscribe(route.project, route.session);
  }

  openSession(project: string, session: string): void {
    this.navigate({ name: "session", project, session });
  }

  /** Opens the session a notification was about, on the Mac that sent it (matched by its device id). */
  openFromLink(link: { mac: string; project: string; session: string }): void {
    const mac = this.state.macs.find((m) => m.deviceId === link.mac);
    if (!mac) return;
    if (mac.id !== this.state.macId) this.switchMac(mac.id);
    this.openSession(link.project, link.session);
  }

  newSession(project: string): void {
    this.navigate({ name: "new", project });
  }

  // ---- the connection ----

  private connectTo(id: string | null): void {
    this.dropSource();
    this.lastFrameAt = -Infinity;
    this.connection++;
    this.commandsInFlight.clear();
    this.following = null;
    const mac = this.state.macs.find((m) => m.id === id);
    this.skew = 0;
    if (!mac) {
      this.set({ macId: null, conn: "offline", remoteOff: false, refusal: null, projects: [], read: null, usage: null, commands: {} });
      this.updateBadge();
      this.updatePushBadge(this.state.projects);
      return;
    }
    this.set({ macId: mac.id, conn: "offline", remoteOff: false, refusal: null, projects: [], read: this.state.demo ? null : loadReadState(mac.id), usage: null, commands: {} });
    this.updateBadge();
    this.updatePushBadge(this.state.projects);
    if (this.createSource) this.useSource(this.createSource(mac, this.state.demo));
    else this.useSource(this.state.demo ? new DemoSource(this.demoOptions) : new RemoteClient(mac));
  }

  private useSource(source: Source): void {
    this.source = source;
    this.unwire = [
      source.on("state", (conn) => this.onState(conn)),
      source.on("welcome", (frame) => this.onWelcome(frame)),
      source.on("projects", (projects) => {
        this.lastFrameAt = this.now();
        this.set({ projects });
        this.updateBadge();
        this.updatePushBadge(projects);
        this.watchForStartedSession();
        this.followNewSession();
        this.ensureReadState();
        this.noteSeen();
      }),
      source.on("usage", (usage) => this.set({ usage })),
      source.on("snapshot", (frame) => this.onSnapshot(frame)),
      source.on("msg", (frame) => this.onMessage(frame)),
      source.on("stream", (frame) => this.onStream(frame)),
      source.on("pending", (frame) => this.onPending(frame)),
      source.on("error", (frame) => this.onError(frame)),
    ];
    this.set({ conn: source.state, projects: source.projects });
    const view = this.state.view;
    if (view?.session) source.subscribe(view.project, view.session);
    source.connect();
  }

  private onState(conn: ClientState): void {
    if (conn !== "open" && this.state.conn === "open") this.noteSeen(); // what is on screen was seen until the connection went
    if (conn === "open") {
      this.set({ conn, remoteOff: false, refusal: null });
      return;
    }
    if (conn === "connecting") this.refusedThisAttempt = false;
    // An attempt that ended without a word from the Mac (the network) makes the last attempt's reason stale.
    const stale = conn === "offline" && !this.refusedThisAttempt && this.state.refusal !== null;
    this.set(stale ? { conn, refusal: null } : { conn });
  }

  private dropSource(): void {
    for (const off of this.unwire) off();
    this.unwire = [];
    this.source?.close();
    this.source = null;
  }

  /** Try again now (after "offline" or "unauthorized"). */
  reconnect(): void {
    this.source?.connect();
  }

  // ---- slash commands ----

  /**
   * Asks the window for its slash commands, unless that isn't needed: not connected, its Mac doesn't offer them
   * (until the next welcome), a request is on its way, or the list is fresh (COMMANDS_FRESH_MS; an empty one never
   * is). A list it has stays on screen while a newer one is fetched, and when that fails.
   */
  loadCommands(project: string): void {
    const source = this.source;
    if (!source || this.state.conn !== "open" || this.commandsInFlight.has(project)) return;
    const entry = this.state.commands[project];
    if (entry?.status === "unsupported") return;
    // An empty list is never fresh: a window with no Claude Code webview yet, or with one still loading, has none.
    const hasList = entry?.status === "ready" && entry.list.length > 0;
    if (hasList && entry.at > 0 && this.now() - entry.at < COMMANDS_FRESH_MS) return;
    this.commandsInFlight.add(project);
    if (!hasList) this.setCommands(project, { status: "loading", list: [], at: 0 });
    const connection = this.connection;
    source.commands(project).then(
      (ack) => {
        if (this.connection !== connection) return; // another Mac by now
        this.commandsInFlight.delete(project);
        this.setCommands(project, { status: "ready", list: parseCommands(ack.commands), at: this.now() });
      },
      (error) => {
        if (this.connection !== connection) return;
        this.commandsInFlight.delete(project);
        const code = errorCode(error);
        if (code === "unknown_type" || code === "unknown_method") this.setCommands(project, { status: "unsupported", list: [], at: 0 });
        else if (this.state.commands[project]?.status !== "ready") this.setCommands(project, { status: "failed", list: [], at: 0 });
      },
    );
  }

  private setCommands(project: string, entry: CommandsEntry): void {
    this.set({ commands: { ...this.state.commands, [project]: entry } });
  }

  /** A new connection: every list is asked for again when next needed, and a Mac that didn't offer them is asked again. */
  private staleCommands(): void {
    const commands: Record<string, CommandsEntry> = {};
    for (const [project, entry] of Object.entries(this.state.commands)) if (entry.status !== "unsupported") commands[project] = { ...entry, at: 0 };
    this.set({ commands });
  }

  // ---- notifications ----

  /** The permission can change while the app is in the background (the Settings app): recompute it. */
  refreshPushSupport(): void {
    const support = pushSupport(this.pushEnv);
    if (support !== this.state.push.support) this.set({ push: { ...this.state.push, support } });
  }

  /**
   * A Mac is ready for requests. While notifications are on, the subscription, keys and prefs are sent
   * again; a subscription or permission that went away turns them off here. While they are off, a Mac
   * that still holds the subscription is told to drop it (the demo has none), so another paired Mac
   * doesn't keep a dead one until a push to it fails.
   */
  private async onWelcome(frame: WelcomeFrame): Promise<void> {
    this.skew = typeof frame.now === "number" && Number.isFinite(frame.now) ? frame.now - this.now() : 0;
    this.staleCommands();
    // Opening the app (each connection) asks for fresh usage numbers; not while the page is in the background.
    if (pageVisible()) this.askUsage();
    if (!this.state.push.on) {
      if (!this.state.demo && frame.push === true) this.clearPushOnMac();
      return;
    }
    let setup: PushSetup | null;
    try {
      setup = await currentSetup(this.state.push.prefs, this.pushEnv);
    } catch {
      // A read that timed out isn't "gone": leave notifications on until the next welcome.
      return;
    }
    if (!setup) {
      setPushOn(false, this.pushEnv);
      this.set({ push: { ...this.state.push, on: false, busy: false, mac: "unknown", error: null } });
      this.toast("Notifications were turned off on this iPhone", "info");
      this.clearPushOnMac();
      return;
    }
    await this.sendPushSetup(setup);
  }

  private async sendPushSetup(setup: PushSetup): Promise<void> {
    const source = this.source;
    if (!source || this.state.conn !== "open") return;
    try {
      await source.pushSet(setup);
      this.set({ push: { ...this.state.push, mac: "on", error: null } });
    } catch (error) {
      const code = errorCode(error);
      if (code === "unknown_type") this.set({ push: { ...this.state.push, mac: "unsupported", error: null } });
      else this.set({ push: { ...this.state.push, mac: "off", error: code } });
    }
  }

  private clearPushOnMac(): void {
    const source = this.source;
    if (!source || this.state.conn !== "open") return;
    void source.pushClear().catch(() => undefined);
  }

  /** Turns notifications on: the permission prompt and the subscription come first, then the Mac. */
  async enablePush(): Promise<void> {
    if (this.state.push.busy) return;
    this.set({ push: { ...this.state.push, busy: true, error: null } });
    let setup: PushSetup;
    try {
      setup = await subscribePush(this.state.push.prefs, this.pushEnv);
    } catch (error) {
      this.set({ push: { ...this.state.push, busy: false, support: pushSupport(this.pushEnv), error: errorCode(error) } });
      return;
    }
    setPushOn(true, this.pushEnv);
    this.set({ push: { ...this.state.push, on: true, busy: false, support: "ok", mac: "unknown", error: null } });
    await this.sendPushSetup(setup);
  }

  /** Turns notifications off: this phone's subscription goes, and the Mac forgets it. */
  async disablePush(): Promise<void> {
    setPushOn(false, this.pushEnv);
    this.set({ push: { ...this.state.push, on: false, busy: false, mac: "unknown", error: null } });
    await unsubscribePush(this.pushEnv);
    this.clearPushOnMac();
  }

  /** Saves a notification preference and sends the new setup to the connected Mac. */
  async setPushPref(key: keyof PushPrefs, value: boolean): Promise<void> {
    const prefs: PushPrefs = { ...this.state.push.prefs, [key]: value };
    savePushPrefs(prefs, this.pushEnv);
    this.set({ push: { ...this.state.push, prefs } });
    if (!this.state.push.on || !this.source || this.state.conn !== "open") return;
    let setup: PushSetup | null;
    try {
      setup = await currentSetup(prefs, this.pushEnv);
    } catch {
      // A read that timed out isn't "gone": the pref stays saved here and goes out on the next welcome.
      return;
    }
    if (setup) await this.sendPushSetup(setup);
  }

  /** Asks the connected Mac for a test notification and says how it went. */
  async testPush(): Promise<void> {
    const source = this.source;
    if (!source || this.state.conn !== "open") {
      this.toast(errorText("not_connected", this.macName), "error");
      return;
    }
    try {
      await source.pushTest();
      this.toast("Test notification sent.", "success");
    } catch (error) {
      const code = errorCode(error);
      const status = error instanceof RemoteError ? error.status : undefined;
      if (code === "push_off") {
        // The Mac may have lost this phone's subscription: send it again and retry once.
        let setup: PushSetup | null = null;
        if (this.state.push.on) {
          try {
            setup = await currentSetup(this.state.push.prefs, this.pushEnv);
          } catch {
            setup = null;
          }
        }
        if (setup) {
          await this.sendPushSetup(setup);
          try {
            await source.pushTest();
            this.toast("Test notification sent.", "success");
            return;
          } catch {
            // The Mac still doesn't have it.
          }
        }
        this.toast(`${this.macName} doesn't have this iPhone's notification setup yet. Turn notifications off and on again.`, "error");
      } else if (code === "unknown_type") {
        this.set({ push: { ...this.state.push, mac: "unsupported", error: null } });
        this.toast(`${this.macName}'s patch is too old for notifications. Update the patch on the Mac.`, "error");
      } else if (code === "push_gone") {
        setPushOn(false, this.pushEnv);
        this.set({ push: { ...this.state.push, on: false, mac: "unknown", error: null } });
        this.toast("Notifications were turned off on this iPhone", "info");
      } else if (code === "push_failed") {
        const reason = error instanceof RemoteError ? error.reason : undefined;
        this.toast(
          status === 0 && reason
            ? `Couldn't reach the push service (${reason}).`
            : status !== undefined
              ? `The push service didn't accept the test notification (status ${status}).`
              : "The push service didn't accept the test notification.",
          "error",
        );
      } else if (code === "demo") {
        this.toast("Notifications aren't available in the demo.", "info");
      } else {
        this.toast(errorText(code, this.macName), "error");
      }
    }
  }

  // ---- session events ----

  private viewFor(frame: { project: string; session: string }): SessionView | null {
    const view = this.state.view;
    return view && view.project === frame.project && view.session === frame.session ? view : null;
  }

  private onSnapshot(frame: SnapshotFrame): void {
    this.lastFrameAt = this.now();
    const view = this.viewFor(frame);
    if (!view) return;
    // Messages this phone sent and the Mac hasn't replayed yet stay below the history.
    const locals = view.messages.filter((m) => m.local);
    const known = new Set(frame.messages.map((m) => m.uuid));
    this.set({
      view: {
        ...view,
        loaded: true,
        messages: [...frame.messages, ...locals.filter((m) => !known.has(m.uuid))],
        outgoing: Object.fromEntries(Object.entries(view.outgoing).filter(([uuid]) => !known.has(uuid))),
        pending: frame.pending,
        state: frame.state,
        live: frame.live,
        truncatedBefore: frame.truncatedBefore,
        stream: EMPTY_STREAM,
      },
    });
    this.noteSeen();
  }

  private onMessage(frame: MessageFrame): void {
    this.lastFrameAt = this.now();
    const view = this.viewFor(frame);
    if (!view) return;
    const message = frame.message;
    let messages = view.messages;
    let outgoing = view.outgoing;
    const index = message.uuid ? messages.findIndex((m) => m.uuid === message.uuid && !m.local) : -1;
    messages = index >= 0 ? messages.map((m, i) => (i === index ? message : m)) : [...messages, message];
    if (message.uuid && outgoing[message.uuid]) {
      // The CLI's replay of a message sent from here: the real one replaces the local copy.
      messages = messages.filter((m) => !(m.local && m.uuid === message.uuid));
      outgoing = without(outgoing, message.uuid);
    } else if (message.type === "user" && message.isReplay) {
      // A replay for a message whose ack named no uuid: matched by its text and photo count instead.
      const signature = signatureOf(message);
      const match = Object.entries(outgoing).find(([id, o]) => id.startsWith("local-") && o.status === "sent" && signatureOf(o) === signature);
      if (match) {
        messages = messages.filter((m) => !(m.local && m.uuid === match[0]));
        outgoing = without(outgoing, match[0]);
      }
    }
    let truncatedBefore = view.truncatedBefore;
    if (messages.length > MAX_MESSAGES) {
      truncatedBefore += messages.length - KEEP_MESSAGES;
      messages = messages.slice(-KEEP_MESSAGES);
    }
    this.set({ view: { ...view, messages, outgoing, truncatedBefore, stream: streamAfterMessage(view.stream, message) } });
    this.noteSeen();
  }

  private onStream(frame: StreamFrame): void {
    this.lastFrameAt = this.now();
    const view = this.viewFor(frame);
    if (!view) return;
    const stream = applyStreamEvent(view.stream, frame.event);
    if (stream !== view.stream) this.set({ view: { ...view, stream } });
  }

  private onPending(frame: PendingFrame): void {
    this.lastFrameAt = this.now();
    const view = this.viewFor(frame);
    if (!view) return;
    const open = new Set(frame.pending.map((p) => p.requestId));
    const keepOpen = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).filter(([id]) => open.has(id)));
    this.set({ view: { ...view, pending: frame.pending, answering: keepOpen(view.answering), answerErrors: keepOpen(view.answerErrors) } });
    this.noteSeen();
  }

  private onError(frame: ErrorFrame): void {
    // Remote access was turned off on the Mac: the connection banner says so while the app retries.
    if (frame.code === "disabled") {
      this.set({ remoteOff: true });
      return;
    }
    // A refusal of this phone (the client is "unauthorized" by now) or an error before the welcome: the
    // connection banner says why, not a toast for every retry.
    if (this.state.conn !== "open") {
      this.refusedThisAttempt = true;
      this.set({ refusal: { code: frame.code, message: frame.message } });
      return;
    }
    // A snapshot that failed only matters to the screen that asked for it.
    if (frame.code === "snapshot_failed") {
      const view = this.state.view;
      if (view?.project !== frame.project || view?.session !== frame.session) return;
    }
    this.toast(errorText(frame.code, this.macName, frame.message), "error");
  }

  // ---- actions ----

  draft(key: string): string {
    return this.drafts.get(key) ?? "";
  }

  setDraft(key: string, text: string): void {
    if (text) this.drafts.set(key, text);
    else this.drafts.delete(key);
  }

  /** Whether the open screen takes a message now (the new-session screen holds while its session starts). */
  canSend(): boolean {
    const view = this.state.view;
    if (!view || !this.source) return false;
    if (view.session !== null) return true;
    if (view.starting && view.starting.status !== "unconfirmed") return false;
    return this.state.projects.some((p) => p.id === view.project);
  }

  /** Sends a message to the open session, or starts the new session. Shown at once as "sending…". */
  async send(text: string, images: ImageUpload[]): Promise<void> {
    const view = this.state.view;
    const source = this.source;
    if (!view || !source) return;
    // One new session at a time: until the Mac names it, every message from here would start another one.
    // The project's listed sessions are what the new one is told apart from.
    if (!this.canSend()) return;
    const isNew = view.session === null;
    const known = isNew ? (this.state.projects.find((p) => p.id === view.project)?.sessions.map((s) => s.id) ?? []) : [];
    const local = `local-${++this.seq}`;
    const content: ContentBlock[] = images.map((): ContentBlock => ({ type: "image", omitted: true }));
    if (text) content.push({ type: "text", text });
    const message: LocalMessage = { uuid: local, type: "user", content, local: "sending" };
    this.set({
      view: {
        ...view,
        messages: [...view.messages, message],
        outgoing: { ...view.outgoing, [local]: { text, images, status: "sending" } },
        ...(isNew ? { starting: { status: "sending" as const, known } } : {}),
      },
    });
    const { key, project, session } = view;
    // A /clear (or /reset, /new) starts a new session in the same VS Code tab: the sessions listed now are what it is
    // told apart from (taken before the answer, which can come after the new session is listed).
    const clearing = session !== null && CLEARS.has(text.trim()) ? this.sessionIdsOf(project) : null;
    try {
      const ack = await source.send(project, session, text, images);
      // The ack names the uuid the CLI will replay; until that replay arrives the local copy stands in.
      const uuid = ack.uuid || local;
      this.patchView(key, (v) => {
        const entry = v.outgoing[local];
        if (!entry) return v;
        const outgoing = without(v.outgoing, local);
        const replayed = uuid !== local && v.messages.some((m) => !m.local && m.uuid === uuid);
        if (replayed) {
          return { ...v, outgoing, messages: v.messages.filter((m) => m.uuid !== local) };
        }
        return {
          ...v,
          outgoing: { ...outgoing, [uuid]: { ...entry, status: "sent" } },
          messages: v.messages.map((m) => (m.uuid === local ? { ...m, uuid } : m)),
        };
      });
      if (session === null) {
        if (ack.session) {
          this.adoptSession(key, ack.session);
        } else {
          // The Mac started it but couldn't name it in time: it shows up in the project list soon.
          this.patchView(key, (v) => ({ ...v, starting: { status: "started", known } }));
          this.watchForStartedSession();
        }
      }
      if (clearing) {
        this.following = { key, project, known: clearing, until: this.now() + FOLLOW_CLEAR_MS };
        this.followNewSession();
      }
    } catch (error) {
      const code = errorCode(error);
      // No answer in time, or a connection that closed first: the message may have arrived anyway.
      const doubtful = isUnconfirmed(code);
      this.patchView(key, (v) => {
        const entry = v.outgoing[local];
        if (!entry) return v;
        return {
          ...v,
          outgoing: { ...v.outgoing, [local]: { ...entry, status: "failed", error: code } },
          messages: v.messages.map((m) => (m.uuid === local ? { ...m, local: "failed" } : m)),
          // Not confirmed may still have started the session: keep watching for it. Anything else started nothing.
          ...(session === null ? { starting: doubtful ? { status: "unconfirmed" as const, known } : undefined } : {}),
        };
      });
      if (session === null && doubtful) this.watchForStartedSession();
      if (this.state.view?.key !== key) {
        this.toast(
          doubtful ? `${this.macName} didn't confirm your message. It may have arrived.` : `Your message wasn't sent. ${errorText(code, this.macName)}`,
          "error",
        );
      }
    }
  }

  /** The session ids the project lists right now. */
  private sessionIdsOf(project: string): Set<string> {
    return new Set(this.state.projects.find((p) => p.id === project)?.sessions.map((s) => s.id) ?? []);
  }

  /**
   * After a /clear from the phone: once the window lists a session that wasn't there, within FOLLOW_CLEAR_MS, the
   * screen moves to it, as the VS Code tab did. The watch ends when it fires, when time is up, and when the screen
   * changes; a /clear that starts no session (a user command of that name) changes nothing.
   */
  private followNewSession(): void {
    const following = this.following;
    if (!following) return;
    if (this.state.view?.key !== following.key || this.now() >= following.until) {
      this.following = null;
      return;
    }
    const listed = this.state.projects.find((p) => p.id === following.project);
    const fresh = listed?.sessions.filter((s) => !following.known.has(s.id)) ?? [];
    if (fresh.length === 0) return;
    const newest = fresh.reduce((a, b) => (b.lastModified > a.lastModified ? b : a));
    this.following = null;
    this.navigate({ name: "session", project: following.project, session: newest.id }, "replace");
    this.toast("Continuing in the new session");
  }

  /** The new-session screen becomes the session's screen: same view, its draft carried over. */
  private adoptSession(key: number, session: string): void {
    const view = this.state.view;
    if (!view || view.key !== key || view.session !== null) return;
    // A first message that wasn't confirmed did arrive after all: the session shows it, its local copy goes.
    const doubtful = Object.entries(view.outgoing)
      .filter(([, o]) => o.status === "failed" && o.error !== undefined && isUnconfirmed(o.error))
      .map(([id]) => id);
    const outgoing = Object.fromEntries(Object.entries(view.outgoing).filter(([id]) => !doubtful.includes(id)));
    const messages = view.messages.filter((m) => !(m.local && doubtful.includes(m.uuid)));
    this.moveDraft(`${view.project}/new`, `${view.project}/${session}`);
    this.set({ view: { ...view, session, loaded: false, starting: undefined, outgoing, messages } });
    this.navigate({ name: "session", project: view.project, session }, "replace");
  }

  /** While a started session has no id here yet: the first session of its project that wasn't there before. */
  private watchForStartedSession(): void {
    const view = this.state.view;
    if (!view || view.session !== null || !view.starting || view.starting.status === "sending") return;
    const listed = this.state.projects.find((p) => p.id === view.project);
    if (!listed) return;
    const known = new Set(view.starting.known);
    const fresh = listed.sessions.filter((s) => !known.has(s.id));
    if (fresh.length === 0) return;
    const newest = fresh.reduce((a, b) => (b.lastModified > a.lastModified ? b : a));
    this.adoptSession(view.key, newest.id);
  }

  private moveDraft(from: string, to: string): void {
    const text = this.drafts.get(from);
    if (text === undefined) return;
    this.drafts.delete(from);
    if (!this.drafts.get(to)) this.drafts.set(to, text);
  }

  /** "Send again" for a message that failed or was not confirmed. Never automatic: it may have arrived. */
  retry(uuid: string): void {
    const view = this.state.view;
    const entry = view?.outgoing[uuid];
    if (!view || !entry) return;
    this.discard(uuid);
    void this.send(entry.text, entry.images);
  }

  discard(uuid: string): void {
    const view = this.state.view;
    if (!view) return;
    this.set({ view: { ...view, outgoing: without(view.outgoing, uuid), messages: view.messages.filter((m) => !(m.local && m.uuid === uuid)) } });
  }

  async answer(pending: Pending, choice: Choice): Promise<void> {
    const view = this.state.view;
    const source = this.source;
    if (!view?.session || !source || view.answering[pending.requestId]) return;
    const { key, project, session } = view;
    const id = pending.requestId;
    this.set({ view: { ...view, answering: { ...view.answering, [id]: choice.kind }, answerErrors: without(view.answerErrors, id) } });
    try {
      await source.answer(project, session, id, choice);
      // The Mac sends the new list too; dropping it here keeps the card from lingering until then.
      this.patchView(key, (v) => ({ ...v, pending: v.pending.filter((p) => p.requestId !== id), answering: without(v.answering, id) }));
    } catch (error) {
      const code = errorCode(error);
      if (code === "not_pending") {
        this.patchView(key, (v) => ({ ...v, pending: v.pending.filter((p) => p.requestId !== id), answering: without(v.answering, id) }));
        this.toast(errorText(code), "info");
      } else {
        this.patchView(key, (v) => ({ ...v, answering: without(v.answering, id), answerErrors: { ...v.answerErrors, [id]: code } }));
      }
    }
  }

  async interrupt(): Promise<void> {
    const view = this.state.view;
    if (!view?.session || !this.source) return;
    try {
      await this.source.interrupt(view.project, view.session);
    } catch (error) {
      const code = errorCode(error);
      const why = errorText(code, this.macName);
      this.toast(isUnconfirmed(code) ? `The stop wasn't confirmed. ${why}` : `Couldn't stop: ${why}`, "error");
    }
  }

  async openOnMac(project: string, session: string): Promise<void> {
    if (!this.source) return;
    try {
      await this.source.open(project, session);
      this.toast(`Opened in VS Code on ${this.macName}`, "success");
    } catch (error) {
      this.toast(errorText(errorCode(error), this.macName), "error");
    }
  }

  async openClaude(project: string): Promise<void> {
    if (!this.source) return;
    try {
      await this.source.openClaude(project);
      this.toast(`Opening Claude Code on ${this.macName}`, "success");
    } catch (error) {
      this.toast(errorText(errorCode(error), this.macName), "error");
    }
  }

  // ---- pairing ----

  /** Reads a scanned, pasted or typed pairing and shows the confirmation (false: not a pairing). */
  beginPair(text: string, fromLink = false): boolean {
    const input = parsePairingInput(text);
    if (this.state.route.name !== "pair") this.navigate({ name: "pair" }, this.state.macs.length ? "push" : "replace");
    this.set({ pair: { ...EMPTY_PAIR, input, fromLink, error: input ? null : "invalid" } });
    return input !== null;
  }

  pairInBrowser(): void {
    this.set({ pair: { ...this.state.pair, inBrowser: true } });
  }

  cancelPair(): void {
    this.set({ pair: EMPTY_PAIR });
  }

  clearPairError(): void {
    if (this.state.pair.error) this.set({ pair: { ...this.state.pair, error: null, errorMessage: "" } });
  }

  async confirmPair(): Promise<void> {
    const { input, busy } = this.state.pair;
    if (!input || busy) return;
    this.set({ pair: { ...this.state.pair, busy: true, error: null, errorMessage: "" } });
    if (this.state.demo) {
      await new Promise((resolve) => setTimeout(resolve, 600));
      this.set({ pair: EMPTY_PAIR });
      this.navigateRoot({ name: "home" });
      this.toast("Demo: nothing was paired", "info");
      return;
    }
    try {
      const result = await pairWithMac(input.url, input.code, defaultDeviceName());
      const name = cleanName(result.macName || input.name, hostOf(input.url));
      const mac: Mac = { id: result.deviceId, name, url: input.url, deviceId: result.deviceId, token: result.token };
      const macs = upsertMac(mac);
      selectMac(mac.id);
      this.set({ macs, pair: EMPTY_PAIR });
      this.connectTo(mac.id);
      this.navigateRoot({ name: "home" });
      this.toast(`Paired with ${name}`, "success");
    } catch (error) {
      this.set({ pair: { ...this.state.pair, busy: false, error: errorCode(error), errorMessage: errorMessage(error) } });
    }
  }

  // ---- Macs ----

  switchMac(id: string): void {
    if (this.state.demo || id === this.state.macId) return;
    selectMac(id);
    this.connectTo(id);
    this.navigateRoot({ name: "home" });
  }

  renameMac(id: string, name: string): void {
    const mac = this.state.macs.find((m) => m.id === id);
    if (!mac) return;
    const clean = cleanName(name, mac.name);
    if (clean === mac.name) return;
    // The demo's Mac lives in memory only.
    const macs = this.state.demo ? this.state.macs.map((m) => (m.id === id ? { ...m, name: clean } : m)) : upsertMac({ ...mac, name: clean });
    this.set({ macs });
  }

  removeMac(id: string): void {
    const mac = this.state.macs.find((m) => m.id === id);
    if (!mac) return;
    if (this.state.demo) {
      this.toast("This is the demo: nothing was removed", "info");
      return;
    }
    const macs = forgetMac(id);
    forgetReadState(id);
    this.set({ macs });
    // This Mac's waiting count is gone with it.
    void setBadgeCount(mac.deviceId, 0, this.pushEnv);
    if (this.state.macId === id) {
      const next = selectedMacId();
      this.connectTo(next);
      this.set({ macId: next });
      if (!next) this.navigateRoot({ name: "pair" });
    }
    this.toast(`Removed ${mac.name}`, "info");
  }

  // ---- Claude Code's usage meter ----

  /** Asks the connected Mac for fresh usage numbers (it answers with a usage frame). */
  private askUsage(): void {
    if (!this.source || this.state.conn !== "open") return;
    this.usageAskedAt = this.now();
    this.source.usageRefresh();
  }

  /** The refresh schedule's tick (every 30 s): asks again once the last ask is USAGE_REFRESH_MS old, while open and in front. */
  usageTick(): void {
    if (this.state.conn === "open" && pageVisible() && this.now() - this.usageAskedAt >= USAGE_REFRESH_MS) this.askUsage();
  }

  // ---- what this phone has read ----

  /** The selected Mac's first project list starts its read state: everything up to now counts as read. */
  private ensureReadState(): void {
    const macId = this.state.macId;
    if (this.state.read || !macId) return;
    const read: ReadState = { baseline: this.macNow(), seen: {} };
    if (!this.state.demo) saveReadState(macId, read);
    this.set({ read });
  }

  /**
   * The session the session screen shows right now, or null: the route is that session, its snapshot is in,
   * the Mac is connected, and (with `requireVisible`) the page is in front.
   */
  private viewing(requireVisible: boolean): string | null {
    const { route, view, conn } = this.state;
    if (route.name !== "session" || !view || !view.loaded || view.session !== route.session || conn !== "open") return null;
    if (requireVisible && !pageVisible()) return null;
    return route.session;
  }

  /**
   * The session was on screen: read up to the last frame that reached it (not "now": back from the background, a
   * screen shows what came before the phone was locked until the connection is checked), and at least up to the
   * session's last activity in the list on screen, in the Mac's own clock (whatever the estimate of that clock).
   */
  private markRead(sessionId: string): void {
    const read = this.state.read;
    const macId = this.state.macId;
    if (!read || !macId) return;
    const route = this.state.route;
    const listed = route.name === "session" ? (findSession(this.state.projects, route.project, sessionId)?.lastModified ?? -Infinity) : -Infinity;
    const at = Math.max(Math.min(this.macNow(), this.lastFrameAt + this.skew), listed);
    if (!Number.isFinite(at)) return;
    const next = markSeen(read, sessionId, at);
    if (next === read) return;
    if (!this.state.demo) saveReadState(macId, next);
    this.set({ read: next });
  }

  /** Marks the session on screen as read up to now, if one is. */
  private noteSeen(): void {
    const shown = this.viewing(true);
    if (shown) this.markRead(shown);
  }

  // ---- badge and toasts ----

  private updateBadge(): void {
    const waiting = waitingCount(this.state.projects);
    document.title = waiting > 0 ? `(${waiting}) CCE Remote` : "CCE Remote";
  }

  /** The home-screen badge sums the waiting sessions of every paired Mac, as last heard from each. */
  private updatePushBadge(projects: readonly Project[]): void {
    const mac = this.mac;
    if (!mac) return;
    void setBadgeCount(mac.deviceId, waitingCount(projects), this.pushEnv);
  }

  toast(text: string, tone: Toast["tone"] = "info"): void {
    const id = ++this.toastSeq;
    this.set({ toasts: [...this.state.toasts.slice(-2), { id, text, tone }] });
    setTimeout(() => {
      if (this.state.toasts.some((t) => t.id === id)) this.set({ toasts: this.state.toasts.filter((t) => t.id !== id) });
    }, 3600);
  }
}
