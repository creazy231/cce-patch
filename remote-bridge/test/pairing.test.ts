import { describe, expect, test } from "bun:test";
import { CODE_ALPHABET, CODE_TTL_MS, MAX_ATTEMPTS, Pairing, createDevice, formatCode, hashToken, normalizeCode, pairingLink, verifyToken } from "../lib/pairing.js";

const NOW = 1_800_000_000_000;
const ORIGIN = "https://app.example.test";

/** A code of the right shape that is not `code`. */
function wrongCode(code: string): string {
  return (code[0] === "A" ? "B" : "A") + code.slice(1);
}

describe("constants", () => {
  test("the alphabet leaves out the look-alikes 0 1 I L O", () => {
    expect(CODE_ALPHABET).toBe("ABCDEFGHJKMNPQRSTUVWXYZ23456789");
    expect(new Set(CODE_ALPHABET).size).toBe(CODE_ALPHABET.length);
    for (const ch of "01ILO") expect(CODE_ALPHABET).not.toContain(ch);
  });

  test("a code lives 10 minutes and takes 5 tries", () => {
    expect(CODE_TTL_MS).toBe(600_000);
    expect(MAX_ATTEMPTS).toBe(5);
  });
});

describe("newCode", () => {
  test("is 8 characters from the alphabet and expires after the TTL", () => {
    const pairing = new Pairing();
    const { code, expiresAt } = pairing.newCode(NOW);
    expect(code).toHaveLength(8);
    for (const ch of code) expect(CODE_ALPHABET).toContain(ch);
    expect(expiresAt).toBe(NOW + CODE_TTL_MS);
  });

  test("defaults to the current time", () => {
    const before = Date.now();
    const { expiresAt } = new Pairing().newCode();
    expect(expiresAt).toBeGreaterThanOrEqual(before + CODE_TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + CODE_TTL_MS);
  });

  test("draws from the whole alphabet and does not repeat", () => {
    const pairing = new Pairing();
    const seen = new Set<string>();
    const codes = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const { code } = pairing.newCode(NOW);
      codes.add(code);
      for (const ch of code) seen.add(ch);
    }
    expect([...seen].sort().join("")).toBe([...CODE_ALPHABET].sort().join(""));
    expect(codes.size).toBeGreaterThan(1990);
  });

  test("replaces the previous code", () => {
    const pairing = new Pairing();
    const first = pairing.newCode(NOW);
    const second = pairing.newCode(NOW + 1000);
    expect(second.code).not.toBe(first.code);
    expect(pairing.current(NOW + 1000)).toEqual(second);
    expect(pairing.consume(first.code, NOW + 1000)).toBe(false);
    expect(pairing.consume(second.code, NOW + 1000)).toBe(true);
  });

  test("a new code starts with a fresh count of tries", () => {
    const pairing = new Pairing();
    const first = pairing.newCode(NOW);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(pairing.consume(wrongCode(first.code), NOW)).toBe(false);
    const second = pairing.newCode(NOW);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(pairing.consume(wrongCode(second.code), NOW)).toBe(false);
    expect(pairing.consume(second.code, NOW)).toBe(true);
  });
});

describe("current", () => {
  test("is null before a code was made", () => {
    expect(new Pairing().current(NOW)).toBeNull();
  });

  test("returns the code and when it expires, until the TTL has passed", () => {
    const pairing = new Pairing();
    const { code, expiresAt } = pairing.newCode(NOW);
    expect(pairing.current(NOW)).toEqual({ code, expiresAt });
    expect(pairing.current(expiresAt)).toEqual({ code, expiresAt });
    expect(pairing.current(expiresAt + 1)).toBeNull();
  });

  test("hands out a copy: changing it does not change the code", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    const view = pairing.current(NOW) as { code: string; expiresAt: number };
    view.code = "XXXXXXXX";
    expect(pairing.current(NOW)?.code).toBe(code);
  });

  test("is null once the code was used or ran out of tries", () => {
    const used = new Pairing();
    const first = used.newCode(NOW);
    expect(used.consume(first.code, NOW)).toBe(true);
    expect(used.current(NOW)).toBeNull();

    const burnt = new Pairing();
    const second = burnt.newCode(NOW);
    for (let i = 0; i < MAX_ATTEMPTS; i++) burnt.consume(wrongCode(second.code), NOW);
    expect(burnt.current(NOW)).toBeNull();
  });
});

describe("consume", () => {
  test("takes the code as typed: any case, with spaces or a dash", () => {
    const variants = (code: string) => [code, code.toLowerCase(), `${code.slice(0, 4)}-${code.slice(4)}`, `${code.slice(0, 4).toLowerCase()} ${code.slice(4).toLowerCase()}`, `  ${code}\n`];
    for (let i = 0; i < 5; i++) {
      const pairing = new Pairing();
      const { code } = pairing.newCode(NOW);
      expect(pairing.consume(variants(code)[i], NOW)).toBe(true);
    }
  });

  test("is single use", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    expect(pairing.consume(code, NOW)).toBe(true);
    expect(pairing.consume(code, NOW)).toBe(false);
  });

  test("fails without a code, and for a wrong one", () => {
    const pairing = new Pairing();
    expect(pairing.consume("ABCDEFGH", NOW)).toBe(false);
    const { code } = pairing.newCode(NOW);
    expect(pairing.consume(wrongCode(code), NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(true); // one wrong try does not burn it
  });

  test("fails after the TTL, and works up to it", () => {
    const late = new Pairing();
    const first = late.newCode(NOW);
    expect(late.consume(first.code, first.expiresAt + 1)).toBe(false);
    const edge = new Pairing();
    const second = edge.newCode(NOW);
    expect(edge.consume(second.code, second.expiresAt)).toBe(true);
  });

  test("a clock that is no number counts as past the expiry", () => {
    const watched = new Pairing();
    watched.newCode(NOW);
    expect(watched.current(NaN)).toBeNull();

    const used = new Pairing();
    const { code } = used.newCode(NOW);
    expect(used.consume(code, NaN)).toBe(false);
    expect(used.consume(code, NOW)).toBe(false); // dropped for good
  });

  test("an expired code stays expired", () => {
    const pairing = new Pairing();
    const { code, expiresAt } = pairing.newCode(NOW);
    expect(pairing.consume(code, expiresAt + 1)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(false);
  });

  test("5 wrong tries invalidate the code, even for the right one afterwards", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    for (let i = 0; i < MAX_ATTEMPTS; i++) expect(pairing.consume(wrongCode(code), NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(false);
  });

  test("the right code still works on the 5th try", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) expect(pairing.consume(wrongCode(code), NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(true);
  });

  test("input that is no text never matches, and counts as a wrong try", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    // [code] would become the code if it were turned into text, which a JSON frame can make it
    for (const bad of [undefined, null, 12345678, {}, [code]]) expect(pairing.consume(bad as any, NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(false); // those were the 5 tries
  });

  test("an empty try counts too", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    for (const bad of ["", "----", " ", "01IOL"]) expect(pairing.consume(bad, NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(true); // 4 tries so far
  });

  test("a try with a code that is too long or too short does not match", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode(NOW);
    expect(pairing.consume(`${code}A`, NOW)).toBe(false);
    expect(pairing.consume(code.slice(0, 7), NOW)).toBe(false);
    expect(pairing.consume(code, NOW)).toBe(true);
  });

  test("defaults to the current time", () => {
    const pairing = new Pairing();
    const { code } = pairing.newCode();
    expect(pairing.current()?.code).toBe(code);
    expect(pairing.consume(code)).toBe(true);
  });
});

describe("formatCode and normalizeCode", () => {
  test("formatCode puts a dash in the middle", () => {
    expect(formatCode("ABCDEFGH")).toBe("ABCD-EFGH");
    expect(formatCode("A2B3C4D5")).toBe("A2B3-C4D5");
    expect(formatCode(new Pairing().newCode(NOW).code)).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  test("normalizeCode upper-cases and drops everything outside the alphabet", () => {
    expect(normalizeCode("abcd efgh")).toBe("ABCDEFGH");
    expect(normalizeCode("abcd-efgh")).toBe("ABCDEFGH");
    expect(normalizeCode("  ab cd\tef\ngh ")).toBe("ABCDEFGH");
    expect(normalizeCode("ABCDEFGH")).toBe("ABCDEFGH");
    expect(normalizeCode("0O1Il2")).toBe("2"); // 0 O 1 I l are not in the alphabet
    expect(normalizeCode("a.b/c_d")).toBe("ABCD");
    expect(normalizeCode("")).toBe("");
  });

  test("normalizeCode folds ASCII only", () => {
    expect(normalizeCode("\u00df")).toBe(""); // sharp s: would upper-case to "SS"
    expect(normalizeCode("\u017f")).toBe(""); // long s: upper-cases to "S"
    expect(normalizeCode("\uff41\uff42")).toBe(""); // full-width a and b
  });

  test("normalizeCode of something that is no text is empty", () => {
    for (const bad of [undefined, null, 12345678, {}, ["ABCD"]]) expect(normalizeCode(bad as any)).toBe("");
  });

  test("a normalized formatted code is the code", () => {
    const { code } = new Pairing().newCode(NOW);
    expect(normalizeCode(formatCode(code))).toBe(code);
  });
});

describe("tokens and devices", () => {
  test("createDevice makes an id, a token and a hash of the token", () => {
    const { device, token } = createDevice({ name: "Test Phone", origin: ORIGIN, now: NOW });
    expect(device.id).toMatch(/^[0-9a-f]{16}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes, base64url without padding
    expect(device.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(device.tokenHash).toBe(hashToken(token));
    expect(device).toEqual({ id: device.id, name: "Test Phone", tokenHash: device.tokenHash, origin: ORIGIN, createdAt: NOW, lastSeenAt: NOW });
    expect(JSON.stringify(device)).not.toContain(token); // only the hash is kept
  });

  test("two devices share nothing", () => {
    const a = createDevice({ name: "A", origin: ORIGIN, now: NOW });
    const b = createDevice({ name: "B", origin: ORIGIN, now: NOW });
    expect(a.device.id).not.toBe(b.device.id);
    expect(a.token).not.toBe(b.token);
    expect(a.device.tokenHash).not.toBe(b.device.tokenHash);
  });

  test("the name is trimmed, cut to 60 characters and defaults to Phone", () => {
    const make = (name?: any) => createDevice({ name, origin: ORIGIN, now: NOW }).device.name;
    expect(make("  Test Phone \n")).toBe("Test Phone");
    expect(make("x".repeat(100))).toBe("x".repeat(60));
    expect(make("x".repeat(59) + " " + "y".repeat(20))).toBe("x".repeat(59)); // no trailing space after the cut
    expect(make(undefined)).toBe("Phone");
    expect(make("")).toBe("Phone");
    expect(make("   ")).toBe("Phone");
    expect(make(42)).toBe("Phone");
    expect(Array.from(make("😀".repeat(100)))).toHaveLength(60); // counted by code point: a cut never leaves half a surrogate pair
    expect(make("😀".repeat(100))).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  test("createDevice works with no arguments at all", () => {
    const before = Date.now();
    const { device, token } = createDevice();
    expect(device.name).toBe("Phone");
    expect(device.origin).toBe("");
    expect(device.createdAt).toBeGreaterThanOrEqual(before);
    expect(device.lastSeenAt).toBe(device.createdAt);
    expect(verifyToken(device, token)).toBe(true);
  });

  test("the origin is kept as it came, an unusable one becomes empty", () => {
    expect(createDevice({ name: "A", origin: ORIGIN, now: NOW }).device.origin).toBe(ORIGIN);
    expect(createDevice({ name: "A", origin: undefined, now: NOW }).device.origin).toBe("");
    expect(createDevice({ name: "A", origin: 5 as any, now: NOW }).device.origin).toBe("");
  });

  test("hashToken is the hex SHA-256", () => {
    expect(hashToken("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hashToken("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  test("verifyToken accepts the token of the device and nothing else", () => {
    const { device, token } = createDevice({ name: "Test Phone", origin: ORIGIN, now: NOW });
    const other = createDevice({ name: "Other", origin: ORIGIN, now: NOW });
    expect(verifyToken(device, token)).toBe(true);
    expect(verifyToken(device, other.token)).toBe(false);
    expect(verifyToken(device, `${token}x`)).toBe(false);
    expect(verifyToken(device, token.slice(0, -1))).toBe(false);
    expect(verifyToken(device, token.toLowerCase() === token ? token.toUpperCase() : token.toLowerCase())).toBe(false);
  });

  test("verifyToken of a token with another length is false and does not throw", () => {
    const { device } = createDevice({ name: "Test Phone", origin: ORIGIN, now: NOW });
    for (const bad of ["", "x", "short", "x".repeat(42), "x".repeat(44), "x".repeat(10_000), device.tokenHash]) {
      expect(verifyToken(device, bad)).toBe(false);
    }
  });

  test("verifyToken is false for input that is no token, or a device that cannot match", () => {
    const { device, token } = createDevice({ name: "Test Phone", origin: ORIGIN, now: NOW });
    for (const bad of [undefined, null, 5, {}, [token]]) expect(verifyToken(device, bad as any)).toBe(false);
    expect(verifyToken(null as any, token)).toBe(false);
    expect(verifyToken(undefined as any, token)).toBe(false);
    expect(verifyToken({} as any, token)).toBe(false);
    for (const tokenHash of ["", "zz", device.tokenHash.slice(0, 62), `${device.tokenHash}00`, `${device.tokenHash.slice(0, 62)}zz`, 5, null]) {
      expect(verifyToken({ ...device, tokenHash } as any, token)).toBe(false);
    }
  });
});

describe("pairingLink", () => {
  const MAC_URL = "https://example-mac.tailnet-0000.ts.net:47821";
  const fragmentOf = (link: string) => link.slice(link.indexOf("#pair=") + "#pair=".length);
  const decode = (link: string) => JSON.parse(Buffer.from(fragmentOf(link), "base64url").toString("utf8"));

  test("decodes back to the payload", () => {
    const link = pairingLink({ appUrl: "https://app.example.test", url: MAC_URL, code: "ABCDEFGH", macName: "Example Mac" });
    expect(link.startsWith("https://app.example.test/#pair=")).toBe(true);
    expect(decode(link)).toEqual({ v: 1, u: MAC_URL, c: "ABCDEFGH", n: "Example Mac" });
  });

  test("uses the placeholder origin without an app URL", () => {
    for (const appUrl of [undefined, "", null as any, 5 as any]) {
      const link = pairingLink({ appUrl, url: MAC_URL, code: "ABCDEFGH", macName: "Example Mac" });
      expect(link.startsWith("https://cce-remote.invalid/#pair=")).toBe(true);
      expect(decode(link)).toEqual({ v: 1, u: MAC_URL, c: "ABCDEFGH", n: "Example Mac" });
    }
  });

  test("drops trailing slashes of the app URL, keeps a path", () => {
    expect(pairingLink({ appUrl: "https://app.example.test///", url: MAC_URL, code: "ABCDEFGH", macName: "M" }).startsWith("https://app.example.test/#pair=")).toBe(true);
    expect(pairingLink({ appUrl: "https://app.example.test/remote/", url: MAC_URL, code: "ABCDEFGH", macName: "M" }).startsWith("https://app.example.test/remote/#pair=")).toBe(true);
  });

  test("the fragment is base64url: no +, / or =", () => {
    for (const macName of ["Example Mac", "???>>>~~~", "x".repeat(1), "ab", "abc"]) {
      expect(fragmentOf(pairingLink({ appUrl: "", url: `${MAC_URL}/?q=>>>`, code: "ABCDEFGH", macName }))).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("a name with characters outside ASCII survives", () => {
    const macName = "Büro-Mac ✨ 日本語";
    expect(decode(pairingLink({ appUrl: "", url: MAC_URL, code: "ABCDEFGH", macName })).n).toBe(macName);
  });

  test("goes into one URL and parses as one", () => {
    const link = pairingLink({ appUrl: "https://app.example.test", url: MAC_URL, code: "ABCDEFGH", macName: "Example Mac" });
    const parsed = new URL(link);
    expect(parsed.origin).toBe("https://app.example.test");
    expect(parsed.hash.startsWith("#pair=")).toBe(true);
    expect(parsed.search).toBe("");
  });
});
