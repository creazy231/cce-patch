import { describe, expect, test } from "bun:test";
import { pushStatusText } from "../src/state/push-status";
import type { PushState } from "../src/state/store";

const MAC = "example-mac";

function push(overrides: Partial<PushState> = {}): PushState {
  return {
    support: "ok",
    on: true,
    busy: false,
    prefs: { waiting: true, done: true, onlyAway: true, details: true },
    mac: "off",
    error: null,
    ...overrides,
  };
}

describe("pushStatusText", () => {
  test("the states that stay as they were", () => {
    expect(pushStatusText(push({ mac: "on" }), MAC)).toBe(`${MAC}: on`);
    expect(pushStatusText(push({ mac: "unsupported" }), MAC)).toBe(`${MAC}: this Mac's patch is too old for notifications`);
    expect(pushStatusText(push({ mac: "unknown" }), MAC)).toBe(`${MAC}: not set up yet`);
    expect(pushStatusText(push({ mac: "off" }), MAC)).toBe(`${MAC}: not set up yet`);
  });

  test("a refused setup names the code", () => {
    for (const code of ["bad_endpoint", "bad_keys", "bad_request"]) {
      expect(pushStatusText(push({ mac: "off", error: code }), MAC)).toBe(`${MAC}: refused this iPhone's notification setup (${code})`);
    }
  });

  test("a setup the Mac couldn't save", () => {
    expect(pushStatusText(push({ mac: "off", error: "save_failed" }), MAC)).toBe(`${MAC}: couldn't save the notification setup`);
  });

  test("any other code is a Mac that can't be reached", () => {
    expect(pushStatusText(push({ mac: "off", error: "timeout" }), MAC)).toBe(`${MAC}: can't be reached right now`);
  });
});
