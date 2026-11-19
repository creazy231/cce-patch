// Test support for the transport modules (ws.js, peer-link.js); not a test file itself.
//
// Bun 1.3 gives a node:http 'upgrade' listener a socket that neither sends nor receives, so these
// tests accept connections on node:net: `listenUpgrade` reads the request head the way node:http
// does and hands `(req, socket, head)` to the code under test, which is all the extension host's
// http server hands it too. `RawConn` is a bare TCP client for frame-level and line-level checks.
import { EventEmitter } from "node:events";
import net from "node:net";

export const OP = { cont: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Fails a test with a clear message instead of hanging it. */
export function withTimeout<T>(promise: Promise<T>, what: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export interface Queue<T> {
  push(item: T): void;
  /** Resolves with the oldest item, waiting for one if none is queued. */
  next(what?: string): Promise<T>;
  /** Items pushed but not taken yet. */
  readonly pending: number;
}

export function queue<T>(): Queue<T> {
  const items: T[] = [];
  const waiters: Array<(item: T) => void> = [];
  return {
    push(item: T) {
      const waiter = waiters.shift();
      if (waiter) waiter(item);
      else items.push(item);
    },
    next(what = "the next item"): Promise<T> {
      if (items.length) return Promise.resolve(items.shift() as T);
      return withTimeout(new Promise<T>((resolve) => waiters.push(resolve)), what);
    },
    get pending() {
      return items.length;
    },
  };
}

export interface UpgradeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

/** The request line and headers, parsed like node:http's IncomingMessage (lower-case names, repeated names joined). */
export function parseRequestHead(text: string): UpgradeRequest {
  const [requestLine, ...lines] = text.split("\r\n");
  const [method, url] = requestLine.split(" ");
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    headers[name] = name in headers ? `${headers[name]}, ${value}` : value;
  }
  return { method, url, headers };
}

export interface UpgradeServer {
  port: number;
  close(): Promise<void>;
}

/** A 127.0.0.1 TCP server on a free port that gives every connection's request to `onUpgrade`, in the same call that sees the head. */
export async function listenUpgrade(
  onUpgrade: (req: UpgradeRequest, socket: net.Socket, head: Buffer) => void,
): Promise<UpgradeServer> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end === -1) return;
      socket.off("data", onData);
      onUpgrade(parseRequestHead(buffered.subarray(0, end).toString("latin1")), socket, buffered.subarray(end + 4));
    };
    socket.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

const rawSockets = new Set<net.Socket>();

/** Destroys every socket a test opened with `RawConn` or `rawRequest`; call it from afterEach. */
export function destroyRawSockets() {
  for (const socket of rawSockets) socket.destroy();
  rawSockets.clear();
}

async function connectRaw(port: number): Promise<net.Socket> {
  const socket = net.connect(port, "127.0.0.1");
  rawSockets.add(socket);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("error", reject);
    }),
    "the TCP connection",
  );
  return socket;
}

/** Sends request text and returns everything the server answers until it closes the connection. */
export async function rawRequest(port: number, text: string): Promise<string> {
  const socket = await connectRaw(port);
  const chunks: Buffer[] = [];
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  socket.on("data", (chunk: Buffer) => chunks.push(chunk));
  socket.on("error", () => {});
  socket.write(text);
  await withTimeout(closed, "the server to close the connection");
  return Buffer.concat(chunks).toString("latin1");
}

export interface Frame {
  fin: boolean;
  rsv: number;
  opcode: number;
  masked: boolean;
  payload: Buffer;
}

/** A TCP client that sends whatever bytes a test wants and reads the server's answer as an HTTP head, then frames or lines. */
export class RawConn {
  /** The response's status line and headers, once complete. */
  head = "";
  /** Received bytes after the head that no `frame()` or `line()` has consumed yet. */
  rest: Buffer = Buffer.alloc(0);
  isClosed = false;
  readonly closed: Promise<void>;
  private checks = new Set<() => void>();

  private constructor(readonly socket: net.Socket) {
    this.closed = new Promise((resolve) => {
      socket.once("close", () => {
        this.isClosed = true;
        this.notify();
        resolve();
      });
    });
    socket.on("error", () => {});
    socket.on("data", (chunk: Buffer) => {
      this.rest = Buffer.concat([this.rest, chunk]);
      if (!this.head) {
        const end = this.rest.indexOf("\r\n\r\n");
        if (end !== -1) {
          this.head = this.rest.subarray(0, end).toString("latin1");
          this.rest = this.rest.subarray(end + 4);
        }
      }
      this.notify();
    });
  }

  /** Connects, writes `request` (HTTP text, optionally followed by raw bytes) and waits for the response head. */
  static async open(port: number, request: string | Buffer): Promise<RawConn> {
    const conn = new RawConn(await connectRaw(port));
    conn.socket.write(request);
    await conn.until("the response head", () => conn.head || undefined);
    return conn;
  }

  /** The value of a response header, by case-insensitive name. */
  header(name: string): string | undefined {
    const line = this.head.split("\r\n").find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
    return line?.slice(name.length + 1).trim();
  }

  send(bytes: Buffer | string) {
    this.socket.write(bytes);
  }

  /** Resolves with the first non-undefined `check()`, re-run on every change; rejects when the connection closes first. */
  until<T>(what: string, check: () => T | undefined, ms = 2000): Promise<T> {
    return withTimeout(
      new Promise<T>((resolve, reject) => {
        const run = () => {
          const value = check();
          if (value !== undefined) {
            this.checks.delete(run);
            resolve(value);
          } else if (this.isClosed) {
            this.checks.delete(run);
            reject(new Error(`connection closed while waiting for ${what}`));
          }
        };
        this.checks.add(run);
        run();
      }),
      what,
      ms,
    );
  }

  private notify() {
    for (const run of [...this.checks]) run();
  }

  private takeFrame(): Frame | undefined {
    const buf = this.rest;
    if (buf.length < 2) return undefined;
    const masked = (buf[1] & 0x80) !== 0;
    let length = buf[1] & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buf.length < 4) return undefined;
      length = buf.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buf.length < 10) return undefined;
      length = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    if (masked) offset += 4;
    if (buf.length < offset + length) return undefined;
    const frame: Frame = {
      fin: (buf[0] & 0x80) !== 0,
      rsv: (buf[0] & 0x70) >> 4,
      opcode: buf[0] & 0x0f,
      masked,
      payload: Buffer.from(buf.subarray(offset, offset + length)),
    };
    this.rest = buf.subarray(offset + length);
    return frame;
  }

  /** The next frame the server sent. */
  frame(): Promise<Frame> {
    return this.until("a frame", () => this.takeFrame());
  }

  /** The next newline-terminated line the server sent (without the newline). */
  line(): Promise<string> {
    return this.until("a line", () => {
      const newline = this.rest.indexOf(0x0a);
      if (newline === -1) return undefined;
      const text = this.rest.subarray(0, newline).toString("utf8");
      this.rest = this.rest.subarray(newline + 1);
      return text;
    });
  }
}

interface FrameOptions {
  fin?: boolean;
  mask?: boolean;
  rsv?: number;
}

/** The frame header up to the length field, without a mask key; lets a test declare a length it never sends. */
export function frameHead(opcode: number, length: number | bigint, { fin = true, mask = true, rsv = 0 }: FrameOptions = {}): Buffer {
  const first = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  const maskBit = mask ? 0x80 : 0;
  if (length < 126) return Buffer.from([first, maskBit | Number(length)]);
  if (length < 65536) {
    const head = Buffer.from([first, maskBit | 126, 0, 0]);
    head.writeUInt16BE(Number(length), 2);
    return head;
  }
  const head = Buffer.alloc(10);
  head[0] = first;
  head[1] = maskBit | 127;
  head.writeBigUInt64BE(BigInt(length), 2);
  return head;
}

const MASK_KEY = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

/** One client-to-server frame; masked unless a test says otherwise. */
export function clientFrame(opcode: number, payload: Buffer | string = "", options: FrameOptions = {}): Buffer {
  const body = Buffer.from(payload);
  const head = frameHead(opcode, body.length, options);
  if (options.mask === false) return Buffer.concat([head, body]);
  for (let i = 0; i < body.length; i++) body[i] ^= MASK_KEY[i & 3];
  return Buffer.concat([head, MASK_KEY, body]);
}

/**
 * A stand-in for a socket. A test emits 'data' by hand, or has bytes `receive`d the way the network
 * delivers them (held back while the socket is paused, like a real stream); what the code under test
 * writes is recorded.
 */
export function stubSocket(): any {
  const socket: any = new EventEmitter();
  socket.destroyed = false;
  socket.paused = false;
  socket.written = [] as Buffer[];
  socket.held = [] as Buffer[];
  socket.setNoDelay = () => {};
  socket.write = (data: Buffer | string) => {
    socket.written.push(Buffer.from(data));
    return true;
  };
  socket.end = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
  };
  socket.pause = () => {
    socket.paused = true;
    return socket;
  };
  socket.resume = () => {
    socket.paused = false;
    for (const chunk of socket.held.splice(0)) socket.emit("data", chunk);
    return socket;
  };
  socket.receive = (chunk: Buffer | string) => {
    if (socket.paused) socket.held.push(Buffer.from(chunk));
    else socket.emit("data", Buffer.from(chunk));
  };
  return socket;
}
