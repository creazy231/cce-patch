import { afterEach, describe, expect, test } from "bun:test";
import {
  loadMacs,
  removeMac,
  saveMacs,
  selectedMacId,
  selectMac,
  upsertMac,
  type Mac,
  type StorageLike,
} from "../src/lib/macs";

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

/** A storage that refuses everything, like a browser with site data blocked. */
const brokenStorage: StorageLike = {
  getItem() {
    throw new Error("SecurityError");
  },
  setItem() {
    throw new Error("QuotaExceededError");
  },
  removeItem() {
    throw new Error("SecurityError");
  },
};

const mac = (n: number, over: Partial<Mac> = {}): Mac => ({
  id: `dev${n}`,
  name: `Example Mac ${n}`,
  url: `https://example-mac-${n}.tailnet-0000.ts.net:47821`,
  deviceId: `dev${n}`,
  token: `tok${n}`,
  ...over,
});

describe("loadMacs / saveMacs", () => {
  test("nothing stored yet", () => {
    const store = new MemoryStorage();
    expect(loadMacs(store)).toEqual([]);
    expect(selectedMacId(store)).toBeNull();
  });

  test("round trip under the key cce-remote:macs", () => {
    const store = new MemoryStorage();
    expect(saveMacs([mac(1), mac(2)], store)).toBe(true);
    expect(JSON.parse(store.getItem("cce-remote:macs")!)).toEqual([mac(1), mac(2)]);
    expect(loadMacs(store)).toEqual([mac(1), mac(2)]);
  });

  test("corrupt or foreign data loads as an empty list", () => {
    const store = new MemoryStorage();
    for (const junk of ["{not json", "null", '"text"', '{"a":1}', "42"]) {
      store.setItem("cce-remote:macs", junk);
      expect(loadMacs(store)).toEqual([]);
    }
  });

  test("entries that lack a field or have the wrong type are dropped, extra fields are not kept", () => {
    const store = new MemoryStorage();
    store.setItem(
      "cce-remote:macs",
      JSON.stringify([
        mac(1),
        { id: "x", name: "no token", url: "https://a.example", deviceId: "d" },
        { ...mac(2), token: 5 },
        null,
        "str",
        { ...mac(3), extra: "ignored" },
        { ...mac(4), token: "" },
        { ...mac(5), id: "" },
      ]),
    );
    expect(loadMacs(store)).toEqual([mac(1), mac(3)]);
  });

  test("a storage that throws neither crashes loading nor saving", () => {
    expect(loadMacs(brokenStorage)).toEqual([]);
    expect(saveMacs([mac(1)], brokenStorage)).toBe(false);
    expect(selectedMacId(brokenStorage)).toBeNull();
    expect(() => selectMac("dev1", brokenStorage)).not.toThrow();
    expect(() => upsertMac(mac(1), brokenStorage)).not.toThrow();
    expect(() => removeMac("dev1", brokenStorage)).not.toThrow();
  });
});

describe("upsertMac / removeMac", () => {
  test("a new Mac is appended, and the list is returned", () => {
    const store = new MemoryStorage();
    expect(upsertMac(mac(1), store)).toEqual([mac(1)]);
    expect(upsertMac(mac(2), store)).toEqual([mac(1), mac(2)]);
    expect(loadMacs(store)).toEqual([mac(1), mac(2)]);
  });

  test("the same id replaces the entry in place", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2), mac(3)], store);
    expect(upsertMac(mac(2, { name: "Renamed" }), store)).toEqual([mac(1), mac(2, { name: "Renamed" }), mac(3)]);
  });

  test("pairing the same Mac again (same url, new device) replaces the old entry instead of duplicating it", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    const repaired = mac(9, { url: mac(1).url });
    expect(upsertMac(repaired, store)).toEqual([repaired, mac(2)]);
  });

  test("removeMac removes by id; an unknown id changes nothing", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    expect(removeMac("dev1", store)).toEqual([mac(2)]);
    expect(removeMac("nope", store)).toEqual([mac(2)]);
    expect(loadMacs(store)).toEqual([mac(2)]);
  });
});

describe("selectedMacId / selectMac", () => {
  test("selectMac stores the id under cce-remote:selected", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    selectMac("dev2", store);
    expect(store.getItem("cce-remote:selected")).toBe("dev2");
    expect(selectedMacId(store)).toBe("dev2");
  });

  test("an unknown or missing selection falls back to the first Mac, and to null without Macs", () => {
    const store = new MemoryStorage();
    expect(selectedMacId(store)).toBeNull();
    saveMacs([mac(1), mac(2)], store);
    expect(selectedMacId(store)).toBe("dev1");
    selectMac("gone", store);
    expect(selectedMacId(store)).toBe("dev1");
  });

  test("selectMac(null) clears the selection", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    selectMac("dev2", store);
    selectMac(null, store);
    expect(store.getItem("cce-remote:selected")).toBeNull();
    expect(selectedMacId(store)).toBe("dev1");
  });

  test("removing the selected Mac clears the selection", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    selectMac("dev2", store);
    removeMac("dev2", store);
    expect(store.getItem("cce-remote:selected")).toBeNull();
    expect(selectedMacId(store)).toBe("dev1");
  });

  test("removing another Mac keeps the selection", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    selectMac("dev2", store);
    removeMac("dev1", store);
    expect(selectedMacId(store)).toBe("dev2");
  });

  test("re-pairing the selected Mac keeps it selected under its new id", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    selectMac("dev2", store); // not the first one, so the "first Mac" fallback cannot hide a lost selection
    upsertMac(mac(9, { url: mac(2).url }), store);
    expect(store.getItem("cce-remote:selected")).toBe("dev9");
    expect(selectedMacId(store)).toBe("dev9");
  });

  test("re-pairing another Mac leaves the selection alone", () => {
    const store = new MemoryStorage();
    saveMacs([mac(1), mac(2)], store);
    selectMac("dev2", store);
    upsertMac(mac(9, { url: mac(1).url }), store);
    expect(selectedMacId(store)).toBe("dev2");
  });
});

describe("default storage", () => {
  const g = globalThis as { localStorage?: StorageLike };
  const original = g.localStorage;
  afterEach(() => {
    if (original === undefined) delete g.localStorage;
    else g.localStorage = original;
  });

  test("uses localStorage when it exists", () => {
    const store = new MemoryStorage();
    g.localStorage = store;
    upsertMac(mac(1));
    selectMac("dev1");
    expect(store.getItem("cce-remote:macs")).toBe(JSON.stringify([mac(1)]));
    expect(store.getItem("cce-remote:selected")).toBe("dev1");
    expect(loadMacs()).toEqual([mac(1)]);
  });

  test("without any usable localStorage the app still works for the session, in memory", () => {
    g.localStorage = brokenStorage;
    upsertMac(mac(7));
    selectMac("dev7");
    expect(loadMacs()).toEqual([mac(7)]);
    expect(selectedMacId()).toBe("dev7");
    removeMac("dev7");
    expect(loadMacs()).toEqual([]);
  });
});
