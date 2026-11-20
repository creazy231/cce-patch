import { describe, expect, test } from "bun:test";
import type { SessionSummary } from "../src/lib/protocol";
import { READ_CAP, forgetReadState, isNew, loadReadState, markSeen, saveReadState, type ReadState } from "../src/lib/readstate";

class MemoryStorage {
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

const session = (id: string, lastModified: number, state: SessionSummary["state"] = "idle"): SessionSummary => ({
  id,
  title: id,
  lastModified,
  state,
  live: false,
  pendingCount: 0,
});

describe("isNew", () => {
  test("nothing is new without a read state", () => {
    expect(isNew(session("s1", 10_000), null)).toBe(false);
  });

  test("new after the baseline, unless seen, with 2 s tolerance", () => {
    const fresh: ReadState = { baseline: 1_000, seen: {} };
    expect(isNew(session("s1", 3_000), fresh)).toBe(false);
    expect(isNew(session("s1", 3_001), fresh)).toBe(true);
    const seen: ReadState = { baseline: 1_000, seen: { s1: 10_000 } };
    expect(isNew(session("s1", 12_000), seen)).toBe(false);
    expect(isNew(session("s1", 12_001), seen)).toBe(true);
  });

  test("waiting and running are never new; the Mac's unread is", () => {
    const state: ReadState = { baseline: 0, seen: {} };
    expect(isNew(session("s1", 99_999, "waiting"), state)).toBe(false);
    expect(isNew(session("s1", 99_999, "running"), state)).toBe(false);
    expect(isNew(session("s1", 99_999, "unread"), state)).toBe(true);
  });
});

describe("markSeen", () => {
  test("keeps the larger time and returns the same object when unchanged", () => {
    const state: ReadState = { baseline: 0, seen: { s1: 5_000 } };
    expect(markSeen(state, "s1", 4_000)).toBe(state);
    expect(markSeen(state, "s1", 5_000)).toBe(state);
    const later = markSeen(state, "s1", 6_000);
    expect(later).not.toBe(state);
    expect(later.seen).toEqual({ s1: 6_000 });
    expect(state.seen).toEqual({ s1: 5_000 });
    expect(markSeen(state, "s2", 1).seen).toEqual({ s1: 5_000, s2: 1 });
  });
});

describe("storage", () => {
  test("save keeps the 500 most recently seen", () => {
    const storage = new MemoryStorage();
    const seen: Record<string, number> = {};
    for (let i = 0; i < 600; i++) seen[`s${i}`] = i;
    saveReadState("mac", { baseline: 7, seen }, storage);
    const loaded = loadReadState("mac", storage)!;
    expect(loaded.baseline).toBe(99); // past the newest session it let go (see the next test)
    expect(Object.keys(loaded.seen)).toHaveLength(READ_CAP);
    expect(loaded.seen.s99).toBeUndefined();
    expect(loaded.seen.s100).toBe(100);
    expect(loaded.seen.s599).toBe(599);
  });

  test("sessions let go at the cap don't turn new again: the baseline moves past them", () => {
    const storage = new MemoryStorage();
    const seen: Record<string, number> = {};
    for (let i = 0; i < 600; i++) seen[`s${i}`] = i * 1_000;
    const state: ReadState = { baseline: 0, seen };
    const quiet = session("s50", 50_000); // read at 50 000, nothing happened since
    expect(isNew(quiet, state)).toBe(false);
    saveReadState("mac", state, storage);
    const loaded = loadReadState("mac", storage)!;
    expect(loaded.seen.s50).toBeUndefined();
    expect(loaded.baseline).toBe(99_000);
    expect(isNew(quiet, loaded)).toBe(false);
  });

  test("load ignores foreign data; forget removes it", () => {
    const storage = new MemoryStorage();
    storage.setItem("cce-remote:read:mac", "{nope");
    expect(loadReadState("mac", storage)).toBeNull();
    storage.setItem("cce-remote:read:mac", JSON.stringify({ baseline: "x", seen: {} }));
    expect(loadReadState("mac", storage)).toBeNull();
    storage.setItem("cce-remote:read:mac", JSON.stringify({ baseline: 5, seen: { a: 1, b: "x", c: null } }));
    expect(loadReadState("mac", storage)).toEqual({ baseline: 5, seen: { a: 1 } });
    expect(loadReadState("other", storage)).toBeNull();
    forgetReadState("mac", storage);
    expect(storage.getItem("cce-remote:read:mac")).toBeNull();
  });

  test("a storage that throws", () => {
    const storage = {
      getItem(): string | null {
        throw new Error("denied");
      },
      setItem() {
        throw new Error("quota");
      },
      removeItem() {
        throw new Error("denied");
      },
    };
    expect(loadReadState("mac", storage)).toBeNull();
    expect(() => saveReadState("mac", { baseline: 1, seen: {} }, storage)).not.toThrow();
    expect(() => forgetReadState("mac", storage)).not.toThrow();
  });
});
