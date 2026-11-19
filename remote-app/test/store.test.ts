import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { RemoteError, type ClientEvents, type ClientState } from "../src/lib/client";
import type { Ack, ImageUpload, Pending, PhoneMessage, Project } from "../src/lib/protocol";
import { buildTranscript } from "../src/lib/transcript";
import type { Source } from "../src/state/source";
import { Store } from "../src/state/store";

// ---- a fake browser (history, location, window events) ----

type Listener = (event: { state: unknown }) => void;
const saved: Record<string, unknown> = {};
const GLOBALS = ["window", "history", "location", "document"] as const;

function installBrowser() {
  const listeners = new Map<string, Set<Listener>>();
  const stack: unknown[] = [null];
  let index = 0;
  const fire = (type: string, event: { state: unknown }) => listeners.get(type)?.forEach((l) => l(event));
  const g = globalThis as Record<string, unknown>;
  for (const key of GLOBALS) saved[key] = g[key];
  g.window = {
    addEventListener: (type: string, l: Listener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(l);
    },
    removeEventListener: (type: string, l: Listener) => listeners.get(type)?.delete(l),
    matchMedia: () => ({ matches: false }),
  };
  g.history = {
    get state() {
      return stack[index];
    },
    pushState(state: unknown) {
      stack.splice(index + 1);
      stack.push(state);
      index++;
    },
    replaceState(state: unknown) {
      stack[index] = state;
    },
    back() {
      this.go(-1);
    },
    go(delta: number) {
      index = Math.max(0, Math.min(stack.length - 1, index + delta));
      queueMicrotask(() => fire("popstate", { state: stack[index] }));
    },
  };
  g.location = { pathname: "/", search: "", hash: "" };
  g.document = { title: "" };
}

function restoreBrowser() {
  const g = globalThis as Record<string, unknown>;
  for (const key of GLOBALS) g[key] = saved[key];
}

// ---- a fake Mac ----

interface Call {
  method: string;
  args: unknown[];
  resolve?: (ack: Ack) => void;
  reject?: (error: Error) => void;
}

class FakeSource implements Source {
  state: ClientState = "offline";
  projects: Project[] = [];
  macName = "example-mac";
  calls: Call[] = [];
  private listeners = new Map<string, Set<(payload: never) => void>>();

  on<K extends keyof ClientEvents>(event: K, listener: (payload: ClientEvents[K]) => void): () => void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener as (payload: never) => void);
    return () => this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }
  emit<K extends keyof ClientEvents>(event: K, payload: ClientEvents[K]): void {
    this.listeners.get(event)?.forEach((l) => (l as (p: ClientEvents[K]) => void)(payload));
  }
  connect() {
    this.calls.push({ method: "connect", args: [] });
    this.state = "open";
    this.emit("state", "open");
  }
  close() {
    this.calls.push({ method: "close", args: [] });
  }
  subscribe(...args: unknown[]) {
    this.calls.push({ method: "subscribe", args });
  }
  unsubscribe() {
    this.calls.push({ method: "unsubscribe", args: [] });
  }
  private deferred(method: string, args: unknown[]): Promise<Ack> {
    return new Promise((resolve, reject) => this.calls.push({ method, args, resolve, reject }));
  }
  send(...args: unknown[]) {
    return this.deferred("send", args);
  }
  answer(...args: unknown[]) {
    return this.deferred("answer", args);
  }
  interrupt(...args: unknown[]) {
    return this.deferred("interrupt", args);
  }
  open(...args: unknown[]) {
    return this.deferred("open", args);
  }
  openClaude(...args: unknown[]) {
    return this.deferred("openClaude", args);
  }

  count(method: string) {
    return this.calls.filter((c) => c.method === method).length;
  }
  last(method: string): Call {
    const call = [...this.calls].reverse().find((c) => c.method === method);
    if (!call) throw new Error(`no ${method} call`);
    return call;
  }
}

// ---- fixtures ----

const PROJECT = "p1";
const SESSION = "s1";
const ack = (extra: Partial<Ack> = {}): Ack => ({ t: "ack", id: "r", ok: true, ...extra });
const said = (uuid: string, text: string): PhoneMessage => ({ uuid, type: "user", content: [{ type: "text", text }] });
const prompt = (requestId: string): Pending => ({
  requestId,
  kind: "tool",
  toolName: "Bash",
  input: { command: "npm test" },
  canAlwaysAllow: false,
  createdAt: 1,
});

let fake: FakeSource;
let store: Store;

function snapshot(messages: PhoneMessage[], pending: Pending[] = [], session = SESSION) {
  fake.emit("snapshot", { t: "snapshot", project: PROJECT, session, messages, pending, state: "idle", live: true, truncatedBefore: 0 });
}

beforeEach(() => {
  installBrowser();
  fake = new FakeSource();
  store = new Store({ demo: true, createSource: () => fake });
  store.start();
  store.openSession(PROJECT, SESSION);
  snapshot([said("m1", "first")]);
});

afterEach(() => {
  store.stop();
  restoreBrowser();
});

const view = () => {
  const v = store.state.view;
  if (!v) throw new Error("no view");
  return v;
};

// ---- tests ----

describe("opening a session", () => {
  test("subscribes, and the snapshot fills the view", () => {
    expect(fake.last("subscribe").args).toEqual([PROJECT, SESSION]);
    expect(view().loaded).toBe(true);
    expect(view().messages.map((m) => m.uuid)).toEqual(["m1"]);
  });

  test("frames of another session leave the view alone", () => {
    fake.emit("msg", { t: "msg", project: PROJECT, session: "other", message: said("x", "not here") });
    snapshot([said("y", "nor this")], [], "other");
    expect(view().messages.map((m) => m.uuid)).toEqual(["m1"]);
  });

  test("going back unsubscribes and drops the view", async () => {
    store.back();
    await Promise.resolve();
    expect(store.state.route).toEqual({ name: "home" });
    expect(store.state.view).toBeNull();
    expect(fake.count("unsubscribe")).toBe(1);
  });
});

describe("sending", () => {
  test("shows the message at once, takes the ack's uuid, and the replay replaces it", async () => {
    const sending = store.send("hello", []);
    const local = view().messages.at(-1)!;
    expect(local).toMatchObject({ type: "user", local: "sending" });
    expect(view().outgoing[local.uuid]?.status).toBe("sending");
    expect(fake.last("send").args).toEqual([PROJECT, SESSION, "hello", []]);

    fake.last("send").resolve!(ack({ uuid: "u-1" }));
    await sending;
    expect(view().messages.at(-1)!.uuid).toBe("u-1");
    expect(view().outgoing["u-1"]?.status).toBe("sent");

    fake.emit("msg", { t: "msg", project: PROJECT, session: SESSION, message: { ...said("u-1", "hello"), isReplay: true } });
    expect(view().messages.filter((m) => m.uuid === "u-1")).toHaveLength(1);
    expect(view().messages.some((m) => m.local)).toBe(false);
    expect(view().outgoing).toEqual({});
    const users = buildTranscript(view().messages).filter((item) => item.kind === "user");
    expect(users).toHaveLength(2);
    expect(users.every((item) => item.kind === "user" && item.status === undefined)).toBe(true);
  });

  test("a replay that beats the ack is not shown twice", async () => {
    const sending = store.send("quick", []);
    fake.emit("msg", { t: "msg", project: PROJECT, session: SESSION, message: { ...said("u-2", "quick"), isReplay: true } });
    fake.last("send").resolve!(ack({ uuid: "u-2" }));
    await sending;
    expect(view().messages.filter((m) => m.uuid === "u-2")).toHaveLength(1);
    expect(view().messages.some((m) => m.local)).toBe(false);
    expect(view().outgoing).toEqual({});
  });

  test("a timed-out send is marked failed with its code and is never resent by itself", async () => {
    const photo: ImageUpload = { mediaType: "image/jpeg", data: "AAAA" };
    const sending = store.send("deploy it", [photo]);
    fake.last("send").reject!(new RemoteError("timeout"));
    await sending;
    const failed = view().messages.at(-1)!;
    expect(failed.local).toBe("failed");
    expect(view().outgoing[failed.uuid]).toMatchObject({ status: "failed", error: "timeout", text: "deploy it" });
    expect(fake.count("send")).toBe(1);

    // "Send again" is the person's call: exactly one more send, same text and photo.
    store.retry(failed.uuid);
    expect(fake.count("send")).toBe(2);
    expect(fake.last("send").args).toEqual([PROJECT, SESSION, "deploy it", [photo]]);
    expect(view().messages.filter((m) => m.local)).toHaveLength(1);
    expect(view().messages.at(-1)!.local).toBe("sending");
  });

  test("not_connected is kept as the reason, and Discard removes the message", async () => {
    const sending = store.send("offline?", []);
    fake.last("send").reject!(new RemoteError("not_connected"));
    await sending;
    const failed = view().messages.at(-1)!;
    expect(view().outgoing[failed.uuid]?.error).toBe("not_connected");
    store.discard(failed.uuid);
    expect(view().messages.some((m) => m.local)).toBe(false);
    expect(view().outgoing).toEqual({});
  });

  test("a new snapshot keeps the messages the Mac hasn't confirmed yet", () => {
    void store.send("still on its way", []);
    snapshot([said("m1", "first"), said("m2", "second")]);
    expect(view().messages.map((m) => m.local ?? "real")).toEqual(["real", "real", "sending"]);
  });

  test("a new session gets its id from the ack and turns into that session's view", async () => {
    fake.emit("projects", [{ id: PROJECT, name: "acme-api", folders: [], editor: "Visual Studio Code", claudeOpen: true, sessions: [] }]);
    store.newSession(PROJECT);
    expect(store.state.route).toEqual({ name: "new", project: PROJECT });
    const key = view().key;
    const sending = store.send("start something", []);
    expect(fake.last("send").args).toEqual([PROJECT, null, "start something", []]);
    fake.last("send").resolve!(ack({ session: "s9", uuid: "u-9" }));
    await sending;
    expect(store.state.route).toEqual({ name: "session", project: PROJECT, session: "s9" });
    expect(view().key).toBe(key);
    expect(view().session).toBe("s9");
    expect(fake.last("subscribe").args).toEqual([PROJECT, "s9"]);
    expect(view().messages.at(-1)).toMatchObject({ uuid: "u-9", local: "sending" });
  });

  test("an ack that arrives after leaving the session changes nothing", async () => {
    const sending = store.send("bye", []);
    store.back();
    await Promise.resolve();
    fake.last("send").resolve!(ack({ uuid: "u-3" }));
    await sending;
    expect(store.state.view).toBeNull();
  });
});

describe("answering", () => {
  beforeEach(() => {
    snapshot([said("m1", "first")], [prompt("a"), prompt("b"), prompt("c")]);
  });

  test("an accepted answer takes the prompt away; a second tap meanwhile sends nothing", async () => {
    const answering = store.answer(prompt("a"), { kind: "allow" });
    void store.answer(prompt("a"), { kind: "allow" });
    expect(fake.count("answer")).toBe(1);
    expect(view().answering.a).toBe("allow");
    fake.last("answer").resolve!(ack());
    await answering;
    expect(view().pending.map((p) => p.requestId)).toEqual(["b", "c"]);
    expect(view().answering).toEqual({});
  });

  test("not_pending (answered in VS Code) takes it away too, with a notice", async () => {
    const answering = store.answer(prompt("b"), { kind: "deny" });
    fake.last("answer").reject!(new RemoteError("not_pending"));
    await answering;
    expect(view().pending.map((p) => p.requestId)).toEqual(["a", "c"]);
    expect(store.state.toasts.at(-1)?.text).toContain("already answered");
  });

  test("other errors stay on the card and the prompt stays", async () => {
    const answering = store.answer(prompt("c"), { kind: "allow" });
    fake.last("answer").reject!(new RemoteError("timeout"));
    await answering;
    expect(view().pending.map((p) => p.requestId)).toEqual(["a", "b", "c"]);
    expect(view().answerErrors.c).toBe("timeout");
    expect(view().answering).toEqual({});
  });

  test("the Mac's pending list replaces the local one", () => {
    fake.emit("pending", { t: "pending", project: PROJECT, session: SESSION, pending: [prompt("c")] });
    expect(view().pending.map((p) => p.requestId)).toEqual(["c"]);
  });
});

describe("starting a new session", () => {
  const listed = (...ids: string[]): Project[] => [
    {
      id: PROJECT,
      name: "acme-api",
      folders: ["~/code/acme-api"],
      editor: "Visual Studio Code",
      claudeOpen: true,
      sessions: ids.map((id, i) => ({ id, title: id, lastModified: 1000 + i, state: "idle" as const, live: true, pendingCount: 0 })),
    },
  ];

  beforeEach(() => {
    fake.emit("projects", listed(SESSION));
    store.newSession(PROJECT);
  });

  test("a second message waits for the first one's ack: one session, not two", async () => {
    void store.send("first", []);
    void store.send("second", []);
    expect(fake.count("send")).toBe(1);
    expect(view().starting?.status).toBe("sending");
    fake.last("send").resolve!(ack({ session: "s-new", uuid: "u-a" }));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.state.route).toEqual({ name: "session", project: PROJECT, session: "s-new" });
    expect(view().starting).toBeUndefined();
  });

  test("an ack without the session's id waits for it in the project list, then switches to it", async () => {
    const sending = store.send("first", []);
    fake.last("send").resolve!(ack({ uuid: "u-a" }));
    await sending;
    expect(view().starting?.status).toBe("started");
    expect(store.state.route).toEqual({ name: "new", project: PROJECT });
    void store.send("held", []);
    expect(fake.count("send")).toBe(1);

    // An update that only touches a known session changes nothing.
    fake.emit("projects", listed(SESSION));
    expect(store.state.route.name).toBe("new");

    fake.emit("projects", listed(SESSION, "s-fresh"));
    expect(store.state.route).toEqual({ name: "session", project: PROJECT, session: "s-fresh" });
    expect(view().session).toBe("s-fresh");
    expect(view().starting).toBeUndefined();
    expect(fake.last("subscribe").args).toEqual([PROJECT, "s-fresh"]);
  });

  test("text typed while it starts moves to the new session's draft", async () => {
    const sending = store.send("first", []);
    store.setDraft(`${PROJECT}/new`, "and then this");
    fake.last("send").resolve!(ack({ session: "s9", uuid: "u-9" }));
    await sending;
    expect(store.draft(`${PROJECT}/s9`)).toBe("and then this");
    expect(store.draft(`${PROJECT}/new`)).toBe("");
  });

  test("a first message that timed out still switches when its session shows up, and its doubtful copy goes", async () => {
    const sending = store.send("first", []);
    fake.last("send").reject!(new RemoteError("timeout"));
    await sending;
    expect(view().starting?.status).toBe("unconfirmed");
    expect(view().messages.at(-1)?.local).toBe("failed");
    fake.emit("projects", listed(SESSION, "s-late"));
    expect(view().session).toBe("s-late");
    expect(view().messages.some((m) => m.local)).toBe(false);
    expect(view().outgoing).toEqual({});
  });

  test("after an unconfirmed start, sending again is the person's call and goes out", async () => {
    const sending = store.send("first", []);
    fake.last("send").reject!(new RemoteError("connection_lost"));
    await sending;
    const failed = view().messages.at(-1)!;
    store.retry(failed.uuid);
    expect(fake.count("send")).toBe(2);
    expect(fake.last("send").args).toEqual([PROJECT, null, "first", []]);
    expect(view().starting?.status).toBe("sending");
  });

  test("a first message whose connection closed before the ack is unconfirmed too: the session may have started", async () => {
    const sending = store.send("first", []);
    fake.last("send").reject!(new RemoteError("closed"));
    await sending;
    expect(view().starting?.status).toBe("unconfirmed");
    fake.emit("projects", listed(SESSION, "s-late"));
    expect(view().session).toBe("s-late");
    expect(view().outgoing).toEqual({});
  });

  test("not_connected started nothing: the screen takes a message again", async () => {
    const sending = store.send("first", []);
    fake.last("send").reject!(new RemoteError("not_connected"));
    await sending;
    expect(view().starting).toBeUndefined();
    void store.send("again", []);
    expect(fake.count("send")).toBe(2);
  });

  test("without the project in the list (not loaded yet) nothing is sent", () => {
    fake.emit("projects", []);
    void store.send("first", []);
    expect(fake.count("send")).toBe(0);
  });
});

describe("sends that end out of sight", () => {
  test("a send that fails after leaving the session says so", async () => {
    const sending = store.send("important", []);
    store.back();
    await Promise.resolve();
    fake.last("send").reject!(new RemoteError("timeout"));
    await sending;
    expect(store.state.toasts.at(-1)?.text).toContain("didn't confirm");
  });

  test("an ack without a uuid: the replay with the same text replaces the local copy", async () => {
    const sending = store.send("no uuid", []);
    fake.last("send").resolve!(ack({}));
    await sending;
    fake.emit("msg", { t: "msg", project: PROJECT, session: SESSION, message: { ...said("u-real", "no uuid"), isReplay: true } });
    const users = buildTranscript(view().messages).filter((item) => item.kind === "user");
    expect(users.map((u) => u.id)).toEqual(["m1", "u-real"]);
    expect(view().outgoing).toEqual({});
  });
});

describe("remote access turned off on the Mac", () => {
  const disabled = () => fake.emit("error", { t: "error", code: "disabled", message: "Remote access was turned off on the Mac" });

  test("an error 'disabled' marks the Mac as turned off while the app retries, until it is connected again", () => {
    expect(store.state.remoteOff).toBe(false);
    disabled();
    fake.emit("state", "offline");
    expect(store.state.remoteOff).toBe(true);
    fake.emit("state", "connecting"); // the retries fail while it is off
    fake.emit("state", "offline");
    expect(store.state.remoteOff).toBe(true);
    fake.emit("state", "open"); // turned on again
    expect(store.state.remoteOff).toBe(false);
  });

  test("the banner says it, so no error toast", () => {
    const before = store.state.toasts.length;
    disabled();
    expect(store.state.toasts.length).toBe(before);
  });

  test("other errors stay toasts and do not mark the Mac as turned off", () => {
    fake.emit("error", { t: "error", code: "weird", message: "" });
    expect(store.state.remoteOff).toBe(false);
    expect(store.state.toasts.at(-1)?.text).toBe("Something went wrong on example-mac (weird).");
  });
});

describe("errors from the Mac", () => {
  const error = (code: string, extra: Record<string, string> = {}) => fake.emit("error", { t: "error", code, message: "The Mac's words.", ...extra });

  test("after the welcome: a code this app knows gets its copy, another one the Mac's own words", () => {
    error("too_many_connections");
    expect(store.state.toasts.at(-1)?.text).toBe(
      "example-mac closed this connection: this phone had too many open. Close CCE Remote in other tabs.",
    );
    error("something_new");
    expect(store.state.toasts.at(-1)?.text).toBe("The Mac's words.");
    expect(store.state.refusal).toBeNull();
  });

  test("a refusal of this phone (the client is 'unauthorized' first) is no toast: the banner says why", () => {
    const before = store.state.toasts.length;
    fake.emit("state", "unauthorized");
    error("revoked");
    expect(store.state.toasts.length).toBe(before);
    expect(store.state.conn).toBe("unauthorized");
    expect(store.state.refusal?.code).toBe("revoked");
  });

  test("an error before the welcome is no toast: the banner shows it while the retries get it again, until connected", () => {
    const before = store.state.toasts.length;
    fake.emit("state", "connecting");
    error("unsupported_version");
    fake.emit("state", "offline");
    expect(store.state.refusal).toEqual({ code: "unsupported_version", message: "The Mac's words." });
    fake.emit("state", "connecting"); // the retry: the reason stays up while it runs
    expect(store.state.refusal?.code).toBe("unsupported_version");
    error("unsupported_version");
    fake.emit("state", "offline");
    expect(store.state.refusal?.code).toBe("unsupported_version");
    expect(store.state.toasts.length).toBe(before);
    fake.emit("state", "connecting");
    fake.emit("state", "open"); // the Mac was updated
    expect(store.state.refusal).toBeNull();
  });

  test("an attempt that ends without a word from the Mac (the network) clears the last attempt's reason", () => {
    fake.emit("state", "connecting");
    error("unsupported_version");
    fake.emit("state", "offline");
    fake.emit("state", "connecting");
    fake.emit("state", "offline");
    expect(store.state.refusal).toBeNull();
  });

  test("snapshot_failed toasts for the session on screen only", () => {
    const before = store.state.toasts.length;
    error("snapshot_failed", { project: PROJECT, session: "another-session" });
    expect(store.state.toasts.length).toBe(before);
    error("snapshot_failed", { project: PROJECT, session: SESSION });
    expect(store.state.toasts.at(-1)?.text).toBe("Couldn't load this session from example-mac. Open it again to retry.");
  });
});

describe("stopping a turn", () => {
  test("a stop that wasn't confirmed says so, not that it failed", async () => {
    const stopping = store.interrupt();
    fake.last("interrupt").reject!(new RemoteError("timeout"));
    await stopping;
    expect(store.state.toasts.at(-1)?.text).toBe("The stop wasn't confirmed. example-mac took too long to answer.");
  });

  test("a stop the Mac refused says why", async () => {
    const stopping = store.interrupt();
    fake.last("interrupt").reject!(new RemoteError("not_running"));
    await stopping;
    expect(store.state.toasts.at(-1)?.text).toBe("Couldn't stop: Claude Code isn't running this session right now.");
  });
});
