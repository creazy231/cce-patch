import { describe, expect, test } from "bun:test";
import { createIdleReader, parseIdleSeconds, userIdleSeconds } from "../lib/idle.js";
import { sleep, withTimeout } from "./support";

// Every reader in here gets a stub `run`, so no test depends on the machine it runs on. The last two
// tests use the default reader: the real `ioreg` on macOS (read-only, local), nothing elsewhere.

/** What `ioreg -c IOHIDSystem -d 4` prints, cut down to the parts around the idle time. */
const ioreg = (nanoseconds: string) => `+-o Root  <class IORegistryEntry, id 0x100000100, retain 25>
  +-o IOHIDSystem  <class IOHIDSystem, id 0x10000020d, registered, matched, active, busy 0 (0 ms), retain 8>
    | {
    |   "IOProbeScore" = 0
    |   "HIDIdleTime" = ${nanoseconds}
    |   "HIDScrollCountIgnoreMomentumScrolls" = Yes
    | }
    |
`;

const IOREG = "/usr/sbin/ioreg";
const IOREG_ARGS = ["-c", "IOHIDSystem", "-d", "4"];

interface RunCall {
  file: string;
  args: string[];
  options: { timeoutMs: number };
}

/** A `run` that records its calls and answers with whatever `output()` gives at that moment. */
function fakeRun(output: () => unknown = () => ioreg("125000000000")) {
  const calls: RunCall[] = [];
  const run = async (file: string, args: string[], options: { timeoutMs: number }) => {
    calls.push({ file, args, options });
    return output();
  };
  return { run: run as any, calls };
}

describe("parseIdleSeconds", () => {
  test("parses HIDIdleTime", () => {
    expect(parseIdleSeconds(ioreg("125000000000"))).toBe(125);
    expect(parseIdleSeconds(ioreg("0"))).toBe(0);
    expect(parseIdleSeconds(ioreg("1500000000"))).toBe(1.5);
    expect(parseIdleSeconds('"HIDIdleTime" = 125000000000')).toBe(125);
    expect(parseIdleSeconds('"HIDIdleTime"=125000000000')).toBe(125);
    expect(parseIdleSeconds("no idle time in here")).toBeNull();
    expect(parseIdleSeconds("")).toBeNull();
  });

  test("takes the first HIDIdleTime", () => {
    expect(parseIdleSeconds(`${ioreg("3000000000")}${ioreg("9000000000")}`)).toBe(3);
  });

  test("is null unless the value is digits, and for anything that is not text", () => {
    expect(parseIdleSeconds('"HIDIdleTime" = Yes')).toBeNull();
    expect(parseIdleSeconds('"HIDIdleTime" = -5')).toBeNull();
    expect(parseIdleSeconds('"HIDIdleTime" = ')).toBeNull();
    expect(parseIdleSeconds('"HIDIdleTimeX" = 5')).toBeNull();
    expect(parseIdleSeconds('"IOHIDIdleTime" = 5')).toBeNull();
    expect(parseIdleSeconds(undefined as any)).toBeNull();
    expect(parseIdleSeconds(null as any)).toBeNull();
    expect(parseIdleSeconds(125 as any)).toBeNull();
    expect(parseIdleSeconds(Buffer.from(ioreg("5000000000")) as any)).toBeNull();
  });
});

describe("createIdleReader", () => {
  test("reads ioreg on macOS and caches the result", async () => {
    let clock = 1_000_000;
    let output = ioreg("125000000000");
    const { run, calls } = fakeRun(() => output);
    const read = createIdleReader({ platform: "darwin", run, now: () => clock });

    expect(await read()).toBe(125);
    expect(calls).toEqual([{ file: IOREG, args: IOREG_ARGS, options: { timeoutMs: 2000 } }]);

    clock += 4999; // within 5 s: the result is reused
    output = ioreg("999000000000");
    expect(await read()).toBe(125);
    expect(calls).toHaveLength(1);

    clock += 1; // 5 s after the read: asks again
    expect(await read()).toBe(999);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);

    clock += 4999;
    expect(await read()).toBe(999);
    expect(calls).toHaveLength(2);
  });

  test("cacheMs and timeoutMs can be set", async () => {
    let clock = 0;
    const { run, calls } = fakeRun();
    const read = createIdleReader({ platform: "darwin", run, now: () => clock, cacheMs: 100, timeoutMs: 750 });
    await read();
    clock = 99;
    await read();
    expect(calls).toHaveLength(1);
    clock = 100;
    await read();
    expect(calls).toHaveLength(2);
    expect(calls[0].options).toEqual({ timeoutMs: 750 });
  });

  test("callers that ask while ioreg is running share that one run", async () => {
    let finish: (text: string) => void = () => {};
    const calls: RunCall[] = [];
    const run = (file: string, args: string[], options: { timeoutMs: number }) => {
      calls.push({ file, args, options });
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    };
    const read = createIdleReader({ platform: "darwin", run });
    const reads = [read(), read(), read()];
    await sleep(5);
    expect(calls).toHaveLength(1);
    finish(ioreg("42000000000"));
    expect(await Promise.all(reads)).toEqual([42, 42, 42]);
    expect(calls).toHaveLength(1);
  });

  test("a run that never settles gives Infinity after timeoutMs + 500 ms, so the shared read always settles", async () => {
    const run = () => new Promise<string>(() => {});
    const read = createIdleReader({ platform: "darwin", run, timeoutMs: 20 });
    const reads = [read(), read()];
    expect(await withTimeout(Promise.all(reads), "the idle read to settle", 2000)).toEqual([Infinity, Infinity]);
  });

  test("accepts what run gives as text, a Buffer or {stdout}", async () => {
    const text = ioreg("7000000000");
    for (const output of [text, Buffer.from(text), { stdout: text, stderr: "" }, { stdout: Buffer.from(text) }]) {
      const { run } = fakeRun(() => output);
      expect(await createIdleReader({ platform: "darwin", run })()).toBe(7);
    }
  });

  test("counts as away when it can't tell", async () => {
    // not macOS: nothing is run
    for (const platform of ["linux", "win32", "freebsd"]) {
      const { run, calls } = fakeRun();
      expect(await createIdleReader({ platform, run })()).toBe(Infinity);
      expect(calls).toHaveLength(0);
    }

    // a run that fails: rejects, throws, or never was a function that returns a promise
    const rejecting = createIdleReader({ platform: "darwin", run: (async () => { throw new Error("ioreg: not found"); }) as any });
    expect(await rejecting()).toBe(Infinity);
    const throwing = createIdleReader({ platform: "darwin", run: (() => { throw new Error("spawn failed"); }) as any });
    expect(await throwing()).toBe(Infinity);

    // output without the field, or that is not output at all
    for (const output of ["", "ioreg: no matching entries", ioreg("Yes"), undefined, null, 42, {}, { stdout: undefined }]) {
      const { run } = fakeRun(() => output);
      expect(await createIdleReader({ platform: "darwin", run })()).toBe(Infinity);
    }
  });

  test("a failed read is cached like any other, so a broken ioreg is not run on every call", async () => {
    let clock = 0;
    let failing = true;
    const { run, calls } = fakeRun(() => {
      if (failing) throw new Error("ioreg timed out");
      return ioreg("5000000000");
    });
    const read = createIdleReader({ platform: "darwin", run, now: () => clock });
    expect(await read()).toBe(Infinity);
    clock += 4999;
    failing = false;
    expect(await read()).toBe(Infinity);
    expect(calls).toHaveLength(1);
    clock += 1;
    expect(await read()).toBe(5);
    expect(calls).toHaveLength(2);
  });

  test("a clock that was set back does not keep an old result", async () => {
    let clock = 1_000_000;
    const { run, calls } = fakeRun();
    const read = createIdleReader({ platform: "darwin", run, now: () => clock });
    await read();
    clock -= 3_600_000; // an hour back
    await read();
    expect(calls).toHaveLength(2);
  });

  test("two readers do not share a cache", async () => {
    const { run, calls } = fakeRun();
    const first = createIdleReader({ platform: "darwin", run });
    const second = createIdleReader({ platform: "darwin", run });
    await first();
    await second();
    expect(calls).toHaveLength(2);
  });
});

describe("userIdleSeconds", () => {
  test("is a function that gives a promise", async () => {
    expect(typeof userIdleSeconds).toBe("function");
    const pending = userIdleSeconds();
    expect(pending).toBeInstanceOf(Promise);
    await pending;
  });

  test.skipIf(process.platform !== "darwin")("reads the real HIDIdleTime on macOS", async () => {
    // Every failure is Infinity, so this is the one test that shows the default runner works
    const seconds = await userIdleSeconds();
    expect(Number.isFinite(seconds)).toBe(true);
    expect(seconds).toBeGreaterThanOrEqual(0);
  });

  test.skipIf(process.platform === "darwin")("is Infinity where there is no ioreg", async () => {
    expect(await userIdleSeconds()).toBe(Infinity);
  });
});
