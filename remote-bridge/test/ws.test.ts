import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import net from "node:net";
import { WsConnection, acceptWebSocket } from "../lib/ws.js";
import {
  OP, RawConn, clientFrame, destroyRawSockets, frameHead, listenUpgrade, queue, rawRequest, sleep, stubSocket, withTimeout,
  type Frame, type Queue, type UpgradeServer,
} from "./support";

interface Fixture extends UpgradeServer {
  url: string;
  /** What acceptWebSocket returned for each request, in order (null = it refused). */
  accepted: any[];
  connections: Queue<any>;
  /** Every `message` event of every connection. */
  messages: Queue<string>;
  /** Every `close` event of every connection. */
  closes: Queue<{ code: number; reason: string }>;
}

async function startWs({ echo = false, ...options }: { maxPayload?: number; closeTimeoutMs?: number; echo?: boolean } = {}): Promise<Fixture> {
  const accepted: any[] = [];
  const connections = queue<any>();
  const messages = queue<string>();
  const closes = queue<{ code: number; reason: string }>();
  const server = await listenUpgrade((req, socket, head) => {
    const conn = acceptWebSocket(req, socket, head, options);
    accepted.push(conn);
    if (!conn) return;
    conn.on("message", (text: string) => {
      messages.push(text);
      if (echo) conn.send(text);
    });
    conn.on("close", (code: number, reason: string) => closes.push({ code, reason }));
    connections.push(conn);
  });
  return { ...server, url: `ws://127.0.0.1:${server.port}/ws`, accepted, connections, messages, closes };
}

// Bun's built-in WebSocket client.
const clients: WebSocket[] = [];

async function openClient(url: string, options?: object): Promise<WebSocket> {
  const ws = new WebSocket(url, options as any);
  clients.push(ws);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the WebSocket failed before it opened"));
    }),
    "the WebSocket to open",
  );
  return ws;
}

const nextMessage = (ws: WebSocket) =>
  withTimeout(new Promise<string>((resolve) => (ws.onmessage = (event) => resolve(event.data as string))), "a message");

const nextClose = (ws: WebSocket) =>
  withTimeout(
    new Promise<{ code: number; reason: string }>((resolve) => (ws.onclose = (event) => resolve({ code: event.code, reason: event.reason }))),
    "the close event",
  );

// Raw TCP client: the handshake is written by hand so a test controls every byte after it.
const SAMPLE_KEY = "dGhlIHNhbXBsZSBub25jZQ=="; // from RFC 6455, section 1.3

function upgradeRequest(headers: Record<string, string | null> = {}, method = "GET"): string {
  const all: Record<string, string | null> = {
    Host: "127.0.0.1",
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": SAMPLE_KEY,
    "Sec-WebSocket-Version": "13",
    ...headers,
  };
  const lines = Object.entries(all).filter(([, value]) => value !== null).map(([name, value]) => `${name}: ${value}\r\n`);
  return `${method} /ws HTTP/1.1\r\n${lines.join("")}\r\n`;
}

/** A raw client past the handshake; `trailing` bytes go out in the same write as the request. */
function openRaw(fx: Fixture, headers?: Record<string, string | null>, trailing?: Buffer): Promise<RawConn> {
  const request = Buffer.from(upgradeRequest(headers), "latin1");
  return RawConn.open(fx.port, trailing ? Buffer.concat([request, trailing]) : request);
}

const pattern = (length: number) => "abcdefghijklmnopqrstuvwxyz".repeat(Math.ceil(length / 26)).slice(0, length);
const closeCode = (frame: Frame) => frame.payload.readUInt16BE(0);
const closeReason = (frame: Frame) => frame.payload.subarray(2).toString("utf8");
const statusAndReason = (code: number, reason = "") => Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]);

afterEach(() => {
  for (const ws of clients.splice(0)) ws.close();
  destroyRawSockets();
});

describe("round trips with Bun's WebSocket client", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs({ echo: true });
  });
  afterEach(() => fx.close());

  test.each([0, 1, 125, 126, 127, 65535, 65536])("echoes a %d-char text", async (length) => {
    const ws = await openClient(fx.url);
    const reply = nextMessage(ws);
    ws.send(pattern(length));
    expect(await reply).toBe(pattern(length));
  });

  test("echoes a 70 000-char text (64-bit length field in both directions)", async () => {
    const ws = await openClient(fx.url);
    const reply = nextMessage(ws);
    ws.send(pattern(70_000));
    expect((await reply) === pattern(70_000)).toBe(true);
  });

  test.each([
    ["mixed scripts and an emoji", "héllo wörld € 日本語 😀"],
    ["42 x euro sign (126 bytes in 42 chars)", "€".repeat(42)],
    ["21 846 x euro sign (65 538 bytes in 21 846 chars)", "€".repeat(21_846)],
  ])("echoes %s", async (_label, text) => {
    const ws = await openClient(fx.url);
    const reply = nextMessage(ws);
    ws.send(text);
    expect((await reply) === text).toBe(true);
  });

  test("delivers a burst of messages in order", async () => {
    const ws = await openClient(fx.url);
    const received: string[] = [];
    const done = withTimeout(
      new Promise<void>((resolve) => {
        ws.onmessage = (event) => {
          received.push(event.data as string);
          if (received.length === 200) resolve();
        };
      }),
      "200 echoes",
    );
    for (let i = 0; i < 200; i++) ws.send(`message ${i}`);
    await done;
    expect(received).toEqual(Array.from({ length: 200 }, (_, i) => `message ${i}`));
  });

  test("exposes the request headers and the Origin header", async () => {
    await openClient(fx.url, { headers: { "Tailscale-User-Login": "owner@example.com", Origin: "https://app.example.test" } });
    const conn = await fx.connections.next();
    expect(conn.headers["tailscale-user-login"]).toBe("owner@example.com");
    expect(conn.origin).toBe("https://app.example.test");
  });

  test("close(): the client sees 1000 and the closing handshake completes", async () => {
    const ws = await openClient(fx.url);
    const conn = await fx.connections.next();
    expect(conn.readyState).toBe("open");
    const closed = nextClose(ws);
    conn.close();
    expect(conn.readyState).toBe("closing");
    expect(await closed).toEqual({ code: 1000, reason: "" });
    expect(await fx.closes.next()).toEqual({ code: 1000, reason: "" });
    expect(conn.readyState).toBe("closed");
  });

  test("close(code, reason) delivers both", async () => {
    const ws = await openClient(fx.url);
    const conn = await fx.connections.next();
    const closed = nextClose(ws);
    conn.close(4401, "revoked");
    expect(await closed).toEqual({ code: 4401, reason: "revoked" });
  });

  test("a close from the client reports its code and reason", async () => {
    const ws = await openClient(fx.url);
    const conn = await fx.connections.next();
    ws.close(4000, "bye");
    expect(await fx.closes.next()).toEqual({ code: 4000, reason: "bye" });
    expect(conn.readyState).toBe("closed");
  });
});

describe("frames the server sends", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs();
  });
  afterEach(() => fx.close());

  test("a text frame has FIN set, no mask and no reserved bits", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.send("hello");
    expect(await raw.frame()).toEqual({ fin: true, rsv: 0, opcode: OP.text, masked: false, payload: Buffer.from("hello") });
  });

  test.each([
    [125, 125, 2],
    [126, 126, 4],
    [65535, 126, 4],
    [65536, 127, 10],
  ])("a %d-byte text uses length marker %d and a %d-byte header", async (length, marker, headerSize) => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.send(pattern(length));
    const bytes = await raw.until("the whole frame", () => (raw.rest.length >= headerSize + length ? Buffer.from(raw.rest) : undefined));
    expect(bytes[1]).toBe(marker);
    if (marker === 126) expect(bytes.readUInt16BE(2)).toBe(length);
    if (marker === 127) expect(bytes.readBigUInt64BE(2)).toBe(BigInt(length));
  });

  test("ping() sends an empty ping frame", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.ping();
    const frame = await raw.frame();
    expect(frame.opcode).toBe(OP.ping);
    expect(frame.payload.length).toBe(0);
  });
});

/** A stand-in socket whose client reads nothing: what is written stays queued (and its write callbacks wait) until flush(). */
function unreadSocket(): any {
  const socket = stubSocket();
  socket.writableLength = 0;
  const callbacks: Array<() => void> = [];
  socket.write = (data: Buffer | string, callback?: () => void) => {
    const bytes = Buffer.from(data);
    socket.written.push(bytes);
    socket.writableLength += bytes.length;
    if (callback) callbacks.push(callback);
    return false;
  };
  socket.flush = () => {
    socket.writableLength = 0;
    for (const callback of callbacks.splice(0)) callback();
  };
  return socket;
}

const pongsIn = (socket: any): string[] => socket.written.filter((f: Buffer) => f[0] === 0x8a).map((f: Buffer) => f.subarray(2).toString());

describe("pongs to a client that does not read", () => {
  const options = { headers: {}, maxPayload: 1024, closeTimeoutMs: 100 };

  test("while a pong is still queued, newer pings only replace the one waiting; the newest is answered once it went out", () => {
    const socket = unreadSocket();
    new WsConnection(socket, options);
    socket.emit("data", Buffer.concat([clientFrame(OP.ping, "a"), clientFrame(OP.ping, "b"), clientFrame(OP.ping, "c")]));
    expect(pongsIn(socket)).toEqual(["a"]);
    socket.flush();
    expect(pongsIn(socket)).toEqual(["a", "c"]); // RFC 6455 section 5.5.3: the latest ping is enough
    socket.flush();
    expect(pongsIn(socket)).toEqual(["a", "c"]);
  });

  test("only the pong that is still queued holds newer pings back: the late write callback of one that went out at once cannot release them", () => {
    // Node may write a frame to the network at once (nothing stays queued) and still call its callback later.
    const socket = unreadSocket();
    const write = socket.write;
    const later: Array<() => void> = [];
    let atOnce = true;
    socket.write = (data: Buffer | string, callback?: () => void) => {
      if (!atOnce) return write(data, callback);
      socket.written.push(Buffer.from(data));
      if (callback) later.push(callback);
      return true;
    };
    new WsConnection(socket, options);
    socket.emit("data", clientFrame(OP.ping, "a")); // goes out at once; its callback comes later
    atOnce = false;
    socket.emit("data", clientFrame(OP.ping, "b")); // stays queued: newer pings wait for it
    for (const callback of later.splice(0)) callback(); // a's callback, late
    socket.emit("data", clientFrame(OP.ping, "c"));
    expect(pongsIn(socket)).toEqual(["a", "b"]); // c waits for b, not for a
    socket.flush();
    expect(pongsIn(socket)).toEqual(["a", "b", "c"]);
  });

  test("a flood of pings costs one queued pong", () => {
    const socket = unreadSocket();
    new WsConnection(socket, options);
    const ping = clientFrame(OP.ping, "p".repeat(125));
    socket.emit("data", Buffer.concat(Array.from({ length: 10_000 }, () => ping)));
    expect(socket.written).toHaveLength(1);
    expect(socket.writableLength).toBe(127);
  });

  test("a client that floods pings and never reads keeps the server's queue small (real sockets)", async () => {
    const fx = await startWs();
    try {
      const client = net.connect(fx.port, "127.0.0.1");
      client.on("error", () => {});
      client.once("data", () => client.pause()); // the 101, then nothing is read any more
      await new Promise<void>((resolve) => client.once("connect", () => resolve()));
      client.write(upgradeRequest());
      const conn = await fx.connections.next();
      const ping = clientFrame(OP.ping, "p".repeat(125));
      const batch = Buffer.concat(Array.from({ length: 8000 }, () => ping)); // 1 MB of pings, 8000 pongs' worth
      for (let i = 0; i < 16; i++) {
        client.write(batch);
        await sleep(5);
      }
      await sleep(200);
      expect(conn.readyState).toBe("open");
      expect(conn.bufferedAmount).toBeLessThan(64 * 1024);
      client.destroy();
    } finally {
      await fx.close();
    }
  });
});

describe("maxBufferedBytes", () => {
  const options = { headers: {}, maxPayload: 1024, closeTimeoutMs: 100 };

  test("past the limit the connection is dropped instead of queueing more: send() refuses, close reports 1013", () => {
    const socket = unreadSocket();
    const conn = new WsConnection(socket, { ...options, maxBufferedBytes: 100 });
    const closes: number[] = [];
    conn.on("close", (code: number) => closes.push(code));
    expect(conn.send("x".repeat(150))).toBe(true); // the limit is looked at before a write: one big message goes
    expect(conn.send("y")).toBe(false);
    expect(socket.destroyed).toBe(true);
    expect(conn.readyState).toBe("closed");
    expect(closes).toEqual([1013]);
    expect(socket.written).toHaveLength(1);
  });

  test("a ping that arrives past the limit drops the connection without a pong", () => {
    const socket = unreadSocket();
    const conn = new WsConnection(socket, { ...options, maxBufferedBytes: 100 });
    conn.send("x".repeat(150));
    socket.emit("data", clientFrame(OP.ping, "a"));
    expect(socket.destroyed).toBe(true);
    expect(pongsIn(socket)).toEqual([]);
  });

  test("ping() past the limit drops the connection too", () => {
    const socket = unreadSocket();
    const conn = new WsConnection(socket, { ...options, maxBufferedBytes: 100 });
    conn.send("x".repeat(150));
    conn.ping();
    expect(socket.destroyed).toBe(true);
    expect(socket.written).toHaveLength(1);
  });

  test("setMaxBufferedBytes changes the limit; it takes a positive number (Infinity: no limit)", () => {
    const socket = unreadSocket();
    const conn = new WsConnection(socket, { ...options, maxBufferedBytes: 100 });
    conn.send("x".repeat(150));
    conn.setMaxBufferedBytes(1000);
    expect(conn.send("y")).toBe(true);
    for (const bad of [0, -1, Number.NaN, "10", undefined]) expect(() => conn.setMaxBufferedBytes(bad as any)).toThrow(TypeError);
    conn.setMaxBufferedBytes(Infinity);
    expect(conn.send("z".repeat(5000))).toBe(true);
    expect(conn.send("z")).toBe(true);
  });

  test("without the option nothing is dropped", () => {
    const socket = unreadSocket();
    const conn = new WsConnection(socket, options);
    for (let i = 0; i < 100; i++) expect(conn.send("x".repeat(10_000))).toBe(true);
    expect(conn.readyState).toBe("open");
  });
});

describe("setMaxPayload", () => {
  const options = { headers: {}, maxPayload: 10, closeTimeoutMs: 100 };

  test("raising the limit lets bigger messages through; lowering it refuses the next big one with 1009", () => {
    const socket = stubSocket();
    const conn = new WsConnection(socket, options);
    const seen: string[] = [];
    conn.on("message", (text: string) => seen.push(text));
    socket.emit("data", clientFrame(OP.text, "0123456789")); // exactly the limit
    conn.setMaxPayload(20);
    socket.emit("data", clientFrame(OP.text, "x".repeat(20)));
    expect(seen).toEqual(["0123456789", "x".repeat(20)]);
    conn.setMaxPayload(5);
    socket.emit("data", clientFrame(OP.text, "123456"));
    expect(seen).toHaveLength(2);
    expect(conn.readyState).not.toBe("open");
    expect(socket.written.at(-1).readUInt16BE(2)).toBe(1009);
  });

  test("a frame whose header was judged under the old limit is judged again under the new one", () => {
    const socket = stubSocket();
    const conn = new WsConnection(socket, options);
    const seen: string[] = [];
    conn.on("message", (text: string) => seen.push(text));
    const frame = clientFrame(OP.text, "y".repeat(30));
    conn.setMaxPayload(30);
    socket.emit("data", frame.subarray(0, 8)); // header in, payload not yet
    conn.setMaxPayload(10);
    socket.emit("data", frame.subarray(8));
    expect(seen).toEqual([]);
    expect(socket.written.at(-1).readUInt16BE(2)).toBe(1009);
  });

  test("a limit that is not a positive integer is a programming error", () => {
    const conn = new WsConnection(stubSocket(), options);
    for (const bad of [0, -1, 1.5, Number.NaN, "10", undefined]) expect(() => conn.setMaxPayload(bad as any)).toThrow(TypeError);
  });
});

describe("bufferedAmount", () => {
  test("is what the socket still holds back, as the socket counts it", () => {
    const socket = stubSocket();
    socket.writableLength = 0;
    const conn = new WsConnection(socket, { headers: {}, maxPayload: 1024, closeTimeoutMs: 100 });
    expect(conn.bufferedAmount).toBe(0);
    socket.writableLength = 12_345;
    expect(conn.bufferedAmount).toBe(12_345);
  });

  test("grows with a big send and falls back to 0 once the client has read it all", async () => {
    const fx = await startWs();
    try {
      const raw = await openRaw(fx);
      const conn = await fx.connections.next();
      expect(conn.bufferedAmount).toBe(0);
      const size = 4 * 1024 * 1024;
      conn.send(pattern(size));
      expect(conn.bufferedAmount).toBeGreaterThan(0); // more than any socket writes at once
      await raw.until("the whole message", () => (raw.rest.length >= 10 + size ? true : undefined), 10_000);
      for (let i = 0; i < 200 && conn.bufferedAmount > 0; i++) await sleep(10);
      expect(conn.bufferedAmount).toBe(0);
    } finally {
      await fx.close();
    }
  });
});

describe("frames the client sends", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs();
  });
  afterEach(() => fx.close());

  test("a fragmented message is reassembled", async () => {
    const raw = await openRaw(fx);
    raw.send(clientFrame(OP.text, "Hello, ", { fin: false }));
    raw.send(clientFrame(OP.cont, "wor", { fin: false }));
    raw.send(clientFrame(OP.cont, "ld"));
    expect(await fx.messages.next()).toBe("Hello, world");
    expect(fx.messages.pending).toBe(0);
  });

  test("a ping between fragments is answered, and a character split across fragments survives", async () => {
    const raw = await openRaw(fx);
    const euro = Buffer.from("€"); // e2 82 ac
    raw.send(clientFrame(OP.text, euro.subarray(0, 1), { fin: false }));
    raw.send(clientFrame(OP.ping, "mid"));
    raw.send(clientFrame(OP.cont, euro.subarray(1)));
    expect(await fx.messages.next()).toBe("€");
    const pong = await raw.frame();
    expect(pong.opcode).toBe(OP.pong);
    expect(pong.payload.toString()).toBe("mid");
  });

  test("a ping gets a pong with the same payload", async () => {
    const raw = await openRaw(fx);
    raw.send(clientFrame(OP.ping, "abc"));
    expect(await raw.frame()).toEqual({ fin: true, rsv: 0, opcode: OP.pong, masked: false, payload: Buffer.from("abc") });
  });

  test("an unsolicited pong is ignored", async () => {
    const raw = await openRaw(fx);
    raw.send(clientFrame(OP.pong, "x"));
    raw.send(clientFrame(OP.text, "after"));
    expect(await fx.messages.next()).toBe("after");
  });

  test("frames sent in the same write as the handshake, and two frames in one segment, arrive in order", async () => {
    await openRaw(fx, {}, Buffer.concat([clientFrame(OP.text, "first"), clientFrame(OP.text, "second")]));
    expect(await fx.messages.next()).toBe("first");
    expect(await fx.messages.next()).toBe("second");
  });

  test("a frame that arrives a few bytes at a time is parsed", async () => {
    const raw = await openRaw(fx);
    const frame = clientFrame(OP.text, "dribbled in");
    for (let at = 0; at < frame.length; at += 2) {
      raw.send(frame.subarray(at, at + 2));
      await sleep(2);
    }
    expect(await fx.messages.next()).toBe("dribbled in");
  });

  test("a 64-bit length field split across segments is parsed", async () => {
    const raw = await openRaw(fx);
    const frame = clientFrame(OP.text, pattern(70_000));
    for (const [from, to] of [[0, 1], [1, 2], [2, 6], [6, 10], [10, 12], [12, 14]]) {
      raw.send(frame.subarray(from, to));
      await sleep(2);
    }
    raw.send(frame.subarray(14));
    expect((await fx.messages.next()) === pattern(70_000)).toBe(true);
  });

  test("a message handler that closes the connection stops the frames that follow it", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.once("message", () => conn.close(4400, "bad first frame"));
    raw.send(Buffer.concat([clientFrame(OP.text, "one"), clientFrame(OP.text, "two")]));
    expect(await fx.messages.next()).toBe("one");
    const frame = await raw.frame();
    expect(frame.opcode).toBe(OP.close);
    expect(closeCode(frame)).toBe(4400);
    await sleep(20);
    expect(fx.messages.pending).toBe(0);
  });
});

describe("protocol violations close the connection with the code RFC 6455 names", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs();
  });
  afterEach(() => fx.close());

  test.each([
    ["an unmasked frame", 1002, () => clientFrame(OP.text, "hi", { mask: false })],
    ["a set reserved bit", 1002, () => clientFrame(OP.text, "hi", { rsv: 4 })],
    ["an unknown opcode", 1002, () => clientFrame(0x3, "x")],
    ["a continuation frame without a message to continue", 1002, () => clientFrame(OP.cont, "x")],
    ["a fragmented ping", 1002, () => clientFrame(OP.ping, "x", { fin: false })],
    ["a ping over 125 bytes", 1002, () => clientFrame(OP.ping, "x".repeat(126))],
    ["a close frame with a one-byte body", 1002, () => clientFrame(OP.close, Buffer.from([0x03]))],
    ["a close frame with a code that must not be sent (1005)", 1002, () => clientFrame(OP.close, statusAndReason(1005))],
    ["a close frame with a code below 1000", 1002, () => clientFrame(OP.close, statusAndReason(999))],
    ["a binary frame", 1003, () => clientFrame(OP.binary, Buffer.from([1, 2, 3]))],
    ["invalid UTF-8", 1007, () => clientFrame(OP.text, Buffer.from([0xc3, 0x28]))],
    ["invalid UTF-8 in a close reason", 1007, () => clientFrame(OP.close, Buffer.concat([statusAndReason(1000), Buffer.from([0xff])]))],
    [
      "a new data frame in the middle of a fragmented message",
      1002,
      () => Buffer.concat([clientFrame(OP.text, "a", { fin: false }), clientFrame(OP.text, "b")]),
    ],
    ["a 64-bit length with the top bit set", 1002, () => Buffer.concat([frameHead(OP.text, 2n ** 63n), Buffer.from([1, 2, 3, 4])])],
    [
      "a message in more than 4096 one-byte fragments",
      1009,
      () => Buffer.concat([clientFrame(OP.text, "a", { fin: false }), ...Array.from({ length: 5000 }, () => clientFrame(OP.cont, "a", { fin: false }))]),
    ],
  ])("%s -> %d", async (_label, code, build) => {
    const raw = await openRaw(fx);
    raw.send(build());
    const frame = await raw.frame();
    expect(frame.opcode).toBe(OP.close);
    expect(closeCode(frame)).toBe(code);
    await raw.closed;
    expect((await fx.closes.next()).code).toBe(code);
    expect(fx.messages.pending).toBe(0);
  });
});

describe("maxPayload", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs({ maxPayload: 1024 });
  });
  afterEach(() => fx.close());

  test("a message of exactly maxPayload bytes is delivered", async () => {
    const ws = await openClient(fx.url);
    ws.send(pattern(1024));
    expect(await fx.messages.next()).toBe(pattern(1024));
  });

  test("one byte more closes with 1009", async () => {
    const ws = await openClient(fx.url);
    const closed = nextClose(ws);
    ws.send(pattern(1025));
    expect((await closed).code).toBe(1009);
    expect(fx.messages.pending).toBe(0);
  });

  test("the declared length decides: the server answers 1009 without waiting for the payload", async () => {
    const raw = await openRaw(fx);
    raw.send(Buffer.concat([frameHead(OP.text, 2n ** 40n), Buffer.from([1, 2, 3, 4])]));
    const frame = await raw.frame();
    expect(frame.opcode).toBe(OP.close);
    expect(closeCode(frame)).toBe(1009);
  });

  test("the fragments of one message add up", async () => {
    const raw = await openRaw(fx);
    raw.send(clientFrame(OP.text, pattern(600), { fin: false }));
    raw.send(clientFrame(OP.cont, pattern(600)));
    const frame = await raw.frame();
    expect(closeCode(frame)).toBe(1009);
    expect(fx.messages.pending).toBe(0);
  });
});

describe("closing", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs({ closeTimeoutMs: 100 });
  });
  afterEach(() => fx.close());

  test("a close frame from the client is echoed, then the server ends the connection", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    raw.send(clientFrame(OP.close, statusAndReason(1001, "bye")));
    const echo = await raw.frame();
    expect(echo.opcode).toBe(OP.close);
    expect(closeCode(echo)).toBe(1001);
    await raw.closed;
    expect(await fx.closes.next()).toEqual({ code: 1001, reason: "bye" });
    expect(conn.readyState).toBe("closed");
  });

  test("a close frame without a status is answered without one and reported as 1005", async () => {
    const raw = await openRaw(fx);
    raw.send(clientFrame(OP.close));
    const echo = await raw.frame();
    expect(echo.opcode).toBe(OP.close);
    expect(echo.payload.length).toBe(0);
    expect(await fx.closes.next()).toEqual({ code: 1005, reason: "" });
  });

  test("a long close reason is cut at a character boundary to fit the 125-byte control frame", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.close(1000, "é".repeat(100)); // 200 bytes
    const frame = await raw.frame();
    expect(frame.payload.length).toBeLessThanOrEqual(125);
    expect(closeReason(frame)).toBe("é".repeat(61));
  });

  test("a connection dropped without a close frame is reported as 1006", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    raw.socket.destroy();
    expect(await fx.closes.next()).toEqual({ code: 1006, reason: "" });
    expect(conn.readyState).toBe("closed");
  });

  test("a close() the client never answers is cut off after closeTimeoutMs; the event reports the code that was sent", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.close(1001, "going away");
    expect(closeCode(await raw.frame())).toBe(1001);
    await raw.closed;
    expect(await fx.closes.next()).toEqual({ code: 1001, reason: "going away" });
  });

  test("frames after our close frame are ignored; the client's echo ends the connection", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.close();
    await raw.frame();
    raw.send(clientFrame(OP.text, "late"));
    raw.send(clientFrame(OP.ping, "late"));
    raw.send(clientFrame(OP.close, statusAndReason(1000)));
    await raw.closed;
    expect(await fx.closes.next()).toEqual({ code: 1000, reason: "" });
    expect(fx.messages.pending).toBe(0);
  });

  test("send() and ping() do nothing once closing; close() twice sends one frame", async () => {
    const raw = await openRaw(fx);
    const conn = await fx.connections.next();
    conn.close();
    expect(conn.send("x")).toBe(false);
    conn.ping();
    conn.close(4000, "again");
    const frame = await raw.frame();
    expect(frame.opcode).toBe(OP.close);
    expect(closeCode(frame)).toBe(1000);
    raw.send(clientFrame(OP.close, statusAndReason(1000)));
    await raw.closed;
    // Nothing but that one close frame was written.
    expect(raw.rest.length).toBe(0);
  });

  test("send() returns true while open; a non-string or an invalid close code is a programming error", async () => {
    await openRaw(fx);
    const conn = await fx.connections.next();
    expect(conn.send("ok")).toBe(true);
    expect(() => conn.send(42)).toThrow(TypeError);
    for (const code of [0, 999, 1004, 1005, 1006, 1015, 2999, 5000, 1000.5]) expect(() => conn.close(code)).toThrow(TypeError);
    expect(conn.readyState).toBe("open");
  });
});

describe("handshake", () => {
  let fx: Fixture;
  beforeEach(async () => {
    fx = await startWs();
  });
  afterEach(() => fx.close());

  test("answers 101 with the accept value RFC 6455 gives for its sample key", async () => {
    const raw = await openRaw(fx);
    expect(raw.head.split("\r\n")[0]).toBe("HTTP/1.1 101 Switching Protocols");
    expect(raw.header("sec-websocket-accept")).toBe("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
    expect(raw.header("upgrade")).toBe("websocket");
    expect(raw.header("connection")?.toLowerCase()).toBe("upgrade");
  });

  test("offers no subprotocol and no extension, whatever the client asks for", async () => {
    const raw = await openRaw(fx, { "Sec-WebSocket-Protocol": "chat", "Sec-WebSocket-Extensions": "permessage-deflate" });
    expect(raw.header("sec-websocket-protocol")).toBeUndefined();
    expect(raw.header("sec-websocket-extensions")).toBeUndefined();
  });

  test("accepts what Firefox sends: Connection: keep-alive, Upgrade and Upgrade: WebSocket", async () => {
    const raw = await openRaw(fx, { Connection: "keep-alive, Upgrade", Upgrade: "WebSocket" });
    expect(raw.head.startsWith("HTTP/1.1 101 ")).toBe(true);
    expect(fx.accepted).toHaveLength(1);
    expect(fx.accepted[0]).not.toBeNull();
  });

  test("exposes the request headers (lower-case names) and the Origin", async () => {
    await openRaw(fx, { Origin: "https://app.example.test", "Tailscale-User-Login": "owner@example.com" });
    const conn = await fx.connections.next();
    expect(conn.headers["tailscale-user-login"]).toBe("owner@example.com");
    expect(conn.headers.host).toBe("127.0.0.1");
    expect(conn.origin).toBe("https://app.example.test");
  });

  test("the origin is an empty string when the request has none", async () => {
    await openRaw(fx);
    expect((await fx.connections.next()).origin).toBe("");
  });

  test.each([
    ["a plain GET, no upgrade", { Upgrade: null, Connection: null, "Sec-WebSocket-Key": null, "Sec-WebSocket-Version": null }, "GET"],
    ["an upgrade for something else", { Upgrade: "h2c" }, "GET"],
    ["no Connection: Upgrade", { Connection: "keep-alive" }, "GET"],
    ["no Sec-WebSocket-Key", { "Sec-WebSocket-Key": null }, "GET"],
    ["a key that is not 16 bytes of base64", { "Sec-WebSocket-Key": "not-a-key" }, "GET"],
    ["Sec-WebSocket-Version 8", { "Sec-WebSocket-Version": "8" }, "GET"],
    ["no Sec-WebSocket-Version", { "Sec-WebSocket-Version": null }, "GET"],
    ["a POST", {}, "POST"],
  ] as Array<[string, Record<string, string | null>, string]>)("%s -> 400 and null", async (_label, headers, method) => {
    const response = await rawRequest(fx.port, upgradeRequest(headers, method));
    expect(response.startsWith("HTTP/1.1 400 ")).toBe(true);
    expect(fx.accepted).toEqual([null]);
  });

  test("a version mismatch names the version the server speaks", async () => {
    const response = await rawRequest(fx.port, upgradeRequest({ "Sec-WebSocket-Version": "8" }));
    expect(response.toLowerCase()).toContain("sec-websocket-version: 13");
  });
});

describe("lifecycle corners", () => {
  test("a connection accepted after its socket is gone still emits close, once", async () => {
    // A caller that checks something asynchronously before it accepts can find the client gone by then.
    const codes = queue<number>();
    const late = await listenUpgrade((req, socket, head) => {
      setTimeout(() => {
        const conn = acceptWebSocket(req, socket, head);
        conn!.on("close", (code: number) => codes.push(code));
      }, 80);
    });
    try {
      const client = net.connect(late.port, "127.0.0.1", () => client.write(upgradeRequest()));
      await sleep(20);
      client.destroy();
      expect(await codes.next("the close event")).toBe(1006);
      await sleep(50);
      expect(codes.pending).toBe(0);
    } finally {
      await late.close();
    }
  });

  test("a message listener that throws does not stall the frames behind it", () => {
    const socket = stubSocket();
    const conn = new WsConnection(socket, { headers: {}, maxPayload: 1024, closeTimeoutMs: 100 });
    const seen: string[] = [];
    conn.on("message", (text: string) => {
      seen.push(text);
      if (text === "bad") throw new Error("listener bug");
    });
    const burst = Buffer.concat([clientFrame(OP.text, "a"), clientFrame(OP.text, "bad"), clientFrame(OP.text, "c")]);
    expect(() => socket.emit("data", burst)).toThrow("listener bug"); // still surfaces, as any listener error does
    expect(seen).toEqual(["a", "bad", "c"]);
    socket.emit("data", clientFrame(OP.text, "d"));
    expect(seen).toEqual(["a", "bad", "c", "d"]);
    expect(conn.readyState).toBe("open");
  });

  test("close() with a reason that is not a string throws and leaves the connection open and usable", () => {
    const socket = stubSocket();
    const conn = new WsConnection(socket, { headers: {}, maxPayload: 1024, closeTimeoutMs: 50 });
    for (const reason of [null, 5, {}, ["x"]]) expect(() => conn.close(1000, reason as any)).toThrow(TypeError);
    expect(conn.readyState).toBe("open");
    expect(socket.written).toHaveLength(0);
    conn.close(1000, "second try");
    expect(conn.readyState).toBe("closing");
    expect(socket.written).toHaveLength(1);
  });

  test("after a protocol failure the socket is ended but kept open, so a client that is still sending is not reset", async () => {
    // Destroying it would reset the connection while the client's bytes are in flight, and the reset can
    // take the Close frame away before the client reads it (seen under Node with a large frame; Bun does not show it).
    const socket = stubSocket();
    let ended = 0;
    socket.end = () => ended++;
    new WsConnection(socket, { headers: {}, maxPayload: 1024, closeTimeoutMs: 50 });
    socket.emit("data", clientFrame(OP.text, "hi", { mask: false })); // a protocol violation
    expect(ended).toBeGreaterThan(0);
    const closeFrame = socket.written.at(-1);
    expect(closeFrame[0]).toBe(0x88); // FIN + Close
    expect(closeFrame.readUInt16BE(2)).toBe(1002);
    socket.emit("finish");
    expect(socket.destroyed).toBe(false);
    socket.emit("data", Buffer.alloc(100_000)); // what the client was still sending is read and dropped
    expect(socket.destroyed).toBe(false);
    await sleep(100);
    expect(socket.destroyed).toBe(true); // only the timer drops it, if the client never closes its end
  });
});

describe("receiving frames in small pieces", () => {
  const options = { headers: {}, maxPayload: 8 * 1024 * 1024, closeTimeoutMs: 100 };

  test.each([
    ["a 13-byte first chunk (one byte short of the header of a 100 000-byte frame)", 100_000, 13],
    ["an 8-byte first chunk holding the whole header of a 60 000-byte frame", 60_000, 8],
  ])("%s, then one byte at a time", (_label, size, firstChunk) => {
    // A first chunk shorter than the 14 bytes the parser looks at must not make every later arrival
    // cost more than the one before (a peer can drip bytes before it has authenticated).
    const socket = stubSocket();
    const conn = new WsConnection(socket, options);
    const messages: string[] = [];
    conn.on("message", (text: string) => messages.push(text));
    const text = pattern(size);
    const frame = clientFrame(OP.text, text);
    socket.emit("data", frame.subarray(0, firstChunk));
    const started = performance.now();
    let at = firstChunk;
    for (; at < frame.length; at++) {
      socket.emit("data", frame.subarray(at, at + 1));
      // Linear work takes milliseconds. Give up early on quadratic work, so a regression fails in a second, not minutes.
      if (at % 1000 === 0 && performance.now() - started > 1000) break;
    }
    expect(at).toBe(frame.length);
    expect(messages).toHaveLength(1);
    expect(messages[0] === text).toBe(true);
  });

  test("a frame header that starts in the last bytes of the receive buffer waits for the rest, instead of reading past the buffer", () => {
    // The first chunk gives the buffer 4096 bytes; the second fills it to the last byte, with only the
    // first two bytes of the next frame's header at the very end: its 16-bit length is not there yet.
    const socket = stubSocket();
    const conn = new WsConnection(socket, options);
    const messages: string[] = [];
    conn.on("message", (text: string) => messages.push(text));
    const first = clientFrame(OP.text, pattern(4086)); // 4 + 4 + 4086 = 4094 bytes
    const second = clientFrame(OP.text, pattern(300));
    const stream = Buffer.concat([first, second.subarray(0, 2)]);
    expect(stream.length).toBe(4096);
    socket.emit("data", stream.subarray(0, 100));
    expect(() => socket.emit("data", stream.subarray(100))).not.toThrow();
    expect(messages).toEqual([pattern(4086)]);
    socket.emit("data", second.subarray(2));
    expect(messages).toHaveLength(2);
    expect(messages[1]).toBe(pattern(300));
    expect(conn.readyState).toBe("open");
  });

  test("the receive buffer is let go once it is empty, so an idle connection does not keep a big frame's worth", () => {
    const socket = stubSocket();
    const conn = new WsConnection(socket, options);
    const messages: string[] = [];
    conn.on("message", (text: string) => messages.push(text));
    socket.emit("data", clientFrame(OP.text, pattern(300_000)));
    expect(messages).toHaveLength(1);
    expect(conn._buf.length).toBeLessThanOrEqual(64 * 1024); // white-box: the buffer that grew for it is dropped
  });

  // mulberry32: a small seeded generator, so a failure names a seed that reproduces it.
  function seeded(seed: number) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  test("any way of cutting the byte stream into chunks delivers the same messages and pongs", () => {
    const alphabet = ["a", "b", "c", "d", "e", " ", "\n", "é", "€", "日", "😀"];
    const sizes = [0, 1, 2, 5, 124, 125, 126, 127, 300, 1000, 1500, 4000, 4096, 5000, 20_000, 65_535, 65_536, 70_000];
    for (let seed = 1; seed <= 200; seed++) {
      const random = seeded(seed);
      const int = (max: number) => Math.floor(random() * max);
      const randomText = (length: number) => Array.from({ length }, () => alphabet[int(alphabet.length)]).join("");
      const parts: Buffer[] = [];
      const expectedMessages: string[] = [];
      const expectedPongs: string[] = [];
      for (let frames = 1 + int(10); frames > 0; frames--) {
        const roll = random();
        if (roll < 0.15) {
          const payload = "ping".repeat(int(32)); // 0 to 124 bytes
          parts.push(clientFrame(OP.ping, payload));
          expectedPongs.push(payload);
        } else if (roll < 0.35) {
          // One message in 2 to 4 fragments, cut anywhere (a character may be split), with pings in between.
          const text = randomText(sizes[int(sizes.length)]);
          const bytes = Buffer.from(text);
          const cuts = Array.from({ length: 1 + int(3) }, () => int(bytes.length + 1)).sort((a, b) => a - b);
          const pieces = [0, ...cuts, bytes.length].slice(0, -1).map((from, i) => bytes.subarray(from, [...cuts, bytes.length][i]));
          pieces.forEach((piece, i) => {
            parts.push(clientFrame(i === 0 ? OP.text : OP.cont, piece, { fin: i === pieces.length - 1 }));
            if (i < pieces.length - 1 && random() < 0.4) {
              parts.push(clientFrame(OP.ping, "mid"));
              expectedPongs.push("mid");
            }
          });
          expectedMessages.push(text);
        } else {
          const text = randomText(sizes[int(sizes.length)]);
          parts.push(clientFrame(OP.text, text));
          expectedMessages.push(text);
        }
      }
      const stream = Buffer.concat(parts);

      const socket = stubSocket();
      const conn = new WsConnection(socket, options);
      const messages: string[] = [];
      conn.on("message", (text: string) => messages.push(text));
      for (let at = 0; at < stream.length; ) {
        const roll = random();
        const size = roll < 0.3 ? 1 + int(3) : roll < 0.5 ? 12 + int(4) : roll < 0.8 ? 1 + int(1500) : 1 + int(30_000);
        socket.emit("data", stream.subarray(at, at + size));
        at += size;
      }

      const fail = (what: string) => {
        throw new Error(`seed ${seed}: ${what}`);
      };
      if (conn.readyState !== "open") fail(`the connection ended (${conn.readyState})`);
      if (messages.length !== expectedMessages.length) fail(`${messages.length} messages, expected ${expectedMessages.length}`);
      messages.forEach((message, i) => message === expectedMessages[i] || fail(`message ${i} differs`));
      const pongs = socket.written.map((frame: Buffer) => (frame[0] === 0x8a ? frame.subarray(2).toString() : fail("a frame that is not a pong")));
      if (pongs.join("|") !== expectedPongs.join("|")) fail("the pongs differ");
    }
  });
});
