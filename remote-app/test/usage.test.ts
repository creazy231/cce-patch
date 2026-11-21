import { describe, expect, test } from "bun:test";
import { parseUsageFrame, resetText, updatedText, usageRows } from "../src/lib/usage";

describe("parseUsageFrame", () => {
  test("keeps a valid frame as it is", () => {
    const frame = { t: "usage", state: "ok", fiveHour: { percent: 42.5, resetsAt: 1_900_000_000_000 }, week: { percent: 18 }, at: 1_899_999_000_000 };
    expect(parseUsageFrame(frame)).toEqual(frame);
  });

  test("is null for another frame, an unknown state or no object", () => {
    expect(parseUsageFrame({ t: "usage", state: "maybe" })).toBeNull();
    expect(parseUsageFrame({ t: "projects" })).toBeNull();
    expect(parseUsageFrame(null)).toBeNull();
  });

  test("drops what isn't valid, field by field", () => {
    expect(parseUsageFrame({ t: "usage", state: "ok", fiveHour: { percent: -1 }, week: { percent: "x" } })).toEqual({ t: "usage", state: "ok" });
    expect(parseUsageFrame({ t: "usage", state: "ok", fiveHour: { percent: 1001 } })).toEqual({ t: "usage", state: "ok" });
    expect(parseUsageFrame({ t: "usage", state: "ok", fiveHour: { percent: 12, resetsAt: 0 } })).toEqual({ t: "usage", state: "ok", fiveHour: { percent: 12 } });
    expect(parseUsageFrame({ t: "usage", state: "none", at: Number.NaN })).toEqual({ t: "usage", state: "none" });
  });

  test("keeps the account, in any state, and drops one that isn't a usable string", () => {
    const accountOf = (account: unknown) => parseUsageFrame({ t: "usage", state: "none", account })?.account;
    expect(parseUsageFrame({ t: "usage", state: "ok", week: { percent: 18 }, account: "ada@example.com" })).toEqual({ t: "usage", state: "ok", week: { percent: 18 }, account: "ada@example.com" });
    expect(accountOf("ada@example.com")).toBe("ada@example.com");
    expect(accountOf(42)).toBeUndefined();
    expect(accountOf("")).toBeUndefined();
    expect(accountOf("ada\n@example.com")).toBeUndefined();
    expect(accountOf("ada\u0085@example.com")).toBeUndefined(); // a C1 control character
    expect(accountOf("ada‮@example.com")).toBeUndefined(); // a bidi override: it could show another address
    expect(accountOf("ada​@example.com")).toBeUndefined(); // a zero-width space
    const longest = `${"a".repeat(242)}@example.com`; // 254 characters: the longest an email address can be
    expect(accountOf(longest)).toBe(longest);
    expect(accountOf(`a${longest}`)).toBeUndefined();
  });
});

// Dates are built in local time, so the phone's time zone doesn't matter; en-GB gives 24 h times.
const L = "en-GB";
const MAC_NOW = new Date(2026, 10, 20, 9, 0).getTime(); // a Friday morning
const LATER = MAC_NOW + 3_600_000;

describe("usageRows", () => {
  test("one row per limit, five-hour first, whole percent", () => {
    const rows = usageRows({ t: "usage", state: "ok", week: { percent: 18, resetsAt: LATER }, fiveHour: { percent: 42.4, resetsAt: LATER } }, MAC_NOW, L);
    expect(rows.map((row) => [row.key, row.label, row.percent])).toEqual([
      ["fiveHour", "5-hour", 42],
      ["week", "Week", 18],
    ]);
    expect(rows[0]!.resetText).toBe("resets 10:00");
  });

  test("the tone follows the shown percent: warn from 80, danger from 95", () => {
    const tone = (percent: number) => usageRows({ t: "usage", state: "ok", fiveHour: { percent } }, MAC_NOW, L)[0]!.tone;
    expect([79.4, 79.5, 94.4, 94.5].map(tone)).toEqual(["ok", "warn", "warn", "danger"]);
  });

  test("a limit whose reset has passed shows 0 % and no reset time", () => {
    const [row] = usageRows({ t: "usage", state: "ok", fiveHour: { percent: 64, resetsAt: MAC_NOW - 1 } }, MAC_NOW, L);
    expect(row).toMatchObject({ percent: 0, resetText: null, tone: "ok" });
  });

  test("only the limits the frame has", () => {
    expect(usageRows({ t: "usage", state: "ok", week: { percent: 5 } }, MAC_NOW, L).map((row) => row.label)).toEqual(["Week"]);
    expect(usageRows({ t: "usage", state: "none" }, MAC_NOW, L)).toEqual([]);
  });
});

describe("resetText", () => {
  test("today: the time; another day: the weekday and the time", () => {
    expect(resetText(new Date(2026, 10, 20, 14, 30).getTime(), MAC_NOW, L)).toBe("resets 14:30");
    expect(resetText(new Date(2026, 10, 23, 9, 0).getTime(), MAC_NOW, L)).toBe("resets Mon 09:00");
  });
});

describe("updatedText", () => {
  test("just now (also for a time ahead), then minutes, hours, days", () => {
    expect(updatedText(1_000, 1_000)).toBe("Updated just now");
    expect(updatedText(61_000, 1_000)).toBe("Updated just now");
    expect(updatedText(0, 59_000)).toBe("Updated just now");
    expect(updatedText(0, 3 * 60_000)).toBe("Updated 3 min ago");
    expect(updatedText(0, 2 * 3_600_000)).toBe("Updated 2 h ago");
    expect(updatedText(0, 3 * 86_400_000)).toBe("Updated 3 d ago");
  });
});
