// What this phone has read: per paired Mac, up to when each session was on screen here, in the Mac's clock (so a
// phone clock that is off doesn't matter). A session that isn't running or waiting is "new" (the green dot) when
// the Mac saw activity in it after that; sessions never opened here count from the baseline, the moment this
// phone first saw the Mac's list, so nothing is new right after pairing or updating the app.

import type { SessionSummary } from "./protocol";
import type { StorageLike } from "./macs";

export interface ReadState {
  /** When this phone first saw the Mac's sessions (the Mac's clock, epoch ms). */
  baseline: number;
  /** Per session id: up to when it was on screen here (the Mac's clock, epoch ms). */
  seen: Record<string, number>;
}

/** How much later than "seen" activity has to be to count: the error of the phone's estimate of the Mac's clock. */
export const READ_TOLERANCE_MS = 2_000;
/** Sessions remembered per Mac; the ones seen longest ago go first. */
export const READ_CAP = 500;

const keyOf = (macId: string) => `cce-remote:read:${macId}`;

function storageOr(storage?: StorageLike): StorageLike | null {
  if (storage) return storage;
  try {
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** The read state kept for a Mac; null when there is none, or it is foreign or corrupt, or storage refuses. */
export function loadReadState(macId: string, storage?: StorageLike): ReadState | null {
  let raw: string | null | undefined;
  try {
    raw = storageOr(storage)?.getItem(keyOf(macId));
  } catch {
    return null;
  }
  if (!raw) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== "object") return null;
  const { baseline, seen } = data as Record<string, unknown>;
  if (!isTime(baseline)) return null;
  const kept: Record<string, number> = {};
  if (seen && typeof seen === "object") {
    for (const [id, at] of Object.entries(seen)) if (isTime(at)) kept[id] = at;
  }
  return { baseline, seen: kept };
}

/**
 * Keeps a Mac's read state: the READ_CAP sessions seen most recently. The baseline moves up to the newest session it
 * lets go, so a session read long ago doesn't turn new again once it is no longer remembered. Never throws: storage
 * may refuse.
 */
export function saveReadState(macId: string, state: ReadState, storage?: StorageLike): void {
  let { baseline, seen } = state;
  const entries = Object.entries(seen);
  if (entries.length > READ_CAP) {
    entries.sort((a, b) => b[1] - a[1]);
    baseline = Math.max(baseline, entries[READ_CAP]![1]);
    seen = Object.fromEntries(entries.slice(0, READ_CAP));
  }
  try {
    storageOr(storage)?.setItem(keyOf(macId), JSON.stringify({ baseline, seen }));
  } catch {
    // not kept: it still applies until the app is closed
  }
}

/** Forgets a Mac's read state (the Mac was removed). */
export function forgetReadState(macId: string, storage?: StorageLike): void {
  try {
    storageOr(storage)?.removeItem(keyOf(macId));
  } catch {
    // nothing to do
  }
}

/** The session was on screen up to `at`: the later of that and what was known. The same object when nothing changed. */
export function markSeen(state: ReadState, sessionId: string, at: number): ReadState {
  const known = state.seen[sessionId];
  if (known !== undefined && known >= at) return state;
  return { ...state, seen: { ...state.seen, [sessionId]: at } };
}

/** Whether a session has activity this phone hasn't shown yet. Running and waiting sessions never count: they are active. */
export function isNew(session: SessionSummary, state: ReadState | null): boolean {
  if (!state || session.state === "waiting" || session.state === "running") return false;
  return session.lastModified > (state.seen[session.id] ?? state.baseline) + READ_TOLERANCE_MS;
}
