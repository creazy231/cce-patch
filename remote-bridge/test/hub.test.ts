// The hub: HTTP routing on 127.0.0.1, the phone protocol (Tailscale identity, pairing, hello with
// token and Origin, subscriptions, requests), the windows behind it (local ones and peers, and the
// attention events they report for notifications), and the limits that keep a phone from costing
// unbounded memory. Phones are Bun WebSocket clients that add the headers `tailscale serve` adds.
// State lives in a temp CCE_REMOTE_HOME; every hub listens on a free port. The last test runs
// remote-bridge/test/hub-smoke.js under real Node.
import { afterEach, describe, expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHash, createHmac, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { LiteServer, respond } from "../lib/http-lite.js";
import { DEFAULT_CALL_TIMEOUTS_MS, Hub } from "../lib/hub.js";
import { connectPeer } from "../lib/peer-link.js";
import { WsConnection } from "../lib/ws.js";
import { loadState, updateState } from "../lib/store.js";
import { OP, RawConn, clientFrame, destroyRawSockets, queue, rawRequest, sleep, withTimeout } from "./support";

type Json = any;

const OWNER = "owner@example.com";
const APP_ORIGIN = "https://app.example.com";
const DNS_NAME = "example-mac.tailnet-0000.ts.net";
const MAC_NAME = "example-mac";
const ID = "aaaaaaaaaaaa";
const T0 = 1_900_000_000_000;
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const OWNER_STATUS = { installed: true, running: true, loginName: OWNER, dnsName: DNS_NAME, httpsEnabled: true };
const PENDING = { requestId: "req-1", kind: "tool", toolName: "Bash", input: { command: "ls" }, canAlwaysAllow: false, createdAt: T0 };

// ---- fixtures -----------------------------------------------------------------------------------

const homes: string[] = [];
const hubs: any[] = [];
const phones: Phone[] = [];
const sockets: net.Socket[] = [];
const closers: Array<() => unknown> = [];

afterEach(async () => {
  // Clients first: a hub's close() would wait for clients that never answer its Close frame.
  for (const phone of phones.splice(0)) phone.terminate();
  for (const socket of sockets.splice(0)) socket.destroy();
  destroyRawSockets();
  for (const close of closers.splice(0)) await close();
  for (const hub of hubs.splice(0)) await hub.close();
  for (const dir of homes.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Ctx {
  hub: any;
  port: number;
  env: { CCE_REMOTE_HOME: string };
  clock: { now: number };
  logs: string[];
  tailscale: { calls: number; status: () => Promise<Json> };
  state: () => Json;
  /** Set to make the hub's reads or writes of state.json fail. */
  faults: { reads: boolean; writes: boolean };
  /** How often the hub wrote state.json. */
  writes: { count: number };
  /** Runs inside each of the hub's writes, after it read state.json and before it writes it back. */
  hooks: { betweenReadAndWrite?: () => void };
}

function tempHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cce-hub-test-"));
  homes.push(dir);
  return dir;
}

async function startHub({ status, hub: options = {} }: { status?: () => Promise<Json>; hub?: Record<string, unknown> } = {}): Promise<Ctx> {
  const env = { CCE_REMOTE_HOME: tempHome() };
  const clock = { now: T0 };
  const logs: string[] = [];
  const read = status ?? (async () => ({ ...OWNER_STATUS }));
  const tailscale = {
    calls: 0,
    status() {
      tailscale.calls++;
      return read();
    },
  };
  const faults = { reads: false, writes: false };
  const writes = { count: 0 };
  const hooks: Ctx["hooks"] = {};
  const hub = new Hub({
    state: () => {
      if (faults.reads) throw new Error("EACCES: permission denied, open 'state.json'");
      return loadState(env);
    },
    updateState: (fn: (state: Json) => unknown) => {
      writes.count++;
      if (faults.writes) throw new Error("ENOSPC: no space left on device");
      return updateState((state: Json) => {
        hooks.betweenReadAndWrite?.();
        return fn(state);
      }, env);
    },
    tailscale,
    macName: () => MAC_NAME,
    log: (message: string, level: string) => logs.push(`${level} ${message}`),
    now: () => clock.now,
    projectsDebounceMs: 20,
    ...options,
  });
  hubs.push(hub);
  await hub.listen(0);
  const port = (hub.server.address() as net.AddressInfo).port;
  return { hub, port, env, clock, logs, tailscale, state: () => loadState(env), faults, writes, hooks };
}

/** A phone written by hand (frames, control frames, exact close codes): before its hello, or past it with `creds`. */
async function rawPhone(ctx: Ctx, creds?: Creds): Promise<RawConn> {
  const request = Buffer.from(upgradeRequest({ "Tailscale-User-Login": OWNER, Origin: APP_ORIGIN }), "latin1");
  if (!creds) return RawConn.open(ctx.port, request);
  const hello = clientFrame(OP.text, JSON.stringify({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token }));
  const raw = await RawConn.open(ctx.port, Buffer.concat([request, hello]));
  expect(JSON.parse((await raw.frame()).payload.toString("utf8")).t).toBe("welcome");
  expect(JSON.parse((await raw.frame()).payload.toString("utf8")).t).toBe("projects");
  expect(JSON.parse((await raw.frame()).payload.toString("utf8")).t).toBe("usage");
  return raw;
}

/**
 * Runs `run` while every WebSocket connection reports `bytes` waiting in its socket. A Bun client
 * reads whatever arrives, so it cannot be slow by itself; ws.test.ts shows the real count.
 */
async function withBacklog(bytes: number, run: () => Promise<void>) {
  const real = Object.getOwnPropertyDescriptor(WsConnection.prototype, "bufferedAmount")!;
  Object.defineProperty(WsConnection.prototype, "bufferedAmount", { configurable: true, get: () => bytes });
  try {
    await run();
  } finally {
    Object.defineProperty(WsConnection.prototype, "bufferedAmount", real);
  }
}

/** The status line of an upgrade request's answer; a 101 connection is closed again right away. */
async function upgradeStatus(port: number, headers: Record<string, string>): Promise<string> {
  const raw = await RawConn.open(port, upgradeRequest(headers));
  raw.socket.destroy();
  return statusOf(raw.head);
}

/** A phone: Bun's WebSocket client with the headers `tailscale serve` adds (and the app's Origin). */
class Phone {
  readonly frames = queue<Json>();
  readonly closeEvent: Promise<{ code: number; reason: string }>;
  isClosed = false;

  private constructor(readonly ws: WebSocket) {
    this.closeEvent = new Promise((resolve) => {
      ws.addEventListener("close", (event) => {
        this.isClosed = true;
        resolve({ code: event.code, reason: event.reason });
      });
    });
    ws.addEventListener("message", (event) => this.frames.push(JSON.parse(String(event.data))));
  }

  static async open(
    port: number,
    { login = OWNER, origin = APP_ORIGIN, headers = {} }: { login?: string | null; origin?: string | null; headers?: Record<string, string> } = {},
  ): Promise<Phone> {
    const all: Record<string, string> = { ...headers };
    if (login !== null) all["Tailscale-User-Login"] = login;
    if (origin !== null) all.Origin = origin;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: all } as any);
    const phone = new Phone(ws);
    phones.push(phone);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () => reject(new Error("the phone could not connect")));
      }),
      "the phone to connect",
    );
    return phone;
  }

  send(frame: unknown) {
    this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
  }

  next(what = "a frame"): Promise<Json> {
    return this.frames.next(what);
  }

  closed() {
    return withTimeout(this.closeEvent, "the phone's connection to close");
  }

  terminate() {
    if (this.isClosed) return;
    try {
      this.ws.close();
    } catch {
      // closing already
    }
  }

  /** Waits a little, then fails on any frame that arrived meanwhile (project lists aside). */
  async expectQuiet(ms = 80) {
    await sleep(ms);
    const extra: Json[] = [];
    while (this.frames.pending > 0) {
      const frame = await this.frames.next();
      if (frame.t !== "projects") extra.push(frame);
    }
    expect(extra).toEqual([]);
  }
}

/** The next frame of type `t`; project lists before it are skipped, anything else fails. */
async function nextFrame(phone: Phone, t: string): Promise<Json> {
  for (;;) {
    const frame = await phone.next(`a ${t} frame`);
    if (frame.t === t) return frame;
    if (frame.t !== "projects") throw new Error(`expected a ${t} frame, got ${JSON.stringify(frame).slice(0, 300)}`);
  }
}

/** The next project list that passes `check`; earlier lists are skipped, any other frame fails. */
async function projectsWhere(phone: Phone, check: (projects: Json[]) => boolean, what = "a projects frame"): Promise<Json[]> {
  for (;;) {
    const frame = await phone.next(what);
    if (frame.t !== "projects") throw new Error(`expected a projects frame, got ${JSON.stringify(frame).slice(0, 300)}`);
    if (check(frame.projects)) return frame.projects;
  }
}

/** A ping and its pong: everything the phone sent before has been handled by the hub. */
async function roundTrip(phone: Phone) {
  phone.send({ t: "ping" });
  await nextFrame(phone, "pong");
}

async function expectRefused(phone: Phone, code: string, closeCode = 4401) {
  expect(await phone.next(`the ${code} error`)).toEqual({ t: "error", code, message: expect.any(String) });
  expect((await phone.closed()).code).toBe(closeCode);
}

interface Creds {
  deviceId: string;
  token: string;
  origin: string;
}

async function pairPhone(ctx: Ctx, { origin = APP_ORIGIN, device = "iPhone" } = {}): Promise<Creds> {
  const { code } = ctx.hub.newPairingCode();
  const phone = await Phone.open(ctx.port, { origin });
  phone.send({ t: "pair", code, device });
  const paired = await phone.next("paired");
  expect(paired).toMatchObject({ t: "paired", mac: { name: MAC_NAME } });
  phone.terminate();
  return { deviceId: paired.deviceId, token: paired.token, origin };
}

async function connectPhone(ctx: Ctx, creds: Creds, { origin = creds.origin }: { origin?: string | null } = {}) {
  const phone = await Phone.open(ctx.port, { origin });
  phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
  const welcome = await phone.next("welcome");
  expect(welcome).toMatchObject({ t: "welcome", v: 1, mac: { name: MAC_NAME } });
  const projects = await phone.next("projects");
  expect(projects.t).toBe("projects");
  const usage = await phone.next("usage");
  expect(usage.t).toBe("usage");
  return { phone, projects: projects.projects as Json[], welcome, usage };
}

async function pairedPhone(ctx: Ctx) {
  const creds = await pairPhone(ctx);
  return { creds, ...(await connectPhone(ctx, creds)) };
}

function session(id: string) {
  return { id, title: `Session ${id}`, lastModified: T0, state: "idle", live: false, pendingCount: 0 };
}

function project(id: string, name = "cce-patch", sessions: Json[] = [session("s1")]) {
  return { id, name, folders: [`/Users/example/${name}`], editor: "Visual Studio Code - Insiders", claudeOpen: true, sessions };
}

function message(uuid: string, text = "hello") {
  return { uuid, type: "assistant", content: [{ type: "text", text }] };
}

function snapshotOf(sessionId: string, messages: Json[] = [message(`${sessionId}-m1`)]) {
  return { messages, pending: [], state: "idle", live: true, truncatedBefore: 0 };
}

interface Call {
  method: string;
  args: Json;
}

/** A window behind the hub: answers its calls from `handlers` and records them (`active` apart). */
function fakeWindow(
  hub: any,
  { key = "w1", id = ID, name = "cce-patch", handlers = {} }: { key?: string; id?: string | null; name?: string; handlers?: Record<string, (args: Json) => unknown> } = {},
) {
  const calls = queue<Call>();
  const log: Call[] = [];
  const answers: Record<string, (args: Json) => unknown> = {
    snapshot: (args) => snapshotOf(args.session),
    send: (args) => ({ session: args.session ?? "s-new", uuid: "u-1" }),
    ...handlers,
  };
  const handle = hub.addWindow({
    key,
    call: async (method: string, args: Json) => {
      const call = { method, args };
      log.push(call);
      if (method !== "active") calls.push(call);
      const answer = answers[method];
      return answer ? answer(args) : undefined;
    },
  });
  if (id !== null) handle.setProject(project(id, name));
  return { handle, calls, handlers: answers, actives: () => log.filter((c) => c.method === "active").map((c) => c.args.on) };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Polls `check` until it returns something truthy, and returns that. */
async function waitFor<T>(check: () => T | undefined | null | false | "", what: string, ms = 2000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = check();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const newNonce = () => randomBytes(32).toString("hex");
const proofOf = (secret: string, side: "hub" | "peer", peerNonce: string, hubNonce: string) =>
  createHmac("sha256", secret).update(`${side}\n${peerNonce}\n${hubNonce}`).digest("hex");

// ---- Web Push fixtures ---------------------------------------------------------------------------

const APPLE = "https://web.push.apple.com/QAbc";
const PUSH_SUBJECT = "https://app.example.test";
const b = (text: string) => Buffer.from(text, "base64url");

interface Subscriber {
  privateKey: Buffer;
  publicKey: Buffer;
  auth: Buffer;
  keys: { p256dh: string; auth: string };
}

/** A push subscription's keys, as a browser makes them. */
function makeSubscriber(): Subscriber {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const publicKey = ecdh.getPublicKey();
  return { privateKey: ecdh.getPrivateKey(), publicKey, auth, keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") } };
}

/** VAPID keys: the raw public key and the private key as a JWK. */
function makeVapid() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" }) as unknown as { x: string; y: string; [member: string]: unknown };
  const publicKey = Buffer.concat([Buffer.from([4]), b(privateJwk.x), b(privateJwk.y)]).toString("base64url");
  return { publicKey, privateJwk };
}

/** A push_set frame for this device. */
function pushFrame(subscriber: Subscriber, vapid: ReturnType<typeof makeVapid>, overrides: Record<string, unknown> = {}) {
  return {
    t: "push_set",
    subscription: { endpoint: APPLE, keys: subscriber.keys },
    vapid,
    subject: PUSH_SUBJECT,
    prefs: { waiting: true, done: true, onlyAway: false, details: true },
    ...overrides,
  };
}

/** The browser's side of RFC 8291: opens an aes128gcm body with the subscriber's keys. */
function decryptPush(body: Buffer, subscriber: Subscriber): Buffer {
  const salt = body.subarray(0, 16);
  const idLength = body[20];
  const senderPublic = body.subarray(21, 21 + idLength);
  const sealed = body.subarray(21 + idLength);
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(subscriber.privateKey);
  const secret = ecdh.computeSecret(senderPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), subscriber.publicKey, senderPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, subscriber.auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const record = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  expect(record[record.length - 1]).toBe(0x02);
  return record.subarray(0, record.length - 1);
}

/** A peer's upgrade request, by hand: Host and a nonce unless `extra` says otherwise. */
function peerUpgrade({ host = "127.0.0.1", nonce = newNonce(), extra = "" }: { host?: string | null; nonce?: string | null; extra?: string } = {}): string {
  const lines = [host === null ? "" : `Host: ${host}\r\n`, "Connection: Upgrade\r\n", "Upgrade: cce-peer\r\n", nonce === null ? "" : `X-CCE-Nonce: ${nonce}\r\n`, extra];
  return `GET /_peer HTTP/1.1\r\n${lines.join("")}\r\n`;
}

/**
 * A peer by hand: the upgrade, then the first line `auth` makes of the hub's nonce (the right proof
 * for `secret` unless a test says otherwise; null sends nothing).
 */
async function rawPeer(port: number, secret: string, auth?: ((hubNonce: string, peerNonce: string) => string) | null) {
  const nonce = newNonce();
  const raw = await RawConn.open(port, peerUpgrade({ nonce }));
  const hubNonce = raw.header("X-CCE-Nonce") ?? "";
  const line = auth === undefined ? `${JSON.stringify({ t: "auth", proof: proofOf(secret, "peer", nonce, hubNonce) })}\n` : auth === null ? "" : auth(hubNonce, nonce);
  if (line) raw.send(line);
  return { raw, nonce, hubNonce };
}
const statusOf = (answer: string) => answer.split("\r\n")[0];

function splitResponse(answer: string): { head: string[]; body: string } {
  const end = answer.indexOf("\r\n\r\n");
  return { head: answer.slice(0, end).split("\r\n"), body: answer.slice(end + 4) };
}

function header(head: string[], name: string): string | undefined {
  const line = head.find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line?.slice(name.length + 1).trim();
}

const WS_KEY = "dGhlIHNhbXBsZSBub25jZQ==";

function upgradeRequest(headers: Record<string, string> = {}, target = "/ws"): string {
  const all: Record<string, string> = {
    Host: "127.0.0.1",
    Upgrade: "websocket",
    Connection: "Upgrade",
    "Sec-WebSocket-Key": WS_KEY,
    "Sec-WebSocket-Version": "13",
    ...headers,
  };
  return `GET ${target} HTTP/1.1\r\n${Object.entries(all).map(([name, value]) => `${name}: ${value}\r\n`).join("")}\r\n`;
}

async function connectSocket(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  sockets.push(socket);
  socket.on("error", () => {});
  await withTimeout(new Promise<void>((resolve) => socket.once("connect", () => resolve())), "the TCP connection");
  return socket;
}

/** Sends `text` a few bytes at a time, as separate writes, and returns the whole answer. */
async function dripRequest(port: number, text: string): Promise<string> {
  const socket = await connectSocket(port);
  const chunks: Buffer[] = [];
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  for (let i = 0; i < text.length; i++) {
    socket.write(text[i]);
    if (i % 3 === 2) await sleep(2);
  }
  await withTimeout(closed, "the answer to a dripped request");
  return Buffer.concat(chunks).toString("latin1");
}

async function liteServer(onRequest: (req: Json, socket: net.Socket, head: Buffer) => void, options: Record<string, unknown> = {}) {
  const lite = new LiteServer(onRequest, options);
  await lite.listen(0);
  closers.push(() => lite.close());
  return { lite, port: (lite.server.address() as net.AddressInfo).port };
}

// ---- HTTP ---------------------------------------------------------------------------------------

describe("HTTP", () => {
  test("GET /health answers the hub's identity as JSON and closes the connection", async () => {
    const { port } = await startHub();
    const { head, body } = splitResponse(await rawRequest(port, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
    expect(head[0]).toBe("HTTP/1.1 200 OK");
    expect(header(head, "Content-Type")).toBe("application/json; charset=utf-8");
    expect(header(head, "Connection")).toBe("close");
    expect(header(head, "Cache-Control")).toBe("no-store");
    expect(Number(header(head, "Content-Length"))).toBe(Buffer.byteLength(body));
    expect(JSON.parse(body)).toEqual({ ok: true, app: "cce-remote", v: 1 });
  });

  test("GET / is a short HTML page, without scripts, that points to the CCE Remote app", async () => {
    const { port } = await startHub();
    const { head, body } = splitResponse(await rawRequest(port, "GET / HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"));
    expect(head[0]).toBe("HTTP/1.1 200 OK");
    expect(header(head, "Content-Type")).toBe("text/html; charset=utf-8");
    expect(header(head, "Content-Security-Policy")).toContain("default-src 'none'");
    expect(body).toContain("CCE Remote");
    expect(body).not.toContain("<script");
  });

  test("the query string does not change the route", async () => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, "GET /health?probe=1 HTTP/1.1\r\n\r\n"))).toBe("HTTP/1.1 200 OK");
  });

  test.each(["/nope", "/health/", "/HEALTH", "/ws/x", "/_peer/x"])("GET %s is a 404", async (target) => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`))).toBe("HTTP/1.1 404 Not Found");
  });

  test.each(["POST", "PUT", "HEAD", "OPTIONS", "DELETE"])("%s is a 405 that names GET", async (method) => {
    const { port } = await startHub();
    const { head } = splitResponse(await rawRequest(port, `${method} /health HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n`));
    expect(head[0]).toBe("HTTP/1.1 405 Method Not Allowed");
    expect(header(head, "Allow")).toBe("GET");
  });

  test.each(["/", "/health", "/nope", "/_peer"])("a Funnel request is refused on %s: 403", async (target) => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, `GET ${target} HTTP/1.1\r\nHost: x\r\nTailscale-Funnel-Request: ?1\r\n\r\n`))).toBe("HTTP/1.1 403 Forbidden");
  });

  test("/ and /health answer tailnet requests without Funnel", async () => {
    const { port } = await startHub();
    const viaServe = `Tailscale-User-Login: other@example.com\r\nX-Forwarded-For: 100.64.0.2\r\n`;
    expect(statusOf(await rawRequest(port, `GET / HTTP/1.1\r\nHost: x\r\n${viaServe}\r\n`))).toBe("HTTP/1.1 200 OK");
    expect(statusOf(await rawRequest(port, `GET /health HTTP/1.1\r\nHost: x\r\n${viaServe}\r\n`))).toBe("HTTP/1.1 200 OK");
  });

  test("a request head over 16 KB gets 431, finished or not", async () => {
    const { port } = await startHub();
    const big = `GET / HTTP/1.1\r\nX-Big: ${"a".repeat(17_000)}\r\n\r\n`;
    expect(statusOf(await rawRequest(port, big))).toBe("HTTP/1.1 431 Request Header Fields Too Large");
    const unfinished = `GET / HTTP/1.1\r\nX-Big: ${"a".repeat(17_000)}`; // no end in sight: answered at once, not after the timeout
    expect(statusOf(await rawRequest(port, unfinished))).toBe("HTTP/1.1 431 Request Header Fields Too Large");
  });

  test.each([
    ["a bare LF", "GET / HTTP/1.1\nHost: x\r\n\r\n"],
    ["a folded header line", "GET / HTTP/1.1\r\nX-A: 1\r\n  folded\r\n\r\n"],
    ["a space before the colon", "GET / HTTP/1.1\r\nHost : x\r\n\r\n"],
    ["a header line without a colon", "GET / HTTP/1.1\r\nHost\r\n\r\n"],
    ["a control character in a value", "GET / HTTP/1.1\r\nX-A: a\x01b\r\n\r\n"],
    ["a CR inside a value", "GET / HTTP/1.1\r\nX-A: a\rb\r\n\r\n"],
    ["an absolute URL", "GET http://127.0.0.1/health HTTP/1.1\r\n\r\n"],
    ["HTTP/2.0", "GET / HTTP/2.0\r\n\r\n"],
    ["no version", "GET /\r\n\r\n"],
    ["two spaces in the request line", "GET  / HTTP/1.1\r\n\r\n"],
    ["a non-ASCII target", "GET /h\xe9 HTTP/1.1\r\n\r\n"],
    ["an empty line first", "\r\nGET / HTTP/1.1\r\n\r\n"],
  ])("a head with %s is a 400", async (_label, text) => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, text))).toBe("HTTP/1.1 400 Bad Request");
  });

  test("a head that arrives a few bytes at a time is read", async () => {
    const { port } = await startHub();
    expect(statusOf(await dripRequest(port, "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"))).toBe("HTTP/1.1 200 OK");
  });

  test("the hub listens on 127.0.0.1 only", async () => {
    const { hub } = await startHub();
    expect((hub.server.address() as net.AddressInfo).address).toBe("127.0.0.1");
  });

  test("listen() on a port that is taken rejects with EADDRINUSE", async () => {
    const ctx = await startHub();
    const second = new Hub({ state: () => loadState(ctx.env), updateState: (fn: Json) => updateState(fn, ctx.env), tailscale: ctx.tailscale, macName: () => MAC_NAME });
    hubs.push(second);
    const error: Json = await second.listen(ctx.port).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("EADDRINUSE");
  });

  test("a hub that never listened (its window joins as a peer) says nothing when it is closed; one that served says it stopped", async () => {
    const ctx = await startHub();
    const lines: string[] = [];
    const second = new Hub({
      state: () => loadState(ctx.env),
      updateState: (fn: Json) => updateState(fn, ctx.env),
      tailscale: ctx.tailscale,
      macName: () => MAC_NAME,
      log: (message: string) => lines.push(message),
    });
    hubs.push(second);
    await second.listen(ctx.port).catch(() => undefined);
    await second.close();
    expect(lines).toEqual([]);
    await ctx.hub.close();
    expect(ctx.logs.filter((line) => line.endsWith(" stopped"))).toHaveLength(1);
  });
});

describe("http-lite", () => {
  test("header names are lower-cased, repeats joined with ', ', and prototype names are plain keys", async () => {
    const seen: Json[] = [];
    const { port } = await liteServer((req, socket) => {
      seen.push(req);
      respond(socket, 200, { body: "ok" });
    });
    const answer = await rawRequest(port, "GET /x?y=1 HTTP/1.0\r\nX-Dup: 1\r\nx-dup:2\r\n__proto__: p\r\nConstructor:  c \r\nEmpty:\r\n\r\n");
    expect(statusOf(answer)).toBe("HTTP/1.1 200 OK");
    const [req] = seen;
    expect(req.method).toBe("GET");
    expect(req.url).toBe("/x?y=1");
    expect(req.httpVersion).toBe("1.0");
    expect(Object.getPrototypeOf(req.headers)).toBe(null);
    expect(req.headers["x-dup"]).toBe("1, 2");
    expect(req.headers["__proto__"]).toBe("p");
    expect(req.headers.constructor).toBe("c");
    expect(req.headers.empty).toBe("");
    expect(Object.keys(req.headers).sort()).toEqual(["__proto__", "constructor", "empty", "x-dup"]);
  });

  test("the bytes after the head come with the request, and what follows waits in the paused socket", async () => {
    const { port } = await liteServer((_req, socket, head) => {
      const got = [head.toString("latin1")];
      setTimeout(() => {
        socket.on("data", (chunk: Buffer) => got.push(chunk.toString("latin1")));
        socket.resume();
        setTimeout(() => respond(socket, 200, { body: got.join("") }), 40);
      }, 60);
    });
    const socket = await connectSocket(port);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.write("GET / HTTP/1.1\r\n\r\nfirst-");
    await sleep(20);
    socket.write("second");
    await withTimeout(closed, "the answer");
    expect(splitResponse(Buffer.concat(chunks).toString("latin1")).body).toBe("first-second");
  });

  test("a head that is not complete within headTimeoutMs gets 408 and the connection is closed", async () => {
    const { port } = await liteServer(() => {}, { headTimeoutMs: 150 });
    const socket = await connectSocket(port);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const started = Date.now();
    socket.write("GET / HTTP/1.1\r\nHost:");
    await withTimeout(closed, "the slow head to be cut off");
    expect(Date.now() - started).toBeGreaterThanOrEqual(120);
    expect(statusOf(Buffer.concat(chunks).toString("latin1"))).toBe("HTTP/1.1 408 Request Timeout");
  });

  test("a request handler that throws costs only its own connection", async () => {
    let calls = 0;
    const { port } = await liteServer((_req, socket) => {
      calls++;
      if (calls === 1) throw new Error("handler bug");
      respond(socket, 200, { body: "ok" });
    });
    expect(await rawRequest(port, "GET / HTTP/1.1\r\n\r\n")).toBe(""); // dropped without an answer
    expect(statusOf(await rawRequest(port, "GET / HTTP/1.1\r\n\r\n"))).toBe("HTTP/1.1 200 OK");
  });

  test("close() drops a connection that lingers past the grace period", async () => {
    const { lite, port } = await liteServer(() => {});
    const socket = await connectSocket(port);
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    const started = Date.now();
    await withTimeout(lite.close(100), "close() to finish");
    await withTimeout(closed, "the lingering connection to be dropped");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ---- who may connect ----------------------------------------------------------------------------

describe("who may open the phone socket", () => {
  test("without Tailscale-User-Login: 403", async () => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, upgradeRequest({ Origin: APP_ORIGIN })))).toBe("HTTP/1.1 403 Forbidden");
  });

  test("with an empty Tailscale-User-Login: 403", async () => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, upgradeRequest({ "Tailscale-User-Login": "" })))).toBe("HTTP/1.1 403 Forbidden");
  });

  test("another Tailscale user: 403", async () => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, upgradeRequest({ "Tailscale-User-Login": "other@example.com" })))).toBe("HTTP/1.1 403 Forbidden");
  });

  test("a Funnel request: 403, even with the owner's login", async () => {
    const { port } = await startHub();
    const request = upgradeRequest({ "Tailscale-User-Login": OWNER, "Tailscale-Funnel-Request": "?1" });
    expect(statusOf(await rawRequest(port, request))).toBe("HTTP/1.1 403 Forbidden");
  });

  test("two login headers are joined by the parser and never match: 403", async () => {
    const { port } = await startHub();
    const request = upgradeRequest({}).replace("\r\n\r\n", `\r\nTailscale-User-Login: ${OWNER}\r\nTailscale-User-Login: ${OWNER}\r\n\r\n`);
    expect(statusOf(await rawRequest(port, request))).toBe("HTTP/1.1 403 Forbidden");
  });

  test("the owner, in any letter case: the socket opens", async () => {
    const { port } = await startHub();
    const raw = await RawConn.open(port, upgradeRequest({ "Tailscale-User-Login": "Owner@Example.COM" }));
    expect(statusOf(raw.head)).toBe("HTTP/1.1 101 Switching Protocols");
  });

  test("owner unknown because the status read fails: the header is enough", async () => {
    const ctx = await startHub({
      status: async () => {
        throw new Error("no tailscale CLI");
      },
    });
    const phone = await Phone.open(ctx.port, { login: "someone@example.com" });
    expect(phone.isClosed).toBe(false);
  });

  test("owner unknown because Tailscale is stopped: the header is enough", async () => {
    const ctx = await startHub({ status: async () => ({ installed: true, running: false, backendState: "Stopped" }) });
    const phone = await Phone.open(ctx.port, { login: "someone@example.com" });
    expect(phone.isClosed).toBe(false);
  });

  test("once the owner is known, it stays enforced when a later status read fails or throws", async () => {
    let mode = "ok";
    const ctx = await startHub({
      status: async () => {
        if (mode === "error") return { installed: true, running: false, error: "tailscale status timed out" };
        if (mode === "throw") throw new Error("no CLI");
        return { ...OWNER_STATUS };
      },
    });
    await waitFor(() => ctx.tailscale.calls > 0, "the first status read");
    await sleep(20);
    for (const failure of ["error", "throw"]) {
      mode = failure;
      expect(await upgradeStatus(ctx.port, { "Tailscale-User-Login": "intruder@example.com" })).toBe("HTTP/1.1 403 Forbidden");
      expect(await upgradeStatus(ctx.port, { "Tailscale-User-Login": OWNER })).toBe("HTTP/1.1 101 Switching Protocols");
    }
  });

  test("a later status read with another login moves the owner", async () => {
    let login = OWNER;
    const ctx = await startHub({ status: async () => ({ ...OWNER_STATUS, loginName: login }) });
    expect(await upgradeStatus(ctx.port, { "Tailscale-User-Login": OWNER })).toBe("HTTP/1.1 101 Switching Protocols");
    login = "new-owner@example.com";
    expect(await upgradeStatus(ctx.port, { "Tailscale-User-Login": OWNER })).toBe("HTTP/1.1 403 Forbidden");
    expect(await upgradeStatus(ctx.port, { "Tailscale-User-Login": "new-owner@example.com" })).toBe("HTTP/1.1 101 Switching Protocols");
  });

  test("GET /ws without a WebSocket upgrade: 400", async () => {
    const { port } = await startHub();
    expect(statusOf(await rawRequest(port, `GET /ws HTTP/1.1\r\nTailscale-User-Login: ${OWNER}\r\n\r\n`))).toBe("HTTP/1.1 400 Bad Request");
  });
});

// ---- before hello -------------------------------------------------------------------------------

describe("before hello", () => {
  test("no first frame within helloTimeoutMs: close 4400, without an error frame", async () => {
    const ctx = await startHub({ hub: { helloTimeoutMs: 200 } });
    const phone = await Phone.open(ctx.port);
    const started = Date.now();
    expect((await phone.closed()).code).toBe(4400);
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(phone.frames.pending).toBe(0);
  });

  test.each([
    ["a ping", JSON.stringify({ t: "ping" })],
    ["a sub", JSON.stringify({ t: "sub", project: ID, session: "s1" })],
    ["text that is not JSON", "{hello"],
    ["a JSON array", "[1,2]"],
    ["a JSON string", '"hello"'],
    ["a hello hidden behind __proto__", '{"__proto__":{"t":"hello","v":1}}'],
  ])("%s as the first frame: close 4400, without an error frame", async (_label, text) => {
    const ctx = await startHub();
    const phone = await Phone.open(ctx.port);
    phone.send(text);
    expect((await phone.closed()).code).toBe(4400);
    expect(phone.frames.pending).toBe(0);
  });

  test("a first frame over 16 KB: close 4400", async () => {
    const ctx = await startHub();
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code: "ABCD-EFGH", device: "a".repeat(20_000) });
    expect((await phone.closed()).code).toBe(4400);
  });

  test("before hello a frame over 64 KB closes the socket with 1009, without being buffered", async () => {
    const ctx = await startHub();
    const phone = await Phone.open(ctx.port);
    phone.send("x".repeat(64 * 1024 + 1));
    expect((await phone.closed()).code).toBe(1009);
  });

  test("after hello the limit is 8 MB: a 1 MB message is read", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "send", id: "r1", project: ID, session: "s1", text: "x".repeat(1024 * 1024) });
    expect((await w.calls.next()).args.text).toHaveLength(1024 * 1024);
    expect(await nextFrame(phone, "ack")).toMatchObject({ t: "ack", id: "r1", ok: true });
  });

  test("a socket refused before hello counts against maxPreauth until its TCP connection is closed", async () => {
    const ctx = await startHub({ hub: { limits: { maxPreauth: 1 } } });
    const refused = await RawConn.open(ctx.port, upgradeRequest({ "Tailscale-User-Login": OWNER, Origin: APP_ORIGIN }));
    refused.send(clientFrame(OP.text, "{junk"));
    const close = await refused.frame();
    expect(close.opcode).toBe(OP.close);
    expect(close.payload.readUInt16BE(0)).toBe(4400);
    // The client never answers the Close frame, so its connection (and what it may still send) stays a while.
    expect(await upgradeStatus(ctx.port, { "Tailscale-User-Login": OWNER })).toBe("HTTP/1.1 503 Service Unavailable");
    refused.socket.destroy();
    let status = "";
    for (let i = 0; i < 50 && !status.includes("101"); i++) {
      await sleep(10);
      status = await upgradeStatus(ctx.port, { "Tailscale-User-Login": OWNER });
    }
    expect(status).toBe("HTTP/1.1 101 Switching Protocols");
  });

  test("before hello a socket more than 1 MB behind is dropped when it pings (its pongs cannot pile up)", async () => {
    const ctx = await startHub();
    const raw = await rawPhone(ctx);
    await withBacklog(1024 * 1024, async () => {
      raw.send(clientFrame(OP.ping, "a"));
      expect((await raw.frame()).opcode).toBe(OP.pong); // at the limit: still answered
    });
    await withBacklog(1024 * 1024 + 1, async () => {
      raw.send(clientFrame(OP.ping, "b"));
      await withTimeout(raw.closed, "the connection to be dropped");
    });
    expect(raw.rest.length).toBe(0); // no pong for "b"
  });

  test("after hello the limit is maxQueuedBytes: a ping 2 MB behind is answered, one past 4 MB drops the phone", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const raw = await rawPhone(ctx, creds);
    await withBacklog(2 * 1024 * 1024, async () => {
      raw.send(clientFrame(OP.ping, "a"));
      expect((await raw.frame()).opcode).toBe(OP.pong);
    });
    await withBacklog(4 * 1024 * 1024 + 1, async () => {
      raw.send(clientFrame(OP.ping, "b"));
      await withTimeout(raw.closed, "the connection to be dropped");
    });
    await waitFor(() => ctx.hub.phoneCount() === 0, "the phone to be gone");
  });

  test("each pair try re-arms the hello timer; the frame after maxPreauthFrames closes 4400", async () => {
    const ctx = await startHub({ hub: { helloTimeoutMs: 300 } });
    const phone = await Phone.open(ctx.port);
    const started = Date.now();
    for (let i = 1; i <= 8; i++) {
      phone.send({ t: "pair", code: "ABCD-EFGH", device: "iPhone" });
      expect((await phone.next()).code).toBe("bad_code");
      await sleep(150);
    }
    expect(phone.isClosed).toBe(false);
    expect(Date.now() - started).toBeGreaterThan(900); // three times helloTimeoutMs: every try re-armed it
    phone.send({ t: "pair", code: "ABCD-EFGH", device: "iPhone" });
    expect((await phone.closed()).code).toBe(4400);
  });

  test("only maxPreauth sockets may wait for their hello: the next upgrade gets 503", async () => {
    const ctx = await startHub({ hub: { limits: { maxPreauth: 2 } } });
    const first = await Phone.open(ctx.port);
    await Phone.open(ctx.port);
    expect(statusOf(await rawRequest(ctx.port, upgradeRequest({ "Tailscale-User-Login": OWNER })))).toBe("HTTP/1.1 503 Service Unavailable");
    first.terminate();
    await first.closed();
    await sleep(30);
    const third = await Phone.open(ctx.port);
    expect(third.isClosed).toBe(false);
  });

  test("a hello of another protocol version: an error, then close 4400", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "hello", v: 2, deviceId: creds.deviceId, token: creds.token });
    expect(await phone.next()).toEqual({ t: "error", code: "unsupported_version", message: expect.any(String) });
    expect((await phone.closed()).code).toBe(4400);
  });
});

// ---- pairing ------------------------------------------------------------------------------------

describe("pairing", () => {
  test("newPairingCode(): a XXXX-XXXX code for 10 minutes, a link with the Mac's address, and its QR code", async () => {
    const ctx = await startHub();
    const first = ctx.hub.newPairingCode();
    expect(first.code).toMatch(CODE_RE);
    expect(first.expiresAt).toBe(T0 + 600_000);
    // The address comes from the Tailscale status, read in the background: info() catches up.
    const link = await waitFor(() => ctx.hub.info().pairing?.link, "the pairing link");
    const pairing = ctx.hub.newPairingCode(); // the status is known now: the link comes at once
    expect(pairing.code).not.toBe(first.code);
    expect(pairing.link).toStartWith("https://cce-remote.invalid/#pair=");
    expect(link).toStartWith("https://cce-remote.invalid/#pair=");
    const payload = JSON.parse(Buffer.from(pairing.link.split("#pair=")[1], "base64url").toString("utf8"));
    expect(payload).toEqual({ v: 1, u: `https://${DNS_NAME}:${ctx.port}`, c: pairing.code.replace("-", ""), n: MAC_NAME });
    expect(pairing.qr.size).toBeGreaterThanOrEqual(21);
    expect(pairing.qr.path).toMatch(/^[Mhvz0-9 -]+$/);
    expect(ctx.hub.info().pairing).toEqual(pairing);
  });

  test("the right code, typed in lower case and with spaces, pairs the phone and stores sha256(token) and the Origin", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code: ` ${code.toLowerCase().replace("-", " - ")} `, device: "  iPhone  " });
    const paired = await phone.next("paired");
    expect(paired).toEqual({
      t: "paired",
      deviceId: expect.stringMatching(/^[0-9a-f]{16}$/),
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      mac: { name: MAC_NAME },
    });
    expect(ctx.state().devices).toEqual([
      { id: paired.deviceId, name: "iPhone", tokenHash: sha256(paired.token), origin: APP_ORIGIN, createdAt: T0, lastSeenAt: T0 },
    ]);
    expect(ctx.hub.devices()).toEqual([{ id: paired.deviceId, name: "iPhone", origin: APP_ORIGIN, createdAt: T0, lastSeenAt: T0, push: false }]);
    expect(ctx.hub.info().pairing).toBeNull(); // used up
    expect(JSON.stringify(ctx.logs)).not.toContain(paired.token);
    expect(JSON.stringify(ctx.logs)).not.toContain(code.replace("-", ""));
  });

  test("a device name cannot forge log lines", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code, device: "iPhone\ninfo a forged line\u202e" });
    expect((await phone.next()).t).toBe("paired");
    const line = ctx.logs.find((l) => l.includes("paired a device"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/[\n\u202e]/);
  });

  test("a wrong code gets bad_code; the socket stays open and the right code still works", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const wrong = (code[0] === "A" ? "B" : "A") + code.slice(1);
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code: wrong, device: "iPhone" });
    expect(await phone.next()).toEqual({ t: "error", code: "bad_code", message: expect.any(String) });
    phone.send({ t: "pair", code, device: "iPhone" });
    expect((await phone.next()).t).toBe("paired");
  });

  test("a pairing that cannot be saved: error server_error, then close 1011", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const phone = await Phone.open(ctx.port);
    ctx.faults.writes = true;
    phone.send({ t: "pair", code, device: "iPhone" });
    expect(await phone.next()).toEqual({ t: "error", code: "server_error", message: expect.any(String) });
    expect((await phone.closed()).code).toBe(1011);
    ctx.faults.writes = false;
    expect(ctx.state().devices).toEqual([]);
  });

  test("a code works once", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code, device: "iPhone" });
    expect((await phone.next()).t).toBe("paired");
    const second = await Phone.open(ctx.port);
    second.send({ t: "pair", code, device: "iPad" });
    expect((await second.next()).code).toBe("bad_code");
    expect(ctx.state().devices).toHaveLength(1);
  });

  test("the fifth wrong try burns the code", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const wrong = (code[0] === "A" ? "B" : "A") + code.slice(1);
    const phone = await Phone.open(ctx.port);
    for (let i = 0; i < 5; i++) {
      phone.send({ t: "pair", code: wrong, device: "iPhone" });
      expect((await phone.next()).code).toBe("bad_code");
    }
    phone.send({ t: "pair", code, device: "iPhone" });
    expect((await phone.next()).code).toBe("bad_code");
    expect(ctx.hub.info().pairing).toBeNull();
    expect(ctx.state().devices).toEqual([]);
  });

  test("an expired code is refused", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    ctx.clock.now = T0 + 600_001;
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code, device: "iPhone" });
    expect((await phone.next()).code).toBe("bad_code");
    expect(ctx.hub.info().pairing).toBeNull();
  });

  test("a new code replaces the old one", async () => {
    const ctx = await startHub();
    const old = ctx.hub.newPairingCode().code;
    const current = ctx.hub.newPairingCode().code;
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code: old, device: "iPhone" });
    expect((await phone.next()).code).toBe("bad_code");
    phone.send({ t: "pair", code: current, device: "iPhone" });
    expect((await phone.next()).t).toBe("paired");
  });

  test("the link starts with the app address once one is saved", async () => {
    const ctx = await startHub();
    await ctx.hub.setAppUrl("https://app.example.com/remote/");
    await waitFor(() => ctx.hub.info().pairing?.link || ctx.hub.newPairingCode().link, "a pairing link");
    expect(ctx.hub.newPairingCode().link).toStartWith("https://app.example.com/remote/#pair=");
  });

  test("an app address in state.json that isn't https never reaches the link", async () => {
    const ctx = await startHub();
    updateState((state: Json) => {
      state.appUrl = "javascript:alert(1)";
    }, ctx.env);
    ctx.hub.newPairingCode();
    const link = await waitFor(() => ctx.hub.info().pairing?.link, "the pairing link");
    expect(link).toStartWith("https://cce-remote.invalid/#pair=");
  });

  test("without a Tailscale DNS name the code comes without a link or a QR code", async () => {
    const ctx = await startHub({ status: async () => ({ installed: true, running: false, backendState: "NeedsLogin" }) });
    await waitFor(() => ctx.tailscale.calls > 0, "the status read");
    await sleep(20);
    const pairing = ctx.hub.newPairingCode();
    expect(pairing.code).toMatch(CODE_RE);
    expect(pairing.link).toBe("");
    expect(pairing.qr).toBeNull();
  });

  test("pair and hello may share one socket", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "pair", code, device: "iPhone" });
    const paired = await phone.next();
    phone.send({ t: "hello", v: 1, deviceId: paired.deviceId, token: paired.token });
    expect(await phone.next()).toMatchObject({ t: "welcome", v: 1, mac: { name: MAC_NAME } });
    expect(ctx.hub.phoneCount()).toBe(1);
  });

  test("a pair frame sent in the same write as the upgrade request is read", async () => {
    const ctx = await startHub();
    const { code } = ctx.hub.newPairingCode();
    const request = Buffer.from(upgradeRequest({ "Tailscale-User-Login": OWNER, Origin: APP_ORIGIN }), "latin1");
    const raw = await RawConn.open(ctx.port, Buffer.concat([request, clientFrame(OP.text, JSON.stringify({ t: "pair", code, device: "Raw" }))]));
    expect(statusOf(raw.head)).toBe("HTTP/1.1 101 Switching Protocols");
    const reply = await raw.frame();
    expect(JSON.parse(reply.payload.toString("utf8"))).toMatchObject({ t: "paired", mac: { name: MAC_NAME } });
  });

  test("bytes that arrive while the Tailscale check runs are kept", async () => {
    const gate = deferred<void>();
    const ctx = await startHub({
      status: async () => {
        await gate.promise;
        return { ...OWNER_STATUS };
      },
    });
    const { code } = ctx.hub.newPairingCode();
    const socket = await connectSocket(ctx.port);
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.write(upgradeRequest({ "Tailscale-User-Login": OWNER, Origin: APP_ORIGIN }));
    await sleep(30);
    socket.write(clientFrame(OP.text, JSON.stringify({ t: "pair", code, device: "Early" })));
    await sleep(30);
    gate.resolve();
    await waitFor(() => Buffer.concat(chunks).includes('"t":"paired"'), "the paired frame");
    expect(ctx.state().devices.map((d: Json) => d.name)).toEqual(["Early"]);
  });
});

// ---- hello --------------------------------------------------------------------------------------

describe("hello", () => {
  test("the token from the pairing's Origin: welcome, then projects; ping gets pong", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const { phone, projects } = await connectPhone(ctx, creds);
    expect(projects).toEqual([]);
    expect(ctx.hub.phoneCount()).toBe(1);
    phone.send({ t: "ping" });
    expect(await phone.next()).toEqual({ t: "pong" });
  });

  test("a wrong token: error bad_token, then close 4401", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: "A".repeat(43) });
    await expectRefused(phone, "bad_token");
    expect(ctx.hub.phoneCount()).toBe(0);
  });

  test("an unknown device: error bad_token, then close 4401", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "hello", v: 1, deviceId: "0123456789abcdef", token: creds.token });
    await expectRefused(phone, "bad_token");
  });

  test.each([
    ["a token that is not a string", { token: 42 }],
    ["a device id that is not a string", { deviceId: { id: "x" } }],
    ["no token at all", { token: undefined }],
  ])("%s: error bad_token, then close 4401", async (_label, patch) => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token, ...patch });
    await expectRefused(phone, "bad_token");
  });

  test("another Origin: error bad_origin, then close 4401", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port, { origin: "https://evil.example.com" });
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    await expectRefused(phone, "bad_origin");
  });

  test("no Origin, when the pairing had one: error bad_origin, then close 4401", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port, { origin: null });
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    await expectRefused(phone, "bad_origin");
  });

  test("a hello while state.json cannot be read: close 1011, without an error frame (the app tries again)", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port);
    ctx.faults.reads = true;
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    expect((await phone.closed()).code).toBe(1011);
    expect(phone.frames.pending).toBe(0);
  });

  test("lastSeenAt is kept in memory: devices() and info() say when a phone was last heard from, and state.json is never written for it", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx); // lastSeenAt T0, written with the device
    const writesAfterPairing = ctx.writes.count;
    const lastSeen = () => ctx.hub.devices()[0].lastSeenAt;
    ctx.clock.now = T0 + 30_000;
    const first = await connectPhone(ctx, creds);
    expect(lastSeen()).toBe(T0 + 30_000); // the hello
    ctx.clock.now = T0 + 61_000;
    await roundTrip(first.phone);
    expect(lastSeen()).toBe(T0 + 61_000);
    ctx.clock.now = T0 + 62_000;
    await roundTrip(first.phone);
    expect(lastSeen()).toBe(T0 + 62_000); // every frame counts: nothing is written, so nothing is held back
    expect(ctx.hub.info().devices[0].lastSeenAt).toBe(T0 + 62_000);
    ctx.clock.now = T0 + 3_600_000;
    await roundTrip(first.phone);
    expect(ctx.writes.count).toBe(writesAfterPairing);
    expect(ctx.state().devices[0].lastSeenAt).toBe(T0);
  });

  test("a phone that keeps talking never rewrites state.json, so a Disconnect another window writes meanwhile is never undone", async () => {
    const ctx = await startHub();
    updateState((state) => {
      state.enabled = true;
    }, ctx.env);
    const { phone } = await pairedPhone(ctx);
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      updateState((state) => {
        state.enabled = false; // the Connection tab of another window
      }, ctx.env);
    };
    // Where it lands if the hub writes: after the hub read the file, before it writes its copy back.
    ctx.hooks.betweenReadAndWrite = disconnect;
    for (let minute = 1; minute <= 5; minute++) {
      ctx.clock.now = T0 + minute * 61_000;
      await roundTrip(phone);
    }
    disconnect(); // (when the hub never wrote, it lands here)
    expect(ctx.state().enabled).toBe(false);
  });

  test("a lastSeenAt in state.json that is newer than what the hub saw (another hub, earlier) still counts", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    updateState((state) => {
      state.devices[0].lastSeenAt = T0 + 500_000;
    }, ctx.env);
    ctx.clock.now = T0 + 1_000;
    await connectPhone(ctx, creds);
    expect(ctx.hub.devices()[0].lastSeenAt).toBe(T0 + 500_000);
  });

  test("a second hello on an open socket is an error, and the socket stays", async () => {
    const ctx = await startHub();
    const { phone, creds } = await pairedPhone(ctx);
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "bad_request", message: expect.any(String) });
    await roundTrip(phone);
  });
});

// ---- projects -----------------------------------------------------------------------------------

describe("projects", () => {
  test("a window's project reaches the phones under the window's own id", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub);
    const { projects } = await pairedPhone(ctx);
    expect(projects).toEqual([project(ID)]);
  });

  test("updates are debounced: three quick setProject calls make one projects frame", async () => {
    const ctx = await startHub({ hub: { projectsDebounceMs: 100 } });
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    w.handle.setProject(project(ID, "one"));
    w.handle.setProject(project(ID, "two"));
    w.handle.setProject(project(ID, "three"));
    const frame = await phone.next("the projects frame");
    expect(frame).toEqual({ t: "projects", projects: [project(ID, "three")] });
    await sleep(250);
    expect(phone.frames.pending).toBe(0);
  });

  test("windows that share an id are told apart with -2, -3", async () => {
    const ctx = await startHub();
    for (const key of ["w1", "w2", "w3"]) fakeWindow(ctx.hub, { key });
    const { projects } = await pairedPhone(ctx);
    expect(projects.map((p: Json) => p.id)).toEqual([ID, `${ID}-2`, `${ID}-3`]);
  });

  test("projects are sorted by name", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, { key: "w1", id: "bbbbbbbbbbbb", name: "zeta" });
    fakeWindow(ctx.hub, { key: "w2", id: "cccccccccccc", name: "Alpha" });
    const { projects } = await pairedPhone(ctx);
    expect(projects.map((p: Json) => p.name)).toEqual(["Alpha", "zeta"]);
  });

  test("a window without a project yet is counted but not listed", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, { id: null });
    const { projects } = await pairedPhone(ctx);
    expect(projects).toEqual([]);
    expect(ctx.hub.info().windows).toBe(1);
  });

  test("a project without a usable id is ignored", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub, { id: null });
    w.handle.setProject({ ...project(ID), id: 42 });
    w.handle.setProject({ ...project(ID), id: "" });
    w.handle.setProject(null);
    const { projects } = await pairedPhone(ctx);
    expect(projects).toEqual([]);
  });

  test("a window whose project id changes is listed under the new id; the old id is gone", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const other = fakeWindow(ctx.hub, { key: "w2", id: "bbbbbbbbbbbb", name: "other" });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await nextFrame(phone, "snapshot");
    await w.calls.next("the snapshot call");
    w.handle.setProject(project("bbbbbbbbbbbb")); // its folders changed, and the new id is taken
    const listed = await projectsWhere(phone, (ps) => ps.every((p: Json) => p.id !== ID));
    expect(listed.map((p: Json) => p.id).sort()).toEqual(["bbbbbbbbbbbb", "bbbbbbbbbbbb-2"]);
    w.handle.sessionEvent("s1", { t: "msg", message: message("m2") }); // now under bbbbbbbbbbbb-2: not subscribed
    phone.send({ t: "open", id: "r1", project: ID, session: "s1" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: false, error: "unknown_project" });
    phone.send({ t: "open", id: "r2", project: "bbbbbbbbbbbb-2", session: "s1" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r2", ok: true });
    expect(await w.calls.next()).toEqual({ method: "open", args: { session: "s1" } });
    expect(other.calls.pending).toBe(0);
    await phone.expectQuiet();
  });

  test("a removed window's project leaves the list, and a new window with the same key replaces the old one", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    w.handle.remove();
    expect(await projectsWhere(phone, (ps) => ps.length === 0)).toEqual([]);
    fakeWindow(ctx.hub, { key: "w1" });
    fakeWindow(ctx.hub, { key: "w1", name: "replaced" });
    expect(await projectsWhere(phone, (ps) => ps.length === 1 && ps[0].name === "replaced")).toEqual([project(ID, "replaced")]);
    expect(ctx.hub.info().windows).toBe(1);
  });
});

// ---- subscriptions ------------------------------------------------------------------------------

describe("subscriptions", () => {
  test("sub gets the window's snapshot, with project and session exactly as the phone sent them", async () => {
    const ctx = await startHub();
    const w1 = fakeWindow(ctx.hub, { key: "w1" });
    const w2 = fakeWindow(ctx.hub, { key: "w2" });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: `${ID}-2`, session: "s1" });
    expect(await w2.calls.next("the snapshot call")).toEqual({ method: "snapshot", args: { session: "s1" } });
    expect(await nextFrame(phone, "snapshot")).toEqual({
      t: "snapshot",
      project: `${ID}-2`,
      session: "s1",
      messages: [message("s1-m1")],
      pending: [],
      state: "idle",
      live: true,
      truncatedBefore: 0,
    });
    expect(w1.calls.pending).toBe(0);
  });

  test("session events reach only the phones subscribed to that session", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const creds = await pairPhone(ctx);
    const a = (await connectPhone(ctx, creds)).phone;
    const b = (await connectPhone(ctx, creds)).phone;
    a.send({ t: "sub", project: ID, session: "s1" });
    b.send({ t: "sub", project: ID, session: "s2" });
    await nextFrame(a, "snapshot");
    await nextFrame(b, "snapshot");
    w.handle.sessionEvent("s1", { t: "msg", message: message("m2") });
    w.handle.sessionEvent("s2", { t: "stream", event: { type: "content_block_delta", index: 0, text: "Hel" } });
    w.handle.sessionEvent("s1", { t: "pending", pending: [PENDING] });
    w.handle.sessionEvent("s3", { t: "msg", message: message("m3") });
    w.handle.sessionEvent("s1", { t: "unknown", message: message("m4") });
    expect(await nextFrame(a, "msg")).toEqual({ t: "msg", project: ID, session: "s1", message: message("m2") });
    expect(await nextFrame(a, "pending")).toEqual({ t: "pending", project: ID, session: "s1", pending: [PENDING] });
    expect(await nextFrame(b, "stream")).toEqual({ t: "stream", project: ID, session: "s2", event: { type: "content_block_delta", index: 0, text: "Hel" } });
    await a.expectQuiet();
    await b.expectQuiet();
  });

  test("events that arrive while the snapshot loads are sent after it, in order", async () => {
    const ctx = await startHub();
    const gate = deferred<Json>();
    const w = fakeWindow(ctx.hub, { handlers: { snapshot: () => gate.promise } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await w.calls.next("the snapshot call");
    w.handle.sessionEvent("s1", { t: "msg", message: message("m2") });
    w.handle.sessionEvent("s1", { t: "stream", event: { type: "message_start" } });
    w.handle.sessionEvent("s1", { t: "msg", message: message("m3") });
    await phone.expectQuiet(50);
    gate.resolve(snapshotOf("s1"));
    expect((await nextFrame(phone, "snapshot")).messages).toEqual([message("s1-m1")]);
    expect((await nextFrame(phone, "msg")).message.uuid).toBe("m2");
    expect((await nextFrame(phone, "stream")).event).toEqual({ type: "message_start" });
    expect((await nextFrame(phone, "msg")).message.uuid).toBe("m3");
  });

  test("after unsub no events arrive, and a snapshot that comes back late is dropped", async () => {
    const ctx = await startHub();
    const gate = deferred<Json>();
    const w = fakeWindow(ctx.hub, { handlers: { snapshot: () => gate.promise } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await w.calls.next("the snapshot call");
    phone.send({ t: "unsub", project: ID, session: "s1" });
    await roundTrip(phone);
    gate.resolve(snapshotOf("s1"));
    w.handle.sessionEvent("s1", { t: "msg", message: message("m2") });
    await phone.expectQuiet();
  });

  test("a snapshot that fails: an error frame for that session; the subscription stays", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub, {
      handlers: {
        snapshot: () => {
          throw new Error("boom");
        },
      },
    });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "snapshot_failed", message: "boom", project: ID, session: "s1" });
    w.handle.sessionEvent("s1", { t: "msg", message: message("m2") });
    expect((await nextFrame(phone, "msg")).message.uuid).toBe("m2");
  });

  test("a snapshot that never comes back fails after the call timeout", async () => {
    const ctx = await startHub({ hub: { callTimeoutMs: 150 } });
    fakeWindow(ctx.hub, { handlers: { snapshot: () => new Promise(() => {}) } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "snapshot_failed", message: "timeout", project: ID, session: "s1" });
  });

  test("a sub for a project that isn't there yet is answered once its window comes", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: "bbbbbbbbbbbb", session: "s1" });
    await roundTrip(phone);
    const w = fakeWindow(ctx.hub, { id: "bbbbbbbbbbbb" });
    expect(await w.calls.next("the snapshot call")).toEqual({ method: "snapshot", args: { session: "s1" } });
    expect(await nextFrame(phone, "snapshot")).toMatchObject({ project: "bbbbbbbbbbbb", session: "s1" });
  });

  test("a window that goes away and comes back with the same key and id: subscribed phones get a fresh snapshot", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub, { key: "w1" });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await nextFrame(phone, "snapshot");
    await w.calls.next("the first snapshot call");
    w.handle.remove();
    const again = fakeWindow(ctx.hub, { key: "w1", handlers: { snapshot: (args) => snapshotOf(args.session, [message("after-reload")]) } });
    expect(await again.calls.next("the second snapshot call")).toEqual({ method: "snapshot", args: { session: "s1" } });
    expect(await nextFrame(phone, "snapshot")).toMatchObject({ project: ID, session: "s1", messages: [message("after-reload")] });
  });

  test("a phone may hold at most maxSubscriptions subscriptions", async () => {
    const ctx = await startHub({ hub: { limits: { maxSubscriptions: 2 } } });
    fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    phone.send({ t: "sub", project: ID, session: "s2" });
    await nextFrame(phone, "snapshot");
    await nextFrame(phone, "snapshot");
    phone.send({ t: "sub", project: ID, session: "s3" });
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "too_many_subscriptions", message: expect.any(String) });
    phone.send({ t: "unsub", project: ID, session: "s1" });
    phone.send({ t: "sub", project: ID, session: "s3" });
    expect((await nextFrame(phone, "snapshot")).session).toBe("s3");
  });

  test.each([
    ["a project that is not a string", { t: "sub", project: 5, session: "s1" }],
    ["an empty session", { t: "sub", project: ID, session: "" }],
    ["a session id that is far too long", { t: "sub", project: ID, session: "s".repeat(300) }],
  ])("a sub with %s: error bad_request", async (_label, frame) => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send(frame);
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "bad_request", message: expect.any(String) });
    expect(w.calls.pending).toBe(0);
  });
});

// ---- requests -----------------------------------------------------------------------------------

describe("requests", () => {
  test("send: routed to the window as {session, text, images}, acked with session and uuid", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "send", id: "r1", project: ID, session: "s1", text: "hi" });
    expect(await w.calls.next()).toEqual({ method: "send", args: { session: "s1", text: "hi", images: [] } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, session: "s1", uuid: "u-1" });
  });

  test("send to a new session (session null), with images", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    const images = [{ mediaType: "image/png", data: "iVBORw0KGgo=" }];
    phone.send({ t: "send", id: "r1", project: ID, session: null, text: "new", images });
    expect(await w.calls.next()).toEqual({ method: "send", args: { session: null, text: "new", images } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, session: "s-new", uuid: "u-1" });
  });

  test("a send whose session is not known yet is acked without one", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, { handlers: { send: () => ({ session: null, uuid: "u-2" }) } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "send", id: "r1", project: ID, session: null, text: "new" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, uuid: "u-2" });
  });

  test("answer, interrupt, open and openClaude: routed to the window and acked", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    const choice = { kind: "deny", reason: "use pnpm" };
    phone.send({ t: "answer", id: "r2", project: ID, session: "s1", requestId: "req-1", choice });
    expect(await w.calls.next()).toEqual({ method: "answer", args: { session: "s1", requestId: "req-1", choice } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r2", ok: true });
    phone.send({ t: "interrupt", id: "r3", project: ID, session: "s1" });
    expect(await w.calls.next()).toEqual({ method: "interrupt", args: { session: "s1" } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r3", ok: true });
    phone.send({ t: "open", id: "r4", project: ID, session: "s1" });
    expect(await w.calls.next()).toEqual({ method: "open", args: { session: "s1" } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r4", ok: true });
    phone.send({ t: "openClaude", id: 5, project: ID });
    expect(await w.calls.next()).toEqual({ method: "openClaude", args: {} });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: 5, ok: true });
  });

  test("a window that throws or rejects: ack ok:false with the error's message", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, {
      handlers: {
        answer: () => {
          throw new Error("not_pending");
        },
        send: async () => {
          throw new Error("bad_images");
        },
      },
    });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "answer", id: "r1", project: ID, session: "s1", requestId: "req-1", choice: { kind: "allow" } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: false, error: "not_pending" });
    phone.send({ t: "send", id: "r2", project: ID, session: "s1", text: "x" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r2", ok: false, error: "bad_images" });
  });

  test("window calls time out per method: send 50 s (a new session can take 40 s), active 10 s, commands 15 s, the rest 20 s", () => {
    expect(DEFAULT_CALL_TIMEOUTS_MS).toEqual({
      snapshot: 20_000,
      send: 50_000,
      answer: 20_000,
      interrupt: 20_000,
      open: 20_000,
      openClaude: 20_000,
      active: 10_000,
      usage: 20_000,
      commands: 15_000,
    });
  });

  test("commands: routed to the window, acked with the checked list", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub, { handlers: { commands: () => [{ name: "compact", description: "Compact the\nconversation" }] } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "commands", id: "r1", project: ID });
    expect(await w.calls.next()).toEqual({ method: "commands", args: {} });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, commands: [{ name: "compact", description: "Compact the conversation" }] });
  });

  test("commands: the hub bounds what a window answers", async () => {
    const ctx = await startHub();
    const names = Array.from({ length: 400 }, (_, i) => `c${String(i).padStart(3, "0")}`);
    const first = { name: "c000", description: "d".repeat(500), argumentHint: "[x]​", aliases: ["a b", ...Array.from({ length: 12 }, (_, i) => `al${i}`)] };
    const answer = [
      { name: "has space" },
      { name: "" },
      { name: "x".repeat(101) },
      { name: "bad‮name" },
      first,
      { name: "c000", description: "a second c000" },
      ...names.slice(1).map((name) => ({ name })),
    ];
    fakeWindow(ctx.hub, { handlers: { commands: () => answer } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "commands", id: "r1", project: ID });
    const ack = await nextFrame(phone, "ack");
    expect(ack.ok).toBe(true);
    expect(ack.commands).toHaveLength(300);
    expect(ack.commands[0]).toEqual({ name: "c000", description: "d".repeat(300), argumentHint: "[x]", aliases: ["al0", "al1", "al2", "al3", "al4", "al5", "al6", "al7", "al8", "al9"] });
    expect(ack.commands.map((c: { name: string }) => c.name)).toEqual(names.slice(0, 300));
  });

  test("commands: MCP command names keep their trailing (MCP)", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, { handlers: { commands: () => [{ name: "github:create-issue (MCP)", argumentHint: "[title]" }, { name: "a (MCP) b" }, { name: "x  (MCP)" }] } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "commands", id: "r1", project: ID });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, commands: [{ name: "github:create-issue (MCP)", argumentHint: "[title]" }] });
  });

  test("commands: a window answer that is not a list acks []", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, { handlers: { commands: () => undefined } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "commands", id: "r1", project: ID });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, commands: [] });
  });

  test("callTimeoutMs can set the timeout of one method", async () => {
    const ctx = await startHub({ hub: { callTimeoutMs: { open: 100 } } });
    const sent = deferred<Json>();
    fakeWindow(ctx.hub, { handlers: { open: () => new Promise(() => {}), send: () => sent.promise } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "send", id: "r1", project: ID, session: "s1", text: "x" });
    phone.send({ t: "open", id: "r2", project: ID, session: "s1" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r2", ok: false, error: "timeout" });
    await sleep(150); // past open's timeout: send keeps its own
    sent.resolve({ session: "s1", uuid: "u-9" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, session: "s1", uuid: "u-9" });
  });

  test("a window call that never settles is acked with timeout", async () => {
    const ctx = await startHub({ hub: { callTimeoutMs: 150 } });
    fakeWindow(ctx.hub, { handlers: { open: () => new Promise(() => {}) } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "open", id: "r1", project: ID, session: "s1" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: false, error: "timeout" });
  });

  test("an unknown project: ack unknown_project, and no window is called", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "interrupt", id: "r1", project: "nope", session: "s1" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: false, error: "unknown_project" });
    expect(w.calls.pending).toBe(0);
  });

  test.each([
    ["send without text", { t: "send", id: "r1", project: ID, session: "s1" }],
    ["send with text that is not a string", { t: "send", id: "r1", project: ID, session: "s1", text: 5 }],
    ["send with images that are not a list", { t: "send", id: "r1", project: ID, session: "s1", text: "x", images: "x" }],
    ["send without a session", { t: "send", id: "r1", project: ID, text: "x" }],
    ["answer without a choice", { t: "answer", id: "r1", project: ID, session: "s1", requestId: "q" }],
    ["answer with a list as the choice", { t: "answer", id: "r1", project: ID, session: "s1", requestId: "q", choice: [] }],
    ["answer without a requestId", { t: "answer", id: "r1", project: ID, session: "s1", choice: { kind: "allow" } }],
    ["interrupt with a session that is not a string", { t: "interrupt", id: "r1", project: ID, session: 5 }],
    ["open with an empty session", { t: "open", id: "r1", project: ID, session: "" }],
    ["openClaude without a project", { t: "openClaude", id: "r1" }],
    ["commands without a project", { t: "commands", id: "r1" }],
    ["a project id that is far too long", { t: "openClaude", id: "r1", project: "p".repeat(300) }],
  ])("%s: ack bad_request, and no window is called", async (_label, frame) => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send(frame);
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: false, error: "bad_request" });
    expect(w.calls.pending).toBe(0);
  });

  test.each([
    ["no id", { t: "open", project: ID, session: "s1" }],
    ["an object as the id", { t: "open", id: { x: 1 }, project: ID, session: "s1" }],
    ["an empty id", { t: "open", id: "", project: ID, session: "s1" }],
  ])("a request with %s: error bad_request", async (_label, frame) => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send(frame);
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "bad_request", message: expect.any(String) });
    expect(w.calls.pending).toBe(0);
  });

  test("a frame of an unknown type: ack unknown_type when it has an id, ignored without one", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "fly", id: "r9" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r9", ok: false, error: "unknown_type" });
    phone.send({ t: "fly" });
    await roundTrip(phone);
    await phone.expectQuiet(30);
  });

  test("text that is not JSON after hello: error bad_request, and the socket stays", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    phone.send("{not json");
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "bad_request", message: expect.any(String) });
    phone.send('{"__proto__":{"t":"ping"}}'); // the type hides behind a prototype key: a frame without a type
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "bad_request", message: expect.any(String) });
    await roundTrip(phone);
    await phone.expectQuiet(30);
  });

  test("a frame over 8 MB closes the socket with 1009", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    phone.send("x".repeat(8 * 1024 * 1024 + 1));
    expect((await phone.closed()).code).toBe(1009);
    await waitFor(() => ctx.hub.phoneCount() === 0, "the phone to be gone");
  });
});

// ---- active -------------------------------------------------------------------------------------

describe("active", () => {
  test("the first phone switches every window on; the last one leaving switches them off", async () => {
    const ctx = await startHub();
    const w1 = fakeWindow(ctx.hub, { key: "w1", id: "aaaaaaaaaaaa" });
    const w2 = fakeWindow(ctx.hub, { key: "w2", id: "bbbbbbbbbbbb" });
    const creds = await pairPhone(ctx);
    await sleep(20);
    expect(w1.actives()).toEqual([]); // pairing alone switches nothing on
    const a = await connectPhone(ctx, creds);
    expect(w1.actives()).toEqual([true]);
    expect(w2.actives()).toEqual([true]);
    const b = await connectPhone(ctx, creds);
    a.phone.terminate();
    await a.phone.closed();
    await waitFor(() => ctx.hub.phoneCount() === 1, "the first phone to be gone");
    expect(w1.actives()).toEqual([true]);
    b.phone.terminate();
    await b.phone.closed();
    await waitFor(() => w1.actives().length === 2 && w2.actives().length === 2, "the windows to be switched off");
    expect(w1.actives()).toEqual([true, false]);
    expect(w2.actives()).toEqual([true, false]);
  });

  test("a window added while a phone is connected is switched on at once", async () => {
    const ctx = await startHub();
    await pairedPhone(ctx);
    const w = fakeWindow(ctx.hub);
    expect(w.actives()).toEqual([true]);
  });

  test("a window whose active call fails stays registered", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub, {
      handlers: {
        active: () => {
          throw new Error("agent gone");
        },
      },
    });
    const { phone } = await pairedPhone(ctx);
    expect(w.actives()).toEqual([true]);
    phone.send({ t: "open", id: "r1", project: ID, session: "s1" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true });
  });
});

// ---- devices, app address, info -----------------------------------------------------------------

describe("devices", () => {
  test("removeDevice(): error revoked, close 4401, gone from state.json, and its token no longer works", async () => {
    const ctx = await startHub();
    const { phone, creds } = await pairedPhone(ctx);
    const other = await pairPhone(ctx, { device: "iPad" });
    await ctx.hub.removeDevice(creds.deviceId);
    await expectRefused(phone, "revoked");
    expect(ctx.state().devices.map((d: Json) => d.id)).toEqual([other.deviceId]);
    expect(ctx.hub.devices().map((d: Json) => d.id)).toEqual([other.deviceId]);
    const again = await Phone.open(ctx.port);
    again.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    await expectRefused(again, "bad_token");
    await connectPhone(ctx, other); // the other device is untouched
  });

  test("a revoked device stays refused even if an old copy of state.json brings it back", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const before = fs.readFileSync(path.join(ctx.env.CCE_REMOTE_HOME, "state.json"), "utf8");
    await ctx.hub.removeDevice(creds.deviceId);
    fs.writeFileSync(path.join(ctx.env.CCE_REMOTE_HOME, "state.json"), before); // another window's stale write
    const phone = await Phone.open(ctx.port);
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    await expectRefused(phone, "bad_token");
  });

  test("removeDevice() that cannot write state.json rejects remove_failed, and still closes the phone and emits change", async () => {
    const ctx = await startHub();
    const { phone, creds } = await pairedPhone(ctx);
    let changes = 0;
    ctx.hub.on("change", () => changes++);
    ctx.faults.writes = true;
    const error: Json = await ctx.hub.removeDevice(creds.deviceId).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("remove_failed");
    expect(error.code).toBe("remove_failed");
    expect(changes).toBeGreaterThan(0);
    await expectRefused(phone, "revoked");
    expect(ctx.logs.some((line) => line.startsWith("warn") && line.includes("ENOSPC"))).toBe(true);
    ctx.faults.writes = false;
    const again = await Phone.open(ctx.port); // still on disk, but this hub refuses it
    again.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    await expectRefused(again, "bad_token");
  });

  test("removeDevice() of an unknown id resolves; an id that is not a string is refused", async () => {
    const ctx = await startHub();
    await ctx.hub.removeDevice("0123456789abcdef");
    await expect(ctx.hub.removeDevice(42)).rejects.toThrow("bad_id");
  });

  test("info(): windows, phones, devices without their token hash, and the live pairing code", async () => {
    const ctx = await startHub();
    fakeWindow(ctx.hub, { key: "w1" });
    fakeWindow(ctx.hub, { key: "w2", id: null });
    expect(ctx.hub.info()).toEqual({ windows: 2, phones: 0, devices: [], pairing: null });
    const creds = await pairPhone(ctx);
    await connectPhone(ctx, creds);
    const pairing = ctx.hub.newPairingCode();
    expect(ctx.hub.info()).toEqual({
      windows: 2,
      phones: 1,
      devices: [{ id: creds.deviceId, name: "iPhone", origin: APP_ORIGIN, createdAt: T0, lastSeenAt: T0, push: false }],
      pairing,
    });
  });
});

describe("setAppUrl", () => {
  test("stores an https address without its trailing slash, and the empty string", async () => {
    const ctx = await startHub();
    await ctx.hub.setAppUrl("https://app.example.com/");
    expect(ctx.state().appUrl).toBe("https://app.example.com");
    await ctx.hub.setAppUrl("  https://App.Example.com/remote/  ");
    expect(ctx.state().appUrl).toBe("https://app.example.com/remote");
    await ctx.hub.setAppUrl("https://app.example.com:8443");
    expect(ctx.state().appUrl).toBe("https://app.example.com:8443");
    await ctx.hub.setAppUrl("");
    expect(ctx.state().appUrl).toBe("");
  });

  test.each([
    ["http", "http://app.example.com"],
    ["credentials", "https://user:secret@app.example.com"],
    ["javascript", "javascript:alert(1)"],
    ["no scheme", "app.example.com"],
    ["https without slashes", "https:app.example.com"],
    ["a query", "https://app.example.com/?x=1"],
    ["a fragment", "https://app.example.com/#x"],
    ["a space", "https://app.example.com/a b"],
    ["a newline", "https://app.example.com/\nx"],
    ["no host", "https://"],
    ["something far too long", `https://app.example.com/${"a".repeat(600)}`],
    ["a number", 42],
    ["null", null],
  ])("refuses %s with bad_url and leaves the state alone", async (_label, url) => {
    const ctx = await startHub();
    await ctx.hub.setAppUrl("https://app.example.com");
    const error: Json = await ctx.hub.setAppUrl(url as Json).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("bad_url");
    expect(error.code).toBe("bad_url");
    expect(ctx.state().appUrl).toBe("https://app.example.com");
  });
});

// ---- peers --------------------------------------------------------------------------------------

describe("peers", () => {
  test("a peer's window: its project and session events reach phones, and phone requests reach it", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const link = await connectPeer({ port: ctx.port, secret: ctx.state().secret });
    closers.push(() => link.close());
    const peerCalls = queue<Call>();
    const peerActives: boolean[] = [];
    link.setHandler((method: string, args: Json) => {
      if (method === "active") {
        peerActives.push(args.on);
        return undefined;
      }
      peerCalls.push({ method, args });
      if (method === "snapshot") return snapshotOf(args.session);
      if (method === "send") return { session: args.session, uuid: "u-peer" };
      return undefined;
    });
    link.notify("project", project("bbbbbbbbbbbb", "peer-window"));
    expect(await projectsWhere(phone, (ps) => ps.length === 1)).toEqual([project("bbbbbbbbbbbb", "peer-window")]);
    await waitFor(() => peerActives.length > 0, "the peer to be switched on");
    expect(peerActives).toEqual([true]);
    phone.send({ t: "sub", project: "bbbbbbbbbbbb", session: "s1" });
    expect(await peerCalls.next()).toEqual({ method: "snapshot", args: { session: "s1" } });
    expect((await nextFrame(phone, "snapshot")).messages).toEqual([message("s1-m1")]);
    link.notify("session", { session: "s1", ev: { t: "msg", message: message("m2") } });
    expect(await nextFrame(phone, "msg")).toEqual({ t: "msg", project: "bbbbbbbbbbbb", session: "s1", message: message("m2") });
    phone.send({ t: "send", id: "r1", project: "bbbbbbbbbbbb", session: "s1", text: "hi" });
    expect(await peerCalls.next()).toEqual({ method: "send", args: { session: "s1", text: "hi", images: [] } });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "r1", ok: true, session: "s1", uuid: "u-peer" });
    link.close();
    expect(await projectsWhere(phone, (ps) => ps.length === 0, "the peer's project to go")).toEqual([]);
    expect(ctx.hub.info().windows).toBe(0);
  });

  test("a peer can use the hub's status, pairing, devices and app address", async () => {
    const ctx = await startHub();
    const link = await connectPeer({ port: ctx.port, secret: ctx.state().secret });
    closers.push(() => link.close());
    link.setHandler(() => undefined);
    const pairing = await link.call("newPairingCode");
    expect(pairing.code).toMatch(CODE_RE);
    const status = await link.call("status");
    expect(status).toMatchObject({ windows: 1, phones: 0, devices: [] });
    expect(status.pairing.code).toBe(pairing.code);
    await link.call("setAppUrl", { url: "https://app.example.com" });
    expect(ctx.state().appUrl).toBe("https://app.example.com");
    await expect(link.call("setAppUrl", { url: "http://app.example.com" })).rejects.toThrow("bad_url");
    const creds = await pairPhone(ctx);
    await link.call("removeDevice", { id: creds.deviceId });
    expect(ctx.state().devices).toEqual([]);
    await expect(link.call("fly")).rejects.toThrow("unknown_method");
  });

  test("/_peer refuses a request with a Tailscale header, without a nonce, or with the secret sent the old way: 403", async () => {
    const ctx = await startHub();
    const secret = ctx.state().secret;
    expect(statusOf(await rawRequest(ctx.port, peerUpgrade({ extra: `Tailscale-User-Login: ${OWNER}\r\n` })))).toBe("HTTP/1.1 403 Forbidden");
    expect(statusOf(await rawRequest(ctx.port, peerUpgrade({ nonce: null })))).toBe("HTTP/1.1 403 Forbidden");
    expect(statusOf(await rawRequest(ctx.port, peerUpgrade({ nonce: null, extra: `X-CCE-Secret: ${secret}\r\n` })))).toBe("HTTP/1.1 403 Forbidden");
    expect(ctx.hub.info().windows).toBe(0);
  });

  test("/_peer refuses what came through tailscale serve (X-Forwarded-*) and any Host that is not loopback", async () => {
    const ctx = await startHub();
    for (const request of [
      peerUpgrade({ host: `127.0.0.1:${ctx.port}`, extra: "X-Forwarded-For: 100.64.0.2\r\n" }),
      peerUpgrade({ host: `127.0.0.1:${ctx.port}`, extra: "X-Forwarded-Proto: https\r\n" }),
      peerUpgrade({ host: `${DNS_NAME}:${ctx.port}` }),
      peerUpgrade({ host: `127.0.0.1.example.com:${ctx.port}` }),
      peerUpgrade({ host: null }),
    ]) {
      expect(statusOf(await rawRequest(ctx.port, request))).toBe("HTTP/1.1 403 Forbidden");
    }
    expect(ctx.hub.info().windows).toBe(0);
    for (const host of [`127.0.0.1:${ctx.port}`, "127.0.0.1", `localhost:${ctx.port}`, `[::1]:${ctx.port}`]) {
      const raw = await RawConn.open(ctx.port, peerUpgrade({ host }));
      expect(statusOf(raw.head)).toBe("HTTP/1.1 101 Switching Protocols");
      raw.socket.destroy();
    }
  });

  test("the hub answers the upgrade with its proof, and registers the peer only once the peer proved itself", async () => {
    const ctx = await startHub();
    const secret = ctx.state().secret;
    const { phone } = await pairedPhone(ctx); // with a phone connected the hub calls a window it registers at once (active)
    const nonce = newNonce();
    const raw = await RawConn.open(ctx.port, peerUpgrade({ nonce }));
    const hubNonce = raw.header("X-CCE-Nonce")!;
    expect(raw.header("X-CCE-Proof")).toBe(proofOf(secret, "hub", nonce, hubNonce));
    await sleep(50);
    expect(ctx.hub.info().windows).toBe(0);
    expect(ctx.hub.peerCount()).toBe(0);
    expect(raw.rest.length).toBe(0); // no call (active) before the proof
    raw.send(`${JSON.stringify({ t: "auth", proof: proofOf(secret, "peer", nonce, hubNonce) })}\n`);
    expect(JSON.parse(await raw.line())).toMatchObject({ t: "call", m: "active", a: { on: true } });
    expect(ctx.hub.info().windows).toBe(1);
    expect(ctx.hub.peerCount()).toBe(1);
    raw.send(`${JSON.stringify({ t: "evt", e: "project", d: project("bbbbbbbbbbbb", "peer-window") })}\n`);
    expect(await projectsWhere(phone, (ps) => ps.length === 1)).toEqual([project("bbbbbbbbbbbb", "peer-window")]);
  });

  test.each([
    ["a wrong proof", (hubNonce: string, peerNonce: string) => `${JSON.stringify({ t: "auth", proof: proofOf("f".repeat(64), "peer", peerNonce, hubNonce) })}\n`],
    ["a project event instead of a proof", () => `${JSON.stringify({ t: "evt", e: "project", d: { id: "bbbbbbbbbbbb", name: "impostor", sessions: [] } })}\n`],
    ["a call instead of a proof", () => `${JSON.stringify({ t: "call", id: 1, m: "newPairingCode" })}\n`],
  ] as Array<[string, (hubNonce: string, peerNonce: string) => string]>)("a peer that sends %s is closed: no window, no project, no answer, and a warning", async (_label, first) => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const before = ctx.hub.info().pairing;
    const { raw } = await rawPeer(ctx.port, ctx.state().secret, first);
    await withTimeout(raw.closed, "the hub to close the link");
    expect(raw.rest.length).toBe(0);
    expect(ctx.hub.info().windows).toBe(0);
    expect(ctx.hub.info().pairing).toEqual(before); // no code was made for it
    await roundTrip(phone);
    expect(phone.frames.pending).toBe(0); // no projects frame
    await waitFor(() => ctx.logs.some((line) => line === "warn refused a peer link: it did not prove that it knows the secret"), "the warning");
  });

  test("a peer that never proves itself is closed after peerAuthTimeoutMs", async () => {
    const ctx = await startHub({ hub: { peerAuthTimeoutMs: 80 } });
    const started = Date.now();
    const { raw } = await rawPeer(ctx.port, ctx.state().secret, null);
    await withTimeout(raw.closed, "the hub to close the link");
    expect(Date.now() - started).toBeLessThan(1500);
    expect(ctx.hub.info().windows).toBe(0);
  });

  test("close() also closes the links that have not proved themselves yet", async () => {
    const ctx = await startHub();
    const { raw } = await rawPeer(ctx.port, ctx.state().secret, null);
    const started = Date.now();
    await ctx.hub.close();
    await withTimeout(raw.closed, "the link to close");
    expect(Date.now() - started).toBeLessThan(900); // not left for the server's 1 s grace
  });

  test("a peer event that isn't well formed is ignored", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const link = await connectPeer({ port: ctx.port, secret: ctx.state().secret });
    closers.push(() => link.close());
    link.setHandler(() => snapshotOf("s1"));
    link.notify("project", project("bbbbbbbbbbbb"));
    await projectsWhere(phone, (ps) => ps.length === 1);
    phone.send({ t: "sub", project: "bbbbbbbbbbbb", session: "s1" });
    await nextFrame(phone, "snapshot");
    link.notify("session", "nonsense");
    link.notify("session", { session: 5, ev: { t: "msg", message: message("x") } });
    link.notify("session", { session: "s1", ev: null });
    link.notify("fly", {});
    link.notify("session", { session: "s1", ev: { t: "msg", message: message("m2") } });
    expect((await nextFrame(phone, "msg")).message.uuid).toBe("m2");
  });
});

// ---- attention ----------------------------------------------------------------------------------

// What a window's agent reports for notifications (a prompt appeared, a session's open prompts changed, a turn
// ended), for whoever listens to the hub (the notifier): `attention` with the window's key, public project id and
// name, and `window-removed` with the key. It needs no phone, and no phone is told.
describe("attention", () => {
  const done = (session = "s1") => ({ kind: "done", session, title: "Fix the flaky test", isError: false, durationMs: 1200, text: "All tests pass." });
  const waiting = (session = "s1", requestId = "r-1") => ({ kind: "waiting", session, requestId, title: "Fix the flaky test", prompt: { kind: "tool", toolName: "Bash", text: "npm test" } });
  const open = (session = "s1", requestIds: string[] = ["r-1"]) => ({ kind: "open", session, requestIds });

  /** The hub's `attention` and `window-removed` events, in order. */
  function listen(hub: any) {
    const attention: Json[] = [];
    const removed: string[] = [];
    hub.on("attention", (event: Json) => attention.push(event));
    hub.on("window-removed", (key: string) => removed.push(key));
    return { attention, removed };
  }

  /** A peer window of the hub: the link, and its project sent. */
  async function peerWindow(ctx: Ctx, id = "bbbbbbbbbbbb", name = "peer-window") {
    const link = await connectPeer({ port: ctx.port, secret: ctx.state().secret });
    closers.push(() => link.close());
    link.setHandler(() => undefined);
    link.notify("project", project(id, name));
    return link;
  }

  test("a window's attention event is emitted with the window's key, public project id and project name", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const w = fakeWindow(ctx.hub, { key: "w1", id: ID, name: "cce-patch" });
    const events = [waiting(), open(), done(), open("s1", []), open("s2", ["r-2", "r-3"])];
    for (const ev of events) w.handle.attention(ev);
    expect(attention).toEqual(events.map((ev) => ({ key: "w1", project: ID, projectName: "cce-patch", ev })));
    expect(attention[0].ev).toBe(events[0]); // the window's event as it is, not a copy
  });

  test("the project is the window's public id (with -2 when another window has the project's id), and follows the window", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const first = fakeWindow(ctx.hub, { key: "w1" });
    const second = fakeWindow(ctx.hub, { key: "w2" }); // the same project id: phones see it as `<id>-2`
    second.handle.attention(done());
    first.handle.attention(done());
    expect(attention.map((event) => [event.key, event.project])).toEqual([["w2", `${ID}-2`], ["w1", ID]]);

    second.handle.setProject(project("bbbbbbbbbbbb", "other")); // the folders changed: another project
    second.handle.attention(done());
    expect(attention.at(-1)).toMatchObject({ key: "w2", project: "bbbbbbbbbbbb", projectName: "other" });
  });

  test("a project name that is not text is an empty name", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const w = fakeWindow(ctx.hub, { id: null });
    w.handle.setProject({ ...project(ID), name: 42 });
    w.handle.attention(done());
    expect(attention).toEqual([{ key: "w1", project: ID, projectName: "", ev: done() }]);
  });

  test.each([
    ["not a record: null", null],
    ["not a record: a string", "done"],
    ["not a record: an array", [done()]],
    ["not a record: a number", 5],
    ["no kind", { session: "s1" }],
    ["an unknown kind", { ...done(), kind: "finished" }],
    ["a kind in another case", { ...done(), kind: "DONE" }],
    ["an empty kind", { ...done(), kind: "" }],
    ["no session", { kind: "done" }],
    ["an empty session", { ...done(), session: "" }],
    ["a session that is not text", { ...done(), session: 5 }],
    ["a session of 257 characters", { ...done(), session: "x".repeat(257) }],
    ["an open event without a session", { kind: "open", requestIds: [] }],
    ["a waiting event without a request id", { ...waiting(), requestId: undefined }],
    ["a waiting event with an empty request id", { ...waiting(), requestId: "" }],
    ["a waiting event with a request id that is not text", { ...waiting(), requestId: 7 }],
    ["a waiting event with a request id of 257 characters", { ...waiting(), requestId: "r".repeat(257) }],
  ] as Array<[string, unknown]>)("an event that is %s is dropped", async (_what, ev) => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const w = fakeWindow(ctx.hub);
    w.handle.attention(ev);
    expect(attention).toEqual([]);
    w.handle.attention(done()); // the window still works
    expect(attention).toHaveLength(1);
  });

  test("ids of 256 characters are fine, and an open or done event needs no request id", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const w = fakeWindow(ctx.hub);
    const long = "x".repeat(256);
    const events = [waiting(long, long), open(long, []), done(long)];
    for (const ev of events) w.handle.attention(ev);
    expect(attention.map((event) => event.ev)).toEqual(events);
  });

  test("a window without a project yet, or whose project has no usable id, is no source of events", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const w = fakeWindow(ctx.hub, { id: null });
    w.handle.attention(done());
    w.handle.setProject({ name: "no id" }); // refused: ignored with a warning
    w.handle.attention(done());
    expect(attention).toEqual([]);
    w.handle.setProject(project(ID));
    w.handle.attention(done());
    expect(attention).toHaveLength(1);
  });

  test("a removed window, a replaced one, and the windows of a closed hub are no source of events", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const gone = fakeWindow(ctx.hub, { key: "w1" });
    gone.handle.remove();
    gone.handle.attention(done());
    const old = fakeWindow(ctx.hub, { key: "w2", id: "bbbbbbbbbbbb" });
    const replacement = fakeWindow(ctx.hub, { key: "w2", id: "cccccccccccc" }); // the same key: replaces the first
    old.handle.attention(done());
    expect(attention).toEqual([]);
    replacement.handle.attention(done());
    expect(attention).toHaveLength(1);

    await ctx.hub.close();
    replacement.handle.attention(done());
    fakeWindow(ctx.hub, { key: "w3" }).handle.attention(done()); // a window added to a closed hub never was
    expect(attention).toHaveLength(1);
  });

  test("a window's removal is announced with its key, once, whether or not it sent a project", async () => {
    const ctx = await startHub();
    const { removed } = listen(ctx.hub);
    const w1 = fakeWindow(ctx.hub, { key: "w1" });
    fakeWindow(ctx.hub, { key: "w2", id: "bbbbbbbbbbbb" });
    w1.handle.remove();
    w1.handle.remove();
    expect(removed).toEqual(["w1"]);
    fakeWindow(ctx.hub, { key: "w3", id: null }).handle.remove();
    expect(removed).toEqual(["w1", "w3"]);
  });

  test("a second window with the same key replaces the first, which is announced as removed; close() announces every window", async () => {
    const ctx = await startHub();
    const { removed } = listen(ctx.hub);
    fakeWindow(ctx.hub, { key: "w1" });
    fakeWindow(ctx.hub, { key: "w1", id: "bbbbbbbbbbbb" });
    expect(removed).toEqual(["w1"]);
    fakeWindow(ctx.hub, { key: "w2", id: "cccccccccccc" });
    await ctx.hub.close();
    expect(removed.slice(1).sort()).toEqual(["w1", "w2"]);
    expect(removed).toHaveLength(3);
    fakeWindow(ctx.hub, { key: "w4" }).handle.remove(); // a window the closed hub never took
    expect(removed).toHaveLength(3);
  });

  test("a peer's attention events reach the same path, under the peer window's public id; its closing is announced with its key", async () => {
    const ctx = await startHub();
    const { attention, removed } = listen(ctx.hub);
    const link = await peerWindow(ctx);
    const events = [waiting(), open(), done()];
    for (const ev of events) link.notify("attention", ev);
    await waitFor(() => attention.length === 3, "the peer's events");
    expect(attention.map((event) => [event.project, event.projectName, event.ev])).toEqual(events.map((ev) => ["bbbbbbbbbbbb", "peer-window", ev]));
    const key = attention[0].key;
    expect(key).toEqual(expect.any(String));
    expect(new Set(attention.map((event) => event.key)).size).toBe(1);
    expect(removed).toEqual([]);
    link.close();
    await waitFor(() => removed.length === 1, "the peer's window to be removed");
    expect(removed).toEqual([key]);
  });

  test("a peer's attention event that is not well formed, or comes before the peer's project, is ignored", async () => {
    const ctx = await startHub();
    const { attention } = listen(ctx.hub);
    const link = await connectPeer({ port: ctx.port, secret: ctx.state().secret });
    closers.push(() => link.close());
    link.setHandler(() => undefined);
    link.notify("attention", done()); // before its project
    link.notify("project", project("bbbbbbbbbbbb", "peer-window"));
    for (const nonsense of [null, "done", [done()], { kind: "fly", session: "s1" }, { ...done(), session: 5 }, { ...waiting(), requestId: "" }]) link.notify("attention", nonsense);
    link.notify("attention", done("s-last"));
    await waitFor(() => attention.length >= 1, "the peer's valid event");
    expect(attention).toEqual([{ key: expect.any(String), project: "bbbbbbbbbbbb", projectName: "peer-window", ev: done("s-last") }]);
    expect(ctx.logs.filter((line) => line.startsWith("error"))).toEqual([]); // nothing failed: it was only not an event
  });

  test("a listener that throws is logged, and reaches neither the window nor the peer link", async () => {
    const ctx = await startHub();
    ctx.hub.on("attention", () => {
      throw new Error("listener broke");
    });
    ctx.hub.on("window-removed", () => {
      throw new Error("listener broke too");
    });
    const w = fakeWindow(ctx.hub, { key: "w1" });
    expect(() => w.handle.attention(done())).not.toThrow();
    expect(ctx.logs).toContain("error a listener of 'attention' failed: listener broke");
    const link = await peerWindow(ctx);
    link.notify("attention", done());
    await waitFor(() => ctx.logs.filter((line) => line === "error a listener of 'attention' failed: listener broke").length === 2, "the peer event's failure to be logged");
    expect(ctx.logs.some((line) => line.includes("a peer event failed"))).toBe(false); // the hub took it: the peer link never saw it
    expect(() => w.handle.remove()).not.toThrow();
    expect(ctx.logs).toContain("error a listener of 'window-removed' failed: listener broke too");
    link.notify("attention", done("s2")); // the link carries on
    await waitFor(() => ctx.logs.filter((line) => line === "error a listener of 'attention' failed: listener broke").length === 3, "the next peer event");
  });

  test("attention events are no phone frames: a phone that watches the session hears nothing of them", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await nextFrame(phone, "snapshot");
    for (const ev of [waiting(), open(), done()]) w.handle.attention(ev);
    await roundTrip(phone);
    await phone.expectQuiet();
  });
});

// ---- push ---------------------------------------------------------------------------------------

// The new protocol frames and the notifier behind them: push_set/push_clear/push_test, welcome.push,
// the looking rule, the devices view, and one real push to a local HTTP server standing in for the
// push service. The notifier's send is a fake everywhere but the end-to-end test.

describe("push", () => {
  const waiting = (session = "s1", requestId = "r-1") => ({
    kind: "waiting",
    session,
    requestId,
    title: "Fix the flaky test",
    prompt: { kind: "tool", toolName: "Bash", text: "npm test" },
  });

  function fakePushSender() {
    const sends: Json[] = [];
    const send = async (push: Json) => {
      sends.push(push);
      return { ok: true, status: 201, gone: false };
    };
    return { sends, send };
  }

  test("push_set, push_clear and push_test are acked", async () => {
    const sender = fakePushSender();
    const ctx = await startHub({ hub: { notifier: { send: sender.send, idleSeconds: async () => 9999, limits: { graceMs: 0 } } } });
    const { phone } = await pairedPhone(ctx);
    const subscriber = makeSubscriber();
    const vapid = makeVapid();

    phone.send(pushFrame(subscriber, vapid, { id: "p1" }));
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    phone.send({ t: "push_test", id: "p2" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p2", ok: true });
    expect(sender.sends).toHaveLength(1);
    phone.send({ t: "push_clear", id: "p3" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p3", ok: true });
    phone.send({ t: "push_test", id: "p4" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p4", ok: false, error: "push_off" });

    phone.send(pushFrame(subscriber, vapid)); // no id
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "bad_request", message: expect.any(String) });
  });

  test("a push_test that could not reach the service carries its reason", async () => {
    const sender = { send: async () => ({ ok: false, status: 0, gone: false, reason: "timeout" }) };
    const ctx = await startHub({ hub: { notifier: { send: sender.send, idleSeconds: async () => 9999, limits: { graceMs: 0 } } } });
    const { phone } = await pairedPhone(ctx);
    phone.send(pushFrame(makeSubscriber(), makeVapid(), { id: "p1" }));
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    phone.send({ t: "push_test", id: "p2" });
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p2", ok: false, error: "push_failed", status: 0, reason: "timeout" });
  });

  test("welcome tells whether this Mac holds a subscription", async () => {
    const sender = fakePushSender();
    const ctx = await startHub({ hub: { notifier: { send: sender.send, idleSeconds: async () => 9999, limits: { graceMs: 0 } } } });
    const creds = await pairPhone(ctx);
    const first = await connectPhone(ctx, creds);
    expect(first.welcome.push).toBe(false);
    first.phone.send(pushFrame(makeSubscriber(), makeVapid(), { id: "p1" }));
    expect(await nextFrame(first.phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    const second = await connectPhone(ctx, creds);
    expect(second.welcome.push).toBe(true);
  });

  test("a looking phone gets no push, a hidden one does", async () => {
    const sender = fakePushSender();
    const ctx = await startHub({ hub: { notifier: { send: sender.send, idleSeconds: async () => 9999, limits: { graceMs: 0 } } } });
    const { phone } = await pairedPhone(ctx);
    phone.send(pushFrame(makeSubscriber(), makeVapid(), { id: "p1" }));
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    const w = fakeWindow(ctx.hub);
    w.handle.attention(waiting("s1", "r-1"));
    await sleep(40);
    expect(sender.sends).toHaveLength(0); // the phone is visible and just sent frames
    phone.send({ t: "visibility", visible: false });
    await roundTrip(phone);
    w.handle.attention(waiting("s1", "r-2"));
    await sleep(40);
    expect(sender.sends).toHaveLength(1);
  });

  test("a phone that went silent counts as not looking", async () => {
    const sender = fakePushSender();
    const ctx = await startHub({
      hub: { notifier: { send: sender.send, idleSeconds: async () => 9999, limits: { graceMs: 0 } }, limits: { lookFreshMs: 50 } },
    });
    const { phone } = await pairedPhone(ctx);
    phone.send(pushFrame(makeSubscriber(), makeVapid(), { id: "p1" }));
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    await sleep(80); // no frames: past lookFreshMs
    const w = fakeWindow(ctx.hub);
    w.handle.attention(waiting());
    await sleep(40);
    expect(sender.sends).toHaveLength(1);
  });

  test("devices show push without the keys", async () => {
    const sender = fakePushSender();
    const ctx = await startHub({ hub: { notifier: { send: sender.send, idleSeconds: async () => 9999, limits: { graceMs: 0 } } } });
    const { creds, phone } = await pairedPhone(ctx);
    phone.send(pushFrame(makeSubscriber(), makeVapid(), { id: "p1" }));
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    const devices = ctx.hub.devices();
    expect(devices).toEqual([{ id: creds.deviceId, name: "iPhone", origin: APP_ORIGIN, createdAt: T0, lastSeenAt: T0, push: true }]);
    const json = JSON.stringify(devices);
    expect(json).not.toContain(APPLE);
    expect(json).not.toContain('"d"');
  });

  test("a push reaches the push service end to end", async () => {
    const subscriber = makeSubscriber();
    const vapid = makeVapid();
    let received: { headers: Json; body: Buffer } | null = null;
    let resolveReceived: () => void = () => {};
    const receivedPush = new Promise<void>((resolve) => (resolveReceived = resolve));
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        received = { headers: req.headers, body: Buffer.concat(chunks) };
        res.statusCode = 201;
        res.end();
        resolveReceived();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const port = (server.address() as net.AddressInfo).port;
    const endpoint = `http://127.0.0.1:${port}/push/abc`;

    const ctx = await startHub({
      hub: {
        notifier: {
          sendOptions: { request: http.request, allowEndpoint: () => true },
          idleSeconds: async () => 9999,
          limits: { graceMs: 0 },
        },
      },
    });
    const w = fakeWindow(ctx.hub);
    const { creds, phone } = await pairedPhone(ctx);
    phone.send(pushFrame(subscriber, vapid, { id: "p1", subscription: { endpoint, keys: subscriber.keys } }));
    expect(await nextFrame(phone, "ack")).toEqual({ t: "ack", id: "p1", ok: true });
    phone.terminate();
    await phone.closed();

    w.handle.attention(waiting());
    await withTimeout(receivedPush, "the push to reach the local server");
    expect(received).not.toBeNull();
    const payload = JSON.parse(decryptPush(received!.body, subscriber).toString("utf8"));
    expect(payload).toEqual({
      v: 1,
      kind: "waiting",
      title: "cce-patch",
      body: "Fix the flaky test\nAllow Bash: npm test?",
      tag: `${creds.deviceId}:${ID}:s1`,
      url: `/?mac=${creds.deviceId}&project=${ID}&session=s1`,
      mac: creds.deviceId,
      badge: 1,
    });
  });
});

// ---- limits -------------------------------------------------------------------------------------

describe("limits", () => {
  test("a phone with more than 4 MB waiting in its socket is closed with 1013", async () => {
    // A Bun client reads whatever arrives (its pause() does not stop the socket), so it cannot be
    // slow: the socket's count is set here instead. ws.test.ts shows that bufferedAmount is that count.
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await nextFrame(phone, "snapshot");
    const real = Object.getOwnPropertyDescriptor(WsConnection.prototype, "bufferedAmount")!;
    let queued = 4 * 1024 * 1024; // the limit itself is fine
    Object.defineProperty(WsConnection.prototype, "bufferedAmount", { configurable: true, get: () => queued });
    try {
      w.handle.sessionEvent("s1", { t: "msg", message: message("m2") });
      expect((await nextFrame(phone, "msg")).message.uuid).toBe("m2");
      expect(ctx.hub.phoneCount()).toBe(1);
      queued += 1;
      w.handle.sessionEvent("s1", { t: "msg", message: message("m3") }); // not sent: the phone is closed instead
      expect((await phone.closed()).code).toBe(1013);
      expect(phone.frames.pending).toBe(0);
      expect(ctx.hub.phoneCount()).toBe(0);
    } finally {
      Object.defineProperty(WsConnection.prototype, "bufferedAmount", real);
    }
  });

  test("one frame bigger than the limit is sent; only a backlog past it closes the phone", async () => {
    const ctx = await startHub({ hub: { limits: { maxQueuedBytes: 64 * 1024 } } });
    fakeWindow(ctx.hub, { handlers: { snapshot: (args) => snapshotOf(args.session, [message("big", "x".repeat(200_000))]) } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    expect((await nextFrame(phone, "snapshot")).messages[0].content[0].text).toHaveLength(200_000);
    await roundTrip(phone); // drained by now: the phone is still there
    expect(ctx.hub.phoneCount()).toBe(1);
  });

  test("limits.maxQueuedBytes sets that threshold", async () => {
    const ctx = await startHub({ hub: { limits: { maxQueuedBytes: 1000 } } });
    const w = fakeWindow(ctx.hub);
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await nextFrame(phone, "snapshot");
    const real = Object.getOwnPropertyDescriptor(WsConnection.prototype, "bufferedAmount")!;
    Object.defineProperty(WsConnection.prototype, "bufferedAmount", { configurable: true, get: () => 1001 });
    try {
      w.handle.sessionEvent("s1", { t: "msg", message: message("m2") });
      expect((await phone.closed()).code).toBe(1013);
    } finally {
      Object.defineProperty(WsConnection.prototype, "bufferedAmount", real);
    }
  });

  test("events held back during a slow snapshot are bounded: past maxPendingFrames the phone is closed with 1013", async () => {
    const ctx = await startHub({ hub: { limits: { maxPendingFrames: 3 } } });
    const gate = deferred<Json>();
    const w = fakeWindow(ctx.hub, { handlers: { snapshot: () => gate.promise } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await w.calls.next("the snapshot call");
    for (let i = 0; i < 4; i++) w.handle.sessionEvent("s1", { t: "msg", message: message(`m${i}`) });
    expect((await phone.closed()).code).toBe(1013);
    gate.resolve(snapshotOf("s1")); // nobody to send it to any more
    await sleep(20);
    expect(ctx.hub.phoneCount()).toBe(0);
  });

  test("past maxPendingBytes of held-back events the phone is closed with 1013", async () => {
    const ctx = await startHub({ hub: { limits: { maxPendingBytes: 1000 } } });
    const gate = deferred<Json>();
    const w = fakeWindow(ctx.hub, { handlers: { snapshot: () => gate.promise } });
    const { phone } = await pairedPhone(ctx);
    phone.send({ t: "sub", project: ID, session: "s1" });
    await w.calls.next("the snapshot call");
    w.handle.sessionEvent("s1", { t: "msg", message: message("m1", "x".repeat(500)) });
    await sleep(30);
    expect(phone.isClosed).toBe(false);
    w.handle.sessionEvent("s1", { t: "msg", message: message("m2", "x".repeat(500)) });
    expect((await phone.closed()).code).toBe(1013);
    gate.resolve(snapshotOf("s1"));
  });

  test("past maxPeers peer links the next one gets 503", async () => {
    const ctx = await startHub({ hub: { limits: { maxPeers: 1 } } });
    const secret = ctx.state().secret;
    const first = await connectPeer({ port: ctx.port, secret });
    closers.push(() => first.close());
    first.setHandler(() => undefined);
    await waitFor(() => ctx.hub.peerCount() === 1, "the first peer");
    expect(statusOf(await rawRequest(ctx.port, peerUpgrade()))).toBe("HTTP/1.1 503 Service Unavailable");
    expect(ctx.hub.info().windows).toBe(1);
  });

  test("links that have not proved themselves yet count against maxPeers", async () => {
    const ctx = await startHub({ hub: { limits: { maxPeers: 2 } } });
    await rawPeer(ctx.port, ctx.state().secret, null);
    await rawPeer(ctx.port, ctx.state().secret, null);
    expect(statusOf(await rawRequest(ctx.port, peerUpgrade()))).toBe("HTTP/1.1 503 Service Unavailable");
  });

  test("a phone that sends nothing for idleTimeoutMs is closed with 4408; one that pings stays", async () => {
    const ctx = await startHub({ hub: { idleTimeoutMs: 300 } });
    const creds = await pairPhone(ctx);
    const quiet = (await connectPhone(ctx, creds)).phone;
    const busy = (await connectPhone(ctx, creds)).phone;
    const pinger = setInterval(() => busy.send({ t: "ping" }), 60);
    try {
      expect((await withTimeout(quiet.closeEvent, "the quiet phone to be closed", 2000)).code).toBe(4408);
      await sleep(200);
      expect(busy.isClosed).toBe(false);
    } finally {
      clearInterval(pinger);
    }
  });

  test("a device keeps at most maxSocketsPerDevice sockets: a new hello closes its oldest (too_many_connections, 4409)", async () => {
    const ctx = await startHub({ hub: { limits: { maxSocketsPerDevice: 2 } } });
    const creds = await pairPhone(ctx);
    const first = (await connectPhone(ctx, creds)).phone;
    const second = (await connectPhone(ctx, creds)).phone;
    const third = (await connectPhone(ctx, creds)).phone;
    expect(await nextFrame(first, "error")).toEqual({ t: "error", code: "too_many_connections", message: expect.any(String) });
    expect((await first.closed()).code).toBe(4409);
    await waitFor(() => ctx.hub.phoneCount() === 2, "two phones");
    expect(second.isClosed).toBe(false);
    expect(third.isClosed).toBe(false);
  });
});

// ---- closing ------------------------------------------------------------------------------------

describe("close", () => {
  test("close() closes the phones with 1001, switches the windows off and frees the port", async () => {
    // A raw client: Bun's WebSocket reports a 1001 from the server as 1000.
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub);
    const creds = await pairPhone(ctx);
    const hello = clientFrame(OP.text, JSON.stringify({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token }));
    const request = Buffer.from(upgradeRequest({ "Tailscale-User-Login": OWNER, Origin: APP_ORIGIN }), "latin1");
    const raw = await RawConn.open(ctx.port, Buffer.concat([request, hello]));
    expect(JSON.parse((await raw.frame()).payload.toString("utf8")).t).toBe("welcome");
    expect(JSON.parse((await raw.frame()).payload.toString("utf8")).t).toBe("projects");
    expect(JSON.parse((await raw.frame()).payload.toString("utf8")).t).toBe("usage");
    const closing = ctx.hub.close();
    const close = await raw.frame();
    expect(close.opcode).toBe(OP.close);
    expect(close.payload.readUInt16BE(0)).toBe(1001);
    raw.send(clientFrame(OP.close, close.payload));
    await withTimeout(closing, "close() to finish");
    await withTimeout(raw.closed, "the connection to close");
    expect(w.actives()).toEqual([true, false]);
    const next = new Hub({ state: () => loadState(ctx.env), updateState: (fn: Json) => updateState(fn, ctx.env), tailscale: ctx.tailscale, macName: () => MAC_NAME });
    hubs.push(next);
    await next.listen(ctx.port);
  });

  test("change is emitted for what the Connection tab shows; close once, after close() is done", async () => {
    const ctx = await startHub();
    await waitFor(() => ctx.hub.info().pairing === null && ctx.tailscale.calls > 0, "the first status read");
    await sleep(20);
    let changes = 0;
    const closes: boolean[] = [];
    ctx.hub.on("change", () => changes++);
    ctx.hub.on("close", () => closes.push(ctx.hub.server.listening));
    /** Runs `action` and returns how many change events it caused. */
    const counted = async (action: () => unknown) => {
      const before = changes;
      await action();
      return changes - before;
    };
    let w: ReturnType<typeof fakeWindow> | undefined;
    expect(await counted(() => (w = fakeWindow(ctx.hub)))).toBeGreaterThan(0);
    expect(await counted(() => ctx.hub.newPairingCode())).toBeGreaterThan(0);
    let creds: Creds | undefined;
    expect(await counted(async () => (creds = await pairPhone(ctx)))).toBeGreaterThan(0);
    expect(await counted(() => connectPhone(ctx, creds!))).toBeGreaterThan(0);
    expect(await counted(() => ctx.hub.setAppUrl("https://app.example.com"))).toBeGreaterThan(0);
    expect(await counted(() => w!.handle.remove())).toBeGreaterThan(0);
    expect(await counted(() => ctx.hub.removeDevice(creds!.deviceId))).toBeGreaterThan(0);
    expect(closes).toEqual([]);
    await ctx.hub.close();
    await ctx.hub.close();
    expect(closes).toEqual([false]);
  });

  test("close({reason: 'disabled'}) tells the phones past their hello that remote access was turned off, then closes them", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const waiting = await Phone.open(ctx.port); // not past its hello: an error now would read as "unauthorized"
    const closing = ctx.hub.close({ reason: "disabled" });
    expect(await nextFrame(phone, "error")).toEqual({ t: "error", code: "disabled", message: "Remote access was turned off on the Mac" });
    await phone.closed();
    await waiting.closed();
    expect(waiting.frames.pending).toBe(0);
    await withTimeout(closing, "close() to finish");
  });

  test("close() twice is fine, and a closed hub does not listen again", async () => {
    const ctx = await startHub();
    await ctx.hub.close();
    await ctx.hub.close();
    await expect(ctx.hub.listen(0)).rejects.toThrow("closed");
  });
});

// ---- the production runtime ---------------------------------------------------------------------

// ---- usage: Claude Code's usage meter, from the windows to the phones ---------------------------------

describe("usage", () => {
  const NOW_S = Math.floor(T0 / 1000); // the hub's clock in these tests
  const R = NOW_S + 3_600; // an hour ahead: inside the hub's "now + 30 days"
  const reading = (at?: number, u = 0.42, resetsAt: number = R) => ({ supported: true, fiveHour: { utilization: u, resetsAt }, ...(at !== undefined && { at }) });

  /** The next usage frame that passes `check`; project lists and earlier usage frames are skipped. */
  async function usageWhere(phone: Phone, check: (frame: Json) => boolean): Promise<Json> {
    for (;;) {
      const frame = await nextFrame(phone, "usage");
      if (check(frame)) return frame;
    }
  }

  test("the welcome carries the Mac's clock, and a usage frame follows projects", async () => {
    const ctx = await startHub();
    const creds = await pairPhone(ctx);
    const phone = await Phone.open(ctx.port, { origin: creds.origin });
    phone.send({ t: "hello", v: 1, deviceId: creds.deviceId, token: creds.token });
    expect(await phone.next("welcome")).toMatchObject({ t: "welcome", now: T0 });
    expect((await phone.next("projects")).t).toBe("projects");
    expect(await phone.next("usage")).toEqual({ t: "usage", state: "unsupported" });
  });

  test("a window's reading becomes the frame, converted", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const { handle } = fakeWindow(ctx.hub);
    handle.usage(reading(1_000));
    expect(await nextFrame(phone, "usage")).toEqual({ t: "usage", state: "ok", fiveHour: { percent: 42, resetsAt: R * 1000 }, at: 1_000 });
    handle.usage(reading(2_000, 0.4567));
    expect((await nextFrame(phone, "usage")).fiveHour.percent).toBe(45.7);
  });

  test("the newest reading wins, and one without at counts as oldest", async () => {
    const ctx = await startHub();
    const w1 = fakeWindow(ctx.hub, { key: "w1", id: "p1" });
    const w2 = fakeWindow(ctx.hub, { key: "w2", id: "p2" });
    w1.handle.usage(reading(5_000, 0.1));
    w2.handle.usage(reading(undefined, 0.9));
    expect(ctx.hub.usageFrame().fiveHour.percent).toBe(10);
    w2.handle.usage(reading(6_000, 0.9));
    expect(ctx.hub.usageFrame().fiveHour.percent).toBe(90);
  });

  test("states: none when supported without numbers, unsupported without support", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const { handle } = fakeWindow(ctx.hub);
    handle.usage({ supported: true });
    expect(await nextFrame(phone, "usage")).toEqual({ t: "usage", state: "none" });
    handle.usage({ supported: false });
    expect(await nextFrame(phone, "usage")).toEqual({ t: "usage", state: "unsupported" });
    handle.usage(reading(1_000));
    expect((await nextFrame(phone, "usage")).state).toBe("ok");
    handle.remove();
    expect(await nextFrame(phone, "usage")).toEqual({ t: "usage", state: "unsupported" });
  });

  test("validation: impossible numbers are dropped field by field, a past reset is kept", async () => {
    const ctx = await startHub();
    const { handle } = fakeWindow(ctx.hub);
    const frameOf = (value: unknown) => {
      handle.usage(value);
      return ctx.hub.usageFrame();
    };
    const week = { utilization: 0.1 };
    expect(frameOf({ supported: true, fiveHour: { utilization: 11 }, week, at: 1 })).toEqual({ t: "usage", state: "ok", week: { percent: 10 }, at: 1 });
    expect(frameOf({ supported: true, fiveHour: { utilization: "x" }, week, at: 2 })).toEqual({ t: "usage", state: "ok", week: { percent: 10 }, at: 2 });
    expect(frameOf({ supported: true, fiveHour: { utilization: 0.5, resetsAt: 1_600_000_000 }, at: 3 }).fiveHour).toEqual({ percent: 50 });
    expect(frameOf({ supported: true, fiveHour: { utilization: 0.5, resetsAt: NOW_S + 31 * 86_400 }, at: 4 }).fiveHour).toEqual({ percent: 50 });
    expect(frameOf({ supported: true, fiveHour: { utilization: 0.5, resetsAt: NOW_S - 86_400 }, at: 5 }).fiveHour).toEqual({ percent: 50, resetsAt: (NOW_S - 86_400) * 1000 });
    expect(frameOf({ supported: true, fiveHour: { utilization: 0.5 }, at: T0 + 61_000 })).toEqual({ t: "usage", state: "ok", fiveHour: { percent: 50 } });
    expect(frameOf("not a reading")).toEqual({ t: "usage", state: "ok", fiveHour: { percent: 50 } }); // ignored: the last reading stays
  });

  test("the frame names the account of the reading its numbers come from, never another window's", async () => {
    const ctx = await startHub();
    const w1 = fakeWindow(ctx.hub, { key: "w1", id: "p1" });
    const w2 = fakeWindow(ctx.hub, { key: "w2", id: "p2" });
    w1.handle.usage({ ...reading(5_000, 0.1), account: "ada@example.com" });
    w2.handle.usage({ ...reading(undefined, 0.9), account: "bob@example.com" });
    expect(ctx.hub.usageFrame()).toEqual({ t: "usage", state: "ok", fiveHour: { percent: 10, resetsAt: R * 1000 }, at: 5_000, account: "ada@example.com" });
    w2.handle.usage({ ...reading(6_000, 0.9), account: "bob@example.com" });
    expect(ctx.hub.usageFrame()).toMatchObject({ fiveHour: { percent: 90 }, account: "bob@example.com" });
    w2.handle.usage(reading(7_000, 0.9)); // its Claude Code doesn't know the account (yet): w1's could be the old one
    expect(ctx.hub.usageFrame()).not.toHaveProperty("account");
  });

  test("without numbers, the frame names the first account a window knows; unsupported names none", async () => {
    const ctx = await startHub();
    const w1 = fakeWindow(ctx.hub, { key: "w1", id: "p1" });
    const w2 = fakeWindow(ctx.hub, { key: "w2", id: "p2" });
    w1.handle.usage({ supported: true });
    w2.handle.usage({ supported: true, account: "ada@example.com" });
    expect(ctx.hub.usageFrame()).toEqual({ t: "usage", state: "none", account: "ada@example.com" });
    w1.handle.usage({ supported: false, account: "ada@example.com" });
    w2.handle.usage({ supported: false, account: "ada@example.com" });
    expect(ctx.hub.usageFrame()).toEqual({ t: "usage", state: "unsupported" });
  });

  test("a change of account alone reaches the phones", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const { handle } = fakeWindow(ctx.hub);
    handle.usage({ ...reading(1_000), account: "ada@example.com" });
    expect((await nextFrame(phone, "usage")).account).toBe("ada@example.com");
    handle.usage({ ...reading(1_000), account: "bob@example.com" });
    expect((await nextFrame(phone, "usage")).account).toBe("bob@example.com");
  });

  test("validation: an account that isn't a usable string is left out", async () => {
    const ctx = await startHub();
    const { handle } = fakeWindow(ctx.hub);
    const accountOf = (account: unknown) => {
      handle.usage({ supported: true, account });
      return ctx.hub.usageFrame().account;
    };
    expect(accountOf("ada@example.com")).toBe("ada@example.com");
    expect(accountOf(42)).toBeUndefined();
    expect(accountOf("")).toBeUndefined();
    expect(accountOf("ada\u0007@example.com")).toBeUndefined(); // a control character
    expect(accountOf("ada\u0085@example.com")).toBeUndefined(); // a C1 control character
    expect(accountOf("ada‮@example.com")).toBeUndefined(); // a bidi override: it could show another address
    expect(accountOf("ada​@example.com")).toBeUndefined(); // a zero-width space
    const longest = `${"a".repeat(242)}@example.com`; // 254 characters: the longest an email address can be
    expect(accountOf(longest)).toBe(longest);
    expect(accountOf(`a${longest}`)).toBeUndefined();
  });

  test("an unchanged reading sends nothing", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const { handle } = fakeWindow(ctx.hub);
    handle.usage(reading(1_000));
    await nextFrame(phone, "usage");
    handle.usage(reading(1_000));
    await phone.expectQuiet();
  });

  test("usage_refresh: the windows are asked newest first until one refreshed, and the asker gets the frame", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const w1 = fakeWindow(ctx.hub, { key: "w1", id: "p1", handlers: { usage: () => ({ refreshed: false, reason: "no_session", reading: reading(2_000) }) } });
    const w2 = fakeWindow(ctx.hub, { key: "w2", id: "p2", handlers: { usage: () => ({ refreshed: true, reading: reading(9_000, 0.5) }) } });
    const w3 = fakeWindow(ctx.hub, { key: "w3", id: "p3", handlers: { usage: () => ({ refreshed: true, reading: reading(9_500, 0.7) }) } });
    w1.handle.usage(reading(2_000));
    w2.handle.usage(reading(3_000));
    w3.handle.usage(reading(1_000));
    phone.send({ t: "usage_refresh" });
    expect(await usageWhere(phone, (frame) => frame.fiveHour?.percent === 50)).toMatchObject({ state: "ok", at: 9_000 });
    expect((await w2.calls.next()).method).toBe("usage");
    expect([w1.calls.pending, w3.calls.pending]).toEqual([0, 0]);
  });

  test("an older window's unknown_method doesn't stop the refresh", async () => {
    const ctx = await startHub();
    const { phone } = await pairedPhone(ctx);
    const order: string[] = [];
    const old = fakeWindow(ctx.hub, {
      key: "w1",
      id: "p1",
      handlers: {
        usage: () => {
          order.push("w1");
          throw Object.assign(new Error("unknown_method"), { code: "unknown_method" });
        },
      },
    });
    const fresh = fakeWindow(ctx.hub, {
      key: "w2",
      id: "p2",
      handlers: {
        usage: () => {
          order.push("w2");
          return { refreshed: true, reading: reading(9_000, 0.5) };
        },
      },
    });
    old.handle.usage(reading(5_000));
    fresh.handle.usage(reading(4_000));
    phone.send({ t: "usage_refresh" });
    expect((await usageWhere(phone, (frame) => frame.fiveHour?.percent === 50)).at).toBe(9_000);
    expect(order).toEqual(["w1", "w2"]);
  });

  test("a refresh in flight is joined, and within usageRefreshMinMs the hub only answers", async () => {
    const ctx = await startHub({ hub: { limits: { usageRefreshMinMs: 60_000 } } });
    const one = await pairedPhone(ctx);
    const two = await pairedPhone(ctx);
    const gate = deferred<Json>();
    const w = fakeWindow(ctx.hub, { handlers: { usage: () => gate.promise } });
    w.handle.usage(reading(1_000));
    await nextFrame(one.phone, "usage");
    await nextFrame(two.phone, "usage");
    one.phone.send({ t: "usage_refresh" });
    two.phone.send({ t: "usage_refresh" });
    await roundTrip(one.phone);
    await roundTrip(two.phone);
    expect((await w.calls.next()).method).toBe("usage");
    expect(w.calls.pending).toBe(0);
    gate.resolve({ refreshed: true, reading: reading(2_000, 0.6) });
    const twoFrames = async (phone: Phone) => [await nextFrame(phone, "usage"), await nextFrame(phone, "usage")].map((frame) => frame.at);
    expect(await twoFrames(one.phone)).toEqual([2_000, 2_000]); // the change, then the answer
    expect(await twoFrames(two.phone)).toEqual([2_000, 2_000]);
    one.phone.send({ t: "usage_refresh" });
    expect((await nextFrame(one.phone, "usage")).at).toBe(2_000); // answered at once, without asking the window
    expect(w.calls.pending).toBe(0);
  });

  test("a phone that never asks gets no refresh", async () => {
    const ctx = await startHub();
    const w = fakeWindow(ctx.hub, { handlers: { usage: () => ({ refreshed: true, reading: reading(1) }) } });
    w.handle.usage(reading(1_000));
    const { phone } = await pairedPhone(ctx);
    await roundTrip(phone);
    expect(w.calls.pending).toBe(0);
  });
});

describe("under real Node", () => {
  test.skipIf(!Bun.which("node"))(
    "a phone pairs, says hello and gets a snapshot (remote-bridge/test/hub-smoke.js)",
    async () => {
      const proc = Bun.spawn(["node", path.join(import.meta.dir, "hub-smoke.js")], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).toContain("hub smoke: ok");
    },
    30_000,
  );
});
