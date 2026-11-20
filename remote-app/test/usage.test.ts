import { describe, expect, test } from "bun:test";
import { parseUsageFrame } from "../src/lib/usage";

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
});
