import { beforeEach, describe, expect, test } from "bun:test";
import { pairWithMac, RemoteClient, RemoteError, type ClientState } from "../src/lib/client";
import type { Mac } from "../src/lib/macs";
import type { Project } from "../src/lib/protocol";

// ---- fakes ---------------------------------------------------------------------------------------

/** A WebSocket stand-in. Tests drive it with open(), receive() and serverClose(). */
class FakeSocket {
  static sockets: FakeSocket[] = [];
  readyState = 0;
  sent: Array<Record<string, unknown>> = [];
  closed: Array<{ code?: number; reason?: string }> = [];
  onopen: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  constructor(public url: string) {
    FakeSocket.sockets.push(this);
  }
  send(data: string) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closed.push({ code, reason });
    this.readyState = 3; // a browser fires the close event later; tests use serverClose() for that
  }
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  receive(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  serverClose(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code, reason: "" });
  }
}

/** Timers on a clock the test moves by hand. */
class FakeTimers {
  now = 0;
  private seq = 0;
  private timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown) => void this.timers.delete(id as number);
  setInterval = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn, every: ms });
    return id;
  };
  clearInterval = (id: unknown) => void this.timers.delete(id as number);
  get pending() {
    return this.timers.size;
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every?: number }] | undefined;
      for (const entry of this.timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      const [id, timer] = next;
      this.now = timer.at;
      if (timer.every) timer.at += timer.every;
      else this.timers.delete(id);
      timer.fn();
    }
    this.now = end;
  }
}

/** document / window stand-ins for the wake-up events. */
class FakeTarget {
  visibilityState = "visible";
  private listeners = new Map<string, Set<(ev: unknown) => void>>();
  addEventListener(type: string, fn: (ev: unknown) => void) {
    (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(fn);
  }
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners.get(type)?.delete(fn);
  }
  count(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
  dispatch(type: string) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type });
  }
}

// ---- helpers -------------------------------------------------------------------------------------

const MAC: Mac = {
  id: "dev1",
  name: "Example Mac",
  url: "https://example-mac.tailnet-0000.ts.net:47821",
  deviceId: "dev1",
  token: "tok1",
};

const PROJECT: Project = {
  id: "p1",
  name: "acme-api",
  folders: ["~/code/acme-api"],
  editor: "Visual Studio Code - Insiders",
  claudeOpen: true,
  sessions: [],
};

const last = () => FakeSocket.sockets[FakeSocket.sockets.length - 1]!;
const count = () => FakeSocket.sockets.length;

function setup(opts: { mac?: Mac; env?: { document?: FakeTarget; window?: FakeTarget } } = {}) {
  const timers = new FakeTimers();
  const client = new RemoteClient(opts.mac ?? MAC, {
    WebSocketImpl: FakeSocket as never,
    timers,
    env: opts.env as never,
  });
  const states: ClientState[] = [];
  client.on("state", (s) => states.push(s));
  return { client, timers, states };
}

/** Opens the socket and plays the hub's greeting. */
function handshake(sock = last(), projects: Project[] = []) {
  sock.open();
  sock.receive({ t: "welcome", v: 1, mac: { name: "Example Mac" } });
  sock.receive({ t: "projects", projects });
}

/** Settles with what a promise did, without waiting for it forever. */
function track<T>(promise: Promise<T>) {
  const out: { state: "pending" | "resolved" | "rejected"; value?: T; error?: unknown } = { state: "pending" };
  promise.then(
    (value) => Object.assign(out, { state: "resolved", value }),
    (error) => Object.assign(out, { state: "rejected", error }),
  );
  return out;
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  FakeSocket.sockets = [];
});

// ---- RemoteClient --------------------------------------------------------------------------------

describe("RemoteClient: connecting", () => {
  test("opens wss://<host>/ws and sends hello with deviceId and token as the very first frame", () => {
    const { client } = setup();
    client.connect();
    expect(count()).toBe(1);
    expect(last().url).toBe("wss://example-mac.tailnet-0000.ts.net:47821/ws");
    expect(client.state).toBe("connecting");
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().sent).toEqual([{ t: "hello", v: 1, deviceId: "dev1", token: "tok1" }]);
  });

  test("a local http address uses ws (development)", () => {
    const { client } = setup({ mac: { ...MAC, url: "http://127.0.0.1:47998" } });
    client.connect();
    expect(last().url).toBe("ws://127.0.0.1:47998/ws");
  });

  test("welcome opens the connection; projects update the list and fire an event", () => {
    const { client, states } = setup();
    const seen: Project[][] = [];
    client.on("projects", (p) => seen.push(p));
    client.connect();
    last().open();
    expect(client.state).toBe("connecting"); // the socket is open, but the hub has not accepted us yet
    last().receive({ t: "welcome", v: 1, mac: { name: "Example Mac" } });
    expect(client.state).toBe("open");
    last().receive({ t: "projects", projects: [PROJECT] });
    expect(seen).toEqual([[PROJECT]]);
    expect(client.projects).toEqual([PROJECT]);
    expect(states).toEqual(["connecting", "open"]);
  });

  test("the Mac's name follows the welcome frame", () => {
    const { client } = setup();
    expect(client.macName).toBe("Example Mac");
    client.connect();
    last().open();
    last().receive({ t: "welcome", v: 1, mac: { name: "Renamed Mac" } });
    expect(client.macName).toBe("Renamed Mac");
  });

  test("connect() while connecting or open does not open a second socket", () => {
    const { client } = setup();
    client.connect();
    client.connect();
    expect(count()).toBe(1);
    handshake();
    client.connect();
    expect(count()).toBe(1);
  });

  test("a state event fires only when the state changes", () => {
    const { client, states } = setup();
    client.connect();
    client.connect();
    handshake();
    last().receive({ t: "welcome", v: 1, mac: { name: "Example Mac" } });
    expect(states).toEqual(["connecting", "open"]);
  });
});

describe("RemoteClient: reconnecting", () => {
  test("reconnects after 500, 1000 and 2000 ms", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    last().serverClose();
    expect(client.state).toBe("offline");

    timers.advance(499);
    expect(count()).toBe(1);
    timers.advance(1);
    expect(count()).toBe(2);
    expect(client.state).toBe("connecting");

    last().serverClose(); // fails before the hub accepted us: the delay doubles
    timers.advance(999);
    expect(count()).toBe(2);
    timers.advance(1);
    expect(count()).toBe(3);

    last().serverClose();
    timers.advance(1999);
    expect(count()).toBe(3);
    timers.advance(1);
    expect(count()).toBe(4);
  });

  test("the delay doubles up to 10 s and stays there", () => {
    const { client, timers } = setup();
    client.connect();
    for (const delay of [500, 1000, 2000, 4000, 8000, 10_000, 10_000, 10_000]) {
      const before = count();
      last().serverClose();
      timers.advance(delay - 1);
      expect(count()).toBe(before);
      timers.advance(1);
      expect(count()).toBe(before + 1);
    }
  });

  test("a failed socket error without a close event also leads to a retry", () => {
    const { client, timers } = setup();
    client.connect();
    last().onerror?.({});
    timers.advance(500);
    expect(count()).toBe(2);
  });

  test("a welcome resets the delay to 500 ms", () => {
    const { client, timers } = setup();
    client.connect();
    last().serverClose();
    timers.advance(500);
    last().serverClose();
    timers.advance(1000);
    expect(count()).toBe(3);
    handshake();
    last().serverClose();
    timers.advance(499);
    expect(count()).toBe(3);
    timers.advance(1);
    expect(count()).toBe(4);
  });

  test("error bad_token ends in 'unauthorized' and never reconnects", () => {
    const { client, timers, states } = setup();
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));
    client.connect();
    last().open();
    last().receive({ t: "error", code: "bad_token", message: "This phone is not paired" });
    expect(client.state).toBe("unauthorized");
    expect(last().closed.length).toBe(1);
    last().serverClose(1008); // the hub hangs up too
    timers.advance(60_000);
    expect(count()).toBe(1);
    expect(timers.pending).toBe(0);
    expect(states).toEqual(["connecting", "unauthorized"]);
    expect(errors).toEqual([{ t: "error", code: "bad_token", message: "This phone is not paired" }]);
  });

  test("bad_origin before the welcome is a refusal of this phone too", () => {
    const { client, timers } = setup();
    client.connect();
    last().open();
    last().receive({ t: "error", code: "bad_origin", message: "Wrong origin" });
    expect(client.state).toBe("unauthorized");
    timers.advance(60_000);
    expect(count()).toBe(1);
  });

  test("revoked after the welcome ends in 'unauthorized' (the listeners see the state first) and never reconnects", () => {
    const { client, timers, states } = setup();
    const seen: Array<[string, ClientState]> = [];
    client.on("error", (e) => seen.push([e.code, client.state]));
    client.connect();
    handshake();
    last().receive({ t: "error", code: "revoked", message: "This phone was removed on the Mac." });
    last().serverClose(4401);
    timers.advance(60_000);
    expect(seen).toEqual([["revoked", "unauthorized"]]);
    expect(states).toEqual(["connecting", "open", "unauthorized"]);
    expect(count()).toBe(1);
  });

  test("other errors before the welcome are not about who we are: passed on, and the closed connection is retried", () => {
    for (const code of ["unsupported_version", "server_error", "something_new"]) {
      FakeSocket.sockets = [];
      const { client, timers, states } = setup();
      const errors: unknown[] = [];
      client.on("error", (e) => errors.push(e));
      client.connect();
      last().open();
      last().receive({ t: "error", code, message: "The Mac's words" });
      expect(client.state).toBe("connecting");
      last().serverClose(4400); // the hub closes after such an error
      expect(client.state).toBe("offline");
      timers.advance(500);
      expect(count()).toBe(2);
      expect(states).toEqual(["connecting", "offline", "connecting"]);
      expect(errors).toEqual([{ t: "error", code, message: "The Mac's words" }]);
      client.close();
    }
  });

  test("an error frame without a usable code or message reaches the listeners as 'failed' with no text", () => {
    const { client } = setup();
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));
    client.connect();
    handshake();
    last().receive({ t: "error", code: 42, message: { not: "text" } });
    expect(errors).toEqual([{ t: "error", code: "failed", message: "" }]);
    expect(client.state).toBe("open");
  });

  test("an error after the welcome is reported and the connection stays", () => {
    const { client } = setup();
    const errors: unknown[] = [];
    client.on("error", (e) => errors.push(e));
    client.connect();
    handshake();
    last().receive({ t: "error", code: "gone", message: "That session is gone" });
    expect(client.state).toBe("open");
    expect(errors).toEqual([{ t: "error", code: "gone", message: "That session is gone" }]);
  });

  test("connect() after 'unauthorized' tries again (a Retry button)", () => {
    const { client } = setup();
    client.connect();
    last().open();
    last().receive({ t: "error", code: "bad_token", message: "x" });
    client.connect();
    expect(count()).toBe(2);
    expect(client.state).toBe("connecting");
  });

  test("connect() while waiting for a retry connects at once and cancels the timer", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    last().serverClose();
    client.connect();
    expect(count()).toBe(2);
    timers.advance(10_000);
    expect(count()).toBe(2);
  });

  test("close() stops for good: no reconnect, no timers, state offline", () => {
    const { client, timers, states } = setup();
    client.connect();
    handshake();
    const first = last();
    const staleClose = first.onclose; // an event that was already on its way
    client.close();
    expect(first.closed.length).toBe(1);
    expect(client.state).toBe("offline");
    staleClose?.({ code: 1000 });
    timers.advance(60_000);
    expect(count()).toBe(1);
    expect(timers.pending).toBe(0);
    expect(states).toEqual(["connecting", "open", "offline"]);
  });

  test("close() while a retry is waiting cancels it", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    last().serverClose();
    client.close();
    timers.advance(60_000);
    expect(count()).toBe(1);
  });

  test("events of a socket that was already replaced are ignored", () => {
    const { client, timers } = setup({ env: { document: new FakeTarget(), window: new FakeTarget() } });
    client.connect();
    const first = last();
    const staleClose = first.onclose;
    const staleMessage = first.onmessage;
    client.connect(); // no-op while connecting
    first.serverClose();
    timers.advance(500); // second socket
    expect(count()).toBe(2);
    staleClose?.({ code: 1006 });
    staleMessage?.({ data: JSON.stringify({ t: "error", code: "bad_token", message: "stale" }) });
    expect(client.state).toBe("connecting");
    timers.advance(60_000);
    expect(count()).toBe(2);
  });
});

describe("RemoteClient: subscriptions", () => {
  test("subscribe sends sub; after a reconnect the new socket sends hello and then sub again", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    client.subscribe("p1", "s1");
    expect(last().sent).toEqual([
      { t: "hello", v: 1, deviceId: "dev1", token: "tok1" },
      { t: "visibility", visible: false },
      { t: "sub", project: "p1", session: "s1" },
    ]);
    last().serverClose();
    timers.advance(500);
    handshake();
    expect(last().sent).toEqual([
      { t: "hello", v: 1, deviceId: "dev1", token: "tok1" },
      { t: "visibility", visible: false },
      { t: "sub", project: "p1", session: "s1" },
    ]);
  });

  test("a subscription made before the connection is open is sent after the welcome, not before", () => {
    const { client } = setup();
    client.subscribe("p1", "s1");
    client.connect();
    last().open();
    expect(last().sent.map((f) => f.t)).toEqual(["hello"]);
    last().receive({ t: "welcome", v: 1, mac: { name: "Example Mac" } });
    expect(last().sent.map((f) => f.t)).toEqual(["hello", "visibility", "sub"]);
  });

  test("nothing but hello goes out before the welcome, even on an open socket", () => {
    const { client } = setup();
    client.connect();
    last().open();
    client.subscribe("p1", "s1");
    expect(last().sent.map((f) => f.t)).toEqual(["hello"]);
    last().receive({ t: "welcome", v: 1, mac: { name: "Example Mac" } });
    expect(last().sent.map((f) => f.t)).toEqual(["hello", "visibility", "sub"]);
  });

  test("subscribing to the same session twice sends one sub", () => {
    const { client } = setup();
    client.connect();
    handshake();
    client.subscribe("p1", "s1");
    client.subscribe("p1", "s1");
    expect(last().sent.filter((f) => f.t === "sub").length).toBe(1);
  });

  test("another session replaces the subscription: unsub first, then sub", () => {
    const { client } = setup();
    client.connect();
    handshake();
    client.subscribe("p1", "s1");
    client.subscribe("p1", "s2");
    expect(last().sent.slice(1)).toEqual([
      { t: "visibility", visible: false },
      { t: "sub", project: "p1", session: "s1" },
      { t: "unsub", project: "p1", session: "s1" },
      { t: "sub", project: "p1", session: "s2" },
    ]);
  });

  test("unsubscribe sends unsub and the session is not subscribed again after a reconnect", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    client.subscribe("p1", "s1");
    client.unsubscribe();
    expect(last().sent.at(-1)).toEqual({ t: "unsub", project: "p1", session: "s1" });
    client.unsubscribe(); // nothing to do
    expect(last().sent.filter((f) => f.t === "unsub").length).toBe(1);
    last().serverClose();
    timers.advance(500);
    handshake();
    expect(last().sent.map((f) => f.t)).toEqual(["hello", "visibility"]);
  });

  test("snapshot, msg, stream and pending frames reach their listeners; off() stops delivery", () => {
    const { client } = setup();
    const got: Record<string, unknown[]> = { snapshot: [], msg: [], stream: [], pending: [] };
    const offSnapshot = client.on("snapshot", (f) => got.snapshot!.push(f));
    client.on("msg", (f) => got.msg!.push(f));
    client.on("stream", (f) => got.stream!.push(f));
    client.on("pending", (f) => got.pending!.push(f));
    client.connect();
    handshake();
    client.subscribe("p1", "s1");

    const snapshot = { t: "snapshot", project: "p1", session: "s1", messages: [], pending: [], state: "idle", live: false, truncatedBefore: 0 };
    const msg = { t: "msg", project: "p1", session: "s1", message: { uuid: "m1", type: "assistant", content: [] } };
    const stream = { t: "stream", project: "p1", session: "s1", event: { type: "content_block_delta", index: 0, text: "hi" } };
    const pending = { t: "pending", project: "p1", session: "s1", pending: [] };
    for (const frame of [snapshot, msg, stream, pending]) last().receive(frame);
    expect(got).toEqual({ snapshot: [snapshot], msg: [msg], stream: [stream], pending: [pending] });

    offSnapshot();
    last().receive(snapshot);
    expect(got.snapshot!.length).toBe(1);
  });

  test("a listener that throws does not stop the others or the connection", () => {
    const { client } = setup();
    const seen: unknown[] = [];
    client.on("projects", () => {
      throw new Error("listener bug");
    });
    client.on("projects", (p) => seen.push(p));
    client.connect();
    const consoleError = console.error;
    console.error = () => {};
    try {
      handshake(last(), [PROJECT]);
    } finally {
      console.error = consoleError;
    }
    expect(seen).toEqual([[PROJECT]]);
    expect(client.state).toBe("open");
  });

  describe("session frames only count for the session the client is subscribed to now", () => {
    /** The four kinds of session frame the Mac sends for one session. */
    const framesOf = (project: string, session: string) => [
      { t: "snapshot", project, session, messages: [], pending: [], state: "idle", live: false, truncatedBefore: 0 },
      { t: "msg", project, session, message: { uuid: `m-${session}`, type: "assistant", content: [] } },
      { t: "stream", project, session, event: { type: "content_block_delta", index: 0, text: "hi" } },
      { t: "pending", project, session, pending: [] },
    ];
    /** What reached the listeners, as "event:project/session". */
    function listen(client: RemoteClient) {
      const got: string[] = [];
      for (const event of ["snapshot", "msg", "stream", "pending"] as const) {
        client.on(event, (f) => got.push(`${event}:${f.project}/${f.session}`));
      }
      return got;
    }
    const all = (project: string, session: string) =>
      ["snapshot", "msg", "stream", "pending"].map((event) => `${event}:${project}/${session}`);

    test("after switching from session A to B, late frames of A are dropped and those of B are delivered", () => {
      const { client } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      client.subscribe("p1", "A");
      client.subscribe("p1", "B");
      for (const frame of framesOf("p1", "A")) last().receive(frame); // the Mac answers A late
      expect(got).toEqual([]);
      for (const frame of framesOf("p1", "B")) last().receive(frame);
      expect(got).toEqual(all("p1", "B"));
    });

    test("A's snapshot arriving after B's is dropped, so A's prompts never reach B's screen", () => {
      const { client } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      client.subscribe("p1", "A");
      client.subscribe("p1", "B");
      const prompt = { requestId: "req-A", kind: "tool", toolName: "Bash", input: { command: "rm -rf build" }, canAlwaysAllow: false, createdAt: 1 };
      last().receive({ t: "snapshot", project: "p1", session: "B", messages: [], pending: [], state: "idle", live: false, truncatedBefore: 0 });
      last().receive({ t: "snapshot", project: "p1", session: "A", messages: [], pending: [prompt], state: "waiting", live: true, truncatedBefore: 0 });
      last().receive({ t: "pending", project: "p1", session: "A", pending: [prompt] });
      expect(got).toEqual(["snapshot:p1/B"]);
    });

    test("nothing is delivered after unsubscribe(), not even for the session that was subscribed", () => {
      const { client } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      client.subscribe("p1", "A");
      for (const frame of framesOf("p1", "A")) last().receive(frame);
      expect(got).toEqual(all("p1", "A"));
      got.length = 0;
      client.unsubscribe();
      for (const frame of [...framesOf("p1", "A"), ...framesOf("p1", "B")]) last().receive(frame);
      expect(got).toEqual([]);
    });

    test("without a subscription nothing is delivered", () => {
      const { client } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      for (const frame of framesOf("p1", "A")) last().receive(frame);
      expect(got).toEqual([]);
    });

    test("the project counts too: the same session id in another project is dropped", () => {
      const { client } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      client.subscribe("p1", "s1");
      for (const frame of [...framesOf("p2", "s1"), ...framesOf("p1", "s2")]) last().receive(frame);
      expect(got).toEqual([]);
      for (const frame of framesOf("p1", "s1")) last().receive(frame);
      expect(got).toEqual(all("p1", "s1"));
    });

    test("after a reconnect the resubscribed session delivers again", () => {
      const { client, timers } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      client.subscribe("p1", "A");
      last().serverClose();
      timers.advance(500);
      handshake();
      expect(last().sent.at(-1)).toEqual({ t: "sub", project: "p1", session: "A" });
      for (const frame of framesOf("p1", "A")) last().receive(frame);
      expect(got).toEqual(all("p1", "A"));
    });

    test("a subscription replaced while offline: after the reconnect only the new session delivers", () => {
      const { client, timers } = setup();
      const got = listen(client);
      client.connect();
      handshake();
      client.subscribe("p1", "A");
      last().serverClose();
      client.subscribe("p1", "B"); // nothing can be sent, the connection is down
      timers.advance(500);
      handshake();
      expect(last().sent.filter((f) => f.t === "sub")).toEqual([{ t: "sub", project: "p1", session: "B" }]);
      for (const frame of [...framesOf("p1", "A"), ...framesOf("p1", "B")]) last().receive(frame);
      expect(got).toEqual(all("p1", "B"));
    });
  });

  test("session frames that lack their parts are ignored; a snapshot without a pending list gets an empty one", () => {
    const { client } = setup();
    const got: unknown[] = [];
    for (const event of ["snapshot", "msg", "stream", "pending"] as const) client.on(event, (f) => got.push(f));
    client.connect();
    handshake();
    client.subscribe("p1", "s1");
    last().receive({ t: "snapshot", project: "p1", session: "s1" });
    last().receive({ t: "snapshot", session: "s1", messages: [], pending: [] });
    last().receive({ t: "msg", project: "p1", session: "s1" });
    last().receive({ t: "msg", project: "p1", session: "s1", message: "text" });
    last().receive({ t: "stream", project: "p1", session: "s1" });
    last().receive({ t: "pending", project: "p1", session: "s1", pending: "nope" });
    expect(got).toEqual([]);
    last().receive({ t: "snapshot", project: "p1", session: "s1", messages: [], state: "idle", live: false, truncatedBefore: 0 });
    expect(got).toEqual([{ t: "snapshot", project: "p1", session: "s1", messages: [], pending: [], state: "idle", live: false, truncatedBefore: 0 }]);
  });

  test("frames that are not JSON objects, binary data and unknown types are ignored", () => {
    const { client } = setup();
    client.connect();
    handshake();
    last().receive("not json");
    last().receive("null");
    last().receive("[1,2]");
    last().receive({ t: "mystery" });
    last().receive({ t: "projects", projects: "nope" });
    last().onmessage?.({ data: new ArrayBuffer(4) });
    expect(client.state).toBe("open");
    expect(client.projects).toEqual([]);
  });
});

describe("RemoteClient: requests", () => {
  test("send resolves with the matching ack", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const result = track(client.send("p1", "s1", "hello"));
    const frame = last().sent.at(-1)!;
    expect(frame).toMatchObject({ t: "send", project: "p1", session: "s1", text: "hello" });
    expect("images" in frame).toBe(false);

    last().receive({ t: "ack", id: "someone-else", ok: true });
    await flush();
    expect(result.state).toBe("pending");

    last().receive({ t: "ack", id: frame.id, ok: true, session: "s1", uuid: "u-1" });
    await flush();
    expect(result).toEqual({ state: "resolved", value: { t: "ack", id: frame.id, ok: true, session: "s1", uuid: "u-1" } });
  });

  test("send to a new session passes null and the images", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const images = [{ mediaType: "image/jpeg", data: "AAAA" }];
    const result = track(client.send("p1", null, "look at this", images));
    const frame = last().sent.at(-1)!;
    expect(frame).toMatchObject({ t: "send", project: "p1", session: null, text: "look at this", images });
    last().receive({ t: "ack", id: frame.id, ok: true, session: "s-new", uuid: "u-2" });
    await flush();
    expect(result.state).toBe("resolved");
    expect((result.value as { session?: string }).session).toBe("s-new");
  });

  test("every request has its own id", () => {
    const { client } = setup();
    client.connect();
    handshake();
    void client.send("p1", "s1", "a").catch(() => {});
    void client.send("p1", "s1", "b").catch(() => {});
    const [a, b] = last().sent.slice(-2);
    expect(a!.id).not.toBe(b!.id);
    client.close();
  });

  test("send rejects when the bridge answers ok:false, with the bridge's error as the code", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const result = track(client.send("p1", "s1", "hello"));
    last().receive({ t: "ack", id: last().sent.at(-1)!.id, ok: false, error: "no_channel" });
    await flush();
    expect(result.state).toBe("rejected");
    expect(result.error).toBeInstanceOf(RemoteError);
    expect((result.error as RemoteError).code).toBe("no_channel");
  });

  test("an ok:false ack without an error text still rejects", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const result = track(client.interrupt("p1", "s1"));
    last().receive({ t: "ack", id: last().sent.at(-1)!.id, ok: false });
    await flush();
    expect(result.state).toBe("rejected");
    expect((result.error as RemoteError).code).toBe("failed");
  });

  test("commands sends its frame and resolves on the ack, with the window's list", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const result = track(client.commands("p1"));
    const frame = last().sent.at(-1)!;
    expect(frame).toEqual({ t: "commands", id: expect.any(String), project: "p1" });
    last().receive({ t: "ack", id: frame.id, ok: true, commands: [{ name: "compact" }] });
    await flush();
    expect(result).toEqual({ state: "resolved", value: { t: "ack", id: frame.id, ok: true, commands: [{ name: "compact" }] } });
  });

  test("commands gives up after 20 s, past the Mac's own 15 s for the window", async () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    const result = track(client.commands("p1"));
    timers.advance(19_999);
    await flush();
    expect(result.state).toBe("pending");
    timers.advance(1);
    await flush();
    expect(result.state).toBe("rejected");
    expect((result.error as RemoteError).code).toBe("timeout");
  });

  test("an ack that never comes rejects with 'timeout' after 30 s", async () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    const result = track(client.send("p1", "s1", "hello"));
    const frame = last().sent.at(-1)!;
    timers.advance(29_999);
    await flush();
    expect(result.state).toBe("pending");
    timers.advance(1);
    await flush();
    expect(result.state).toBe("rejected");
    expect((result.error as RemoteError).code).toBe("timeout");
    // a late ack does nothing
    last().receive({ t: "ack", id: frame.id, ok: true });
    await flush();
    expect(result.state).toBe("rejected");
  });

  test("a send that starts a new session waits 60 s for its ack (the Mac may need ~40 s to name it)", async () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    const result = track(client.send("p1", null, "start something"));
    const frame = last().sent.at(-1)!;
    // The connection stays healthy meanwhile: every ping gets its pong.
    const alive = (ms: number) => {
      for (let done = 0; done < ms; done += 1000) {
        timers.advance(Math.min(1000, ms - done));
        if (last().sent.at(-1)?.t === "ping") last().receive({ t: "pong" });
      }
    };
    alive(30_000);
    await flush();
    expect(result.state).toBe("pending");
    alive(29_999);
    await flush();
    expect(result.state).toBe("pending");
    timers.advance(1);
    await flush();
    expect(result.state).toBe("rejected");
    expect((result.error as RemoteError).code).toBe("timeout");
    last().receive({ t: "ack", id: frame.id, ok: true, session: "s-late" });
    await flush();
    expect(result.state).toBe("rejected");
  });

  test("requests in flight reject with 'connection_lost' when the socket drops", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const result = track(client.send("p1", "s1", "hello"));
    last().serverClose();
    await flush();
    expect(result.state).toBe("rejected");
    expect((result.error as RemoteError).code).toBe("connection_lost");
  });

  test("close() rejects requests in flight with 'closed'", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const result = track(client.send("p1", "s1", "hello"));
    client.close();
    await flush();
    expect((result.error as RemoteError).code).toBe("closed");
  });

  test("a request while not connected rejects at once with 'not_connected'", async () => {
    const { client } = setup();
    const offline = track(client.send("p1", "s1", "hello"));
    client.connect();
    const connecting = track(client.send("p1", "s1", "hello"));
    await flush();
    expect(offline.state).toBe("rejected");
    expect((offline.error as RemoteError).code).toBe("not_connected");
    expect((connecting.error as RemoteError).code).toBe("not_connected");
    expect(last().sent).toEqual([]);
  });

  test("answer, interrupt, open and openClaude send their frames and resolve on the ack", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const calls: Array<[Promise<unknown>, Record<string, unknown>]> = [
      [
        client.answer("p1", "s1", "req-1", { kind: "answers", answers: { "Which library?": "react-day-picker" } }),
        { t: "answer", project: "p1", session: "s1", requestId: "req-1", choice: { kind: "answers", answers: { "Which library?": "react-day-picker" } } },
      ],
      [client.answer("p1", "s1", "req-2", { kind: "deny", reason: "use pnpm" }), { t: "answer", project: "p1", session: "s1", requestId: "req-2", choice: { kind: "deny", reason: "use pnpm" } }],
      [client.interrupt("p1", "s1"), { t: "interrupt", project: "p1", session: "s1" }],
      [client.open("p1", "s1"), { t: "open", project: "p1", session: "s1" }],
      [client.openClaude("p1"), { t: "openClaude", project: "p1" }],
    ];
    const frames = last().sent.slice(-calls.length);
    calls.forEach(([, expected], i) => expect(frames[i]).toMatchObject(expected));
    frames.forEach((f) => last().receive({ t: "ack", id: f.id, ok: true }));
    const results = await Promise.all(calls.map(([p]) => p));
    expect(results.every((r) => (r as { ok: boolean }).ok)).toBe(true);
  });
});

describe("RemoteClient: notifications", () => {
  test("sends visibility after welcome and on visibility changes", () => {
    const doc = new FakeTarget();
    const { client } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    last().open();
    last().receive({ t: "welcome", v: 1, mac: { name: "Example Mac" } });
    expect(last().sent.at(-1)).toEqual({ t: "visibility", visible: true });

    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    expect(last().sent.at(-1)).toEqual({ t: "visibility", visible: false });

    doc.visibilityState = "visible";
    doc.dispatch("visibilitychange");
    expect(last().sent.slice(-2)).toEqual([
      { t: "visibility", visible: true },
      { t: "ping" }, // the existing wake-up check stays
    ]);
  });

  test("push requests are acked", async () => {
    const { client } = setup();
    client.connect();
    handshake();
    const setupValue = {
      subscription: { endpoint: "https://push.example/abc", keys: { p256dh: "BAbc-_", auth: "Zm9v-_" } },
      vapid: { publicKey: "BAbc-_", privateJwk: { kty: "EC", crv: "P-256", x: "x", y: "y", d: "d" } },
      subject: "https://app.example",
      prefs: { waiting: true, done: true, onlyAway: true, details: true },
    };
    const requests = [client.pushSet(setupValue), client.pushClear(), client.pushTest()];
    const frames = last().sent.slice(-3);
    expect(frames[0]).toMatchObject({
      t: "push_set",
      subscription: setupValue.subscription,
      vapid: setupValue.vapid,
      subject: setupValue.subject,
      prefs: setupValue.prefs,
    });
    expect(frames[1]).toMatchObject({ t: "push_clear" });
    expect(frames[2]).toMatchObject({ t: "push_test" });
    for (const frame of frames) expect(typeof frame.id).toBe("string");

    frames.forEach((frame, index) => last().receive({ t: "ack", id: frame.id, ok: true, status: 201 + index }));
    const results = await Promise.all(requests);
    expect(results.map((result) => result.status)).toEqual([201, 202, 203]);
  });

  test("emits welcome", () => {
    const { client } = setup();
    const welcomes: unknown[] = [];
    client.on("welcome", (frame) => welcomes.push(frame));
    client.connect();
    last().open();
    const frame = { t: "welcome", v: 1, mac: { name: "Example Mac" }, push: true };
    last().receive(frame);
    expect(welcomes).toEqual([frame]);
  });
});

describe("RemoteClient: usage", () => {
  test("a usage frame reaches the listeners; a malformed one doesn't", () => {
    const { client } = setup();
    const frames: unknown[] = [];
    client.on("usage", (frame) => frames.push(frame));
    client.connect();
    handshake();
    last().receive({ t: "usage", state: "ok", fiveHour: { percent: 42 } });
    last().receive({ t: "usage", state: 7 });
    expect(frames).toEqual([{ t: "usage", state: "ok", fiveHour: { percent: 42 } }]);
  });

  test("usageRefresh sends usage_refresh only while open", () => {
    const { client } = setup();
    client.connect();
    client.usageRefresh();
    expect(last().sent).toEqual([]);
    handshake();
    const before = last().sent.length;
    client.usageRefresh();
    expect(last().sent.slice(before)).toEqual([{ t: "usage_refresh" }]);
  });
});

describe("RemoteClient: keeping the connection alive", () => {
  test("pings every 25 s while open", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    const pings = () => last().sent.filter((f) => f.t === "ping").length;
    timers.advance(24_999);
    expect(pings()).toBe(0);
    timers.advance(1);
    expect(pings()).toBe(1);
    last().receive({ t: "pong" });
    timers.advance(25_000);
    expect(pings()).toBe(2);
  });

  test("a connection that stops answering is dropped and re-opened", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    const first = last();
    timers.advance(25_000); // ping goes out
    timers.advance(9_999);
    expect(count()).toBe(1);
    timers.advance(1);
    expect(count()).toBe(2);
    expect(first.closed.length).toBe(1);
    expect(client.state).toBe("connecting");
  });

  test("any frame counts as proof of life, not only the pong", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    timers.advance(25_000); // ping goes out; without any frame the socket would be dropped at 35 s
    last().receive({ t: "projects", projects: [PROJECT] });
    timers.advance(10_000);
    expect(count()).toBe(1);
  });

  test("no heartbeat is left behind after the connection drops", () => {
    const { client, timers } = setup();
    client.connect();
    handshake();
    last().serverClose();
    timers.advance(24_000); // retry fires at 500, the new socket is not open yet
    expect(last().sent).toEqual([]);
    client.close();
    expect(timers.pending).toBe(0);
  });
});

describe("RemoteClient: waking up", () => {
  test("the page becoming visible while waiting for a retry reconnects at once", () => {
    const doc = new FakeTarget();
    const { client, timers } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    handshake();
    last().serverClose();
    expect(count()).toBe(1);
    doc.dispatch("visibilitychange");
    expect(count()).toBe(2);
    expect(client.state).toBe("connecting");
    timers.advance(10_000); // the old retry timer is gone
    expect(count()).toBe(2);
  });

  test("a hidden page does nothing", () => {
    const doc = new FakeTarget();
    const { client } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    handshake();
    last().serverClose();
    doc.visibilityState = "hidden";
    doc.dispatch("visibilitychange");
    expect(count()).toBe(1);
  });

  test("the network coming back reconnects at once and restarts the delay at 500 ms", () => {
    const win = new FakeTarget();
    const { client, timers } = setup({ env: { document: new FakeTarget(), window: win } });
    client.connect();
    for (const delay of [500, 1000, 2000]) {
      last().serverClose();
      timers.advance(delay);
    }
    expect(count()).toBe(4);
    last().serverClose(); // next delay would be 4000
    win.dispatch("online");
    expect(count()).toBe(5);
    last().serverClose();
    timers.advance(500);
    expect(count()).toBe(6);
  });

  test("a socket that hangs while connecting is replaced when the page wakes up", () => {
    const doc = new FakeTarget();
    const { client } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    const hung = last();
    doc.dispatch("visibilitychange");
    expect(count()).toBe(2);
    expect(hung.closed.length).toBe(1);
  });

  test("while open, waking up checks the connection: a ping that goes unanswered for 4 s reconnects", () => {
    const doc = new FakeTarget();
    const { client, timers } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    handshake();
    doc.dispatch("visibilitychange");
    expect(last().sent.at(-1)).toEqual({ t: "ping" });
    timers.advance(3_999);
    expect(count()).toBe(1);
    timers.advance(1);
    expect(count()).toBe(2);
  });

  test("while open, an answered check keeps the connection", () => {
    const doc = new FakeTarget();
    const { client, timers } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    handshake();
    doc.dispatch("visibilitychange");
    last().receive({ t: "pong" });
    timers.advance(10_000); // well past the 4 s check, before the next regular ping
    expect(count()).toBe(1);
    expect(client.state).toBe("open");
  });

  test("waking up does not retry after 'unauthorized'", () => {
    const doc = new FakeTarget();
    const { client } = setup({ env: { document: doc, window: new FakeTarget() } });
    client.connect();
    last().open();
    last().receive({ t: "error", code: "bad_token", message: "x" });
    doc.dispatch("visibilitychange");
    expect(count()).toBe(1);
  });

  test("the wake-up listeners exist only between connect() and close()", () => {
    const doc = new FakeTarget();
    const win = new FakeTarget();
    const { client } = setup({ env: { document: doc, window: win } });
    expect(doc.count("visibilitychange")).toBe(0);
    client.connect();
    client.connect();
    expect(doc.count("visibilitychange")).toBe(1);
    expect(win.count("online")).toBe(1);
    client.close();
    expect(doc.count("visibilitychange")).toBe(0);
    expect(win.count("online")).toBe(0);
  });
});

// ---- pairWithMac ---------------------------------------------------------------------------------

describe("pairWithMac", () => {
  const device = "iPhone";

  test("sends pair with the code and device name, resolves with the credentials and closes the socket", async () => {
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never }));
    expect(last().url).toBe("wss://example-mac.tailnet-0000.ts.net:47821/ws");
    expect(last().sent).toEqual([]);
    last().open();
    expect(last().sent).toEqual([{ t: "pair", code: "ABCDEFGH", device: "iPhone" }]);
    last().receive({ t: "paired", deviceId: "dev-9", token: "secret-token", mac: { name: "Example Mac" } });
    await flush();
    expect(result).toEqual({ state: "resolved", value: { deviceId: "dev-9", token: "secret-token", macName: "Example Mac" } });
    expect(last().closed.length).toBe(1);
  });

  test("a wrong code rejects with the bridge's error code", async () => {
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never }));
    last().open();
    last().receive({ t: "error", code: "bad_code", message: "That code is not valid" });
    await flush();
    expect(result.state).toBe("rejected");
    expect(result.error).toBeInstanceOf(RemoteError);
    expect((result.error as RemoteError).code).toBe("bad_code");
    expect((result.error as RemoteError).message).toBe("That code is not valid");
    expect(last().closed.length).toBe(1);
  });

  test("a Mac that cannot be reached rejects with 'unreachable'", async () => {
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never }));
    last().serverClose(1006);
    await flush();
    expect((result.error as RemoteError).code).toBe("unreachable");
  });

  test("a socket error also rejects with 'unreachable'", async () => {
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never }));
    last().onerror?.({});
    await flush();
    expect((result.error as RemoteError).code).toBe("unreachable");
  });

  test("a hub that hangs up after the upgrade rejects with 'connection_lost'", async () => {
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never }));
    last().open();
    last().serverClose(1008);
    await flush();
    expect((result.error as RemoteError).code).toBe("connection_lost");
  });

  test("no answer within 15 s rejects with 'timeout' and closes the socket", async () => {
    const timers = new FakeTimers();
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never, timers }));
    last().open();
    timers.advance(14_999);
    await flush();
    expect(result.state).toBe("pending");
    timers.advance(1);
    await flush();
    expect((result.error as RemoteError).code).toBe("timeout");
    expect(last().closed.length).toBe(1);
  });

  test("the timeout is cancelled once the Mac answers", async () => {
    const timers = new FakeTimers();
    const result = track(pairWithMac(MAC.url, "ABCDEFGH", device, { WebSocketImpl: FakeSocket as never, timers }));
    last().open();
    last().receive({ t: "paired", deviceId: "d", token: "t", mac: { name: "Example Mac" } });
    await flush();
    expect(result.state).toBe("resolved");
    expect(timers.pending).toBe(0);
  });
});
