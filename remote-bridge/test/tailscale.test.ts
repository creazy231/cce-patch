import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Tailscale, findCli, findConsentUrl, parseServeStatus, parseStatus, runCli } from "../lib/tailscale.js";
import { sleep } from "./support";

// Nothing in here runs the real Tailscale CLI. Every Tailscale gets the fake script
// (fixtures/fake-tailscale.sh), a stub `run`, or an override path that does not exist; openApp()
// only ever sees a stub, so no test opens the real app either.
const FAKE = path.resolve(import.meta.dir, "fixtures/fake-tailscale.sh");
const TAILSCALE_JS = path.resolve(import.meta.dir, "../lib/tailscale.js");
const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
const KNOWN_CLIS = [APP_CLI, "/usr/local/bin/tailscale", "/opt/homebrew/bin/tailscale", "/usr/bin/tailscale"];
const CONSENT_URL = "https://login.tailscale.com/f/serve?node=abc";
const CONSENT_TEXT = `\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         ${CONSENT_URL}\n`;
const VERSION_WARNING = 'Warning: client version "1.94.2-t2de4d317a" != tailscaled server version "1.104.6-t3b273a64c"';
const DAEMON_DOWN = "failed to connect to local Tailscale service; is Tailscale running?";
const NOT_INSTALLED = { installed: false, running: false, httpsEnabled: false };

let stateDir: string;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "cce-fake-ts-"));
});
afterEach(() => {
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error.code === "EPERM";
  }
};

/** Whether a process is gone within a moment (a killed child is reaped a few milliseconds later). */
async function goneSoon(pid: number, ms = 2000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (alive(pid) && Date.now() < deadline) await sleep(20);
  return !alive(pid);
}

const readPid = (file: string) => Number(fs.readFileSync(file, "utf8").trim());

// --- the CLI's JSON -------------------------------------------------------------------------

const STATUS = {
  Version: "1.99.0",
  BackendState: "Running",
  AuthURL: "",
  Self: { ID: "nExampleCNTRL", HostName: "example-mac", DNSName: "example-mac.tailnet-0000.ts.net.", UserID: 123, Online: true },
  CertDomains: ["example-mac.tailnet-0000.ts.net"],
  Peer: { "nodekey:0000": { HostName: "example-phone", DNSName: "example-phone.tailnet-0000.ts.net.", UserID: 456 } },
  User: {
    "123": { ID: 123, LoginName: "owner@example.com", DisplayName: "Example Owner" },
    "456": { ID: 456, LoginName: "friend@example.com", DisplayName: "Example Friend" },
  },
};

const SERVE = {
  TCP: { "47821": { HTTPS: true } },
  Web: { "example-mac.tailnet-0000.ts.net:47821": { Handlers: { "/": { Proxy: "http://127.0.0.1:47821" } } } },
};

describe("parseStatus", () => {
  test("reads a running tailnet", () => {
    expect(parseStatus(STATUS)).toEqual({
      installed: true,
      running: true,
      backendState: "Running",
      loginName: "owner@example.com",
      dnsName: "example-mac.tailnet-0000.ts.net",
      hostName: "example-mac",
      httpsEnabled: true,
    });
  });

  test("HTTPS certificates are off when CertDomains is null, empty or missing", () => {
    expect(parseStatus({ ...STATUS, CertDomains: null }).httpsEnabled).toBe(false);
    expect(parseStatus({ ...STATUS, CertDomains: [] }).httpsEnabled).toBe(false);
    const { CertDomains, ...without } = STATUS;
    expect(parseStatus(without).httpsEnabled).toBe(false);
  });

  test("only BackendState Running is running", () => {
    for (const backendState of ["Stopped", "NeedsLogin", "NeedsMachineAuth", "Starting", "NoState", ""]) {
      const status = parseStatus({ ...STATUS, BackendState: backendState });
      expect(status.running).toBe(false);
      expect(status.backendState).toBe(backendState);
      expect(status.installed).toBe(true);
    }
  });

  test("a logged-out CLI has no Self and no users", () => {
    const status = parseStatus({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/abc", CertDomains: null, User: null });
    expect(status).toEqual({ installed: true, running: false, backendState: "NeedsLogin", httpsEnabled: false });
    expect(status.loginName).toBeUndefined();
    expect(status.dnsName).toBeUndefined();
    expect(status.hostName).toBeUndefined();
  });

  test("the login is Self's user, not a peer's user that happens to come first", () => {
    const status = parseStatus({
      ...STATUS,
      Self: { ...STATUS.Self, UserID: 999 },
      User: { "123": { ID: 123, LoginName: "friend@example.com" }, "999": { ID: 999, LoginName: "owner@example.com" } },
    });
    expect(status.loginName).toBe("owner@example.com");
  });

  test("the login is unknown (not a guess) when Self's user is not listed", () => {
    expect(parseStatus({ ...STATUS, Self: { ...STATUS.Self, UserID: 777 } }).loginName).toBeUndefined();
    expect(parseStatus({ ...STATUS, Self: { ...STATUS.Self, UserID: undefined } }).loginName).toBeUndefined();
  });

  test("the DNS name loses its one trailing dot; an empty one is unknown", () => {
    expect(parseStatus({ ...STATUS, Self: { ...STATUS.Self, DNSName: "example-mac.tailnet-0000.ts.net" } }).dnsName).toBe("example-mac.tailnet-0000.ts.net");
    expect(parseStatus({ ...STATUS, Self: { ...STATUS.Self, DNSName: "" } }).dnsName).toBeUndefined();
    expect(parseStatus({ ...STATUS, Self: { ...STATUS.Self, DNSName: "." } }).dnsName).toBeUndefined();
  });

  test("junk is a not-running status, never a throw", () => {
    for (const junk of [null, undefined, "text", 42, [], { Self: "x", User: 3, CertDomains: "yes", BackendState: 7 }]) {
      expect(parseStatus(junk)).toMatchObject({ installed: true, running: false, httpsEnabled: false });
    }
  });
});

describe("parseServeStatus", () => {
  test("is true when the port serves HTTPS and proxies to our own port", () => {
    expect(parseServeStatus(SERVE, 47821)).toBe(true);
  });

  test("is false for another port, or a handler that proxies elsewhere", () => {
    expect(parseServeStatus(SERVE, 47822)).toBe(false);
    const elsewhere = {
      TCP: SERVE.TCP,
      Web: { "example-mac.tailnet-0000.ts.net:47821": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } },
    };
    expect(parseServeStatus(elsewhere, 47821)).toBe(false);
    const otherHost = {
      TCP: SERVE.TCP,
      Web: { "example-mac.tailnet-0000.ts.net:47821": { Handlers: { "/": { Proxy: "http://192.0.2.10:47821" } } } },
    };
    expect(parseServeStatus(otherHost, 47821)).toBe(false);
  });

  test("needs the HTTPS listener and a handler on /", () => {
    expect(parseServeStatus({ TCP: { "47821": { HTTPS: false } }, Web: SERVE.Web }, 47821)).toBe(false);
    expect(parseServeStatus({ TCP: { "47821": { TCPForward: "127.0.0.1:47821" } }, Web: SERVE.Web }, 47821)).toBe(false);
    expect(parseServeStatus({ TCP: {}, Web: SERVE.Web }, 47821)).toBe(false);
    expect(parseServeStatus({ TCP: SERVE.TCP }, 47821)).toBe(false);
    const onlySubPath = { TCP: SERVE.TCP, Web: { "example-mac.tailnet-0000.ts.net:47821": { Handlers: { "/api": { Proxy: "http://127.0.0.1:47821" } } } } };
    expect(parseServeStatus(onlySubPath, 47821)).toBe(false);
  });

  test("is not fooled by another port that ends in the same digits", () => {
    const web = { "example-mac.tailnet-0000.ts.net:147821": { Handlers: { "/": { Proxy: "http://127.0.0.1:47821" } } } };
    expect(parseServeStatus({ TCP: SERVE.TCP, Web: web }, 47821)).toBe(false);
  });

  test("accepts a trailing slash on the proxy target, and several ports", () => {
    const web = {
      "example-mac.tailnet-0000.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } },
      "example-mac.tailnet-0000.ts.net:47821": { Handlers: { "/": { Proxy: "http://127.0.0.1:47821/" } } },
    };
    expect(parseServeStatus({ TCP: { "443": { HTTPS: true }, "47821": { HTTPS: true } }, Web: web }, 47821)).toBe(true);
    expect(parseServeStatus({ TCP: { "443": { HTTPS: true }, "47821": { HTTPS: true } }, Web: web }, 443)).toBe(false);
  });

  test("an empty or odd config is not configured", () => {
    for (const junk of [{}, null, undefined, "x", 1, [], { TCP: null, Web: null }, { TCP: "x", Web: "y" }]) {
      expect(parseServeStatus(junk, 47821)).toBe(false);
    }
  });
});

describe("findConsentUrl", () => {
  test("finds the link in the CLI's consent text", () => {
    expect(findConsentUrl("To enable, visit:\n\n         https://login.tailscale.com/f/serve?node=abc\n")).toBe(CONSENT_URL);
  });

  test("takes the first of several, whatever surrounds it", () => {
    expect(findConsentUrl(`${CONSENT_TEXT}\nor https://login.tailscale.com/admin/dns\n`)).toBe(CONSENT_URL);
    expect(findConsentUrl("ignore https://example.com/x then https://login.tailscale.com/admin/dns now")).toBe("https://login.tailscale.com/admin/dns");
  });

  test("drops punctuation that ends the sentence, keeps the query", () => {
    expect(findConsentUrl("Visit https://login.tailscale.com/f/serve?node=abc.")).toBe(CONSENT_URL);
    expect(findConsentUrl("(see https://login.tailscale.com/f/serve?node=abc&x=1)")).toBe("https://login.tailscale.com/f/serve?node=abc&x=1");
  });

  test("is null without a Tailscale login link", () => {
    expect(findConsentUrl("")).toBeNull();
    expect(findConsentUrl("Available within your tailnet:\n\nhttps://example-mac.tailnet-0000.ts.net:47821/\n")).toBeNull();
    expect(findConsentUrl("see https://example.com/login.tailscale.com/x")).toBeNull();
    expect(findConsentUrl("http://login.tailscale.com/f/serve")).toBeNull();
    expect(findConsentUrl("https://login.tailscale.com.evil.example/f/serve")).toBeNull();
  });
});

describe("findCli", () => {
  const only = (...present: string[]) => (candidate: string) => present.includes(candidate);

  test("CCE_REMOTE_TAILSCALE comes first", () => {
    expect(findCli({ CCE_REMOTE_TAILSCALE: "/fake/ts", PATH: "/bin" }, only("/fake/ts", ...KNOWN_CLIS))).toBe("/fake/ts");
  });

  test("an override that does not exist is final: it never falls back to a real install", () => {
    expect(findCli({ CCE_REMOTE_TAILSCALE: "/fake/ts", PATH: "/bin" }, only(...KNOWN_CLIS, "/bin/tailscale"))).toBeNull();
  });

  test("an empty override is no override", () => {
    expect(findCli({ CCE_REMOTE_TAILSCALE: "" }, only(APP_CLI))).toBe(APP_CLI);
  });

  test("then the app's own binary, /usr/local/bin, Homebrew and /usr/bin, in that order", () => {
    for (let i = 0; i < KNOWN_CLIS.length; i++) {
      expect(findCli({}, only(...KNOWN_CLIS.slice(i)))).toBe(KNOWN_CLIS[i]);
    }
  });

  test("the last resort is tailscale on PATH, first match wins", () => {
    const env = { PATH: ["/nope", "/opt/bin", "/other"].join(path.delimiter) };
    expect(findCli(env, only("/opt/bin/tailscale", "/other/tailscale"))).toBe("/opt/bin/tailscale");
    expect(findCli(env, only("/other/tailscale"))).toBe("/other/tailscale");
    expect(findCli(env, only("/opt/bin/tailscale", "/usr/bin/tailscale"))).toBe("/usr/bin/tailscale"); // a known place beats PATH
  });

  test("never looks in the current directory: empty and relative PATH entries are skipped", () => {
    const asked: string[] = [];
    const env = { PATH: ["", ".", "bin", "/opt/bin"].join(path.delimiter) };
    expect(findCli(env, (candidate) => (asked.push(candidate), false))).toBeNull();
    expect(asked.every((candidate) => path.isAbsolute(candidate))).toBe(true);
    expect(asked).toContain("/opt/bin/tailscale");
  });

  test("is null when there is nothing, with or without a PATH", () => {
    expect(findCli({ PATH: "/opt/bin" }, () => false)).toBeNull();
    expect(findCli({}, () => false)).toBeNull();
  });
});

// --- the process runner ---------------------------------------------------------------------

describe("runCli", () => {
  const sh = (script: string, ...rest: string[]) => ["-c", script, ...rest];

  test("collects stdout, stderr and the exit code", async () => {
    const result = await runCli("/bin/sh", sh("echo out; echo err >&2; exit 3"), { timeoutMs: 5000 });
    expect(result).toMatchObject({ code: 3, stdout: "out\n", stderr: "err\n", timedOut: false, stopped: false });
    expect(result.error).toBeUndefined();
  });

  test("passes the environment through, and nothing else", async () => {
    const result = await runCli("/bin/sh", sh("echo $CCE_TEST_VALUE"), { env: { ...process.env, CCE_TEST_VALUE: "from the options" }, timeoutMs: 5000 });
    expect(result.stdout).toBe("from the options\n");
  });

  test("closes stdin, so a CLI that asks a question gets an end of input", async () => {
    const result = await runCli("/bin/sh", sh("read answer; echo got-eof-$?"), { timeoutMs: 5000 });
    expect(result.stdout).toBe("got-eof-1\n");
  });

  test("a program that cannot be started is an error, not a throw", async () => {
    const result = await runCli("/nonexistent/tailscale", [], { timeoutMs: 5000 });
    expect((result.error as any)?.code).toBe("ENOENT");
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
  });

  test("a run that takes too long is killed and reported as timed out", async () => {
    const pidFile = path.join(stateDir, "pid");
    const started = performance.now();
    const result = await runCli("/bin/sh", sh('echo $$ > "$0"; echo partial; exec sleep 30', pidFile), { timeoutMs: 300 });
    expect(result.timedOut).toBe(true);
    expect(result.stopped).toBe(false);
    expect(result.stdout).toBe("partial\n");
    expect(performance.now() - started).toBeLessThan(2500);
    expect(await goneSoon(readPid(pidFile))).toBe(true);
  });

  test("until() ends the run as soon as it returns true, and kills the child", async () => {
    const pidFile = path.join(stateDir, "pid");
    const seen: string[] = [];
    const started = performance.now();
    const result = await runCli("/bin/sh", sh('echo $$ > "$0"; echo first; sleep 0.3; echo "the link"; exec sleep 30', pidFile), {
      timeoutMs: 10_000,
      until: ({ stdout }) => (seen.push(stdout), stdout.includes("link")),
    });
    expect(result.stopped).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.stdout).toBe("first\nthe link\n");
    // Called after each chunk with everything so far; the run ended long before `exec sleep 30` did.
    expect(seen.at(-1)).toBe("first\nthe link\n");
    expect(seen.every((snapshot, i) => i === 0 || snapshot.startsWith(seen[i - 1]))).toBe(true);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await goneSoon(readPid(pidFile))).toBe(true);
  });

  test("until() sees stderr too", async () => {
    const result = await runCli("/bin/sh", sh("echo oops >&2; exec sleep 30"), { timeoutMs: 10_000, until: ({ stderr }) => stderr.includes("oops") });
    expect(result).toMatchObject({ stopped: true, stderr: "oops\n", stdout: "" });
  });

  test("a child that ignores SIGTERM is killed for good after the grace period, and the result does not wait for that", async () => {
    const pidFile = path.join(stateDir, "pid");
    const started = performance.now();
    const result = await runCli("/bin/sh", sh('trap "" TERM; echo $$ > "$0"; while :; do sleep 0.1; done', pidFile), { timeoutMs: 200, killGraceMs: 1500 });
    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000); // well before the SIGKILL at 1700 ms
    expect(await goneSoon(readPid(pidFile), 4000)).toBe(true);
  });

  test("a throwing until() ends the run with that error, and the child is killed", async () => {
    const pidFile = path.join(stateDir, "pid");
    const result = await runCli("/bin/sh", sh('echo $$ > "$0"; echo something; exec sleep 30', pidFile), {
      timeoutMs: 10_000,
      until: () => {
        throw new Error("until broke");
      },
    });
    expect(result.error?.message).toBe("until broke");
    expect(result).toMatchObject({ timedOut: false, stopped: false, stdout: "something\n" });
    expect(await goneSoon(readPid(pidFile))).toBe(true);
  });

  test("stopping a run releases its pipes, so a grandchild that holds them cannot keep the process alive", () => {
    // `(sleep 5 &)` outlives the shell and inherits its stdout. A process that ran the CLI must still be able to exit.
    const script = path.join(stateDir, "hold.cjs");
    fs.writeFileSync(
      script,
      `const { runCli } = require(${JSON.stringify(TAILSCALE_JS)});
       runCli("/bin/sh", ["-c", "(sleep 5 &); echo hit; exec sleep 30"], { timeoutMs: 10000, until: ({ stdout }) => stdout.includes("hit") })
         .then((result) => console.log(result.stopped));`,
    );
    const started = performance.now();
    const run = spawnSync(process.execPath, [script], { encoding: "utf8", timeout: 15_000 });
    expect(run.stdout.trim()).toBe("true");
    expect(performance.now() - started).toBeLessThan(3500);
  });

  test("output beyond the limit stops the run with an error", async () => {
    const started = performance.now();
    const result = await runCli("/bin/sh", sh("exec yes"), { timeoutMs: 10_000, maxOutputChars: 2000 });
    expect(result.error?.message).toMatch(/too much output/);
    expect(result).toMatchObject({ timedOut: false, stopped: false });
    expect(result.stdout.length).toBeLessThan(2_000_000);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

// --- Tailscale with a stub runner: what is run, and how results are read --------------------

interface RunResult {
  code: number | null;
  signal?: string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  stopped: boolean;
  error?: Error;
}
interface RunCall {
  command: string;
  args: string[];
  options: { env?: any; timeoutMs: number; until?: (output: { stdout: string; stderr: string }) => boolean };
}

/** A `run` that records its calls and answers from a queue; a call beyond the queue fails the test. */
function stubRun(...results: Array<Partial<RunResult>>) {
  const calls: RunCall[] = [];
  const queue = [...results];
  const run = async (command: string, args: string[], options: RunCall["options"]): Promise<RunResult> => {
    calls.push({ command, args, options });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected run: ${command} ${args.join(" ")}`);
    return { code: 0, stdout: "", stderr: "", timedOut: false, stopped: false, ...next };
  };
  return { run, calls };
}

const enoent = Object.assign(new Error("spawn /stub/tailscale ENOENT"), { code: "ENOENT" });
const stubbed = (run: any, extra: object = {}) => new Tailscale({ cli: "/stub/tailscale", env: { PATH: "/stub" }, run, ...extra });

describe("Tailscale.status (stub runner)", () => {
  test("runs `status --json` with the CLI, the environment and a 5 s limit", async () => {
    const { run, calls } = stubRun({ stdout: JSON.stringify(STATUS) });
    const status = await stubbed(run).status();
    expect(status).toEqual(parseStatus(STATUS));
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/stub/tailscale");
    expect(calls[0].args).toEqual(["status", "--json"]);
    expect(calls[0].options.timeoutMs).toBe(5000);
    expect(calls[0].options.env).toEqual({ PATH: "/stub" });
    expect(calls[0].options.until).toBeUndefined();
  });

  test("a stderr warning next to good JSON does not matter", async () => {
    const { run } = stubRun({ stdout: JSON.stringify(STATUS), stderr: `${VERSION_WARNING}\n` });
    expect((await stubbed(run).status()).running).toBe(true);
  });

  test("a CLI that cannot be started means Tailscale is not installed", async () => {
    const { run } = stubRun({ code: null, error: enoent });
    expect(await stubbed(run).status()).toEqual(NOT_INSTALLED);
  });

  test("a failing CLI is an error result without the version warning", async () => {
    const { run } = stubRun({ code: 1, stderr: `${VERSION_WARNING}\n${DAEMON_DOWN}\n` });
    expect(await stubbed(run).status()).toEqual({ installed: true, running: false, error: DAEMON_DOWN });
  });

  test("a failing CLI without a message still says why", async () => {
    const exited = stubbed(stubRun({ code: 7 }).run);
    expect(await exited.status()).toEqual({ installed: true, running: false, error: "Tailscale exited with code 7" });
    const killed = stubbed(stubRun({ code: null, signal: "SIGKILL" }).run);
    expect(await killed.status()).toEqual({ installed: true, running: false, error: "Tailscale was stopped by SIGKILL" });
  });

  test("a CLI that does not answer in time is an error result", async () => {
    const { run } = stubRun({ code: null, timedOut: true });
    expect(await stubbed(run).status()).toEqual({ installed: true, running: false, error: "Tailscale did not answer within 5 s" });
  });

  test("output that is not JSON is an error result", async () => {
    const { run } = stubRun({ stdout: "Tailscale is stopped.\n" });
    const status = await stubbed(run).status();
    expect(status).toMatchObject({ installed: true, running: false });
    expect(status.error).toMatch(/not JSON/);
  });

  test("a long error message is cut", async () => {
    const { run } = stubRun({ code: 1, stderr: "x".repeat(5000) });
    const status = await stubbed(run).status();
    expect(status.error.length).toBeLessThan(700);
    expect(status.error.startsWith("xxxx")).toBe(true);
  });

  test("caches every answer for 5 s: the first call after that asks again", async () => {
    let now = 1_000_000;
    const { run, calls } = stubRun({ stdout: JSON.stringify(STATUS) }, { stdout: JSON.stringify({ ...STATUS, BackendState: "Stopped" }) });
    const ts = stubbed(run, { now: () => now });
    expect((await ts.status()).running).toBe(true);
    now += 4999;
    expect((await ts.status()).running).toBe(true);
    expect(calls).toHaveLength(1);
    now += 1;
    expect((await ts.status()).running).toBe(false);
    expect(calls).toHaveLength(2);
  });

  test("errors are cached too, so a broken CLI is not run on every poll", async () => {
    const { run, calls } = stubRun({ code: 1, stderr: DAEMON_DOWN });
    const ts = stubbed(run);
    await ts.status();
    await ts.status();
    expect(calls).toHaveLength(1);
  });

  test("concurrent callers share one run", async () => {
    const { run, calls } = stubRun({ stdout: JSON.stringify(STATUS) });
    const ts = stubbed(run);
    const [a, b, c] = await Promise.all([ts.status(), ts.status(), ts.status()]);
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  test("hands out copies, from a fresh read and from the cache: changing one answer does not change the next", async () => {
    const { run } = stubRun({ stdout: JSON.stringify(STATUS) });
    const ts = stubbed(run);
    const first = await ts.status(); // a fresh read
    first.loginName = "someone-else@example.com";
    first.consentUrl = "https://login.tailscale.com/x";
    const second = await ts.status(); // from the cache
    expect(second.loginName).toBe("owner@example.com");
    expect(second.consentUrl).toBeUndefined();
    second.running = false;
    second.dnsName = "changed.example.test";
    const third = await ts.status(); // from the cache again
    expect(third).toEqual(parseStatus(STATUS));
  });

  test("serveOn and serveOff drop the cached status (HTTPS may have been enabled meanwhile)", async () => {
    const { run, calls } = stubRun(
      { stdout: JSON.stringify({ ...STATUS, CertDomains: null }) },
      {}, // serve on
      { stdout: JSON.stringify(STATUS) },
      {}, // serve off
      { stdout: JSON.stringify({ ...STATUS, BackendState: "Stopped" }) },
    );
    const ts = stubbed(run);
    expect((await ts.status()).httpsEnabled).toBe(false);
    await ts.serveOn(47821);
    expect((await ts.status()).httpsEnabled).toBe(true);
    await ts.serveOff(47821);
    expect((await ts.status()).running).toBe(false);
    expect(calls.map((call) => call.args[0])).toEqual(["status", "serve", "status", "serve", "status"]);
  });

  /** A `run` that holds every call until the test releases it; status calls answer from `answers`, in release order. */
  function heldRun(answers: string[]) {
    const release: Array<() => void> = [];
    const calls: string[][] = [];
    const run = (command: string, args: string[]) => {
      calls.push(args);
      return new Promise<RunResult>((resolve) => {
        release.push(() => resolve({ code: 0, stdout: args[0] === "status" ? answers.shift()! : "", stderr: "", timedOut: false, stopped: false }));
      });
    };
    return { run, calls, release };
  }
  const STALE_AND_FRESH = [JSON.stringify({ ...STATUS, CertDomains: null }), JSON.stringify(STATUS)];

  test("a status read that was in flight when serveOn finished does not fill the cache with its stale answer", async () => {
    const { run, calls, release } = heldRun([...STALE_AND_FRESH]);
    const ts = stubbed(run);
    const stale = ts.status(); // in flight
    const on = ts.serveOn(47821);
    await sleep(5);
    release[1](); // serve on finishes while the status read is still running
    await on;
    release[0](); // then the older read ends, with the answer from before serveOn
    expect((await stale).httpsEnabled).toBe(false); // its own caller still gets it
    const fresh = ts.status(); // must read again, not be handed that answer from the cache
    await sleep(5);
    release[2]();
    expect((await fresh).httpsEnabled).toBe(true);
    expect(calls.map((args) => args[0])).toEqual(["status", "serve", "status"]);
  });

  test("a status read asked for after serveOn starts its own instead of joining the older one", async () => {
    const { run, calls, release } = heldRun([...STALE_AND_FRESH]);
    const ts = stubbed(run);
    const stale = ts.status(); // in flight
    const on = ts.serveOn(47821);
    await sleep(5);
    release[1](); // serve on finishes while the status read is still running
    await on;
    const fresh = ts.status(); // must start its own read
    await sleep(5);
    expect(calls.map((args) => args[0])).toEqual(["status", "serve", "status"]);
    release[0](); // the older read ends first
    expect((await stale).httpsEnabled).toBe(false);
    release[2]();
    expect((await fresh).httpsEnabled).toBe(true);
    expect((await ts.status()).httpsEnabled).toBe(true); // the cache holds the newer answer
    expect(calls).toHaveLength(3);
  });
});

describe("Tailscale.serveOn (stub runner)", () => {
  test("runs `serve --bg --https=<port> http://127.0.0.1:<port>` with a 20 s limit", async () => {
    const { run, calls } = stubRun({ stdout: "Serve started and running in the background.\n" });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/stub/tailscale");
    expect(calls[0].args).toEqual(["serve", "--bg", "--https=47821", "http://127.0.0.1:47821"]);
    expect(calls[0].options.timeoutMs).toBe(20_000);
    expect(calls[0].options.env).toEqual({ PATH: "/stub" });
  });

  test("a port given as digits works like a number", async () => {
    const { run, calls } = stubRun({});
    expect(await stubbed(run).serveOn("47999")).toEqual({ ok: true });
    expect(calls[0].args).toEqual(["serve", "--bg", "--https=47999", "http://127.0.0.1:47999"]);
  });

  test("a consent link ends the run early and comes back as needsConsent", async () => {
    const { run } = stubRun({ code: null, stopped: true, stdout: CONSENT_TEXT });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, needsConsent: CONSENT_URL });
  });

  test("the link may be on stderr", async () => {
    const { run } = stubRun({ code: null, stopped: true, stderr: CONSENT_TEXT });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, needsConsent: CONSENT_URL });
  });

  test("a run that was stopped never counts as done, whatever exit code it reports", async () => {
    const { run } = stubRun({ code: 0, stopped: true, stdout: CONSENT_TEXT });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, needsConsent: CONSENT_URL });
  });

  test("a whole link wins over a cut-off one at the end of the other stream", async () => {
    const { run } = stubRun({ code: null, stopped: true, stdout: "visit https://login.tailscale.com/f/ser", stderr: `visit ${CONSENT_URL}\n` });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, needsConsent: CONSENT_URL });
  });

  test("tells the runner to stop only once a whole link is there", async () => {
    const { run, calls } = stubRun({ code: null, stopped: true, stdout: CONSENT_TEXT });
    await stubbed(run).serveOn(47821);
    const until = calls[0].options.until!;
    expect(until({ stdout: "", stderr: "" })).toBe(false);
    expect(until({ stdout: "\nServe is not enabled on your tailnet.\nTo enable, visit:\n", stderr: "" })).toBe(false);
    expect(until({ stdout: "visit:\n\n         https://login.tailscale.com/f/ser", stderr: "" })).toBe(false); // still arriving
    expect(until({ stdout: "visit:\n\n         https://login.tailscale.com/f/ser", stderr: "\nWarning: x\n" })).toBe(false); // not glued to stderr
    expect(until({ stdout: `visit:\n\n         ${CONSENT_URL}\n`, stderr: "" })).toBe(true);
    expect(until({ stdout: "", stderr: `visit ${CONSENT_URL}\r\n` })).toBe(true);
    expect(until({ stdout: "Available at https://example.com/x\n", stderr: "" })).toBe(false);
  });

  test("a link without a final newline still counts once the CLI has ended", async () => {
    const { run } = stubRun({ code: 1, stdout: `To enable, visit:\n\n   ${CONSENT_URL}` });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, needsConsent: CONSENT_URL });
  });

  test("a run that ended with exit code 0 is a success, whatever it printed", async () => {
    const { run } = stubRun({ code: 0, stdout: "Manage at https://login.tailscale.com/admin/machines" });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: true });
  });

  test("a runner that throws is an error result, not a crash", async () => {
    const run = async () => {
      throw new Error("runner broke");
    };
    const ts = stubbed(run);
    expect(await ts.serveOn(47821)).toEqual({ ok: false, error: "Could not run Tailscale: runner broke" });
    expect(await ts.serveOff(47821)).toEqual({ ok: false, error: "Could not run Tailscale: runner broke" });
    expect(await ts.status()).toEqual({ installed: true, running: false, error: "Could not run Tailscale: runner broke" });
  });

  test("a failure carries the CLI's own message", async () => {
    const { run } = stubRun({ code: 1, stderr: `${VERSION_WARNING}\nerror: port 47821 is already in use\n` });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, error: "error: port 47821 is already in use" });
  });

  test("falls back to stdout for the message, and to the exit code", async () => {
    expect(await stubbed(stubRun({ code: 1, stdout: "something went wrong\n" }).run).serveOn(47821)).toEqual({ ok: false, error: "something went wrong" });
    expect(await stubbed(stubRun({ code: 3 }).run).serveOn(47821)).toEqual({ ok: false, error: "Tailscale exited with code 3" });
  });

  test("prefers stderr over stdout for the message", async () => {
    const { run } = stubRun({ code: 1, stdout: "Available within your tailnet:\n", stderr: "error: boom\n" });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, error: "error: boom" });
  });

  test("a timeout says how long it waited", async () => {
    const { run } = stubRun({ code: null, timedOut: true });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, error: "Tailscale did not answer within 20 s" });
  });

  test("a CLI that cannot be started is reported as not installed", async () => {
    const { run } = stubRun({ code: null, error: enoent });
    expect(await stubbed(run).serveOn(47821)).toEqual({ ok: false, error: "Tailscale is not installed" });
  });

  test("another start failure keeps its reason", async () => {
    const { run } = stubRun({ code: null, error: Object.assign(new Error("spawn /stub/tailscale EACCES"), { code: "EACCES" }) });
    const result = await stubbed(run).serveOn(47821);
    expect(result).toEqual({ ok: false, error: "Could not run Tailscale: spawn /stub/tailscale EACCES" });
  });

  test("refuses a port that is not 1-65535 without running anything", async () => {
    const { run, calls } = stubRun();
    const ts = stubbed(run);
    for (const port of [0, -1, 65536, 1.5, NaN, Infinity, "", "abc", "47821 --set-path=/x", "4e4", undefined, null, {}, [], true]) {
      const result = await ts.serveOn(port as any);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/invalid port/i);
    }
    expect((await ts.serveOff(0)).ok).toBe(false);
    expect(await ts.serveStatus(65536)).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });
});

describe("Tailscale.serveOff and serveStatus (stub runner)", () => {
  test("serveOff runs `serve --https=<port> off` with a 5 s limit", async () => {
    const { run, calls } = stubRun({});
    expect(await stubbed(run).serveOff(47821)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["serve", "--https=47821", "off"]);
    expect(calls[0].options.timeoutMs).toBe(5000);
    expect(calls[0].options.until).toBeUndefined();
  });

  test("a failed off is still a success when the port turns out not to be served any more", async () => {
    const { run, calls } = stubRun({ code: 1, stderr: "error: failed to remove web serve: handler does not exist" }, { stdout: "{}" });
    expect(await stubbed(run).serveOff(47821)).toEqual({ ok: true });
    expect(calls.map((call) => call.args)).toEqual([["serve", "--https=47821", "off"], ["serve", "status", "--json"]]);
  });

  test("a failed off is an error when the port is still served", async () => {
    const { run } = stubRun({ code: 1, stderr: "error: access denied" }, { stdout: JSON.stringify(SERVE) });
    expect(await stubbed(run).serveOff(47821)).toEqual({ ok: false, error: "error: access denied" });
  });

  test("a failed off is an error when nothing can confirm the state", async () => {
    const down = stubRun({ code: 1, stderr: DAEMON_DOWN }, { code: 1, stderr: DAEMON_DOWN });
    expect(await stubbed(down.run).serveOff(47821)).toEqual({ ok: false, error: DAEMON_DOWN });
    const garbled = stubRun({ code: 1, stderr: "error: boom" }, { stdout: "not json" });
    expect(await stubbed(garbled.run).serveOff(47821)).toEqual({ ok: false, error: "error: boom" });
  });

  test("an off that timed out or could not start does not ask again", async () => {
    const timedOut = stubRun({ code: null, timedOut: true });
    expect(await stubbed(timedOut.run).serveOff(47821)).toEqual({ ok: false, error: "Tailscale did not answer within 5 s" });
    expect(timedOut.calls).toHaveLength(1);
    const missing = stubRun({ code: null, error: enoent });
    expect(await stubbed(missing.run).serveOff(47821)).toEqual({ ok: false, error: "Tailscale is not installed" });
    expect(missing.calls).toHaveLength(1);
  });

  test("serveStatus runs `serve status --json` and reads whether our port is served", async () => {
    const { run, calls } = stubRun({ stdout: JSON.stringify(SERVE) }, { stdout: JSON.stringify(SERVE) }, { stdout: "{}\n" });
    const ts = stubbed(run);
    expect(await ts.serveStatus(47821)).toEqual({ configured: true });
    expect(await ts.serveStatus(47822)).toEqual({ configured: false });
    expect(await ts.serveStatus(47821)).toEqual({ configured: false });
    expect(calls[0].args).toEqual(["serve", "status", "--json"]);
    expect(calls[0].options.timeoutMs).toBe(5000);
  });

  test("serveStatus is not configured when the CLI fails, times out, is missing or prints junk", async () => {
    for (const result of [{ code: 1, stderr: DAEMON_DOWN }, { code: null, timedOut: true }, { code: null, error: enoent }, { stdout: "No serve config\n" }, { stdout: "" }]) {
      expect(await stubbed(stubRun(result).run).serveStatus(47821)).toEqual({ configured: false });
    }
  });
});

describe("Tailscale.openApp (stub runner)", () => {
  test("runs `open -a Tailscale` on macOS", async () => {
    const { run, calls } = stubRun({});
    await stubbed(run, { platform: "darwin" }).openApp();
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("open");
    expect(calls[0].args).toEqual(["-a", "Tailscale"]);
    expect(calls[0].options.timeoutMs).toBe(5000);
  });

  test("does nothing elsewhere", async () => {
    for (const platform of ["linux", "win32"]) {
      const { run, calls } = stubRun();
      await stubbed(run, { platform }).openApp();
      expect(calls).toHaveLength(0);
    }
  });

  test("rejects with the reason when the app cannot be opened", async () => {
    const { run } = stubRun({ code: 1, stderr: "Unable to find application named 'Tailscale'\n" });
    await expect(stubbed(run, { platform: "darwin" }).openApp()).rejects.toThrow("Unable to find application named 'Tailscale'");
    const timedOut = stubRun({ code: null, timedOut: true });
    await expect(stubbed(timedOut.run, { platform: "darwin" }).openApp()).rejects.toThrow("Tailscale did not answer within 5 s");
  });

  test("a runner that throws is a rejection too, not a crash", async () => {
    const run = async () => {
      throw new Error("runner broke");
    };
    await expect(stubbed(run, { platform: "darwin" }).openApp()).rejects.toThrow("runner broke");
  });
});

describe("Tailscale without a CLI", () => {
  test("a missing override means not installed, and nothing is run", async () => {
    const { run, calls } = stubRun();
    const ts = new Tailscale({ env: { CCE_REMOTE_TAILSCALE: path.join(stateDir, "missing", "tailscale") }, run });
    expect(await ts.status()).toEqual(NOT_INSTALLED);
    expect(await ts.serveOn(47821)).toEqual({ ok: false, error: "Tailscale is not installed" });
    expect(await ts.serveOff(47821)).toEqual({ ok: false, error: "Tailscale is not installed" });
    expect(await ts.serveStatus(47821)).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("a CLI that appears later is found on the next read", async () => {
    const cli = path.join(stateDir, "bin", "tailscale");
    let now = 0;
    const ts = new Tailscale({ env: { ...process.env, CCE_REMOTE_TAILSCALE: cli, FAKE_TS_STATE_DIR: stateDir }, now: () => now });
    expect(await ts.status()).toEqual(NOT_INSTALLED);
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.copyFileSync(FAKE, cli);
    fs.chmodSync(cli, 0o755);
    expect(await ts.status()).toEqual(NOT_INSTALLED); // still inside the 5 s
    now += 5000;
    expect((await ts.status()).running).toBe(true);
  });

  test("the CLI is looked up again on each read: one that moved is found at its new place", async () => {
    const install = (cli: string) => {
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.copyFileSync(FAKE, cli);
      fs.chmodSync(cli, 0o755);
    };
    const first = path.join(stateDir, "old", "tailscale");
    const second = path.join(stateDir, "new", "tailscale");
    install(first);
    const env = { ...process.env, CCE_REMOTE_TAILSCALE: first, FAKE_TS_STATE_DIR: stateDir };
    let now = 0;
    const ts = new Tailscale({ env, now: () => now });
    expect((await ts.status()).running).toBe(true);
    fs.rmSync(first);
    install(second);
    env.CCE_REMOTE_TAILSCALE = second;
    now += 5000;
    expect((await ts.status()).running).toBe(true);
    expect(calls()).toHaveLength(2);
  });

  test("a given cli that is not there is not installed either", async () => {
    const ts = new Tailscale({ cli: path.join(stateDir, "gone"), env: process.env });
    expect(await ts.status()).toEqual(NOT_INSTALLED);
    expect(await ts.serveOn(47821)).toEqual({ ok: false, error: "Tailscale is not installed" });
  });
});

// --- Tailscale against the fake CLI script: real processes ----------------------------------

/** The fake CLI's call log: one entry per run, its arguments. */
function calls(): string[] {
  const file = path.join(stateDir, "calls");
  return fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
}

function fakeTailscale(mode?: "ok" | "consent" | "consent-stderr" | "fail", options: { now?: () => number } = {}) {
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_TS_STATE_DIR: stateDir };
  if (mode) env.FAKE_TS_MODE = mode;
  else delete env.FAKE_TS_MODE;
  return new Tailscale({ cli: FAKE, env, ...options });
}

describe("Tailscale with the fake CLI", () => {
  test("the fixture is executable", () => {
    expect(fs.statSync(FAKE).mode & 0o111).not.toBe(0);
  });

  test("status() reads a running tailnet (mode ok is the default)", async () => {
    expect(await fakeTailscale().status()).toEqual({
      installed: true,
      running: true,
      backendState: "Running",
      loginName: "owner@example.com",
      dnsName: "example-mac.tailnet-0000.ts.net",
      hostName: "example-mac",
      httpsEnabled: true,
    });
    expect(calls()).toEqual(["status --json"]);
  });

  test("status() without HTTPS certificates (consent mode)", async () => {
    expect(await fakeTailscale("consent").status()).toMatchObject({ running: true, httpsEnabled: false });
  });

  test("status() asks the CLI once for two calls within 5 s", async () => {
    const ts = fakeTailscale();
    const first = await ts.status();
    const second = await ts.status();
    expect(second).toEqual(first);
    expect(calls().filter((call) => call === "status --json")).toHaveLength(1);
  });

  test("status() asks again after 5 s, and shares one run between concurrent calls", async () => {
    let now = 5_000_000;
    const ts = fakeTailscale("ok", { now: () => now });
    await Promise.all([ts.status(), ts.status(), ts.status()]);
    expect(calls()).toHaveLength(1);
    now += 4999;
    await ts.status();
    expect(calls()).toHaveLength(1);
    now += 1;
    await ts.status();
    expect(calls()).toHaveLength(2);
  });

  test("status() of a failing CLI is an error result with the CLI's message, cached like any answer", async () => {
    const ts = fakeTailscale("fail");
    const first = await ts.status();
    expect(first).toEqual({ installed: true, running: false, error: DAEMON_DOWN });
    expect(await ts.status()).toEqual(first);
    expect(calls()).toHaveLength(1);
  });

  test("serveOn then serveStatus then serveOff, the way the bridge drives it", async () => {
    const ts = fakeTailscale();
    expect(await ts.serveStatus(47821)).toEqual({ configured: false });
    expect(await ts.serveOn(47821)).toEqual({ ok: true });
    expect(calls()).toContain("serve --bg --https=47821 http://127.0.0.1:47821");
    expect(await ts.serveStatus(47821)).toEqual({ configured: true });
    expect(await ts.serveStatus(47822)).toEqual({ configured: false });
    expect(await ts.serveOff(47821)).toEqual({ ok: true });
    expect(calls()).toContain("serve --https=47821 off");
    expect(await ts.serveStatus(47821)).toEqual({ configured: false });
  });

  test("serveOff of a port that is not served is a success (the fake's off fails there, like the real CLI)", async () => {
    const ts = fakeTailscale();
    expect(await ts.serveOff(47821)).toEqual({ ok: true });
    expect(calls()).toEqual(["serve --https=47821 off", "serve status --json"]);
  });

  test("two ports are independent", async () => {
    const ts = fakeTailscale();
    await ts.serveOn(47821);
    await ts.serveOn(47999);
    await ts.serveOff(47821);
    expect(await ts.serveStatus(47821)).toEqual({ configured: false });
    expect(await ts.serveStatus(47999)).toEqual({ configured: true });
  });

  test("serveOn with consent needed returns the link within 3 s and kills the CLI", async () => {
    const ts = fakeTailscale("consent");
    const started = performance.now();
    const result = await ts.serveOn(47821);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result).toEqual({ ok: false, needsConsent: CONSENT_URL });
    expect(await goneSoon(readPid(path.join(stateDir, "pid")))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "serve-47821"))).toBe(false);
  });

  test("serveOn with the consent text on stderr works the same", async () => {
    const ts = fakeTailscale("consent-stderr");
    const started = performance.now();
    expect(await ts.serveOn(47821)).toEqual({ ok: false, needsConsent: CONSENT_URL });
    expect(performance.now() - started).toBeLessThan(3000);
    expect(await goneSoon(readPid(path.join(stateDir, "pid")))).toBe(true);
  });

  test("serveOn of a failing CLI returns its stderr text", async () => {
    const result = await fakeTailscale("fail").serveOn(47821);
    expect(result).toEqual({ ok: false, error: DAEMON_DOWN });
    expect(result.needsConsent).toBeUndefined();
  });

  test("serveOff and serveStatus of a failing CLI do not claim anything", async () => {
    const ts = fakeTailscale("fail");
    expect(await ts.serveOff(47821)).toEqual({ ok: false, error: DAEMON_DOWN });
    expect(await ts.serveStatus(47821)).toEqual({ configured: false });
  });
});
