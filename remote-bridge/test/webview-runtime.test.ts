import { describe, expect, test } from "bun:test";
import { CONNECTION_RUNTIME } from "../install.ts";
import { FakeClock, FakeDocument, type FakeElement, button, byClass, findAll, settle } from "./fake-dom.ts";

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const TAILSCALE = {
  installed: true,
  running: true,
  loginName: "owner@example.com",
  dnsName: "example-mac.tailnet-0000.ts.net",
  httpsEnabled: true,
};
const OFF = {
  enabled: false,
  role: "off",
  port: 47821,
  macName: "example-mac",
  tailscale: TAILSCALE,
  serve: { configured: false },
  windows: 0,
  devices: [] as object[],
  appUrl: "",
};
const PAIRING = {
  code: "ABCD-EFGH",
  expiresAt: NOW + 600_000,
  link: "https://cce-remote.example.com/#pair=eyJ2IjoxfQ",
  qr: { size: 21, path: "M0 0h7v7h-7zM14 0h7v7h-7z" },
};
const HUB = {
  ...OFF,
  enabled: true,
  role: "hub",
  url: "https://example-mac.tailnet-0000.ts.net:47821",
  serve: { configured: true },
  windows: 2,
  devices: [
    { id: "a1b2c3d4e5f60718", name: "iPhone", createdAt: Date.UTC(2026, 10, 1), lastSeenAt: NOW - 5 * 60_000 },
  ],
  pairing: PAIRING,
  appUrl: "https://cce-remote.example.com",
};

type Request = Record<string, any> & { type: string };
type Handler = (request: Request) => unknown;

/** Answers every request with `status` (the bridge's shape: `<type>_response`). */
const answer = (status: object): Handler => (request) => ({ type: `${request.type}_response`, status });

function setup(handler: Handler = answer(OFF), { attach = true } = {}) {
  const clock = new FakeClock();
  clock.now = NOW;
  const document = new FakeDocument();
  const window: any = {};
  const warnings: unknown[][] = [];
  const fakeConsole = { warn: (...args: unknown[]) => warnings.push(args), error: (...args: unknown[]) => warnings.push(args), log() {} };
  const load = () =>
    new Function("window", "document", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "console", CONNECTION_RUNTIME)(
      window, document, clock.setTimeout, clock.clearTimeout, clock.setInterval, clock.clearInterval, clock.Date, fakeConsole,
    );
  load();
  const sent: Request[] = [];
  let respond = handler;
  const sessions = {
    comms: {
      connection: {
        value: {
          sendRequest(request: Request) {
            sent.push(request);
            return Promise.resolve().then(() => respond(request));
          },
        },
      },
    },
  };
  const remote = window.__cceRemote;
  if (attach) remote.attach(sessions);
  // The element React gives the ref: the list content's classes plus cce-conn, inside the app.
  const app = document.body.appendChild(document.createElement("div"));
  const host = app.appendChild(document.createElement("div"));
  host.className = "content_Zr4Kp1 cce-conn";
  return {
    clock, document, window, remote, sent, app, host, warnings, load,
    types: () => sent.map((r) => r.type),
    respondWith(next: Handler) {
      respond = next;
    },
    /** Lets every pending promise (requests, their answers, the re-render) run. */
    settle,
  };
}

const view = (host: FakeElement) => byClass(host, "cce-conn-view");
const text = (el: FakeElement | undefined) => (el ? el.textContent : "");

/** A promise a test resolves by hand. */
function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("window.__cceRemote", () => {
  test("is defined once, with attach, mount and request", () => {
    const t = setup();
    const first = t.window.__cceRemote;
    expect(typeof first.attach).toBe("function");
    expect(typeof first.mount).toBe("function");
    expect(typeof first.request).toBe("function");
    t.load();
    expect(t.window.__cceRemote).toBe(first);
    expect(Object.keys(t.window)).toEqual(["__cceRemote"]);
  });

  test("request() goes through the sessions' connection and returns the answer", async () => {
    const t = setup((request) => ({ type: "cce_remote_copy_response", echo: request }));
    const res = await t.remote.request("cce_remote_copy", { text: "https://example.com", type: "not this" });
    expect(t.sent).toEqual([{ type: "cce_remote_copy", text: "https://example.com" }]);
    expect(res).toEqual({ type: "cce_remote_copy_response", echo: { type: "cce_remote_copy", text: "https://example.com" } });
  });

  test("request() before attach rejects instead of throwing", async () => {
    const t = setup(answer(OFF), { attach: false });
    await expect(t.remote.request("cce_remote_status")).rejects.toThrow();
  });

  test("mount returns nothing (React 19 would take a returned function for a cleanup)", () => {
    const t = setup();
    expect(t.remote.mount(t.host)).toBeUndefined();
    expect(t.remote.mount(null)).toBeUndefined();
  });

  test("the source is plain ES2019 that builds the DOM without innerHTML", () => {
    expect(CONNECTION_RUNTIME).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\?\.|\?\?|\beval\(/);
    expect(CONNECTION_RUNTIME.endsWith("\n")).toBe(true);
  });
});

describe("the Connection view", () => {
  test("renders at once and asks for the status", async () => {
    const t = setup();
    t.remote.mount(t.host);
    expect(text(view(t.host))).toContain("Phone remote");
    expect(text(view(t.host))).toContain("Control this Mac's Claude Code sessions from your phone over Tailscale.");
    expect(t.types()).toEqual(["cce_remote_status"]);
    await t.settle();
    expect(button(t.host, "Connect with Tailscale")).toBeDefined();
    expect(text(view(t.host))).toContain("Connected to Tailscale as owner@example.com");
    expect(text(view(t.host))).toContain("example-mac.tailnet-0000.ts.net");
    // Off: no pairing yet.
    expect(text(view(t.host))).not.toContain("Pair a phone");
  });

  test("polls every 2 s while mounted, and stops when unmounted", async () => {
    const t = setup();
    t.remote.mount(t.host);
    await t.settle();
    await t.clock.advance(1999);
    await t.settle();
    expect(t.types()).toEqual(["cce_remote_status"]);
    await t.clock.advance(1);
    await t.settle();
    expect(t.types()).toEqual(["cce_remote_status", "cce_remote_status"]);
    // React takes the element out, then calls the ref with null.
    t.app.removeChild(t.host);
    t.remote.mount(null);
    await t.clock.advance(0);
    await t.clock.advance(10_000);
    await t.settle();
    expect(t.types()).toHaveLength(2);
    expect(t.clock.pending).toBe(0);
  });

  test("re-renders only when the status changes", async () => {
    let status: object = OFF;
    const t = setup((request) => ({ type: `${request.type}_response`, status }));
    t.remote.mount(t.host);
    await t.settle();
    const before = view(t.host).children[0];
    await t.clock.advance(2000);
    await t.settle();
    expect(view(t.host).children[0]).toBe(before);
    status = { ...OFF, macName: "renamed" };
    await t.clock.advance(2000);
    await t.settle();
    expect(view(t.host).children[0]).not.toBe(before);
  });

  test("Connect: busy while it runs, then the connected view", async () => {
    const t = setup();
    t.remote.mount(t.host);
    await t.settle();
    const pending = deferred();
    t.respondWith((request) => (request.type === "cce_remote_connect" ? pending.promise : { type: "cce_remote_status_response", status: OFF }));
    button(t.host, "Connect with Tailscale").click();
    await t.settle();
    expect(t.types()).toContain("cce_remote_connect");
    const busy = button(t.host, "Connecting…");
    expect(busy).toBeDefined();
    expect(busy.disabled).toBe(true);
    // A second click while it runs sends nothing.
    busy.click();
    expect(t.types().filter((type) => type === "cce_remote_connect")).toHaveLength(1);

    t.respondWith(answer(HUB));
    pending.resolve({ type: "cce_remote_connect_response", status: HUB });
    await t.settle();
    const shown = text(view(t.host));
    expect(button(t.host, "Disconnect")).toBeDefined();
    expect(shown).toContain("Connected");
    expect(shown).toContain("This window serves your phone");
    expect(shown).toContain("Address");
    expect(shown).toContain("https://example-mac.tailnet-0000.ts.net:47821");
    expect(shown).toContain("2 VS Code windows connected");
    // The status is asked for again right after the action.
    expect(t.types().at(-1)).toBe("cce_remote_status");
  });

  test("a peer says it goes through another window; one window reads singular", async () => {
    const t = setup(answer({ ...HUB, role: "peer", windows: 1 }));
    t.remote.mount(t.host);
    await t.settle();
    expect(text(view(t.host))).toContain("Connected through another VS Code window");
    expect(text(view(t.host))).toContain("1 VS Code window connected");
  });

  test("Disconnect sends cce_remote_disconnect", async () => {
    const t = setup(answer(HUB));
    t.remote.mount(t.host);
    await t.settle();
    button(t.host, "Disconnect").click();
    await t.settle();
    expect(t.types()).toContain("cce_remote_disconnect");
  });

  test("pairing: QR code, code, countdown, New code and Copy link", async () => {
    const t = setup(answer(HUB));
    t.remote.mount(t.host);
    await t.settle();
    const shown = text(view(t.host));
    expect(shown).toContain("Pair a phone");
    expect(shown).toContain("1. On your phone, open the CCE Remote app (with Tailscale on).");
    expect(shown).toContain("2. Tap Add Mac, then scan this code or paste the link.");
    expect(shown).toContain("ABCD-EFGH");

    const [svg] = findAll(t.host, (el) => el.tagName === "svg");
    expect(svg.namespaceURI).toBe("http://www.w3.org/2000/svg");
    expect(svg.getAttribute("viewBox")).toBe("-4 -4 29 29");
    const [rect] = findAll(svg, (el) => el.tagName === "rect");
    expect(rect.getAttribute("fill")).toBe("#fff");
    expect([rect.getAttribute("x"), rect.getAttribute("y"), rect.getAttribute("width"), rect.getAttribute("height")]).toEqual(["-4", "-4", "29", "29"]);
    const [path] = findAll(svg, (el) => el.tagName === "path");
    expect(path.getAttribute("d")).toBe(PAIRING.qr.path);
    expect(path.getAttribute("fill")).toBe("#000");

    expect(text(view(t.host))).toContain("expires in 10:00");
    await t.clock.advance(1000);
    expect(text(view(t.host))).toContain("expires in 9:59");
    await t.clock.advance(60_000);
    expect(text(view(t.host))).toContain("expires in 8:59");

    button(t.host, "New code").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "cce_remote_new_code")).toBeDefined();
    button(t.host, "Copy link").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "cce_remote_copy")).toEqual({ type: "cce_remote_copy", text: PAIRING.link });
  });

  test("a QR code of a bad size isn't drawn", async () => {
    const t = setup(answer({ ...HUB, pairing: { ...PAIRING, qr: { size: -3, path: "M0 0" } } }));
    t.remote.mount(t.host);
    await t.settle();
    expect(findAll(t.host, (el) => el.tagName === "svg")).toHaveLength(0);
    expect(text(view(t.host))).toContain("ABCD-EFGH");
  });

  test("the app address field keeps what's typed across re-renders", async () => {
    let status: any = HUB;
    const t = setup((request) => ({ type: `${request.type}_response`, status }));
    t.remote.mount(t.host);
    await t.settle();
    const input = findAll(t.host, (el) => el.tagName === "INPUT")[0];
    expect(input.value).toBe("https://cce-remote.example.com");
    expect(input.placeholder).toBe("https://cce-remote.example.com");
    expect(text(view(t.host))).toContain("Used in the pairing link and QR code.");

    input.focus();
    input.value = "https://typing.example";
    status = { ...HUB, windows: 3, appUrl: "https://other.example" };
    await t.clock.advance(2000);
    await t.settle();
    expect(text(view(t.host))).toContain("3 VS Code windows connected");
    expect(findAll(t.host, (el) => el.tagName === "INPUT")[0]).toBe(input);
    expect(input.value).toBe("https://typing.example");
    expect(t.document.activeElement).toBe(input);

    input.blur();
    status = { ...HUB, windows: 4, appUrl: "https://other.example" };
    await t.clock.advance(2000);
    await t.settle();
    expect(input.value).toBe("https://other.example");
  });

  test("Save (or Enter) sends the app address; a bad one shows an error", async () => {
    const t = setup((request) =>
      request.type === "cce_remote_set_app_url" && !String(request.url).startsWith("https://")
        ? { type: "cce_remote_set_app_url_response", status: HUB, error: "bad_url" }
        : { type: `${request.type}_response`, status: HUB });
    t.remote.mount(t.host);
    await t.settle();
    const input = findAll(t.host, (el) => el.tagName === "INPUT")[0];
    input.value = "  https://app.example.com  ";
    button(t.host, "Save").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "cce_remote_set_app_url")).toEqual({ type: "cce_remote_set_app_url", url: "https://app.example.com" });

    input.focus();
    input.value = "http://plain.example.com";
    const enter = input.dispatch("keydown", { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    await t.settle();
    expect(t.sent.filter((r) => r.type === "cce_remote_set_app_url").at(-1)).toEqual({ type: "cce_remote_set_app_url", url: "http://plain.example.com" });
    expect(text(byClass(t.host, "cce-conn-notice"))).toMatch(/https:\/\//);
  });

  test("Tailscale not installed: a link to get it", async () => {
    const t = setup(answer({ ...OFF, tailscale: { installed: false, running: false, httpsEnabled: false } }));
    t.remote.mount(t.host);
    await t.settle();
    expect(text(view(t.host))).toContain("Tailscale isn't installed.");
    button(t.host, "Get Tailscale").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "open_url")).toEqual({ type: "open_url", url: "https://tailscale.com/download" });
  });

  test("Tailscale stopped: a button to open it", async () => {
    const t = setup(answer({ ...OFF, tailscale: { installed: true, running: false, httpsEnabled: false } }));
    t.remote.mount(t.host);
    await t.settle();
    expect(text(view(t.host))).toContain("Tailscale isn't running or is logged out.");
    button(t.host, "Open Tailscale").click();
    await t.settle();
    expect(t.types()).toContain("cce_remote_open_tailscale");
  });

  test("HTTPS certificates off: the consent link and the certificate-log warning", async () => {
    const consentUrl = "https://login.tailscale.com/f/serve?node=example";
    const t = setup(answer({ ...OFF, tailscale: { ...TAILSCALE, httpsEnabled: false, consentUrl } }));
    t.remote.mount(t.host);
    await t.settle();
    const shown = text(view(t.host));
    expect(shown).toContain("HTTPS certificates are off for your tailnet.");
    expect(shown).toContain(
      "Turning on HTTPS publishes this Mac's Tailscale name (example-mac.tailnet-0000.ts.net) in public certificate logs. " +
        "Rename the machine in Tailscale first if the name is personal.",
    );
    button(t.host, "Turn on HTTPS").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "open_url")).toEqual({ type: "open_url", url: consentUrl });
  });

  test("HTTPS off without a consent URL links to the DNS admin page", async () => {
    const t = setup(answer({ ...OFF, tailscale: { ...TAILSCALE, httpsEnabled: false } }));
    t.remote.mount(t.host);
    await t.settle();
    button(t.host, "Turn on HTTPS").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "open_url")).toEqual({ type: "open_url", url: "https://login.tailscale.com/admin/dns" });
  });

  test("paired devices: name, dates, Remove; and the empty state", async () => {
    const t = setup(answer(HUB));
    t.remote.mount(t.host);
    await t.settle();
    const device = byClass(t.host, "cce-conn-device");
    expect(text(device)).toContain("iPhone");
    expect(text(device)).toContain("paired ");
    expect(text(device)).toContain("last seen 5 min ago");
    button(device, "Remove").click();
    await t.settle();
    expect(t.sent.find((r) => r.type === "cce_remote_remove_device")).toEqual({ type: "cce_remote_remove_device", id: "a1b2c3d4e5f60718" });

    const empty = setup(answer(OFF));
    empty.remote.mount(empty.host);
    await empty.settle();
    expect(text(view(empty.host))).toContain("Paired devices");
    expect(text(view(empty.host))).toContain("No phones paired yet.");
  });

  test("a device with push shows notifications on", async () => {
    const t = setup(answer({ ...HUB, devices: [{ ...HUB.devices[0], push: true }] }));
    t.remote.mount(t.host);
    await t.settle();
    const device = byClass(t.host, "cce-conn-device");
    expect(text(device)).toContain("last seen 5 min ago");
    expect(text(device)).toContain(" · notifications on");
  });

  test("names and errors from the host are shown as text, never as markup", async () => {
    const t = setup(answer({ ...HUB, error: "<img src=x onerror=alert(1)>", devices: [{ id: "x", name: "<b>bold</b>", createdAt: NOW, lastSeenAt: NOW }] }));
    t.remote.mount(t.host);
    await t.settle();
    expect(text(byClass(t.host, "cce-conn-notice"))).toContain("<img src=x onerror=alert(1)>");
    expect(findAll(t.host, (el) => el.tagName === "IMG" || el.tagName === "B")).toHaveLength(0);
  });

  test("an old bridge or none: the error says so, and polling backs off", async () => {
    const t = setup(() => Promise.reject(new Error("Unknown request type.")));
    t.remote.mount(t.host);
    await t.settle();
    expect(text(byClass(t.host, "cce-conn-notice"))).toMatch(/isn't running in this window/);
    await t.clock.advance(2000);
    await t.settle();
    expect(t.types()).toHaveLength(1);
    await t.clock.advance(2000);
    await t.settle();
    expect(t.types()).toHaveLength(2);
    // Once it answers, back to every 2 s.
    t.respondWith(answer(OFF));
    await t.clock.advance(8000);
    await t.settle();
    const n = t.types().length;
    await t.clock.advance(2000);
    await t.settle();
    expect(t.types().length).toBe(n + 1);
    expect(byClass(t.host, "cce-conn-notice")).toBeUndefined();
  });

  test("a status that never comes back times out", async () => {
    const t = setup(() => new Promise(() => {}));
    t.remote.mount(t.host);
    await t.settle();
    await t.clock.advance(10_000);
    await t.settle();
    expect(text(byClass(t.host, "cce-conn-notice"))).toMatch(/didn't answer/);
  });

  test("an old status answer can't overwrite a newer action's status", async () => {
    let held: ReturnType<typeof deferred> | undefined;
    let status: object = OFF;
    const t = setup((request) =>
      request.type === "cce_remote_status" && held ? held.promise : { type: `${request.type}_response`, status });
    t.remote.mount(t.host);
    await t.settle();
    // The next poll goes out and its answer (still "off") is held back…
    held = deferred();
    await t.clock.advance(2000);
    await t.settle();
    // …while Connect runs and comes back first.
    status = HUB;
    button(t.host, "Connect with Tailscale").click();
    await t.settle();
    expect(button(t.host, "Disconnect")).toBeDefined();
    // The stale answer arrives; the refresh it lets out is held back in turn.
    const stale = held;
    held = deferred();
    stale.resolve({ type: "cce_remote_status_response", status: OFF });
    await t.settle();
    expect(button(t.host, "Disconnect")).toBeDefined();
    expect(button(t.host, "Connect with Tailscale")).toBeUndefined();
    // The refresh after the action waited for the old poll, then went out at once.
    expect(t.types()).toEqual(["cce_remote_status", "cce_remote_status", "cce_remote_connect", "cce_remote_status"]);
    held.resolve({ type: "cce_remote_status_response", status: HUB });
    await t.settle();
    expect(button(t.host, "Disconnect")).toBeDefined();
  });

  test("one action at a time: Enter in the address field waits for a running Connect", async () => {
    const t = setup();
    t.remote.mount(t.host);
    await t.settle();
    const pending = deferred();
    t.respondWith((request) => (request.type === "cce_remote_connect" ? pending.promise : { type: `${request.type}_response`, status: OFF }));
    button(t.host, "Connect with Tailscale").click();
    await t.settle();
    const input = findAll(t.host, (el) => el.tagName === "INPUT")[0];
    input.focus();
    input.value = "https://cce-remote.example.com";
    input.dispatch("keydown", { key: "Enter" });
    await t.settle();
    expect(t.types().filter((type) => type === "cce_remote_set_app_url")).toEqual([]);
    pending.resolve({ type: "cce_remote_connect_response", status: HUB });
    await t.settle();
    input.dispatch("keydown", { key: "Enter" });
    await t.settle();
    expect(t.types().filter((type) => type === "cce_remote_set_app_url")).toEqual(["cce_remote_set_app_url"]);
  });

  test("keys typed in the view stay there, shortcuts with modifiers still bubble", async () => {
    const t = setup(answer(HUB));
    const seen: string[] = [];
    t.app.addEventListener("keydown", (e) => seen.push(`${e.metaKey ? "cmd+" : ""}${e.key}`));
    t.remote.mount(t.host);
    await t.settle();
    const input = findAll(t.host, (el) => el.tagName === "INPUT")[0];
    input.dispatch("keydown", { key: "1" });
    input.dispatch("keydown", { key: "ArrowDown" });
    button(t.host, "New code").dispatch("keydown", { key: "Escape" });
    input.dispatch("keydown", { key: "v", metaKey: true });
    expect(seen).toEqual(["cmd+v"]);
  });

  test("an element React keeps but gives back to the list is cleared", async () => {
    const t = setup(answer(OFF));
    t.remote.mount(t.host);
    await t.settle();
    expect(view(t.host)).toBeDefined();
    // Same element, now the list's: React changed its class and dropped the ref.
    t.host.className = "content_Zr4Kp1";
    t.remote.mount(null);
    await t.clock.advance(0);
    expect(view(t.host)).toBeUndefined();
    expect(t.clock.pending).toBe(0);
  });

  test("remounting shows the last status right away", async () => {
    const t = setup(answer(HUB));
    t.remote.mount(t.host);
    await t.settle();
    t.app.removeChild(t.host);
    t.remote.mount(null);
    await t.clock.advance(0);
    const again = t.app.appendChild(t.document.createElement("div"));
    again.className = "content_Zr4Kp1 cce-conn";
    t.remote.mount(again);
    expect(button(again, "Disconnect")).toBeDefined();
  });
});

describe("the Claude in Chrome switch", () => {
  /** The section under the "Claude in Chrome" heading. */
  const chromeSection = (host: FakeElement) =>
    findAll(host, (el) => el.tagName === "SECTION" && el.children.some((child) => child.tagName === "H3" && child.textContent === "Claude in Chrome"))[0];
  const type = "cce_remote_set_chrome_auto_accept";

  test("off: says so and names the risk; Turn on sends the switch and shows Saving… while it runs; then it's on", async () => {
    const t = setup(answer({ ...OFF, chromeAutoAccept: false }));
    t.remote.mount(t.host);
    await t.settle();
    const off = chromeSection(t.host);
    expect(off).toBeDefined();
    expect(text(off)).toContain("Auto-accept is off");
    expect(text(off)).toContain("You confirm Claude in Chrome's permission prompts yourself.");
    expect(text(off)).toContain(
      "Only routine prompts are answered: those that Claude Code's safety checks flag still ask you. Each site is allowed for the rest of its session. A web page Claude reads could steer it without a prompt.",
    );
    expect(byClass(off, "cce-conn-dot").getAttribute("data-state")).toBe("off");

    const saving = deferred<object>();
    t.respondWith((request) => (request.type === type ? saving.promise : answer({ ...OFF, chromeAutoAccept: false })(request)));
    button(off, "Turn on auto-accept").click();
    await t.settle();
    expect(t.sent.filter((r) => r.type === type)).toEqual([{ type, on: true }]);
    const busy = button(chromeSection(t.host), "Saving…");
    expect(busy).toBeDefined();
    expect(busy.disabled).toBe(true);

    saving.resolve({ type: `${type}_response`, status: { ...OFF, chromeAutoAccept: true } });
    t.respondWith(answer({ ...OFF, chromeAutoAccept: true }));
    await t.settle();
    const on = chromeSection(t.host);
    expect(text(on)).toContain("Auto-accept is on");
    expect(text(on)).toContain("Claude in Chrome's routine permission prompts are answered for you in all your editor windows.");
    expect(byClass(on, "cce-conn-dot").getAttribute("data-state")).toBe("ok");
    button(on, "Turn off auto-accept").click();
    await t.settle();
    expect(t.sent.filter((r) => r.type === type).at(-1)).toEqual({ type, on: false });
  });

  test("shown with remote access on too, below the paired devices", async () => {
    const t = setup(answer({ ...HUB, chromeAutoAccept: true }));
    t.remote.mount(t.host);
    await t.settle();
    const section = chromeSection(t.host);
    expect(text(section)).toContain("Auto-accept is on");
    const sections = findAll(t.host, (el) => el.tagName === "SECTION");
    expect(sections.indexOf(section)).toBeGreaterThan(sections.indexOf(byClass(t.host, "cce-conn-device").parentNode as FakeElement));
  });

  test("a bridge whose status doesn't have the switch shows no Claude in Chrome section", async () => {
    const t = setup(answer(OFF));
    t.remote.mount(t.host);
    await t.settle();
    expect(text(view(t.host))).toContain("Paired devices");
    expect(chromeSection(t.host)).toBeUndefined();
  });

  test("a switch that can't be saved: the reason shows, and the switch stays as it was", async () => {
    const t = setup((request) =>
      request.type === type
        ? { type: `${type}_response`, status: { ...OFF, chromeAutoAccept: false }, error: "EACCES: permission denied" }
        : { type: `${request.type}_response`, status: { ...OFF, chromeAutoAccept: false } },
    );
    t.remote.mount(t.host);
    await t.settle();
    button(chromeSection(t.host), "Turn on auto-accept").click();
    await t.settle();
    expect(text(byClass(t.host, "cce-conn-notice"))).toBe("EACCES: permission denied");
    expect(text(chromeSection(t.host))).toContain("Auto-accept is off");
  });
});
