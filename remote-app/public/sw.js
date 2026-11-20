// CCE Remote service worker: keeps the app shell available offline.
// - One cache per build (BUILD); a new build installs a new cache and the old ones are deleted.
// - Pages (navigations): network first, the cached shell when offline or slow.
// - /assets/ (hashed file names, never change): cache first.
// - Only same-origin GET requests. The connection to the Mac (another origin) is never touched.

// Filled in by the build (vite.config.ts): the build id and the hashed files of this build.
const BUILD = "__CCE_BUILD__";
const BUILD_ASSETS = ["__CCE_ASSETS__"];

const CACHE = `cce-remote-${BUILD}`;
const SHELL = ["/", "/index.html", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png", "/icons/icon-maskable-512.png", "/icons/apple-touch-icon.png", "/icons/favicon-32.png"];
const PRECACHE = [...SHELL, ...BUILD_ASSETS.filter((path) => path.startsWith("/assets/"))];
/** How long a page request may take before the cached shell is shown instead. */
const NETWORK_WAIT_MS = 3500;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("cce-remote-") && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(page(event));
  } else if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirst(request));
  } else if (SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(request));
  }
});

/** Network first; the cached shell when the network fails or takes too long. Fresh pages refresh the cache. */
async function page(event) {
  const cache = await caches.open(CACHE);
  const network = fetch(event.request)
    .then((response) => {
      // Only the app page itself becomes the offline shell (never an error, never something else).
      const html = (response.headers.get("Content-Type") || "").includes("text/html");
      if (response.ok && response.type === "basic" && html) {
        const copy = response.clone();
        event.waitUntil(cache.put("/index.html", copy));
      }
      return response;
    })
    .catch(() => null);
  const cached = () => cache.match("/index.html").then((hit) => hit || cache.match("/"));
  const timeout = new Promise((resolve) => setTimeout(() => resolve("slow"), NETWORK_WAIT_MS));
  const first = await Promise.race([network, timeout]);
  if (first && first !== "slow") return first;
  const hit = await cached();
  if (hit) return hit;
  const late = await network;
  return late || new Response("CCE Remote is offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

/** Cached files first; a fetched file is kept only when it arrived whole (never an error page or a 404). */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.status === 200 && response.type === "basic") await cache.put(request, response.clone());
  return response;
}

// ---- notifications -------------------------------------------------------------------------------
// Pushes arrive end-to-end encrypted and are decrypted by the browser; this worker only shows them.
// The badge counts live in their own cache (cce-badge), which activate keeps.

const BADGE_CACHE = "cce-badge";
const BADGE_PATH = "/badge.json";
const NOTIFICATION_ICON = "/icons/icon-192.png";
const FALLBACK = { title: "Claude Code", body: "Open CCE Remote", tag: "cce" };

/** A string cut to a sane length; anything else is "". */
function cut(value, max) {
  return typeof value === "string" ? [...value].slice(0, max).join("") : "";
}

/** Keeps the waiting count per Mac and returns their sum, or null when the cache is unavailable. */
async function updateBadge(mac, count) {
  const update = async () => {
    const cache = await caches.open(BADGE_CACHE);
    const hit = await cache.match(BADGE_PATH);
    let stored = {};
    if (hit) {
      try {
        const value = await hit.json();
        if (value && typeof value === "object" && !Array.isArray(value)) stored = value;
      } catch {
        stored = {};
      }
    }
    const map = {};
    for (const [key, value] of Object.entries(stored)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) map[key] = value;
    }
    if (count > 0) map[mac] = count;
    else delete map[mac];
    await cache.put(BADGE_PATH, new Response(JSON.stringify(map), { headers: { "Content-Type": "application/json" } }));
    let sum = 0;
    for (const value of Object.values(map)) sum += value;
    return sum;
  };
  try {
    // The same lock name as the page's setBadgeCount: the two take turns on the badge cache.
    const locks = self.navigator && self.navigator.locks;
    if (locks && typeof locks.request === "function") return await locks.request(BADGE_CACHE, update);
    return await update();
  } catch {
    return null;
  }
}

async function showPush(event) {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }
  if (!payload || typeof payload !== "object") {
    await self.registration.showNotification(FALLBACK.title, { body: FALLBACK.body, tag: FALLBACK.tag });
    return;
  }
  const title = cut(payload.title, 120) || FALLBACK.title;
  const body = cut(payload.body, 300) || FALLBACK.body;
  const tag = cut(payload.tag, 120) || FALLBACK.tag;
  const url = cut(payload.url, 2000) || "/";
  await self.registration.showNotification(title, {
    body,
    tag,
    data: { url },
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_ICON,
    renotify: payload.kind === "waiting",
  });
  if (typeof payload.mac === "string" && Number.isInteger(payload.badge) && payload.badge >= 0) {
    const sum = await updateBadge(payload.mac, payload.badge);
    if (sum !== null) {
      try {
        await self.navigator.setAppBadge(sum);
      } catch {
        // Not supported here.
      }
    }
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(showPush(event));
});

async function openFromNotification(notification) {
  const data = notification.data && typeof notification.data === "object" ? notification.data : {};
  let target = "/";
  try {
    const url = new URL(typeof data.url === "string" ? data.url : "/", self.location.origin);
    if (url.origin === self.location.origin) target = url.pathname + url.search + url.hash;
  } catch {
    target = "/";
  }
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const first = windows[0];
  if (first) {
    await first.focus();
    first.postMessage({ type: "cce-open", url: target });
  } else {
    await self.clients.openWindow(target);
  }
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openFromNotification(event.notification));
});
