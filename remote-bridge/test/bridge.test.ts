import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { VERSION, attach, bridgeOf, detach } from "../bridge.js";
import { loadState } from "../lib/store.js";
import { WindowAgent } from "../lib/window-agent.js";
import { createFakeComms, createFakeProvider, createFakeVscode, type FakeComms } from "./fake-extension";
import { sleep } from "./support";

const FAKE_CLI = path.resolve(import.meta.dir, "fixtures/fake-tailscale.sh");
const DNS = "example-mac.tailnet-0000.ts.net";

// Safety net: code that forgets its `env` lands in a temp dir, on a port it cannot listen on, without a Tailscale CLI.
const GUARDED = ["CCE_REMOTE_HOME", "CCE_REMOTE_PORT", "CCE_REMOTE_TAILSCALE"] as const;
const outer: Partial<Record<(typeof GUARDED)[number], string | undefined>> = {};
let guardRoot = "";
beforeAll(() => {
  guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cce-bridge-guard-"));
  for (const name of GUARDED) outer[name] = process.env[name];
  process.env.CCE_REMOTE_HOME = guardRoot;
  process.env.CCE_REMOTE_PORT = "1";
  process.env.CCE_REMOTE_TAILSCALE = path.join(guardRoot, "no-tailscale");
});
afterAll(() => {
  for (const name of GUARDED) {
    if (outer[name] === undefined) delete process.env[name];
    else process.env[name] = outer[name];
  }
  fs.rmSync(guardRoot, { recursive: true, force: true });
});

const roots: string[] = [];
const providers: object[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) await detach(provider);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** The env of one extension host: its own state dir and port, and the fake Tailscale CLI with its own state. */
async function hostEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cce-bridge-"));
  roots.push(root);
  const port = await freePort();
  const tsState = path.join(root, "tailscale");
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    CCE_REMOTE_HOME: path.join(root, "home"),
    CCE_REMOTE_PORT: String(port),
    CCE_REMOTE_TAILSCALE: FAKE_CLI,
    FAKE_TS_STATE_DIR: tsState,
  };
  return { env, port, tsState };
}

/** A provider the way the extension makes it, with the webview's comms and a clipboard on the fake vscode. */
function window() {
  const provider = createFakeProvider();
  providers.push(provider);
  const comms = createFakeComms({ sessions: [{ id: "s1", summary: "Fix the flaky test", lastModified: 1_000 }] });
  comms.openChannel("c1", "s1");
  provider.allComms.add(comms);
  const copied: string[] = [];
  const vscode: any = createFakeVscode();
  vscode.env.clipboard = { writeText: async (text: string) => void copied.push(text) };
  vscode.env.openExternal = async () => true;
  vscode.Uri = { parse: (value: string) => ({ toString: () => value }) };
  return { provider, comms, vscode, copied };
}

let lastRequest = 0;

/** A Connection-tab request the way the webview sends it; resolves with the host's response to it. */
async function ask(comms: FakeComms, request: Record<string, unknown>): Promise<any> {
  const requestId = `w-${++lastRequest}`;
  await comms.fromClient({ type: "request", channelId: "", requestId, request });
  for (let i = 0; i < 500; i++) {
    await comms.flush();
    const answer = comms.sent.find((message) => message.type === "response" && message.requestId === requestId);
    if (answer) return answer.response;
    await sleep(10);
  }
  throw new Error(`no response to ${String(request.type)}`);
}

describe("attach", () => {
  test("VERSION is 1.0.0", () => {
    expect(VERSION).toBe("1.0.0");
  });

  test("defers its work: called from the allComms field initializer, it instruments the comms once the constructor is done", async () => {
    const { env } = await hostEnv();
    const { comms, vscode } = window();
    const provider: any = {};
    providers.push(provider);
    // The patched field initializer: attach(this) runs before the field and the constructor are set.
    provider.allComms = (attach(provider, { vscode, env }) as unknown) || new Set();
    expect(bridgeOf(provider)?.agent ?? null).toBeNull();
    provider.allComms.add(comms);
    provider.output = createFakeProvider().output;
    await tick();
    expect(bridgeOf(provider)!.agent).toBeInstanceOf(WindowAgent);
    expect((comms as any).__cceRemote).toBe(true);
  });

  test("twice for one provider: one agent", async () => {
    const { env } = await hostEnv();
    const { provider, vscode } = window();
    attach(provider, { vscode, env });
    attach(provider, { vscode, env });
    await tick();
    const first = bridgeOf(provider)!;
    expect(first.agent).toBeInstanceOf(WindowAgent);
    attach(provider, { vscode, env });
    await tick();
    expect(bridgeOf(provider)!.agent).toBe(first.agent);
    expect(bridgeOf(provider)!.coordinator).toBe(first.coordinator);
  });

  test("comms added later are instrumented and answer the Connection tab", async () => {
    const { env } = await hostEnv();
    const { provider, vscode } = window();
    attach(provider, { vscode, env });
    await tick();
    const later = createFakeComms({ sessions: [] });
    provider.allComms.add(later);
    expect((later as any).__cceRemote).toBe(true);
    const response = await ask(later, { type: "cce_remote_status" });
    expect(response.type).toBe("cce_remote_status_response");
    expect(response.status.role).toBe("off");
  });

  test("a cce_remote_status request through processRequest answers with the status: off, Tailscale from the CLI", async () => {
    const { env, port } = await hostEnv();
    const { provider, comms, vscode } = window();
    attach(provider, { vscode, env });
    await tick();
    const response = await ask(comms, { type: "cce_remote_status" });
    expect(response).toEqual({
      type: "cce_remote_status_response",
      status: {
        enabled: false,
        role: "off",
        port,
        url: `https://${DNS}:${port}`,
        macName: "example-mac",
        tailscale: { installed: true, running: true, loginName: "owner@example.com", dnsName: DNS, httpsEnabled: true },
        serve: { configured: false },
        windows: 0,
        devices: [],
        appUrl: "",
      },
    });
    // other requests still reach the extension
    expect((await ask(comms, { type: "list_sessions_request" })).type).toBe("list_sessions_response");
  });

  test("an object without allComms, or no object at all, does not throw", async () => {
    const { env } = await hostEnv();
    const vscode = createFakeVscode();
    const bare: any = {};
    providers.push(bare);
    expect(() => attach(bare, { vscode, env })).not.toThrow();
    expect(() => attach(null as any)).not.toThrow();
    expect(() => attach(undefined as any)).not.toThrow();
    expect(() => attach(42 as any)).not.toThrow();
    await tick();
    await sleep(20);
    expect(bridgeOf(bare)!.agent).toBeInstanceOf(WindowAgent);
    expect(await bridgeOf(bare)!.coordinator.status()).toMatchObject({ role: "off", enabled: false });
  });

  test("a second provider in the same extension host gets its own agent and shares the coordinator", async () => {
    const { env } = await hostEnv();
    const one = window();
    const two = window();
    attach(one.provider, { vscode: one.vscode, env });
    attach(two.provider, { vscode: two.vscode, env });
    await tick();
    expect(bridgeOf(one.provider)!.agent).not.toBe(bridgeOf(two.provider)!.agent);
    expect(bridgeOf(one.provider)!.coordinator).toBe(bridgeOf(two.provider)!.coordinator);
    expect(bridgeOf(two.provider)!.agent!.enabled).toBe(false); // only the first agent's window reaches the phone
    expect((await ask(two.comms, { type: "cce_remote_status" })).status.role).toBe("off");
  });
});

describe("the Connection tab through the bridge", () => {
  test("connect, copy, disconnect: the hub listens, serve is on, the pairing link is copied; the log has no secret, token or code", async () => {
    const { env, port, tsState } = await hostEnv();
    const { provider, comms, vscode, copied } = window();
    attach(provider, { vscode, env });
    await tick();

    const connected = await ask(comms, { type: "cce_remote_connect" });
    expect(connected.type).toBe("cce_remote_connect_response");
    expect(connected.error).toBeUndefined();
    expect(connected.status).toMatchObject({ enabled: true, role: "hub", port, windows: 1, serve: { configured: true } });
    expect(fs.readFileSync(path.join(tsState, `serve-${port}`), "utf8")).toBe(`http://127.0.0.1:${port}`);
    expect(await isListening(port)).toBe(true);
    const pairing = connected.status.pairing;
    expect(pairing.code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);

    expect(await ask(comms, { type: "cce_remote_copy", text: pairing.link })).toEqual({ type: "cce_remote_copy_response" });
    expect(copied).toEqual([pairing.link]);

    const disconnected = await ask(comms, { type: "cce_remote_disconnect" });
    expect(disconnected.status).toMatchObject({ enabled: false, role: "off" });
    expect(fs.existsSync(path.join(tsState, `serve-${port}`))).toBe(false);
    expect(await isListening(port)).toBe(false);

    const lines = provider.output.lines;
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^\[(trace|debug|info|warn|error)\] \[cce-remote\] /);
    const log = lines.join("\n");
    const secret = loadState(env).secret;
    expect(log).not.toContain(secret);
    expect(log).not.toContain(pairing.code);
    expect(log).not.toContain(pairing.code.replace("-", ""));
    expect(log).not.toContain("#pair=");
  });

  test("the extension's subscriptions stop the bridge: the port is let go, and the tab hears that the bridge is gone", async () => {
    const { env, port } = await hostEnv();
    const { provider, comms, vscode } = window();
    const subscriptions: Array<{ dispose(): unknown }> = [];
    (provider as any).context = { subscriptions };
    attach(provider, { vscode, env });
    await tick();
    await ask(comms, { type: "cce_remote_connect" });
    expect(await isListening(port)).toBe(true);
    expect(subscriptions).toHaveLength(1);
    await subscriptions[0].dispose();
    await sleep(50);
    expect(await isListening(port)).toBe(false);
    expect(loadState(env).enabled).toBe(true); // a window going away does not turn remote access off
    expect(await ask(comms, { type: "cce_remote_status" })).toEqual({ type: "error", error: "cce_remote_unavailable" });
  });
});

describe("the window closes", () => {
  test("VS Code's deactivate awaits provider.shutdownAll: the bridge stops inside it, the last window turns serve off and leaves remote access on, and the extension's own shutdown still runs", async () => {
    const { env, port, tsState } = await hostEnv();
    const { provider, comms, vscode } = window();
    const own: unknown[] = [];
    (provider as any).shutdownAll = async function (this: unknown) {
      own.push(this);
      return "the extension's";
    };
    attach(provider, { vscode, env });
    await tick();
    await ask(comms, { type: "cce_remote_connect" });
    expect(fs.existsSync(path.join(tsState, `serve-${port}`))).toBe(true);
    const started = Date.now();
    expect(await (provider as any).shutdownAll()).toBe("the extension's");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(own).toEqual([provider]);
    expect(bridgeOf(provider)!.detached).toBe(true);
    expect(await isListening(port)).toBe(false);
    expect(fs.existsSync(path.join(tsState, `serve-${port}`))).toBe(false);
    expect(loadState(env).enabled).toBe(true); // the next start of VS Code serves again
  });

  test("shutdownAll waits at most 2 s for the bridge, and keeps the extension's result and its errors", async () => {
    const { env } = await hostEnv();
    const { provider, vscode } = window();
    let fails = false;
    (provider as any).shutdownAll = async () => {
      if (fails) throw new Error("the extension's shutdown failed");
      return "the extension's";
    };
    attach(provider, { vscode, env });
    await tick();
    (bridgeOf(provider)!.coordinator as any).stop = () => new Promise(() => {}); // a bridge that never finishes stopping
    const started = Date.now();
    expect(await (provider as any).shutdownAll()).toBe("the extension's");
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(1900);
    expect(took).toBeLessThan(2600);
    fails = true;
    await expect((provider as any).shutdownAll()).rejects.toThrow("the extension's shutdown failed");
  });

  test("a provider without shutdownAll (an older extension) still gets the bridge, stopped by its subscriptions", async () => {
    const { env } = await hostEnv();
    const { provider, vscode } = window();
    attach(provider, { vscode, env });
    await tick();
    expect((provider as any).shutdownAll).toBeUndefined();
    expect(bridgeOf(provider)!.coordinator).not.toBeNull();
  });
});

// ---- the production runtime ------------------------------------------------------------------------

describe("under real Node", () => {
  test.skipIf(!Bun.which("node"))(
    "two windows, a phone, a takeover and a disconnect (remote-bridge/test/bridge-smoke.js)",
    async () => {
      const proc = Bun.spawn(["node", path.join(import.meta.dir, "bridge-smoke.js")], { stdout: "pipe", stderr: "pipe" });
      const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect(out).toContain("bridge smoke: ok");
    },
    30_000,
  );
});
