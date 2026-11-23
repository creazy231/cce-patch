import { describe, expect, test } from "bun:test";
import { handleConnectionRequest } from "../lib/connection-ui.js";

/** A coordinator that records what the Connection tab asked for; `fail` makes an action reject with that error. */
function fakeCoordinator(fail: Record<string, unknown> = {}) {
  const calls: unknown[][] = [];
  let statuses = 0;
  const act = (name: string, value?: unknown) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      if (name in fail) throw fail[name];
      return value;
    };
  return {
    calls,
    async status() {
      statuses++;
      calls.push(["status"]);
      return { enabled: true, role: "hub", seq: statuses };
    },
    connect: act("connect", { enabled: true, role: "hub", from: "connect" }),
    disconnect: act("disconnect", { enabled: false, role: "off", from: "disconnect" }),
    newPairingCode: act("newPairingCode", { code: "ABCD-EFGH" }),
    removeDevice: act("removeDevice"),
    setAppUrl: act("setAppUrl"),
    setChromeAutoAccept: act("setChromeAutoAccept"),
    openTailscale: act("openTailscale"),
  };
}

function deps() {
  const opened: string[] = [];
  const copied: string[] = [];
  return {
    opened,
    copied,
    openExternal: async (url: string) => {
      opened.push(url);
    },
    copy: async (text: string) => {
      copied.push(text);
    },
  };
}

describe("handleConnectionRequest", () => {
  test("status: a fresh status", async () => {
    const coordinator = fakeCoordinator();
    expect(await handleConnectionRequest(coordinator, { type: "cce_remote_status" }, deps())).toEqual({
      type: "cce_remote_status_response",
      status: { enabled: true, role: "hub", seq: 1 },
    });
  });

  test("connect and disconnect answer with the status they end with", async () => {
    const coordinator = fakeCoordinator();
    expect(await handleConnectionRequest(coordinator, { type: "cce_remote_connect" }, deps())).toEqual({
      type: "cce_remote_connect_response",
      status: { enabled: true, role: "hub", from: "connect" },
    });
    expect(await handleConnectionRequest(coordinator, { type: "cce_remote_disconnect" }, deps())).toEqual({
      type: "cce_remote_disconnect_response",
      status: { enabled: false, role: "off", from: "disconnect" },
    });
    expect(coordinator.calls).toEqual([["connect"], ["disconnect"]]);
  });

  test("new code, remove device and app address run the action, then answer with a fresh status", async () => {
    const coordinator = fakeCoordinator();
    const answers = [
      await handleConnectionRequest(coordinator, { type: "cce_remote_new_code" }, deps()),
      await handleConnectionRequest(coordinator, { type: "cce_remote_remove_device", id: "d1" }, deps()),
      await handleConnectionRequest(coordinator, { type: "cce_remote_set_app_url", url: "https://app.example.com" }, deps()),
    ];
    expect(answers).toEqual([
      { type: "cce_remote_new_code_response", status: { enabled: true, role: "hub", seq: 1 } },
      { type: "cce_remote_remove_device_response", status: { enabled: true, role: "hub", seq: 2 } },
      { type: "cce_remote_set_app_url_response", status: { enabled: true, role: "hub", seq: 3 } },
    ]);
    expect(coordinator.calls).toEqual([["newPairingCode"], ["status"], ["removeDevice", "d1"], ["status"], ["setAppUrl", "https://app.example.com"], ["status"]]);
  });

  test("a failed action: the error, and a fresh status all the same; bad_url stays the code the tab knows", async () => {
    const coordinator = fakeCoordinator({
      setAppUrl: new Error("bad_url"),
      connect: new Error("Couldn't publish port 47821 on your tailnet: Tailscale is stopped"),
      newPairingCode: Object.assign(new Error("closed"), { code: "closed" }),
    });
    expect(await handleConnectionRequest(coordinator, { type: "cce_remote_set_app_url", url: "http://x" }, deps())).toEqual({
      type: "cce_remote_set_app_url_response",
      status: { enabled: true, role: "hub", seq: 1 },
      error: "bad_url",
    });
    const connect = await handleConnectionRequest(coordinator, { type: "cce_remote_connect" }, deps());
    expect(connect).toEqual({
      type: "cce_remote_connect_response",
      status: { enabled: true, role: "hub", seq: 2 },
      error: "Couldn't publish port 47821 on your tailnet: Tailscale is stopped",
    });
    const code = await handleConnectionRequest(coordinator, { type: "cce_remote_new_code" }, deps());
    expect(code.error).not.toBe("closed"); // a code is turned into words for the tab
    expect(code.error).toMatch(/window/i);
  });

  test("a device id or an app address that is not text is refused before the coordinator sees it", async () => {
    const coordinator = fakeCoordinator();
    const device = await handleConnectionRequest(coordinator, { type: "cce_remote_remove_device", id: 42 }, deps());
    expect(device.type).toBe("cce_remote_remove_device_response");
    expect(device.error).toBeTruthy();
    expect(device.status).toEqual({ enabled: true, role: "hub", seq: 1 });
    const url = await handleConnectionRequest(coordinator, { type: "cce_remote_set_app_url", url: { href: "https://x" } }, deps());
    expect(url.error).toBe("bad_url");
    expect(coordinator.calls.filter(([name]) => name !== "status")).toEqual([]);
  });

  test("the Claude in Chrome switch: on and off run the action, then answer with a fresh status; anything else is refused", async () => {
    const coordinator = fakeCoordinator();
    const type = "cce_remote_set_chrome_auto_accept";
    expect(await handleConnectionRequest(coordinator, { type, on: true }, deps())).toEqual({ type: `${type}_response`, status: { enabled: true, role: "hub", seq: 1 } });
    expect(await handleConnectionRequest(coordinator, { type, on: false }, deps())).toEqual({ type: `${type}_response`, status: { enabled: true, role: "hub", seq: 2 } });
    for (const on of ["true", 1, null, undefined]) {
      const refused = await handleConnectionRequest(coordinator, { type, on }, deps());
      expect(refused.type).toBe(`${type}_response`);
      expect(refused.error).toBe("Choose on or off.");
      expect(refused.status).toMatchObject({ enabled: true, role: "hub" });
    }
    expect(coordinator.calls.filter(([name]) => name !== "status")).toEqual([["setChromeAutoAccept", true], ["setChromeAutoAccept", false]]);
  });

  test("a switch that can't be saved: the reason, and a fresh status", async () => {
    const coordinator = fakeCoordinator({ setChromeAutoAccept: new Error("EACCES: permission denied, open '/home/me/.cce-remote/state.json.tmp'") });
    expect(await handleConnectionRequest(coordinator, { type: "cce_remote_set_chrome_auto_accept", on: true }, deps())).toEqual({
      type: "cce_remote_set_chrome_auto_accept_response",
      status: { enabled: true, role: "hub", seq: 1 },
      error: "EACCES: permission denied, open '/home/me/.cce-remote/state.json.tmp'",
    });
  });

  test("open_tailscale opens the app; when it can't, the download page; no status either way", async () => {
    const opened = deps();
    expect(await handleConnectionRequest(fakeCoordinator(), { type: "cce_remote_open_tailscale" }, opened)).toEqual({ type: "cce_remote_open_tailscale_response" });
    expect(opened.opened).toEqual([]);
    const missing = deps();
    const answer = await handleConnectionRequest(fakeCoordinator({ openTailscale: new Error("Unable to find application named 'Tailscale'") }), { type: "cce_remote_open_tailscale" }, missing);
    expect(answer).toEqual({ type: "cce_remote_open_tailscale_response" });
    expect(missing.opened).toEqual(["https://tailscale.com/download"]);
    const nothing = await handleConnectionRequest(
      fakeCoordinator({ openTailscale: new Error("Unable to find application named 'Tailscale'") }),
      { type: "cce_remote_open_tailscale" },
      { copy: async () => {}, openExternal: async () => { throw new Error("no browser"); } },
    );
    expect(nothing.type).toBe("cce_remote_open_tailscale_response");
    expect(nothing.error).toContain("Tailscale");
  });

  test("copy writes the text to the clipboard; no status", async () => {
    const d = deps();
    expect(await handleConnectionRequest(fakeCoordinator(), { type: "cce_remote_copy", text: "https://app.example.com/#pair=abc" }, d)).toEqual({ type: "cce_remote_copy_response" });
    expect(d.copied).toEqual(["https://app.example.com/#pair=abc"]);
    expect((await handleConnectionRequest(fakeCoordinator(), { type: "cce_remote_copy", text: "" }, d)).error).toBeTruthy();
    expect((await handleConnectionRequest(fakeCoordinator(), { type: "cce_remote_copy", text: 7 }, d)).error).toBeTruthy();
    const broken = await handleConnectionRequest(fakeCoordinator(), { type: "cce_remote_copy", text: "x" }, { openExternal: async () => {}, copy: async () => { throw new Error("denied"); } });
    expect(broken).toEqual({ type: "cce_remote_copy_response", error: expect.stringContaining("denied") });
    expect(d.copied).toEqual(["https://app.example.com/#pair=abc"]);
  });

  test("an unknown cce_remote_ request gets an error response of its own type", async () => {
    expect(await handleConnectionRequest(fakeCoordinator(), { type: "cce_remote_reboot" }, deps())).toEqual({ type: "cce_remote_reboot_response", error: "unknown_request" });
  });
});
