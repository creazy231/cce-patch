// Web Push on the phone: the home-screen app makes a VAPID key pair once, subscribes with its public
// key and hands the subscription to its paired Macs. Everything here takes its browser APIs from a
// `PushEnv`, so the logic runs under Bun with fakes.

import type { StorageLike } from "./macs";

export type PushSupport = "ok" | "not-installed" | "unsupported" | "denied";

export interface PushPrefs {
  waiting: boolean;
  done: boolean;
  onlyAway: boolean;
  details: boolean;
}

export const DEFAULT_PUSH_PREFS: PushPrefs = { waiting: true, done: true, onlyAway: true, details: true };

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushVapidKeys {
  publicKey: string;
  /** Only kty, crv, x, y and d leave this phone. */
  privateJwk: JsonWebKey;
}

export interface PushSetup {
  subscription: PushSubscriptionJson;
  vapid: PushVapidKeys;
  subject: string;
  prefs: PushPrefs;
}

// ---- injectable browser environment --------------------------------------------------------------

export interface PushSubscriptionLike {
  readonly endpoint?: string;
  readonly options?: { applicationServerKey?: ArrayBuffer | Uint8Array | null };
  toJSON(): { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  unsubscribe(): Promise<boolean>;
}

export interface PushRegistration {
  pushManager?: {
    getSubscription(): Promise<PushSubscriptionLike | null>;
    subscribe(options: { userVisibleOnly: boolean; applicationServerKey: Uint8Array }): Promise<PushSubscriptionLike>;
  };
}

export interface PushNavigator {
  serviceWorker?: { ready: Promise<PushRegistration> };
  setAppBadge?(count: number): Promise<void> | void;
  clearAppBadge?(): Promise<void> | void;
}

export interface PushNotification {
  permission: string;
  requestPermission(): Promise<string>;
}

export interface PushCache {
  match(request: string): Promise<{ json(): Promise<unknown> } | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface PushCaches {
  open(name: string): Promise<PushCache>;
}

export interface PushEnv {
  navigator: PushNavigator;
  /** Undefined when the browser has no Notification API. */
  Notification?: PushNotification;
  /** Whether the browser has the Push API's PushManager. */
  pushManager: boolean;
  crypto: Crypto;
  storage: StorageLike;
  origin: string;
  userAgent: string;
  maxTouchPoints: number;
  standalone(): boolean;
  /** How long to wait for `serviceWorker.ready`, in ms. */
  readyTimeoutMs?: number;
  caches?: PushCaches;
}

class MemoryStorage implements StorageLike {
  private readonly data = new Map<string, string>();
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

const memoryStorage = new MemoryStorage();

function defaultStorage(): StorageLike {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (storage) return storage;
  } catch {
    // Reading the property can throw when site data is blocked.
  }
  return memoryStorage;
}

function defaultStandalone(): boolean {
  try {
    const media = (globalThis as { matchMedia?: (query: string) => { matches: boolean } }).matchMedia;
    if (media?.("(display-mode: standalone)").matches) return true;
  } catch {
    // no matchMedia
  }
  return (globalThis as { navigator?: { standalone?: boolean } }).navigator?.standalone === true;
}

function defaultPushEnv(): PushEnv {
  const navigator = (globalThis as { navigator?: { userAgent?: string; maxTouchPoints?: number } }).navigator;
  return {
    navigator: (navigator ?? {}) as PushNavigator,
    Notification: (globalThis as { Notification?: PushNotification }).Notification,
    pushManager: "PushManager" in globalThis,
    crypto: (globalThis as { crypto?: Crypto }).crypto ?? ({} as Crypto),
    storage: defaultStorage(),
    origin: typeof location !== "undefined" ? location.origin : "",
    userAgent: navigator?.userAgent ?? "",
    maxTouchPoints: navigator?.maxTouchPoints ?? 0,
    standalone: defaultStandalone,
    caches: (globalThis as { caches?: PushCaches }).caches,
  };
}

// ---- base64url -----------------------------------------------------------------------------------

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Canonical, unpadded base64url: the Mac refuses padding and the +/ alphabet. */
function canonicalBase64Url(value: string): string {
  return value.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesOf(key: ArrayBuffer | Uint8Array | null | undefined): Uint8Array | null {
  if (!key) return null;
  return key instanceof Uint8Array ? key : new Uint8Array(key);
}

function sameKey(key: ArrayBuffer | Uint8Array | null | undefined, expected: Uint8Array): boolean {
  const actual = bytesOf(key);
  if (!actual || actual.length !== expected.length) return false;
  return actual.every((byte, i) => byte === expected[i]);
}

const DEFAULT_READY_TIMEOUT_MS = 10000;

/** A `serviceWorker.ready` that is waited for at most `timeoutMs`; the timeout rejects with `error`. */
function readyWithin<T>(ready: Promise<T>, timeoutMs: number, error: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(error)), timeoutMs);
    ready.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (cause) => {
        clearTimeout(timer);
        reject(cause);
      },
    );
  });
}

// ---- support -------------------------------------------------------------------------------------

/** Whether this browser can show Web Push notifications for the app. */
export function pushSupport(env?: PushEnv): PushSupport {
  const e = env ?? defaultPushEnv();
  const ios = /iPhone|iPad|iPod/.test(e.userAgent) || (e.maxTouchPoints > 1 && /Macintosh/.test(e.userAgent));
  if (ios && !e.standalone()) return "not-installed";
  if (!e.navigator.serviceWorker || !e.pushManager || typeof e.Notification?.requestPermission !== "function") return "unsupported";
  if (e.Notification.permission === "denied") return "denied";
  return "ok";
}

// ---- VAPID keys ----------------------------------------------------------------------------------

const VAPID_KEY = "cce-remote:vapid";

/** One key pair being made per storage, so concurrent calls share it. */
const vapidInFlight = new WeakMap<StorageLike, Promise<PushVapidKeys>>();

function loadVapidKeys(env: PushEnv): PushVapidKeys | null {
  try {
    const raw = env.storage.getItem(VAPID_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as { publicKey?: unknown; privateJwk?: unknown };
    if (typeof value?.publicKey !== "string" || !value.privateJwk || typeof value.privateJwk !== "object") return null;
    const jwk = value.privateJwk as JsonWebKey;
    if (typeof jwk.d !== "string" || typeof jwk.x !== "string" || typeof jwk.y !== "string") return null;
    return {
      publicKey: value.publicKey,
      privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    };
  } catch {
    return null;
  }
}

/** The phone's VAPID key pair: made once, kept, and returned for this run even when storage refuses it. */
export async function ensureVapidKeys(env?: PushEnv): Promise<PushVapidKeys> {
  const e = env ?? defaultPushEnv();
  const stored = loadVapidKeys(e);
  if (stored) return stored;
  // Settings' mount and a tap can ask at the same time: they share the one pair being made.
  const pending = vapidInFlight.get(e.storage);
  if (pending) return pending;
  const making = (async (): Promise<PushVapidKeys> => {
    const pair = (await e.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const raw = new Uint8Array(await e.crypto.subtle.exportKey("raw", pair.publicKey));
    const jwk = await e.crypto.subtle.exportKey("jwk", pair.privateKey);
    const keys: PushVapidKeys = {
      publicKey: toBase64Url(raw),
      privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d },
    };
    try {
      e.storage.setItem(VAPID_KEY, JSON.stringify(keys));
    } catch {
      // Not persisted: these keys work for this run.
    }
    return keys;
  })();
  vapidInFlight.set(e.storage, making);
  try {
    return await making;
  } finally {
    vapidInFlight.delete(e.storage);
  }
}

// ---- subscribing ---------------------------------------------------------------------------------

function setupFrom(subscription: PushSubscriptionLike, vapid: PushVapidKeys, prefs: PushPrefs, origin: string): PushSetup {
  const json = subscription.toJSON();
  const endpoint = typeof json.endpoint === "string" ? json.endpoint : (subscription.endpoint ?? "");
  const keys = json.keys ?? {};
  return {
    subscription: {
      endpoint,
      keys: { p256dh: canonicalBase64Url(keys.p256dh ?? ""), auth: canonicalBase64Url(keys.auth ?? "") },
    },
    vapid: { publicKey: vapid.publicKey, privateJwk: vapid.privateJwk },
    subject: origin,
    prefs,
  };
}

/**
 * Asks for permission (first, straight from the button's tap), then subscribes with the phone's VAPID
 * public key. A subscription bound to another key is dropped first.
 */
export async function subscribePush(prefs: PushPrefs, env?: PushEnv): Promise<PushSetup> {
  const e = env ?? defaultPushEnv();
  if (!e.Notification) throw new Error("unsupported");
  const permission = await e.Notification.requestPermission();
  if (permission !== "granted") throw new Error("denied");
  const vapid = await ensureVapidKeys(e);
  const serviceWorker = e.navigator.serviceWorker;
  if (!serviceWorker) throw new Error("unsupported");
  const registration = await readyWithin(serviceWorker.ready, e.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, "unsupported");
  const pushManager = registration.pushManager;
  if (!pushManager) throw new Error("unsupported");

  const applicationServerKey = fromBase64Url(vapid.publicKey);
  let subscription = await pushManager.getSubscription();
  if (subscription && !sameKey(subscription.options?.applicationServerKey, applicationServerKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  if (!subscription) subscription = await pushManager.subscribe({ userVisibleOnly: true, applicationServerKey });
  return setupFrom(subscription, vapid, prefs, e.origin);
}

/** The setup to send to a Mac, or null when permission, a subscription or the keys are missing. */
export async function currentSetup(prefs: PushPrefs, env?: PushEnv): Promise<PushSetup | null> {
  const e = env ?? defaultPushEnv();
  if (!e.Notification || e.Notification.permission !== "granted") return null;
  const serviceWorker = e.navigator.serviceWorker;
  if (!serviceWorker) return null;
  const vapid = loadVapidKeys(e);
  if (!vapid) return null;
  // A wait that times out is not "gone": it throws, and the caller keeps notifications on.
  const registration = await readyWithin(serviceWorker.ready, e.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, "timeout");
  const subscription = await registration.pushManager?.getSubscription();
  if (!subscription) return null;
  // A subscription bound to another key would be refused by every push service: the setup is stale.
  const key = subscription.options?.applicationServerKey;
  if (bytesOf(key) && !sameKey(key, fromBase64Url(vapid.publicKey))) return null;
  return setupFrom(subscription, vapid, prefs, e.origin);
}

export async function unsubscribePush(env?: PushEnv): Promise<void> {
  const e = env ?? defaultPushEnv();
  const serviceWorker = e.navigator.serviceWorker;
  if (!serviceWorker) return;
  try {
    const registration = await serviceWorker.ready;
    const subscription = await registration.pushManager?.getSubscription();
    if (subscription) await subscription.unsubscribe();
  } catch {
    // Nothing to unsubscribe.
  }
}

// ---- prefs and the on flag -----------------------------------------------------------------------

const PREFS_KEY = "cce-remote:push-prefs";
const ON_KEY = "cce-remote:push";

function readStorage(env: PushEnv, key: string): string | null {
  try {
    return env.storage.getItem(key);
  } catch {
    return null;
  }
}

export function loadPushPrefs(env?: PushEnv): PushPrefs {
  const e = env ?? defaultPushEnv();
  const prefs: PushPrefs = { ...DEFAULT_PUSH_PREFS };
  const raw = readStorage(e, PREFS_KEY);
  if (!raw) return prefs;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof PushPrefs, unknown>>;
    for (const key of Object.keys(prefs) as Array<keyof PushPrefs>) {
      if (typeof value?.[key] === "boolean") prefs[key] = value[key] as boolean;
    }
  } catch {
    // Unreadable prefs: all on.
  }
  return prefs;
}

export function savePushPrefs(prefs: PushPrefs, env?: PushEnv): void {
  const e = env ?? defaultPushEnv();
  try {
    e.storage.setItem(
      PREFS_KEY,
      JSON.stringify({
        waiting: prefs.waiting === true,
        done: prefs.done === true,
        onlyAway: prefs.onlyAway === true,
        details: prefs.details === true,
      }),
    );
  } catch {
    // Not persisted: the defaults come back after a reload.
  }
}

export function isPushOn(env?: PushEnv): boolean {
  return readStorage(env ?? defaultPushEnv(), ON_KEY) === "1";
}

export function setPushOn(on: boolean, env?: PushEnv): void {
  const e = env ?? defaultPushEnv();
  try {
    if (on) e.storage.setItem(ON_KEY, "1");
    else e.storage.removeItem(ON_KEY);
  } catch {
    // Not persisted: it lasts until the page closes.
  }
}

// ---- deep links ----------------------------------------------------------------------------------

const LINK_MAX = 256;

/** `?mac=<device id>&project=<id>&session=<id>` from a notification; all three parts are required. */
export function parseOpenLink(search: string): { mac: string; project: string; session: string } | null {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const mac = params.get("mac");
  const project = params.get("project");
  const session = params.get("session");
  const usable = (value: string | null): value is string => typeof value === "string" && value.length > 0 && value.length <= LINK_MAX;
  if (!usable(mac) || !usable(project) || !usable(session)) return null;
  return { mac, project, session };
}

// ---- badge ---------------------------------------------------------------------------------------

const BADGE_CACHE = "cce-badge";
const BADGE_PATH = "/badge.json";

async function applyBadge(navigator: PushNavigator, sum: number): Promise<void> {
  try {
    if (sum > 0) await navigator.setAppBadge?.(sum);
    else await navigator.clearAppBadge?.();
  } catch {
    // Not supported here.
  }
}

/**
 * Keeps the waiting count per Mac in the badge cache and sets the home-screen badge to their sum.
 * Never throws: without Cache Storage there is simply no badge.
 */
export async function setBadgeCount(mac: string, count: number, env?: PushEnv): Promise<void> {
  const e = env ?? defaultPushEnv();
  try {
    if (!e.caches) return;
    const cache = await e.caches.open(BADGE_CACHE);
    const map: Record<string, number> = {};
    const hit = await cache.match(BADGE_PATH);
    if (hit) {
      try {
        const stored = await hit.json();
        if (stored && typeof stored === "object" && !Array.isArray(stored)) {
          for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
            if (typeof value === "number" && Number.isFinite(value) && value > 0) map[key] = value;
          }
        }
      } catch {
        // Unreadable: start over.
      }
    }
    const n = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (n > 0) map[mac] = n;
    else delete map[mac];
    await cache.put(BADGE_PATH, new Response(JSON.stringify(map)));
    let sum = 0;
    for (const value of Object.values(map)) sum += value;
    await applyBadge(e.navigator, sum);
  } catch {
    // Cache Storage failed: the badge stays as it was.
  }
}
