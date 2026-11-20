import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// ---- fakes ---------------------------------------------------------------------------------------

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

interface FakeClient {
  focus(): Promise<void> | void;
  postMessage(message: unknown): void;
}

/** Loads public/sw.js into a fresh context and hands back what the handlers did. */
function loadWorker() {
  const listeners = new Map<string, Array<(event: Record<string, unknown>) => void>>();
  const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
  const badges: number[] = [];
  const opened: string[] = [];
  const caches = new FakeCaches();
  let windows: FakeClient[] = [];

  const self = {
    addEventListener(type: string, listener: (event: Record<string, unknown>) => void) {
      const set = listeners.get(type) ?? [];
      set.push(listener);
      listeners.set(type, set);
    },
    location: { origin: "https://app.example" },
    registration: {
      async showNotification(title: string, options: Record<string, unknown>) {
        shown.push({ title, options });
      },
    },
    clients: {
      async claim() {},
      async matchAll() {
        return windows;
      },
      async openWindow(url: string) {
        opened.push(url);
        return {};
      },
    },
    navigator: {
      async setAppBadge(count: number) {
        badges.push(count);
      },
      async clearAppBadge() {
        badges.push(0);
      },
    },
    async skipWaiting() {},
  };

  const context = {
    self,
    caches,
    URL,
    Request,
    Response,
    fetch: async () => new Response(""),
    setTimeout,
    console,
  };
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);

  async function dispatch(type: string, event: Record<string, unknown>) {
    const waits: Promise<unknown>[] = [];
    const withWait = { ...event, waitUntil(promise: Promise<unknown>) { waits.push(promise); } };
    for (const listener of listeners.get(type) ?? []) listener(withWait);
    await Promise.all(waits);
  }

  return {
    dispatch,
    shown,
    badges,
    opened,
    caches,
    setWindows(clients: FakeClient[]) {
      windows = clients;
    },
  };
}

function pushWith(data: unknown) {
  return { data };
}

const PAYLOAD = {
  v: 1,
  kind: "waiting",
  title: "acme-api",
  body: "Fix the login\nClaude asks: Which account?",
  tag: "dev1:p1:s1",
  url: "/?mac=dev1&project=p1&session=s1",
  mac: "dev1",
  badge: 2,
};

// ---- tests ---------------------------------------------------------------------------------------

describe("push", () => {
  test("a push shows its notification and sets the badge", async () => {
    const worker = loadWorker();
    await worker.dispatch("push", pushWith({ json: () => PAYLOAD }));

    expect(worker.shown).toEqual([
      {
        title: "acme-api",
        options: {
          body: "Fix the login\nClaude asks: Which account?",
          tag: "dev1:p1:s1",
          data: { url: "/?mac=dev1&project=p1&session=s1" },
          icon: "/icons/icon-192.png",
          badge: "/icons/icon-192.png",
          renotify: true,
        },
      },
    ]);
    expect(worker.caches.map("cce-badge")).toEqual({ dev1: 2 });
    expect(worker.badges).toEqual([2]);
  });

  test("an unreadable push still shows a notification", async () => {
    const worker = loadWorker();
    await worker.dispatch("push", pushWith({ json: () => { throw new Error("bad payload"); } }));
    await worker.dispatch("push", pushWith(null));

    expect(worker.shown).toEqual([
      { title: "Claude Code", options: { body: "Open CCE Remote", tag: "cce" } },
      { title: "Claude Code", options: { body: "Open CCE Remote", tag: "cce" } },
    ]);
    expect(worker.badges).toEqual([]);
  });
});

describe("notificationclick", () => {
  test("a click focuses the app and tells it what to open", async () => {
    const worker = loadWorker();
    const messages: unknown[] = [];
    let focused = 0;
    worker.setWindows([
      {
        async focus() {
          focused++;
        },
        postMessage(message: unknown) {
          messages.push(message);
        },
      },
    ]);
    let closed = 0;
    await worker.dispatch("notificationclick", {
      notification: { data: { url: "/?mac=dev1&project=p1&session=s1" }, close() { closed++; } },
    });

    expect(closed).toBe(1);
    expect(focused).toBe(1);
    expect(messages).toEqual([{ type: "cce-open", url: "/?mac=dev1&project=p1&session=s1" }]);
    expect(worker.opened).toEqual([]);
  });

  test("a click opens the app when it is closed", async () => {
    const worker = loadWorker();
    await worker.dispatch("notificationclick", {
      notification: { data: { url: "/?mac=dev1&project=p1&session=s1" }, close() {} },
    });
    expect(worker.opened).toEqual(["/?mac=dev1&project=p1&session=s1"]);
  });

  test("a click never leaves the app's origin", async () => {
    const worker = loadWorker();
    await worker.dispatch("notificationclick", {
      notification: { data: { url: "https://evil.example/x" }, close() {} },
    });
    expect(worker.opened).toEqual(["/"]);
  });
});
