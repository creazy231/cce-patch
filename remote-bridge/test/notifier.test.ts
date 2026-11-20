import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import { NOTIFIER_LIMITS, Notifier, buildPayload } from "../lib/notifier.js";
import { sleep } from "./support";

// The notifier decides who gets a Web Push and builds its payload. Every collaborator is a fake:
// state and updateState (with a write count), isLooking, idleSeconds, send (recording calls and
// answering a scripted status) and the timers (driven by hand). No push leaves this file.

const T0 = 1_900_000_000_000;
const MAC = "example-mac";
const ID = "aaaaaaaaaaaa";
const APPLE = "https://web.push.apple.com/QAbc";
const SUBJECT = "https://app.example.test";

const b = (text: string) => Buffer.from(text, "base64url");

interface Subscriber {
  privateKey: Buffer;
  publicKey: Buffer;
  auth: Buffer;
  keys: { p256dh: string; auth: string };
}

function makeSubscriber(): Subscriber {
  const ecdh = crypto.createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const publicKey = ecdh.getPublicKey();
  return { privateKey: ecdh.getPrivateKey(), publicKey, auth, keys: { p256dh: publicKey.toString("base64url"), auth: auth.toString("base64url") } };
}

interface Jwk {
  kty: string;
  crv: string;
  x: string;
  y: string;
  d: string;
  [member: string]: unknown;
}

function makeVapid() {
  const { privateKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const privateJwk = privateKey.export({ format: "jwk" }) as unknown as Jwk;
  const publicKey = Buffer.concat([Buffer.from([4]), b(privateJwk.x), b(privateJwk.y)]).toString("base64url");
  return { publicKey, privateJwk };
}

const SUBSCRIBER = makeSubscriber();
const VAPID = makeVapid();

/** A push_set frame as the app sends it. */
function pushFrame(overrides: Record<string, unknown> = {}) {
  return {
    subscription: { endpoint: APPLE, keys: SUBSCRIBER.keys },
    vapid: { publicKey: VAPID.publicKey, privateJwk: { ...VAPID.privateJwk, ext: true, key_ops: ["sign"] } },
    subject: SUBJECT,
    prefs: { waiting: true, done: true, onlyAway: true, details: true },
    ...overrides,
  };
}

const bytes = (length: number, first = 4) => Buffer.concat([Buffer.from([first]), crypto.randomBytes(length - 1)]).toString("base64url");

/** Manual timers: every callback runs when a test advances the clock. */
function fakeTimers() {
  let now = T0;
  const jobs: Array<{ at: number; fn: () => void; cleared: boolean; unref: () => void }> = [];
  const setTimeout = (fn: () => void, ms: number) => {
    const timer = { at: now + Math.max(0, ms), fn, cleared: false, unref: () => {} };
    jobs.push(timer);
    return timer;
  };
  const clearTimeout = (timer: { cleared: boolean } | undefined) => {
    if (timer) timer.cleared = true;
  };
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = jobs.filter((job) => !job.cleared && job.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      now = due.at;
      due.cleared = true;
      due.fn();
    }
    now = end;
  };
  return {
    setTimeout,
    clearTimeout,
    advance,
    get now() {
      return now;
    },
    set now(value: number) {
      now = value;
    },
  };
}

interface Answer {
  ok: boolean;
  status: number;
  gone: boolean;
}

interface HarnessOptions {
  looking?: boolean;
  idle?: number | (() => Promise<number>);
  answer?: (call: number, push: any) => Answer | Promise<Answer>;
  limits?: Record<string, unknown>;
}

function harness(options: HarnessOptions = {}) {
  const db: any = { devices: [{ id: "dev1", name: "iPhone", origin: "https://app.example.test", createdAt: T0, lastSeenAt: T0 }] };
  const writes = { count: 0 };
  const logs: string[] = [];
  const calls: Array<{ push: any; options: any }> = [];
  const flags = { looking: options.looking ?? false };
  const idle = { value: options.idle ?? 300, calls: 0 };
  const answer = options.answer ?? (() => ({ ok: true, status: 201, gone: false }));
  const clock = fakeTimers();
  const sendOptions = { marker: "send-options" };
  const notifier = new Notifier({
    state: () => db,
    updateState: (fn: (state: any) => void) => {
      writes.count++;
      fn(db);
      return db;
    },
    isLooking: () => flags.looking,
    macName: () => MAC,
    log: (message: string, level: string) => logs.push(`${level} ${message}`),
    now: () => clock.now,
    idleSeconds: () => {
      idle.calls++;
      return typeof idle.value === "function" ? idle.value() : Promise.resolve(idle.value);
    },
    send: async (push: any, sendOpts: any) => {
      calls.push({ push, options: sendOpts });
      return answer(calls.length, push);
    },
    sendOptions,
    timers: { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout },
    limits: { ...NOTIFIER_LIMITS, ...options.limits },
  });
  return { db, writes, logs, calls, flags, idle, clock, notifier, sendOptions };
}

const waiting = (session = "s1", requestId = "r1", prompt: any = { kind: "tool", toolName: "Bash", text: "npm test" }, title = "Fix the flaky test") => ({
  kind: "waiting",
  session,
  requestId,
  title,
  prompt,
});
const open = (session = "s1", requestIds: string[] = []) => ({ kind: "open", session, requestIds });
const done = (session = "s1", text = "All tests pass.") => ({ kind: "done", session, title: "Fix the flaky test", isError: false, durationMs: 1200, text });

function attention(h: ReturnType<typeof harness>, ev: any, key = "w1", project = ID, projectName = "cce-patch") {
  h.notifier.attention({ key, project, projectName, ev });
}

/** Lets the notifier's async send finish. */
const settle = () => sleep(5);

function withPush(h: ReturnType<typeof harness>, prefs: Record<string, boolean> = { waiting: true, done: true, onlyAway: false, details: true }) {
  const result = h.notifier.setPush("dev1", pushFrame({ prefs }));
  expect(result).toEqual({ ok: true });
  return result;
}

describe("setPush", () => {
  test("setPush validates and stores, and writes only changes", () => {
    const h = harness();
    const frame = pushFrame();
    expect(h.notifier.setPush("dev1", frame)).toEqual({ ok: true });
    expect(h.writes.count).toBe(1);
    const stored = h.db.devices[0].push;
    expect(stored.endpoint).toBe(APPLE);
    expect(stored.keys).toEqual(SUBSCRIBER.keys);
    expect(stored.subject).toBe(SUBJECT);
    expect(stored.prefs).toEqual({ waiting: true, done: true, onlyAway: true, details: true });
    expect(stored.createdAt).toBe(T0);
    expect(Object.keys(stored.vapid.privateJwk).sort()).toEqual(["crv", "d", "kty", "x", "y"]); // ext and key_ops dropped
    expect(stored.vapid.publicKey).toBe(VAPID.publicKey);

    expect(h.notifier.setPush("dev1", frame)).toEqual({ ok: true });
    expect(h.writes.count).toBe(1); // nothing changed

    h.clock.now = T0 + 1_000;
    const changed = pushFrame({ prefs: { waiting: true, done: true, onlyAway: true, details: false } });
    expect(h.notifier.setPush("dev1", changed)).toEqual({ ok: true });
    expect(h.writes.count).toBe(2);
    expect(h.db.devices[0].push.createdAt).toBe(T0); // kept
    expect(h.db.devices[0].push.prefs.details).toBe(false);

    const noPrefs = pushFrame();
    delete (noPrefs as any).prefs;
    expect(h.notifier.setPush("dev1", noPrefs)).toEqual({ ok: true });
    expect(h.writes.count).toBe(3);
    expect(h.db.devices[0].push.prefs).toEqual({ waiting: true, done: true, onlyAway: true, details: true });
  });

  test("setPush refuses bad frames and stores nothing", () => {
    const cases: Array<[string, unknown, string]> = [
      ["an endpoint off the allowlist", pushFrame({ subscription: { endpoint: "https://example.com/push", keys: SUBSCRIBER.keys } }), "bad_endpoint"],
      ["a p256dh of 64 bytes", pushFrame({ subscription: { endpoint: APPLE, keys: { ...SUBSCRIBER.keys, p256dh: bytes(64) } } }), "bad_keys"],
      ["an auth of 15 bytes", pushFrame({ subscription: { endpoint: APPLE, keys: { ...SUBSCRIBER.keys, auth: bytes(15) } } }), "bad_keys"],
      ["a p256dh that is not on the curve", pushFrame({ subscription: { endpoint: APPLE, keys: { ...SUBSCRIBER.keys, p256dh: bytes(65) } } }), "bad_keys"],
      ["a JWK of another key pair", pushFrame({ vapid: { publicKey: VAPID.publicKey, privateJwk: makeVapid().privateJwk } }), "bad_keys"],
      ["a javascript subject", pushFrame({ subject: "javascript:x" }), "bad_request"],
      ["an http subject", pushFrame({ subject: "http://x" }), "bad_request"],
      ["a 10000-character subject", pushFrame({ subject: `https://${"a".repeat(10_000)}` }), "bad_request"],
      ["a non-boolean pref", pushFrame({ prefs: { waiting: "yes", done: true, onlyAway: true, details: true } }), "bad_request"],
      ["prefs that are not a record", pushFrame({ prefs: [] }), "bad_request"],
      ["a non-record frame", null, "bad_request"],
      ["a string frame", "frame", "bad_request"],
      ["an array frame", [], "bad_request"],
      ["a number frame", 42, "bad_request"],
      ["no subscription", pushFrame({ subscription: undefined }), "bad_request"],
    ];
    for (const [what, frame, error] of cases) {
      const h = harness();
      expect({ what, result: h.notifier.setPush("dev1", frame as any), writes: h.writes.count }).toEqual({ what, result: { ok: false, error }, writes: 0 });
    }
  });

  test("clearPush removes the subscription, and hasPush follows it", () => {
    const h = harness();
    expect(h.notifier.hasPush("dev1")).toBe(false);
    withPush(h);
    expect(h.notifier.hasPush("dev1")).toBe(true);
    expect(h.notifier.clearPush("dev1")).toEqual({ ok: true });
    expect(h.notifier.hasPush("dev1")).toBe(false);
    expect(h.db.devices[0].push).toBeUndefined();
    expect(h.notifier.clearPush("dev1")).toEqual({ ok: true }); // nothing to remove
  });
});

describe("attention", () => {
  test("waiting pushes after the grace unless answered", async () => {
    const h = harness();
    withPush(h);
    attention(h, waiting("s1", "r1"));
    await settle();
    expect(h.calls).toHaveLength(0); // still in the grace
    h.clock.advance(4000);
    await settle();
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].push.payload).toContain("Allow Bash: npm test?");

    const answered = harness();
    withPush(answered);
    attention(answered, waiting("s2", "r2"));
    attention(answered, open("s2", [])); // answered on the Mac within the grace
    answered.clock.advance(4000);
    await settle();
    expect(answered.calls).toHaveLength(0);
  });

  test("who gets a push", async () => {
    for (const looking of [true, false]) {
      for (const onlyAway of [true, false]) {
        for (const idle of [30, 300]) {
          for (const prefOn of [true, false]) {
            for (const kind of ["waiting", "done"] as const) {
              const h = harness({ looking, idle });
              withPush(h, { waiting: prefOn, done: prefOn, onlyAway, details: true });
              attention(h, kind === "waiting" ? waiting("s1", "r1") : done("s1"));
              h.clock.advance(kind === "waiting" ? 4000 : 0); // done is immediate; only a waiting has a grace
              await settle();
              const expected = !looking && prefOn && !(onlyAway && idle < 120) ? 1 : 0;
              expect({ looking, onlyAway, idle, prefOn, kind, sends: h.calls.length }).toEqual({ looking, onlyAway, idle, prefOn, kind, sends: expected });
            }
          }
        }
      }
    }
  });

  test("one push per prompt, and a cap per device", async () => {
    const dedupe = harness();
    withPush(dedupe);
    attention(dedupe, waiting("s1", "r1"));
    attention(dedupe, waiting("s1", "r1")); // the same requestId again
    dedupe.clock.advance(4000);
    await settle();
    expect(dedupe.calls).toHaveLength(1);

    const h = harness();
    withPush(h);
    for (let i = 0; i < 13; i++) {
      attention(h, done("s1"));
      await settle();
    }
    expect(h.calls).toHaveLength(12);
    expect(h.logs.filter((line) => line.includes("cap"))).toHaveLength(1);
    h.clock.now = T0 + 60_000;
    attention(h, done("s1"));
    await settle();
    expect(h.calls).toHaveLength(13); // a new minute
  });

  test("an open without prompts drops the session's entry", async () => {
    const h = harness();
    withPush(h);
    attention(h, waiting("s1", "r1"));
    expect(h.notifier._sessions.size).toBe(1);

    attention(h, open("s1", []));
    expect(h.notifier._sessions.size).toBe(0);
    expect(h.notifier.waitingCount()).toBe(0);
  });

  test("the badge counts waiting sessions", async () => {
    const h = harness();
    withPush(h);
    attention(h, waiting("s1", "r1"));
    attention(h, waiting("s2", "r2"));
    expect(h.notifier.waitingCount()).toBe(2);
    attention(h, done("s3"));
    await settle();
    expect(JSON.parse(h.calls[0].push.payload).badge).toBe(2);
    attention(h, open("s1", []));
    expect(h.notifier.waitingCount()).toBe(1);
    attention(h, done("s4"));
    await settle();
    expect(JSON.parse(h.calls[1].push.payload).badge).toBe(1);
    h.notifier.windowRemoved("w1");
    expect(h.notifier.waitingCount()).toBe(0);
    attention(h, done("s5"));
    await settle();
    expect(JSON.parse(h.calls[2].push.payload).badge).toBe(0);
  });

  test("the notifier's payload limit applies to its pushes", async () => {
    const h = harness({ limits: { maxPayloadBytes: 300 } });
    withPush(h);
    attention(h, waiting("s1", "r1", { kind: "question", text: "Q".repeat(200) }, "T".repeat(200)));
    h.clock.advance(4000);
    await settle();

    expect(h.calls).toHaveLength(1);
    expect(Buffer.byteLength(h.calls[0].push.payload)).toBeLessThanOrEqual(300);
  });

  test("a gone subscription is removed, other failures are logged once an hour", async () => {
    const gone = harness({ answer: () => ({ ok: false, status: 410, gone: true }) });
    withPush(gone);
    attention(gone, done("s1"));
    await settle();
    expect(gone.db.devices[0].push).toBeUndefined();

    const changed = harness({
      answer: () => {
        // Another window replaced it meanwhile: a fresh object, as a state read would give.
        changed.db.devices[0].push = { ...changed.db.devices[0].push, endpoint: "https://web.push.apple.com/Other" };
        return { ok: false, status: 410, gone: true };
      },
    });
    withPush(changed);
    attention(changed, done("s1"));
    await settle();
    expect(changed.db.devices[0].push).toBeDefined();

    const failing = harness({ answer: () => ({ ok: false, status: 500, gone: false }) });
    withPush(failing);
    attention(failing, done("s1"));
    await settle();
    attention(failing, done("s1"));
    await settle();
    expect(failing.calls).toHaveLength(2);
    expect(failing.logs).toHaveLength(1);
    expect(failing.logs[0]).toContain("web.push.apple.com");
    expect(failing.logs[0]).not.toContain("/QAbc");
    failing.clock.now = T0 + 3_600_000;
    attention(failing, done("s1"));
    await settle();
    expect(failing.logs).toHaveLength(2);
  });

  test("the idle read is bounded: a timeout counts as away", async () => {
    const h = harness({ idle: () => new Promise<number>(() => {}) });
    withPush(h, { waiting: true, done: true, onlyAway: true, details: true });
    attention(h, done("s1"));
    await settle();
    expect(h.calls).toHaveLength(0); // waiting for the idle read
    h.clock.advance(3000);
    await settle();
    expect(h.calls).toHaveLength(1); // Infinity is away
  });

  test("close stops timers and sends", async () => {
    const h = harness();
    withPush(h);
    attention(h, waiting("s1", "r1"));
    h.notifier.close();
    h.clock.advance(4000);
    await settle();
    expect(h.calls).toHaveLength(0);

    let resolveSend: (answer: Answer) => void = () => {};
    const inFlight = harness({ answer: () => new Promise<Answer>((resolve) => (resolveSend = resolve)) });
    withPush(inFlight);
    attention(inFlight, done("s1"));
    await settle();
    expect(inFlight.calls).toHaveLength(1);
    inFlight.notifier.close();
    resolveSend({ ok: false, status: 500, gone: false });
    await settle();
    expect(inFlight.logs).toEqual([]); // a result after close is ignored, and nothing throws
  });
});

describe("test pushes", () => {
  test("test pushes ignore looking and away", async () => {
    const h = harness({ looking: true, idle: 0 });
    withPush(h);
    const result = await h.notifier.test("dev1");
    expect(result).toEqual({ ok: true });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].options).toBe(h.sendOptions);
    const payload = JSON.parse(h.calls[0].push.payload);
    expect(payload).toMatchObject({ kind: "test", title: "CCE Remote", tag: "cce-test", url: "/" });
    expect(payload.body).toBe(`Notifications from ${MAC} work.`);
    expect(h.calls[0].push.ttl).toBe(60);
    expect(h.calls[0].push.urgency).toBe("high");
  });

  test("a test push carries the waiting badge", async () => {
    const h = harness();
    withPush(h);
    attention(h, waiting("s1", "r1"));
    expect(h.notifier.waitingCount()).toBe(1);

    expect(await h.notifier.test("dev1")).toEqual({ ok: true });
    expect(JSON.parse(h.calls[0].push.payload).badge).toBe(1);
  });

  test("the notifier's payload limit applies to test pushes", async () => {
    const h = harness({ limits: { maxPayloadBytes: 100 } });
    withPush(h);

    expect(await h.notifier.test("dev1")).toEqual({ ok: true });
    expect(Buffer.byteLength(h.calls[0].push.payload)).toBeLessThanOrEqual(100);
  });

  test("test without a subscription, and its failures", async () => {
    const off = harness();
    expect(await off.notifier.test("dev1")).toEqual({ ok: false, error: "push_off" });
    expect(off.calls).toHaveLength(0);

    const gone = harness({ answer: () => ({ ok: false, status: 410, gone: true }) });
    withPush(gone);
    expect(await gone.notifier.test("dev1")).toEqual({ ok: false, error: "push_gone" });
    expect(gone.db.devices[0].push).toBeUndefined();

    const failed = harness({ answer: () => ({ ok: false, status: 500, gone: false }) });
    withPush(failed);
    expect(await failed.notifier.test("dev1")).toEqual({ ok: false, error: "push_failed", status: 500 });
  });
});

describe("buildPayload", () => {
  const base = { mac: "dev1", project: ID, session: "s1", projectName: "cce-patch", badge: 2 };

  test("payloads for each prompt kind and for done, with details", () => {
    const parse = (ev: any, kind = "waiting") => JSON.parse(buildPayload({ ...base, kind, details: true, ev }));
    const question = parse(waiting("s1", "r1", { kind: "question", text: "Which database?" }));
    expect(question).toEqual({ v: 1, kind: "waiting", title: "cce-patch", body: "Fix the flaky test\nClaude asks: Which database?", tag: "dev1:aaaaaaaaaaaa:s1", url: "/?mac=dev1&project=aaaaaaaaaaaa&session=s1", mac: "dev1", badge: 2 });
    expect(parse(waiting("s1", "r1", { kind: "question", text: "" })).body).toBe("Fix the flaky test\nClaude has a question");
    expect(parse(waiting("s1", "r1", { kind: "tool", toolName: "Bash", text: "npm test" })).body).toBe("Fix the flaky test\nAllow Bash: npm test?");
    expect(parse(waiting("s1", "r1", { kind: "tool", toolName: "Bash", text: "" })).body).toBe("Fix the flaky test\nAllow Bash?");
    expect(parse(waiting("s1", "r1", { kind: "plan", text: "" })).body).toBe("Fix the flaky test\nPlan ready for your approval");
    expect(parse(waiting("s1", "r1", { kind: "dialog", text: "" })).body).toBe("Fix the flaky test\nClaude needs your input");
    expect(parse(done("s1", "All tests pass."), "done").body).toBe("Fix the flaky test\nFinished: All tests pass.");
    expect(parse(done("s1", ""), "done").body).toBe("Fix the flaky test\nFinished");
    expect(parse({ ...done("s1", "All tests pass."), isError: true }, "done").body).toBe("Fix the flaky test\nStopped with an error");
    expect(parse({ ...done("s1", ""), title: 42 }, "done").body).toBe("Untitled\nFinished");
    expect(parse({ ...waiting("s1", "r1", { kind: "question", text: "Q" }), title: "" }).body).toBe("Untitled\nClaude asks: Q");
  });

  test("without details the body is generic", () => {
    const parse = (ev: any, kind = "waiting") => JSON.parse(buildPayload({ ...base, kind, details: false, ev }));
    expect(parse(waiting("s1", "r1"))).toMatchObject({ title: "Claude Code", body: "A session needs your input" });
    expect(parse(done("s1"), "done")).toMatchObject({ title: "Claude Code", body: "A session finished" });
  });

  test("a test payload, and encoded links", () => {
    expect(JSON.parse(buildPayload({ kind: "test", mac: "dev1", macName: MAC, badge: 0 }))).toEqual({
      v: 1,
      kind: "test",
      title: "CCE Remote",
      body: `Notifications from ${MAC} work.`,
      tag: "cce-test",
      url: "/",
      mac: "dev1",
      badge: 0,
    });
    const encoded = JSON.parse(buildPayload({ ...base, project: "a/b", session: "s 1", kind: "done", details: true, ev: done("s 1") }));
    expect(encoded.url).toBe("/?mac=dev1&project=a%2Fb&session=s%201");
    expect(encoded.tag).toBe("dev1:a/b:s 1");
  });

  test("an injected maxPayloadBytes bounds the payload", () => {
    const payload = buildPayload({
      ...base,
      kind: "waiting",
      details: true,
      ev: waiting("s1", "r1", { kind: "question", text: "Q".repeat(200) }, "T".repeat(200)),
      maxPayloadBytes: 300,
    });
    expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(300);
    const parsed = JSON.parse(payload);
    expect(parsed.v).toBe(1);
    expect(parsed.kind).toBe("waiting");
  });

  test("cuts by code point, and keeps the payload at 3000 bytes", () => {
    const longTitle = JSON.parse(buildPayload({ ...base, kind: "waiting", details: true, ev: waiting("s1", "r1", { kind: "question", text: "Q" }, "🎉".repeat(2000)) }));
    expect(Array.from(longTitle.body.split("\n")[0]).length).toBe(80);
    expect(longTitle.body.split("\n")[0].endsWith("…")).toBe(true);
    const longProject = JSON.parse(buildPayload({ ...base, projectName: "p".repeat(100), kind: "waiting", details: true, ev: waiting("s1", "r1") }));
    expect(Array.from(longProject.title).length).toBe(60);
    expect(longProject.title.endsWith("…")).toBe(true);
    const longTool = JSON.parse(buildPayload({ ...base, kind: "waiting", details: true, ev: waiting("s1", "r1", { kind: "tool", toolName: "Bash", text: "x".repeat(5000) }) }));
    expect(Array.from(longTool.body.split("\n")[1]).length).toBe(160);
    expect(longTool.body.split("\n")[1].endsWith("…")).toBe(true);

    const cases = [
      { ev: waiting("s1", "r1", { kind: "question", text: "q".repeat(3000) }), kind: "waiting" },
      { ev: waiting("s1", "r1", { kind: "tool", toolName: "Bash", text: "x".repeat(5000) }), kind: "waiting" },
      { ev: { ...done("s1"), title: "🎉".repeat(2000), text: "y".repeat(3000) }, kind: "done" },
      { ev: waiting("s1", "r1"), kind: "waiting", project: "é".repeat(256), session: "é".repeat(256) },
    ];
    for (const item of cases) {
      const payload = buildPayload({ ...base, ...item, details: true });
      expect(Buffer.byteLength(payload)).toBeLessThanOrEqual(3000);
      const parsed = JSON.parse(payload);
      expect(parsed.v).toBe(1);
      expect(payload).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
      expect(payload).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    }
  });
});
