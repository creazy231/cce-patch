import { describe, expect, test } from "bun:test";
import type { StorageLike } from "../src/lib/macs";
import {
  currentSetup,
  ensureVapidKeys,
  parseOpenLink,
  pushSupport,
  setBadgeCount,
  subscribePush,
  type PushEnv,
  type PushPrefs,
} from "../src/lib/push";

// ---- fakes ---------------------------------------------------------------------------------------

const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15";
const DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15";
const realCrypto = globalThis.crypto;

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

/** A storage that refuses every write, like a browser with site data blocked. */
const brokenStorage: StorageLike = {
  getItem() {
    return null;
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    // nothing stored anyway
  },
};

class FakeCache {
  data = new Map<string, string>();
  async match(request: string) {
    const body = this.data.get(request);
    return body === undefined ? undefined : new Response(body);
  }
  async put(request: string, response: Response) {
    this.data.set(request, await response.text());
  }
}

class FakeCaches {
  private readonly caches = new Map<string, FakeCache>();
  async open(name: string) {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }
  map(name: string): Record<string, number> {
    const body = this.caches.get(name)?.data.get("/badge.json");
    return body ? JSON.parse(body) : {};
  }
}

/** A subscription as the browser hands it over, with the padded base64 the platform uses. */
class FakeSubscription {
  endpoint = "https://push.example/abc";
  unsubscribed = false;
  constructor(private readonly key: ArrayBuffer | Uint8Array | null = null) {}
  get options() {
    return { applicationServerKey: this.key };
  }
  toJSON() {
    return { endpoint: this.endpoint, keys: { p256dh: "BAbc+/==", auth: "Zm9v+/==" } };
  }
  async unsubscribe() {
    this.unsubscribed = true;
    return true;
  }
}

interface FakeOptions {
  userAgent?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
  permission?: string;
  requestPermission?: () => Promise<string>;
  /** No service worker at all: a desktop browser without Push. */
  noServiceWorker?: boolean;
  /** Whether the browser has the Push API's PushManager. */
  pushManager?: boolean;
  /** A service worker that never becomes ready. */
  readyHangs?: boolean;
  readyTimeoutMs?: number;
  crypto?: PushEnv["crypto"];
  storage?: StorageLike;
  caches?: PushEnv["caches"];
  setAppBadge?: (count: number) => Promise<void>;
  clearAppBadge?: () => Promise<void>;
}

function fakeEnv(options: FakeOptions = {}): PushEnv {
  const subscription = new FakeSubscription();
  const registration = {
    pushManager: {
      getSubscription: async () => subscription as FakeSubscription | null,
      subscribe: async () => subscription,
    },
  };
  const navigator = options.noServiceWorker
    ? { setAppBadge: options.setAppBadge, clearAppBadge: options.clearAppBadge }
    : {
        serviceWorker: {
          ready: options.readyHangs ? new Promise<never>(() => {}) : Promise.resolve(registration),
        },
        setAppBadge: options.setAppBadge,
        clearAppBadge: options.clearAppBadge,
      };
  return {
    navigator: navigator as PushEnv["navigator"],
    Notification: {
      permission: options.permission ?? "granted",
      requestPermission: options.requestPermission ?? (async () => options.permission ?? "granted"),
    },
    crypto: options.crypto ?? (realCrypto as PushEnv["crypto"]),
    storage: options.storage ?? new MemoryStorage(),
    origin: "https://app.example",
    userAgent: options.userAgent ?? IPHONE_UA,
    maxTouchPoints: options.maxTouchPoints ?? 5,
    standalone: () => options.standalone ?? true,
    pushManager: options.pushManager ?? true,
    readyTimeoutMs: options.readyTimeoutMs,
    caches: options.caches ?? new FakeCaches(),
  };
}

/** An environment that records the order of the steps subscribing takes. */
function recordingEnv(log: string[]) {
  const storage = new MemoryStorage();
  let current: FakeSubscription | null = null;
  let subscribedWith: Uint8Array | null = null;
  const pushManager = {
    getSubscription: async () => {
      log.push("getSubscription");
      return current;
    },
    subscribe: async (options: { applicationServerKey: Uint8Array }) => {
      log.push("subscribe");
      subscribedWith = options.applicationServerKey;
      current = new FakeSubscription(options.applicationServerKey);
      return current;
    },
  };
  const registration = { pushManager };
  const env: PushEnv = {
    navigator: {
      serviceWorker: {
        get ready() {
          log.push("ready");
          return Promise.resolve(registration);
        },
      },
    } as PushEnv["navigator"],
    Notification: {
      permission: "default",
      requestPermission: async () => {
        log.push("requestPermission");
        return "granted";
      },
    },
    crypto: {
      subtle: {
        generateKey: (...args: Parameters<SubtleCrypto["generateKey"]>) => {
          log.push("generateKey");
          return realCrypto.subtle.generateKey(...args);
        },
        exportKey: (...args: Parameters<SubtleCrypto["exportKey"]>) => realCrypto.subtle.exportKey(...args),
      },
    } as PushEnv["crypto"],
    storage,
    origin: "https://app.example",
    userAgent: IPHONE_UA,
    maxTouchPoints: 5,
    standalone: () => true,
    pushManager: true,
  };
  return { env, storage, pushManager, current: () => current, subscribedWith: () => subscribedWith };
}

function decodeBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

const PREFS: PushPrefs = { waiting: true, done: false, onlyAway: true, details: false };

// ---- support -------------------------------------------------------------------------------------

describe("pushSupport", () => {
  test("an iPhone browser tab is not installed", () => {
    expect(pushSupport(fakeEnv({ userAgent: IPHONE_UA, standalone: false }))).toBe("not-installed");
  });

  test("a desktop browser without Push is unsupported", () => {
    expect(pushSupport(fakeEnv({ userAgent: DESKTOP_UA, maxTouchPoints: 0, noServiceWorker: true }))).toBe("unsupported");
  });

  test("a blocked permission is denied", () => {
    expect(pushSupport(fakeEnv({ permission: "denied" }))).toBe("denied");
  });

  test("the home-screen app with the APIs is ok", () => {
    expect(pushSupport(fakeEnv())).toBe("ok");
  });

  test("a service worker but no Notification is unsupported", () => {
    const env = fakeEnv();
    env.Notification = undefined;
    expect(pushSupport(env)).toBe("unsupported");
  });

  test("a service worker and Notification but no PushManager is unsupported", () => {
    expect(pushSupport(fakeEnv({ pushManager: false }))).toBe("unsupported");
  });
});

describe("without the Notification API", () => {
  test("subscribing rejects with 'unsupported'", async () => {
    const env = fakeEnv();
    env.Notification = undefined;
    await expect(subscribePush(PREFS, env)).rejects.toThrow("unsupported");
  });

  test("currentSetup is null", async () => {
    const env = fakeEnv();
    await ensureVapidKeys(env);
    env.Notification = undefined;
    expect(await currentSetup(PREFS, env)).toBeNull();
  });
});

// ---- VAPID keys ----------------------------------------------------------------------------------

describe("ensureVapidKeys", () => {
  test("VAPID keys are made once and kept", async () => {
    const env = fakeEnv();
    const first = await ensureVapidKeys(env);

    const raw = decodeBase64Url(first.publicKey);
    expect(raw.length).toBe(65);
    expect(raw[0]).toBe(0x04);
    expect(first.privateJwk.d).toBeTruthy();
    expect(first.privateJwk.x).toBeTruthy();
    expect(first.privateJwk.y).toBeTruthy();

    const second = await ensureVapidKeys(env);
    expect(second).toEqual(first);

    expect([...raw.slice(1, 33)]).toEqual([...decodeBase64Url(first.privateJwk.x!)]);
    expect([...raw.slice(33)]).toEqual([...decodeBase64Url(first.privateJwk.y!)]);

    const stored = JSON.parse(env.storage.getItem("cce-remote:vapid")!);
    expect(stored).toEqual(first);
    // Canonical base64url: no padding, none of + or /.
    expect(first.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("storage that refuses writes still returns the keys for this run", async () => {
    const keys = await ensureVapidKeys(fakeEnv({ storage: brokenStorage }));
    expect(decodeBase64Url(keys.publicKey).length).toBe(65);
    expect(keys.privateJwk.d).toBeTruthy();
  });

  test("concurrent calls make one key pair", async () => {
    const log: string[] = [];
    const { env } = recordingEnv(log);

    const [first, second] = await Promise.all([ensureVapidKeys(env), ensureVapidKeys(env)]);

    expect(log.filter((step) => step === "generateKey")).toHaveLength(1);
    expect(first).toEqual(second);
  });
});

describe("currentSetup", () => {
  test("a subscription bound to another key is no setup", async () => {
    const env = fakeEnv();
    await ensureVapidKeys(env);
    const subscription = new FakeSubscription(new Uint8Array(65).fill(9));
    env.navigator.serviceWorker = {
      ready: Promise.resolve({ pushManager: { getSubscription: async () => subscription, subscribe: async () => subscription } }),
    };

    expect(await currentSetup(PREFS, env)).toBeNull();
  });

  test("a ready that never comes throws instead of looking gone", async () => {
    const env = fakeEnv({ readyHangs: true, readyTimeoutMs: 20 });
    await ensureVapidKeys(env);
    await expect(currentSetup(PREFS, env)).rejects.toThrow();
  });
});

describe("a service worker that never becomes ready", () => {
  test("subscribing rejects with 'unsupported'", async () => {
    const env = fakeEnv({ readyHangs: true, readyTimeoutMs: 20 });
    await expect(subscribePush(PREFS, env)).rejects.toThrow("unsupported");
  });
});

// ---- subscribing ---------------------------------------------------------------------------------

describe("subscribePush", () => {
  test("subscribing asks for permission before anything else", async () => {
    const log: string[] = [];
    const { env, subscribedWith } = recordingEnv(log);

    const setup = await subscribePush(PREFS, env);

    expect(log[0]).toBe("requestPermission");
    for (const step of ["generateKey", "ready", "subscribe"]) {
      expect(log.indexOf("requestPermission")).toBeLessThan(log.indexOf(step));
    }
    expect(setup.subscription.endpoint).toBe("https://push.example/abc");
    expect(setup.subscription.keys).toEqual({ p256dh: "BAbc-_", auth: "Zm9v-_" });
    expect(setup.vapid.publicKey).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(setup.vapid.privateJwk.d).toBeTruthy();
    expect(setup.subject).toBe("https://app.example");
    expect(setup.prefs).toEqual(PREFS);
    // The subscription is bound to the raw public key bytes, not the encoded string.
    expect([...subscribedWith()!]).toEqual([...decodeBase64Url(setup.vapid.publicKey)]);
  });

  test("a denied permission rejects with 'denied' and subscribes nothing", async () => {
    const log: string[] = [];
    const { env } = recordingEnv(log);
    env.Notification.requestPermission = async () => {
      log.push("requestPermission");
      return "denied";
    };

    await expect(subscribePush(PREFS, env)).rejects.toThrow("denied");
    expect(log).toEqual(["requestPermission"]);
  });

  test("a subscription made with another key is unsubscribed first", async () => {
    const log: string[] = [];
    const { env, pushManager } = recordingEnv(log);
    const old = new FakeSubscription(new Uint8Array(65).fill(7));
    old.unsubscribe = async () => {
      log.push("unsubscribe");
      old.unsubscribed = true;
      return true;
    };
    (pushManager as unknown as { getSubscription: () => Promise<FakeSubscription | null> }).getSubscription = async () => {
      log.push("getSubscription");
      return old;
    };

    await subscribePush(PREFS, env);

    expect(old.unsubscribed).toBe(true);
    expect(log.indexOf("unsubscribe")).toBeLessThan(log.indexOf("subscribe"));
  });
});

// ---- deep links ----------------------------------------------------------------------------------

describe("parseOpenLink", () => {
  test("reads the Mac, project and session, decoded", () => {
    expect(parseOpenLink("?mac=a&project=p%2F1&session=s")).toEqual({ mac: "a", project: "p/1", session: "s" });
  });

  test("a missing, empty or overlong part gives null", () => {
    expect(parseOpenLink("?mac=a&project=p")).toBeNull();
    expect(parseOpenLink("?mac=&project=p&session=s")).toBeNull();
    expect(parseOpenLink("?mac=a&project=&session=s")).toBeNull();
    expect(parseOpenLink("?mac=a&project=p&session=")).toBeNull();
    expect(parseOpenLink("")).toBeNull();
    const long = "x".repeat(300);
    expect(parseOpenLink(`?mac=${long}&project=p&session=s`)).toBeNull();
    expect(parseOpenLink(`?mac=a&project=${long}&session=s`)).toBeNull();
    expect(parseOpenLink(`?mac=a&project=p&session=${long}`)).toBeNull();
    expect(parseOpenLink(`?mac=${"x".repeat(256)}&project=p&session=s`)).toEqual({ mac: "x".repeat(256), project: "p", session: "s" });
  });
});

// ---- badge ---------------------------------------------------------------------------------------

describe("setBadgeCount", () => {
  test("badge sums Macs", async () => {
    const caches = new FakeCaches();
    const badges: number[] = [];
    let cleared = 0;
    const env = fakeEnv({
      caches: caches as unknown as PushEnv["caches"],
      setAppBadge: async (count) => {
        badges.push(count);
      },
      clearAppBadge: async () => {
        cleared++;
      },
    });

    await setBadgeCount("a", 2, env);
    expect(caches.map("cce-badge")).toEqual({ a: 2 });
    await setBadgeCount("b", 1, env);
    expect(caches.map("cce-badge")).toEqual({ a: 2, b: 1 });
    expect(badges).toEqual([2, 3]);

    await setBadgeCount("a", 0, env);
    expect(caches.map("cce-badge")).toEqual({ b: 1 });
    expect(badges).toEqual([2, 3, 1]);

    await setBadgeCount("b", 0, env);
    expect(caches.map("cce-badge")).toEqual({});
    expect(cleared).toBe(1);
  });

  test("a throwing caches does not throw", async () => {
    const env = fakeEnv({
      caches: {
        async open() {
          throw new Error("no cache storage");
        },
      } as unknown as PushEnv["caches"],
    });
    await expect(setBadgeCount("a", 1, env)).resolves.toBeUndefined();
  });
});
