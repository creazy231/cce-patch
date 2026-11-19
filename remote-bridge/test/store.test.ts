import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, effectivePort, loadState, remoteHome, saveState, statePath, updateState, watchState } from "../lib/store.js";
import { queue, sleep } from "./support";

const STORE_PATH = path.resolve(import.meta.dir, "../lib/store.js");

// watchState polls every POLL_MS; a change shows within about one poll. QUIET_MS is long enough for five polls:
// what should not happen has not happened by then.
const POLL_MS = 50;
const QUIET_MS = 250;
// Child processes spin until this long after the script was handed to them, then act together.
const GATE_MS = 350;

// Safety net: a call that forgets its `env` argument lands in this directory, never in the real ~/.cce-remote.
let guardRoot = "";
let outerHome: string | undefined;
beforeAll(() => {
  guardRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cce-remote-guard-"));
  outerHome = process.env.CCE_REMOTE_HOME;
  process.env.CCE_REMOTE_HOME = guardRoot;
});
afterAll(() => {
  if (outerHome === undefined) delete process.env.CCE_REMOTE_HOME;
  else process.env.CCE_REMOTE_HOME = outerHome;
  fs.rmSync(guardRoot, { recursive: true, force: true });
});

const roots: string[] = [];
const stops: Array<() => void> = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A fresh state directory (not created yet: loadState has to) and the env that points at it. */
function tempHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cce-remote-"));
  roots.push(root);
  const dir = path.join(root, "home");
  return { env: { CCE_REMOTE_HOME: dir } as Record<string, string>, dir, file: path.join(dir, "state.json") };
}

const mode = (p: string) => fs.statSync(p).mode & 0o777;
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const SECRET = /^[0-9a-f]{64}$/;

/** Writes a state file the way a person (or an older version) might have left it. */
function writeRaw(t: ReturnType<typeof tempHome>, content: string) {
  fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(t.file, content, { mode: 0o600 });
}

/** Runs a script in a separate process of the current runtime and resolves with its stdout. */
function runScript(script: string, env: Record<string, string>, timeoutMs = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`the script did not exit within ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`exit code ${code}: ${err}`));
    });
  });
}

describe("remoteHome", () => {
  test("CCE_REMOTE_HOME wins, otherwise ~/.cce-remote", () => {
    expect(remoteHome({ CCE_REMOTE_HOME: "/example/state" })).toBe("/example/state");
    expect(remoteHome({ CCE_REMOTE_HOME: "", HOME: "/home/example" })).toBe(path.join("/home/example", ".cce-remote"));
    expect(remoteHome({ HOME: "/home/example" })).toBe(path.join("/home/example", ".cce-remote"));
    expect(remoteHome({})).toBe(path.join(os.homedir(), ".cce-remote"));
  });

  test("without an argument it reads process.env", () => {
    expect(remoteHome()).toBe(guardRoot);
    expect(statePath()).toBe(path.join(guardRoot, "state.json"));
  });
});

describe("loadState", () => {
  test("creates the directory (0700) and the file (0600) with the defaults", () => {
    const { env, dir, file } = tempHome();
    const state = loadState(env);
    expect(state).toEqual({ version: 1, enabled: false, port: 47821, secret: expect.stringMatching(SECRET), appUrl: "", devices: [] });
    expect(DEFAULT_PORT).toBe(47821);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(readJson(file)).toEqual(state);
    expect(statePath(env)).toBe(file);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]); // no temp file left behind
  });

  test("without an env argument it uses process.env", () => {
    const state = loadState();
    expect(readJson(path.join(guardRoot, "state.json"))).toEqual(state);
  });

  test("the secret is 64 hex characters and stays the same across loads", () => {
    const { env, file } = tempHome();
    const first = loadState(env);
    expect(first.secret).toMatch(SECRET);
    expect(loadState(env).secret).toBe(first.secret);
    expect(loadState(env).secret).toBe(readJson(file).secret);
  });

  test("two directories get two different secrets", () => {
    expect(loadState(tempHome().env).secret).not.toBe(loadState(tempHome().env).secret);
  });

  test("loading an intact file does not rewrite it", () => {
    const { env, file } = tempHome();
    loadState(env);
    const before = fs.statSync(file);
    loadState(env);
    const after = fs.statSync(file);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  test("repairs wider permissions on the directory and the file", () => {
    const { env, dir, file } = tempHome();
    const secret = loadState(env).secret;
    fs.chmodSync(dir, 0o755);
    fs.chmodSync(file, 0o644);
    expect(loadState(env).secret).toBe(secret);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
  });

  test("keeps unknown keys, in the result and in the file", () => {
    const t = tempHome();
    const secret = "ab".repeat(32);
    const content = { version: 1, enabled: true, port: 5000, secret, appUrl: "https://app.example.test", devices: [], later: { nested: [1, 2] }, note: "hand-written" };
    writeRaw(t, JSON.stringify(content));
    expect(loadState(t.env)).toEqual(content);
    expect(readJson(t.file)).toEqual(content);
  });

  test("fills in what the file lacks, keeps what it has and stores the new secret", () => {
    const t = tempHome();
    writeRaw(t, JSON.stringify({ enabled: true, port: 5000, extra: 1 }));
    const state = loadState(t.env);
    expect(state).toEqual({ version: 1, enabled: true, port: 5000, secret: expect.stringMatching(SECRET), appUrl: "", devices: [], extra: 1 });
    expect(readJson(t.file)).toEqual(state);
    expect(loadState(t.env).secret).toBe(state.secret);
  });

  test("replaces values of the wrong type by the defaults", () => {
    const t = tempHome();
    const device = { id: "0123456789abcdef", name: "Test Phone", tokenHash: "00".repeat(32), origin: "", createdAt: 1, lastSeenAt: 2 };
    writeRaw(t, JSON.stringify({ version: "1", enabled: "false", port: "abc", secret: "short", appUrl: 5, devices: [null, 7, device, "x", [1]] }));
    const state = loadState(t.env);
    expect(state).toEqual({ version: 1, enabled: false, port: 47821, secret: expect.stringMatching(SECRET), appUrl: "", devices: [device] });
    expect(readJson(t.file)).toEqual(state);
    for (const port of [0, 70000, 80.5, -1, "5000"]) {
      writeRaw(t, JSON.stringify({ ...state, port }));
      expect(loadState(t.env).port).toBe(47821);
    }
    writeRaw(t, JSON.stringify({ ...state, devices: "none" }));
    expect(loadState(t.env).devices).toEqual([]);
  });

  test("a corrupt file is renamed aside and replaced by the defaults", () => {
    const t = tempHome();
    writeRaw(t, '{"enabled": tru');
    const before = Date.now();
    const state = loadState(t.env);
    const after = Date.now();
    expect(state).toEqual({ version: 1, enabled: false, port: 47821, secret: expect.stringMatching(SECRET), appUrl: "", devices: [] });
    const aside = fs.readdirSync(t.dir).filter((name) => name.startsWith("state.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(aside[0]).toMatch(/^state\.json\.corrupt-\d+$/);
    const stamp = Number(aside[0].slice("state.json.corrupt-".length));
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(stamp).toBeLessThanOrEqual(after);
    expect(fs.readFileSync(path.join(t.dir, aside[0]), "utf8")).toBe('{"enabled": tru'); // kept for the person to look at
    expect(fs.readdirSync(t.dir).sort()).toEqual([aside[0], "state.json"].sort());
    expect(readJson(t.file)).toEqual(state);
    expect(mode(t.file)).toBe(0o600);
    expect(mode(path.join(t.dir, aside[0]))).toBe(0o600);
  });

  test("JSON that is not an object counts as corrupt", () => {
    for (const content of ["[]", "null", '"text"', "42", "true", ""]) {
      const t = tempHome();
      writeRaw(t, content);
      const state = loadState(t.env);
      expect(state.secret).toMatch(SECRET);
      expect(fs.readdirSync(t.dir).filter((name) => name.startsWith("state.json.corrupt-"))).toHaveLength(1);
      expect(readJson(t.file)).toEqual(state);
    }
  });

  test("a corrupt file that another window repairs while we look is left alone", () => {
    const t = tempHome();
    writeRaw(t, '{"enabled": tru');
    const theirs = { version: 1, enabled: true, port: 5000, secret: "ab".repeat(32), appUrl: "", devices: [] };
    const realRead = fs.readFileSync;
    let reads = 0;
    (fs as any).readFileSync = (...args: any[]) => {
      // the other window's repair lands between our first read of the file and the check before we move it
      if (args[0] === t.file && ++reads === 2) fs.writeFileSync(t.file, JSON.stringify(theirs));
      return (realRead as any)(...args);
    };
    let state;
    try {
      state = loadState(t.env);
    } finally {
      (fs as any).readFileSync = realRead;
    }
    expect(state).toEqual(theirs);
    expect(readJson(t.file)).toEqual(theirs);
    expect(fs.readdirSync(t.dir)).toEqual(["state.json"]); // their file was not moved aside
  });

  test("a file that starts with a byte order mark loads", () => {
    const t = tempHome();
    const secret = "cd".repeat(32);
    writeRaw(t, `\ufeff${JSON.stringify({ version: 1, enabled: true, port: 5000, secret, appUrl: "", devices: [] })}`);
    expect(loadState(t.env)).toMatchObject({ enabled: true, port: 5000, secret });
    expect(fs.readdirSync(t.dir)).toEqual(["state.json"]);
  });

  test("falls back to a rename on a file system without hard links", () => {
    const { env, dir, file } = tempHome();
    const realLink = fs.linkSync;
    (fs as any).linkSync = () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    };
    let state;
    try {
      state = loadState(env);
    } finally {
      (fs as any).linkSync = realLink;
    }
    expect(state.secret).toMatch(SECRET);
    expect(readJson(file)).toEqual(state);
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
    expect(loadState(env).secret).toBe(state.secret);
  });

  test("windows that start at the same moment agree on one secret", async () => {
    // Eight processes make the first load of a state file at the same moment. A race is a matter of
    // luck, so it happens in several rounds, each in a fresh directory.
    const ROUNDS = 6;
    const { dir } = tempHome();
    const startAt = Date.now() + GATE_MS;
    const script = `const { loadState } = require(${JSON.stringify(STORE_PATH)});
      const secrets = [];
      for (let round = 0; round < ${ROUNDS}; round++) {
        while (Date.now() < ${startAt} + round * 40) {}
        secrets.push(loadState({ CCE_REMOTE_HOME: ${JSON.stringify(dir)} + "/round" + round }).secret);
      }
      process.stdout.write(secrets.join(","));`;
    const outputs = await Promise.all(Array.from({ length: 8 }, () => runScript(script, {})));
    const perProcess = outputs.map((output) => output.split(","));
    for (let round = 0; round < ROUNDS; round++) {
      const roundDir = path.join(dir, `round${round}`);
      const secrets = perProcess.map((list) => list[round]);
      expect(secrets[0]).toMatch(SECRET);
      expect(new Set(secrets).size).toBe(1);
      expect(loadState({ CCE_REMOTE_HOME: roundDir }).secret).toBe(secrets[0]);
      expect(fs.readdirSync(roundDir)).toEqual(["state.json"]); // no temp files, nothing moved aside as corrupt
    }
  });
});

describe("saveState", () => {
  test("writes the JSON with mode 0600 and leaves no temp file behind", () => {
    const { env, dir, file } = tempHome();
    const state = loadState(env);
    saveState({ ...state, enabled: true, appUrl: "https://app.example.test" }, env);
    expect(readJson(file)).toEqual({ ...state, enabled: true, appUrl: "https://app.example.test" });
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });

  test("creates the directory when it is missing", () => {
    const { env, dir, file } = tempHome();
    saveState({ version: 1, enabled: false, port: 47821, secret: "ef".repeat(32), appUrl: "", devices: [] }, env);
    expect(mode(dir)).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(loadState(env).secret).toBe("ef".repeat(32));
  });

  test("the file is 0600 whatever the umask", () => {
    const { env, file } = tempHome();
    const state = loadState(env);
    const old = process.umask(0o277);
    try {
      saveState({ ...state, enabled: true }, env);
    } finally {
      process.umask(old);
    }
    expect(mode(file)).toBe(0o600);
  });

  test("replaces a file with wider permissions by a 0600 one", () => {
    const { env, file } = tempHome();
    const state = loadState(env);
    fs.chmodSync(file, 0o644);
    saveState({ ...state, enabled: true }, env);
    expect(mode(file)).toBe(0o600);
  });

  test("rejects what is not an object, before touching the file", () => {
    const { env, file } = tempHome();
    const state = loadState(env);
    const before = fs.readFileSync(file, "utf8");
    // by message: a null or undefined state would be a TypeError anyway, from reading its secret
    for (const bad of [null, undefined, "text", 5, [state]]) expect(() => saveState(bad as any, env)).toThrow(/state must be an object/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("refuses a state without a valid secret, before touching anything", () => {
    const { env, dir } = tempHome(); // neither the directory nor the file exists
    const state = { version: 1, enabled: false, port: 47821, appUrl: "", devices: [] };
    const hex = "ab".repeat(32);
    // missing, empty, too short, too long (at either end), not hex, not text
    const bad: unknown[] = [undefined, null, "", "short", hex.slice(1), `${hex}a`, `a${hex}`, `${hex}\n`, "zz".repeat(32), 5, [hex], { value: hex }];
    for (const secret of bad) expect(() => saveState({ ...state, secret } as any, env)).toThrow(TypeError);
    expect(() => saveState(state as any, env)).toThrow(TypeError); // no secret key at all
    expect(() => saveState(Promise.resolve({ ...state, secret: hex }) as any, env)).toThrow(TypeError); // what an async function hands back
    expect(fs.existsSync(dir)).toBe(false); // not even the directory was made
  });

  test("an upper-case hex secret is as good as a lower-case one", () => {
    const t = tempHome();
    const secret = "AB".repeat(32);
    saveState({ version: 1, enabled: false, port: 47821, secret, appUrl: "", devices: [] }, t.env);
    expect(readJson(t.file).secret).toBe(secret);
    expect(loadState(t.env).secret).toBe(secret); // loadState does not replace it either
  });

  test("a write that fails leaves no temp file", () => {
    const { env, dir, file } = tempHome();
    fs.mkdirSync(file, { recursive: true }); // a directory where the file should go: the rename fails
    let error: any;
    try {
      saveState({ version: 1, enabled: false, port: 47821, secret: "ab".repeat(32), appUrl: "", devices: [] }, env);
    } catch (e) {
      error = e;
    }
    expect(error?.code).toMatch(/^E[A-Z]+$/); // the file system's refusal, not a check of ours
    expect(fs.readdirSync(dir)).toEqual(["state.json"]);
  });
});

describe("updateState", () => {
  test("applies a change made in place, saves it and returns it", () => {
    const { env, file } = tempHome();
    const before = loadState(env);
    const next = updateState((s) => {
      s.enabled = true;
      s.devices.push({ id: "0123456789abcdef", name: "Test Phone", tokenHash: "11".repeat(32), origin: "https://app.example.test", createdAt: 1, lastSeenAt: 1 });
    }, env);
    expect(next).toEqual({ ...before, enabled: true, devices: [expect.objectContaining({ id: "0123456789abcdef" })] });
    expect(readJson(file)).toEqual(next);
  });

  test("keeps what another window wrote since the state was loaded", () => {
    const { env, file } = tempHome();
    const stale = loadState(env); // what this window read earlier
    saveState({ ...stale, appUrl: "https://app.example.test" }, env); // another window changes another key
    const next = updateState((s) => {
      s.enabled = true;
    }, env);
    expect(next.appUrl).toBe("https://app.example.test");
    expect(next.enabled).toBe(true);
    expect(readJson(file)).toEqual({ ...stale, appUrl: "https://app.example.test", enabled: true });
  });

  test("keeps unknown keys", () => {
    const t = tempHome();
    const secret = "12".repeat(32);
    writeRaw(t, JSON.stringify({ version: 1, enabled: false, port: 47821, secret, appUrl: "", devices: [], later: { a: 1 } }));
    updateState((s) => {
      s.enabled = true;
    }, t.env);
    expect(readJson(t.file)).toEqual({ version: 1, enabled: true, port: 47821, secret, appUrl: "", devices: [], later: { a: 1 } });
  });

  test("an object returned by the function replaces the state; any other return value is ignored", () => {
    const { env, file } = tempHome();
    const before = loadState(env);
    const replaced = updateState((s) => ({ ...s, port: 5000 }), env);
    expect(replaced).toEqual({ ...before, port: 5000 });
    expect(readJson(file).port).toBe(5000);
    // an arrow function that returns its assignment hands back `true`: the in-place change still counts
    const assigned = updateState((s) => (s.enabled = true) as any, env);
    expect(assigned.enabled).toBe(true);
    expect(assigned.port).toBe(5000);
    expect(readJson(file)).toEqual({ ...before, port: 5000, enabled: true });
    const pushed = updateState((s) => s.devices.push({} as any) as any, env);
    expect(pushed.devices).toHaveLength(1);
  });

  /** The error that `updateState(fn)` throws, or undefined when it does not. */
  function thrownBy(fn: (s: any) => unknown, env: Record<string, string>): unknown {
    try {
      updateState(fn, env);
    } catch (error) {
      return error;
    }
    return undefined;
  }

  const DEVICE = { id: "0123456789abcdef", name: "Test Phone", tokenHash: "11".repeat(32), origin: "https://app.example.test", createdAt: 1, lastSeenAt: 1 };

  test("refuses an async function and writes nothing", () => {
    const { env, file } = tempHome();
    const before = loadState(env);
    const bytes = fs.readFileSync(file, "utf8");
    // a Promise is an object: taken for the new state it would wipe the secret and every pairing
    expect(() =>
      updateState((async (s: any) => {
        s.enabled = true;
      }) as any, env),
    ).toThrow(/must not be async/);
    expect(() => updateState((() => ({ then() {} })) as any, env)).toThrow(/must not be async/); // any thenable
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(loadState(env)).toEqual(before);
  });

  test("a promise that rejects later is not left unhandled", async () => {
    // In a child process: bun test does not hand an unhandled rejection to a listener inside the test.
    const { env } = tempHome();
    const script = `const { updateState } = require(${JSON.stringify(STORE_PATH)});
      const seen = [];
      process.on("unhandledRejection", (reason) => seen.push("unhandled: " + reason.message));
      try {
        updateState(async () => { throw new Error("late failure"); });
      } catch (error) {
        seen.push("refused: " + error.constructor.name);
      }
      setTimeout(() => process.stdout.write(JSON.stringify(seen)), 50);`;
    expect(JSON.parse(await runScript(script, env))).toEqual(["refused: TypeError"]);
  });

  test("refuses a return value that is not a state, and writes nothing", () => {
    const { env, file } = tempHome();
    const before = updateState((s) => {
      s.devices.push({ ...DEVICE });
    }, env);
    const bytes = fs.readFileSync(file, "utf8");
    const slips: Array<[string, (s: any) => unknown]> = [
      ["a lookup of the device", (s) => s.devices.find((d: any) => d.id === DEVICE.id)],
      ["the device it updated", (s) => Object.assign(s.devices[0], { lastSeenAt: 99 })],
      ["a part of the state", (s) => ({ devices: s.devices })],
      ["an empty object", () => ({})],
      ["a copy without the secret", (s) => ({ ...s, secret: undefined })],
    ];
    // compared as text with the label in it, so that a failure says which slip got through
    for (const [what, slip] of slips) expect(`${what}: ${thrownBy(slip, env) instanceof TypeError}`).toBe(`${what}: true`);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes); // not a byte changed
    expect(loadState(env)).toEqual(before); // same secret, same device
  });

  test("refuses a change that removes or breaks the secret, and writes nothing", () => {
    const { env, file } = tempHome();
    const before = loadState(env);
    const bytes = fs.readFileSync(file, "utf8");
    const slips: Array<[string, (s: any) => void]> = [
      ["clearing it", (s) => void (s.secret = "")],
      ["deleting it", (s) => void delete s.secret],
      ["a secret of the wrong length", (s) => void (s.secret = "ab".repeat(31))],
      ["a secret that is not hex", (s) => void (s.secret = "zz".repeat(32))],
    ];
    for (const [what, slip] of slips) expect(`${what}: ${thrownBy(slip, env) instanceof TypeError}`).toBe(`${what}: true`);
    expect(fs.readFileSync(file, "utf8")).toBe(bytes);
    expect(loadState(env).secret).toBe(before.secret);
  });

  test("a function that returns a copy of the state, with its secret, still works", () => {
    const { env, file } = tempHome();
    const before = loadState(env);
    const next = updateState((s) => ({ ...s, devices: [{ ...DEVICE }] }), env);
    expect(next).toEqual({ ...before, devices: [DEVICE] });
    expect(readJson(file)).toEqual(next);
  });

  test("creates the file when there is none", () => {
    const { env, file } = tempHome();
    const next = updateState((s) => {
      s.appUrl = "https://app.example.test";
    }, env);
    expect(next.secret).toMatch(SECRET);
    expect(readJson(file)).toEqual(next);
    expect(mode(file)).toBe(0o600);
  });

  test("writes nothing when the function throws", () => {
    const { env, file } = tempHome();
    loadState(env);
    const before = fs.readFileSync(file, "utf8");
    expect(() =>
      updateState((s) => {
        s.enabled = true;
        throw new Error("nope");
      }, env),
    ).toThrow("nope");
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  test("updates from several processes at once never tear the file", async () => {
    const { env, dir, file } = tempHome();
    const secret = loadState(env).secret;
    const startAt = Date.now() + GATE_MS;
    const script = (n: number) =>
      `const { updateState } = require(${JSON.stringify(STORE_PATH)}); while (Date.now() < ${startAt}) {} for (let i = 0; i < 40; i++) updateState((s) => { s["w${n}"] = i; });`;
    await Promise.all(Array.from({ length: 6 }, (_, n) => runScript(script(n), env)));
    const state = readJson(file); // valid JSON, whatever the interleaving was
    expect(state.secret).toBe(secret);
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["state.json"]); // no temp files, nothing moved aside as corrupt
  });
});

describe("effectivePort", () => {
  test("is the state's port", () => {
    expect(effectivePort({ port: 5000 } as any, {})).toBe(5000);
  });

  test("CCE_REMOTE_PORT wins", () => {
    expect(effectivePort({ port: 5000 } as any, { CCE_REMOTE_PORT: "6000" })).toBe(6000);
    expect(effectivePort({ port: 5000 } as any, { CCE_REMOTE_PORT: " 6001 " })).toBe(6001);
    expect(effectivePort({ port: 5000 } as any, { CCE_REMOTE_PORT: "65535" })).toBe(65535);
  });

  test("a CCE_REMOTE_PORT that is not a port is ignored", () => {
    for (const bad of ["", "abc", "0", "70000", "65536", "-1", "80.5", "0x50", "5000abc", "1e3"]) {
      expect(effectivePort({ port: 5000 } as any, { CCE_REMOTE_PORT: bad })).toBe(5000);
    }
  });

  test("falls back to the default port when the state has no usable one", () => {
    expect(effectivePort({} as any, {})).toBe(47821);
    expect(effectivePort({ port: "5000" } as any, {})).toBe(47821);
    expect(effectivePort(undefined as any, {})).toBe(47821);
  });

  test("reads process.env when no env is given", () => {
    const saved = process.env.CCE_REMOTE_PORT;
    process.env.CCE_REMOTE_PORT = "6002";
    try {
      expect(effectivePort({ port: 5000 } as any)).toBe(6002);
    } finally {
      if (saved === undefined) delete process.env.CCE_REMOTE_PORT;
      else process.env.CCE_REMOTE_PORT = saved;
    }
  });
});

describe("watchState", () => {
  test("calls back once for a real change, and not for a rewrite of the same JSON", async () => {
    const { env, file } = tempHome();
    const initial = loadState(env);
    const changes = queue<any>();
    stops.push(watchState((state) => changes.push(state), env, POLL_MS));
    await sleep(100); // the first poll records its baseline

    saveState({ ...initial }, env); // a new file with the same JSON
    fs.writeFileSync(file, JSON.stringify(initial)); // the same JSON, other bytes
    await sleep(QUIET_MS);
    expect(changes.pending).toBe(0);

    updateState((s) => {
      s.enabled = true;
    }, env);
    const state = await changes.next("the change");
    expect(state).toEqual({ ...initial, enabled: true });
    await sleep(QUIET_MS);
    expect(changes.pending).toBe(0); // only once
  });

  test("tells the next change again, and stop() ends the callbacks", async () => {
    const { env } = tempHome();
    loadState(env);
    const changes = queue<any>();
    const stop = watchState((state) => changes.push(state), env, POLL_MS);
    stops.push(stop);
    await sleep(100);
    updateState((s) => {
      s.appUrl = "https://one.example.test";
    }, env);
    expect((await changes.next("the first change")).appUrl).toBe("https://one.example.test");
    updateState((s) => {
      s.appUrl = "https://two.example.test";
    }, env);
    expect((await changes.next("the second change")).appUrl).toBe("https://two.example.test");
    stop();
    stop(); // harmless twice
    updateState((s) => {
      s.appUrl = "https://three.example.test";
    }, env);
    await sleep(QUIET_MS);
    expect(changes.pending).toBe(0);
  });

  test("hands over the full state: defaults filled in, unknown keys kept", async () => {
    const t = tempHome();
    const initial = loadState(t.env);
    const changes = queue<any>();
    stops.push(watchState((state) => changes.push(state), t.env, POLL_MS));
    await sleep(100);
    fs.writeFileSync(t.file, JSON.stringify({ secret: initial.secret, enabled: true, later: 1 }));
    expect(await changes.next("the change")).toEqual({ version: 1, enabled: true, port: 47821, secret: initial.secret, appUrl: "", devices: [], later: 1 });
  });

  test("a state file that appears after the watching began is reported", async () => {
    const t = tempHome(); // neither the directory nor the file exists yet
    const changes = queue<any>();
    stops.push(watchState((state) => changes.push(state), t.env, POLL_MS));
    await sleep(100);
    expect(changes.pending).toBe(0); // looking does not create anything
    expect(fs.existsSync(t.dir)).toBe(false);
    const created = loadState(t.env);
    expect(await changes.next("the new file")).toEqual(created);
  });

  test("writing out the defaults of a file it already reported is no change", async () => {
    const t = tempHome();
    const initial = loadState(t.env);
    const changes = queue<any>();
    stops.push(watchState((state) => changes.push(state), t.env, POLL_MS));
    await sleep(100);
    fs.writeFileSync(t.file, JSON.stringify({ secret: initial.secret, enabled: true }));
    const reported = await changes.next("the change");
    expect(updateState(() => {}, t.env)).toEqual(reported); // loadState stores the repaired form
    expect(readJson(t.file)).toEqual(reported);
    await sleep(QUIET_MS);
    expect(changes.pending).toBe(0);
  });

  test("skips a file without a usable secret until loadState has repaired it", async () => {
    const t = tempHome();
    const initial = loadState(t.env);
    const changes = queue<any>();
    stops.push(watchState((state) => changes.push(state), t.env, POLL_MS));
    await sleep(100);
    for (const content of [{ enabled: true }, { enabled: true, secret: "short" }, { enabled: true, secret: 5 }]) {
      fs.writeFileSync(t.file, JSON.stringify(content)); // written by hand
      await sleep(QUIET_MS);
    }
    expect(changes.pending).toBe(0); // a watcher cannot make a secret, and must not write one
    expect(readJson(t.file)).toEqual({ enabled: true, secret: 5 });

    const repaired = loadState(t.env); // what a window that starts up does
    expect(repaired.enabled).toBe(true);
    expect(repaired.secret).toMatch(SECRET);
    expect(repaired.secret).not.toBe(initial.secret);
    expect(await changes.next("the repaired file")).toEqual(repaired);
  });

  test("skips a file that is not valid or not there, and reports the next good one", async () => {
    const { env, file } = tempHome();
    const initial = loadState(env);
    const changes = queue<any>();
    stops.push(watchState((state) => changes.push(state), env, POLL_MS));
    await sleep(100);

    fs.writeFileSync(file, '{"enabled": tru'); // someone is in the middle of an edit
    await sleep(QUIET_MS);
    fs.writeFileSync(file, "[]");
    await sleep(QUIET_MS);
    fs.rmSync(file);
    await sleep(QUIET_MS);
    expect(changes.pending).toBe(0);
    expect(fs.readdirSync(path.dirname(file))).toEqual([]); // the watcher never repairs, renames or creates anything

    fs.writeFileSync(file, JSON.stringify({ ...initial, port: 5000 }));
    expect((await changes.next("the repaired file")).port).toBe(5000);
  });

  test("does not keep the process alive", async () => {
    const { env } = tempHome();
    const script = `const s = require(${JSON.stringify(STORE_PATH)}); s.loadState(process.env); s.watchState(() => {}, process.env, 50); process.stdout.write("ready");`;
    expect(await runScript(script, env, 8000)).toBe("ready"); // a persistent watcher would never let the script end
  });
});
