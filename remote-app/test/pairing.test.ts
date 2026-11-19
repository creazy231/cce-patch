import { describe, expect, test } from "bun:test";
import { defaultDeviceName, normalizeMacUrl, parsePairingInput } from "../src/lib/pairing";

// The bridge builds its pairing link as
//   <appUrl or https://cce-remote.invalid>/#pair=<base64url(JSON {v:1,u,c,n})>
// The app and the bridge are separate tracks, so the format is rebuilt here instead of imported.
const b64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");
const MAC_URL = "https://example-mac.tailnet-0000.ts.net:47821";
const payload = { v: 1, u: MAC_URL, c: "ABCDEFGH", n: "Example Mac" };
const fragment = (p: object) => `pair=${b64url(JSON.stringify(p))}`;
const link = (p: object, origin = "https://app.example.com") => `${origin}/#${fragment(p)}`;

describe("parsePairingInput", () => {
  const expected = { url: MAC_URL, code: "ABCDEFGH", name: "Example Mac" };

  test("reads a full pairing link (round trip of the bridge's format)", () => {
    expect(parsePairingInput(link(payload))).toEqual(expected);
  });

  test("ignores the link's origin, including the bridge's placeholder origin", () => {
    expect(parsePairingInput(link(payload, "https://cce-remote.invalid"))).toEqual(expected);
    expect(parsePairingInput(link(payload, "https://cce-remote.invalid/"))).toEqual(expected);
  });

  test("reads a bare #pair= fragment (the app's own location.hash)", () => {
    expect(parsePairingInput(`#${fragment(payload)}`)).toEqual(expected);
    expect(parsePairingInput(fragment(payload))).toEqual(expected);
  });

  test("reads the raw base64url payload", () => {
    expect(parsePairingInput(b64url(JSON.stringify(payload)))).toEqual(expected);
  });

  test("trims whitespace and newlines around pasted input", () => {
    expect(parsePairingInput(`  \n${link(payload)}\n  `)).toEqual(expected);
  });

  test("decodes non-ASCII Mac names as UTF-8", () => {
    const parsed = parsePairingInput(link({ ...payload, n: "Café Mac ☕" }));
    expect(parsed?.name).toBe("Café Mac ☕");
  });

  test("reads 'https://host:port CODE' typed by hand; the code is normalised", () => {
    expect(parsePairingInput(`${MAC_URL} abcd-efgh`)).toEqual({
      url: MAC_URL,
      code: "ABCDEFGH",
      name: "example-mac",
    });
    expect(parsePairingInput(`  ${MAC_URL}   ABCD EFGH  `)?.code).toBe("ABCDEFGH");
  });

  test("hand-typed address without scheme or port gets https and the default port", () => {
    expect(parsePairingInput("example-mac.tailnet-0000.ts.net ABCD-EFGH")).toEqual({
      url: MAC_URL,
      code: "ABCDEFGH",
      name: "example-mac",
    });
  });

  test("hand-typed local address for development is accepted over http", () => {
    expect(parsePairingInput("http://127.0.0.1:47998 ABCD-EFGH")).toEqual({
      url: "http://127.0.0.1:47998",
      code: "ABCDEFGH",
      name: "127.0.0.1",
    });
  });

  test("falls back to the host name when the link carries no Mac name", () => {
    expect(parsePairingInput(link({ v: 1, u: MAC_URL, c: "ABCDEFGH" }))?.name).toBe("example-mac");
    expect(parsePairingInput(link({ v: 1, u: MAC_URL, c: "ABCDEFGH", n: "  " }))?.name).toBe("example-mac");
  });

  test("normalises the address and the code inside a link", () => {
    const parsed = parsePairingInput(
      link({ v: 1, u: "example-mac.tailnet-0000.ts.net", c: "abcd-efgh", n: "Example Mac" }),
    );
    expect(parsed).toEqual(expected);
  });

  test("rejects input that is not a pairing payload", () => {
    for (const bad of ["", "   ", "hello world", "not-a-link", "https://app.example.com/", "#pair=", "#pair=%%%"]) {
      expect(parsePairingInput(bad)).toBeNull();
    }
  });

  test("rejects a payload that is not JSON, or JSON of the wrong shape", () => {
    expect(parsePairingInput(`#pair=${b64url("just text")}`)).toBeNull();
    expect(parsePairingInput(`#pair=${b64url("[1,2,3]")}`)).toBeNull();
    expect(parsePairingInput(`#pair=${b64url("null")}`)).toBeNull();
    expect(parsePairingInput(`#pair=${b64url(JSON.stringify({ v: 1, u: MAC_URL, c: 12345678 }))}`)).toBeNull();
  });

  test("rejects an unknown protocol version", () => {
    expect(parsePairingInput(link({ ...payload, v: 2 }))).toBeNull();
    expect(parsePairingInput(link({ u: MAC_URL, c: "ABCDEFGH", n: "x" }))).toBeNull();
  });

  test("rejects a link that points at an insecure or foreign address", () => {
    expect(parsePairingInput(link({ ...payload, u: "http://evil" }))).toBeNull();
    expect(parsePairingInput(link({ ...payload, u: "http://example-mac.tailnet-0000.ts.net:47821" }))).toBeNull();
    expect(parsePairingInput(link({ ...payload, u: "javascript:alert(1)" }))).toBeNull();
  });

  test("rejects a code that cannot be a pairing code, so no try is wasted on the Mac", () => {
    expect(parsePairingInput(link({ ...payload, c: "" }))).toBeNull();
    expect(parsePairingInput(link({ ...payload, c: "ABC" }))).toBeNull();
    expect(parsePairingInput(link({ ...payload, c: "ABCDEFGHJ2" }))).toBeNull();
    expect(parsePairingInput(`${MAC_URL} ABCD`)).toBeNull();
    expect(parsePairingInput(`${MAC_URL} 0000-0000`)).toBeNull();
  });

  test("rejects a hand-typed address that is not allowed", () => {
    expect(parsePairingInput("http://evil ABCD-EFGH")).toBeNull();
    expect(parsePairingInput("ABCD-EFGH")).toBeNull();
  });
});

describe("normalizeMacUrl", () => {
  test("adds https and the default port to a bare host name", () => {
    expect(normalizeMacUrl("example-mac.tailnet-0000.ts.net")).toBe(MAC_URL);
  });

  test("keeps an explicit port, drops the trailing slash, path, query and fragment", () => {
    expect(normalizeMacUrl("https://example-mac.tailnet-0000.ts.net:8443")).toBe(
      "https://example-mac.tailnet-0000.ts.net:8443",
    );
    expect(normalizeMacUrl(`${MAC_URL}/`)).toBe(MAC_URL);
    expect(normalizeMacUrl(`${MAC_URL}/ws?x=1#y`)).toBe(MAC_URL);
  });

  test("keeps an explicit :443, which URL parsing would otherwise swallow", () => {
    expect(normalizeMacUrl("https://example-mac.tailnet-0000.ts.net:443")).toBe(
      "https://example-mac.tailnet-0000.ts.net:443",
    );
  });

  test("lower-cases the host and trims whitespace", () => {
    expect(normalizeMacUrl("  HTTPS://Example-Mac.Tailnet-0000.ts.net  ")).toBe(MAC_URL);
  });

  test("rejects http except for localhost and 127.0.0.1", () => {
    expect(normalizeMacUrl("http://evil")).toBeNull();
    expect(normalizeMacUrl("http://example-mac.tailnet-0000.ts.net:47821")).toBeNull();
    expect(normalizeMacUrl("http://localhost:47998")).toBe("http://localhost:47998");
    expect(normalizeMacUrl("http://127.0.0.1:47998")).toBe("http://127.0.0.1:47998");
    expect(normalizeMacUrl("http://localhost")).toBe("http://localhost:47821");
  });

  test("rejects other schemes, credentials, empty input and bad ports", () => {
    for (const bad of [
      "",
      "   ",
      "https://",
      "ftp://example.com",
      "ws://example.com",
      "javascript:alert(1)",
      "https://user:pw@example.com",
      "exa mple.com",
      "example-mac.tailnet-0000.ts.net:0",
      "example-mac.tailnet-0000.ts.net:99999",
    ]) {
      expect(normalizeMacUrl(bad)).toBeNull();
    }
  });
});

describe("defaultDeviceName", () => {
  test("names the device by the user agent", () => {
    expect(defaultDeviceName("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("iPhone");
    expect(defaultDeviceName("Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15")).toBe("iPad");
    expect(defaultDeviceName("Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36")).toBe("Android phone");
    expect(defaultDeviceName("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("Mac");
  });

  test("an iPad that reports a desktop user agent is recognised by its touch screen", () => {
    const desktopUa = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    expect(defaultDeviceName(desktopUa, 5)).toBe("iPad");
  });

  test("falls back to Phone", () => {
    expect(defaultDeviceName("")).toBe("Phone");
    expect(defaultDeviceName("curl/8.0")).toBe("Phone");
  });
});
