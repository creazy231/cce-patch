/** A paired Mac: where it is, and the credentials this phone got when it paired. */
export type Mac = {
  /** Local identity (the pairing flow uses the deviceId); the selection refers to it. */
  id: string;
  name: string;
  /** https://<host>:<port> as returned by normalizeMacUrl. */
  url: string;
  deviceId: string;
  token: string;
};

/** The part of the Web Storage API the app uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const MACS_KEY = "cce-remote:macs";
const SELECTED_KEY = "cce-remote:selected";
const PROBE_KEY = "cce-remote:probe";

class MemoryStorage implements StorageLike {
  private data = new Map<string, string>();
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

// Used when localStorage is missing or refuses writes (site data blocked): the app then works
// until the page is reloaded instead of failing to pair at all.
const memory = new MemoryStorage();
let probed: { storage: StorageLike; usable: boolean } | undefined;

function defaultStorage(): StorageLike {
  let storage: StorageLike | undefined;
  try {
    storage = (globalThis as { localStorage?: StorageLike }).localStorage;
  } catch {
    // Merely reading the property can throw when site data is blocked.
  }
  if (!storage) return memory;
  if (probed?.storage !== storage) {
    let usable = true;
    try {
      storage.setItem(PROBE_KEY, "1");
      storage.removeItem(PROBE_KEY);
    } catch {
      usable = false;
    }
    probed = { storage, usable };
  }
  return probed.usable ? storage : memory;
}

function toMac(value: unknown): Mac | null {
  if (!value || typeof value !== "object") return null;
  const { id, name, url, deviceId, token } = value as Record<string, unknown>;
  if (typeof name !== "string") return null;
  if (typeof id !== "string" || typeof url !== "string" || typeof deviceId !== "string" || typeof token !== "string") return null;
  if (!id || !url || !deviceId || !token) return null;
  return { id, name, url, deviceId, token };
}

/** The paired Macs. Corrupt or foreign data in storage reads as "none". */
export function loadMacs(storage: StorageLike = defaultStorage()): Mac[] {
  let raw: string | null;
  try {
    raw = storage.getItem(MACS_KEY);
  } catch {
    return [];
  }
  if (!raw) return [];
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(data)) return [];
  const macs: Mac[] = [];
  for (const item of data) {
    const mac = toMac(item);
    if (mac) macs.push(mac);
  }
  return macs;
}

/** Stores the list; false when the browser refused (the pairing then lasts until the page closes). */
export function saveMacs(macs: Mac[], storage: StorageLike = defaultStorage()): boolean {
  try {
    storage.setItem(MACS_KEY, JSON.stringify(macs));
    return true;
  } catch {
    return false;
  }
}

function storedSelection(storage: StorageLike): string | null {
  try {
    return storage.getItem(SELECTED_KEY);
  } catch {
    return null;
  }
}

/**
 * Adds a Mac, or replaces the entry with the same id or the same address (pairing a Mac again
 * gives a new device id): the new entry takes the old one's place and its selection.
 * Returns the new list.
 */
export function upsertMac(mac: Mac, storage: StorageLike = defaultStorage()): Mac[] {
  const macs = loadMacs(storage);
  const same = (m: Mac) => m.id === mac.id || m.url === mac.url;
  const replaced = macs.filter(same);
  const next: Mac[] = [];
  let placed = false;
  for (const m of macs) {
    if (!same(m)) next.push(m);
    else if (!placed) {
      next.push(mac);
      placed = true;
    }
  }
  if (!placed) next.push(mac);
  saveMacs(next, storage);

  const selected = storedSelection(storage);
  if (selected && selected !== mac.id && replaced.some((m) => m.id === selected)) selectMac(mac.id, storage);
  return next;
}

/** Forgets a Mac. If it was the selected one, the selection is cleared. Returns the new list. */
export function removeMac(id: string, storage: StorageLike = defaultStorage()): Mac[] {
  const next = loadMacs(storage).filter((m) => m.id !== id);
  saveMacs(next, storage);
  if (storedSelection(storage) === id) selectMac(null, storage);
  return next;
}

/** The selected Mac's id; the first Mac when nothing (valid) is selected; null without Macs. */
export function selectedMacId(storage: StorageLike = defaultStorage()): string | null {
  const macs = loadMacs(storage);
  const stored = storedSelection(storage);
  if (stored && macs.some((m) => m.id === stored)) return stored;
  return macs[0]?.id ?? null;
}

export function selectMac(id: string | null, storage: StorageLike = defaultStorage()): void {
  try {
    if (id === null) storage.removeItem(SELECTED_KEY);
    else storage.setItem(SELECTED_KEY, id);
  } catch {
    // Not persisted; the selection falls back to the first Mac after a reload.
  }
}
