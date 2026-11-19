import { afterEach, describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import net from "node:net";
import { PeerLink, acceptPeer, connectPeer } from "../lib/peer-link.js";
import { RawConn, destroyRawSockets, listenUpgrade, queue, rawRequest, sleep, stubSocket, withTimeout, type Queue, type UpgradeServer } from "./support";

const SECRET = "0123456789abcdef".repeat(4); // the shape of a real one: 32 random bytes as hex
const NONCE_RE = /^[0-9a-f]{64}$/;

/** A nonce as a peer makes one: 32 random bytes as hex. */
const newNonce = () => randomBytes(32).toString("hex");

/** What each side proves it knows the secret with: hex HMAC-SHA256 of `<side>\n<peer nonce>\n<hub nonce>`, keyed with the secret. */
function proofOf(secret: string, side: "hub" | "peer", peerNonce: string, hubNonce: string): string {
  return createHmac("sha256", secret).update(`${side}\n${peerNonce}\n${hubNonce}`).digest("hex");
}

interface Hub extends UpgradeServer {
  /** What acceptPeer returned for each request, in order (null = it refused). */
  accepted: any[];
  /** The links whose peer proved that it knows the secret, in that order. */
  links: Queue<any>;
}

const hubs: UpgradeServer[] = [];

/**
 * A server that accepts peers like the hub's `/_peer` upgrade does. A link joins `links` once its
 * peer proved itself (`auth`); `onLink` runs in that same call, as the hub's attachPeer does.
 */
async function startHub({ secret = SECRET, onLink, authTimeoutMs }: { secret?: string; onLink?: (link: any) => void; authTimeoutMs?: number } = {}): Promise<Hub> {
  const accepted: any[] = [];
  const links = queue<any>();
  const server = await listenUpgrade((req, socket, head) => {
    const link = authTimeoutMs === undefined ? acceptPeer(req, socket, head, secret) : acceptPeer(req, socket, head, secret, { authTimeoutMs });
    accepted.push(link);
    if (!link) return;
    link.on("auth", () => {
      onLink?.(link);
      links.push(link);
    });
  });
  hubs.push(server);
  return { ...server, accepted, links };
}

/**
 * A peer written by hand: the upgrade with `nonce`, then the line `auth` makes of the hub's nonce
 * (the right proof unless a test says otherwise; null sends nothing), with `after` in the same write.
 */
async function rawPeer(
  port: number,
  { nonce = newNonce(), auth, after = "" }: { nonce?: string; auth?: ((hubNonce: string, peerNonce: string) => string) | null; after?: string } = {},
) {
  const raw = await RawConn.open(port, peerRequest({}, nonce));
  const hubNonce = raw.header("X-CCE-Nonce") ?? "";
  const line = auth === undefined ? `${JSON.stringify({ t: "auth", proof: proofOf(SECRET, "peer", nonce, hubNonce) })}\n` : auth === null ? "" : auth(hubNonce, nonce);
  if (line || after) raw.send(line + after);
  return { raw, nonce, hubNonce };
}

const links: any[] = [];

/** A connectPeer client and the hub's end of the same link. */
async function pair(hub: Hub) {
  const client = await connectPeer({ port: hub.port, secret: SECRET });
  const server = await hub.links.next();
  links.push(client, server);
  return { client, server };
}

afterEach(async () => {
  for (const link of links.splice(0)) link.close();
  destroyRawSockets();
  for (const server of hubs.splice(0)) await server.close();
});

/** The reason a promise rejected with. */
async function rejection(promise: Promise<unknown>): Promise<any> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

function peerRequest(headers: Record<string, string | null> = {}, nonce: string | null = newNonce()): string {
  const all: Record<string, string | null> = {
    Host: "127.0.0.1",
    Connection: "Upgrade",
    Upgrade: "cce-peer",
    "X-CCE-Nonce": nonce,
    ...headers,
  };
  const lines = Object.entries(all).filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${value}\r\n`);
  return `GET /_peer HTTP/1.1\r\n${lines.join("")}\r\n`;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("calls and events", () => {
  test("call() round-trips the arguments and the return value", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler(async (method: string, args: { a: number; b: number }) => {
      if (method === "add") return args.a + args.b;
      throw new Error(`unknown method ${method}`);
    });
    expect(await client.call("add", { a: 1, b: 2 })).toBe(3);
  });

  test("either side can call the other", async () => {
    const { client, server } = await pair(await startHub());
    client.setHandler(async (method: string) => `client:${method}`);
    server.setHandler(async (method: string) => `server:${method}`);
    expect(await server.call("ping")).toBe("client:ping");
    expect(await client.call("ping")).toBe("server:ping");
  });

  test("a handler may be synchronous; any JSON value comes back as it went", async () => {
    const { client, server } = await pair(await startHub());
    const values = [null, 0, false, "", "line\nbreak \"quoted\" é € 😀", [1, [2, { three: 3 }]], { a: { b: [] } }];
    server.setHandler((_method: string, args: unknown) => args);
    for (const value of values) expect(await client.call("echo", value)).toEqual(value);
  });

  test("no arguments and no return value come back as undefined", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler(async (_method: string, args: unknown) => {
      expect(args).toBeUndefined();
    });
    expect(await client.call("nothing")).toBeUndefined();
  });

  test("a handler that throws or rejects rejects the call with its message", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler((method: string) => {
      if (method === "sync") throw new Error("sync boom");
      if (method === "string") return Promise.reject("rejected with a string");
      return Promise.reject(new Error("async boom"));
    });
    for (const [method, message] of [["sync", "sync boom"], ["async", "async boom"], ["string", "rejected with a string"]]) {
      const error = await rejection(client.call(method));
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(message);
    }
  });

  test("a call nobody handles rejects with no_handler", async () => {
    const { client } = await pair(await startHub());
    expect((await rejection(client.call("anything"))).message).toBe("no_handler");
  });

  test("a result JSON cannot carry rejects the call instead of leaving it hanging", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler(async () => 10n);
    expect((await rejection(client.call("big"))).message).toBe("unserializable_result");
  });

  test("arguments JSON cannot carry reject without throwing synchronously", async () => {
    const { client } = await pair(await startHub());
    let promise: Promise<unknown>;
    try {
      promise = client.call("big", 10n);
    } catch {
      throw new Error("call() threw instead of rejecting");
    }
    expect((await rejection(promise)).message).toContain("BigInt");
  });

  test("concurrent calls settle independently, in any order", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler(async (_method: string, args: { ms: number; value: string }) => {
      await sleep(args.ms);
      return args.value;
    });
    const settled: string[] = [];
    const slow = client.call("wait", { ms: 60, value: "slow" }).then((v: string) => settled.push(v));
    const fast = client.call("wait", { ms: 1, value: "fast" }).then((v: string) => settled.push(v));
    await Promise.all([slow, fast]);
    expect(settled).toEqual(["fast", "slow"]);
  });

  test("notify() arrives as an event with its name and data, in order, in both directions", async () => {
    const { client, server } = await pair(await startHub());
    const atServer: unknown[] = [];
    const atClient: unknown[] = [];
    server.on("event", (name: string, data: unknown) => atServer.push([name, data]));
    client.on("event", (name: string, data: unknown) => atClient.push([name, data]));
    expect(client.notify("project", { id: 1, name: "cce-patch" })).toBe(true);
    expect(client.notify("session", { id: "s1", state: "running" })).toBe(true);
    expect(server.notify("active", { on: true })).toBe(true);
    await withTimeout(
      (async () => {
        while (atServer.length < 2 || atClient.length < 1) await sleep(2);
      })(),
      "the events",
    );
    expect(atServer).toEqual([["project", { id: 1, name: "cce-patch" }], ["session", { id: "s1", state: "running" }]]);
    expect(atClient).toEqual([["active", { on: true }]]);
  });
});

describe("a 5 MB value", () => {
  test("survives in both directions: newline framing, no corruption where reads split it", async () => {
    const { client, server } = await pair(await startHub());
    // Raw newlines, carriage returns, quotes, a lookalike protocol message, and multi-byte characters
    // that a chunk boundary is likely to land inside.
    const unit = 'line one\nline two\r\n\t"quoted" \\ back é € 😀 {"t":"call","id":999,"m":"evil"}\n';
    const blob = unit.repeat(Math.ceil((5 * 1024 * 1024) / unit.length));
    expect(blob.length).toBeGreaterThanOrEqual(5 * 1024 * 1024);
    const value = { blob, list: [blob.slice(0, 1000), { nested: blob.slice(1000, 2000) }] };
    server.setHandler(async (_method: string, args: unknown) => args);
    const echoed = await client.call("echo", value, { timeoutMs: 15000 });
    expect(echoed.blob === value.blob).toBe(true);
    expect(JSON.stringify(echoed) === JSON.stringify(value)).toBe(true);
  });
});

describe("timeouts and closing", () => {
  test("call() rejects with timeout when no answer comes, and the link keeps working", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler((method: string) => (method === "hang" ? new Promise(() => {}) : "fine"));
    const started = Date.now();
    expect((await rejection(client.call("hang", null, { timeoutMs: 50 }))).message).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client._pending.size).toBe(0); // a timed-out call leaves nothing behind
    expect(await client.call("other")).toBe("fine");
  });

  test("an answer that arrives after the timeout is ignored", async () => {
    const { client, server } = await pair(await startHub());
    let release: (value: string) => void = () => {};
    server.setHandler((method: string) => (method === "late" ? new Promise<string>((resolve) => (release = resolve)) : "fine"));
    expect((await rejection(client.call("late", null, { timeoutMs: 20 }))).message).toBe("timeout");
    release("too late");
    await sleep(30);
    expect(client._pending.size).toBe(0);
    expect(await client.call("other")).toBe("fine");
  });

  test("call() on a closed link rejects with closed at once, and notify() returns false", async () => {
    const { client } = await pair(await startHub());
    client.close();
    let rejected: Error | undefined;
    client.call("x").catch((error: Error) => (rejected = error));
    await Promise.resolve(); // two microtask turns: an immediate rejection has landed, one that waits for the socket has not
    await Promise.resolve();
    expect(rejected?.message).toBe("closed");
    expect(client.notify("x", 1)).toBe(false);
  });

  test("pending calls reject with closed when the other side closes; each side emits close once", async () => {
    const { client, server } = await pair(await startHub());
    server.setHandler(() => new Promise(() => {}));
    let clientCloses = 0;
    let serverCloses = 0;
    client.on("close", () => clientCloses++);
    server.on("close", () => serverCloses++);
    const pending = client.call("hang");
    await sleep(10);
    server.close();
    expect((await rejection(pending)).message).toBe("closed");
    await withTimeout(
      (async () => {
        while (clientCloses < 1 || serverCloses < 1) await sleep(2);
      })(),
      "both close events",
    );
    client.close();
    server.close();
    await sleep(20);
    expect([clientCloses, serverCloses]).toEqual([1, 1]);
  });

  test("close() delivers everything written before it, even what the socket could not take at once", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port);
    const link = await hub.links.next();
    const blob = "x".repeat(3 * 1024 * 1024);
    link.notify("big", { blob });
    link.close();
    const event = JSON.parse(await raw.line());
    expect(event.e).toBe("big");
    expect(event.d.blob === blob).toBe(true);
    await raw.closed;
  });

  test("a link accepted after its socket is gone still emits close, once", async () => {
    // A caller that checks something asynchronously before it accepts can find the other side gone by then.
    const closes = queue<true>();
    const late = await listenUpgrade((req, socket, head) => {
      setTimeout(() => {
        const link = acceptPeer(req, socket, head, SECRET);
        link.on("close", () => closes.push(true));
      }, 80);
    });
    hubs.push(late);
    const client = net.connect(late.port, "127.0.0.1", () => client.write(peerRequest()));
    await sleep(20);
    client.destroy();
    await closes.next("the close event");
    await sleep(50);
    expect(closes.pending).toBe(0);
  });
});

describe("close events", () => {
  test("close is emitted once even if the socket's own close event follows a late accept", async () => {
    // The socket was destroyed but had not emitted 'close' yet when the link was built.
    const socket = stubSocket();
    socket.destroyed = true;
    const link = new PeerLink(socket);
    let closes = 0;
    link.on("close", () => closes++);
    socket.emit("close");
    await sleep(10);
    expect(closes).toBe(1);
  });
});

describe("connectPeer", () => {
  test("rejects with the socket error code when nothing listens", async () => {
    const error = await rejection(connectPeer({ port: await freePort(), secret: SECRET }));
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("ECONNREFUSED");
    expect(error.code).toBe("ECONNREFUSED");
  });

  test("the upgrade request carries a fresh nonce and never the secret", async () => {
    const requests: Array<{ headers: Record<string, string>; text: string }> = [];
    const seen = await listenUpgrade((req, socket, head) => {
      requests.push({ headers: req.headers, text: `${req.method} ${req.url} ${JSON.stringify(req.headers)} ${head.toString("latin1")}` });
      socket.destroy();
    });
    hubs.push(seen);
    await rejection(connectPeer({ port: seen.port, secret: SECRET }));
    await rejection(connectPeer({ port: seen.port, secret: SECRET }));
    expect(requests).toHaveLength(2);
    const [one, two] = requests.map(({ headers }) => headers["x-cce-nonce"]);
    expect(one).toMatch(NONCE_RE);
    expect(two).toMatch(NONCE_RE);
    expect(one).not.toBe(two);
    for (const { headers, text } of requests) {
      expect(text).toStartWith("GET /_peer ");
      expect(headers.upgrade).toBe("cce-peer");
      expect(text).not.toContain(SECRET);
      expect(text.toLowerCase()).not.toContain("x-cce-secret");
    }
  });

  test("a hub that knows another secret is refused, and is sent nothing after the request", async () => {
    const hub = await startHub({ secret: "f".repeat(64) });
    const error = await rejection(connectPeer({ port: hub.port, secret: SECRET }));
    expect(error.message).toBe("refused");
    expect(error.code).toBe("refused");
    const link = hub.accepted[0];
    expect(link).not.toBeNull(); // the hub answered, with a proof made of its own secret
    await withTimeout(new Promise((resolve) => link.once("close", resolve)), "the hub's end to close");
    expect(hub.links.pending).toBe(0); // no auth line ever came
  });

  /** A server that answers every upgrade with `answer(peerNonce)`, then records whatever else the peer sends. */
  async function impostor(answer: (peerNonce: string) => string) {
    const after: Buffer[] = [];
    const server = await listenUpgrade((req, socket, head) => {
      if (head.length) after.push(head);
      socket.on("data", (chunk: Buffer) => after.push(chunk));
      socket.write(answer(req.headers["x-cce-nonce"] ?? ""));
    });
    hubs.push(server);
    return { port: server.port, sentAfterRequest: () => Buffer.concat(after).toString("latin1") };
  }

  const UPGRADED = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: cce-peer\r\nConnection: Upgrade\r\n";
  test.each([
    ["no proof at all (what any program can answer)", () => `${UPGRADED}\r\n`],
    ["a nonce without a proof", () => `${UPGRADED}X-CCE-Nonce: ${newNonce()}\r\n\r\n`],
    ["a proof without a nonce", (peer: string) => `${UPGRADED}X-CCE-Proof: ${proofOf(SECRET, "hub", peer, "")}\r\n\r\n`],
    ["a made-up proof", () => `${UPGRADED}X-CCE-Nonce: ${newNonce()}\r\nX-CCE-Proof: ${"0".repeat(64)}\r\n\r\n`],
    ["the peer's own proof (a reflection)", (peer: string) => {
      const hub = newNonce();
      return `${UPGRADED}X-CCE-Nonce: ${hub}\r\nX-CCE-Proof: ${proofOf(SECRET, "peer", peer, hub)}\r\n\r\n`;
    }],
    ["a proof for another peer nonce", () => {
      const hub = newNonce();
      return `${UPGRADED}X-CCE-Nonce: ${hub}\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", newNonce(), hub)}\r\n\r\n`;
    }],
    ["a proof for another hub nonce", (peer: string) => `${UPGRADED}X-CCE-Nonce: ${newNonce()}\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", peer, newNonce())}\r\n\r\n`],
    ["a nonce that is not 32 bytes of hex", (peer: string) => `${UPGRADED}X-CCE-Nonce: abc\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", peer, "abc")}\r\n\r\n`],
    ["the proof in upper case", (peer: string) => {
      const hub = newNonce();
      return `${UPGRADED}X-CCE-Nonce: ${hub}\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", peer, hub).toUpperCase()}\r\n\r\n`;
    }],
    ["the proof twice", (peer: string) => {
      const hub = newNonce();
      const proof = proofOf(SECRET, "hub", peer, hub);
      return `${UPGRADED}X-CCE-Nonce: ${hub}\r\nX-CCE-Proof: ${proof}\r\nX-CCE-Proof: ${proof}\r\n\r\n`;
    }],
  ] as Array<[string, (peerNonce: string) => string]>)("a 101 with %s is refused, and the program is sent nothing after the request", async (_label, answer) => {
    const fake = await impostor(answer);
    const error = await rejection(connectPeer({ port: fake.port, secret: SECRET }));
    expect(error.message).toBe("refused");
    await sleep(20);
    expect(fake.sentAfterRequest()).toBe("");
  });

  test("a hub's proof is accepted; the peer's first line is its own proof, and calls and events follow it", async () => {
    let auth: any;
    let firstLines = "";
    const fake = await listenUpgrade((req, socket) => {
      const peerNonce = req.headers["x-cce-nonce"];
      const hubNonce = newNonce();
      socket.on("data", (chunk: Buffer) => (firstLines += chunk.toString("utf8")));
      socket.write(`${UPGRADED}X-CCE-Nonce: ${hubNonce}\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", peerNonce, hubNonce)}\r\n\r\n`);
      auth = { peerNonce, hubNonce };
    });
    hubs.push(fake);
    const link = await connectPeer({ port: fake.port, secret: SECRET });
    links.push(link);
    link.notify("project", { id: "p" });
    await withTimeout(
      (async () => {
        while (firstLines.split("\n").length < 3) await sleep(2);
      })(),
      "two lines",
    );
    const [first, second] = firstLines.split("\n");
    expect(JSON.parse(first)).toEqual({ t: "auth", proof: proofOf(SECRET, "peer", auth.peerNonce, auth.hubNonce) });
    expect(JSON.parse(second)).toEqual({ t: "evt", e: "project", d: { id: "p" } });
    expect(firstLines).not.toContain(SECRET);
  });

  test("a response head with 16 KB of spaces inside a value is refused at once (it is read without backtracking)", async () => {
    const odd = await listenUpgrade((_req, socket) => {
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: cce-peer\r\nX-Pad: a${" ".repeat(16_000)}x\r\n\r\n`);
    });
    hubs.push(odd);
    const started = performance.now();
    expect((await rejection(connectPeer({ port: odd.port, secret: SECRET }))).message).toBe("refused");
    expect(performance.now() - started).toBeLessThan(50); // a backtracking trim takes about 160 ms here
  });

  test("a server that answers something else is refused", async () => {
    const odd = await listenUpgrade((_req, socket) => {
      socket.end("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    hubs.push(odd);
    expect((await rejection(connectPeer({ port: odd.port, secret: SECRET }))).message).toBe("refused");
  });

  test("a 101 for another protocol is refused, even with a good proof", async () => {
    const other = await listenUpgrade((req, socket) => {
      const hub = newNonce();
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-CCE-Nonce: ${hub}\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", req.headers["x-cce-nonce"], hub)}\r\n\r\n`);
    });
    hubs.push(other);
    expect((await rejection(connectPeer({ port: other.port, secret: SECRET }))).message).toBe("refused");
  });

  test("a 200 that carries the Upgrade header and a good proof is not an upgrade", async () => {
    const odd = await listenUpgrade((req, socket) => {
      const hub = newNonce();
      socket.write(`HTTP/1.1 200 OK\r\nUpgrade: cce-peer\r\nConnection: Upgrade\r\nX-CCE-Nonce: ${hub}\r\nX-CCE-Proof: ${proofOf(SECRET, "hub", req.headers["x-cce-nonce"], hub)}\r\nContent-Length: 0\r\n\r\n`);
    });
    hubs.push(odd);
    expect((await rejection(connectPeer({ port: odd.port, secret: SECRET }))).message).toBe("refused");
  });

  test("a server that hangs up without answering is refused", async () => {
    const dead = await listenUpgrade((_req, socket) => socket.destroy());
    hubs.push(dead);
    expect((await rejection(connectPeer({ port: dead.port, secret: SECRET }))).message).toBe("refused");
  });

  test("a server that never answers times out after timeoutMs", async () => {
    const silent = await listenUpgrade(() => {});
    hubs.push(silent);
    const started = Date.now();
    expect((await rejection(connectPeer({ port: silent.port, secret: SECRET, timeoutMs: 100 }))).message).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(1000);
  });

  test("a missing secret is rejected before connecting", async () => {
    for (const secret of ["", undefined as unknown as string, 42 as unknown as string]) {
      expect((await rejection(connectPeer({ port: await freePort(), secret }))).message).toBe("bad_secret");
    }
  });
});

describe("acceptPeer", () => {
  test("answers 101 with its own nonce and its proof: HMAC-SHA256 of hub, the peer's nonce and its own, keyed with the secret", async () => {
    const hub = await startHub();
    const nonce = newNonce();
    const raw = await RawConn.open(hub.port, peerRequest({}, nonce));
    const lines = raw.head.split("\r\n");
    expect(lines.slice(0, 3)).toEqual(["HTTP/1.1 101 Switching Protocols", "Upgrade: cce-peer", "Connection: Upgrade"]);
    const hubNonce = raw.header("X-CCE-Nonce")!;
    expect(hubNonce).toMatch(NONCE_RE);
    expect(hubNonce).not.toBe(nonce);
    expect(raw.header("X-CCE-Proof")).toBe(proofOf(SECRET, "hub", nonce, hubNonce));
    expect(lines).toHaveLength(5);
    expect(raw.head).not.toContain(SECRET);
    expect(hub.accepted[0]).not.toBeNull();
    expect(hub.accepted[0].authenticated).toBe(false);
  });

  test("every upgrade gets a nonce of its own", async () => {
    const hub = await startHub();
    const nonce = newNonce();
    const one = await RawConn.open(hub.port, peerRequest({}, nonce));
    const two = await RawConn.open(hub.port, peerRequest({}, nonce));
    expect(one.header("X-CCE-Nonce")).not.toBe(two.header("X-CCE-Nonce"));
  });

  test("the right proof as the first line: auth, once, and the link works", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port);
    const link = await hub.links.next("the authenticated link");
    links.push(link);
    expect(link.authenticated).toBe(true);
    link.setHandler(async (method: string) => `handled ${method}`);
    raw.send('{"t":"call","id":1,"m":"ping"}\n');
    expect(JSON.parse(await raw.line())).toEqual({ t: "ret", id: 1, ok: true, v: "handled ping" });
  });

  test.each([
    ["a wrong proof", (hubNonce: string) => `${JSON.stringify({ t: "auth", proof: proofOf("f".repeat(64), "peer", newNonce(), hubNonce) })}\n`],
    ["the hub's own proof sent back (a reflection)", (hubNonce: string, peerNonce: string) => `${JSON.stringify({ t: "auth", proof: proofOf(SECRET, "hub", peerNonce, hubNonce) })}\n`],
    ["a call before any proof", () => '{"t":"call","id":1,"m":"snapshot","a":{"session":"s1"}}\n'],
    ["an event before any proof", () => '{"t":"evt","e":"project","d":{"id":"p"}}\n'],
    ["a blank first line", () => "\n"],
    ["text that is not JSON", () => "hello\n"],
    ["an auth line without a proof", () => '{"t":"auth"}\n'],
    ["a proof that is not a string", () => '{"t":"auth","proof":42}\n'],
  ] as Array<[string, (hubNonce: string, peerNonce: string) => string]>)("%s closes the link: no auth, nothing answered, nothing delivered", async (_label, first) => {
    let called = false;
    const delivered: unknown[] = [];
    const hub = await startHub({ onLink: (link) => link.setHandler(() => (called = true)) });
    const { raw } = await rawPeer(hub.port, { auth: first, after: '{"t":"call","id":2,"m":"send","a":{}}\n{"t":"evt","e":"session","d":{}}\n' });
    const link = hub.accepted[0];
    link.on("event", (name: string, data: unknown) => delivered.push([name, data]));
    await raw.closed;
    expect(hub.links.pending).toBe(0);
    expect(link.authenticated).toBe(false);
    expect(called).toBe(false);
    expect(delivered).toEqual([]);
    expect(raw.rest.length).toBe(0); // not a byte after the 101
  });

  test("the proof made for another peer nonce (a replay) closes the link", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port, { auth: (hubNonce) => `${JSON.stringify({ t: "auth", proof: proofOf(SECRET, "peer", newNonce(), hubNonce) })}\n` });
    await raw.closed;
    expect(hub.links.pending).toBe(0);
  });

  test("before its proof the link sends nothing: call() rejects not_authenticated and notify() returns false", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port, { auth: null });
    await withTimeout(
      (async () => {
        while (hub.accepted.length === 0) await sleep(2);
      })(),
      "the upgrade",
    );
    const link = hub.accepted[0];
    links.push(link);
    expect((await rejection(link.call("snapshot", { session: "s1" }))).message).toBe("not_authenticated");
    expect(link.notify("active", { on: true })).toBe(false);
    await sleep(20);
    expect(raw.rest.length).toBe(0);
  });

  test("no proof within authTimeoutMs closes the link", async () => {
    const hub = await startHub({ authTimeoutMs: 80 });
    const started = Date.now();
    const { raw } = await rawPeer(hub.port, { auth: null });
    await withTimeout(raw.closed, "the link to close");
    expect(Date.now() - started).toBeLessThan(1000);
    expect(hub.links.pending).toBe(0);
  });

  test("a first line longer than 1 KB closes the link before it ends", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port, { auth: () => `{"t":"auth","proof":"${"a".repeat(4096)}` });
    await withTimeout(raw.closed, "the link to close");
    expect(hub.links.pending).toBe(0);
  });

  test.each([
    ["no nonce", null],
    ["an empty nonce", ""],
    ["a nonce that is too short", "ab".repeat(16)],
    ["a nonce that is not hex", "z".repeat(64)],
    ["a nonce in upper case", "AB".repeat(32)],
    ["two nonces", `${"a".repeat(64)}, ${"b".repeat(64)}`],
  ] as Array<[string, string | null]>)("%s -> 403 and null", async (_label, nonce) => {
    const hub = await startHub();
    const response = await rawRequest(hub.port, peerRequest({}, nonce));
    expect(response.startsWith("HTTP/1.1 403 ")).toBe(true);
    expect(hub.accepted).toEqual([null]);
  });

  test("the secret sent the old way (X-CCE-Secret, no nonce) is refused: 403", async () => {
    const hub = await startHub();
    const response = await rawRequest(hub.port, peerRequest({ "X-CCE-Secret": SECRET }, null));
    expect(response.startsWith("HTTP/1.1 403 ")).toBe(true);
    expect(hub.accepted).toEqual([null]);
  });

  test("an empty configured secret accepts nobody", async () => {
    const hub = await startHub({ secret: "" });
    const response = await rawRequest(hub.port, peerRequest());
    expect(response.startsWith("HTTP/1.1 403 ")).toBe(true);
    expect(hub.accepted).toEqual([null]);
  });

  test.each([
    ["Tailscale-User-Login", "owner@example.com"],
    ["tailscale-funnel-request", "?1"],
    ["TAILSCALE-APP-CAPABILITIES", "{}"],
  ])("a %s header is refused even with a good nonce: 403", async (name, value) => {
    const hub = await startHub();
    const response = await rawRequest(hub.port, peerRequest({ [name]: value }));
    expect(response.startsWith("HTTP/1.1 403 ")).toBe(true);
    expect(hub.accepted).toEqual([null]);
  });

  test("an Upgrade header other than cce-peer is a 400, whatever the nonce", async () => {
    const hub = await startHub();
    const response = await rawRequest(hub.port, peerRequest({ Upgrade: "websocket" }));
    expect(response.startsWith("HTTP/1.1 400 ")).toBe(true);
    expect(hub.accepted).toEqual([null]);
  });
});

describe("what comes with the upgrade and the proof", () => {
  test("accept side: a call in the same write as the proof reaches a handler attached in the auth event", async () => {
    const hub = await startHub({ onLink: (link) => link.setHandler(async (method: string) => `handled ${method}`) });
    const { raw } = await rawPeer(hub.port, { after: '{"t":"call","id":1,"m":"early"}\n' });
    links.push(await hub.links.next());
    expect(JSON.parse(await raw.line())).toEqual({ t: "ret", id: 1, ok: true, v: "handled early" });
  });

  test("connect side: what the hub writes the moment the proof is in reaches a caller who attaches after `await connectPeer`", async () => {
    // A hub greets a peer and asks for its state in the same tick as it accepts the proof.
    let snapshot: Promise<unknown> = Promise.resolve();
    const hub = await startHub({
      onLink: (link) => {
        link.notify("hello", { n: 1 });
        snapshot = link.call("snapshot", { session: "s1" });
        snapshot.catch(() => {});
      },
    });
    const peer = await connectPeer({ port: hub.port, secret: SECRET });
    links.push(peer, await hub.links.next());
    const events: unknown[] = [];
    peer.on("event", (name: string, data: unknown) => events.push([name, data]));
    peer.setHandler(async (method: string, args: unknown) => ({ method, args }));
    expect(await snapshot).toEqual({ method: "snapshot", args: { session: "s1" } });
    expect(events).toEqual([["hello", { n: 1 }]]);
  });

  test("the link holds its socket paused until the upgrade's bytes are delivered, and nothing arriving later overtakes them", async () => {
    const socket = stubSocket();
    const link = new PeerLink(socket, Buffer.from('{"t":"evt","e":"first"}\n'));
    const seen: string[] = [];
    link.on("event", (name: string) => seen.push(name));
    expect(socket.paused).toBe(true);
    socket.receive('{"t":"evt","e":"second"}\n'); // behind it on the wire
    expect(seen).toEqual([]); // nothing is read before the caller's turn is over
    await new Promise((resolve) => setImmediate(resolve)); // the link's own turn comes first (FIFO)
    expect(seen).toEqual(["first", "second"]);
    expect(socket.paused).toBe(false);
  });

  test("a link closed before its first turn still drains the socket, delivering nothing", async () => {
    const socket = stubSocket();
    const link = new PeerLink(socket, Buffer.from('{"t":"evt","e":"first"}\n'));
    const seen: string[] = [];
    link.on("event", (name: string) => seen.push(name));
    link.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([]);
    expect(socket.paused).toBe(false); // resumed: what the peer still sends is read and dropped, not left to reset the connection
  });
});

describe("the wire: newline-delimited JSON", () => {
  test("call lines carry increasing integer ids; ret lines settle them", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port);
    const link = await hub.links.next();
    links.push(link);
    const calls = [link.call("a", { x: 1 }), link.call("b"), link.call("c", [1, 2])];
    const settled = Promise.allSettled(calls);
    expect(JSON.parse(await raw.line())).toEqual({ t: "call", id: 1, m: "a", a: { x: 1 } });
    expect(JSON.parse(await raw.line())).toEqual({ t: "call", id: 2, m: "b" });
    expect(JSON.parse(await raw.line())).toEqual({ t: "call", id: 3, m: "c", a: [1, 2] });
    raw.send('{"t":"ret","id":2,"ok":true,"v":"two"}\n{"t":"ret","id":1,"ok":false,"e":"nope"}\n{"t":"ret","id":3,"ok":true}\n');
    const [first, second, third] = await settled;
    expect(first.status).toBe("rejected");
    expect((first as PromiseRejectedResult).reason.message).toBe("nope");
    expect(second).toEqual({ status: "fulfilled", value: "two" });
    expect(third).toEqual({ status: "fulfilled", value: undefined });
  });

  test("incoming calls are answered with ret lines; notify() writes evt lines", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port);
    const link = await hub.links.next();
    links.push(link);
    link.setHandler(async (method: string, args: unknown) => {
      if (method === "fail") throw new Error("boom");
      return args;
    });
    raw.send('{"t":"call","id":7,"m":"echo","a":[1]}\n{"t":"call","id":8,"m":"fail"}\n');
    const rets = [JSON.parse(await raw.line()), JSON.parse(await raw.line())].sort((a, b) => a.id - b.id);
    expect(rets).toEqual([
      { t: "ret", id: 7, ok: true, v: [1] },
      { t: "ret", id: 8, ok: false, e: "boom" },
    ]);
    link.notify("project", { id: 1 });
    expect(JSON.parse(await raw.line())).toEqual({ t: "evt", e: "project", d: { id: 1 } });
    const received: unknown[] = [];
    link.on("event", (name: string, data: unknown) => received.push([name, data]));
    raw.send('{"t":"evt","e":"session","d":{"s":"a"}}\n');
    await sleep(20);
    expect(received).toEqual([["session", { s: "a" }]]);
  });

  test("several lines in one chunk, a line split across chunks, blank lines and junk are all tolerated", async () => {
    const hub = await startHub();
    const { raw } = await rawPeer(hub.port);
    const link = await hub.links.next();
    links.push(link);
    const received: unknown[] = [];
    link.on("event", (name: string, data: unknown) => received.push([name, data]));
    raw.send('{"t":"evt","e":"a","d":1}\n{"t":"evt","e":"b","d":2}\n{"t":"ev');
    await sleep(10);
    raw.send('t","e":"c","d":3}\n\nnot json\n[1,2]\n{"t":"nope"}\n{"t":"call"}\n{"t":"evt","e":"d","d":4}\n');
    // A multi-byte character cut in two by a chunk boundary.
    const euro = Buffer.from('{"t":"evt","e":"u","d":"€"}\n');
    const cut = euro.indexOf(0xe2) + 1;
    await sleep(10);
    raw.send(euro.subarray(0, cut));
    await sleep(10);
    raw.send(euro.subarray(cut));
    await withTimeout(
      (async () => {
        while (received.length < 5) await sleep(2);
      })(),
      "five events",
    );
    expect(received).toEqual([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["u", "€"]]);
  });

  test("an event listener that throws does not cost the lines behind it, answers included", async () => {
    const socket = stubSocket();
    const link = new PeerLink(socket);
    const seen: string[] = [];
    link.on("event", (name: string) => {
      seen.push(name);
      if (name === "bad") throw new Error("listener bug");
    });
    const answer = link.call("x"); // id 1
    const lines = '{"t":"evt","e":"a"}\n{"t":"evt","e":"bad"}\n{"t":"evt","e":"c"}\n{"t":"ret","id":1,"ok":true,"v":42}\n';
    expect(() => socket.emit("data", Buffer.from(lines))).toThrow("listener bug"); // still surfaces, as any listener error does
    expect(seen).toEqual(["a", "bad", "c"]);
    expect(await answer).toBe(42);
    socket.emit("data", Buffer.from('{"t":"evt","e":"d"}\n'));
    expect(seen).toEqual(["a", "bad", "c", "d"]);
  });
});
