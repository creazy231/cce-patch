// `?demo`: a pretend Mac on the built-in fixtures (lib/demo.ts). It follows the client's contract — session
// events only for the subscribed session, acks with `uuid`/`session`, `not_pending`, `not_connected` — and
// plays a little life into the data: the running session streams, a sent message is replayed and answered.
// Nothing leaves the page.

import { RemoteError, type ClientEvents, type ClientState } from "../lib/client";
import { demoProjects, demoSnapshot } from "../lib/demo";
import type { Ack, Choice, ContentBlock, ImageUpload, Pending, PhoneMessage, Project, SessionState, StreamEvent } from "../lib/protocol";
import type { Source } from "./source";

export const DEMO_MAC_ID = "demo-mac";
export const DEMO_MAC_NAME = "example-mac";
export const DEMO_MAC_URL = "https://example-mac.tailnet-0000.ts.net:47821";

/** The session that is "running" in the fixtures: it streams when opened. */
const STREAMING_SESSION = "demo-session-ratelimit";
const STREAMING_TEXT =
  "The linter is happy with the new middleware. Next I'll add tests for the limit itself: the 61st request inside a minute should get a `429`, and `Retry-After` should count down to the next free slot.";

const REPLY_TO_MESSAGE =
  "This is demo data, so your message stayed on this phone. With a paired Mac, Claude Code answers here, and the same session updates in VS Code.";

function replyTo(choice: Choice): string {
  switch (choice.kind) {
    case "allow":
    case "allowAlways":
      return "Approved. In a real session the tool runs now, and its result shows up right here.";
    case "deny":
      return choice.reason ? `Understood, I won't do that. You said: “${choice.reason}”` : "Understood, I stopped there.";
    case "answers":
      return `Thanks, noted: ${Object.values(choice.answers).join("; ")}.`;
    case "approveAuto":
    case "approveManual":
      return "Plan approved. Starting with step 1: the compatibility layer.";
    case "keepPlanning":
      return choice.feedback ? `Good point. I'll rework the plan: “${choice.feedback}”` : "OK, I'll keep planning.";
    case "cancel":
      return "Cancelled.";
  }
}

interface SessionData {
  project: string;
  messages: PhoneMessage[];
  pending: Pending[];
  live: boolean;
}

type Listener = (payload: never) => void;
type Timer = ReturnType<typeof setTimeout>;

export interface DemoOptions {
  /** Multiplies every delay; 0 makes the demo answer on the next tick (tests). */
  speed?: number;
  /** Stream the running session when it is opened (default true). */
  liveStream?: boolean;
}

export class DemoSource implements Source {
  private current: ClientState = "offline";
  private list: Project[];
  private readonly data = new Map<string, SessionData>();
  private readonly listeners = new Map<keyof ClientEvents, Set<Listener>>();
  private readonly timers = new Set<Timer>();
  private sub: { project: string; session: string } | null = null;
  private streamTimer: Timer | null = null;
  private seq = 0;
  private readonly speed: number;
  private readonly liveStream: boolean;

  constructor(options: DemoOptions = {}) {
    this.speed = options.speed ?? 1;
    this.liveStream = options.liveStream ?? true;
    this.list = structuredClone(demoProjects);
    for (const project of this.list) {
      for (const session of project.sessions) {
        const snapshot = demoSnapshot(session.id);
        this.data.set(session.id, {
          project: project.id,
          messages: structuredClone(snapshot.messages),
          pending: structuredClone(snapshot.pending),
          live: snapshot.live,
        });
      }
    }
  }

  get state(): ClientState {
    return this.current;
  }

  get projects(): Project[] {
    return this.list;
  }

  get macName(): string {
    return DEMO_MAC_NAME;
  }

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const entry = listener as Listener;
    set.add(entry);
    return () => {
      set.delete(entry);
    };
  }

  connect(): void {
    if (this.current === "open" || this.current === "connecting") return;
    this.setState("connecting");
    this.later(() => {
      this.setState("open");
      this.emit("projects", this.list);
      if (this.sub) this.sendSnapshot(this.sub.session);
    }, 160);
  }

  close(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.stopStream();
    this.setState("offline");
  }

  subscribe(project: string, session: string): void {
    if (this.sub && this.sub.project === project && this.sub.session === session) return;
    this.stopStream();
    this.sub = { project, session };
    if (this.current === "open") this.later(() => this.sendSnapshot(session), 90);
  }

  unsubscribe(): void {
    this.sub = null;
    this.stopStream();
  }

  send(project: string, session: string | null, text: string, images: ImageUpload[] = []): Promise<Ack> {
    if (this.current !== "open") return Promise.reject(new RemoteError("not_connected"));
    return new Promise((resolve, reject) => {
      this.later(() => {
        const target = this.list.find((p) => p.id === project);
        if (!target) {
          reject(new RemoteError("gone"));
          return;
        }
        let id = session;
        if (id === null) {
          id = `demo-session-new-${++this.seq}`;
          const title = text.split("\n")[0]?.trim().slice(0, 60) || "New session";
          this.data.set(id, { project, messages: [], pending: [], live: true });
          this.updateProject(project, (p) => ({
            ...p,
            claudeOpen: true,
            sessions: [{ id: id as string, title, lastModified: Date.now(), state: "running", live: true, pendingCount: 0 }, ...p.sessions],
          }));
        } else if (!this.data.has(id)) {
          reject(new RemoteError("gone"));
          return;
        }
        const uuid = `demo-user-${++this.seq}`;
        const sessionId = id;
        resolve({ t: "ack", id: `demo-${this.seq}`, ok: true, session: sessionId, uuid });

        const content: ContentBlock[] = [...images.map((): ContentBlock => ({ type: "image", omitted: true }))];
        if (text) content.push({ type: "text", text });
        this.later(() => {
          this.addMessage(sessionId, { uuid, type: "user", isReplay: true, content });
          this.setSessionState(sessionId, "running");
          this.reply(sessionId, REPLY_TO_MESSAGE);
        }, 420);
      }, 260);
    });
  }

  answer(_project: string, session: string, requestId: string, choice: Choice): Promise<Ack> {
    if (this.current !== "open") return Promise.reject(new RemoteError("not_connected"));
    return new Promise((resolve, reject) => {
      this.later(() => {
        const data = this.data.get(session);
        if (!data || !data.pending.some((p) => p.requestId === requestId)) {
          reject(new RemoteError("not_pending"));
          return;
        }
        data.pending = data.pending.filter((p) => p.requestId !== requestId);
        resolve({ t: "ack", id: `demo-${++this.seq}`, ok: true });
        this.emitForSession(session, "pending", { t: "pending", project: data.project, session, pending: data.pending });
        this.updateSession(session, (s) => ({ ...s, pendingCount: data.pending.length }));
        if (data.pending.length > 0) return;
        this.setSessionState(session, "running");
        this.reply(session, replyTo(choice));
      }, 240);
    });
  }

  interrupt(_project: string, session: string): Promise<Ack> {
    if (this.current !== "open") return Promise.reject(new RemoteError("not_connected"));
    return new Promise((resolve) => {
      this.later(() => {
        resolve({ t: "ack", id: `demo-${++this.seq}`, ok: true });
        if (this.sub?.session === session) this.stopStream();
        this.addMessage(session, { uuid: `demo-int-${++this.seq}`, type: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] });
        const data = this.data.get(session);
        if (data) {
          data.pending = [];
          this.emitForSession(session, "pending", { t: "pending", project: data.project, session, pending: [] });
        }
        this.updateSession(session, (s) => ({ ...s, pendingCount: 0 }));
        this.setSessionState(session, "idle");
      }, 200);
    });
  }

  open(): Promise<Ack> {
    return this.simpleAck();
  }

  openClaude(project: string): Promise<Ack> {
    const ack = this.simpleAck();
    ack.then(
      () => this.updateProject(project, (p) => ({ ...p, claudeOpen: true })),
      () => undefined,
    );
    return ack;
  }

  // ---- internals ----

  private simpleAck(): Promise<Ack> {
    if (this.current !== "open") return Promise.reject(new RemoteError("not_connected"));
    return new Promise((resolve) => this.later(() => resolve({ t: "ack", id: `demo-${++this.seq}`, ok: true }), 220));
  }

  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms * this.speed);
    this.timers.add(timer);
  }

  private setState(next: ClientState): void {
    if (this.current === next) return;
    this.current = next;
    this.emit("state", next);
  }

  private emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as (payload: ClientEvents[K]) => void)(payload);
  }

  /** Session events reach the screens only for the session subscribed right now (as with the real client). */
  private emitForSession<K extends "msg" | "stream" | "pending" | "snapshot">(session: string, event: K, payload: ClientEvents[K]): void {
    if (this.current === "open" && this.sub?.session === session) this.emit(event, payload);
  }

  private sendSnapshot(session: string): void {
    const data = this.data.get(session);
    const summary = this.findSession(session);
    this.emitForSession(session, "snapshot", {
      t: "snapshot",
      project: this.sub?.project ?? data?.project ?? "",
      session,
      messages: structuredClone(data?.messages ?? []),
      pending: structuredClone(data?.pending ?? []),
      state: summary?.state ?? "idle",
      live: data?.live ?? false,
      truncatedBefore: 0,
    });
    if (session === STREAMING_SESSION && summary?.state === "running" && this.liveStream) this.stream(session, STREAMING_TEXT, null);
  }

  private addMessage(session: string, message: PhoneMessage): void {
    const data = this.data.get(session);
    if (!data) return;
    data.messages.push(message);
    this.emitForSession(session, "msg", { t: "msg", project: data.project, session, message });
    this.updateSession(session, (s) => ({ ...s, lastModified: Date.now() }));
  }

  /** Streams `text` word by word; `finish` then turns it into a message and ends the turn. */
  private stream(session: string, text: string, finish: (() => void) | null): void {
    this.stopStream();
    const data = this.data.get(session);
    const project = data?.project ?? "";
    const event = (e: StreamEvent) => this.emitForSession(session, "stream", { t: "stream", project, session, event: e });
    const words = text.split(/(?<=\s)/);
    let index = 0;
    const step = () => {
      if (index >= words.length) {
        this.streamTimer = null;
        finish?.();
        return;
      }
      if (index === 0) {
        event({ type: "message_start" });
        event({ type: "content_block_start", index: 0 });
      }
      event({ type: "content_block_delta", index: 0, text: words.slice(index, index + 2).join("") });
      index += 2;
      this.streamTimer = setTimeout(step, 70 * this.speed);
    };
    this.streamTimer = setTimeout(step, 380 * this.speed);
  }

  private stopStream(): void {
    if (this.streamTimer !== null) clearTimeout(this.streamTimer);
    this.streamTimer = null;
  }

  private reply(session: string, text: string): void {
    this.stream(session, text, () => {
      this.addMessage(session, { uuid: `demo-reply-${++this.seq}`, type: "assistant", content: [{ type: "text", text }] });
      this.addMessage(session, {
        uuid: `demo-result-${++this.seq}`,
        type: "result",
        result: { subtype: "success", isError: false, durationMs: 2_400 + text.length * 9, numTurns: 1 },
      });
      this.setSessionState(session, "idle");
    });
  }

  private findSession(session: string) {
    for (const project of this.list) {
      const found = project.sessions.find((s) => s.id === session);
      if (found) return found;
    }
    return undefined;
  }

  private setSessionState(session: string, state: SessionState): void {
    this.updateSession(session, (s) => ({ ...s, state, lastModified: Date.now() }));
  }

  private updateSession(session: string, change: (s: Project["sessions"][number]) => Project["sessions"][number]): void {
    const data = this.data.get(session);
    if (!data) return;
    this.updateProject(data.project, (p) => ({ ...p, sessions: p.sessions.map((s) => (s.id === session ? change(s) : s)) }));
  }

  private updateProject(project: string, change: (p: Project) => Project): void {
    this.list = this.list.map((p) => (p.id === project ? change(p) : p));
    if (this.current === "open") this.emit("projects", this.list);
  }
}
